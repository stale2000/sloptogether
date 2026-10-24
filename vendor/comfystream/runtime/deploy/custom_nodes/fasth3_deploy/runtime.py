"""Identity for the measured FastH3 preset and narrow weight variants."""

import hashlib
import importlib.metadata
import json
import re
import sys
from typing import NotRequired, TypedDict, cast

from .kitchen_baseline import (
    B1_PRESET,
    BASELINE_CHUNK_SIZE,
    KITCHEN_VERSION,
    KITCHEN_WHEEL_SHA256,
    baseline_policy,
)

GOLDEN_PRESET = "fp4-mlp-fused"
FASTH3_V2_PRESET = "fp4-mlp-fused-fasth3-v2-8step"
FASTH3_V2_CHECKPOINT = "fastvideo_fasth3_8step_v2_pruned_int8_convrot.safetensors"
FASTH3_V2_4STEP_20_PRESET = "fp4-mlp-fused-fasth3-v2-4step-vsa20"
FASTH3_V2_8STEP_10_PRESET = "fp4-mlp-fused-fasth3-v2-8step-vsa10"
FASTH3_V2_8STEP_05_PRESET = "fp4-mlp-fused-fasth3-v2-8step-vsa05"
FASTH3_TRIM_CHECKPOINT = "fastvideo_fasth3_trim_8step_int8_convrot.safetensors"
FASTH3_V2_B1_8STEP_PRESET = "fp4-mlp-fused-fasth3-v2-8step-vsa20-b1-control"
FASTH3_TRIM_B1_4STEP_PRESET = "fp4-mlp-fused-fasth3-trim-4step-vsa20-b1-candidate"
FASTH3_TRIM_B1_5STEP_PRESET = "fp4-mlp-fused-fasth3-trim-5step-vsa20-b1-candidate"
FASTH3_TRIM_B1_8STEP_PRESET = "fp4-mlp-fused-fasth3-trim-8step-vsa20-b1-candidate"
DEFAULT_PRESET = FASTH3_TRIM_B1_5STEP_PRESET
OPTIMIZED_B1_PRESETS = frozenset({
    B1_PRESET, FASTH3_V2_B1_8STEP_PRESET,
    FASTH3_TRIM_B1_4STEP_PRESET, FASTH3_TRIM_B1_5STEP_PRESET,
    FASTH3_TRIM_B1_8STEP_PRESET,
})
LEGACY_EXECUTION_PROFILE = "legacy"
NATIVE_DECODER_EXECUTION_PROFILE = "native_v036_candidate"
EXECUTION_PROFILES = (LEGACY_EXECUTION_PROFILE, NATIVE_DECODER_EXECUTION_PROFILE)
class Preset(TypedDict):
    checkpoint: str
    precision: str
    chunk_size: int
    experimental: bool
    sampling_contract: str
    steps: int
    sampler: str
    vsa_topk_ratio: float
    experiment_note: NotRequired[str]


class PresetManifest(Preset):
    preset_id: str
    schema: str
    topk_ratio: float
    statistics_policy: str
    preset_hash: NotRequired[str]
    token_aug: NotRequired[int]
    vae_precision_policy: NotRequired[str]
    kitchen_baseline: NotRequired[dict[str, str | int | bool]]
    vsa_budget_policy: NotRequired[str | None]
    transformer_compile: NotRequired[dict[str, object]]
    model_variant: NotRequired[str]
    lora_strength: NotRequired[float]
    gate_loader: NotRequired[str]
    gate_loader_profile: NotRequired[dict[str, object]]
    status: NotRequired[str]


PRESETS: dict[str, Preset] = {
    GOLDEN_PRESET: {
        "checkpoint": "minimax_h3_fastvideo_vsa_datafree_1300step_4step_int8_convrot.safetensors",
        "precision": "fp4-mlp-fused",
        "chunk_size": 4096,
        "experimental": False,
        "sampling_contract": "preview-v1-4step",
        "steps": 4,
        "sampler": "euler",
        "vsa_topk_ratio": 0.10,
    },
    FASTH3_V2_PRESET: {
        "checkpoint": FASTH3_V2_CHECKPOINT,
        "precision": "fp4-mlp-fused",
        "chunk_size": 4096,
        "experimental": True,
        "sampling_contract": "v2-8step",
        "steps": 8,
        "sampler": "res_multistep",
        # The V2 card says VSA-H3 was trained at 80% sparsity: retain 20%.
        "vsa_topk_ratio": 0.20,
    },
    FASTH3_V2_4STEP_20_PRESET: {
        "checkpoint": FASTH3_V2_CHECKPOINT,
        "precision": "fp4-mlp-fused",
        "chunk_size": 4096,
        "experimental": True,
        "sampling_contract": "v2-4step-subsampled",
        "steps": 4,
        "sampler": "res_multistep",
        "vsa_topk_ratio": 0.20,
        "experiment_note": "V2 trained for eight steps; four-step schedule is subsampled and exploratory.",
    },
    FASTH3_V2_8STEP_10_PRESET: {
        "checkpoint": FASTH3_V2_CHECKPOINT,
        "precision": "fp4-mlp-fused",
        "chunk_size": 4096,
        "experimental": True,
        "sampling_contract": "v2-8step",
        "steps": 8,
        "sampler": "res_multistep",
        "vsa_topk_ratio": 0.10,
        "experiment_note": "VSA retention differs from V2's published 20% keep setting.",
    },
    FASTH3_V2_8STEP_05_PRESET: {
        "checkpoint": FASTH3_V2_CHECKPOINT,
        "precision": "fp4-mlp-fused",
        "chunk_size": 4096,
        "experimental": True,
        "sampling_contract": "v2-8step",
        "steps": 8,
        "sampler": "res_multistep",
        "vsa_topk_ratio": 0.05,
        "experiment_note": "VSA retention differs from V2's published 20% keep setting.",
    },
}
PRESETS[B1_PRESET] = PRESETS[FASTH3_V2_4STEP_20_PRESET].copy()
PRESETS[B1_PRESET]["chunk_size"] = BASELINE_CHUNK_SIZE
PRESETS[FASTH3_V2_B1_8STEP_PRESET] = {
    **PRESETS[FASTH3_V2_PRESET],
    "chunk_size": BASELINE_CHUNK_SIZE,
    "experimental": True,
    "experiment_note": "Eight-step B1 optimization control for checkpoint comparisons.",
}
PRESETS[FASTH3_TRIM_B1_4STEP_PRESET] = {
    **PRESETS[FASTH3_V2_4STEP_20_PRESET],
    "checkpoint": FASTH3_TRIM_CHECKPOINT,
    "chunk_size": BASELINE_CHUNK_SIZE,
    "experimental": True,
    "sampling_contract": "v2-4step-subsampled",
    "experiment_note": (
        "Literal B1 checkpoint replacement; Trim was distilled for eight steps, "
        "so four-step output quality is unqualified."
    ),
}
PRESETS[FASTH3_TRIM_B1_5STEP_PRESET] = {
    **PRESETS[FASTH3_V2_4STEP_20_PRESET],
    "checkpoint": FASTH3_TRIM_CHECKPOINT,
    "chunk_size": BASELINE_CHUNK_SIZE,
    "experimental": True,
    "sampling_contract": "v2-5step-subsampled",
    "steps": 5,
    "experiment_note": (
        "Trim 5-step experiment; keeps the four-step sample points and adds the "
        "0.125 timestep from the existing eight-step schedule before terminal zero. "
        "Trim was distilled for eight steps."
    ),
}
PRESETS[FASTH3_TRIM_B1_8STEP_PRESET] = {
    **PRESETS[FASTH3_V2_8STEP_10_PRESET],
    "checkpoint": FASTH3_TRIM_CHECKPOINT,
    "chunk_size": BASELINE_CHUNK_SIZE,
    "experimental": True,
    "sampling_contract": "v2-8step",
    # Keep the current B1 VSA retention and execution path while following
    # Trim's published eight-step sampler contract.
    "vsa_topk_ratio": 0.20,
    "experiment_note": (
        "Trim eight-step sampler with the current B1 VSA, fused MLP, decoder, "
        "and output optimizations."
    ),
}
def preset_manifest(name: str, *, token_aug: int=0, vae_precision_policy: str="established") -> PresetManifest:
    policy = baseline_policy(token_aug=token_aug, vae_precision_policy=vae_precision_policy)
    try:
        preset = PRESETS[name]
    except KeyError as error:
        choices = ", ".join(sorted(PRESETS))
        raise ValueError(f"unknown FastH3 preset {name!r}; choose {choices}") from error
    config = cast(PresetManifest, dict(
        preset,
        preset_id=name,
        schema="fasth3-preset/1",
        topk_ratio=preset["vsa_topk_ratio"],
        statistics_policy="per_request",
    ))
    # Preserve the historical default manifest/hash for explicit legacy IDs.
    if name in OPTIMIZED_B1_PRESETS or token_aug != 0 or vae_precision_policy != "established":
        config.update({
            "schema": "fasth3-preset/2",
            "token_aug": token_aug,
            "vae_precision_policy": vae_precision_policy,
        })
    if name in OPTIMIZED_B1_PRESETS:
        config["kitchen_baseline"] = policy
    config["preset_hash"] = hashlib.sha256(
        json.dumps(config, sort_keys=True).encode()
    ).hexdigest()
    return config


def execution_profile_manifest(
    name: str, execution_profile: str = LEGACY_EXECUTION_PROFILE, *,
    resolved_preset_hash: str | None = None,
) -> dict[str, str]:
    """Bind a runtime path to the loader's resolved policy/model identity.

    Omission retains the historical default-preset descriptor. Callers that
    resolve token augmentation, precision or PDMD variants must supply their
    final preset hash so qualification receipts cannot alias the defaults.
    """
    if execution_profile not in EXECUTION_PROFILES:
        raise ValueError(f"unknown FastH3 execution profile: {execution_profile!r}")
    preset = preset_manifest(name)
    if resolved_preset_hash is None:
        resolved_preset_hash = preset["preset_hash"]
    elif (not isinstance(resolved_preset_hash, str)
          or re.fullmatch(r"[0-9a-f]{64}", resolved_preset_hash) is None):
        raise ValueError("resolved_preset_hash must be a lowercase SHA-256 digest")
    descriptor = {
        "schema": "fasth3-execution-profile/1",
        "profile_id": f"{name}::decoder-{execution_profile}/v1",
        "preset_id": name,
        "preset_hash": resolved_preset_hash,
        "decoder_mode": (
            "native_v036"
            if execution_profile == NATIVE_DECODER_EXECUTION_PROFILE
            else "fused_ff_qk_rope"
        ),
        "promotion_status": (
            "unqualified_candidate"
            if execution_profile == NATIVE_DECODER_EXECUTION_PROFILE
            else "legacy_reference"
        ),
    }
    descriptor["profile_hash"] = hashlib.sha256(
        json.dumps(descriptor, sort_keys=True, separators=(",", ":")).encode()
    ).hexdigest()
    return descriptor


def execution_profile_for_decoder(
    name: str, decoder_mode: str, *, resolved_preset_hash: str | None = None,
) -> dict[str, str]:
    """Resolve the named runtime profile implied by one serialized decoder mode."""
    if decoder_mode == "fused_ff_qk_rope":
        selected = LEGACY_EXECUTION_PROFILE
    elif decoder_mode == "native_v036":
        selected = NATIVE_DECODER_EXECUTION_PROFILE
    else:
        raise ValueError(f"unknown FastH3 decoder mode: {decoder_mode!r}")
    return execution_profile_manifest(name, selected, resolved_preset_hash=resolved_preset_hash)


def validate_execution_profile_id(
    name: str, decoder_mode: str, profile_id: str | None, *,
    resolved_preset_hash: str | None = None,
) -> dict[str, str]:
    """Reject workflow profile IDs that do not match the selected preset and decoder."""
    profile = execution_profile_for_decoder(name, decoder_mode, resolved_preset_hash=resolved_preset_hash)
    if profile_id not in (None, "", profile["profile_id"]):
        raise ValueError("execution_profile_id does not match decoder mode and preset")
    return profile


def runtime_identity(*, comfyui_commit: str | None=None) -> dict[str, object]:
    import torch

    if not torch.cuda.is_available():
        raise RuntimeError("FastH3 requires CUDA")
    identity: dict[str, object] = {
        "gpu": torch.cuda.get_device_name(),
        "capability": list(torch.cuda.get_device_capability()),
        "torch": torch.__version__,
        "cuda": torch.version.cuda,
    }
    if comfyui_commit is None:
        from .model_cache import comfyui_core_revision

        comfyui_commit = comfyui_core_revision()
    identity["comfyui_commit"] = comfyui_commit
    identity["comfy-kitchen"] = importlib.metadata.version("comfy-kitchen")
    identity["kitchen_build_expected"] = baseline_policy()
    identity["kitchen_pin_matches"] = (
        identity["comfy-kitchen"] == cast(dict[str, str | int | bool], identity["kitchen_build_expected"])["kitchen_version"]
    )
    # Expected wheel hash above is a lockfile identity, not an installed-byte attestation.
    canonical = json.dumps(identity, sort_keys=True, separators=(",", ":"))
    identity["environment_digest"] = hashlib.sha256(canonical.encode()).hexdigest()
    return identity


def require_b1_runtime() -> None:
    """Fail before model loading when the worker is not the locked B1 runtime."""
    # The worker may be loaded outside the coordinator's Python environment.
    if sys.version_info < (3, 12):  # noqa: UP036
        raise RuntimeError(
            "FastH3 B1 requires CPython 3.12+; the locked Kitchen wheel is cp312-abi3"
        )

    import torch

    cuda_version = torch.version.cuda or ""
    try:
        cuda_major, cuda_minor = (int(part) for part in cuda_version.split(".", 1))
    except (ValueError, TypeError):
        raise RuntimeError(f"FastH3 B1 requires PyTorch CUDA 13.0+; found {cuda_version!r}")
    if (cuda_major, cuda_minor) < (13, 0):
        raise RuntimeError(
            f"FastH3 B1 requires PyTorch CUDA 13.0+; found {cuda_version} ({torch.__version__})"
        )

    kitchen = importlib.metadata.distribution("comfy-kitchen")
    if kitchen.version != KITCHEN_VERSION:
        raise RuntimeError(
            f"FastH3 B1 requires comfy-kitchen=={KITCHEN_VERSION}; found {kitchen.version}"
        )
    direct_url = kitchen.read_text("direct_url.json")
    if direct_url is None:
        raise RuntimeError("FastH3 B1 requires wheel provenance in comfy-kitchen direct_url.json")
    try:
        archive_hash = json.loads(direct_url)["archive_info"]["hashes"]["sha256"]
    except (FileNotFoundError, KeyError, TypeError, json.JSONDecodeError) as exc:
        raise RuntimeError(
            "FastH3 B1 requires the locked comfy-kitchen 0.2.34 cp312-abi3 wheel; "
            "installed distribution has no verifiable wheel hash"
        ) from exc
    if archive_hash != KITCHEN_WHEEL_SHA256:
        raise RuntimeError(
            "FastH3 B1 requires the locked comfy-kitchen 0.2.34 cp312-abi3 wheel; "
            f"found sha256={archive_hash}"
        )

    # These imports catch mixed Torch package families before a long render.
    try:
        import torchaudio  # noqa: F401
        import torchvision  # noqa: F401
    except Exception as exc:
        raise RuntimeError(
            "FastH3 B1 requires torchvision and torchaudio built for the installed CUDA PyTorch"
        ) from exc
