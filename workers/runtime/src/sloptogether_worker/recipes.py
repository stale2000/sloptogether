from __future__ import annotations

import copy
import hashlib
import importlib.resources
import json
import uuid
from dataclasses import dataclass
from typing import Any

from .errors import WorkerError
from .models import WorkerJob

TRIM_FIVE_STEP_ID = "fast-h3-trim-5step-vsa20-b1"
SOL_UPSCALE_ID = "sol-h3-upscale-pruna-fast"
TRIM_PRESET_ID = "fp4-mlp-fused-fasth3-trim-5step-vsa20-b1-candidate"
TRIM_SOURCE_DIGEST = "9a2d5d19fb22b7e55d29c8e6048c4c421c5b73b044b7cc010188efe7df9ccaef"
UPSCALE_SOURCE_DIGEST = "e0b4949fbbc02e31b0dc697fc2bedc5a7a1efe57d5d96fe908013d89a3bf8b8c"
MAX_WORKFLOW_BYTES = 2 * 1024 * 1024


@dataclass(frozen=True, slots=True)
class Recipe:
    recipe_id: str
    workflow_file: str
    source_digest: str
    width: int | None
    height: int | None
    fps: int | None
    frame_count: int | None
    minimum_vram_bytes: int
    minimum_free_vram_bytes: int
    minimum_sm: tuple[int, int]
    required_nodes: frozenset[str]
    output_node_id: str
    minimum_system_memory_bytes: int = 0
    platforms: frozenset[str] = frozenset({"linux", "wsl", "fal"})


RECIPES: dict[str, Recipe] = {
    TRIM_FIVE_STEP_ID: Recipe(
        recipe_id=TRIM_FIVE_STEP_ID,
        workflow_file="trim-five-step-first-last-frame.json",
        source_digest=TRIM_SOURCE_DIGEST,
        width=448,
        height=256,
        fps=24,
        frame_count=362,
        minimum_vram_bytes=24_000_000_000,
        minimum_free_vram_bytes=22 * 1024**3,
        minimum_sm=(8, 9),
        required_nodes=frozenset({
            "FastH3OptimizedLoader",
            "ComfyStreamerH3ImageToVideo",
            "FastH3BenchmarkSampler",
            "FastH3BenchmarkVAEDecode",
            "FastH3BenchmarkVAEDecodeAudio",
            "FastH3BenchmarkOutput",
            "ClipProjApply",
            "LoadImage",
        }),
        output_node_id="12",
    ),
    SOL_UPSCALE_ID: Recipe(
        recipe_id=SOL_UPSCALE_ID,
        workflow_file="sol-upscale-standard.json",
        source_digest=UPSCALE_SOURCE_DIGEST,
        width=1920,
        height=1080,
        fps=None,
        frame_count=None,
        minimum_vram_bytes=24_000_000_000,
        minimum_free_vram_bytes=22 * 1024**3,
        minimum_sm=(8, 9),
        required_nodes=frozenset({"LoadVideo", "ComfyStreamMiniMaxH3SoLUpscaler", "SaveVideo"}),
        output_node_id="3",
        minimum_system_memory_bytes=128 * 1024**3,
    ),
}


def _workflow(recipe: Recipe) -> dict[str, Any]:
    file = importlib.resources.files("sloptogether_worker").joinpath("assets", "recipes", recipe.workflow_file)
    raw = file.read_bytes()
    if len(raw) > MAX_WORKFLOW_BYTES:
        raise WorkerError("workflow_too_large", "Pinned worker workflow exceeds its size bound.")
    actual = hashlib.sha256(raw).hexdigest()
    manifest = importlib.resources.files("sloptogether_worker").joinpath("assets", "recipes", "provenance.json")
    records = json.loads(manifest.read_text("utf-8"))
    expected = next((row.get("sha256") for row in records if row.get("destination", "").endswith(recipe.workflow_file)), None)
    if actual != expected:
        raise WorkerError("workflow_digest_mismatch", "Pinned worker workflow failed its integrity check.")
    try:
        value = json.loads(raw)
    except json.JSONDecodeError as error:
        raise WorkerError("workflow_invalid", "Pinned worker workflow is invalid JSON.") from error
    if not isinstance(value, dict):
        raise WorkerError("workflow_invalid", "Pinned worker workflow has an invalid shape.")
    nodes = [node for node in value.values() if isinstance(node, dict) and isinstance(node.get("class_type"), str)]
    if not recipe.required_nodes.issubset({node["class_type"] for node in nodes}):
        raise WorkerError("workflow_node_set_changed", "Pinned worker workflow does not match its capability profile.")
    return value


def validate_comfy_capabilities(
    object_info: object,
    role: str,
    *,
    compute_capability: tuple[int, int] | None,
    platform: str = "linux",
    vsa_budget_policy: str = "fixed",
) -> list[str]:
    if not isinstance(object_info, dict):
        raise WorkerError("comfy_object_info_invalid", "Local ComfyUI returned invalid node metadata.")
    recipes = [item for item in RECIPES.values() if (role == "generation" and item.fps) or (role == "upscale" and item.width and item.recipe_id == SOL_UPSCALE_ID)]
    eligible: list[str] = []
    for recipe in recipes:
        if platform not in recipe.platforms:
            continue
        if not recipe.required_nodes.issubset(object_info):
            continue
        if recipe.recipe_id == SOL_UPSCALE_ID:
            node = object_info.get("ComfyStreamMiniMaxH3SoLUpscaler")
            inputs = node.get("input") if isinstance(node, dict) else None
            optional = inputs.get("optional") if isinstance(inputs, dict) else None
            precision = optional.get("transformer_precision") if isinstance(optional, dict) else None
            if not isinstance(precision, list) or not precision or not isinstance(precision[0], list) or "auto" not in precision[0]:
                continue
            if not isinstance(optional,dict) or "sloptogether_scope" not in optional:
                continue
            if compute_capability is not None and compute_capability < (8, 9):
                continue
        else:
            # 5-step Trim is a candidate preset; never imply this is qualified
            # for a GPU solely because the custom node has loaded.
            if recipe.recipe_id != TRIM_FIVE_STEP_ID:
                continue
            if vsa_budget_policy == "adaptive" and platform != "fal":
                continue
            node = object_info.get("FastH3OptimizedLoader")
            inputs = node.get("input") if isinstance(node, dict) else None
            optional = inputs.get("optional") if isinstance(inputs, dict) else None
            policy = optional.get("vsa_budget_policy") if isinstance(optional, dict) else None
            choices = policy[0] if isinstance(policy, list) and policy else None
            if not isinstance(choices, list) or vsa_budget_policy not in choices:
                continue
        eligible.append(recipe.recipe_id)
    return eligible


def validate_device_recipe(
    recipe_id: str,
    compute_capability: tuple[int, int] | None,
    total_memory_bytes: int | None,
    system_memory_bytes: int | None = None,
) -> None:
    recipe = RECIPES.get(recipe_id)
    if recipe is None:
        raise WorkerError("recipe_not_allowed", "This recipe is not in the signed worker manifest.")
    if compute_capability is None or compute_capability < recipe.minimum_sm:
        raise WorkerError("recipe_gpu_architecture_unsupported", "The installed GPU does not meet this pinned recipe's architecture requirement.")
    if total_memory_bytes is None or total_memory_bytes < recipe.minimum_vram_bytes:
        raise WorkerError("recipe_gpu_memory_unsupported", "The installed GPU does not meet this recipe's VRAM profile.")
    if (recipe.minimum_system_memory_bytes and total_memory_bytes < 94 * 1024**3
            and (system_memory_bytes is None or system_memory_bytes < recipe.minimum_system_memory_bytes)):
        raise WorkerError("recipe_system_memory_unsupported", "This low-VRAM upscale profile requires at least 128 GiB of system RAM.")


def validate_free_vram(
    recipe_id: str,
    free_memory_bytes: int | None,
    compute_capability: tuple[int, int] | None = None,
    total_memory_bytes: int | None = None,
) -> None:
    recipe = RECIPES.get(recipe_id)
    required = recipe.minimum_free_vram_bytes if recipe else 0
    if (recipe_id == SOL_UPSCALE_ID and compute_capability is not None
            and compute_capability >= (10, 0) and total_memory_bytes is not None
            and total_memory_bytes >= 94 * 1024**3):
        required = 90 * 1024**3
    if recipe is None or free_memory_bytes is None or free_memory_bytes < required:
        raise WorkerError("gpu_memory_reservation_insufficient", "Free GPU memory is below this recipe's reserved worker budget.")


def build_workflow(
    job: WorkerJob,
    recipe: Recipe,
    comfy_filenames: dict[str, str],
    *,
    vsa_budget_policy: str = "fixed",
) -> tuple[str, dict[str, Any]]:
    if job.recipe_id != recipe.recipe_id or recipe.recipe_id not in RECIPES:
        raise WorkerError("recipe_not_allowed", "This device does not have the requested pinned recipe.")
    if job.recipe_sha256 != recipe.source_digest:
        raise WorkerError("recipe_digest_not_qualified", "This device does not have the server-requested recipe version.")
    if not comfy_filenames:
        raise WorkerError("recipe_assets_missing", "The task is missing its authorized local assets.")
    if recipe.fps is not None and (job.width, job.height, job.fps_num, job.fps_den, job.frame_count) != (
        recipe.width, recipe.height, recipe.fps, 1, recipe.frame_count
    ):
        raise WorkerError("recipe_dimensions_not_qualified", "This device does not support the job's requested native video geometry.")
    if recipe.recipe_id == SOL_UPSCALE_ID and (job.width, job.height) != (recipe.width, recipe.height):
        raise WorkerError("recipe_dimensions_not_qualified", "This device does not support the requested upscale dimensions.")
    graph = _workflow(recipe)
    rendered = copy.deepcopy(graph)
    if recipe.recipe_id == TRIM_FIVE_STEP_ID and vsa_budget_policy not in {"fixed", "adaptive"}:
        raise WorkerError("trim_vsa_budget_policy_invalid", "This worker profile has an unsupported Trim VSA policy.")
    if recipe.recipe_id == TRIM_FIVE_STEP_ID and not job.requested_end_boundary_revision_id:
        # The node defines both image references as optional. Remove the
        # unrequested last-frame input node entirely, rather than passing the
        # start image twice and pretending the worker had a locked end anchor.
        rendered.pop("21", None)
    for node_id, node in rendered.items():
        if not isinstance(node, dict) or not isinstance(node.get("inputs"), dict):
            continue
        inputs = node["inputs"]
        kind = node.get("class_type")
        if kind == "FastH3OptimizedLoader":
            inputs["preset"] = TRIM_PRESET_ID
            inputs["vsa_budget_policy"] = vsa_budget_policy
        elif kind == "ComfyStreamerH3ImageToVideo":
            inputs["prompt"] = job.prompt
            inputs["width"] = recipe.width
            inputs["height"] = recipe.height
            inputs["length"] = recipe.frame_count
            inputs["first_frame"] = ["20", 0]
            if job.requested_end_boundary_revision_id and job.end_frame_asset_id:
                inputs["last_frame"] = ["21", 0]
            elif job.requested_end_boundary_revision_id:
                raise WorkerError("end_frame_missing", "This two-anchor generation job has no authorized end-frame asset.")
            else:
                inputs.pop("last_frame", None)
        elif kind == "LoadImage" and str(node_id) in comfy_filenames:
            inputs["image"] = comfy_filenames[str(node_id)]
        elif kind == "FastH3BenchmarkSampler":
            inputs["seed"] = int(uuid.UUID(job.job_id).int % (2**32))
            inputs["run_nonce"] = f"slop-{job.job_id}-{job.attempt_id}-{job.fence}"
        elif kind == "FastH3BenchmarkVAEDecode":
            inputs["retain_final_frame_only"] = True
            inputs["stream_fps"] = 24
        elif kind == "FastH3BenchmarkOutput":
            inputs["fps"] = 24
            inputs["filename_prefix"] = f"sloptogether/{job.job_id}/{job.attempt_id}/clip"
        elif kind == "LoadVideo":
            inputs["file"] = comfy_filenames.get("source_video", "")
        elif kind == "ComfyStreamMiniMaxH3SoLUpscaler":
            inputs["width"] = recipe.width
            inputs["height"] = recipe.height
            inputs["output_backend"] = "nvenc"
            inputs["transformer_precision"] = "auto"
            inputs["sloptogether_scope"] = f"sloptogether/{job.job_id}/{job.attempt_id}"
        elif kind == "SaveVideo":
            inputs["filename_prefix"] = f"sloptogether/{job.job_id}/{job.attempt_id}/clip"
    return recipe.output_node_id, rendered

