"""Hardware-based, fail-closed H3 refiner precision selection."""

from __future__ import annotations

from typing import Any


def select_transformer_precision(
    capability: tuple[int, int],
    total_memory_bytes: int,
    free_memory_bytes: int,
) -> str:
    if capability >= (10, 0) and total_memory_bytes >= 94 * 1024**3:
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
