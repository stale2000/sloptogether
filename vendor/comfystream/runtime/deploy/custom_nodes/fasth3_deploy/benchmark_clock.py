"""Benchmark-only worker clock used to time a warm conditioned video request."""
from __future__ import annotations

import time
from dataclasses import dataclass
from pathlib import Path


@dataclass(frozen=True)
class H3WorkerClock:
    nonce: str
    started_monotonic: float
    text_cache_policy: str
    residency_policy: str
    residency_start: dict[str, object]


def _residency_snapshot() -> dict[str, object]:
    """Capture observable CUDA/model residency without forcing a device sync."""
    result: dict[str, object] = {"cuda_available": False, "loaded_models_known": False}
    try:
        import torch

        if not torch.cuda.is_available():
            return result
        device = torch.cuda.current_device()
        props = torch.cuda.get_device_properties(device)
        free, total = torch.cuda.mem_get_info(device)
        result.update({
            "cuda_available": True,
            "device": str(device),
            "device_name": str(props.name),
            "device_total_bytes": int(total),
            "device_free_bytes": int(free),
            "allocated_bytes": int(torch.cuda.memory_allocated(device)),
            "reserved_bytes": int(torch.cuda.memory_reserved(device)),
        })
    except (ImportError, RuntimeError, AttributeError):
        return result
    try:
        from comfy import model_management

        entries = []
        for loaded in getattr(model_management, "current_loaded_models", ()):
            patcher = getattr(loaded, "model", None)
            model = getattr(patcher, "model", None)
            if patcher is None:
                continue
            name = (
                getattr(patcher, "model_name", None)
                or getattr(model, "model_name", None)
                or type(model).__name__
            )
            try:
                loaded_bytes = int(patcher.loaded_size())
            except (AttributeError, RuntimeError, TypeError):
                loaded_bytes = None
            entries.append({
                "name": Path(str(name)).name,
                "implementation": (
                    f"{type(model).__module__}.{type(model).__qualname__}" if model is not None else None
                ),
                "loaded_bytes": loaded_bytes,
            })
        result["loaded_models"] = sorted(entries, key=lambda item: (
            str(item["name"]), str(item["implementation"]), str(item["loaded_bytes"]),
        ))
        result["loaded_models_known"] = True
    except (ImportError, RuntimeError, AttributeError):
        result["loaded_models"] = []
    return result


def residency_restored(start: object, end: object, *, tolerance_bytes: int = 512 * 1024**2) -> bool:
    """Require the pinned Comfy model set/device plus bounded live-allocation restoration."""
    if (not isinstance(start, dict) or not isinstance(end, dict)
            or start.get("cuda_available") is not True or end.get("cuda_available") is not True
            or start.get("loaded_models_known") is not True
            or end.get("loaded_models_known") is not True):
        return False
    if (start.get("device") != end.get("device")
            or start.get("device_name") != end.get("device_name")
            or start.get("loaded_models") != end.get("loaded_models")):
        return False
    first, last = start.get("allocated_bytes"), end.get("allocated_bytes")
    return (
        type(first) is int and type(last) is int
        and abs(last - first) <= tolerance_bytes
    )


class ComfyStreamerH3BenchmarkClock:
    RETURN_TYPES = ("H3_BENCHMARK_CLOCK",)
    RETURN_NAMES = ("clock",)
    FUNCTION = "start"
    CATEGORY = "ComfyStreamerH3/Experimental"
    OUTPUT_NODE = False

    @classmethod
    def INPUT_TYPES(cls) -> dict[str, dict[str, tuple[object, ...]]]:
        return {
            "required": {"nonce": ("STRING", {"default": ""})},
            "optional": {
            "text_cache_policy": ("STRING", {"default": "per-request-conditioner"}),
                "residency_policy": (["original", "R1", "R2"], {"default": "original"}),
            },
        }

    @classmethod
    def IS_CHANGED(cls, nonce: str, text_cache_policy: str = "per-request-conditioner",
                    residency_policy: str = "original") -> str:
        # The harness supplies a fresh nonce for every request. Include both
        # policies so a graph cannot reuse a clock with another campaign pin.
        return f"{nonce}:{text_cache_policy}:{residency_policy}"

    def start(self, nonce: str, text_cache_policy: str = "per-request-conditioner",
              residency_policy: str = "original") -> tuple[H3WorkerClock]:
        if not isinstance(nonce, str) or not nonce.strip():
            raise ValueError("benchmark clock requires a per-request nonce")
        if (not isinstance(text_cache_policy, str) or not text_cache_policy.strip()
                or residency_policy not in {"original", "R1", "R2"}):
            raise ValueError("benchmark clock policy pins are invalid")
        return (H3WorkerClock(
            nonce=nonce,
            started_monotonic=time.perf_counter(),
            text_cache_policy=text_cache_policy,
            residency_policy=residency_policy,
            residency_start=_residency_snapshot(),
        ),)
