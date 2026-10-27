"""Load the Ada transformer without first retaining a full BF16 transformer."""

from __future__ import annotations

import re
from typing import Any

from .fp8_optimizations import _select_mxfp8_linear


def load_transformer_fp8(
    transformer_class: Any, model_id: str, model_revision: str,
) -> tuple[Any, tuple[str, ...]]:
    """Quantize each large Linear as pinned Diffusers loads checkpoint shards.

    All other parameters retain BF16. A meta skeleton determines the same layer
    selection as the in-place FP8 path without allocating real model weights.
    The returned names describe verified TorchAO weights, not requested ones.
    """
    if not re.fullmatch(r"[0-9a-fA-F]{40}", model_revision):
        raise ValueError("FP8 loading requires an immutable model commit")

    import torch
    from accelerate import init_empty_weights
    from diffusers import TorchAoConfig
    from torchao.quantization import Float8DynamicActivationFloat8WeightConfig, PerRow
    from torchao.quantization.quantize_.workflows import Float8Tensor

    if not torch.cuda.is_available():
        raise RuntimeError("FP8 loading requires a CUDA GPU")
    if torch.cuda.get_device_capability() < (8, 9):
        raise RuntimeError("FP8 loading requires NVIDIA Ada (SM 8.9) or newer")

    config = transformer_class.load_config(
        model_id, subfolder="transformer", revision=model_revision,
    )
    with init_empty_weights(include_buffers=True):
        skeleton = transformer_class.from_config(config)
    selected: list[str] = []
    excluded: list[str] = []
    for name, module in skeleton.named_modules():
        if isinstance(module, torch.nn.Linear):
            target = selected if _select_mxfp8_linear(module, name, torch.nn.Linear) else excluded
            target.append(name)
    del skeleton
    if not selected:
        raise RuntimeError("FP8 selected no transformer Linear layers to quantize")

    # Do not set device_map='cpu': pinned Diffusers treats that as offloading
    # and deliberately leaves CPU weights unquantized. With no map its meta
    # loader quantizes one CPU Linear at a time before sequential GPU offload.
    transformer = transformer_class.from_pretrained(
        model_id,
        subfolder="transformer",
        revision=model_revision,
        torch_dtype=torch.bfloat16,
        low_cpu_mem_usage=True,
        use_safetensors=True,
        quantization_config=TorchAoConfig(
            Float8DynamicActivationFloat8WeightConfig(granularity=PerRow()),
            modules_to_not_convert=excluded,
        ),
    )
    modules = dict(transformer.named_modules())
    for name in selected:
        if not isinstance(getattr(modules.get(name), "weight", None), Float8Tensor):
            raise RuntimeError(f"FP8 transformer Linear {name!r} was not quantized")
    for name in excluded:
        if isinstance(getattr(modules.get(name), "weight", None), Float8Tensor):
            raise RuntimeError(f"FP8 unexpectedly quantized excluded Linear {name!r}")
    return transformer, tuple(selected)
