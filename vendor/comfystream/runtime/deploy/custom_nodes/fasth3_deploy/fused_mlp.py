"""Strict, opt-in bridge for the H3 fused NVFP4 SwiGLU preprocessing path.

The bridge deliberately patches only ``mlp.forward`` through Comfy's object
patch API.  It does not monkey-patch classes or install a process-global hook.
Unsupported models, devices, kernels, and dynamic weight transforms are hard
errors: a request for fused FP4 must never silently turn into an eager path.
"""

from __future__ import annotations

import importlib
import logging
import types
from collections.abc import Callable
from dataclasses import dataclass
from typing import TYPE_CHECKING, Protocol, cast

if TYPE_CHECKING:
    from comfy.ldm.minimax.model import MiniMaxH3Model
    from comfy.model_patcher import ModelPatcher

import torch
from torch import nn

try:  # Supports both Comfy package imports and standalone contract tests.
    from .precision import (
        NVFP4Capability,
        NVFP4CapabilityError,
        NVFP4MLPAdapter,
        NVFP4ValidationError,
        apply_mlp_fp4,
        discover_mlp_projections,
    )
except ImportError:  # pragma: no cover - exercised by direct test imports
    from precision import (  # type: ignore[no-redef]
        NVFP4Capability,
        NVFP4CapabilityError,
        NVFP4MLPAdapter,
        NVFP4ValidationError,
        apply_mlp_fp4,
        discover_mlp_projections,
    )

class _FusedKernel(Protocol):
    TRITON_AVAILABLE: bool

    def runtime_description(self) -> str: ...
    def fused_swiglu_nvfp4_tensor_scale(
        self, value: torch.Tensor, *, precision: str,
    ) -> torch.Tensor: ...
    def fused_swiglu_quantize_nvfp4(
        self, value: torch.Tensor, *, precision: str,
        tensor_scale: torch.Tensor | None, blocks_per_program: int | None,
    ) -> tuple[torch.Tensor, torch.Tensor, torch.Tensor, tuple[int, ...]]: ...


class _MLP(Protocol):
    fc1: nn.Module
    fc2: nn.Module


LOG = logging.getLogger(__name__)
CONFIG_KEY = "fasth3_fused_nvfp4_mlp"


@dataclass(frozen=True)
class FusedMLPReport:
    enabled: bool
    applied: tuple[str, ...]
    skipped: tuple[str, ...]
    capability: NVFP4Capability

    def to_dict(self) -> dict[str, object]:
        return {
            "enabled": self.enabled,
            "applied": self.applied,
            "skipped": self.skipped,
            "capability": self.capability.__dict__,
        }


def _vendor_kernel() -> _FusedKernel:
    # The vendored Triton module supplies this pinned launch interface.
    return cast(_FusedKernel, importlib.import_module(".vendor.fused_mlp.kernel", __package__))


def _require_triton() -> _FusedKernel:
    from .compiler import ensure_triton_compiler
    ensure_triton_compiler()
    kernel = _vendor_kernel()
    if not kernel.TRITON_AVAILABLE:
        raise NVFP4CapabilityError(kernel.runtime_description())
    return kernel


def _validate_fc2(fc2: object, name: str) -> None:
    try:
        quant_ops = importlib.import_module("comfy.quant_ops")
        qt = quant_ops.QuantizedTensor
    except Exception as exc:
        raise NVFP4CapabilityError(f"{name}: Comfy QuantizedTensor API is unavailable: {exc}") from exc
    weight = getattr(fc2, "weight", None)
    # Before apply_mlp_fp4 the source is an ordinary loaded Linear.  Existing
    # native FP4 weights are accepted only when they advertise the exact layout;
    # ordinary sources are converted atomically by apply_mlp_fp4 below.
    if isinstance(weight, qt) and getattr(weight, "_layout_cls", None) != "TensorCoreNVFP4Layout":
        raise NVFP4ValidationError(f"{name}: FC2 layout must be TensorCoreNVFP4Layout")
    if isinstance(weight, qt) and getattr(getattr(weight, "_params", None), "transposed", False):
        raise NVFP4ValidationError(f"{name}: transposed NVFP4 FC2 weights are unsupported")
    for attr in ("pre_quant_scale", "input_scale"):
        if getattr(fc2, attr, None) is not None:
            raise NVFP4ValidationError(f"{name}: FC2 {attr} is unsupported")
    for attr in ("weight_function", "bias_function"):
        if getattr(fc2, attr, ()):
            raise NVFP4ValidationError(f"{name}: FC2 dynamic transforms/LoRA are unsupported ({attr})")


def _make_forward(
    mlp: _MLP, block_name: str, kernel: _FusedKernel,
) -> Callable[[torch.Tensor], torch.Tensor]:
    try:
        from .fp4_kernel_config import fp4_kernel_options
        from .nvtx import nvtx_range
    except ImportError:  # pragma: no cover - standalone tests
        from fp4_kernel_config import fp4_kernel_options  # type: ignore[no-redef]
        from nvtx import nvtx_range  # type: ignore[no-redef]
    quant_ops = importlib.import_module("comfy.quant_ops")

    def forward(self: _MLP, x: torch.Tensor) -> torch.Tensor:
        if not isinstance(self.fc1, NVFP4MLPAdapter) or not isinstance(self.fc2, NVFP4MLPAdapter):
            raise NVFP4ValidationError(f"{block_name}: FP4 child patches are not active")
        if not x.is_cuda or x.dtype not in (torch.float16, torch.bfloat16):
            raise NVFP4CapabilityError(
                f"{block_name}: fused NVFP4 requires CUDA BF16/FP16 activations, got {x.device}/{x.dtype}"
            )
        with nvtx_range("mlp_fc1"):
            fc1_output: torch.Tensor = self.fc1(x)
        if fc1_output.ndim != 2:
            fc1_output = fc1_output.reshape(-1, fc1_output.shape[-1])
        if fc1_output.shape[-1] % 2:
            raise NVFP4ValidationError(f"{block_name}: FC1 output width must be even")
        try:
            options = fp4_kernel_options()
            tensor_scale = None
            module_name = (
                f"{__package__}.speculative_forcing_freeze"
                if __package__ else "speculative_forcing_freeze"
            )
            active_freeze_state = importlib.import_module(module_name).active_freeze_state
            freeze_state = active_freeze_state()
            if (freeze_state is not None and freeze_state.dense_reference
                    and freeze_state.ready_count > 0
                    and freeze_state.active_rows is not None
                    and freeze_state.active_rows.numel() < fc1_output.shape[0]):
                active_rows = freeze_state.active_rows.to(
                    device=fc1_output.device, dtype=torch.long,
                )
                active_fc1 = fc1_output.index_select(0, active_rows)
                tensor_scale = kernel.fused_swiglu_nvfp4_tensor_scale(
                    active_fc1, precision="native_rounding",
                )
            packed, tensor_scale, block_scales, orig_shape = kernel.fused_swiglu_quantize_nvfp4(
                fc1_output,
                precision="native_rounding",
                tensor_scale=tensor_scale,
                blocks_per_program=options["blocks_per_program"] or None,
            )
            params = quant_ops.TensorCoreNVFP4Layout.Params(
                scale=tensor_scale,
                orig_dtype=fc1_output.dtype,
                orig_shape=orig_shape,
                block_scale=block_scales,
            )
            qinput = quant_ops.QuantizedTensor(packed, "TensorCoreNVFP4Layout", params)
            with nvtx_range("mlp_fc2"):
                output: torch.Tensor = self.fc2(qinput)
                return output.reshape(*x.shape[:-1], self.fc2.out_features)
        except (NVFP4CapabilityError, NVFP4ValidationError):
            raise
        except Exception as exc:
            raise NVFP4CapabilityError(f"{block_name}: fused NVFP4 dispatch failed: {exc}") from exc

    return types.MethodType(forward, mlp)


def apply_fused_mlp(model_patcher: ModelPatcher) -> tuple[ModelPatcher, FusedMLPReport]:
    """Clone *model_patcher*, install native FP4 adapters, then patch MLP forwards.

    Returns ``(patched_model_patcher, report)``.  The input patcher is never
    mutated.  This is intentionally an explicit opt-in API and has no fallback.
    """
    model = getattr(model_patcher, "model", None)
    if not isinstance(model, nn.Module):
        raise NVFP4ValidationError("apply_fused_mlp requires a ModelPatcher with a torch module")
    if not torch.cuda.is_available():
        raise NVFP4CapabilityError("fused NVFP4 requires CUDA")
    kernel = _require_triton()
    names = discover_mlp_projections(model)
    # Precision adapter installation performs the native capability probe and
    # atomically prepares both FC1/FC2 leaves for each discovered block before
    # object patches land. V2 has 50 blocks; Trim has 42.
    patched, precision_report = apply_mlp_fp4(model_patcher, names, enabled=True)
    diffusion = cast("MiniMaxH3Model", model.get_submodule("diffusion_model"))
    blocks = tuple(diffusion.blocks)
    if len(names) != 2 * len(blocks):
        raise NVFP4ValidationError(
            "fused NVFP4 MLP projection count does not match the loaded "
            f"FastH3 block count ({len(names)} projections for {len(blocks)} blocks)"
        )
    applied = []
    for block in range(len(blocks)):
        mlp_name = f"diffusion_model.blocks.{block}.mlp"
        mlp = blocks[block].mlp
        _validate_fc2(patched.get_model_object(f"{mlp_name}.fc2"), f"{mlp_name}.fc2")
        patched.add_object_patch(f"{mlp_name}.forward", _make_forward(mlp, mlp_name, kernel))
        applied.append(mlp_name)
    report = FusedMLPReport(True, tuple(applied), precision_report.skipped, precision_report.capability)
    return patched, report


__all__ = ["CONFIG_KEY", "FusedMLPReport", "apply_fused_mlp"]
