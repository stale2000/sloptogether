"""Experimental native Kitchen 0.2.34 VC; no import-time CUDA/build side effects."""

from __future__ import annotations

from collections.abc import Callable, Iterable, Sequence
from types import ModuleType
from typing import TYPE_CHECKING, TypedDict, cast

from .grouped import NativeState

if TYPE_CHECKING:
    import torch

    from ..anemoi_native.quota import PrecisionPolicy
    from ._abi import NativeLibrary
    from .scratch import ScratchPool
from .instrumentation import StageTimings, request_stage_timings
from .runtime import (
    Prepared,
    ValidationContext,
    anemoi_routes,
    fine,
    merge_coarse,
    original_route_scores,
    prepare_chunked,
    route,
    sol_attn_chunked,
)


class _CommonBackendOptions(TypedDict, total=False):
    scratch_pool: ScratchPool[tuple[torch.Tensor, torch.Tensor]] | None
    retained_operand_bytes: int
    reuse_geometry: bool
    _stage_mark: Callable[[str], None] | None


class _AnemoiBackendOptions(_CommonBackendOptions, total=False):
    validation_context: ValidationContext
    center_values: bool
    precision_policy: PrecisionPolicy | None
    attention_kernel_policy: str
    native_state: NativeState | None
    diagnostic_calibration_override: bool
    direct_prefix_output: bool
    share_phase_validity: bool
    native_preparation: bool
    native_ragged_preparation: bool
    optimize_phase_metadata: bool
    fused_route_metadata: bool
    nvfp4_range_margin: float


class _VCBackendOptions(_CommonBackendOptions, total=False):
    omega_coarse_epilogue: bool


__all__ = [
    "Prepared",
    "StageTimings",
    "ValidationContext",
    "anemoi_routes",
    "fine",
    "invalidate_caches",
    "merge_coarse",
    "original_route_scores",
    "prepare_chunked",
    "request_stage_timings",
    "require_backend",
    "resource_report",
    "route",
    "run_chunked",
    "sol_attn_chunked",
]


def require_backend(option: str, device: torch.device | str | int | None=None) -> NativeLibrary | ModuleType:
    """Fail before projection on missing prebuilt artifact or unsupported device."""
    if option in ("anemoi", "combined"):
        from .. import anemoi_native
        return anemoi_native.require_backend(option)
    if option != "vc":
        raise NotImplementedError(f"native {option!r} backend is not installed in this adapter")
    from ._abi import get_native_library
    from .runtime import _dependencies
    native = get_native_library()
    torch, _ = _dependencies()
    if not torch.cuda.is_available():
        raise RuntimeError("native VC requires a CUDA device; CPU/diagnostic fallback is disabled")
    capability = torch.cuda.get_device_capability(device)
    arch = f"{capability[0]}{capability[1]}"
    if arch not in cast(Sequence[str], native.report["architectures"]):
        raise RuntimeError(f"native VC has no sm_{arch} artifact; rebuild on the CUDA builder")
    with torch.cuda.device(device if device is not None else torch.cuda.current_device()):
        native.check_resources(torch.cuda.current_device())
    return native


def resource_report() -> dict[str, object]:
    """Return verified artifact/source hashes and raw compiler resource evidence; no GPU launch."""
    from ._abi import artifact_report
    return artifact_report()[1]


def invalidate_caches() -> None:
    """Revalidate metadata after explicit changes; restart for same-path binary replacement."""
    from ._abi import clear_validation_cache
    from .runtime import _dependencies
    clear_validation_cache()
    _dependencies.cache_clear()


def run_chunked(
    option: str, chunks: Callable[[], Iterable[torch.Tensor]] | Iterable[torch.Tensor], n: int, heads: int, freqs: torch.Tensor, qk_weights: Sequence[torch.Tensor], *, kmean: torch.Tensor | None=None, vscale: torch.Tensor | None=None,
    tau: float=1.0, topk_ratio: float=0.0, scale: float | None=None, sink_blocks: Sequence[int] | None=None, sink_q: Sequence[int] | None=None,
    rope_eps: float=1e-6, block_len: torch.Tensor | None=None, coarse_gate: torch.Tensor | None=None, token_aug: int=0, tail: bool=False,
    diagnostics: dict[str, object] | None=None, grouping_policy: str="none", pv_precision: str="int8",
    grouping_schedule: str="all_steps", evaluation_index: int | None=None, grouping_state: NativeState | None=None,
    validation_context: ValidationContext | None=None, center_values: bool | None=None, adaptive_budget_test: bool=False,
    adaptive_budget_collect_diagnostics: bool=True,
    adaptive_video_grid: Sequence[int] | None=None, adaptive_video_cube_grid: Sequence[int] | None=None,
    adaptive_video_cube_size: Sequence[int] | None=None, active_query_blocks: torch.Tensor | None=None, active_query_ids: torch.Tensor | None=None,
    producer_active_query_blocks: torch.Tensor | None=None,
    adaptive_score_byte_limit: int=32 * 1024 * 1024,
    **backend_options: object,
) -> tuple[torch.Tensor, torch.Tensor | None, torch.Tensor | None]:
    """Parent dispatcher entry; sol_attn_chunked retains Kitchen's original ABI."""
    if option in ("anemoi", "combined"):
        if adaptive_budget_test:
            raise ValueError("adaptive VSA test is only supported by the VC route")
        from .. import anemoi_native
        if pv_precision != "int8":
            raise ValueError("use Anemoi precision_policy for its phase selection; pv_precision is VC-only")
        if validation_context is not None:
            backend_options["validation_context"] = validation_context
        if center_values is not None:
            backend_options["center_values"] = center_values
        return anemoi_native.run_chunked(
            option, chunks, n, heads, freqs, qk_weights, kmean=kmean, vscale=vscale,
            tau=tau, topk_ratio=topk_ratio, scale=scale, sink_blocks=sink_blocks,
            sink_q=sink_q, rope_eps=rope_eps, block_len=block_len,
            coarse_gate=coarse_gate, token_aug=token_aug, tail=tail, diagnostics=diagnostics,
            grouping_policy=grouping_policy,
            grouping_schedule=grouping_schedule, evaluation_index=evaluation_index,
            grouping_state=grouping_state, **cast(_AnemoiBackendOptions, backend_options),
        )
    return sol_attn_chunked(
        chunks, n, heads, freqs, qk_weights, kmean, vscale, tau, topk_ratio,
        scale, sink_blocks, sink_q, rope_eps, tail, block_len, coarse_gate,
        token_aug, option=option, diagnostics=diagnostics,
        grouping_policy=grouping_policy, pv_precision=pv_precision,
        grouping_schedule=grouping_schedule, evaluation_index=evaluation_index,
        grouping_state=grouping_state, validation_context=validation_context,
        center_values=center_values,
        adaptive_budget_test=adaptive_budget_test,
        adaptive_budget_collect_diagnostics=adaptive_budget_collect_diagnostics,
        adaptive_video_grid=adaptive_video_grid,
        adaptive_video_cube_grid=adaptive_video_cube_grid,
        adaptive_video_cube_size=adaptive_video_cube_size,
        adaptive_score_byte_limit=adaptive_score_byte_limit,
        active_query_blocks=active_query_blocks,
        active_query_ids=active_query_ids,
        producer_active_query_blocks=producer_active_query_blocks,
        **cast(_VCBackendOptions, backend_options),
    )
