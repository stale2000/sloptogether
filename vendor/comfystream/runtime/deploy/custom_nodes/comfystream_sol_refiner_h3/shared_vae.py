"""Opt-in same-host VAE/transformer pipeline benchmark with bounded chunk handoff.

This module imports CUDA dependencies lazily so scheduling invariants can be
checked on a CPU host. GPU ordinal values are local to the isolated worker.
"""
from __future__ import annotations

import os
import subprocess
import tempfile
import time
from collections.abc import Callable
from concurrent.futures import Future, ThreadPoolExecutor
from contextlib import ExitStack
from dataclasses import asdict
from fractions import Fraction
from pathlib import Path
from types import ModuleType
from typing import TYPE_CHECKING, Protocol, cast

from .distributed import VideoChunk
from .media_metadata import probe_source_metadata, reconcile_decoded_frames
from .protocol import WorkerRequest

if TYPE_CHECKING:
    from torch import Tensor
    from torch.cuda import Event

    from .cuda_transfers import TransferReport
    from .fixed_conditioning import FixedConditioning
    from .sol_refiner_h3 import SoLRefinerH3Pipeline


class _ScheduledChunk(Protocol):
    @property
    def device(self) -> str: ...
    @property
    def index(self) -> int: ...


_RUNTIME: tuple[tuple[object, ...], SoLRefinerH3Pipeline, dict[str, SoLRefinerH3Pipeline], FixedConditioning] | None = None

def role_overrides(role: str) -> dict[str, None]:
    """Prevent unwanted checkpoint components from being loaded in each role."""
    common = {"text_encoder": None, "tokenizer": None, "connectors": None,
              "diffusion_decoder": None}
    if role == "vae":
        return {**common, "transformer": None}
    if role == "transformer":
        return {**common, "vae": None, "latent_upsampler": None}
    raise ValueError("role must be vae or transformer")


def run_bounded_chunks[Chunk: _ScheduledChunk, Encoded, Refined](
    chunks: tuple[Chunk, ...], encode: Callable[[Chunk], Encoded],
    refine: Callable[[Chunk, Encoded], Refined], consume: Callable[[Chunk, Refined], None],
) -> int:
    """Overlap two bounded transformer jobs per device, consuming in source order.

    Encoding and consumption stay on the caller thread (one VAE GPU). One
    transformer job may run while its next conditioning tensor waits in the
    executor. Its credit remains owned through ordered result consumption, so
    completed tensors are included in the bound. A failed task cancels pending
    work before returning.
    """
    if not chunks:
        raise ValueError("shared VAE benchmark requires at least one chunk")
    devices = tuple(dict.fromkeys(chunk.device for chunk in chunks))
    pending: dict[int, Future[Refined]] = {}
    owned_by_device = {device: 0 for device in devices}
    next_submit = 0
    peak_pending = 0
    with ExitStack() as resources:
        # A pipeline owns a mutable scheduler. Keep each device's calls serial
        # even when another device completes early and can accept its next job.
        pools = {
            device: resources.enter_context(ThreadPoolExecutor(
                max_workers=1, thread_name_prefix=f"sol-h3-latent-{device}",
            ))
            for device in devices
        }
        try:
            for chunk in chunks:
                while next_submit < len(chunks):
                    candidate = chunks[next_submit]
                    if owned_by_device[candidate.device] >= 2:
                        break
                    conditioned = encode(candidate)
                    pending[candidate.index] = pools[candidate.device].submit(
                        refine, candidate, conditioned,
                    )
                    del conditioned
                    owned_by_device[candidate.device] += 1
                    next_submit += 1
                    peak_pending = max(peak_pending, len(pending))
                result = pending.pop(chunk.index).result()
                consume(chunk, result)
                owned_by_device[chunk.device] -= 1
                del result
        except BaseException:
            for future in pending.values():
                future.cancel()
            raise
    return peak_pending


def _load_roles(request: WorkerRequest, artifact: Path, torch: ModuleType) -> tuple[SoLRefinerH3Pipeline, dict[str, SoLRefinerH3Pipeline], FixedConditioning, float]:
    global _RUNTIME
    from . import fast_decoder
    from .fixed_conditioning import FixedConditioning, conditioning_identity
    from .model_runtime import MODEL_ID, MODEL_REVISION
    from .node import (
        VIDEO_ONLY_REFINER_ENV,
        _ensure_refiner_source_path,
        _experiment_flag,
        _transformer_experiment_flags,
    )

    config = request["shared_vae"]
    vae_device = int(config["vae_device"])
    devices = tuple(str(value) for value in config["upscale_devices"])
    precision = request.get("transformer_precision", "nvfp4")
    video_only = _experiment_flag(VIDEO_ONLY_REFINER_ENV)
    identity = conditioning_identity(request["prompt"], MODEL_ID, MODEL_REVISION, video_only)
    if not artifact.is_file():
        raise RuntimeError(
            "Shared VAE conditioning cache is missing for this exact prompt and runtime. "
            "Run install_runtime.sh --prepare-shared-vae-conditioning during deployment "
            "for the default prompt, or run scripts/prepare_h3_upscale_conditioning.py "
            "with this exact custom prompt."
        )
    # Validate even on warm requests; never reuse embeddings for a changed prompt.
    fixed = FixedConditioning.load(artifact, identity)
    compiled = _transformer_experiment_flags("pruna_fast", request["width"], request["height"])
    key = (vae_device, devices, precision, video_only, compiled, fixed.sha256)
    if _RUNTIME is not None:
        if _RUNTIME[0] != key:
            raise RuntimeError("Shared VAE topology/model/prompt changed; restart its persistent worker")
        return _RUNTIME[1], _RUNTIME[2], _RUNTIME[3], 0.0
    started = time.perf_counter()
    _ensure_refiner_source_path()
    from diffusers.pipelines import pipeline_loading_utils

    from .sol_refiner_h3 import SoLRefinerH3Pipeline

    previous = pipeline_loading_utils.LOADABLE_CLASSES.get("sol_refiner_h3")
    pipeline_loading_utils.LOADABLE_CLASSES["sol_refiner_h3"] = {
        "ModelMixin": ["save_pretrained", "from_pretrained"]
    }
    try:
        with torch.cuda.device(vae_device):
            vae = SoLRefinerH3Pipeline.from_pretrained(
                MODEL_ID, revision=MODEL_REVISION, torch_dtype=torch.bfloat16,
                **role_overrides("vae"),
            ).to(f"cuda:{vae_device}")
            vae.model_residency = f"cuda:{vae_device}"
            vae.cpu_offload_enabled = False
            # The pinned Pruna decoder's cuda calls use the active device.
            fast_decoder._PRUNA_VAE = fast_decoder.load_pruna_vae(torch)
        transformers = {}
        for device in devices:
            with torch.cuda.device(int(device)):
                pipe = SoLRefinerH3Pipeline.from_pretrained(
                    MODEL_ID, revision=MODEL_REVISION, torch_dtype=torch.bfloat16,
                    **role_overrides("transformer"),
                )
                pipe.video_only_refiner = video_only
                pipe.video_only_transformer_blocks = 0
                if video_only:
                    from .sol_refiner_h3.video_only import enable_video_only_refiner

                    pipe.video_only_transformer_blocks = enable_video_only_refiner(pipe.transformer)
                pipe.transformer_precision = precision
                pipe.transformer_mxfp8_linear_names = ()
                pipe.transformer_nvfp4_linear_names = ()
                if precision == "nvfp4":
                    from .fp8_optimizations import enable_transformer_nvfp4

                    pipe.transformer_nvfp4_linear_names = enable_transformer_nvfp4(pipe.transformer)
                elif precision == "mxfp8":
                    from .fp8_optimizations import enable_transformer_mxfp8

                    pipe.transformer_mxfp8_linear_names = enable_transformer_mxfp8(pipe.transformer)
                elif precision != "bf16":
                    raise ValueError("Unsupported transformer precision")
                pipe.to(f"cuda:{device}")
                if pipe._execution_device != torch.device(f"cuda:{device}"):
                    raise RuntimeError("Transformer pipeline resolved to the wrong execution device")
                if pipe.vae is not None or pipe.latent_upsampler is not None:
                    raise RuntimeError("Transformer role unexpectedly loaded VAE components")
                pipe.model_residency = f"cuda:{device}"
                pipe.cpu_offload_enabled = False
                pipe.transformer_compiled = compiled
                if compiled:
                    pipe.transformer.compile_repeated_blocks()
                pipe.shared_prompt = fixed.tensors(f"cuda:{device}")
                transformers[device] = pipe
    except BaseException:
        # Partially loaded role models must not survive a failed initialization.
        fast_decoder._PRUNA_VAE = None
        raise
    finally:
        if previous is None:
            pipeline_loading_utils.LOADABLE_CLASSES.pop("sol_refiner_h3", None)
        else:
            pipeline_loading_utils.LOADABLE_CLASSES["sol_refiner_h3"] = previous
    _RUNTIME = (key, vae, transformers, fixed)
    for ordinal in (vae_device, *map(int, devices)):
        torch.cuda.synchronize(ordinal)
    return vae, transformers, fixed, time.perf_counter() - started


class ChunkFrameWriter:
    """Join adjacent overlap frames and pipe bounded RGB batches once."""

    def __init__(self, request: WorkerRequest, chunks: tuple[VideoChunk, ...], frame_count: int,
                 fps: Fraction, has_audio: bool, torch: ModuleType, *, interpolate_overlaps: bool) -> None:
        from .node import _nvenc_input_pixel_format, ffmpeg_export_command

        self.request, self.chunks, self.torch = request, chunks, torch
        self.interpolate_overlaps = interpolate_overlaps
        self.pending: Tensor | int | None = None
        self.frames_written = 0
        self.expected_frames = frame_count
        self.pack_seconds = self.host_copy_seconds = self.pipe_write_seconds = 0.0
        self.blend_seconds = self.ffmpeg_wait_seconds = 0.0
        self.max_batch_bytes = self.max_overlap_frames = 0
        self.pixel_format = _nvenc_input_pixel_format(request["output_backend"])
        command = ffmpeg_export_command(
            request["source"], request["output"], width=request["width"],
            height=request["height"], frame_rate=fps, frame_count=frame_count,
            backend=request["output_backend"], has_audio=has_audio,
            input_pixel_format=self.pixel_format,
        )
        if request["output_backend"] == "nvenc":
            command[-1:-1] = ["-gpu", str(request["shared_vae"]["vae_device"])]
        self.resources = ExitStack()
        # ExitStack owns this stream across incremental consume()/finish() calls.
        self.errors = self.resources.enter_context(tempfile.TemporaryFile())  # noqa: SIM115
        try:
            self.process = subprocess.Popen(command, stdin=subprocess.PIPE, stderr=self.errors)
        except BaseException:
            self.resources.close()
            raise
        if self.process.stdin is None:
            self.abort()
            raise RuntimeError("FFmpeg did not expose its input pipe")
        self.pipe = self.process.stdin
        self.started = time.perf_counter()

    def _write(self, frames: Tensor) -> None:
        from .node import _pack_rgb_as_yuv420p

        torch = self.torch
        for offset in range(0, len(frames), 8):
            batch = frames[offset:offset + 8]
            tick = time.perf_counter()
            if self.pixel_format == "yuv420p":
                packed = _pack_rgb_as_yuv420p(batch, torch)
            else:
                packed = (batch.float() * 255).round().clamp(0, 255).to(torch.uint8).contiguous()
            torch.cuda.synchronize(batch.device)
            self.pack_seconds += time.perf_counter() - tick
            tick = time.perf_counter()
            host = torch.empty_like(packed, device="cpu", pin_memory=True)
            host.copy_(packed, non_blocking=True)
            torch.cuda.synchronize(batch.device)
            self.host_copy_seconds += time.perf_counter() - tick
            payload = memoryview(host.numpy()).cast("B")
            self.max_batch_bytes = max(self.max_batch_bytes, len(payload))
            tick = time.perf_counter()
            try:
                self.pipe.write(payload)
            except BrokenPipeError as exc:
                raise RuntimeError(f"Shared VAE FFmpeg input pipe failed: {self._stderr_tail()}") from exc
            self.pipe_write_seconds += time.perf_counter() - tick
            self.frames_written += len(batch)

    def consume(self, chunk: VideoChunk, frames: Tensor) -> None:
        expected = chunk.input_end - chunk.input_start
        if len(frames) != expected or tuple(frames.shape[1:]) != (
            self.request["height"], self.request["width"], 3
        ):
            raise ValueError("Decoded chunk does not match its input frame range/geometry")
        if not bool(self.torch.isfinite(frames).all()):
            raise ValueError("Shared VAE decoder returned non-finite pixels")
        if float(frames.min()) < -0.001 or float(frames.max()) > 1.001:
            raise ValueError("Shared VAE decoder pixels are outside [0,1]")
        cursor = 0
        if self.pending is not None:
            count = len(cast("Tensor", self.pending)) if self.interpolate_overlaps else cast(int, self.pending)
            if count > expected:
                raise ValueError("Chunk overlap exceeds decoded input")
            if self.interpolate_overlaps:
                tick = time.perf_counter()
                weights = self.torch.linspace(
                    0, 1, count, device=frames.device, dtype=self.torch.float32
                ).reshape(count, 1, 1, 1)
                blended = cast("Tensor", self.pending).float() * (1 - weights) + frames[:count].float() * weights
                self.torch.cuda.synchronize(frames.device)
                self.blend_seconds += time.perf_counter() - tick
                self._write(blended)
            else:
                # Use the next chunk's prediction directly; do not synthesize
                # transition frames from two independently refined overlaps.
                self._write(frames[:count])
            self.pending = None
            cursor = count
        if chunk.index + 1 < len(self.chunks):
            next_chunk = self.chunks[chunk.index + 1]
            stop = next_chunk.input_start - chunk.input_start
            if stop < cursor or stop > expected:
                raise ValueError("Chunk overlaps do not form a bounded ordered sequence")
            self._write(frames[cursor:stop])
            overlap_count = expected - stop
            if self.interpolate_overlaps:
                # Blending needs both predictions; clone only the small overlap.
                self.pending = frames[stop:].clone()
            else:
                # The next chunk's prediction is emitted at the seam, so retain
                # only its frame count and release this decoded chunk now.
                self.pending = overlap_count
            self.max_overlap_frames = max(self.max_overlap_frames, overlap_count)
        else:
            self._write(frames[cursor:])

    def finish(self, fps: Fraction, has_audio: bool) -> dict[str, object]:
        if self.pending is not None or self.frames_written != self.expected_frames:
            raise RuntimeError("Shared VAE assembly did not emit the exact source frame count")
        self.pipe.close()
        tick = time.perf_counter()
        code = self.process.wait(timeout=1800)
        self.ffmpeg_wait_seconds = time.perf_counter() - tick
        if code:
            raise RuntimeError(f"Shared VAE FFmpeg export failed: {self._stderr_tail()}")
        self.resources.close()
        if not Path(self.request["output"]).is_file() or not Path(self.request["output"]).stat().st_size:
            raise RuntimeError("FFmpeg returned success without an output video")
        return {
            "frames": self.frames_written, "width": self.request["width"],
            "height": self.request["height"], "fps": f"{fps.numerator}/{fps.denominator}",
            "backend": self.request["output_backend"], "input_pixel_format": self.pixel_format,
            "audio_stream_copied": has_audio, "packing_device": "cuda",
            "pack_seconds": self.pack_seconds, "host_copy_seconds": self.host_copy_seconds,
            "pipe_write_seconds": self.pipe_write_seconds,
            "ffmpeg_wait_seconds": self.ffmpeg_wait_seconds,
            "encode_seconds": time.perf_counter() - self.started,
            "encode_seconds_scope": "stream lifetime; overlaps model inference",
            "packing_chunk_frames": 8, "max_packed_batch_bytes": self.max_batch_bytes,
            "max_overlap_frames": self.max_overlap_frames,
            "pixel_rounding": "FP32 normalized RGB, round-to-even, clipped uint8",
            "overlap_interpolation_enabled": self.interpolate_overlaps,
        }

    def _stderr_tail(self) -> str:
        self.errors.seek(0, os.SEEK_END)
        self.errors.seek(max(0, self.errors.tell() - 4000))
        return self.errors.read(4000).decode(errors="replace")

    def abort(self) -> None:
        try:
            if self.process.poll() is None:
                self.process.kill()
            self.process.wait()
        finally:
            try:
                if self.process.stdin is not None:
                    self.process.stdin.close()
            except OSError:
                pass  # A failed encoder may already have closed its pipe.
            finally:
                self.resources.close()


def run(request: WorkerRequest) -> dict[str, object]:
    import sys

    import torch
    from diffusers.utils import load_video

    from .fast_decoder import decode_pruna_vae
    from .fixed_conditioning import ARTIFACT_ENV, conditioning_cache_path, conditioning_identity
    from .model_runtime import (
        MODEL_ID,
        MODEL_REVISION,
        VIDEO_ONLY_REFINER_ENV,
        WORKER_TORCH_VERSION,
    )
    from .node import (
        _experiment_flag,
        pad_video_frames,
        validate_runtime,
        validate_upscale_geometry,
    )
    from .shared_vae_plan import GlobalLatentNoise, plan_shared_vae_chunks

    validate_runtime(torch, sys.version_info[:2], expected_torch=WORKER_TORCH_VERSION)
    if request.get("decoder_mode") != "pruna_fast":
        raise ValueError("Shared VAE benchmarking supports only pruna_fast")
    if not torch.cuda.is_available():
        raise RuntimeError("Shared VAE mode requires separate VAE and transformer CUDA GPUs")
    config = request["shared_vae"]
    vae_device = int(config["vae_device"])
    devices = tuple(str(value) for value in config["upscale_devices"])
    all_devices = (vae_device, *map(int, devices))
    if not devices or len(devices) > 4 or len(set(all_devices)) != len(all_devices):
        raise ValueError("Shared VAE requires one distinct VAE GPU and one to four transformer GPUs")
    for device in all_devices:
        if device >= torch.cuda.device_count() or device < 0:
            raise ValueError("Shared VAE device is outside the worker-visible GPU list")
        with torch.cuda.device(device):
            if not torch.cuda.is_bf16_supported():
                raise RuntimeError(f"Shared VAE GPU {device} does not support BF16")
    started = time.perf_counter()
    request = {
        **request,
        "source": str(Path(request["source"]).resolve()),
        "output": str(Path(request["output"]).resolve()),
    }
    output = Path(request["output"])
    output.parent.mkdir(parents=True, exist_ok=True)
    stages = {name: 0.0 for name in (
        "source_probe_s", "source_decode_s", "vae_encode_and_upsample_s", "transformer_s",
        "vae_encode_s", "latent_upsample_s", "latent_transfer_s", "vae_decode_s",
        "blend_and_export_s", "final_encode_wait_s",
    )}
    tick = time.perf_counter()
    source_metadata = probe_source_metadata(request["source"])
    stages["source_probe_s"] = time.perf_counter() - tick
    fps = Fraction(request["fps"])
    if source_metadata["fps"] != fps:
        raise ValueError("Shared VAE source FPS does not match its request")
    validate_upscale_geometry(source_metadata["width"], source_metadata["height"],
                              request["width"], request["height"])
    artifact_setting = os.environ.get(ARTIFACT_ENV, "").strip()
    artifact = Path(artifact_setting).expanduser().resolve() if artifact_setting else conditioning_cache_path(
        conditioning_identity(request["prompt"], MODEL_ID, MODEL_REVISION,
                              _experiment_flag(VIDEO_ONLY_REFINER_ENV))
    )
    vae, transformers, fixed, model_load_s = _load_roles(request, artifact, torch)
    for device in all_devices:
        torch.cuda.reset_peak_memory_stats(device)
    infer_started = time.perf_counter()
    tick = time.perf_counter()
    decoded_frames = load_video(request["source"])
    stages["source_decode_s"] = time.perf_counter() - tick
    if not decoded_frames:
        raise ValueError("Input video contains no decodable frames")
    frames, decoder_tail_frames_dropped = reconcile_decoded_frames(
        decoded_frames, source_metadata["frames"]
    )
    chunks = plan_shared_vae_chunks(
        len(frames), devices, int(config["chunk_frames"]), int(config["overlap_frames"])
    )
    global_noise = GlobalLatentNoise(torch, len(frames), request["seed"])
    interpolate_overlaps = config.get("interpolate_overlaps", False)
    if type(interpolate_overlaps) is not bool:
        raise TypeError("shared VAE interpolate_overlaps must be a boolean")
    has_audio = source_metadata["audio"]
    from .cuda_transfers import CudaPeerTransfers

    transfer_mode = config.get("transfer_mode", "blocking")
    cuda_transfers = CudaPeerTransfers(torch, mode=transfer_mode)
    transfers = cuda_transfers.transfers
    chunk_reports: dict[int, dict[str, object]] = {}

    def transfer(
        tensor: Tensor, destination: int, chunk_index: int, direction: str,
    ) -> tuple[Tensor, Event | None, TransferReport]:
        return cuda_transfers.enqueue(
            tensor, destination, chunk_index=chunk_index, direction=direction,
        )

    def encode(chunk: VideoChunk) -> tuple[Tensor, Tensor, Event | None]:
        padded = pad_video_frames(frames[chunk.input_start:chunk.input_end])
        encode_stages: dict[str, float] = {}
        tick = time.perf_counter()
        with torch.cuda.device(vae_device):
            latents = vae.encode_conditioning(
                padded, width=request["width"], height=request["height"],
                dtype=transformers[chunk.device].transformer.dtype,
                stage_timings=encode_stages,
            )
            torch.cuda.synchronize(vae_device)
        elapsed = time.perf_counter() - tick
        stages["vae_encode_and_upsample_s"] += elapsed
        for name, seconds in encode_stages.items():
            stages[name] += seconds
        chunk_reports[chunk.index] = {**asdict(chunk), "processed_frames": len(padded),
                                     "padding_frames": len(padded) - chunk.input_frames,
                                     "core_frame_range": [chunk.core_start, chunk.core_end],
                                     "input_frame_range": [chunk.input_start, chunk.input_end],
                                     "source_frames": chunk.input_frames,
                                     "temporal_overlap_frames": int(config["overlap_frames"]),
                                     "encode_s": elapsed, **encode_stages}
        latents, transfer_event, _transfer = transfer(
            latents, int(chunk.device), chunk.index, "conditioning_to_transformer",
        )
        noise = global_noise.for_chunk(chunk, latents)
        return latents, noise, transfer_event

    def refine(chunk: VideoChunk, encoded: tuple[Tensor, Tensor, Event | None]) -> tuple[Tensor, float]:
        pipe = transformers[chunk.device]
        device = int(chunk.device)
        latents, noise, transfer_event = encoded
        with torch.cuda.device(device), torch.no_grad():
            cuda_transfers.wait_on_consumer(latents, transfer_event)
            tick = time.perf_counter()
            embeddings, mask = pipe.shared_prompt
            result = pipe.refine_conditioned_latents(
                latents, embeddings, prompt_attention_mask=mask, frame_rate=float(fps),
                noise=noise,
            )
            torch.cuda.synchronize(device)
        return result, time.perf_counter() - tick

    writer = ChunkFrameWriter(
        request, chunks, len(frames), fps, has_audio, torch,
        interpolate_overlaps=interpolate_overlaps,
    )

    def consume(chunk: VideoChunk, result: tuple[Tensor, float]) -> None:
        nonlocal decoder_tail_frames_dropped
        latents, transformer_s = result
        stages["transformer_s"] += transformer_s
        chunk_reports[chunk.index]["transformer_s"] = transformer_s
        latents, transfer_event, _transfer = transfer(
            latents, vae_device, chunk.index, "refined_to_vae",
        )
        tick = time.perf_counter()
        with torch.cuda.device(vae_device), torch.no_grad():
            cuda_transfers.wait_on_consumer(latents, transfer_event)
            latents = vae.denormalize_conditioned_latents(latents)
            decoded_pixels = decode_pruna_vae(
                latents, request["width"], request["height"], torch,
                tile_size=int(request.get("pruna_tile_size", 1024)),
                tile_stride=int(request.get("pruna_tile_stride", 1024)),
                frame_count=chunk.input_frames,
            )
            pixels, chunk_decoder_tail_frames_dropped = reconcile_decoded_frames(
                decoded_pixels, chunk.input_frames,
            )
            decoder_tail_frames_dropped += chunk_decoder_tail_frames_dropped
            torch.cuda.synchronize(vae_device)
            elapsed = time.perf_counter() - tick
            stages["vae_decode_s"] += elapsed
            chunk_reports[chunk.index]["decode_s"] = elapsed
            tick = time.perf_counter()
            writer.consume(chunk, pixels)
            stages["blend_and_export_s"] += time.perf_counter() - tick

    try:
        max_inflight = run_bounded_chunks(chunks, encode, refine, consume)
        inference_s = time.perf_counter() - infer_started
        export = writer.finish(fps, has_audio)
        stages["final_encode_wait_s"] = cast(float, export["ffmpeg_wait_seconds"])
    except BaseException:
        writer.abort()
        raise
    finally:
        cuda_transfers.finish()
        stages["latent_transfer_s"] = sum(item["seconds"] for item in transfers)
        stages["latent_transfer_submit_s"] = sum(
            item["submit_seconds"] for item in transfers
        )
    processed = sum(cast(int, report["processed_frames"]) for report in chunk_reports.values())
    peak: dict[str, dict[str, object]] = {
        str(device): {"gpu": torch.cuda.get_device_name(device),
                      "allocated_bytes": torch.cuda.max_memory_allocated(device),
                      "reserved_bytes": torch.cuda.max_memory_reserved(device)}
        for device in all_devices
    }
    return {
        "status": "succeeded", "model": MODEL_ID, "model_revision": MODEL_REVISION,
        "gpu": torch.cuda.get_device_name(vae_device), "torch": torch.__version__,
        "cuda": torch.version.cuda, "python": sys.version.split()[0],
        "allocator_config": os.environ.get("PYTORCH_ALLOC_CONF", ""),
        "natten_backend": "not-used", "model_residency": "cuda",
        "cpu_offload_enabled": False, "decoder_fused_rope_modules": 0,
        "transformer_precision": request.get("transformer_precision", "nvfp4"),
        "transformer_compiled": all(pipe.transformer_compiled for pipe in transformers.values()),
        "fixed_conditioning_enabled": True, "fixed_conditioning_sha256": fixed.sha256,
        "text_encoder_loaded": False, "decoder_mode": "pruna_fast",
        "pruna_tile_size": int(request.get("pruna_tile_size", 1024)),
        "pruna_tile_stride": int(request.get("pruna_tile_stride", 1024)),
        "frames": len(frames), "processed_frames": processed,
        "decoder_tail_frames_dropped": decoder_tail_frames_dropped,
        "trimmed_padding_frames": sum(cast(int, report["padding_frames"]) for report in chunk_reports.values()),
        "trimmed_context_frames": sum(chunk.input_frames for chunk in chunks) - len(frames),
        "width": request["width"], "height": request["height"],
        "fps": f"{fps.numerator}/{fps.denominator}", "duration_seconds": len(frames) / float(fps),
        "audio_preserved": has_audio, "seed": request["seed"], "decoder_seed": request["decoder_seed"],
        "prompt": request["prompt"], "model_load_s": model_load_s, "inference_s": inference_s,
        "inference_seconds_scope": "staged pipeline wall including source decode/export writes; excludes model load/final encoder wait",
        "total_seconds": time.perf_counter() - started, "output": str(output), "export": export,
        "peak_allocated_bytes": max(cast(int, item["allocated_bytes"]) for item in peak.values()),
        "peak_reserved_bytes": max(cast(int, item["reserved_bytes"]) for item in peak.values()),
        "shared_vae_benchmark": {
            "source_frames": len(frames), "temporal_overlap_frames": int(config["overlap_frames"]),
            "overlap_interpolation_enabled": interpolate_overlaps,
            "transfer_mode": transfer_mode,
            "decoder_tail_frames_dropped": decoder_tail_frames_dropped,
            "topology": {"vae_device": vae_device, "upscale_devices": list(map(int, devices)),
                         "same_host": True, "vae_copies": 1, "transformer_copies": len(devices),
                         "vae_device_components": ["conditioning_vae", "latent_upsampler", "pruna_decoder"]},
            "stages": stages, "stage_seconds_scope": "CUDA-event peer-copy durations plus synchronized model stages; concurrent transformer sums are not wall time",
            "transfers": transfers, "latent_transfer_bytes": sum(item["bytes"] for item in transfers),
            "chunks": [chunk_reports[chunk.index] for chunk in chunks], "peak_memory_by_device": peak,
            "max_inflight_chunks": max_inflight, "source_decode_count": 1,
            "source_probe_count": 1,
            "intermediate_video_files": 0, "final_encode_count": 1,
            "blend_seconds": writer.blend_seconds,
            "noise_mode": "global_latent",
            "noise_seed": request["seed"],
            "noise_temporal_stride_frames": 8,
            "quality_note": "Each chunk receives the corresponding slice of one clip-wide seeded latent-noise field. VAE context resets and truncated transformer context still differ from full-clip inference.",
        },
    }
