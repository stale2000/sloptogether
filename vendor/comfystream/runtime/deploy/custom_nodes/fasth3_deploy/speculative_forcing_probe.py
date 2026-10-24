"""Opt-in clean-latent trace capture and offline Speculative Forcing probe."""

from __future__ import annotations

import hashlib
import json
import uuid
from collections.abc import Iterator, Sequence
from contextlib import contextmanager
from pathlib import Path

import torch

TRACE_FORMAT = "comfystream/speculative-forcing-trace/1"


class DenoisingTraceRecorder:
    """Capture the sampler's clean video estimate at each denoising step."""

    def __init__(
        self, directory: Path | None, seed: int, *, capture_inputs: bool = False,
        capture_forward_inputs: bool = False,
    ) -> None:
        if directory is not None:
            if directory.exists() and not directory.is_dir():
                raise ValueError("speculative trace path must be a directory")
            directory.mkdir(parents=True, exist_ok=True)
        self.path = directory / f"trace-{uuid.uuid4().hex}.pt" if directory else None
        self.seed = seed
        self.capture_inputs = bool(capture_inputs)
        self.capture_forward_inputs = bool(capture_forward_inputs)
        self.steps: list[torch.Tensor] = []
        self.samples: list[torch.Tensor] = []
        self.input_fingerprints: dict[str, str] = {}
        self.model_input_fingerprints: list[dict[str, str]] = []
        self.model_output_fingerprints: list[str] = []

    @staticmethod
    def _fingerprint(value: object) -> str:
        digest = hashlib.sha256()

        def visit(item: object) -> None:
            if isinstance(item, torch.Tensor):
                tensor = item.detach().to(device="cpu").contiguous()
                digest.update(b"tensor\0")
                digest.update(str((tuple(tensor.shape), str(tensor.dtype))).encode())
                digest.update(tensor.reshape(-1).view(torch.uint8).numpy().tobytes())
            elif isinstance(item, dict):
                digest.update(b"dict\0")
                for key in sorted(item, key=str):
                    visit(str(key))
                    visit(item[key])
            elif isinstance(item, (tuple, list)):
                digest.update(type(item).__name__.encode() + b"\0")
                for child in item:
                    visit(child)
            elif hasattr(item, "tensors") and isinstance(item.tensors, (tuple, list)):
                visit(item.tensors)
            elif item is None or isinstance(item, (bool, int, float, str)):
                digest.update(json.dumps(item, sort_keys=True).encode() + b"\0")
            else:
                digest.update(type(item).__qualname__.encode() + b"\0")

        visit(value)
        return digest.hexdigest()

    def record_inputs(self, *, noise: object, latent: object, conditioning: object) -> None:
        if not self.capture_inputs:
            return
        self.input_fingerprints = {
            "noise_sha256": self._fingerprint(noise),
            "initial_latent_sha256": self._fingerprint(latent),
            "conditioning_sha256": self._fingerprint(conditioning),
        }

    def record_model_input(
        self, x: object, timestep: object, context: object, transformer_options: object = None,
        minimax_payload: object = None, denoise_mask: object = None,
        audio_denoise_mask: object = None,
    ) -> None:
        if not self.capture_forward_inputs:
            return
        values = {
            "x": x,
            "timestep": timestep,
            "context": context,
            "transformer_options": transformer_options,
            "minimax_payload": minimax_payload,
            "denoise_mask": denoise_mask,
            "audio_denoise_mask": audio_denoise_mask,
        }
        self.model_input_fingerprints.append({
            f"{name}_sha256": self._fingerprint(value)
            for name, value in values.items()
        })

    @contextmanager
    def capture_model_inputs(self, model_patcher: object) -> Iterator[None]:
        """Fingerprint actual denoiser inputs after Comfy has processed conditions."""
        if not self.capture_forward_inputs:
            yield
            return
        get_model_object = getattr(model_patcher, "get_model_object", None)
        if not callable(get_model_object):
            raise TypeError("model-input diagnostics require a Comfy ModelPatcher")
        diffusion = get_model_object("diffusion_model")
        register_hook = getattr(diffusion, "register_forward_pre_hook", None)
        if not callable(register_hook):
            raise TypeError("diffusion model does not support forward pre-hooks")

        def record(_module: object, args: tuple[object, ...], kwargs: dict[str, object]) -> None:
            self.record_model_input(
                args[0] if args else kwargs.get("x"),
                args[1] if len(args) > 1 else kwargs.get("timestep"),
                args[2] if len(args) > 2 else kwargs.get("context"),
                kwargs.get("transformer_options"),
                kwargs.get("minimax_payload"),
                kwargs.get("denoise_mask"),
                kwargs.get("audio_denoise_mask"),
            )

        handle = register_hook(record, with_kwargs=True)
        try:
            output_handle = diffusion.register_forward_hook(
                lambda _module, _args, output: self.model_output_fingerprints.append(
                    self._fingerprint(output)
                )
            )
            try:
                yield
            finally:
                output_handle.remove()
        finally:
            handle.remove()

    def __call__(
        self, step: int, denoised_video: torch.Tensor,
        sample_video: torch.Tensor | None = None,
    ) -> None:
        if step != len(self.steps):
            raise ValueError("speculative trace steps must be recorded in order")
        self.steps.append(denoised_video.detach().to(device="cpu").contiguous().clone())
        if self.capture_inputs and sample_video is not None:
            self.samples.append(sample_video.detach().to(device="cpu").contiguous().clone())

    def finish(self) -> Path | None:
        if len(self.steps) < 2:
            raise ValueError("speculative trace requires at least two denoising steps")
        if self.path is not None:
            torch.save(
                {"format": TRACE_FORMAT, "seed": self.seed, "video_steps": self.steps}, self.path
            )
        return self.path


def video_clean_estimate(value: object) -> torch.Tensor:
    """Return the video x0 tensor from Comfy's tensor and H3 latent wrappers."""
    if isinstance(value, dict) and "samples" in value:
        value = value["samples"]
    if isinstance(value, torch.Tensor) and value.ndim == 5:
        return value
    parts = getattr(value, "tensors", None)
    if isinstance(parts, (tuple, list)):
        value = parts
    if isinstance(value, (tuple, list)) and value:
        video = value[0]
        if isinstance(video, torch.Tensor) and video.ndim == 5:
            return video
    raise TypeError("Comfy sampler callback did not provide a video latent shaped [B,C,T,H,W]")


def _token_vectors(latent: torch.Tensor, channel_dim: int) -> torch.Tensor:
    if latent.ndim < 2:
        raise ValueError("latent tensor must have a channel dimension and token dimensions")
    channel_axis = channel_dim % latent.ndim
    if channel_axis == 0:
        raise ValueError("channel_dim cannot select the batch dimension")
    return latent.movedim(channel_axis, -1).reshape(-1, latent.shape[channel_axis]).float()


def _patch_token_vectors(latent: torch.Tensor) -> torch.Tensor:
    """Match the freeze controller's 2x2 latent-patch tokenization."""
    if latent.ndim != 5 or latent.shape[0] != 1:
        raise ValueError("H3 patch tokens require [1,C,T,H,W] video latents")
    batch, channels, frames, height, width = latent.shape
    if height % 2 or width % 2:
        raise ValueError("H3 patch tokens require even latent height and width")
    return (
        latent.reshape(batch, channels, frames, height // 2, 2, width // 2, 2)
        .permute(0, 2, 3, 5, 1, 4, 6)
        .reshape(-1, channels * 4)
        .float()
    )


def _acceptance_policy(
    scores: Sequence[torch.Tensor], oracle_gaps: Sequence[torch.Tensor],
    *, token_count: int, step_count: int, epsilon: float, thresholds: Sequence[float],
) -> list[dict[str, float]]:
    policies = []
    for threshold in thresholds:
        committed = torch.full((token_count,), step_count, dtype=torch.int64)
        for step_index, score in enumerate(scores, start=2):
            accepted = (committed == step_count) & (score <= threshold)
            committed[accepted] = step_index
        selected = committed < step_count
        false_accepts = torch.zeros_like(selected)
        for step_index, gap in enumerate(oracle_gaps[1:], start=2):
            at_step = committed == step_index
            false_accepts |= at_step & (gap > epsilon)
        accepted_count = int(selected.sum().item())
        # The local H3 adaptation builds reusable per-layer states on the next
        # forward, so an acceptance at k saves work only after k+1.
        effective_steps = committed.clone()
        effective_steps[selected] = (effective_steps[selected] + 1).clamp_max(step_count)
        policies.append({
            "threshold": float(threshold),
            "accepted_fraction": float(selected.float().mean().item()),
            "false_accept_fraction_of_accepted": (
                float(false_accepts[selected].float().mean().item()) if accepted_count else 0.0
            ),
            "mean_steps_per_token": float(committed.float().mean().item()),
            "mean_effective_steps_with_cache_seed": float(effective_steps.float().mean().item()),
        })
    return policies


def analyze_trace(
    video_steps: Sequence[torch.Tensor],
    *,
    epsilon: float = 0.24,
    thresholds: Sequence[float] = (0.05, 0.10, 0.15, 0.20, 0.24, 0.30, 0.40),
    paper_thresholds: Sequence[float] = (0.1, 0.2, 0.327, 0.5, 1.0, 2.0, 4.0, 6.0),
    channel_dim: int = 1,
    patch_size: int = 1,
) -> dict[str, object]:
    """Score stability-based early acceptance against the full-step oracle.

    Input tensors use ``[batch, channels, ...token dimensions]``. The final
    denoising output is the oracle only for measurement; it is never used to
    make the simulated acceptance decision.
    """
    if len(video_steps) < 2:
        raise ValueError("trace must contain at least two denoising steps")
    if not torch.isfinite(torch.tensor(epsilon)) or epsilon <= 0:
        raise ValueError("epsilon must be positive and finite")
    if not thresholds or any(not torch.isfinite(torch.tensor(t)) or t < 0 for t in thresholds):
        raise ValueError("thresholds must be a non-empty sequence of finite non-negative values")
    if not paper_thresholds or any(
            not torch.isfinite(torch.tensor(t)) or t < 0 for t in paper_thresholds):
        raise ValueError("paper_thresholds must be a non-empty sequence of finite non-negative values")
    if patch_size not in (1, 2):
        raise ValueError("patch_size must be one or two")

    vectorizer = _patch_token_vectors if patch_size == 2 else lambda step: _token_vectors(step, channel_dim)
    vectors = [vectorizer(step.detach().cpu()) for step in video_steps]
    if any(step.shape != vectors[0].shape for step in vectors[1:]):
        raise ValueError("all denoising snapshots must have the same latent shape")
    final = vectors[-1]
    scale = final.norm(dim=-1).median().clamp_min(1e-12)
    oracle_gaps = [((step - final).norm(dim=-1) / scale) for step in vectors[:-1]]
    stability_raw = [
        (vectors[i] - vectors[i - 1]).norm(dim=-1)
        for i in range(1, len(vectors) - 1)
    ]
    stability = [score / scale for score in stability_raw]
    latent = video_steps[0]
    if latent.ndim != 5:
        raise ValueError("spatiotemporal smoothing requires [B,C,T,H,W] video latents")
    grid = (
        int(latent.shape[2]),
        int(latent.shape[3]) // patch_size,
        int(latent.shape[4]) // patch_size,
    )
    try:
        from .speculative_forcing_freeze import smooth_stability_scores
    except ImportError:  # Standalone probe CLI and contract-test import.
        from speculative_forcing_freeze import (  # type: ignore[import-not-found, no-redef]
            smooth_stability_scores,
        )

    paper_stability = [smooth_stability_scores(score, grid) for score in stability_raw]
    by_threshold = _acceptance_policy(
        stability, oracle_gaps, token_count=final.shape[0], step_count=len(vectors),
        epsilon=epsilon, thresholds=thresholds,
    )
    paper_by_threshold = _acceptance_policy(
        paper_stability, oracle_gaps, token_count=final.shape[0], step_count=len(vectors),
        epsilon=epsilon, thresholds=paper_thresholds,
    )

    step_metrics = []
    for index, gap in enumerate(oracle_gaps):
        item: dict[str, object] = {
            "step": index + 1,
            "oracle_converged_fraction": float((gap <= epsilon).float().mean().item()),
            "oracle_gap_p50": float(gap.median().item()),
            "oracle_gap_p90": float(torch.quantile(gap, 0.90).item()),
        }
        if index > 0:
            score = stability[index - 1]
            item["stability_gap_p50"] = float(score.median().item())
            item["stability_gap_p90"] = float(torch.quantile(score, 0.90).item())
            paper_score = paper_stability[index - 1]
            item["paper_stability_gap_p50"] = float(paper_score.median().item())
            item["paper_stability_gap_p90"] = float(torch.quantile(paper_score, 0.90).item())
        step_metrics.append(item)

    return {
        "format": "comfystream/speculative-forcing-analysis/1",
        "steps": len(vectors),
        "tokens": int(final.shape[0]),
        "epsilon": float(epsilon),
        "normalizer_median_final_token_norm": float(scale.item()),
        "per_step": step_metrics,
        "stability_policy": by_threshold,
        "paper_smoothed_stability_policy": paper_by_threshold,
        "tokenization": "h3-2x2-latent-patches" if patch_size == 2 else "latent-pixels",
        "note": "Step 1 has no stability score; these results test the convergence signal, not autoregressive KV-cache compatibility.",
    }


def load_trace(path: Path) -> dict[str, object]:
    """Load a probe trace without allowing arbitrary pickle objects."""
    value = torch.load(path, map_location="cpu", weights_only=True)
    if not isinstance(value, dict) or value.get("format") != TRACE_FORMAT:
        raise ValueError("unsupported speculative forcing trace format")
    steps = value.get("video_steps")
    if not isinstance(steps, list) or not all(isinstance(step, torch.Tensor) for step in steps):
        raise ValueError("trace video_steps must be a list of tensors")
    return value
