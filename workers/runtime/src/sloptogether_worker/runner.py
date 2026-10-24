from __future__ import annotations

import hashlib
import json
import logging
import os
import re
import shutil
import subprocess
import sys
import tempfile
import threading
import time
import ctypes
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable, Mapping

from .client import Lease, WorkerApi
from .comfy import MAX_FRAME_BYTES, MAX_VIDEO_BYTES, ComfyClient, build_job_workflow
from .config import WorkerConfig
from .errors import WorkerError
from .models import WorkerJob
from .recipes import RECIPES, validate_comfy_capabilities, validate_device_recipe, validate_free_vram

_LOG = logging.getLogger("sloptogether.worker")
GENERATION_MAX_OUTPUT_BYTES = 128 * 1024 * 1024
UPSCALE_MAX_OUTPUT_BYTES = 256 * 1024 * 1024


class LeaseHeartbeat:
    def __init__(self, api: WorkerApi, lease: Lease, interval_seconds: int = 30) -> None:
        self.api = api
        self.lease = lease
        self.interval_seconds = interval_seconds
        self.cancelled = threading.Event()
        self.stop = threading.Event()
        self.phase = "starting"
        self.progress = 0.0
        self.thread: threading.Thread | None = None

    def start(self) -> None:
        self.thread = threading.Thread(target=self._loop, name="sloptogether-lease", daemon=True)
        self.thread.start()

    def _loop(self) -> None:
        while not self.stop.wait(self.interval_seconds):
            try:
                result = self.api.heartbeat(self.lease, phase=self.phase, progress=self.progress)
                if result.get("state") in {"cancelled", "expired", "revoked", "fenced"} or result.get("accepted") is False:
                    self.cancelled.set()
                    return
            except WorkerError as error:
                if getattr(error, "status", None) in {401, 403, 404, 409}:
                    self.cancelled.set()
                    return
                # A transient heartbeat outage cannot authorize publishing after
                # the local hard deadline. The render remains untrusted until
                # the server accepts its current fence.
                if time.time() >= self.lease_deadline.timestamp():
                    self.cancelled.set()
                    return

    @property
    def lease_deadline(self) -> datetime:
        return datetime.fromisoformat(self.lease.job_payload["attemptDeadlineAt"].replace("Z", "+00:00"))

    def update(self, phase: str, progress: float) -> None:
        self.phase = phase
        self.progress = max(0.0, min(1.0, progress))

    def close(self) -> None:
        self.stop.set()
        if self.thread:
            self.thread.join(timeout=2)


class ComfyRecipeRunner:
    def __init__(self, config: WorkerConfig, comfy: ComfyClient) -> None:
        self.config = config
        self.comfy = comfy
        self._qualified_by_role: dict[str, list[str]] = {}

    def check_compatible_nodes(self, role: str) -> list[str]:
        cached = self._qualified_by_role.get(role)
        if cached is not None:
            return cached.copy()
        if not shutil.which("ffmpeg") or not shutil.which("ffprobe"):
            raise WorkerError("ffmpeg_tools_missing","Install ffmpeg and ffprobe before running a media worker.")
        nodes = self.comfy.object_info()
        capability = detect_gpu_capability()
        if (role == "generation"
                and getattr(self.config, "trim_vsa_budget_policy", "fixed") == "adaptive"
                and capability[0] != (12, 0)):
            raise WorkerError(
                "trim_adaptive_gpu_profile_mismatch",
                "Adaptive Trim VSA requires the SM120 GPU profile pinned by this Fal deployment.",
            )
        recipes = validate_comfy_capabilities(
            nodes,
            role,
            compute_capability=capability[0],
            platform=self.config.platform,
            vsa_budget_policy=getattr(self.config, "trim_vsa_budget_policy", "fixed"),
        )
        qualified: list[str] = []
        free_memory = detect_gpu_free_memory()
        system_memory = detect_system_memory()
        for recipe_id in recipes:
            validate_device_recipe(recipe_id, capability[0], capability[1], system_memory)
            qualified.append(recipe_id)
        recipes = qualified
        if not recipes:
            if role in {"generation", "upscale"} and self.config.platform == "windows":
                raise WorkerError(
                    "windows_inference_runtime_unavailable",
                    "The imported FastH3 and SoL Comfy runtimes are Linux-only; no Windows inference runtime is installed.",
                )
            raise WorkerError("no_qualified_recipe", "This device does not have the nodes/GPU profile for the requested worker role.")
        for recipe_id in recipes:
            try:
                validate_free_vram(recipe_id, free_memory, capability[0], capability[1])
            except WorkerError as error:
                if error.code != "gpu_memory_reservation_insufficient" or not self.comfy.queue_is_idle():
                    raise
                # This worker owns its idle Comfy instance; release its warm model cache once on startup.
                self.comfy.release_idle_models()
                deadline = time.monotonic() + 30
                while time.monotonic() < deadline:
                    free_memory = detect_gpu_free_memory()
                    try:
                        validate_free_vram(recipe_id, free_memory, capability[0], capability[1])
                        break
                    except WorkerError:
                        time.sleep(1)
                validate_free_vram(recipe_id, free_memory, capability[0], capability[1])
        # Comfy keeps reusable model weights resident between jobs. Rechecking
        # cold free-VRAM thresholds before every lease would reject the worker's
        # own warm cache after its first successful render.
        self._qualified_by_role[role] = recipes.copy()
        return recipes

    def execute(self, job: WorkerJob, lease: Lease, heartbeat: LeaseHeartbeat, api: WorkerApi, job_directory: Path,
                *, cancelled: Callable[[], bool] | None = None) -> tuple[Path, dict[str, Any]]:
        def cancellation_requested() -> bool:
            return heartbeat.cancelled.is_set() or bool(cancelled and cancelled())

        recipe = RECIPES.get(job.recipe_id)
        if recipe is None:
            raise WorkerError("recipe_not_allowed", "The requested recipe is not in this worker's pinned profiles.")
        available = self.check_compatible_nodes("generation" if job.stage == "generation" else "upscale")
        if recipe.recipe_id not in available:
            raise WorkerError("recipe_not_qualified_for_device", "This recipe is not qualified for the detected GPU profile.")
        if datetime.now(timezone.utc) >= job.attempt_deadline_at:
            raise WorkerError("attempt_deadline_elapsed", "The authorized attempt deadline has expired.")

        state_dir = self.config.state_dir.resolve()
        if job_directory.is_symlink() or job_directory.parent.resolve() != state_dir:
            raise WorkerError("worker_workspace_invalid", "Worker attempt workspace is outside its private state directory.")
        comfy_inputs: list[str] = []
        try:
            files: dict[str, str] = {}
            if job.stage == "generation":
                start = self._fetch_asset(api, lease, job.start_frame_asset_id or "", job_directory, "start", MAX_FRAME_BYTES)
                start_name=self.comfy.temporary_input_filename(start.suffix)
                comfy_inputs.append(start_name)
                files["20"] = self.comfy.upload_image(start,start_name)
                if files["20"]!=start_name:comfy_inputs.append(files["20"])
                if job.requested_end_boundary_revision_id:
                    end = self._fetch_asset(api, lease, job.end_frame_asset_id or "", job_directory, "end", MAX_FRAME_BYTES)
                    end_name=self.comfy.temporary_input_filename(end.suffix)
                    comfy_inputs.append(end_name)
                    files["21"] = self.comfy.upload_image(end,end_name)
                    if files["21"]!=end_name:comfy_inputs.append(files["21"])
                output_suffix = ".mp4"
            elif job.stage == "upscale":
                source = self._fetch_asset(api, lease, job.source_asset_id or "", job_directory, "source", MAX_VIDEO_BYTES)
                files["source_video"] = self.comfy.upload_video_to_input_dir(source)
                comfy_inputs.append(files["source_video"])
                output_suffix = ".mp4"
            else:
                raise WorkerError("worker_stage_unsupported", "Story planning is a text service, not a GPU render stage.")

            output_node_id, workflow = build_job_workflow(
                job,
                recipe,
                files,
                vsa_budget_policy=getattr(self.config, "trim_vsa_budget_policy", "fixed"),
            )
            if cancellation_requested():
                raise WorkerError("attempt_revoked", "The server revoked this worker attempt.")
            heartbeat.update("running", 0.03)
            prompt_id = self.comfy.submit(workflow)
            try:
                self._send_attempt_identity(api, lease, prompt_id)
                api.heartbeat(lease, phase="running", progress=0.05)
                remaining = min(job.attempt_deadline_at.timestamp() - time.time(), self.config.request_timeout_seconds * 30)
                outputs = self.comfy.await_output(prompt_id, remaining, progress=lambda value: heartbeat.update("running", value), cancelled=cancellation_requested)
            except Exception:
                self.comfy.cancel_prompt(prompt_id)
                raise
            if cancellation_requested():
                raise WorkerError("attempt_revoked", "The server revoked this worker attempt.")
            candidates = [item for item in outputs if item.get("node_id") == output_node_id and item.get("filename", "").endswith(output_suffix)]
            if len(candidates) != 1:
                raise WorkerError("worker_output_ambiguous", "ComfyUI did not return exactly one expected video file.")
            if candidates[0].get("subfolder")!=f"sloptogether/{job.job_id}/{job.attempt_id}" or candidates[0].get("type")!="output":
                raise WorkerError("worker_output_scope_invalid","ComfyUI output did not match this job's isolated attempt folder.")
            result = job_directory / f"result{output_suffix}"
            size_limit = GENERATION_MAX_OUTPUT_BYTES if job.stage == "generation" else UPSCALE_MAX_OUTPUT_BYTES
            heartbeat.update("uploading", 0.8)
            self.comfy.download_output(candidates[0], result, size_limit)
            inspect_media(
                result,
                expected_fps=job.fps_num / job.fps_den if job.stage == "generation" else None,
                require_audio=job.require_audio,
            )
            normalized=job_directory/"sloptogether-16x9.mp4"
            normalize_16x9(result,normalized,job.output_width,job.output_height,job.attempt_deadline_at)
            facts=inspect_media(
                normalized,
                expected_fps=job.fps_num / job.fps_den if job.stage == "generation" else None,
                require_audio=job.require_audio,
            )
            if facts["width"]!=job.output_width or facts["height"]!=job.output_height:
                raise WorkerError("worker_output_aspect_invalid","Worker output did not conform to the channel's exact 16:9 frame.")
            return normalized, facts
        finally:
            try:
                for name in comfy_inputs:
                    self.comfy.remove_temporary_input(name)
            finally:
                self.comfy.remove_attempt_outputs(job.job_id,job.attempt_id)

    @staticmethod
    def _send_attempt_identity(api: WorkerApi, lease: Lease, provider_request_id: str) -> None:
        # Optional idempotent endpoint: the server records the provider identity
        # against this lease before recovery. A deployment can return 404 until
        # that route is installed; the job is still reconciled with its fence.
        try:
            api.record_provider_request(lease, provider_request_id)
        except WorkerError as error:
            if getattr(error, "status", None) not in {404, 405}:
                raise

    @staticmethod
    def _fetch_asset(api: WorkerApi, lease: Lease, asset_id: str, target_dir: Path, prefix: str, max_bytes: int) -> Path:
        if not asset_id:
            raise WorkerError("job_asset_missing", "The authorized job is missing a required source asset.")
        target = target_dir / f"{prefix}-{uuid_short()}{'.mp4' if prefix == 'source' else '.bin'}"
        api.download_asset(lease, asset_id, str(target), max_bytes=max_bytes)
        if prefix in {"start", "end"}:
            from .comfy import _image_mime
            mime = _image_mime(target)
            normalized = target.with_suffix({"image/png": ".png", "image/jpeg": ".jpg", "image/webp": ".webp"}[mime])
            target.replace(normalized)
            target = normalized
        if prefix == "source":
            with target.open("rb") as stream:
                signature = stream.read(16)
            if len(signature) < 12 or signature[4:8] != b"ftyp":
                raise WorkerError("source_video_invalid", "Upscale input is not a supported MP4 asset.")
        return target


def nvidia_smi_gpu_id(env: Mapping[str, str] | None = None) -> str | None:
    values = os.environ if env is None else env
    explicit = values.get("SLOPTOGETHER_GPU_ID")
    if explicit is not None:
        gpu_id = explicit.strip()
        return gpu_id if gpu_id and "," not in gpu_id and not any(c in gpu_id for c in "\r\n") else None
    if "CUDA_VISIBLE_DEVICES" not in values:
        return "0"
    visible = values["CUDA_VISIBLE_DEVICES"].split(",", 1)[0].strip()
    return visible if visible and visible not in {"-1", "NoDevFiles"} and not any(c in visible for c in "\r\n") else None


def detect_gpu_capability() -> tuple[tuple[int, int] | None, int | None, str | None]:
    executable = shutil.which("nvidia-smi")
    gpu_id = nvidia_smi_gpu_id()
    if not executable or gpu_id is None:
        return None, None, None
    try:
        process = subprocess.run(
            [executable, "--id", gpu_id, "--query-gpu=compute_cap,memory.total,name", "--format=csv,noheader,nounits"],
            shell=False,
            check=True,
            capture_output=True,
            text=True,
            timeout=5,
        )
    except (OSError, subprocess.SubprocessError):
        return None, None, None
    first = process.stdout.splitlines()[0].split(",", 2) if process.stdout.splitlines() else []
    if len(first) != 3:
        return None, None, None
    try:
        major, minor = (int(value) for value in first[0].strip().split(".", 1))
        memory_bytes = int(first[1].strip()) * 1024 * 1024
    except (ValueError, TypeError):
        return None, None, first[2].strip()[:128]
    return (major, minor), memory_bytes, first[2].strip()[:128]


def detect_gpu_free_memory() -> int | None:
    executable = shutil.which("nvidia-smi")
    gpu_id = nvidia_smi_gpu_id()
    if not executable or gpu_id is None:
        return None
    try:
        result = subprocess.run(
            [executable, "--id", gpu_id, "--query-gpu=memory.free", "--format=csv,noheader,nounits"],
            shell=False, check=True, capture_output=True, text=True, timeout=5,
        )
        free_mib = int(result.stdout.splitlines()[0].strip())
        return free_mib * 1024 * 1024
    except (OSError, subprocess.SubprocessError, ValueError, IndexError):
        return None


def detect_system_memory() -> int | None:
    """Return the physical RAM limit visible to this worker, if available."""
    total: int | None = None
    if sys.platform == "win32":
        class MemoryStatus(ctypes.Structure):
            _fields_ = [
                ("dwLength", ctypes.c_ulong), ("dwMemoryLoad", ctypes.c_ulong),
                ("ullTotalPhys", ctypes.c_ulonglong), ("ullAvailPhys", ctypes.c_ulonglong),
                ("ullTotalPageFile", ctypes.c_ulonglong), ("ullAvailPageFile", ctypes.c_ulonglong),
                ("ullTotalVirtual", ctypes.c_ulonglong), ("ullAvailVirtual", ctypes.c_ulonglong),
                ("ullAvailExtendedVirtual", ctypes.c_ulonglong),
            ]
        status = MemoryStatus()
        status.dwLength = ctypes.sizeof(status)
        if ctypes.windll.kernel32.GlobalMemoryStatusEx(ctypes.byref(status)):
            total = int(status.ullTotalPhys)
    else:
        try:
            total = int(os.sysconf("SC_PAGE_SIZE")) * int(os.sysconf("SC_PHYS_PAGES"))
        except (AttributeError, OSError, ValueError):
            pass
        for path in (Path("/sys/fs/cgroup/memory.max"), Path("/sys/fs/cgroup/memory/memory.limit_in_bytes")):
            try:
                raw = path.read_text().strip()
                limit = int(raw) if raw != "max" else None
            except (OSError, ValueError):
                continue
            if limit and limit < 2**60:
                total = min(total, limit) if total else limit
    return total if total and total > 0 else None


def uuid_short() -> str:
    import uuid
    return uuid.uuid4().hex


def inspect_media(path: Path, *, expected_fps: float | None, require_audio: bool = False) -> dict[str, object]:
    executable = shutil.which("ffprobe")
    if not executable:
        raise WorkerError("ffprobe_missing", "Install ffprobe or use the managed worker profile.")
    try:
        result = subprocess.run(
            [executable, "-v", "error", "-show_streams", "-show_format", "-of", "json", str(path)],
            shell=False,
            check=True,
            capture_output=True,
            text=True,
            timeout=15,
        )
        metadata = json.loads(result.stdout)
    except (OSError, subprocess.SubprocessError, json.JSONDecodeError):
        raise WorkerError("media_probe_failed", "Could not inspect the worker output media.") from None
    streams = metadata.get("streams")
    video = next((stream for stream in streams if stream.get("codec_type") == "video"), None) if isinstance(streams, list) else None
    if not isinstance(video, dict):
        raise WorkerError("worker_output_missing_video", "Worker output contains no video stream.")
    audio = [stream for stream in streams if stream.get("codec_type") == "audio"] if isinstance(streams, list) else []
    if require_audio and not audio:
        raise WorkerError("worker_output_audio_missing", "This clip requires a generated dialogue/audio track.")
    duration_raw = (metadata.get("format") or {}).get("duration")
    try:
        duration = float(duration_raw)
    except (TypeError, ValueError):
        raise WorkerError("worker_output_duration_unknown", "Worker output has no measurable duration.") from None
    if not 0.5 <= duration <= 18.0:
        raise WorkerError("worker_output_duration_invalid", "Worker output duration is outside the supported clip interval.")
    width, height = video.get("width"), video.get("height")
    if type(width) is not int or type(height) is not int or width < 64 or height < 64 or width > 3840 or height > 2160:
        raise WorkerError("worker_output_dimensions_invalid", "Worker output dimensions are outside the supported limits.")
    fps_raw = video.get("avg_frame_rate") or video.get("r_frame_rate")
    fps: float | None = None
    if isinstance(fps_raw, str) and "/" in fps_raw:
        numerator, denominator = fps_raw.split("/", 1)
        try:
            fps = float(numerator) / float(denominator)
        except (ValueError, ZeroDivisionError):
            fps = None
    if expected_fps and (fps is None or abs(fps - expected_fps) > 0.1):
        raise WorkerError("worker_output_fps_invalid", "Worker output frame rate does not match its recipe.")
    return {"width": width, "height": height, "fps": fps, "durationSeconds": duration, "hasAudio": bool(audio)}


def normalize_16x9(source:Path,destination:Path,width:int,height:int,deadline:datetime)->None:
    if width<64 or height<64 or width*9!=height*16 or width%2 or height%2:
        raise WorkerError("worker_output_geometry_invalid","The server requested a non-16:9 publication frame.")
    executable=shutil.which("ffmpeg")
    if not executable:
        raise WorkerError("ffmpeg_missing","Install ffmpeg to conform worker output to the channel's 16:9 format.")
    remaining=deadline.timestamp()-time.time()
    if remaining<=0:
        raise WorkerError("attempt_deadline_elapsed","The authorized attempt deadline has expired.")
    vf=(f"scale={width}:{height}:force_original_aspect_ratio=decrease:force_divisible_by=2,"
        f"pad={width}:{height}:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1")
    command=[executable,"-hide_banner","-loglevel","error","-nostdin","-y","-i",str(source),
        "-map","0:v:0","-map","0:a?","-map_metadata","-1","-map_chapters","-1",
        "-vf",vf,"-c:v","libx264","-preset","veryfast","-crf","18","-pix_fmt","yuv420p",
        "-c:a","aac","-b:a","128k","-threads","2","-movflags","+faststart",str(destination)]
    try:
        subprocess.run(command,shell=False,check=True,capture_output=True,timeout=max(1,min(180,remaining)))
    except subprocess.TimeoutExpired:
        raise WorkerError("worker_output_conform_timeout","16:9 output encoding exceeded the worker's attempt deadline.") from None
    except (OSError,subprocess.CalledProcessError):
        destination.unlink(missing_ok=True)
        raise WorkerError("worker_output_conform_failed","Could not encode the generated clip to the channel's 16:9 output.") from None
