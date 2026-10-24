"""Validate trained FastH3 gates; let ComfyUI construct and load the model."""

from __future__ import annotations

from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from comfy.model_patcher import ModelPatcher
import hashlib
import json
import re

from comfy.ldm.minimax.model import MiniMaxH3Model

UPSTREAM_GATE_CORE_COMMIT = "ee71d5c4993f29086b27fde1629a945ae48425bf"


def upstream_gate_loader_manifest() -> dict[str, object]:
    """Identity for the opt-in experiment; this does not certify equivalence."""
    descriptor: dict[str, object] = {
        "schema": "fasth3-gate-loader/2",
        "profile_id": "fasth3-upstream-gate-loader/v2",
        "status": "unqualified_candidate",
        "comfyui_commit": UPSTREAM_GATE_CORE_COMMIT,
        "stock_model": "comfy.model_base.MiniMaxH3",
        "stock_backbone": "comfy.ldm.minimax.model.MiniMaxH3Model",
        "detection_policy": "gate_compress=True; contiguous complete 42- or 50-block trained gates",
        "supported_block_counts": [42, 50],
        "producer_policy": "preserve custom VSA, selective NVFP4 and fused MLP",
        "pdmd_policy": "excluded from this candidate",
    }
    descriptor["profile_hash"] = hashlib.sha256(
        json.dumps(descriptor, sort_keys=True).encode()
    ).hexdigest()
    return descriptor


def load_upstream_gate_checkpoint(path: str, disable_dynamic: bool = False) -> ModelPatcher:
    """Use the pinned public state-dict loader after checking every trained gate.

    The official loader consumes weight dictionaries. Validate completeness
    before that mutation without modifying ComfyUI's global model registry.
    Empty model_options preserve UNETLoader's historical default dtype choice.
    """
    import comfy.model_base
    import comfy.model_detection
    import comfy.sd
    import comfy.utils

    state_dict, metadata = comfy.utils.load_torch_file(path, return_metadata=True)
    prefix = comfy.model_detection.unet_prefix_from_state_dict(state_dict)
    # The FastVideo Comfy export stores MiniMax-H3 block keys at the top level.
    # Comfy's generic prefix helper falls back to "model." when no known wrapper
    # prefix exists, so recognize the native bare-key form before validating it.
    if (f"{prefix}blocks.0.attn.to_gate_compress.weight" not in state_dict
            and "blocks.0.attn.to_gate_compress.weight" in state_dict):
        prefix = ""
    gate_pattern = re.compile(
        rf"^{re.escape(prefix)}blocks\.(?P<block>\d+)\.attn\.to_gate_compress\.weight$"
    )
    gate_blocks = sorted(
        int(match.group("block"))
        for key in state_dict
        if (match := gate_pattern.fullmatch(key)) is not None
    )
    if not gate_blocks:
        raise ValueError("Incomplete FastH3 gate bank: no trained gate weights were found")
    missing = sorted(set(range(gate_blocks[-1] + 1)) - set(gate_blocks))
    if missing:
        raise ValueError(f"Incomplete FastH3 gate bank: missing blocks {missing}")
    expected_block_count = len(gate_blocks)
    if expected_block_count not in (42, 50):
        expected = 42 if expected_block_count < 42 else 50
        missing = list(range(expected_block_count, expected))
        if expected_block_count < 50:
            raise ValueError(
                "Incomplete FastH3 gate bank: "
                f"found {expected_block_count} contiguous blocks; missing blocks {missing}"
            )
        raise ValueError(
            f"Unsupported FastH3 gate bank: found {expected_block_count} blocks; expected 42 or 50"
        )
    model = comfy.sd.load_diffusion_model_state_dict(
        state_dict, model_options={}, metadata=metadata, disable_dynamic=disable_dynamic,
    )
    if model is None:
        raise RuntimeError("Upstream gate checkpoint model could not be detected")
    if (type(model.model) is not comfy.model_base.MiniMaxH3
            or model.model.model_type != comfy.model_base.ModelType.FLOW_AV):
        raise RuntimeError("FastH3 requires the stock MiniMaxH3 FLOW_AV model")
    backbone = model.get_model_object("diffusion_model")
    if (type(backbone) is not MiniMaxH3Model or len(backbone.blocks) != expected_block_count
            or any(getattr(block.attn, "to_gate_compress", None) is None
                   for block in backbone.blocks)):
        raise RuntimeError(
            "Upstream gate loader did not construct all "
            f"{expected_block_count} native gates"
        )
    # Keep completeness validation on Comfy's lazy dynamic-to-static reload.
    model.cached_patcher_init = (load_upstream_gate_checkpoint, (path,))
    return model
