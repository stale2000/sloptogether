"""Bounded, CPU-only source media validation shared by inference workers."""
from __future__ import annotations

import json
import os
import selectors
import subprocess
import time
from fractions import Fraction
from itertools import pairwise
from typing import Protocol, TypedDict, cast


class _SliceableFrames(Protocol):
    def __len__(self) -> int: ...
    def __getitem__(self, index: slice[int | None, int | None, int | None], /) -> _SliceableFrames: ...


class SourceMetadata(TypedDict):
    fps: Fraction
    frames: int
    width: int
    height: int
    audio: bool


_FFPROBE_TIMEOUT_SECONDS = 60
_FFPROBE_MAX_OUTPUT_BYTES = 8 * 1024 * 1024
_MAX_SOURCE_FRAMES = 14_400  # Ten minutes at 24 fps, beyond supported upscale clips.


def reconcile_decoded_frames[Frames: _SliceableFrames](
    frames: Frames, declared_frames: int | None, *, max_tail_frames: int = 2,
) -> tuple[Frames, int]:
    """Align decoder output to a trusted CFR count, dropping only bounded tail frames."""
    if declared_frames is None:
        return frames, 0
    if type(declared_frames) is not int or declared_frames <= 0:
        raise ValueError("declared source frame count must be positive")
    if max_tail_frames < 0:
        raise ValueError("maximum decoder tail must be nonnegative")
    if len(frames) < declared_frames:
        raise ValueError("decoded source has fewer frames than FFprobe declared")
    extra = len(frames) - declared_frames
    if extra > max_tail_frames:
        raise ValueError("decoded source exceeds FFprobe frame count beyond the endpoint tolerance")
    return cast(Frames, frames[:declared_frames]), extra


def _ffprobe_bounded(
    arguments: list[str], *, deadline: float, max_output_bytes: int,
) -> bytes:
    """Run ffprobe while bounding wall time and captured output bytes."""
    from .distributed import _ffprobe

    process = subprocess.Popen(
        [_ffprobe(), *arguments], stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
    )
    assert process.stdout is not None
    output = bytearray()
    try:
        with selectors.DefaultSelector() as selector:
            selector.register(process.stdout, selectors.EVENT_READ)
            while True:
                remaining = deadline - time.monotonic()
                if remaining <= 0 or not selector.select(remaining):
                    raise TimeoutError("FFprobe source metadata exceeded its 60-second deadline")
                chunk = os.read(process.stdout.fileno(), 64 * 1024)
                if not chunk:
                    break
                output.extend(chunk)
                if len(output) > max_output_bytes:
                    raise ValueError("FFprobe source metadata exceeded its 8 MiB output limit")
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            raise TimeoutError("FFprobe source metadata exceeded its 60-second deadline")
        return_code = process.wait(timeout=remaining)
        if return_code:
            raise RuntimeError(f"FFprobe failed with exit status {return_code}")
        return bytes(output)
    except BaseException:
        if process.poll() is None:
            process.kill()
        process.wait()
        raise
    finally:
        process.stdout.close()


def _validate_cfr_timestamps(
    frame_rows: list[tuple[int, int]], fps: Fraction, time_base: Fraction,
) -> int:
    """Prove monotonic, constant frame timing within one stream time-base tick."""
    if not frame_rows or len(frame_rows) > _MAX_SOURCE_FRAMES:
        raise ValueError("source frame count is outside the supported bounded range")
    expected = 1 / fps
    tick = time_base
    timestamps = [timestamp for timestamp, _duration in frame_rows]
    if any(right <= left for left, right in pairwise(timestamps)):
        raise ValueError("source frame timestamps are not strictly monotonic")
    deltas = [right - left for left, right in pairwise(timestamps)]
    durations = [duration for _timestamp, duration in frame_rows]
    if any(duration <= 0 for duration in durations):
        raise ValueError("source frame durations are missing or invalid")
    for value in (*deltas, *durations):
        if abs(Fraction(value) * tick - expected) > tick:
            raise ValueError("source per-frame timestamps/durations do not prove constant-frame-rate input")
    return len(frame_rows)


def probe_source_metadata(source: str) -> SourceMetadata:
    """Validate stream metadata and bounded per-frame timing without decoding pixels."""
    deadline = time.monotonic() + _FFPROBE_TIMEOUT_SECONDS
    stream_data = _ffprobe_bounded(
        ["-v", "error", "-show_streams", "-of", "json", source],
        deadline=deadline, max_output_bytes=_FFPROBE_MAX_OUTPUT_BYTES,
    )
    streams_data = json.loads(stream_data)
    streams = streams_data["streams"]
    videos = [stream for stream in streams if stream.get("codec_type") == "video"]
    if len(videos) != 1:
        raise ValueError("upscale source must have exactly one video stream")
    video = videos[0]
    fps = Fraction(video["avg_frame_rate"])
    if fps <= 0 or Fraction(video["r_frame_rate"]) != fps:
        raise ValueError("upscale requires matching positive rational CFR rates")
    time_base = Fraction(video["time_base"])
    if time_base <= 0:
        raise ValueError("source video stream has an invalid time base")
    raw_frames = _ffprobe_bounded(
        [
            "-v", "error", "-select_streams", "v:0", "-show_frames",
            "-show_entries", "frame=best_effort_timestamp,duration,pkt_duration",
            "-of", "compact=p=0:nk=0", source,
        ],
        deadline=deadline, max_output_bytes=_FFPROBE_MAX_OUTPUT_BYTES - len(stream_data),
    )
    frame_rows: list[tuple[int, int]] = []
    for line in raw_frames.splitlines():
        if not line.strip():
            continue
        fields = dict(
            entry.split(b"=", 1) for entry in line.split(b"|") if b"=" in entry
        )
        timestamp = fields.get(b"best_effort_timestamp")
        duration = fields.get(b"duration", fields.get(b"pkt_duration"))
        if timestamp is None or duration is None:
            raise ValueError("FFprobe returned incomplete per-frame timing metadata")
        try:
            frame_rows.append((int(timestamp), int(duration)))
        except ValueError as exc:
            raise ValueError("FFprobe returned invalid per-frame timing metadata") from exc
        if len(frame_rows) > _MAX_SOURCE_FRAMES:
            raise ValueError("source exceeds the supported 14,400-frame timing-probe limit")
    counted_frames = _validate_cfr_timestamps(frame_rows, fps, time_base)
    declared_count = video.get("nb_frames")
    declared = int(declared_count) if str(declared_count).isdecimal() else None
    if declared is not None and declared != counted_frames:
        raise ValueError("FFprobe declared frame count disagrees with per-frame timing metadata")
    return {
        "fps": fps, "frames": counted_frames,
        "width": int(video["width"]), "height": int(video["height"]),
        "audio": any(stream.get("codec_type") == "audio" for stream in streams),
    }
