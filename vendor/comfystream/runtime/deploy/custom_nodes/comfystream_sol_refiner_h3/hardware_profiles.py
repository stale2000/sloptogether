"""Hardware-based, fail-closed H3 refiner precision selection."""

from __future__ import annotations

from typing import Any, Callable


def resident_reuse_is_safe(
    capability: tuple[int, int],
    total_memory_bytes: int,
    free_memory_bytes: int,
    peak_reserved_bytes: object,
    *,
    profile_matches: bool,
    worker_matches: bool,
) -> bool:
    """Permit a proven warm run only with enough *additional* free memory.

    Requiring the entire prior peak again is deliberately conservative: it
    avoids treating the child's resident allocation as free and leaves room for
    other CUDA users. Unknown or malformed measurements never qualify.
    """
    if not profile_matches or not worker_matches:
        return False
    if (type(total_memory_bytes) is not int or type(free_memory_bytes) is not int
            or not 0 <= free_memory_bytes <= total_memory_bytes):
        return False
    if capability < (10, 0) or total_memory_bytes < 94 * 1024**3:
        return False
    if type(peak_reserved_bytes) is not int or not 0 < peak_reserved_bytes <= total_memory_bytes:
        return False
    return free_memory_bytes >= peak_reserved_bytes + 2 * 1024**3


def select_transformer_precision(
    capability: tuple[int, int],
    total_memory_bytes: int,
    free_memory_bytes: int,
    *,
    release_resident_worker: Callable[[], None] | None = None,
    probe_free_memory: Callable[[], int] | None = None,
) -> str:
    if capability >= (10, 0) and total_memory_bytes >= 94 * 1024**3:
        if free_memory_bytes < 90 * 1024**3 and release_resident_worker and probe_free_memory:
            release_resident_worker()
            free_memory_bytes = probe_free_memory()
        if free_memory_bytes >= 90 * 1024**3:
            return "nvfp4"
        raise RuntimeError("The resident Blackwell H3 upscale profile requires 90 GiB free VRAM")
    if capability >= (8, 9) and total_memory_bytes >= 24_000_000_000:
        return "fp8"
    raise RuntimeError("The automatic H3 upscale profile requires Ada+ and at least 24 GB of GPU memory")


def configure_pipeline_device(pipeline: Any) -> None:
    if pipeline.transformer_precision == "fp8":
        pipeline.enable_sequential_cpu_offload(gpu_id=0)
        pipeline.model_residency = "cpu-sequential-offload"
        pipeline.cpu_offload_enabled = True
    else:
        pipeline.to("cuda")
        pipeline.model_residency = "cuda"
        pipeline.cpu_offload_enabled = False
