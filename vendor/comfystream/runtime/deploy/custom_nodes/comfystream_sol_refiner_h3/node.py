"""Standalone ComfyUI node for NVIDIA's H3-specific LTX-2.5 SoL refiner."""

from __future__ import annotations

import atexit
import gc
import json
import math
import os
import shutil
import subprocess  # noqa: F401 - preserve the historical node-module patch surface.
import sys
import tempfile
import threading
import time
import uuid
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
from fractions import Fraction
from pathlib import Path
from types import ModuleType
from typing import TYPE_CHECKING, Literal, Protocol, cast

if TYPE_CHECKING:
    from torch import Tensor

    from .sol_refiner_h3 import SoLRefinerH3Pipeline

from .distributed import (
    assemble_chunks,
    extract_chunk,
    parse_devices,
    plan_chunks,
    probe_video,
    resolve_visible_devices,
)
from .media_export import (
    ASYNC_NVENC_STAGING_ENV,
    GPU_AMINMAX_ENV,
    NVENC_INPUT_FORMAT_ENV,
    NVENC_INPUT_HASH_ENV,
    NVENC_PRESET_ENV,
    _encoder_args,
    _experiment_flag,
    _ffmpeg_executable,
    _gpu_pixel_range,
    _nvenc_input_pixel_format,
    _nvenc_preset,
    _pack_rgb_as_yuv420p,
    _write_frames,
    _write_gpu_frames,
    ffmpeg_export_command,
)
from .media_metadata import probe_source_metadata
from .model_runtime import _RUNTIME as _MODEL_RUNTIME
from .model_runtime import (
    CPU_PREPROCESS_OVERLAP_ENV,
    CPU_TEXT_ENCODER_ENV,
    DEFAULT_OUTPUT_HEIGHT,
    DEFAULT_OUTPUT_WIDTH,
    MODEL_ID,
    MODEL_RESIDENCY,
    MODEL_REVISION,
    PYTHON_VERSION,
    TORCH_CUDA_VERSION,
    TORCH_VERSION,
    VIDEO_ONLY_REFINER_ENV,
    WORKER_TORCH_VERSION,
)
from .protocol import WorkerRequest
from .shared_vae_plan import shared_vae_topology, validate_chunk_settings
from .sloptogether_scope import refiner_output_directory
from .worker_client import WorkerClientRegistry, worker_environment_fingerprint
from .hardware_profiles import configure_pipeline_device, resident_reuse_is_safe, select_transformer_precision

DEFAULT_SIGMA = 0.9093750119
DEFAULT_WORKER_RESPONSE_TIMEOUT_SECONDS = 1800.0
TRANSFORMER_COMPILE_ENV = "COMFYSTREAM_SOL_H3_COMPILE_TRANSFORMER"
_EXECUTION_LOCK = threading.RLock()
_WORKER_REGISTRY = WorkerClientRegistry()


@dataclass(frozen=True)
class _ResidentProof:
    token: object
    signature: tuple[object, ...]
    profile: tuple[object, ...]
    frames: int
    peak_reserved_bytes: int


_RESIDENT_PROOF: _ResidentProof | None = None


def _worker_response_timeout_seconds() -> float:
    """Return the bounded worker wait, allowing longer jobs through an env override."""
    raw = os.environ.get("COMFYSTREAM_SOL_H3_TIMEOUT_SECONDS")
    if raw is None:
        return DEFAULT_WORKER_RESPONSE_TIMEOUT_SECONDS
    try:
        timeout = float(raw)
    except ValueError as exc:
        raise ValueError("COMFYSTREAM_SOL_H3_TIMEOUT_SECONDS must be a positive number") from exc
    if not math.isfinite(timeout) or timeout <= 0:
        raise ValueError("COMFYSTREAM_SOL_H3_TIMEOUT_SECONDS must be a positive number")
    return timeout


def _transformer_precision_mode(value: str = "nvfp4") -> Literal["auto", "bf16", "fp8", "mxfp8", "nvfp4"]:
    """Select a memory profile or validate an explicit transformer precision."""
    mode = str(value).strip().lower() or "nvfp4"
    if mode == "auto":
        import torch
        return cast(Literal["auto", "bf16", "fp8", "mxfp8", "nvfp4"], select_transformer_precision(
            torch.cuda.get_device_capability(),
            torch.cuda.get_device_properties(0).total_memory,
            torch.cuda.mem_get_info()[0],
            release_resident_worker=_stop_worker if "single" in _WORKER_REGISTRY.keys() else None,
            probe_free_memory=lambda: torch.cuda.mem_get_info()[0],
        ))
    if mode not in {"bf16", "fp8", "mxfp8", "nvfp4"}:
        raise ValueError("transformer_precision must be 'auto', 'bf16', 'fp8', 'mxfp8', or 'nvfp4'")
    return cast(Literal["auto", "bf16", "fp8", "mxfp8", "nvfp4"], mode)


class VideoComponents(Protocol):
    frame_rate: Fraction
    images: Tensor


class VideoInput(Protocol):
    """The small Comfy VIDEO surface consumed by this node."""

    def get_stream_source(self) -> object: ...

    def get_dimensions(self) -> tuple[int, int]: ...

    def get_components(self) -> VideoComponents: ...


def _stop_worker() -> None:
    """Stop the single-GPU persistent child owned by the transport registry."""
    global _RESIDENT_PROOF
    _RESIDENT_PROOF = None
    _WORKER_REGISTRY.close("single")


def _stop_distributed_worker(device: str) -> None:
    _WORKER_REGISTRY.close(f"device:{device}")


def _worker_preparation(
    package_dir: Path, *, device: str | None = None,
) -> tuple[dict[str, str], tuple[tuple[str, int], ...], str]:
    # A reused process must reflect every local Python module, not only a
    # hand-maintained subset of imports. Contents and credentials stay out of
    # the signature and logs; modification timestamps trigger a cold reload.
    files = sorted(package_dir.glob("*.py")) + [package_dir / "runtime.json"]
    files.extend(sorted((package_dir / "sol_refiner_h3").glob("*.py")))
    environment = dict(os.environ)
    # Comfy's allocator alias would override the child's canonical setting.
    environment.pop("PYTORCH_CUDA_ALLOC_CONF", None)
    environment.setdefault("PYTORCH_ALLOC_CONF", "expandable_segments:True")
    if device is not None:
        environment["CUDA_VISIBLE_DEVICES"] = device
    sources = tuple((str(path), path.stat().st_mtime_ns) for path in files)
    return environment, sources, worker_environment_fingerprint(environment)


def _request_worker_on_device(
    worker_python: str, request: WorkerRequest, target_dir: Path, device: str, slot: str,
    *, worker_script: str = "worker.py",
) -> dict[str, object]:
    """Run one chunk on a persistent isolated process pinned to one CUDA device."""
    if worker_script not in {"worker.py", "shared_vae_worker.py"}:
        raise ValueError("Unsupported isolated worker script")
    package_dir = Path(__file__).resolve().parent
    environment, sources, environment_fingerprint = _worker_preparation(package_dir, device=device)
    signature: tuple[object, ...] = (
        worker_python, worker_script, sources, environment_fingerprint,
    )
    if worker_script == "shared_vae_worker.py":
        signature += (
            request["prompt"], request.get("transformer_precision", "nvfp4"),
            json.dumps(request.get("shared_vae", {}).get("upscale_devices", [])),
            _transformer_experiment_flags("pruna_fast", request["width"], request["height"]),
            os.environ.get("COMFYSTREAM_SOL_H3_CONDITIONING_ARTIFACT", ""),
            os.environ.get(VIDEO_ONLY_REFINER_ENV, "0"),
        )
    log_path = target_dir.parent / f"worker-cuda-{slot}.log"
    response, pid, _ = _WORKER_REGISTRY.request(
        f"device:{device}", signature,
        [worker_python, str(package_dir / worker_script), "--serve"],
        environment, log_path, request,
        timeout=_worker_response_timeout_seconds(), label=f"CUDA worker {slot}",
    )
    if response["status"] != "succeeded":
        raise RuntimeError(f"CUDA worker {slot} failed: {response['error']}")
    report = response["report"]
    if "shared_vae" in request:
        details = report.get("shared_vae_benchmark")
        if (not isinstance(details, dict)
                or details.get("topology", {}).get("upscale_devices")
                != request["shared_vae"]["upscale_devices"]):
            _stop_distributed_worker(device)
            raise ValueError("Shared VAE worker response does not match its requested topology")
    report.update({"worker_persistent": True, "worker_pid": pid, "cuda_device_slot": slot})
    return report


def _stop_all_distributed_workers() -> None:
    _WORKER_REGISTRY.close_matching("device:")


def _stop_all_workers() -> None:
    _WORKER_REGISTRY.close_matching("")


atexit.register(_stop_all_workers)


def _request_worker(
    worker_python: str, request: WorkerRequest, target_dir: Path,
    *, prepared: tuple[dict[str, str], tuple[object, ...]] | None = None,
    required_token: object | None = None,
) -> dict[str, object]:
    """Reuse one isolated GPU worker for serialized Comfy node requests."""
    package_dir = Path(__file__).resolve().parent
    if prepared is None:
        environment, sources, environment_fingerprint = _worker_preparation(package_dir)
        signature = (worker_python, sources, environment_fingerprint)
    else:
        environment, signature = prepared
    response, pid, _ = _WORKER_REGISTRY.request(
        "single", signature,
        [worker_python, str(package_dir / "worker.py"), "--serve"],
        environment, target_dir / "worker.log", request,
        timeout=_worker_response_timeout_seconds(), label="SoL H3 worker",
        required_token=required_token,
    )
    if response["status"] != "succeeded":
        raise RuntimeError(f"SoL H3 worker failed: {response['error']}")
    report = response["report"]
    report.update({"worker_persistent": True, "worker_pid": pid})
    return report


def _resident_profile(
    source: str, *, source_width: int, source_height: int, fps: Fraction,
    width: int, height: int, decoder_mode: str, output_backend: str,
    prompt: str, cache_conditioning: bool,
) -> tuple[tuple[object, ...], int] | None:
    """Describe a source only when its measured geometry and timing agree."""
    try:
        info = probe_source_metadata(source)
        frames = info["frames"]
        if (type(frames) is not int or frames < 1 or info["width"] != source_width
                or info["height"] != source_height or info["fps"] != fps):
            return None
    except (OSError, ValueError, KeyError, TypeError, RuntimeError, OverflowError, ZeroDivisionError, subprocess.SubprocessError):
        return None
    return ((source_width, source_height, width, height, f"{fps.numerator}/{fps.denominator}", decoder_mode,
             output_backend, prompt, cache_conditioning), frames)


def _remember_resident_proof(
    *, signature: tuple[object, ...], profile: tuple[object, ...], frames: int,
    report: dict[str, object],
) -> None:
    global _RESIDENT_PROOF
    _RESIDENT_PROOF = None
    peak = report.get("peak_reserved_bytes")
    pid = report.get("worker_pid")
    if type(pid) is not int or pid <= 0:
        return
    token = _WORKER_REGISTRY.compatible_token("single", signature, expected_pid=pid)
    if (token is not None and report.get("status") == "succeeded"
            and report.get("transformer_precision") == "nvfp4"
            and report.get("model_residency") == "cuda"
            and report.get("frames") == frames and report.get("width") == profile[2]
            and report.get("height") == profile[3] and report.get("fps") == profile[4]
            and type(peak) is int and peak > 0):
        _RESIDENT_PROOF = _ResidentProof(token, signature, profile, frames, peak)


def padded_frame_count(frame_count: int, temporal_factor: int = 8) -> int:
    """Return the next supported 1 + k*factor length without shortening input."""
    frame_count = int(frame_count)
    temporal_factor = int(temporal_factor)
    if frame_count <= 0 or temporal_factor <= 0:
        raise ValueError("frame_count and temporal_factor must be positive")
    return 1 + math.ceil((frame_count - 1) / temporal_factor) * temporal_factor


def pad_video_frames[Frame](frames: list[Frame], temporal_factor: int = 8) -> list[Frame]:
    """Repeat only the last frame to satisfy LTX temporal geometry."""
    if not frames:
        raise ValueError("video must contain at least one frame")
    target = padded_frame_count(len(frames), temporal_factor)
    return [*frames, *([frames[-1]] * (target - len(frames)))]


def validate_upscale_geometry(source_width: int, source_height: int,
                              width: int, height: int) -> None:
    values = tuple(map(int, (source_width, source_height, width, height)))
    source_width, source_height, width, height = values
    if min(values) <= 0 or width % 2 or height % 2:
        raise ValueError("source and output dimensions must be positive; output must be even")
    if width < source_width or height < source_height:
        raise ValueError("upscale output dimensions cannot be smaller than the H3 input")
    if width * source_height != height * source_width:
        raise ValueError("output aspect ratio must match the H3 input; implicit cropping is disabled")


def _source_path(video: VideoInput, temporary_directory: str) -> tuple[str, str | None]:
    """Use Comfy's file-backed source when possible; materialize byte streams once."""
    get_stream_source = getattr(video, "get_stream_source", None)
    if not callable(get_stream_source):
        raise TypeError("video must be a ComfyUI VIDEO input with get_stream_source()")
    source = get_stream_source()
    if isinstance(source, (str, os.PathLike)):
        return os.fspath(source), None
    if not hasattr(source, "read"):
        raise TypeError("ComfyUI VIDEO returned an unsupported stream source")
    source.seek(0)
    target = os.path.join(temporary_directory, "source.mp4")
    with open(target, "wb") as output:
        shutil.copyfileobj(source, output, length=1024 * 1024)
    return target, target


def _transformer_experiment_flags(decoder_mode: str, width: int, height: int) -> bool:
    """Compile repeated transformer blocks by default for every fast upscale size."""
    compile_default = decoder_mode == "pruna_fast"
    compile_blocks = _experiment_flag(TRANSFORMER_COMPILE_ENV, default=compile_default)
    if decoder_mode != "pruna_fast" and compile_blocks:
        raise ValueError("Transformer speed experiments are limited to pruna_fast mode")
    return compile_blocks


def _load_pipeline(model_id: str, expected_torch: str = TORCH_VERSION,
                   *, optimize_decoder: bool = True,
                   decoder_mode: str = "diffusion",
                   transformer_precision: str = "nvfp4",
                   width: int = DEFAULT_OUTPUT_WIDTH, height: int = DEFAULT_OUTPUT_HEIGHT,
                   conditioning_artifact: Path | None = None,
                   fixed_prompt: str | None = None) -> SoLRefinerH3Pipeline:
    """Compatibility entry point; model_runtime owns loading and cache state."""
    pipeline: SoLRefinerH3Pipeline = _MODEL_RUNTIME.load_pipeline(
        model_id,
        expected_torch,
        optimize_decoder=optimize_decoder,
        decoder_mode=decoder_mode,
        transformer_precision=transformer_precision,
        width=width,
        height=height,
        conditioning_artifact=conditioning_artifact,
        fixed_prompt=fixed_prompt,
        transformer_flags=_transformer_experiment_flags,
        precision_mode=_transformer_precision_mode,
        experiment_flag=_experiment_flag,
        validate_runtime=validate_runtime,
        natten_backend_name=natten_backend_name,
        ensure_source_path=_ensure_refiner_source_path,
        keep_pipeline_on_cuda=_keep_pipeline_on_cuda,
    )
    return pipeline

def _keep_pipeline_on_cuda(pipeline: SoLRefinerH3Pipeline) -> None:
    """Use block-by-block CPU offload for Ada FP8; keep qualified fast models resident."""
    configure_pipeline_device(pipeline)


def validate_runtime(
    torch_module: ModuleType,
    python_version: tuple[int, int],
    *,
    expected_torch: str = TORCH_VERSION,
) -> None:
    """Require the same CUDA 13/PyTorch build pinned for FastH3 production."""
    if tuple(python_version) != PYTHON_VERSION:
        raise RuntimeError(f"This node requires Python 3.12; found {python_version!r}")
    if getattr(torch_module, "__version__", None) != expected_torch:
        raise RuntimeError(
            f"This runtime requires PyTorch {expected_torch}; "
            f"found {getattr(torch_module, '__version__', None)!r}"
        )
    if getattr(getattr(torch_module, "version", None), "cuda", None) != TORCH_CUDA_VERSION:
        raise RuntimeError(
            f"This node requires the CUDA {TORCH_CUDA_VERSION} PyTorch runtime; "
            f"found {getattr(getattr(torch_module, 'version', None), 'cuda', None)!r}"
        )


def _release_comfy_models() -> bool:
    """Free the completed H3 generator before the independent refiner loads."""
    try:
        from comfy import model_management
    except ImportError as exc:
        raise RuntimeError("This node must run inside ComfyUI") from exc
    unload = getattr(model_management, "unload_all_models", None)
    if not callable(unload):
        raise RuntimeError("This ComfyUI build cannot safely unload the completed H3 model")  # noqa: TRY004
    unload()
    empty_cache = getattr(model_management, "soft_empty_cache", None)
    if callable(empty_cache):
        empty_cache()
    return True


def natten_backend_name(compiled_flex: bool = False) -> str:
    try:
        import natten
    except ImportError:
        return "missing"
    if bool(getattr(natten, "HAS_LIBNATTEN", False)):
        return "libnatten"
    return "torch-flex-compiled" if compiled_flex else "torch-flex"


def _ensure_refiner_source_path() -> str:
    """Expose the vendored upstream package name expected by Diffusers configs."""
    source = str(Path(__file__).resolve().parent)
    if source in sys.path:
        sys.path.remove(source)
    sys.path.insert(0, source)
    return source


def _video_frame_rate(video: VideoInput) -> Fraction:
    get_frame_rate = getattr(video, "get_frame_rate", None)
    if callable(get_frame_rate):
        rate = Fraction(get_frame_rate())
    else:
        components = video.get_components()
        rate = Fraction(components.frame_rate)
    if rate <= 0:
        raise ValueError("input video frame rate must be positive")
    return rate


def _has_audio(source: str) -> bool:
    try:
        import av
    except ImportError as exc:
        raise RuntimeError("PyAV is required to inspect the source audio stream") from exc
    with av.open(source) as container:
        return len(container.streams.audio) > 0


class MiniMaxH3SoLUpscaler:
    """Video-to-video LTX-2.5 SoL Refiner specialized for MiniMax-H3 output."""

    RETURN_TYPES = ("VIDEO", "STRING")
    RETURN_NAMES = ("video", "report")
    FUNCTION = "refine"
    CATEGORY = "ComfyStream/Upscale"
    OUTPUT_NODE = True

    @classmethod
    def INPUT_TYPES(cls) -> dict[str, object]:
        return {
            "required": {
                "video": ("VIDEO",),
                "prompt": ("STRING", {"multiline": True, "default": ""}),
                "width": ("INT", {"default": DEFAULT_OUTPUT_WIDTH, "min": 64, "max": 3840, "step": 8}),
                "height": ("INT", {"default": DEFAULT_OUTPUT_HEIGHT, "min": 64, "max": 2160, "step": 8}),
                "seed": ("INT", {"default": 303000, "min": 0, "max": 0x7FFFFFFFFFFFFFFF}),
                "decoder_seed": ("INT", {"default": 20260826, "min": 0, "max": 0x7FFFFFFFFFFFFFFF}),
                "decoder_mode": (["pruna_fast", "diffusion"], {"default": "pruna_fast"}),
                "output_backend": (["nvenc", "libx264"], {"default": "nvenc"}),
            },
            "optional": {
                "cache_conditioning": ("BOOLEAN", {"default": False}),
                "transformer_precision": (["auto", "nvfp4", "mxfp8", "fp8", "bf16"], {"default": "nvfp4"}),
                "sloptogether_scope": ("STRING", {"default": "", "multiline": False}),
            },
        }

    @classmethod
    def IS_CHANGED(
        cls,
        video: object,
        prompt: str,
        width: int,
        height: int,
        seed: int,
        decoder_seed: int,
        decoder_mode: str,
        output_backend: str,
        **_kwargs: object,
    ) -> float:
        # A video object is opaque to Comfy's cache. Force one run per execution
        # to avoid accidentally returning a previous clip for a different input.
        return float("nan")

    def refine(
        self,
        video: VideoInput,
        prompt: str,
        width: int = DEFAULT_OUTPUT_WIDTH,
        height: int = DEFAULT_OUTPUT_HEIGHT,
        seed: int = 303000,
        decoder_seed: int = 20260826,
        decoder_mode: str = "pruna_fast",
        output_backend: str = "nvenc",
        execution_mode: str = "single_gpu",
        cache_conditioning: bool = False,
        transformer_precision: str = "nvfp4",
        cuda_devices: str = "0,1",
        temporal_overlap_frames: int = 16,
        vae_device: str = "0",
        chunk_frames: int = 96,
        interpolate_overlaps: bool = False,
        transfer_mode: Literal["blocking", "peer_event"] = "blocking",
        sloptogether_scope: str = "",
    ) -> tuple[VideoInput, str]:
        global _RESIDENT_PROOF
        if not str(prompt).strip():
            raise ValueError("Enter a scene or preservation prompt for the H3 upscaler")
        if type(cache_conditioning) is not bool:
            raise TypeError("cache_conditioning must be a boolean")
        if not isinstance(sloptogether_scope,str):
            raise TypeError("sloptogether_scope must be a string")
        if output_backend not in {"nvenc", "libx264"}:
            raise ValueError("Unsupported output encoder")
        if decoder_mode not in {"diffusion", "pruna_fast"}:
            raise ValueError("Unsupported decoder mode")
        if execution_mode not in {"single_gpu", "multi_gpu_benchmark", "shared_vae_benchmark"}:
            raise ValueError("Unsupported execution mode")
        if type(temporal_overlap_frames) is not int:
            raise TypeError("temporal overlap must be an integer")
        if type(interpolate_overlaps) is not bool:
            raise TypeError("interpolate_overlaps must be a boolean")
        if execution_mode == "shared_vae_benchmark" and transfer_mode not in {
            "blocking", "peer_event",
        }:
            raise ValueError("shared-VAE transfer mode must be blocking or peer_event")
        if execution_mode == "shared_vae_benchmark":
            if decoder_mode != "pruna_fast":
                raise ValueError("shared VAE benchmark requires pruna_fast")
            validate_chunk_settings(chunk_frames, temporal_overlap_frames)
            shared_vae_topology(vae_device, cuda_devices, os.environ.get("CUDA_VISIBLE_DEVICES"))
        typed_decoder_mode = cast(Literal["diffusion", "pruna_fast"], decoder_mode)
        typed_output_backend = cast(Literal["nvenc", "libx264"], output_backend)

        import folder_paths
        from comfy_api.latest import InputImpl

        with _EXECUTION_LOCK:
            started = time.perf_counter()
            with tempfile.TemporaryDirectory(prefix="comfystream-h3-sol-") as temp_dir:
                source, owned_source = _source_path(video, temp_dir)
                dimensions = getattr(video, "get_dimensions", None)
                if callable(dimensions):
                    source_width, source_height = dimensions()
                else:
                    components = video.get_components()
                    source_height, source_width = map(int, components.images.shape[1:3])
                validate_upscale_geometry(source_width, source_height, int(width), int(height))
                fps = _video_frame_rate(video)
                comfy_models_unloaded = _release_comfy_models()

                worker_python = os.environ.get(
                    "COMFYSTREAM_SOL_H3_PYTHON",
                    str(Path(__file__).resolve().parent / ".worker" / "bin" / "python"),
                )
                if not Path(worker_python).is_file():
                    raise RuntimeError(
                        "SoL H3 worker runtime is missing. Run this node's install_runtime.sh "
                        "or set COMFYSTREAM_SOL_H3_PYTHON to a verified Torch 2.13/CUDA 13 worker."
                    )
                prepared: tuple[dict[str, str], tuple[object, ...]] | None = None
                warm_token: object | None = None
                if execution_mode == "single_gpu":
                    environment, sources, fingerprint = _worker_preparation(Path(__file__).resolve().parent)
                    signature = (worker_python, sources, fingerprint)
                    prepared = (environment, signature)
                    proof = _RESIDENT_PROOF
                    if str(transformer_precision).strip().lower() == "auto" and proof is not None:
                        profile = _resident_profile(source, source_width=source_width, source_height=source_height,
                            fps=fps, width=int(width), height=int(height), decoder_mode=decoder_mode,
                            output_backend=output_backend, prompt=str(prompt), cache_conditioning=cache_conditioning)
                        if profile is not None:
                            import torch
                            capability = torch.cuda.get_device_capability()
                            total_memory = torch.cuda.get_device_properties(0).total_memory
                            free_memory = torch.cuda.mem_get_info()[0]
                            token = _WORKER_REGISTRY.compatible_token("single", signature)
                            if resident_reuse_is_safe(capability, total_memory, free_memory, proof.peak_reserved_bytes,
                                    profile_matches=(proof.signature == signature and proof.profile == profile[0]
                                                     and profile[1] <= proof.frames),
                                    worker_matches=(token is proof.token)):
                                warm_token = token
                typed_transformer_precision = "nvfp4" if warm_token is not None else _transformer_precision_mode(transformer_precision)

                output_dir = Path(folder_paths.get_output_directory())
                target_dir = refiner_output_directory(output_dir,sloptogether_scope)
                target_dir.mkdir(parents=True, exist_ok=False)
                output = target_dir / "refined.mp4"
                partial = target_dir / "refined.partial.mp4"
                try:
                    request: WorkerRequest = {
                        "source": source,
                        "output": str(partial),
                        "prompt": str(prompt),
                        "width": int(width),
                        "height": int(height),
                        "fps": f"{fps.numerator}/{fps.denominator}",
                        "seed": int(seed),
                        "decoder_seed": int(decoder_seed),
                        "decoder_mode": typed_decoder_mode,
                        "output_backend": typed_output_backend,
                        "transformer_precision": typed_transformer_precision,
                    }
                    if cache_conditioning:
                        request["cache_conditioning"] = True
                    request_path = target_dir / "worker-request.json"
                    request_path.write_text(json.dumps(request, sort_keys=True))
                    if execution_mode == "single_gpu":
                        _stop_all_distributed_workers()
                        report = _request_worker(worker_python, request, target_dir, prepared=prepared, required_token=warm_token)
                    elif execution_mode == "multi_gpu_benchmark":
                        _stop_worker()
                        report = self._refine_multi_gpu_benchmark(
                            source=source, target_dir=target_dir, output=partial,
                            worker_python=worker_python, request=request,
                            devices=parse_devices(cuda_devices),
                            overlap=int(temporal_overlap_frames),
                            output_backend=typed_output_backend,
                        )
                    else:
                        _stop_worker()
                        report = self._refine_shared_vae_benchmark(
                            target_dir=target_dir, worker_python=worker_python,
                            request=request, vae_device=vae_device,
                            cuda_devices=cuda_devices, chunk_frames=chunk_frames,
                            overlap=temporal_overlap_frames,
                            interpolate_overlaps=interpolate_overlaps,
                            transfer_mode=transfer_mode,
                        )
                    if report.get("status") != "succeeded" or not partial.is_file():
                        raise RuntimeError("SoL H3 worker returned without a complete output video")
                    os.replace(partial, output)
                    if (prepared is not None and report.get("transformer_precision") == "nvfp4"
                            and report.get("model_residency") == "cuda"):
                        profile = _resident_profile(source, source_width=source_width, source_height=source_height,
                            fps=fps, width=int(width), height=int(height), decoder_mode=decoder_mode,
                            output_backend=output_backend, prompt=str(prompt), cache_conditioning=cache_conditioning)
                        if profile is not None:
                            _remember_resident_proof(signature=prepared[1], profile=profile[0], frames=profile[1], report=report)
                        else:
                            _RESIDENT_PROOF = None
                    else:
                        _RESIDENT_PROOF = None
                except BaseException:
                    _RESIDENT_PROOF = None
                    partial.unlink(missing_ok=True)
                    raise
                gc.collect()
                host_total_seconds = time.perf_counter() - started
                report.update({
                    "host_python": sys.version.split()[0],
                    "sigma": DEFAULT_SIGMA,
                    "steps": 1,
                    "output": str(output),
                    "worker_total_seconds": report.get("total_seconds"),
                    "host_total_seconds": host_total_seconds,
                    "total_seconds": host_total_seconds,
                    "source_was_materialized": owned_source is not None,
                    "comfy_models_unloaded_before_refinement": comfy_models_unloaded,
                })
                (target_dir / "worker-report.json").write_text(
                    json.dumps(report, sort_keys=True, indent=2) + "\n"
                )
                output_video = InputImpl.VideoFromFile(str(output))
                return output_video, json.dumps(report, sort_keys=True)

    def _refine_shared_vae_benchmark(
        self, *, target_dir: Path, worker_python: str, request: WorkerRequest,
        vae_device: str, cuda_devices: str, chunk_frames: int, overlap: int,
        interpolate_overlaps: bool = False,
        transfer_mode: Literal["blocking", "peer_event"] = "blocking",
    ) -> dict[str, object]:
        """Run one process with shared VAE service and resident upscale workers."""
        slots, resolved = shared_vae_topology(
            vae_device, cuda_devices, os.environ.get("CUDA_VISIBLE_DEVICES"),
        )
        validate_chunk_settings(chunk_frames, overlap)
        worker_visibility = ",".join(resolved)
        stale = tuple(
            key.removeprefix("device:")
            for key in _WORKER_REGISTRY.keys("device:")
            if key != f"device:{worker_visibility}"
        )
        for device in stale:
            _stop_distributed_worker(device)
        request["shared_vae"] = {
            "vae_device": 0, "upscale_devices": list(range(1, len(slots))),
            "chunk_frames": chunk_frames, "overlap_frames": overlap,
            "interpolate_overlaps": interpolate_overlaps,
            "transfer_mode": transfer_mode,
        }
        (target_dir / "worker-request.json").write_text(json.dumps(request, sort_keys=True))
        report = _request_worker_on_device(
            worker_python, request, target_dir, worker_visibility, "shared-vae",
            worker_script="shared_vae_worker.py",
        )
        if not isinstance(report.get("shared_vae_benchmark"), dict):
            raise TypeError("Shared VAE worker returned without its stage timing report")
        details = cast(dict[str, object], report["shared_vae_benchmark"])
        details.update({
            "cuda_device_slots": list(slots), "vae_cuda_device_slot": slots[0],
            "upscale_cuda_device_slots": list(slots[1:]),
            "transport_scope": "one host; CUDA tensor copies; no remote worker protocol",
            "transfer_mode": transfer_mode,
        })
        return report

    def _refine_multi_gpu_benchmark(
        self,
        *,
        source: str,
        target_dir: Path,
        output: Path,
        worker_python: str,
        request: WorkerRequest,
        devices: tuple[str, ...],
        overlap: int,
        output_backend: Literal["nvenc", "libx264"],
    ) -> dict[str, object]:
        """Run an experimental local-CUDA temporal split and assemble one clip."""
        source_facts = probe_video(source)
        fps = Fraction(request["fps"])
        if source_facts["fps"] != fps:
            raise ValueError("Comfy VIDEO frame rate does not match its source container")
        if source_facts["pixel_format"] != "yuv420p":
            raise ValueError("multi-GPU benchmark currently requires a YUV420P H3 source")
        if source_facts["width"] % 2 or source_facts["height"] % 2:
            raise ValueError("multi-GPU benchmark requires even source dimensions")
        visible_devices = resolve_visible_devices(devices, os.environ.get("CUDA_VISIBLE_DEVICES"))
        stale = tuple(
            key.removeprefix("device:")
            for key in _WORKER_REGISTRY.keys("device:")
            if key.removeprefix("device:") not in visible_devices
        )
        for device in stale:
            _stop_distributed_worker(device)
        chunks = plan_chunks(source_facts["frames"], visible_devices, overlap)
        inputs: list[Path] = []
        reports: list[dict[str, object]] = []
        split_seconds = 0.0
        for chunk in chunks:
            chunk_input = target_dir / f"chunk-{chunk.index:02d}-input.mp4"
            split_seconds += extract_chunk(source, chunk_input, chunk, fps)
            inputs.append(chunk_input)

        def refine_chunk(index: int) -> dict[str, object]:
            chunk = chunks[index]
            chunk_output = target_dir / f"chunk-{chunk.index:02d}-refined.mp4"
            chunk_request = dict(request)
            chunk_request.update({
                "source": str(inputs[index]),
                "output": str(chunk_output),
                "output_backend": "libx264_lossless",
            })
            return _request_worker_on_device(
                worker_python, cast(WorkerRequest, chunk_request), target_dir,
                chunk.device, devices[index],
            )

        with ThreadPoolExecutor(max_workers=len(chunks), thread_name_prefix="sol-h3-mgpu") as pool:
            futures = [pool.submit(refine_chunk, index) for index in range(len(chunks))]
            for future in futures:
                reports.append(future.result())

        chunk_outputs = tuple(target_dir / f"chunk-{index:02d}-refined.mp4" for index in range(len(chunks)))
        assembly = assemble_chunks(
            chunks, chunk_outputs, source, output,
            frame_count=source_facts["frames"],
            width=int(request["width"]), height=int(request["height"]),
            fps=fps, output_backend=output_backend,
        )
        return {
            "status": "succeeded",
            "model": reports[0]["model"],
            "model_revision": reports[0]["model_revision"],
            "prompt": str(request["prompt"]),
            "seed": int(request["seed"]),
            "decoder_seed": int(request["decoder_seed"]),
            "decoder_mode": str(request.get("decoder_mode", "diffusion")),
            "transformer_precision": str(request.get("transformer_precision", "nvfp4")),
            "frames": source_facts["frames"],
            "processed_frames": sum(cast(int, report["processed_frames"]) for report in reports),
            "fps": f"{fps.numerator}/{fps.denominator}",
            "width": int(request["width"]),
            "height": int(request["height"]),
            "output": str(output),
            "output_backend": output_backend,
            "audio_preserved": bool(assembly["audio_preserved"]),
            "multi_gpu_benchmark": {
                "worker_count": len(chunks),
                "cuda_device_slots": list(devices),
                "temporal_overlap_frames": overlap,
                "source_frames": source_facts["frames"],
                "chunks": [
                    {
                        "index": chunk.index,
                        "cuda_device_slot": devices[chunk.index],
                        "core_frame_range": [chunk.core_start, chunk.core_end],
                        "inference_frame_range": [chunk.input_start, chunk.input_end],
                        "processed_frames": reports[chunk.index]["processed_frames"],
                    }
                    for chunk in chunks
                ],
                "lossless_split_seconds": split_seconds,
                "worker_reports": reports,
                "assembly": assembly,
                "temporal_noise_is_chunk_local": True,
                "temporal_position_offsets_supported": False,
                "quality_note": "Experimental temporal chunking changes model context and random-noise coordinates; review seams before use.",
            },
            "model_load_s": max(cast(float, report["model_load_s"]) for report in reports),
            "inference_s": max(cast(float, report["inference_s"]) for report in reports),
            "total_seconds": cast(float, assembly["assembly_seconds"]) + split_seconds
            + max(cast(float, report["total_seconds"]) for report in reports),
            "worker_persistent": True,
        }

class MiniMaxH3SoLSharedVAEBenchmark(MiniMaxH3SoLUpscaler):
    """Optional dedicated VAE GPU plus one to four upscale GPUs."""

    FUNCTION = "refine_shared_vae"
    CATEGORY = "ComfyStream/Upscale/Experimental"

    @classmethod
    def INPUT_TYPES(cls) -> dict[str, object]:
        schema = MiniMaxH3SoLUpscaler.INPUT_TYPES()
        required = dict(cast(dict[str, object], schema["required"]))
        required["decoder_mode"] = (["pruna_fast"], {"default": "pruna_fast"})
        required["vae_device"] = ("STRING", {"default": "0"})
        required["cuda_devices"] = ("STRING", {"default": "1,2"})
        required["chunk_frames"] = ("INT", {"default": 96, "min": 32, "max": 512, "step": 8})
        required["temporal_overlap_frames"] = (
            "INT", {"default": 16, "min": 16, "max": 64, "step": 16},
        )
        # The legacy_rgb noise path is deprecated. Shared-VAE always uses one
        # clip-wide latent noise field; retain this single-choice input for
        # workflow compatibility and preflight visibility.
        required["consistency_mode"] = (["global_latent"], {"default": "global_latent"})
        required["interpolate_overlaps"] = ("BOOLEAN", {"default": False})
        cast(dict[str, object], schema.setdefault("optional", {}))["transfer_mode"] = (
            ["peer_event", "blocking"], {"default": "blocking"},
        )
        schema["required"] = required
        return schema

    def refine_shared_vae(
        self, video: VideoInput, prompt: str,
        width: int = DEFAULT_OUTPUT_WIDTH, height: int = DEFAULT_OUTPUT_HEIGHT,
        seed: int = 303000, decoder_seed: int = 20260826,
        decoder_mode: str = "pruna_fast", output_backend: str = "nvenc",
        vae_device: str = "0", cuda_devices: str = "1,2", chunk_frames: int = 96,
        temporal_overlap_frames: int = 16, consistency_mode: str = "global_latent",
        cache_conditioning: bool = False,
        transformer_precision: str = "nvfp4", interpolate_overlaps: bool = False,
        transfer_mode: Literal["blocking", "peer_event"] = "blocking",
    ) -> tuple[VideoInput, str]:
        if consistency_mode != "global_latent":
            raise ValueError(
                "legacy_rgb consistency is deprecated; shared VAE requires global_latent"
            )
        return self.refine(
            video=video, prompt=prompt, width=width, height=height,
            seed=seed, decoder_seed=decoder_seed, decoder_mode=decoder_mode,
            output_backend=output_backend, execution_mode="shared_vae_benchmark",
            cache_conditioning=cache_conditioning, transformer_precision=transformer_precision,
            vae_device=vae_device, cuda_devices=cuda_devices, chunk_frames=chunk_frames,
            temporal_overlap_frames=temporal_overlap_frames,
            interpolate_overlaps=interpolate_overlaps,
            transfer_mode=transfer_mode,
        )


class MiniMaxH3SoLParallelBenchmark(MiniMaxH3SoLUpscaler):
    """Opt-in companion node for local temporal multi-GPU benchmarking."""

    FUNCTION = "refine_multi_gpu"
    CATEGORY = "ComfyStream/Upscale/Experimental"

    @classmethod
    def INPUT_TYPES(cls) -> dict[str, object]:
        schema = MiniMaxH3SoLUpscaler.INPUT_TYPES()
        required = dict(cast(dict[str, object], schema["required"]))
        required["cuda_devices"] = ("STRING", {"default": "0,1"})
        required["temporal_overlap_frames"] = (
            "INT", {"default": 16, "min": 16, "max": 64, "step": 16},
        )
        schema["required"] = required
        return schema

    def refine_multi_gpu(
        self,
        video: VideoInput,
        prompt: str,
        width: int = DEFAULT_OUTPUT_WIDTH,
        height: int = DEFAULT_OUTPUT_HEIGHT,
        seed: int = 303000,
        decoder_seed: int = 20260826,
        decoder_mode: str = "pruna_fast",
        output_backend: str = "nvenc",
        cuda_devices: str = "0,1",
        temporal_overlap_frames: int = 16,
        cache_conditioning: bool = False,
        transformer_precision: str = "nvfp4",
    ) -> tuple[VideoInput, str]:
        return self.refine(
            video=video,
            prompt=prompt,
            width=width,
            height=height,
            seed=seed,
            decoder_seed=decoder_seed,
            decoder_mode=decoder_mode,
            output_backend=output_backend,
            execution_mode="multi_gpu_benchmark",
            cache_conditioning=cache_conditioning,
            transformer_precision=transformer_precision,
            cuda_devices=cuda_devices,
            temporal_overlap_frames=temporal_overlap_frames,
        )


__all__ = [
    "ASYNC_NVENC_STAGING_ENV",
    "CPU_PREPROCESS_OVERLAP_ENV",
    "CPU_TEXT_ENCODER_ENV",
    "DEFAULT_OUTPUT_HEIGHT",
    "DEFAULT_OUTPUT_WIDTH",
    "GPU_AMINMAX_ENV",
    "MODEL_ID",
    "MODEL_RESIDENCY",
    "MODEL_REVISION",
    "NVENC_INPUT_FORMAT_ENV",
    "NVENC_INPUT_HASH_ENV",
    "NVENC_PRESET_ENV",
    "PYTHON_VERSION",
    "TORCH_CUDA_VERSION",
    "TORCH_VERSION",
    "VIDEO_ONLY_REFINER_ENV",
    "WORKER_TORCH_VERSION",
    "MiniMaxH3SoLParallelBenchmark",
    "MiniMaxH3SoLSharedVAEBenchmark",
    "MiniMaxH3SoLUpscaler",
    "_encoder_args",
    "_experiment_flag",
    "_ffmpeg_executable",
    "_gpu_pixel_range",
    "_nvenc_input_pixel_format",
    "_nvenc_preset",
    "_pack_rgb_as_yuv420p",
    "_write_frames",
    "_write_gpu_frames",
    "ffmpeg_export_command",
    "natten_backend_name",
    "pad_video_frames",
    "padded_frame_count",
    "validate_runtime",
    "validate_upscale_geometry",
]
