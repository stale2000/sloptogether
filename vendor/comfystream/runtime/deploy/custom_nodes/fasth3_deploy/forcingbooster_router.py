"""Small head and fixed loss contract for the FastH3 Trim router."""
from __future__ import annotations

import hashlib
import json
import math
import os
import re
import tempfile
from collections.abc import Mapping
from pathlib import Path
from typing import TYPE_CHECKING, TypedDict

if TYPE_CHECKING:
    from comfy.model_patcher import ModelPatcher

import torch
from torch import nn

ROUTER_SCHEMA = "comfystream/forcingbooster-router/1"
TRAINING_CONTRACT = "patch_mse_plus_expected_steps/sample_mean/v1"
_PROFILE_ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$")


class PatchExitRouter(nn.Module):
    """Predict the probability that one video patch can stop now."""

    def __init__(
        self, input_dim: int, hidden_dim: int = 2048, initial_exit_bias: float = -2.0,
    ) -> None:
        super().__init__()
        if type(input_dim) is not int or input_dim <= 0:
            raise ValueError("router input_dim must be a positive integer")
        if type(hidden_dim) is not int or hidden_dim <= 0:
            raise ValueError("router hidden_dim must be a positive integer")
        if not math.isfinite(float(initial_exit_bias)):
            raise ValueError("router initial_exit_bias must be finite")
        self.input_dim = input_dim
        self.hidden_dim = hidden_dim
        output_layer = nn.Linear(hidden_dim, 1)
        self.net = nn.Sequential(
            nn.LayerNorm(input_dim, eps=1e-6),
            nn.Linear(input_dim, hidden_dim),
            nn.SiLU(),
            output_layer,
        )
        nn.init.zeros_(output_layer.weight)
        nn.init.constant_(output_layer.bias, float(initial_exit_bias))
        self.float()

    def forward(self, features: torch.Tensor) -> torch.Tensor:
        if features.ndim < 2 or features.shape[-1] != self.input_dim:
            raise ValueError(
                f"router features must end in {self.input_dim}, got {tuple(features.shape)}"
            )
        output: torch.Tensor = self.net(features.detach().to(dtype=torch.float32))
        return output.squeeze(-1)


def patch_error_mse(prediction: torch.Tensor, reference: torch.Tensor) -> torch.Tensor:
    """Per-patch mean squared latent error for `[patch, channel × 2 × 2]` rows."""
    left, right = prediction.float(), reference.float()
    if left.ndim != 2 or right.shape != left.shape:
        raise ValueError("patch predictions and references must have matching matrices")
    return (left - right).square().mean(dim=-1)


def prescribed_exit_steps(token_count: int, pattern: str, *, device: torch.device | str | None = None) -> torch.Tensor:
    """Build deterministic mixed early/terminal patch maps for parity diagnostics."""
    if type(token_count) is not int or token_count <= 0:
        raise ValueError("prescribed exit map needs a positive video-token count")
    token_ids = torch.arange(token_count, dtype=torch.long, device=device)
    if pattern == "scattered":
        return token_ids.remainder(5) + 1
    if pattern == "contiguous":
        return torch.div(token_ids * 5, token_count, rounding_mode="floor").clamp_max(4) + 1
    if pattern == "late":
        return token_ids.remainder(3) + 3
    raise ValueError(f"unsupported prescribed exit pattern: {pattern}")


def route_target_patch_mask(
    token_ids: torch.Tensor,
    *,
    route_patch_count: int,
    target_patch_count: int,
    max_boundary_gap: int = 1,
) -> torch.Tensor:
    """Select routed token IDs with a teacher target; allow only boundary truncation."""
    if min(route_patch_count, target_patch_count) <= 0 or max_boundary_gap < 0:
        raise ValueError("patch counts must be positive and boundary gap non-negative")
    if abs(route_patch_count - target_patch_count) > max_boundary_gap:
        raise ValueError(
            f"teacher/router patch geometry differs by {abs(route_patch_count - target_patch_count)}"
        )
    if token_ids.ndim != 1 or token_ids.dtype != torch.long:
        raise TypeError("routed token IDs must be a one-dimensional long tensor")
    if token_ids.numel() and (
        int(token_ids.min()) < 0 or int(token_ids.max()) >= route_patch_count
    ):
        raise ValueError("routed token ID is outside the route patch geometry")
    return token_ids < target_patch_count


def align_patch_row_prefix(
    prediction: torch.Tensor,
    reference: torch.Tensor,
    *,
    max_boundary_gap: int = 1,
) -> tuple[torch.Tensor, torch.Tensor, int]:
    """Align full latent rows by index, tolerating only one trailing boundary patch."""
    if prediction.ndim != 2 or reference.ndim != 2 or prediction.shape[1] != reference.shape[1]:
        raise ValueError("routed and teacher patch matrices must have matching feature widths")
    gap = abs(prediction.shape[0] - reference.shape[0])
    if gap > max_boundary_gap:
        raise ValueError(f"teacher/router patch geometry differs by {gap}")
    count = min(prediction.shape[0], reference.shape[0])
    return prediction[:count], reference[:count], gap


def router_objective(
    logits: torch.Tensor,
    exit_mse: torch.Tensor,
    continuation_steps: torch.Tensor,
    *,
    selected_step: int,
    total_patches: int,
    nfe_weight: float = 0.03,
) -> tuple[torch.Tensor, dict[str, torch.Tensor]]:
    """ForcingBooster stop-error/cost surrogate, averaged over active patches."""
    weight = float(nfe_weight)
    if not math.isfinite(weight) or weight < 0:
        raise ValueError("nfe_weight must be finite and non-negative")
    if type(selected_step) is not int or selected_step < 1:
        raise ValueError("selected_step must be a positive integer")
    if type(total_patches) is not int or total_patches < 1:
        raise ValueError("total_patches must be positive")
    scores = logits.float().reshape(-1)
    if not bool(torch.isfinite(scores).all()):
        raise FloatingPointError("router logits must be finite")
    error = exit_mse.detach().to(device=scores.device, dtype=torch.float32).reshape(-1)
    cost = continuation_steps.detach().to(device=scores.device, dtype=torch.float32).reshape(-1)
    if scores.shape != error.shape or scores.shape != cost.shape:
        raise ValueError("router logits, exit errors and continuation costs must align")
    if scores.numel() > total_patches:
        raise ValueError("active patch count exceeds total patch count")
    if not scores.numel():
        # Keep a zero connected to the trainable graph so all ranks can use the
        # same backward structure; trainers skip updates for an empty batch.
        zero = logits.sum() * 0.0
        return zero, {"router_loss": zero.detach(), "router_mse": zero.detach(),
                      "router_nfe": zero.detach(), "router_exit_prob": zero.detach()}
    if not bool(torch.isfinite(error).all()) or not bool(torch.isfinite(cost).all()):
        raise ValueError("router targets must be finite")
    if bool((cost < selected_step + 1).any()):
        raise ValueError("continuing patches must be assigned at least one further step")
    probability = scores.sigmoid()
    mse = (probability * error).mean()
    expected_steps = probability * selected_step + (1.0 - probability) * cost
    nfe = expected_steps.mean()
    loss = mse + weight * nfe
    return loss, {
        "router_loss": loss.detach(),
        "router_mse": mse.detach(),
        "router_nfe": nfe.detach(),
        "router_exit_prob": probability.detach().mean(),
    }


def manifest_digest(manifest: dict[str, object]) -> str:
    data = json.dumps(manifest, sort_keys=True, separators=(",", ":")).encode("utf-8")
    return hashlib.sha256(data).hexdigest()



class RouterRuntimeContract(TypedDict):
    model_manifest_sha256: str
    model_manifest: dict[str, object]
    checkpoint: str
    preset_id: str
    sampling_contract: str
    sampler: str
    sigmas: list[float]
    attention_option: str
    vsa_topk_ratio: float
    transformer_blocks: int
    feature_dim: int
    patch_size: list[int]
    router_granularity: str
    threshold_rule: str
    freeze_runtime_semantics: str
    training_target_semantics: str


def runtime_contract(
    *, model: ModelPatcher, profile: dict[str, object], sigmas: torch.Tensor, sampler_name: str,
) -> RouterRuntimeContract:
    """Build strict router compatibility fields from the loaded Comfy model."""
    backbone = model.get_model_object("diffusion_model")
    model_manifest = profile.get("model_manifest")
    if not isinstance(model_manifest, dict) or not model_manifest:
        raise ValueError("FastH3 router requires a content-hashed model manifest")
    preset = profile.get("preset_id")
    if not isinstance(preset, str) or "trim" not in preset.lower():
        raise ValueError("this ForcingBooster router is trained for a Trim preset")
    vsa = profile.get("vsa")
    if not isinstance(vsa, dict):
        raise TypeError("FastH3 router requires the loaded VSA profile")
    vsa_ratio = vsa.get("topk_ratio", vsa.get("keep_ratio"))
    if vsa_ratio is None or not math.isfinite(float(vsa_ratio)) or not 0 < float(vsa_ratio) <= 1:
        raise ValueError("FastH3 router requires a valid VSA key-budget ratio")
    return {
        "model_manifest_sha256": manifest_digest(model_manifest),
        "model_manifest": dict(model_manifest),
        "checkpoint": str(profile.get("checkpoint", "")),
        "preset_id": preset,
        "sampling_contract": str(profile.get("sampling_contract", "")),
        "sampler": str(sampler_name),
        "sigmas": [float(value) for value in torch.as_tensor(sigmas).detach().cpu().tolist()],
        "attention_option": str(profile.get("attention_option", "")),
        "vsa_topk_ratio": float(vsa_ratio),
        "transformer_blocks": len(backbone.blocks),
        "feature_dim": int(backbone.hidden_size),
        "patch_size": [int(value) for value in backbone.patch_size],
        "router_granularity": "patch_2x2_video_latent",
        "threshold_rule": "sigmoid_gt_threshold",
        "freeze_runtime_semantics": "trim5-model-boundary-projection-v2",
        "training_target_semantics": "request-scoped-rollout-cache-parity-v8",
    }


def router_profile_path(profile_id: str, root: str | Path | None = None) -> Path:
    """Resolve a path-free profile ID beneath Comfy's dedicated model folder."""
    if not isinstance(profile_id, str) or _PROFILE_ID.fullmatch(profile_id) is None:
        raise ValueError("router profile must be a 1–64 character identifier")
    if root is None:
        root = os.environ.get("COMFYSTREAM_FORCINGBOOSTER_ROOT")
    if root is None:
        import folder_paths

        root = Path(folder_paths.models_dir) / "forcingbooster"
    base = Path(root).expanduser().resolve()
    candidate = (base / profile_id / "router.safetensors").resolve(strict=True)
    if not candidate.is_relative_to(base) or not candidate.is_file():
        raise ValueError("router profile escaped its model directory")
    return candidate


def atomic_save_router(
    head: PatchExitRouter, output_dir: str | Path, manifest: dict[str, object],
) -> tuple[Path, Path]:
    """Write weights and the compatibility contract atomically."""
    from safetensors.torch import save_file

    target_dir = Path(output_dir).expanduser().resolve()
    target_dir.mkdir(parents=True, exist_ok=True)
    weights_path = target_dir / "router.safetensors"
    manifest_path = target_dir / "router.json"
    metadata = dict(manifest)
    metadata.update(
        schema=ROUTER_SCHEMA,
        training_contract=TRAINING_CONTRACT,
        input_dim=head.input_dim,
        hidden_dim=head.hidden_dim,
        weights_sha256=None,
    )
    fd, temporary = tempfile.mkstemp(prefix=".router-", suffix=".safetensors", dir=target_dir)
    os.close(fd)
    try:
        save_file(
            {key: value.detach().to(device="cpu", dtype=torch.float32).contiguous()
             for key, value in head.state_dict().items()},
            temporary,
        )
        digest = hashlib.sha256(Path(temporary).read_bytes()).hexdigest()
        metadata["weights_sha256"] = digest
        with open(temporary + ".json", "w", encoding="utf-8") as handle:
            json.dump(metadata, handle, sort_keys=True, indent=2)
            handle.write("\n")
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, weights_path)
        os.replace(temporary + ".json", manifest_path)
    finally:
        for path in (Path(temporary), Path(temporary + ".json")):
            path.unlink(missing_ok=True)
    return weights_path, manifest_path


def load_router(
    weights_path: str | Path,
    *,
    expected_input_dim: int,
    expected_contract: Mapping[str, object],
    device: torch.device | str,
) -> tuple[PatchExitRouter, dict[str, object]]:
    from safetensors.torch import load_file

    path = Path(weights_path).expanduser().resolve(strict=True)
    manifest_path = path.with_name("router.json")
    meta = json.loads(manifest_path.read_text(encoding="utf-8"))
    if meta.get("schema") != ROUTER_SCHEMA or meta.get("training_contract") != TRAINING_CONTRACT:
        raise ValueError("unsupported ForcingBooster router schema")
    if meta.get("input_dim") != expected_input_dim:
        raise ValueError(
            f"router feature width {meta.get('input_dim')} does not match {expected_input_dim}"
        )
    expected_assets = expected_contract.get("model_manifest")
    trained_assets = meta.get("source_model_manifest")
    if expected_assets is not None:
        if not isinstance(expected_assets, dict) or not isinstance(trained_assets, dict) or not trained_assets:
            raise ValueError("router model asset manifest is missing or malformed")
        if manifest_digest(trained_assets) != meta.get("model_manifest_sha256"):
            raise ValueError("router training model manifest digest is inconsistent")
        mismatches = {
            name: (digest, expected_assets.get(name))
            for name, digest in trained_assets.items()
            if expected_assets.get(name) != digest
        }
        if mismatches:
            raise ValueError(f"router trained model assets differ from runtime assets: {mismatches}")
    for key, value in expected_contract.items():
        # Runtime graphs can include assets (such as an audio VAE) that do not
        # participate in the frozen Trim transformer features. Bind the router
        # to every asset used while training, while allowing harmless additions.
        if expected_assets is not None and key in {"model_manifest", "model_manifest_sha256"}:
            continue
        if meta.get(key) != value:
            raise ValueError(f"router contract mismatch for {key}: {meta.get(key)!r} != {value!r}")
    digest = hashlib.sha256(path.read_bytes()).hexdigest()
    if digest != meta.get("weights_sha256"):
        raise ValueError("router tensor hash does not match its manifest")
    head = PatchExitRouter(expected_input_dim, int(meta["hidden_dim"]))
    head.load_state_dict(load_file(str(path), device=str(device)), strict=True)
    head.to(device=device, dtype=torch.float32)
    head.eval()
    return head, meta
