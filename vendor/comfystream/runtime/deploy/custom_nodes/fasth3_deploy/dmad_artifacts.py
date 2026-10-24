"""Pure manifest validation for converted DMAD model artifacts."""
from __future__ import annotations

import json
import os
from pathlib import Path

UPSTREAM_GATE_CORE_COMMIT = "ee71d5c4993f29086b27fde1629a945ae48425bf"

_SUPPORTED_VARIANTS = ("lora_critic", "full_critic")


class DmadModelError(RuntimeError):
    """The selected merged artifact cannot safely enter the Comfy H3 model path."""


def read_dmad_artifact(path: str | os.PathLike[str], *, variant: str) -> tuple[Path, dict[str, object], str]:
    checkpoint = Path(path).resolve(strict=True)
    if not checkpoint.is_file() or checkpoint.suffix != ".safetensors":
        raise DmadModelError("DMAD checkpoint must be a Comfy converted safetensors file")
    sidecar = checkpoint.with_suffix(checkpoint.suffix + ".dmad.json")
    try:
        manifest = json.loads(sidecar.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise DmadModelError(f"DMAD checkpoint manifest is missing or invalid: {exc}") from exc
    # Artifact format is a serialized contract shared with the converter;
    # keep the v1 identifier stable across the UI/package rename.
    if manifest.get("format") != "comfystream-dmad-comfy-h3-v1":
        raise DmadModelError("Unsupported DMAD Comfy checkpoint manifest")
    if variant not in _SUPPORTED_VARIANTS or manifest.get("variant") != variant:
        raise DmadModelError("Selected DMAD variant does not match the checkpoint manifest")
    if (manifest.get("base_model_id") != "MiniMaxAI/MiniMax-H3"
            or manifest.get("base_revision") != "42ed227ee7df40d41602854ae760620d6eb651fe"):
        raise DmadModelError("DMAD checkpoint was not prepared from the pinned original MiniMax-H3 base")
    if manifest.get("comfyui_core_commit") != UPSTREAM_GATE_CORE_COMMIT:
        raise DmadModelError("DMAD checkpoint was converted for a different ComfyUI Core contract")
    if manifest.get("gate_compress") is not False:
        raise DmadModelError("DMAD Dense H3 must not synthesize or inherit FastH3 VSA gates")
    if manifest.get("activation_layout") != "comfy_gate_up":
        raise DmadModelError("DMAD checkpoint must convert Diffusers up/gate rows to Comfy gate/up order")
    checkpoint_identity = manifest.get("comfy_checkpoint")
    if not isinstance(checkpoint_identity, dict) or checkpoint_identity.get("file") != checkpoint.name:
        raise DmadModelError("DMAD manifest checkpoint name does not match the selected file")
    return checkpoint, manifest, str(checkpoint_identity.get("sha256", ""))
