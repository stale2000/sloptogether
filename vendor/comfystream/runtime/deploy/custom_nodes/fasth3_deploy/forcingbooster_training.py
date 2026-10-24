"""ComfyUI training node for an on-policy FastH3 Trim exit router.

The denoiser stays frozen. Each training sample uses a cached full-schedule x0
reference and a current-policy rollout whose final-block features are captured
by the existing request-scoped token-freeze wrapper.
"""
from __future__ import annotations

import hashlib
import json
import os
import random
import re
import shutil
import tempfile
import time
from collections.abc import Iterator, Mapping
from contextlib import contextmanager
from importlib import import_module
from pathlib import Path
from typing import TYPE_CHECKING, Literal, NotRequired, TypedDict, cast

import torch

if TYPE_CHECKING:
    from comfy.model_patcher import ModelPatcher
    from comfy.samplers import KSAMPLER
    from comfy.sd import CLIP, VAE

    from .benchmark_sampler import (
        ComfyStreamerH3BenchmarkSampler as _ComfyStreamerH3BenchmarkSampler,
    )
    from .benchmark_sampler import _sampler_name
    from .forcingbooster_router import PatchExitRouter as _PatchExitRouter
    from .forcingbooster_router import align_patch_row_prefix as _align_patch_row_prefix
    from .forcingbooster_router import atomic_save_router as _atomic_save_router
    from .forcingbooster_router import load_router as _load_router
    from .forcingbooster_router import patch_error_mse as _patch_error_mse
    from .forcingbooster_router import prescribed_exit_steps as _prescribed_exit_steps
    from .forcingbooster_router import route_target_patch_mask as _route_target_patch_mask
    from .forcingbooster_router import router_objective as _router_objective
    from .forcingbooster_router import runtime_contract as _runtime_contract
    from .speculative_forcing_freeze import TokenFreezeController as _TokenFreezeController
    from .speculative_forcing_freeze import _video_tokens
    from .speculative_forcing_probe import DenoisingTraceRecorder as _DenoisingTraceRecorder
    from .speculative_forcing_probe import video_clean_estimate as _video_clean_estimate
else:
    # Dynamic imports keep mypy from loading these modules a second time under
    # their standalone names when both custom-node loading modes are supported.
    _module_prefix = f"{__package__}." if __package__ else ""
    try:
        _benchmark_sampler = import_module(f"{_module_prefix}benchmark_sampler")
        _forcingbooster_router = import_module(f"{_module_prefix}forcingbooster_router")
        _speculative_forcing_freeze = import_module(f"{_module_prefix}speculative_forcing_freeze")
        _speculative_forcing_probe = import_module(f"{_module_prefix}speculative_forcing_probe")
    except ImportError:  # standalone smoke imports from the custom-node directory
        _benchmark_sampler = import_module("benchmark_sampler")
        _forcingbooster_router = import_module("forcingbooster_router")
        _speculative_forcing_freeze = import_module("speculative_forcing_freeze")
        _speculative_forcing_probe = import_module("speculative_forcing_probe")

    _ComfyStreamerH3BenchmarkSampler = _benchmark_sampler.ComfyStreamerH3BenchmarkSampler
    _sampler_name = _benchmark_sampler._sampler_name
    _PatchExitRouter = _forcingbooster_router.PatchExitRouter
    _align_patch_row_prefix = _forcingbooster_router.align_patch_row_prefix
    _atomic_save_router = _forcingbooster_router.atomic_save_router
    _load_router = _forcingbooster_router.load_router
    _patch_error_mse = _forcingbooster_router.patch_error_mse
    _prescribed_exit_steps = _forcingbooster_router.prescribed_exit_steps
    _route_target_patch_mask = _forcingbooster_router.route_target_patch_mask
    _router_objective = _forcingbooster_router.router_objective
    _runtime_contract = _forcingbooster_router.runtime_contract
    _TokenFreezeController = _speculative_forcing_freeze.TokenFreezeController
    _video_tokens = _speculative_forcing_freeze._video_tokens
    _DenoisingTraceRecorder = _speculative_forcing_probe.DenoisingTraceRecorder
    _video_clean_estimate = _speculative_forcing_probe.video_clean_estimate


class _ManifestRow(TypedDict):
    split: Literal['train', 'validation', 'test']
    source_id: str
    prompt: str
    first_frame: str
    first_frame_sha256: str
    width: NotRequired[int | str | float]
    height: NotRequired[int | str | float]
    length: NotRequired[int | str | float]


class _ParityCase(TypedDict):
    source_id: str
    seed: int
    exit_counts_by_step: list[int]
    first_last_patch_exit_steps: list[int]
    stage_metrics: list[dict[str, int | float | bool]]
    stage3_sampled_block_metrics: list[_BlockMetric]
    stage3_linear_metrics_by_block: dict[str, dict[str, dict[str, _ErrorMetric]]]
    stage3_block1_qkv_metrics: dict[str, object]
    first_divergent_linear: dict[str, object] | None
    first_divergent_block_output: int | None
    committed_coordinates_exact: bool
    final_latent_mse: float
    final_max_abs: float
    dense_reference_report: dict[str, object]
    sparse_report: dict[str, object]


class _ErrorMetric(TypedDict):
    mse: float | None
    max_abs: float | None
    finite_sample_count: int
    nonfinite_sample_count: int


class _BlockMetric(TypedDict):
    block: int
    input: _ErrorMetric
    output: _ErrorMetric


class _TrainingSample(TypedDict):
    features: torch.Tensor
    source_id: str
    exit_mse: torch.Tensor
    continuation: torch.Tensor
    selected_step: int
    total_patches: int
    exit_counts: list[int]
    patch_steps: torch.Tensor
    geometry_mismatch_patches: int


type _TeacherTarget = tuple[
    torch.Tensor, torch.Tensor, list[torch.Tensor], dict[str, str],
    list[torch.Tensor], list[dict[str, str]], list[str],
]


@contextmanager
def _rollout_state_scope() -> Iterator[None]:
    """Give each dense/routed trajectory independent rolling attention state."""
    module_prefix = f"{__package__}." if __package__ else ""
    try:
        attention_execution = import_module(f"{module_prefix}attention_execution")
        sol_attn = import_module(f"{module_prefix}sol_attn_minimax_v5")
    except ImportError:
        attention_execution = import_module("attention_execution")
        sol_attn = import_module("sol_attn_minimax_v5")
    sol_attn.reset_producer_stats()
    with attention_execution.capture_attention_execution():
        yield

class ComfyStreamerH3ForcingBoosterTrainer:
    """Train router-only ForcingBooster head using real B1 Comfy H3 rollouts."""

    RETURN_TYPES = ("STRING",)
    RETURN_NAMES = ("training_report",)
    FUNCTION = "train"
    CATEGORY = "ComfyStreamerH3/Training"
    OUTPUT_NODE = True

    @classmethod
    def INPUT_TYPES(cls) -> dict[str, dict[str, tuple[object, ...]]]:
        return {"required": {
            "model": ("MODEL",),
            "sampler": ("SAMPLER",),
            "sigmas": ("SIGMAS",),
            "clip": ("CLIP",),
            "vae": ("VAE",),
            "profile": ("H3_PROFILE",),
            "training_manifest": ("STRING", {"default": "", "multiline": False}),
            "output_dir": ("STRING", {"default": "/workspace/forcingbooster", "multiline": False}),
            "router_profile_id": ("STRING", {"default": "trim-router-v1", "multiline": False}),
            "max_updates": ("INT", {"default": 500, "min": 1, "max": 100000}),
            "updates_this_run": ("INT", {"default": 1, "min": 1, "max": 500}),
            "batch_size": ("INT", {"default": 8, "min": 1, "max": 32}),
            "learning_rate": ("FLOAT", {"default": 0.0001, "min": 0.000001, "max": 0.01, "step": 0.00001}),
            "nfe_weight": ("FLOAT", {"default": 0.03, "min": 0.0, "max": 10.0, "step": 0.001}),
            "exit_threshold": ("FLOAT", {"default": 0.5, "min": 0.0, "max": 1.0, "step": 0.01}),
            "seed": ("INT", {"default": 42, "min": 0, "max": 0x7FFFFFFFFFFFFFFF}),
            "checkpoint_every": ("INT", {"default": 25, "min": 1, "max": 10000}),
            "resume": ("BOOLEAN", {"default": True}),
            "diagnostic_only": ("BOOLEAN", {"default": False}),
            "diagnostic_exit_pattern": ("STRING", {"default": ""}),
        }}

    def _read_manifest(self, path: Path) -> tuple[list[_ManifestRow], list[_ManifestRow]]:
        records = []
        with path.open("r", encoding="utf-8") as handle:
            for line_number, line in enumerate(handle, 1):
                item: object = json.loads(line)
                if not isinstance(item, dict):
                    raise TypeError(f"manifest line {line_number} is not an object")
                split = item.get("split")
                if split not in {"train", "validation", "test"}:
                    raise ValueError(f"manifest line {line_number} has an invalid split")
                source_id = item.get("source_id")
                prompt = item.get("prompt")
                image_path = Path(str(item.get("first_frame", ""))).resolve(strict=True)
                if not isinstance(source_id, str) or not source_id or not isinstance(prompt, str) or not prompt.strip():
                    raise ValueError(f"manifest line {line_number} lacks source_id or prompt")
                expected_hash = item.get("first_frame_sha256")
                actual_hash = hashlib.sha256(image_path.read_bytes()).hexdigest()
                if expected_hash != actual_hash:
                    raise ValueError(f"manifest first-frame hash mismatch on line {line_number}")
                item["first_frame"] = str(image_path)
                records.append(cast(_ManifestRow, item))
        train = [row for row in records if row["split"] == "train"]
        validation = [row for row in records if row["split"] == "validation"]
        if not train or not validation:
            raise ValueError("router training needs nonempty train and validation splits")
        train_sources = {row["source_id"] for row in train}
        val_sources = {row["source_id"] for row in validation}
        test_sources = {row["source_id"] for row in records if row["split"] == "test"}
        if train_sources & val_sources or train_sources & test_sources or val_sources & test_sources:
            raise ValueError("train, validation and test source IDs must be disjoint")
        return train, validation

    @staticmethod
    def _read_first_frame(image_path: str) -> torch.Tensor:
        import numpy as np
        from PIL import Image

        with Image.open(image_path) as image:
            array = np.asarray(image.convert("RGB"), dtype=np.float32) / 255.0
        return torch.from_numpy(array).unsqueeze(0)

    @staticmethod
    def _conditioning(
        *, model: ModelPatcher, clip: CLIP, vae: VAE, profile: dict[str, object], row: _ManifestRow,
    ) -> tuple[object, dict[str, object]]:
        from comfy_extras.nodes_custom_sampler import Guider_Basic

        from .conditioning import ComfyStreamerH3ImageToVideo

        width = int(row.get("width", 512))
        height = int(row.get("height", 288))
        length = int(row.get("length", 362))
        first = ComfyStreamerH3ForcingBoosterTrainer._read_first_frame(row["first_frame"])
        value = ComfyStreamerH3ImageToVideo().execute(
            clip=clip, vae=vae, profile=profile, prompt=str(row["prompt"]),
            width=width, height=height, length=length, first_frame=first,
        )
        positive, latent = getattr(value, "args", value)
        guider = Guider_Basic(model)
        guider.set_conds(positive)
        return guider, latent

    @staticmethod
    def _reference_key(contract: Mapping[str, object], row: _ManifestRow, seed: int) -> str:
        fields = {
            "contract": contract,
            "source_id": row["source_id"],
            "prompt_sha256": hashlib.sha256(row["prompt"].encode("utf-8")).hexdigest(),
            "first_frame_sha256": row["first_frame_sha256"],
            "seed": int(seed),
            "width": int(row.get("width", 512)),
            "height": int(row.get("height", 288)),
            "length": int(row.get("length", 362)),
        }
        return hashlib.sha256(json.dumps(fields, sort_keys=True, separators=(",", ":")).encode()).hexdigest()

    def _teacher_target(
        self, *, benchmark_sampler: _ComfyStreamerH3BenchmarkSampler,
        sampler: KSAMPLER, model: ModelPatcher, sigmas: torch.Tensor, guider: object,
        latent: dict[str, object], seed: int, cache_dir: Path, key: str,
        capture_inputs: bool = False, capture_forward_inputs: bool = False,
    ) -> _TeacherTarget:
        from safetensors.torch import load_file, save_file

        target_path = cache_dir / f"{key}.safetensors"
        if target_path.is_file():
            targets = load_file(str(target_path), device="cpu")
            step_keys = [key for key in sorted(targets) if key.startswith("dense_step_")]
            sample_keys = [key for key in sorted(targets) if key.startswith("dense_input_")]
            if "dense_return_video" not in targets or len(step_keys) != len(sigmas) - 1:
                raise RuntimeError("cached teacher is missing dense return or per-step parity targets")
            input_path = target_path.with_suffix(".json")
            try:
                trace_metadata = json.loads(input_path.read_text(encoding="utf-8"))
            except (OSError, json.JSONDecodeError):
                trace_metadata = {}
            cache_has_requested_inputs = (
                not capture_inputs or len(sample_keys) == len(sigmas) - 1
            )
            cache_has_requested_forward_inputs = (
                not capture_forward_inputs
                or (
                    len(trace_metadata.get("model_input_fingerprints", [])) == len(sigmas) - 1
                    and len(trace_metadata.get("model_output_fingerprints", [])) == len(sigmas) - 1
                )
            )
            if cache_has_requested_inputs and cache_has_requested_forward_inputs:
                return (targets["x0"], targets["dense_return_video"],
                        [targets[key] for key in step_keys],
                        trace_metadata.get("input_fingerprints", {}),
                        [targets[key] for key in sample_keys],
                        trace_metadata.get("model_input_fingerprints", []),
                        trace_metadata.get("model_output_fingerprints", []))
        trace = _DenoisingTraceRecorder(
            directory=None, seed=int(seed), capture_inputs=capture_inputs,
            capture_forward_inputs=capture_forward_inputs,
        )
        with torch.no_grad(), _rollout_state_scope():
            dense_result = benchmark_sampler._run_sample(
                model, sampler, sigmas, guider, latent, seed, [0], trace_recorder=trace
            )
        if len(trace.steps) != len(sigmas) - 1:
            raise RuntimeError("teacher reference did not produce every resolved sigma stage")
        if capture_inputs and len(trace.samples) != len(trace.steps):
            raise RuntimeError("teacher trace did not capture every sampler input state")
        if capture_forward_inputs and len(trace.model_input_fingerprints) != len(trace.steps):
            raise RuntimeError("teacher trace did not capture every model forward input")
        if capture_forward_inputs and len(trace.model_output_fingerprints) != len(trace.steps):
            raise RuntimeError("teacher trace did not capture every model forward output")
        # The final callback is the dense teacher x0 in the same video-patch
        # coordinate system used by the router; the sampler return may pack
        # video and audio into a NestedTensor.
        final_x0 = trace.steps[-1].detach().to(
            device="cpu", dtype=torch.float16
        ).contiguous()
        dense_return_video = _video_clean_estimate(dense_result).detach().to(
            device="cpu", dtype=torch.float16
        ).contiguous()
        fd, temporary = tempfile.mkstemp(prefix=".teacher-", suffix=".safetensors", dir=cache_dir)
        os.close(fd)
        try:
            targets = {"x0": final_x0, "dense_return_video": dense_return_video}
            targets.update({
                f"dense_step_{index:02d}": step.detach().to(
                    device="cpu", dtype=torch.float16
                ).contiguous()
                for index, step in enumerate(trace.steps)
            })
            targets.update({
                f"dense_input_{index:02d}": sample.detach().to(
                    device="cpu", dtype=torch.float16
                ).contiguous()
                for index, sample in enumerate(trace.samples)
            })
            save_file(targets, temporary)
            os.replace(temporary, target_path)
            target_path.with_suffix(".json").write_text(
                json.dumps({
                    "input_fingerprints": trace.input_fingerprints,
                    "model_input_fingerprints": trace.model_input_fingerprints,
                    "model_output_fingerprints": trace.model_output_fingerprints,
                }, sort_keys=True, indent=2) + "\n",
                encoding="utf-8",
            )
        finally:
            Path(temporary).unlink(missing_ok=True)
        del dense_result
        return (final_x0, dense_return_video,
                [step.detach().to(device="cpu", dtype=torch.float16).contiguous()
                 for step in trace.steps],
                trace.input_fingerprints,
                [sample.detach().to(device="cpu", dtype=torch.float16).contiguous()
                 for sample in trace.samples],
                trace.model_input_fingerprints,
                trace.model_output_fingerprints)

    @staticmethod
    def _save_optimizer(
        output_dir: Path, head: _PatchExitRouter, optimizer: torch.optim.Optimizer, step: int, attempts: int, seed: int,
        runtime: Mapping[str, object], dataset_manifest_sha256: str, router_profile_id: str,
    ) -> None:
        state_path = output_dir / "trainer-state.pt"
        fd, temporary = tempfile.mkstemp(prefix=".trainer-state-", suffix=".pt", dir=output_dir)
        os.close(fd)
        try:
            torch.save({
                "head": {key: value.detach().cpu() for key, value in head.state_dict().items()},
                "optimizer": optimizer.state_dict(),
                "successful_updates": step,
                "attempts": attempts,
                "seed": int(seed),
                "runtime_contract": runtime,
                "dataset_manifest_sha256": dataset_manifest_sha256,
                "router_profile_id": router_profile_id,
            }, temporary)
            os.replace(temporary, state_path)
        finally:
            Path(temporary).unlink(missing_ok=True)

    def train(
        self, model: ModelPatcher, sampler: KSAMPLER, sigmas: torch.Tensor,
        clip: CLIP, vae: VAE, profile: dict[str, object], training_manifest: str,
        output_dir: str, router_profile_id: str = "trim-router-v1", max_updates: int = 500,
        updates_this_run: int = 1, batch_size: int = 8, learning_rate: float = 1e-4,
        nfe_weight: float = 0.03, exit_threshold: float = 0.5, seed: int = 42,
        checkpoint_every: int = 25, resume: bool = True, diagnostic_only: bool = False,
        diagnostic_exit_pattern: str = "",
    ) -> dict[str, object]:
        # The Comfy executor may wrap output nodes in inference_mode. The
        # frozen transformer remains no-grad, while the small router optimizer
        # must own ordinary versioned parameters and run with autograd enabled.
        with torch.inference_mode(False):
            return self._train(
                model, sampler, sigmas, clip, vae, profile, training_manifest,
                output_dir, router_profile_id, max_updates, updates_this_run,
                batch_size, learning_rate, nfe_weight, exit_threshold, seed,
                checkpoint_every, resume, diagnostic_only, diagnostic_exit_pattern,
            )

    def _train(
        self, model: ModelPatcher, sampler: KSAMPLER, sigmas: torch.Tensor,
        clip: CLIP, vae: VAE, profile: dict[str, object], training_manifest: str,
        output_dir: str, router_profile_id: str = "trim-router-v1", max_updates: int = 500,
        updates_this_run: int = 1, batch_size: int = 8, learning_rate: float = 1e-4,
        nfe_weight: float = 0.03, exit_threshold: float = 0.5, seed: int = 42,
        checkpoint_every: int = 25, resume: bool = True, diagnostic_only: bool = False,
        diagnostic_exit_pattern: str = "",
    ) -> dict[str, object]:
        if _sampler_name(sampler) != profile.get("sampler"):
            raise ValueError("ForcingBooster training sampler must match the loaded Trim profile")
        if profile.get("model_variant") != "base" or not str(profile.get("preset_id", "")).startswith(
                "fp4-mlp-fused-fasth3-trim-5step-"):
            raise ValueError("ForcingBooster training requires the exact ComfyStream Trim five-step base profile")
        sigmas = torch.as_tensor(sigmas)
        total_steps = int(sigmas.numel() - 1)
        if total_steps != 5:
            raise ValueError(f"Trim router training expects five denoising evaluations, got {total_steps}")
        if diagnostic_exit_pattern not in {"", "scattered", "contiguous", "late"}:
            raise ValueError("diagnostic_exit_pattern must be empty, scattered, contiguous, or late")
        if diagnostic_exit_pattern and not diagnostic_only:
            raise ValueError("prescribed exit patterns are available only in diagnostic mode")
        if type(batch_size) is not int or batch_size != 8:
            raise ValueError("the initial Trim router recipe uses effective batch size 8")
        if type(updates_this_run) is not int or not 1 <= updates_this_run <= 500:
            raise ValueError("updates_this_run must be in [1, 500]")
        if not 0.0 < float(exit_threshold) < 1.0:
            raise ValueError("exit_threshold must be in (0, 1)")
        if type(seed) is not int or seed < 0:
            raise ValueError("seed must be a non-negative integer")
        manifest_path = Path(training_manifest).expanduser().resolve(strict=True)
        output = Path(output_dir).expanduser().resolve()
        if (not isinstance(router_profile_id, str)
                or re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_.-]{0,63}", router_profile_id) is None):
            raise ValueError("router_profile_id must be a 1–64 character identifier")
        output.mkdir(parents=True, exist_ok=True)
        target_cache = output / "teacher-x0"
        target_cache.mkdir(parents=True, exist_ok=True)
        train_rows, validation_rows = self._read_manifest(manifest_path)
        manifest_digest = hashlib.sha256(manifest_path.read_bytes()).hexdigest()
        runtime = _runtime_contract(
            model=model, profile=profile, sigmas=sigmas, sampler_name=_sampler_name(sampler) or ""
        )
        hidden_dim = 2048
        import comfy.model_management

        device = comfy.model_management.get_torch_device()
        head = _PatchExitRouter(runtime["feature_dim"], hidden_dim=hidden_dim).to(device=device, dtype=torch.float32)
        optimizer = torch.optim.AdamW(
            head.parameters(), lr=float(learning_rate), betas=(0.9, 0.999), weight_decay=0.0,
        )
        successful_updates, attempts, resume_from = 0, 0, False
        trainer_state = output / "trainer-state.pt"
        if resume and not diagnostic_only and trainer_state.is_file():
            state = torch.load(trainer_state, map_location="cpu", weights_only=True)
            if (state.get("runtime_contract") != runtime
                    or state.get("dataset_manifest_sha256") != manifest_digest
                    or state.get("router_profile_id") != router_profile_id
                    or state.get("seed") != int(seed)):
                raise ValueError("router resume contract, profile or training manifest changed")
            if isinstance(state.get("head"), dict):
                head.load_state_dict(state["head"], strict=True)
            else:
                checkpoint_dir = output / "checkpoints" / f"update-{int(state['successful_updates']):06d}"
                checkpoint_head, _ = _load_router(
                    checkpoint_dir / "router.safetensors",
                    expected_input_dim=runtime["feature_dim"],
                    expected_contract=runtime,
                    device=device,
                )
                head.load_state_dict(checkpoint_head.state_dict())
            optimizer.load_state_dict(state["optimizer"])
            successful_updates = int(state["successful_updates"])
            attempts = int(state["attempts"])
            resume_from = True
        head.eval()
        model.get_model_object("diffusion_model").eval()
        samples_sampler = _ComfyStreamerH3BenchmarkSampler()
        rng = random.Random(int(seed) + successful_updates * 1_000_003)
        metric_path = output / "metrics.jsonl"
        output_manifest = {
            **runtime,
            "dataset_manifest_sha256": manifest_digest,
            "train_source_count": len({row["source_id"] for row in train_rows}),
            "validation_source_count": len({row["source_id"] for row in validation_rows}),
            "optimizer": "AdamW",
            "learning_rate": float(learning_rate),
            "betas": [0.9, 0.999],
            "weight_decay": 0.0,
            "nfe_weight": float(nfe_weight),
            "exit_threshold": float(exit_threshold),
            "effective_batch_size": int(batch_size),
            "decision_step_distribution": "uniform_1_to_K_minus_1",
            "train_loss_normalization": "mean_per_sample_active_patch_loss_then_mean_samples",
            "seed": int(seed),
            "router_profile_id": router_profile_id,
        }

        def record_sample(
            row: _ManifestRow, update_index: int, batch_index: int,
        ) -> _TrainingSample | None:
            source_seed = int(hashlib.sha256(row["source_id"].encode()).hexdigest()[:8], 16)
            sample_seed = int((seed + source_seed) % 2_147_483_647)
            cache_id = self._reference_key(runtime, row, sample_seed)
            teacher_guider, teacher_latent = self._conditioning(
                model=model, clip=clip, vae=vae, profile=profile, row=row
            )
            reference, _dense_return_video, _dense_steps, _teacher_inputs, _dense_samples, _teacher_model_inputs, _teacher_model_outputs = self._teacher_target(
                benchmark_sampler=samples_sampler, sampler=sampler,
                model=model, sigmas=sigmas,
                guider=teacher_guider, latent=teacher_latent, seed=sample_seed,
                cache_dir=target_cache, key=cache_id,
            )
            # Comfy's guider processes and mutates its conditioning dictionaries
            # during sample(). Rebuild them so the routed rollout starts from
            # the same unprocessed condition as the cached dense teacher.
            del teacher_guider, teacher_latent
            guider, latent = self._conditioning(
                model=model, clip=clip, vae=vae, profile=profile, row=row
            )
            selected_step = rng.randint(1, total_steps - 1)
            controller = _TokenFreezeController(
                total_steps=total_steps, compact_active_queries=True,
                freeze_granularity="token", seed_mode="activation",
                router_head=head, router_threshold=float(exit_threshold),
                router_capture_step=selected_step,
            )
            with torch.no_grad(), _rollout_state_scope():
                output_latent = samples_sampler._run_sample(
                    model, sampler, sigmas, guider, latent, sample_seed, [0],
                    freeze_controller=controller,
                )
            del output_latent
            record = controller.finish_router_training_record()
            if not record:
                return None
            token_ids = record["token_ids"].to(dtype=torch.long)
            if not token_ids.numel():
                return None
            teacher_rows = _video_tokens(reference).float()
            route_patch_count = int(record["exit_steps"].numel())
            target_mask = _route_target_patch_mask(
                token_ids, route_patch_count=route_patch_count,
                target_patch_count=int(teacher_rows.shape[0]),
            )
            geometry_mismatch = abs(route_patch_count - int(teacher_rows.shape[0]))
            token_ids = token_ids[target_mask]
            features = record["features"][target_mask]
            predictions = record["exit_prediction"][target_mask].float()
            if not token_ids.numel():
                return None
            errors = _patch_error_mse(predictions, teacher_rows.index_select(0, token_ids))
            exits = record["exit_steps"].index_select(0, token_ids)
            continuation = torch.maximum(
                exits, torch.full_like(exits, selected_step + 1)
            )
            return {
                "features": features,
                "source_id": row["source_id"],
                "exit_mse": errors,
                "continuation": continuation,
                "selected_step": selected_step,
                "total_patches": int(teacher_rows.shape[0]),
                "exit_counts": [int((record["exit_steps"] == stage).sum())
                                for stage in range(1, total_steps + 1)],
                "patch_steps": record["exit_steps"],
                "geometry_mismatch_patches": geometry_mismatch,
            }

        def validate_router(update_index: int) -> dict[str, object]:
            """Separate same-render callback/return error from routed parity error."""
            losses: list[float] = []
            routed_vs_dense_return: list[float] = []
            dense_callback_vs_return: list[float] = []
            routed_max_abs: list[float] = []
            dense_repeat_step_mse: list[list[float]] = []
            routed_step_mse: list[list[float]] = []
            dense_repeat_sample_mse: list[list[float]] = []
            routed_sample_mse: list[list[float]] = []
            input_fingerprints: list[dict[str, dict[str, str]]] = []
            model_input_fingerprints: list[dict[str, list[dict[str, str]]]] = []
            model_output_fingerprints: list[dict[str, list[str]]] = []
            exit_counts = [0] * total_steps
            geometry_mismatch_total = 0
            rows = validation_rows[: min(4, len(validation_rows))]
            for index, row in enumerate(rows):
                source_seed = int(hashlib.sha256(row["source_id"].encode()).hexdigest()[:8], 16)
                sample_seed = int((seed + 1_000_000_000 + source_seed + index) % 2_147_483_647)
                cache_id = self._reference_key(runtime, row, sample_seed)
                teacher_guider, teacher_latent = self._conditioning(
                    model=model, clip=clip, vae=vae, profile=profile, row=row
                )
                reference, dense_return, dense_steps, teacher_inputs, dense_samples, teacher_model_inputs, teacher_model_outputs = self._teacher_target(
                    benchmark_sampler=samples_sampler, sampler=sampler,
                    model=model, sigmas=sigmas,
                    guider=teacher_guider, latent=teacher_latent, seed=sample_seed,
                    cache_dir=target_cache, key=cache_id, capture_inputs=True,
                    capture_forward_inputs=True,
                )
                del teacher_guider, teacher_latent
                guider, latent = self._conditioning(
                    model=model, clip=clip, vae=vae, profile=profile, row=row
                )
                dense_repeat_trace = _DenoisingTraceRecorder(
                    directory=None, seed=sample_seed, capture_inputs=True,
                    capture_forward_inputs=True,
                )
                with torch.no_grad(), _rollout_state_scope():
                    dense_repeat = samples_sampler._run_sample(
                        model, sampler, sigmas, guider, latent, sample_seed, [0],
                        trace_recorder=dense_repeat_trace,
                    )
                del dense_repeat, guider, latent
                guider, latent = self._conditioning(
                    model=model, clip=clip, vae=vae, profile=profile, row=row
                )
                controller = _TokenFreezeController(
                    total_steps=total_steps, compact_active_queries=True,
                    freeze_granularity="token", seed_mode="activation",
                    router_head=head, router_threshold=float(exit_threshold),
                )
                routed_trace = _DenoisingTraceRecorder(
                    directory=None, seed=sample_seed, capture_inputs=True,
                    capture_forward_inputs=True,
                )
                with torch.no_grad(), _rollout_state_scope():
                    result = samples_sampler._run_sample(
                        model, sampler, sigmas, guider, latent, sample_seed, [0],
                        freeze_controller=controller, trace_recorder=routed_trace,
                    )
                routed = _video_tokens(_video_clean_estimate(result)).float()
                teacher = _video_tokens(reference).to(device=routed.device, dtype=torch.float32)
                dense_return_rows = _video_tokens(dense_return).to(
                    device=routed.device, dtype=torch.float32
                )
                routed_rows, teacher_rows, geometry_mismatch = _align_patch_row_prefix(
                    routed, teacher,
                )
                dense_return_aligned, teacher_again, return_geometry_mismatch = (
                    _align_patch_row_prefix(dense_return_rows, teacher)
                )
                if return_geometry_mismatch != geometry_mismatch or not torch.equal(
                    teacher_again, teacher_rows
                ):
                    raise RuntimeError("dense callback and sampler return latent geometries differ")
                geometry_mismatch_total += geometry_mismatch
                losses.append(float((routed_rows - teacher_rows).square().mean().detach().cpu()))
                routed_vs_dense_return.append(float(
                    (routed_rows - dense_return_aligned).square().mean().detach().cpu()
                ))
                dense_callback_vs_return.append(float(
                    (teacher_rows - dense_return_aligned).square().mean().detach().cpu()
                ))
                routed_max_abs.append(float(
                    (routed_rows - dense_return_aligned).abs().max().detach().cpu()
                ))
                if not (len(dense_steps) == len(dense_repeat_trace.steps) == len(routed_trace.steps)):
                    raise RuntimeError("dense and routed diagnostic traces have different step counts")
                if not (len(teacher_model_inputs) == len(dense_repeat_trace.model_input_fingerprints)
                        == len(routed_trace.model_input_fingerprints) == len(dense_steps)):
                    raise RuntimeError("denoiser input hook did not capture each sampler step")
                if not (len(teacher_model_outputs) == len(dense_repeat_trace.model_output_fingerprints)
                        == len(routed_trace.model_output_fingerprints) == len(dense_steps)):
                    raise RuntimeError("denoiser output hook did not capture each sampler step")
                dense_repeat_step_mse.append([
                    float((_video_tokens(repeat_step).float() - _video_tokens(reference_step).float())
                          .square().mean().detach().cpu())
                    for reference_step, repeat_step in zip(dense_steps, dense_repeat_trace.steps)
                ])
                routed_step_mse.append([
                    float((_video_tokens(route_step).float() - _video_tokens(reference_step).float())
                          .square().mean().detach().cpu())
                    for reference_step, route_step in zip(dense_steps, routed_trace.steps)
                ])
                if len(dense_samples) != len(dense_repeat_trace.samples) or len(dense_samples) != len(routed_trace.samples):
                    raise RuntimeError("diagnostic callbacks did not expose every sampler input state")
                dense_repeat_sample_mse.append([
                    float((_video_tokens(reference_sample).float() - _video_tokens(repeat_sample).float())
                          .square().mean().detach().cpu())
                    for reference_sample, repeat_sample in zip(dense_samples, dense_repeat_trace.samples)
                ])
                routed_sample_mse.append([
                    float((_video_tokens(reference_sample).float() - _video_tokens(route_sample).float())
                          .square().mean().detach().cpu())
                    for reference_sample, route_sample in zip(dense_samples, routed_trace.samples)
                ])
                input_fingerprints.append({
                    "teacher": teacher_inputs,
                    "dense_repeat": dense_repeat_trace.input_fingerprints,
                    "routed": routed_trace.input_fingerprints,
                })
                model_input_fingerprints.append({
                    "teacher": teacher_model_inputs,
                    "dense_repeat": dense_repeat_trace.model_input_fingerprints,
                    "routed": routed_trace.model_input_fingerprints,
                })
                model_output_fingerprints.append({
                    "teacher": teacher_model_outputs,
                    "dense_repeat": dense_repeat_trace.model_output_fingerprints,
                    "routed": routed_trace.model_output_fingerprints,
                })
                if controller.router_exit_steps is None:
                    raise RuntimeError("validation rollout did not record router exits")
                counts = torch.bincount(
                    controller.router_exit_steps.detach().to(device="cpu", dtype=torch.long),
                    minlength=total_steps + 1,
                )
                for step in range(1, total_steps + 1):
                    exit_counts[step - 1] += int(counts[step])
                del result, reference, dense_return, dense_steps, routed, teacher, dense_return_rows
                del controller, guider, latent
            return {
                "update": int(update_index),
                "source_ids": [row["source_id"] for row in rows],
                "final_latent_mse": sum(losses) / max(1, len(losses)),
                "routed_vs_dense_return_mse": sum(routed_vs_dense_return) / max(1, len(routed_vs_dense_return)),
                "dense_callback_vs_return_mse": sum(dense_callback_vs_return) / max(1, len(dense_callback_vs_return)),
                "routed_vs_dense_return_max_abs_error": max(routed_max_abs, default=0.0),
                "dense_repeat_step_mse": [
                    sum(values[step] for values in dense_repeat_step_mse) / max(1, len(dense_repeat_step_mse))
                    for step in range(total_steps)
                ],
                "routed_vs_dense_step_mse": [
                    sum(values[step] for values in routed_step_mse) / max(1, len(routed_step_mse))
                    for step in range(total_steps)
                ],
                "dense_repeat_sampler_input_step_mse": [
                    sum(values[step] for values in dense_repeat_sample_mse) / max(1, len(dense_repeat_sample_mse))
                    for step in range(total_steps)
                ],
                "routed_sampler_input_step_mse": [
                    sum(values[step] for values in routed_sample_mse) / max(1, len(routed_sample_mse))
                    for step in range(total_steps)
                ],
                "run_input_fingerprints": input_fingerprints,
                "model_input_fingerprints": model_input_fingerprints,
                "model_output_fingerprints": model_output_fingerprints,
                "model_inputs_match_teacher_by_step": [
                    {
                        "source_id": row["source_id"],
                        "dense_repeat": [
                            all(runs["dense_repeat"][step].get(name)
                                == runs["teacher"][step].get(name)
                                for name in runs["teacher"][step])
                            for step in range(total_steps)
                        ],
                        "routed": [
                            all(runs["routed"][step].get(name)
                                == runs["teacher"][step].get(name)
                                for name in runs["teacher"][step])
                            for step in range(total_steps)
                        ],
                    }
                    for row, runs in zip(rows, model_input_fingerprints, strict=True)
                ],
                "model_outputs_match_teacher_by_step": [
                    {
                        "source_id": row["source_id"],
                        "dense_repeat": [
                            runs["dense_repeat"][step] == runs["teacher"][step]
                            for step in range(total_steps)
                        ],
                        "routed": [
                            runs["routed"][step] == runs["teacher"][step]
                            for step in range(total_steps)
                        ],
                    }
                    for row, runs in zip(rows, model_output_fingerprints, strict=True)
                ],
                "first_routed_divergence_step": next((
                    step + 1 for step, mse in enumerate(
                        [sum(values[step] for values in routed_step_mse) / max(1, len(routed_step_mse))
                         for step in range(total_steps)]
                    ) if mse > 1e-8
                ), None),
                "exit_counts_by_step": exit_counts,
                "geometry_mismatch_patches": geometry_mismatch_total,
            }

        def validate_prescribed_exit_pattern(pattern: str) -> dict[str, object]:
            """Compare sparse routing to full-layout execution with the same clean caches."""
            rows = validation_rows[: min(4, len(validation_rows))]
            cases_to_run = [
                (index, row, replicate)
                for index, row in enumerate(rows)
                for replicate in range(2)
            ]
            cases: list[_ParityCase] = []
            for index, row, replicate in cases_to_run:
                source_seed = int(hashlib.sha256(row["source_id"].encode()).hexdigest()[:8], 16)
                sample_seed = int((
                    seed + 2_000_000_000 + source_seed + index + replicate * 1_000_003
                ) % 2_147_483_647)
                cache_id = self._reference_key(runtime, row, sample_seed)
                teacher_guider, teacher_latent = self._conditioning(
                    model=model, clip=clip, vae=vae, profile=profile, row=row
                )
                teacher, _, _, _, _, _, _ = self._teacher_target(
                    benchmark_sampler=samples_sampler, sampler=sampler, model=model,
                    sigmas=sigmas, guider=teacher_guider, latent=teacher_latent,
                    seed=sample_seed, cache_dir=target_cache, key=cache_id,
                )
                token_count = int(_video_tokens(teacher).shape[0])
                prescribed = _prescribed_exit_steps(
                    token_count, pattern, device=device,
                )
                del teacher_guider, teacher_latent, teacher

                def run_reference(
                    *, dense: bool, _row: _ManifestRow = row,
                    _prescribed: torch.Tensor = prescribed, _sample_seed: int = sample_seed,
                    _capture_block_trace: bool = (index == 0 and replicate == 0),
                ) -> tuple[
                    dict[str, object], torch.Tensor, torch.Tensor, _DenoisingTraceRecorder,
                    _TokenFreezeController, dict[int, dict[str, torch.Tensor]],
                    dict[int, dict[str, dict[str, torch.Tensor]]], dict[str, torch.Tensor],
                ]:
                    run_guider, run_latent = self._conditioning(
                        model=model, clip=clip, vae=vae, profile=profile, row=_row
                    )
                    controller = _TokenFreezeController(
                        total_steps=total_steps,
                        # In the dense reference every block ID remains in this
                        # compact-kernel list, preserving the full layout while
                        # matching the sparse runtime's native VSA dispatch.
                        compact_active_queries=True,
                        seed_mode="activation",
                        prescribed_exit_steps=_prescribed,
                        dense_reference=dense,
                    )
                    trace = _DenoisingTraceRecorder(
                        directory=None, seed=_sample_seed, capture_inputs=True,
                        capture_forward_inputs=True,
                    )
                    block_trace: dict[int, dict[str, torch.Tensor]] = {}
                    linear_trace: dict[int, dict[str, dict[str, torch.Tensor]]] = {}
                    qkv_trace: dict[str, torch.Tensor] = {}
                    if _capture_block_trace:
                        def capture_block_value(
                            trace_block_index: int, trace_part: str, value: torch.Tensor,
                        ) -> None:
                            if (controller.cache_count == 0 or controller.ready_count == 0
                                    or not isinstance(value, torch.Tensor)
                                    or value.ndim != 2
                                    or value.shape[0] != controller.sequence_length):
                                return
                            if trace_part in block_trace.get(trace_block_index, {}):
                                return
                            positions = None
                            if controller.active_rows is not None and controller.video_span is not None:
                                start, end = controller.video_span
                                positions = controller.active_rows[
                                    (controller.active_rows >= start)
                                    & (controller.active_rows < end)
                                ]
                            if positions is None or not positions.numel():
                                positions = torch.arange(
                                    min(32, value.shape[0]), device=value.device,
                                    dtype=torch.long,
                                )
                            if not positions.numel():
                                return
                            sample_count = min(32, positions.numel())
                            sample_ids = torch.linspace(
                                0, positions.numel() - 1, sample_count,
                                device=positions.device,
                            ).round().to(torch.long)
                            sampled_positions = positions.index_select(0, sample_ids)
                            sampled = value.index_select(0, sampled_positions).detach().to(
                                device="cpu", dtype=torch.float16, copy=True,
                            ).contiguous()
                            block_trace.setdefault(trace_block_index, {})[trace_part] = sampled

                        def capture_linear_value(
                            trace_block_index: int, trace_module_kind: str,
                            input_rows: torch.Tensor, output_rows: torch.Tensor,
                        ) -> None:
                            block_values = linear_trace.setdefault(trace_block_index, {})
                            if not input_rows.shape[0] or trace_module_kind in block_values:
                                return
                            sample_count = min(32, input_rows.shape[0])
                            sample_ids = torch.linspace(
                                0, input_rows.shape[0] - 1, sample_count,
                                device=input_rows.device,
                            ).round().to(torch.long)
                            block_values[trace_module_kind] = {
                                "input": input_rows.index_select(0, sample_ids).detach().to(
                                    device="cpu", dtype=torch.float16, copy=True,
                                ).contiguous(),
                                "output": output_rows.index_select(0, sample_ids).detach().to(
                                    device="cpu", dtype=torch.float16, copy=True,
                                ).contiguous(),
                            }

                        def capture_qkv_chunk(
                            trace_block_index: int, source_rows: torch.Tensor,
                            qkv_rows: torch.Tensor,
                        ) -> None:
                            if (trace_block_index != 1 or controller.cache_count == 0
                                    or controller.ready_count == 0 or qkv_trace
                                    or controller.video_span is None):
                                return
                            start, end = controller.video_span
                            positions = ((source_rows >= start) & (source_rows < end)).nonzero(
                                as_tuple=False
                            ).flatten()[:16]
                            if not positions.numel():
                                return
                            qkv_trace["source_rows"] = source_rows.index_select(
                                0, positions
                            ).detach().to(device="cpu", dtype=torch.long, copy=True)
                            qkv_trace["values"] = qkv_rows.index_select(
                                0, positions
                            ).detach().to(device="cpu", dtype=torch.float16, copy=True).contiguous()

                        controller.debug_block_trace = capture_block_value
                        controller.debug_linear_trace = capture_linear_value
                        controller.debug_qkv_trace = capture_qkv_chunk
                    with torch.no_grad(), _rollout_state_scope():
                        result = samples_sampler._run_sample(
                            model, sampler, sigmas, run_guider, run_latent,
                            _sample_seed, [0], freeze_controller=controller,
                            trace_recorder=trace,
                        )
                    final_rows = _video_tokens(_video_clean_estimate(result)).float()
                    committed_video = controller.committed_video
                    if committed_video is None:
                        raise RuntimeError("prescribed routing did not commit video latents")
                    committed_rows = _video_tokens(committed_video).float()
                    return (
                        result, final_rows, committed_rows, trace, controller,
                        block_trace, linear_trace, qkv_trace,
                    )

                (
                    dense_result, dense_final, dense_committed, dense_trace,
                    dense_controller, dense_block_trace, dense_linear_trace, dense_qkv_trace,
                ) = run_reference(dense=True)
                dense_report = dense_controller.report()
                dense_final = dense_final.detach().to(device="cpu", dtype=torch.float32)
                dense_committed = dense_committed.detach().to(device="cpu", dtype=torch.float32)
                dense_controller.debug_block_trace = None
                dense_controller.debug_linear_trace = None
                dense_controller.debug_qkv_trace = None
                del dense_result, dense_controller
                if torch.cuda.is_available():
                    torch.cuda.empty_cache()
                (
                    sparse_result, sparse_final, sparse_committed, sparse_trace,
                    sparse_controller, sparse_block_trace, sparse_linear_trace, sparse_qkv_trace,
                ) = run_reference(dense=False)
                if not (
                    len(dense_trace.steps) == len(sparse_trace.steps)
                    == len(dense_trace.samples) == len(sparse_trace.samples)
                    == len(dense_trace.model_input_fingerprints)
                    == len(sparse_trace.model_input_fingerprints)
                    == len(dense_trace.model_output_fingerprints)
                    == len(sparse_trace.model_output_fingerprints)
                    == total_steps
                ):
                    raise RuntimeError("prescribed-exit parity did not capture every Trim5 stage")
                if dense_final.shape != sparse_final.shape:
                    raise RuntimeError("dense and sparse parity outputs have different geometries")
                sparse_report = sparse_controller.report()
                sparse_final = sparse_final.detach().to(device="cpu", dtype=torch.float32)
                sparse_committed = sparse_committed.detach().to(device="cpu", dtype=torch.float32)
                sparse_controller.debug_block_trace = None
                sparse_controller.debug_linear_trace = None
                sparse_controller.debug_qkv_trace = None
                del sparse_result, sparse_controller
                if torch.cuda.is_available():
                    torch.cuda.empty_cache()
                exit_mask = prescribed.detach().to(device="cpu")
                committed_mask = exit_mask < total_steps
                if not torch.equal(
                    dense_final[committed_mask], dense_committed[committed_mask]
                ) or not torch.equal(
                    sparse_final[committed_mask], sparse_committed[committed_mask]
                ):
                    raise RuntimeError("a committed patch drifted in the final sampler output")

                stage_metrics: list[dict[str, int | float | bool]] = []
                for stage, (dense_step, sparse_step) in enumerate(
                    zip(dense_trace.steps, sparse_trace.steps, strict=True), start=1
                ):
                    dense_rows = _video_tokens(dense_step).float()
                    sparse_rows = _video_tokens(sparse_step).float()
                    live = exit_mask >= stage
                    difference = dense_rows[live] - sparse_rows[live]
                    dense_sample_rows = _video_tokens(dense_trace.samples[stage - 1]).float()
                    sparse_sample_rows = _video_tokens(sparse_trace.samples[stage - 1]).float()
                    input_live = exit_mask >= stage
                    input_difference = (
                        dense_sample_rows[input_live] - sparse_sample_rows[input_live]
                    )
                    stage_metrics.append({
                        "stage": stage,
                        "active_patch_count": int(live.sum().item()),
                        "active_mse": float(difference.square().mean().detach().cpu())
                        if difference.numel() else 0.0,
                        "active_max_abs": float(difference.abs().max().detach().cpu())
                        if difference.numel() else 0.0,
                        "sampler_input_active_mse": float(
                            input_difference.square().mean().detach().cpu()
                        ) if input_difference.numel() else 0.0,
                        "sampler_input_active_max_abs": float(
                            input_difference.abs().max().detach().cpu()
                        ) if input_difference.numel() else 0.0,
                        "denoiser_input_fingerprints_match": (
                            dense_trace.model_input_fingerprints[stage - 1]
                            == sparse_trace.model_input_fingerprints[stage - 1]
                        ),
                        "denoiser_output_fingerprints_match": (
                            dense_trace.model_output_fingerprints[stage - 1]
                            == sparse_trace.model_output_fingerprints[stage - 1]
                        ),
                    })
                block_metrics: list[_BlockMetric] = []
                if dense_block_trace or sparse_block_trace:
                    if dense_block_trace.keys() != sparse_block_trace.keys():
                        raise RuntimeError("dense and sparse block traces captured different layer sets")
                    for block_index in sorted(dense_block_trace):
                        components: dict[str, _ErrorMetric] = {}
                        for kind in ("input", "output"):
                            left = dense_block_trace[block_index].get(kind)
                            right = sparse_block_trace[block_index].get(kind)
                            if left is None or right is None or left.shape != right.shape:
                                raise RuntimeError("dense and sparse block trace tensors are incompatible")
                            finite = torch.isfinite(left) & torch.isfinite(right)
                            finite_count = int(finite.sum().item())
                            nonfinite_count = int(finite.numel() - finite_count)
                            if finite_count:
                                delta = left.float()[finite] - right.float()[finite]
                                mse: float | None = float(delta.square().mean().cpu())
                                max_abs: float | None = float(delta.abs().max().cpu())
                                if not torch.isfinite(torch.tensor(mse)):
                                    mse = None
                                if not torch.isfinite(torch.tensor(max_abs)):
                                    max_abs = None
                            else:
                                mse, max_abs = None, None
                            components[kind] = {
                                "mse": mse,
                                "max_abs": max_abs,
                                "finite_sample_count": finite_count,
                                "nonfinite_sample_count": nonfinite_count,
                            }
                        block_metrics.append({
                            "block": block_index, "input": components["input"],
                            "output": components["output"],
                        })
                if index == 0 and replicate == 0 and not block_metrics:
                    raise RuntimeError("stage-3 transformer block trace captured no layers")
                qkv_metrics: dict[str, object] = {}
                if dense_qkv_trace or sparse_qkv_trace:
                    if dense_qkv_trace.keys() != sparse_qkv_trace.keys():
                        raise RuntimeError("dense and sparse QKV traces captured different fields")
                    if not torch.equal(
                        dense_qkv_trace["source_rows"], sparse_qkv_trace["source_rows"]
                    ):
                        qkv_metrics["source_rows_match"] = False
                    else:
                        qkv_metrics["source_rows_match"] = True
                    left = dense_qkv_trace["values"]
                    right = sparse_qkv_trace["values"]
                    if left.shape != right.shape:
                        raise RuntimeError("dense and sparse QKV sample shapes differ")
                    finite = torch.isfinite(left) & torch.isfinite(right)
                    finite_count = int(finite.sum().item())
                    difference_qkv = left.float()[finite] - right.float()[finite]
                    qkv_metrics.update(
                        qkv_sample_mse=float(difference_qkv.square().mean())
                        if finite_count else None,
                        qkv_sample_max_abs=float(difference_qkv.abs().max())
                        if finite_count else None,
                        finite_sample_count=finite_count,
                        nonfinite_sample_count=int(finite.numel() - finite_count),
                    )
                if index == 0 and replicate == 0 and not qkv_metrics:
                    raise RuntimeError("stage-3 block-1 QKV trace captured no rows")
                linear_metrics: dict[str, dict[str, dict[str, _ErrorMetric]]] = {}
                if dense_linear_trace or sparse_linear_trace:
                    if dense_linear_trace.keys() != sparse_linear_trace.keys():
                        raise RuntimeError("dense and sparse linear traces captured different modules")
                    for block_index in sorted(dense_linear_trace):
                        if dense_linear_trace[block_index].keys() != sparse_linear_trace[block_index].keys():
                            raise RuntimeError("dense and sparse linear traces captured different modules")
                        block_components: dict[str, dict[str, _ErrorMetric]] = {}
                        for kind in sorted(dense_linear_trace[block_index]):
                            components = {}
                            for part in ("input", "output"):
                                left = dense_linear_trace[block_index][kind][part]
                                right = sparse_linear_trace[block_index][kind][part]
                                if left.shape != right.shape:
                                    raise RuntimeError("dense and sparse linear trace shapes differ")
                                finite = torch.isfinite(left) & torch.isfinite(right)
                                finite_count = int(finite.sum().item())
                                delta = left.float()[finite] - right.float()[finite]
                                mse = float(delta.square().mean()) if finite_count else None
                                max_abs = float(delta.abs().max()) if finite_count else None
                                components[part] = {
                                    "mse": mse if mse is None or torch.isfinite(torch.tensor(mse)) else None,
                                    "max_abs": max_abs if max_abs is None or torch.isfinite(torch.tensor(max_abs)) else None,
                                    "finite_sample_count": finite_count,
                                    "nonfinite_sample_count": int(finite.numel() - finite_count),
                                }
                            block_components[kind] = components
                        linear_metrics[str(block_index)] = block_components

                def output_diverged(metrics: dict[str, _ErrorMetric]) -> bool:
                    output = metrics["output"]
                    mse = output["mse"]
                    return output["nonfinite_sample_count"] > 0 or (
                        isinstance(mse, (int, float)) and mse > 1e-8
                    )

                difference = dense_final - sparse_final
                cases.append({
                    "source_id": row["source_id"],
                    "seed": sample_seed,
                    "exit_counts_by_step": [
                        int((exit_mask == stage).sum().item())
                        for stage in range(1, total_steps + 1)
                    ],
                    "first_last_patch_exit_steps": [
                        int(exit_mask[0].item()), int(exit_mask[-1].item()),
                    ],
                    "stage_metrics": stage_metrics,
                    "stage3_sampled_block_metrics": block_metrics,
                    "stage3_linear_metrics_by_block": linear_metrics,
                    "stage3_block1_qkv_metrics": qkv_metrics,
                    "first_divergent_linear": next((
                        {"block": int(block_index), "module": module_kind}
                        for block_index in sorted(linear_metrics, key=int)
                        for module_kind, metrics in linear_metrics[block_index].items()
                        if output_diverged(metrics)
                    ), None),
                    "first_divergent_block_output": next((
                        item["block"] for item in block_metrics
                        if item["output"]["nonfinite_sample_count"] > 0
                        or (item["output"]["mse"] is not None
                            and item["output"]["mse"] > 1e-8)
                    ), None),
                    "committed_coordinates_exact": True,
                    "final_latent_mse": float(difference.square().mean().detach().cpu()),
                    "final_max_abs": float(difference.abs().max().detach().cpu()),
                    "dense_reference_report": dense_report,
                    "sparse_report": sparse_report,
                })
                del dense_final, sparse_final
                del dense_committed, sparse_committed, dense_trace, sparse_trace
                del dense_block_trace, sparse_block_trace
                del dense_linear_trace, sparse_linear_trace
                del dense_qkv_trace, sparse_qkv_trace
            return {
                "mode": "prescribed_mixed_exit_dense_reference",
                "pattern": pattern,
                "reference_semantics": "full packed VSA queries and full MLP/output projections; cached clean hidden states and K/V retained",
                "source_ids": [row["source_id"] for row in rows],
                "seeds_per_source": 2,
                "cases": cases,
                "passed": all(
                    all(metric["active_mse"] <= 1e-6 and metric["active_max_abs"] <= 1e-2
                        for metric in case["stage_metrics"])
                    and case["committed_coordinates_exact"]
                    and case["final_latent_mse"] <= 1e-6
                    and case["final_max_abs"] <= 1e-2
                    for case in cases
                ),
            }

        (output / "checksums.json").write_text(json.dumps({
            "runtime_contract": runtime,
            "runtime_contract_sha256": hashlib.sha256(
                json.dumps(runtime, sort_keys=True, separators=(",", ":")).encode()
            ).hexdigest(),
            "dataset_manifest_sha256": manifest_digest,
        }, sort_keys=True, indent=2) + "\n", encoding="utf-8")
        started = time.perf_counter()
        report = {
            "status": "running",
            "max_updates": int(max_updates),
            "successful_updates": successful_updates,
            "attempts": attempts,
            "resume": resume_from,
            "train_sources": len({row["source_id"] for row in train_rows}),
            "validation_sources": len({row["source_id"] for row in validation_rows}),
            "train_sources_has_first_frame": all(bool(row.get("first_frame")) for row in train_rows),
        }
        if diagnostic_only:
            validation_report = (
                validate_prescribed_exit_pattern(diagnostic_exit_pattern)
                if diagnostic_exit_pattern else validate_router(successful_updates)
            )
            diagnostic_name = (
                f"parity-mixed-exit-{diagnostic_exit_pattern}.json"
                if diagnostic_exit_pattern else "parity-diagnostic.json"
            )
            diagnostic_path = output / diagnostic_name
            diagnostic_path.write_text(
                json.dumps(validation_report, allow_nan=False, sort_keys=True, indent=2) + "\n",
                encoding="utf-8",
            )
            report.update(
                status="diagnostic_complete",
                successful_updates=successful_updates,
                attempts=attempts,
                elapsed_sec=float(time.perf_counter() - started),
                diagnostic_path=str(diagnostic_path),
                validation=validation_report,
            )
            report["router_profile_id"] = router_profile_id
            return ({"ui": {"text": [json.dumps(report, sort_keys=True)]},
                     "result": (json.dumps(report),)})
        call_target = min(int(max_updates), successful_updates + int(updates_this_run))
        with metric_path.open("a", encoding="utf-8") as metrics:
            while successful_updates < call_target:
                attempts += 1
                if torch.cuda.is_available():
                    torch.cuda.reset_peak_memory_stats(device)
                rows = [train_rows[rng.randrange(len(train_rows))] for _ in range(batch_size)]
                records = [
                    value for batch_index, row in enumerate(rows)
                    if (value := record_sample(row, successful_updates, batch_index)) is not None
                ]
                if records:
                    optimizer.zero_grad(set_to_none=True)
                    with torch.enable_grad():
                        sample_losses, sample_metrics = [], []
                        for record in records:
                            features = record["features"].to(device=device, dtype=torch.float32)
                            if not bool(torch.isfinite(features).all()):
                                raise FloatingPointError(
                                    f"non-finite last-block router features for {record['source_id']}"
                                )
                            logits = head(features)
                            sample_loss, values = _router_objective(
                                logits, record["exit_mse"], record["continuation"],
                                selected_step=record["selected_step"],
                                total_patches=record["total_patches"],
                                nfe_weight=float(nfe_weight),
                            )
                            sample_losses.append(sample_loss)
                            sample_metrics.append(values)
                        # Mean one active-patch mean per example. Empty examples
                        # contribute zero to the fixed effective-batch divisor.
                        loss = torch.stack(sample_losses).sum() / batch_size
                        if not bool(torch.isfinite(loss)):
                            raise FloatingPointError("non-finite ForcingBooster training loss")
                        loss.backward()
                    torch.nn.utils.clip_grad_norm_(head.parameters(), 1.0)
                    optimizer.step()
                    successful_updates += 1
                    mean_metrics = {
                        key: float(torch.stack(
                            [values[key].float().cpu() for values in sample_metrics]
                        ).mean())
                        for key in ("router_mse", "router_nfe", "router_exit_prob")
                    }

                    row_metrics = {
                        "update": successful_updates,
                        "attempt": attempts,
                        "loss": float(loss.detach().cpu()),
                        **mean_metrics,
                        "nonempty_samples": len(records),
                        "geometry_mismatch_patches": sum(
                            int(record["geometry_mismatch_patches"]) for record in records
                        ),
                        "decision_steps": [int(r["selected_step"]) for r in records],
                        "accepted_per_step": [sum(r["exit_counts"][step] for r in records)
                                              for step in range(total_steps)],
                        "elapsed_sec": float(time.perf_counter() - started),
                        "peak_allocated_bytes": int(torch.cuda.max_memory_allocated(device)),
                        "peak_reserved_bytes": int(torch.cuda.max_memory_reserved(device)),
                    }
                    metrics.write(json.dumps(row_metrics, allow_nan=False) + "\n")
                    metrics.flush()
                    if successful_updates % 5 == 0:
                        print("[forcingbooster-train] " + json.dumps(row_metrics, sort_keys=True), flush=True)
                    should_checkpoint = successful_updates % int(checkpoint_every) == 0
                    if should_checkpoint or successful_updates == int(max_updates):
                        checkpoint_dir = output / "checkpoints" / f"update-{successful_updates:06d}"
                        checkpoint_manifest = {
                            **output_manifest,
                            "successful_updates": successful_updates,
                            "attempts": attempts,
                            "source_model_manifest": profile["model_manifest"],
                        }
                        _atomic_save_router(head, checkpoint_dir, checkpoint_manifest)
                        router_profile_dir = output / "router_profiles" / router_profile_id
                        _atomic_save_router(head, router_profile_dir, checkpoint_manifest)
                        import folder_paths

                        model_profile_dir = (
                            Path(folder_paths.models_dir) / "forcingbooster" / router_profile_id
                        )
                        _atomic_save_router(head, model_profile_dir, checkpoint_manifest)
                        export_dir = Path(folder_paths.get_output_directory()) / "forcingbooster" / router_profile_id
                        export_dir.mkdir(parents=True, exist_ok=True)
                        for filename in ("router.safetensors", "router.json"):
                            temp_export = export_dir / f".{filename}.tmp"
                            shutil.copyfile(model_profile_dir / filename, temp_export)
                            os.replace(temp_export, export_dir / filename)
                        validation = None
                        if should_checkpoint or successful_updates == int(max_updates):
                            validation = validate_router(successful_updates)
                            with (output / "validation.jsonl").open("a", encoding="utf-8") as stream:
                                stream.write(json.dumps(validation, allow_nan=False, sort_keys=True) + "\n")
                        latest = {
                            "successful_updates": successful_updates,
                            "attempts": attempts,
                            "checkpoint_dir": str(checkpoint_dir),
                            "checkpoint_manifest_sha256": hashlib.sha256(
                                json.dumps(checkpoint_manifest, sort_keys=True, separators=(",", ":")).encode()
                            ).hexdigest(),
                        }
                        if validation is not None:
                            latest["validation_final_latent_mse"] = validation["final_latent_mse"]
                        temp = output / ".latest.json.tmp"
                        temp.write_text(json.dumps(latest, sort_keys=True, indent=2) + "\n", encoding="utf-8")
                        os.replace(temp, output / "latest.json")
                if attempts >= (successful_updates + 1) * 2 and successful_updates < call_target:
                    raise RuntimeError(
                        f"router training reached {successful_updates} updates after {attempts} attempts"
                    )
        self._save_optimizer(
            output, head, optimizer, successful_updates, attempts, seed, runtime,
            manifest_digest, router_profile_id,
        )
        import folder_paths

        latest_file = output / "latest.json"
        latest = json.loads(latest_file.read_text(encoding="utf-8")) if latest_file.is_file() else {}
        model_profile_dir = Path(folder_paths.models_dir) / "forcingbooster" / router_profile_id
        report.update(status="complete" if successful_updates >= int(max_updates) else "partial",
                      successful_updates=successful_updates,
                      attempts=attempts, elapsed_sec=float(time.perf_counter() - started),
                      final_checkpoint=latest.get("checkpoint_dir"),
                      router_profile_path=str(model_profile_dir) if (model_profile_dir / "router.safetensors").is_file() else None)
        report["router_profile_id"] = router_profile_id
        return ({"ui": {"text": [json.dumps(report, sort_keys=True)]}, "result": (json.dumps(report),)})


NODE_CLASS_MAPPINGS = {"ComfyStreamerH3ForcingBoosterTrainer": ComfyStreamerH3ForcingBoosterTrainer}
NODE_DISPLAY_NAME_MAPPINGS = {"ComfyStreamerH3ForcingBoosterTrainer": "FastH3 ForcingBooster Router Trainer"}
