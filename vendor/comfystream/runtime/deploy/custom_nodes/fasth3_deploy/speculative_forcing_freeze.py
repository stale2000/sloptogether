"""Training-free, opt-in token freezing for the MiniMax-H3 Trim sampler.

This is a Comfy/FastH3 adaptation, not the paper's autoregressive KV-cache
implementation. It freezes accepted video latent patches, reuses their clean
per-block hidden states, and skips their MLP and attention output projections.
The VSA kernel still receives the full packed sequence so frozen tokens remain
available as context.
"""
from __future__ import annotations

from collections.abc import Callable, Iterator
from contextlib import contextmanager
from contextvars import ContextVar
from math import prod
from typing import Protocol, cast

import torch
import torch.nn.functional as F

try:
    from .freeze_rows import (
        copy_rows_,
        gather_cached_active_rows,
        gather_cached_kv_active_qkv,
        scatter_active_rows,
        scatter_selected_rows_,
    )
except ImportError:  # Standalone benchmark and contract-test imports.
    from freeze_rows import (  # type: ignore[import-not-found, no-redef]
        copy_rows_,
        gather_cached_active_rows,
        gather_cached_kv_active_qkv,
        scatter_active_rows,
        scatter_selected_rows_,
    )

class _ForwardOwner(Protocol):
    forward: object


class _TensorStreams(Protocol):
    def __getitem__(self, index: int) -> torch.Tensor: ...


class _ModelForward(Protocol):
    def __call__(
        self, x: _TensorStreams, timestep: torch.Tensor, context: torch.Tensor,
        transformer_options: dict[str, object] | None = None, minimax_payload: object = None,
        denoise_mask: torch.Tensor | None = None, audio_denoise_mask: torch.Tensor | None = None,
        **kwargs: object,
    ) -> object: ...


class _BlockForward(Protocol):
    def __call__(
        self, x: torch.Tensor, t_emb: torch.Tensor, mod_segments: object, rope_freqs: object,
        transformer_options: dict[str, object] | None = None, attention: object = None,
    ) -> torch.Tensor: ...


_ACTIVE_FREEZE: ContextVar[TokenFreezeController | None] = ContextVar(
    "fasth3_speculative_forcing_freeze", default=None
)
_CACHED_ROWS: ContextVar[torch.Tensor | None] = ContextVar(
    "fasth3_speculative_forcing_cached_rows", default=None
)
_ACTIVE_ROWS: ContextVar[torch.Tensor | None] = ContextVar(
    "fasth3_speculative_forcing_active_rows", default=None
)
_ACTIVE_BLOCK_INDEX: ContextVar[int | None] = ContextVar(
    "fasth3_speculative_forcing_block_index", default=None
)


def _video_tokens(video: torch.Tensor) -> torch.Tensor:
    if video.ndim != 5 or video.shape[0] != 1:
        raise ValueError("token freezing requires a batch-one [B,C,T,H,W] video latent")
    batch, channels, frames, height, width = video.shape
    if height % 2 or width % 2:
        raise ValueError("MiniMax-H3 token freezing requires even latent height and width")
    return (
        video.reshape(batch, channels, frames, height // 2, 2, width // 2, 2)
        .permute(0, 2, 3, 5, 1, 4, 6)
        .reshape(-1, channels * 4)
    )


def smooth_stability_scores(
    scores: torch.Tensor, grid: tuple[int, int, int]
) -> torch.Tensor:
    """Apply the paper's per-frame spatial and forward temporal score smoothing."""
    frames, height, width = grid
    if scores.ndim != 1 or scores.numel() != frames * height * width:
        raise ValueError("stability score count does not match the latent token grid")
    if min(frames, height, width) <= 0:
        raise ValueError("stability smoothing needs a nonempty latent token grid")
    values = scores.float().reshape(frames, 1, height, width)
    axis = torch.arange(-4, 5, dtype=torch.float32, device=scores.device)
    gaussian = torch.exp(-0.5 * axis.square())
    spatial_kernel = gaussian[:, None] * gaussian[None, :]
    spatial_kernel /= spatial_kernel.sum()
    padding_mode = "reflect" if min(height, width) > 4 else "replicate"
    spatial = F.conv2d(
        F.pad(values, (4, 4, 4, 4), mode=padding_mode),
        spatial_kernel.view(1, 1, 9, 9),
    )

    # Scores at frame t use t and the following latent frames in the same
    # chunk. Renormalize at the chunk end so the filter does not bias scores
    # downward where fewer future frames exist.
    offsets = torch.arange(min(5, frames), dtype=torch.float32, device=scores.device)
    temporal_weights = torch.exp(-0.5 * offsets.square())
    temporal = torch.zeros_like(spatial)
    denominator = spatial.new_zeros((frames, 1, 1, 1))
    for offset, weight in enumerate(temporal_weights):
        length = frames - offset
        temporal[:length] += spatial[offset:] * weight
        denominator[:length] += weight
    return (temporal / denominator).reshape(-1)


def aggregate_vsa_cube_scores(
    scores: torch.Tensor,
    grid: tuple[int, int, int],
    cube_size: tuple[int, int, int] = (4, 4, 4),
    reduction: str = "max",
) -> torch.Tensor:
    """Broadcast a live-token score reduction to every token in its VSA cube."""
    frames, height, width = grid
    cube_t, cube_h, cube_w = cube_size
    if scores.ndim != 1 or scores.numel() != frames * height * width:
        raise ValueError("stability score count does not match the latent token grid")
    if min(*grid, *cube_size) <= 0:
        raise ValueError("VSA cube aggregation needs positive grid and cube dimensions")
    if reduction not in {"max", "mean"}:
        raise ValueError("VSA cube reduction must be max or mean")
    padded_grid = tuple(
        (size + cube - 1) // cube * cube for size, cube in zip(grid, cube_size)
    )
    pt, ph, pw = padded_grid
    shape = (pt // cube_t, cube_t, ph // cube_h, cube_h, pw // cube_w, cube_w)
    if reduction == "max":
        padded = torch.full(padded_grid, -torch.inf, dtype=scores.dtype, device=scores.device)
        padded[:frames, :height, :width] = scores.reshape(grid)
        grouped = padded.reshape(shape)
        reduced = grouped.amax(dim=(1, 3, 5))
    else:
        padded = torch.zeros(padded_grid, dtype=scores.dtype, device=scores.device)
        valid = torch.zeros(padded_grid, dtype=scores.dtype, device=scores.device)
        padded[:frames, :height, :width] = scores.reshape(grid)
        valid[:frames, :height, :width] = 1
        grouped = padded.reshape(shape)
        grouped_valid = valid.reshape(shape)
        reduced = grouped.sum(dim=(1, 3, 5)) / grouped_valid.sum(dim=(1, 3, 5)).clamp_min(1)
    expanded = reduced.repeat_interleave(cube_t, 0)
    expanded = expanded.repeat_interleave(cube_h, 1)
    expanded = expanded.repeat_interleave(cube_w, 2)
    return expanded[:frames, :height, :width].reshape(-1)


class TokenFreezeController:
    """Commit stable 2x2 video-latent patches and cache their block states."""

    def __init__(
        self,
        threshold: float = 0.24,
        total_steps: int = 5,
        compact_active_queries: bool = False,
        stability_observations: int = 1,
        stability_mode: str = "legacy_relative",
        freeze_granularity: str = "token",
        seed_mode: str = "activation",
        prescribed_exit_steps: torch.Tensor | None = None,
        dense_reference: bool = False,
    ) -> None:
        if not torch.isfinite(torch.tensor(threshold)) or threshold < 0:
            raise ValueError("freeze threshold must be finite and non-negative")
        if total_steps < 2:
            raise ValueError("token freezing requires at least two denoising steps")
        if type(compact_active_queries) is not bool:
            raise TypeError("compact_active_queries must be a boolean")
        if type(dense_reference) is not bool:
            raise TypeError("dense_reference must be a boolean")
        if (type(stability_observations) is not int or stability_observations < 1
                or stability_observations >= total_steps):
            raise ValueError("stability_observations must be between 1 and total_steps - 1")
        if stability_mode not in {"legacy_relative", "paper_smoothed"}:
            raise ValueError("stability_mode must be 'legacy_relative' or 'paper_smoothed'")
        if freeze_granularity not in {
            "token", "vsa_cube", "vsa_cube_mean_step2",
            "vsa_cube_mean_step2_hybrid", "vsa_cube_mean_step2_hybrid75",
            "vsa_cube_mean_step3"
        }:
            raise ValueError(
                "freeze_granularity must be token, vsa_cube, "
                "vsa_cube_mean_step2, vsa_cube_mean_step2_hybrid, "
                "vsa_cube_mean_step2_hybrid75, or vsa_cube_mean_step3"
            )
        if seed_mode not in {"activation", "previous_forward"}:
            raise ValueError("seed_mode must be 'activation' or 'previous_forward'")
        if prescribed_exit_steps is not None:
            if prescribed_exit_steps.ndim != 1 or prescribed_exit_steps.dtype not in (torch.int32, torch.int64):
                raise ValueError("prescribed exit steps must be a one-dimensional integer tensor")
            if torch.any((prescribed_exit_steps < 1) | (prescribed_exit_steps > total_steps)):
                raise ValueError("prescribed exit steps must be between 1 and total_steps")
        self.threshold = float(threshold)
        self.total_steps = int(total_steps)
        self.compact_active_queries = compact_active_queries
        self.dense_reference = dense_reference
        self.stability_observations = stability_observations
        self.stability_mode = stability_mode
        self.freeze_granularity = freeze_granularity
        self.early_threshold = (
            self.threshold * 0.75
            if freeze_granularity in {
                "vsa_cube_mean_step2_hybrid", "vsa_cube_mean_step2_hybrid75"
            } else None
        )
        self.seed_mode = seed_mode
        self.prescribed_exit_steps = (
            prescribed_exit_steps.detach().to(dtype=torch.long).clone()
            if prescribed_exit_steps is not None else None
        )
        self.debug_block_trace: Callable[[int, str, torch.Tensor], None] | None = None
        self.debug_linear_trace: Callable[[int, str, torch.Tensor, torch.Tensor], None] | None = None
        self.debug_qkv_trace: Callable[[int, torch.Tensor, torch.Tensor], None] | None = None
        self.debug_model_input_trace: Callable[
            [object, object, object, object, object, object, object], None
        ] | None = None
        self.previous_tokens: torch.Tensor | None = None
        self.frozen_tokens: torch.Tensor | None = None
        self.stable_observation_counts: torch.Tensor | None = None
        # Candidate readiness can precede the earliest permitted freeze step.
        # Keep this separate so preseed can capture prior-forward K/V without
        # changing the acceptance schedule.
        self.qkv_candidate_observation_counts: torch.Tensor | None = None
        self.ready_tokens: torch.Tensor | None = None
        self.committed_video: torch.Tensor | None = None
        self.slot_by_token: torch.Tensor | None = None
        self.cache_count = 0
        self.ready_count = 0
        self.cached_token_ids: torch.Tensor | None = None
        self.new_token_ids: torch.Tensor | None = None
        self.cached_sequence_rows: torch.Tensor | None = None
        self.cached_slot_by_sequence_row: torch.Tensor | None = None
        self.new_slot_by_sequence_row: torch.Tensor | None = None
        self.qkv_slot_by_sequence_row: torch.Tensor | None = None
        self.new_sequence_rows: torch.Tensor | None = None
        self.cached_slot_ids: torch.Tensor | None = None
        self.new_slot_ids: torch.Tensor | None = None
        self._empty_indices: torch.Tensor | None = None
        self._frozen_video_mask: torch.Tensor | None = None
        self.initial_hidden: torch.Tensor | None = None
        # The activation forward already owns full-sequence hidden tensors.
        # Retain those tensors as row-addressable caches instead of copying
        # every newly frozen row into compact buffers at every block.
        self.dense_block_cache_indices: set[int] = set()
        self.dense_block_cache_local_indices: set[int] = set()
        self.dense_initial_hidden = False
        self.block_outputs: dict[int, torch.Tensor] = {}
        self.qkv_outputs: dict[int, torch.Tensor] = {}
        self.kv_only_qkv_blocks: set[int] = set()
        self.qkv_rows_projected = 0
        self.qkv_rows_reused = 0
        self.dense_qkv_materialization_bytes_avoided = 0
        self.qkv_chunk_gather_rows = 0
        self.qkv_cache_bootstrap_skipped_final = False
        self.pending_initial_hidden: torch.Tensor | None = None
        self.pending_block_outputs: dict[int, torch.Tensor] = {}
        self.pending_capture_valid = True
        self.pending_qkv_candidate_ids: torch.Tensor | None = None
        self.pending_qkv_slot_by_token: torch.Tensor | None = None
        self.pending_qkv_slot_by_sequence_row: torch.Tensor | None = None
        self.pending_qkv_capture_step: int | None = None
        self.pending_kv_outputs: dict[int, torch.Tensor] = {}
        self.pending_kv_captured_slots: dict[int, torch.Tensor] = {}
        self.pending_qkv_input_outputs: dict[int, torch.Tensor] = {}
        self.pending_qkv_repair_projections: list[Callable[[torch.Tensor], torch.Tensor] | None] = []
        self.pending_qkv_capture_enabled = False
        self.pending_qkv_candidate_preparations = 0
        self.pending_qkv_candidate_rows = 0
        self.pending_qkv_layer_capture_blocks: set[int] = set()
        self.pending_qkv_current_step_capture_blocks: set[int] = set()
        self.pending_qkv_chunk_capture_calls = 0
        self.pending_qkv_disabled_chunk_capture_calls = 0
        self.pending_qkv_current_step_chunk_capture_calls = 0
        self.pending_qkv_current_step_dense_projection_calls = 0
        self.pending_qkv_active_capture_calls = 0
        self.pending_qkv_dense_projection_calls = 0
        self.pending_qkv_dense_projection_shapes: set[str] = set()
        self.pending_qkv_dense_projection_offsets: dict[int, int] = {}
        self.pending_qkv_projection_source_rows: dict[int, torch.Tensor] = {}
        self.pending_qkv_repaired_token_rows = 0
        self.pending_qkv_parity_relative_error: float | None = None
        self.pending_qkv_missing_capture_attempts = 0
        self.pending_qkv_missing_capture_skips: dict[str, int] = {}
        self.pending_qkv_missing_capture_last_shape: tuple[int, ...] | None = None
        self.pending_qkv_missing_capture_last_rows = 0
        self.pending_qkv_missing_capture_snapshot_counts: dict[int, int] = {}
        self.pending_qkv_commit_capture_slot_counts: list[int] = []
        self.pending_qkv_commit_attempts = 0
        self.pending_qkv_commit_skips: dict[str, int] = {}
        self.pending_qkv_commit_captured_layer_count = 0
        self.pending_qkv_commit_missing_layers: list[int] = []
        self.pending_qkv_commit_missing_candidate_counts: list[int] = []
        self.pending_qkv_commit_missing_candidate_ids: list[int] = []
        self.pending_qkv_commit_mismatched_token_count = 0
        self.pending_qkv_commit_mismatched_token_ids: list[int] = []
        self.previous_forward_kv_seed_tokens = 0
        self.qkv_bootstrap_projection_rows_avoided = 0
        self.previous_forward_seed_tokens = 0
        self.previous_forward_seed_fallbacks = 0
        self.sequence_length: int | None = None
        self.video_span: tuple[int, int] | None = None
        self.active_rows: torch.Tensor | None = None
        self.active_row_positions: torch.Tensor | None = None
        self.cached_rows: torch.Tensor | None = None
        self.accepted_per_step: list[int] = []
        self.early_accepted_per_step: list[int] = []
        self.active_video_tokens_per_eval: list[int] = []
        self.ffn_rows_skipped = 0
        self.out_projection_rows_skipped = 0
        self.cached_block_input_rows_restored = 0
        self.transformer_blocks = 0
        self.query_blocks_per_eval: dict[
            int, tuple[torch.Tensor, int, torch.Tensor]
        ] = {}
        self.active_query_plans: dict[int, tuple[torch.Tensor, torch.Tensor | None]] = {}
        self.last_step: int | None = None

    @property
    def token_count(self) -> int:
        return 0 if self.frozen_tokens is None else int(self.frozen_tokens.numel())

    def observe(self, step: int, denoised_video: torch.Tensor, sample_video: torch.Tensor) -> None:
        """Record exits from x0; projection happens at the next model boundary."""
        tokens = _video_tokens(denoised_video).detach()
        if self.frozen_tokens is None:
            self.frozen_tokens = torch.zeros(tokens.shape[0], dtype=torch.bool, device=tokens.device)
            self.stable_observation_counts = torch.zeros(
                tokens.shape[0], dtype=torch.int32, device=tokens.device
            )
            self.qkv_candidate_observation_counts = torch.zeros(
                tokens.shape[0], dtype=torch.int32, device=tokens.device
            )
            self.ready_tokens = torch.zeros_like(self.frozen_tokens)
            self.slot_by_token = torch.full(
                (tokens.shape[0],), -1, dtype=torch.long, device=tokens.device
            )
            self.committed_video = torch.zeros_like(denoised_video)
            self._empty_indices = torch.empty(0, dtype=torch.long, device=tokens.device)
        elif tokens.shape[0] != self.frozen_tokens.numel():
            raise ValueError("video latent token geometry changed during sampling")
        assert self._empty_indices is not None

        if self.prescribed_exit_steps is not None:
            if self.prescribed_exit_steps.numel() != tokens.shape[0]:
                raise ValueError("prescribed exit map does not match the video token geometry")
            if step < self.total_steps:
                active = ~self.frozen_tokens
                newly_frozen = ((self.prescribed_exit_steps.to(tokens.device) == step) & active).nonzero(
                    as_tuple=False
                ).flatten()
            else:
                newly_frozen = self._empty_indices
            early_accepted = self._empty_indices
        # No first-step stability score exists. The final step forces survivors.
        elif self.previous_tokens is not None and step < self.total_steps - 1:
            stability = (tokens.float() - self.previous_tokens.float()).norm(dim=-1)
            if self.stability_mode == "legacy_relative":
                scale = tokens.norm(dim=-1).median().clamp_min(1e-12)
                stability = stability / scale
            else:
                stability = smooth_stability_scores(
                    stability,
                    (
                        denoised_video.shape[2],
                        denoised_video.shape[3] // 2,
                        denoised_video.shape[4] // 2,
                    ),
                )
            minimum_freeze_step = 0
            if self.freeze_granularity.startswith("vsa_cube"):
                stability = aggregate_vsa_cube_scores(
                    stability,
                    (
                        denoised_video.shape[2],
                        denoised_video.shape[3] // 2,
                        denoised_video.shape[4] // 2,
                    ),
                    reduction=(
                        "mean" if self.freeze_granularity.startswith("vsa_cube_mean_step") else "max"
                    ),
                )
                minimum_freeze_step = 2 if self.freeze_granularity in {
                    "vsa_cube_mean_step2", "vsa_cube_mean_step2_hybrid",
                    "vsa_cube_mean_step2_hybrid75"
                } else 3 if self.freeze_granularity == "vsa_cube_mean_step3" else 0
            raw_stability = stability
            if self.qkv_candidate_observation_counts is not None:
                candidate_stable = (raw_stability <= self.threshold) & ~self.frozen_tokens
                self.qkv_candidate_observation_counts.copy_(torch.where(
                    candidate_stable,
                    self.qkv_candidate_observation_counts + 1,
                    torch.zeros_like(self.qkv_candidate_observation_counts),
                ))
            if step < minimum_freeze_step:
                stability = torch.full_like(stability, torch.inf)
            assert self.stable_observation_counts is not None
            stable_unfrozen = (stability <= self.threshold) & ~self.frozen_tokens
            self.stable_observation_counts.copy_(torch.where(
                stable_unfrozen,
                self.stable_observation_counts + 1,
                torch.zeros_like(self.stable_observation_counts),
            ))
            accepted = (
                (self.stable_observation_counts >= self.stability_observations)
                & ~self.frozen_tokens
            )
            if self.early_threshold is not None and step == 2:
                early_accepted = (
                    (stability <= self.early_threshold) & ~self.frozen_tokens
                )
                accepted |= early_accepted
                early_accepted = early_accepted.nonzero(as_tuple=False).flatten()
            else:
                early_accepted = self._empty_indices
            newly_frozen = accepted.nonzero(as_tuple=False).flatten()
        else:
            assert self._empty_indices is not None
            newly_frozen = self._empty_indices
            early_accepted = self._empty_indices
        newly_frozen_count = newly_frozen.numel()
        self.accepted_per_step.append(newly_frozen_count)
        self.early_accepted_per_step.append(early_accepted.numel())
        if newly_frozen_count:
            assert self.slot_by_token is not None and self.frozen_tokens is not None
            slots = torch.arange(
                self.cache_count,
                self.cache_count + newly_frozen_count,
                device=newly_frozen.device,
                dtype=torch.long,
            )
            self.slot_by_token[newly_frozen] = slots
            self.cache_count += newly_frozen_count
            self.frozen_tokens[newly_frozen] = True
            assert self.committed_video is not None
            patch_grid = self.frozen_tokens.reshape(
                denoised_video.shape[2], denoised_video.shape[3] // 2,
                denoised_video.shape[4] // 2,
            )
            new_grid = torch.zeros_like(patch_grid)
            new_grid.view(-1)[newly_frozen] = True
            expanded = new_grid.repeat_interleave(2, dim=1).repeat_interleave(2, dim=2)
            self.committed_video.copy_(torch.where(
                expanded[None, None], denoised_video, self.committed_video
            ))
            self._frozen_video_mask = patch_grid.repeat_interleave(
                2, dim=1
            ).repeat_interleave(2, dim=2)[None, None]

        self.previous_tokens = tokens
        self.last_step = int(step)
        if newly_frozen_count:
            assert self._empty_indices is not None
            if self.cached_token_ids is None:
                self.cached_token_ids = self._empty_indices
                self.cached_slot_ids = self._empty_indices
            if self.new_token_ids is None or not self.new_token_ids.numel():
                self.new_token_ids = newly_frozen
                self.new_slot_ids = slots
            else:
                assert self.new_slot_ids is not None
                token_ids = torch.cat((self.new_token_ids, newly_frozen))
                slot_ids = torch.cat((self.new_slot_ids, slots))
                order = token_ids.argsort()
                self.new_token_ids = token_ids.index_select(0, order)
                self.new_slot_ids = slot_ids.index_select(0, order)
            if self.sequence_length is not None:
                self._refresh_sequence_layout()
            if self.seed_mode == "previous_forward" and step < self.total_steps:
                if not self._seed_from_previous_forward():
                    self.previous_forward_seed_fallbacks += 1
                else:
                    self.commit_pending_qkv(newly_frozen, slots)
            else:
                self._clear_pending_previous_forward()
        elif self.cached_token_ids is None:
            self._refresh_sequence_rows()
        else:
            self._clear_pending_previous_forward()
        self._clear_pending_qkv()

    @property
    def should_capture_previous_hidden(self) -> bool:
        """Capture only forwards whose following callback may still freeze tokens."""
        return (
            self.seed_mode == "previous_forward"
            and self.last_step is not None
            and self.last_step < self.total_steps - 1
        )

    def begin_previous_forward_capture(self) -> None:
        self.pending_initial_hidden = None
        self.pending_block_outputs.clear()
        self.pending_capture_valid = True

    def capture_previous_forward_block_input(
        self, block_index: int, hidden_video_rows: torch.Tensor,
    ) -> None:
        if not self.should_capture_previous_hidden or block_index != 0:
            return
        self.pending_initial_hidden = hidden_video_rows.detach().clone()

    def capture_previous_forward_block_output(
        self, block_index: int, hidden_video_rows: torch.Tensor,
    ) -> None:
        if not self.should_capture_previous_hidden:
            return
        # Retain this block's backing storage until the sampler callback
        # decides which rows to cache; copying every full block output here
        # would add another sequence-sized memory pass on the deciding step.
        self.pending_block_outputs[block_index] = hidden_video_rows.detach()

    def _clear_pending_previous_forward(self) -> None:
        self.pending_initial_hidden = None
        self.pending_block_outputs.clear()
        self.pending_capture_valid = True

    def _clear_pending_qkv(self) -> None:
        self.pending_qkv_candidate_ids = None
        self.pending_qkv_slot_by_token = None
        self.pending_qkv_slot_by_sequence_row = None
        self.pending_kv_outputs.clear()
        self.pending_kv_captured_slots.clear()
        self.pending_qkv_input_outputs.clear()
        self.pending_qkv_capture_enabled = False
        self.pending_qkv_capture_step = None
        self.pending_qkv_current_step_capture_blocks.clear()
        self.pending_qkv_current_step_chunk_capture_calls = 0
        self.pending_qkv_current_step_dense_projection_calls = 0

    def _prepare_pending_qkv_capture(self) -> None:
        # H3 may invoke the patched model more than once before the sampler
        # reports this step (for example, separate guidance branches). Keep
        # the first projection carriers until the callback decides acceptance.
        if self.pending_qkv_capture_step == self.last_step:
            return
        self._clear_pending_qkv()
        self.pending_qkv_capture_step = self.last_step
        if (self.seed_mode != "previous_forward" or self.stability_observations < 2
                or self.early_threshold is not None or self.frozen_tokens is None
                or self.qkv_candidate_observation_counts is None
                or self.last_step is None or self.last_step >= self.total_steps - 1):
            return
        candidates = (
            (self.qkv_candidate_observation_counts >= self.stability_observations - 1)
            & ~self.frozen_tokens
        ).nonzero(as_tuple=False).flatten()
        if not candidates.numel():
            return
        self.pending_qkv_candidate_preparations += 1
        self.pending_qkv_candidate_rows += candidates.numel()
        assert self.slot_by_token is not None
        self.pending_qkv_candidate_ids = candidates
        self.pending_qkv_slot_by_token = torch.full_like(self.slot_by_token, -1)
        self.pending_qkv_slot_by_token[candidates] = torch.arange(
            candidates.numel(), device=candidates.device, dtype=torch.long,
        )
        self.pending_qkv_capture_enabled = True
        self._refresh_pending_qkv_sequence_layout()

    def _refresh_pending_qkv_sequence_layout(self) -> None:
        if (self.pending_qkv_candidate_ids is None or self.sequence_length is None
                or self.video_span is None):
            return
        start, end = self.video_span
        if end - start != self.token_count:
            raise ValueError("pending QKV candidates do not match the video span")
        rows = self.pending_qkv_candidate_ids + start
        self.pending_qkv_slot_by_sequence_row = torch.full(
            (self.sequence_length,), -1, dtype=torch.long,
            device=self.pending_qkv_candidate_ids.device,
        )
        self.pending_qkv_slot_by_sequence_row[rows] = torch.arange(
            rows.numel(), device=rows.device, dtype=torch.long,
        )

    def _pending_kv_cache(self, block_index: int, projected: torch.Tensor) -> torch.Tensor:
        if self.pending_qkv_candidate_ids is None:
            raise RuntimeError("pending QKV candidates are unavailable")
        hidden_width = projected.shape[1] // 3
        cache = self.pending_kv_outputs.get(block_index)
        self.pending_qkv_layer_capture_blocks.add(block_index)
        self.pending_qkv_current_step_capture_blocks.add(block_index)
        if cache is None:
            cache = projected.new_empty((self.pending_qkv_candidate_ids.numel(), 2 * hidden_width))
            self.pending_kv_outputs[block_index] = cache
            self.pending_kv_captured_slots[block_index] = torch.zeros(
                self.pending_qkv_candidate_ids.numel(), dtype=torch.bool,
                device=projected.device,
            )
        elif cache.shape[1] != 2 * hidden_width:
            raise ValueError("pending K/V cache width changed during sampling")
        return cache

    def capture_pending_qkv_chunk(
        self, block_index: int, projected: torch.Tensor, source_rows: torch.Tensor,
    ) -> None:
        """Retain candidate K/V already computed by this forward for a later freeze."""
        self.pending_qkv_chunk_capture_calls += 1
        self.pending_qkv_current_step_chunk_capture_calls += 1
        if (not self.pending_qkv_capture_enabled
                or self.pending_qkv_slot_by_sequence_row is None):
            self.pending_qkv_disabled_chunk_capture_calls += 1
            return
        if (projected.ndim != 2 or source_rows.ndim != 1
                or projected.shape[0] != source_rows.numel() or projected.shape[1] % 3):
            raise ValueError("pending QKV chunks must align with their source rows")
        if source_rows.device != projected.device:
            raise ValueError("pending QKV source rows must share the projection device")
        assert self.sequence_length is not None
        valid = (source_rows >= 0) & (source_rows < self.sequence_length)
        safe_rows = source_rows.clamp(0, self.sequence_length - 1).to(torch.long)
        slots = self.pending_qkv_slot_by_sequence_row.index_select(0, safe_rows)
        slots.masked_fill_(~valid, -1)
        cache = self._pending_kv_cache(block_index, projected)
        scatter_selected_rows_(cache, projected[:, projected.shape[1] // 3:], slots)
        captured = self.pending_kv_captured_slots[block_index]
        captured.index_fill_(0, slots[slots >= 0], True)

    def capture_pending_qkv_dense_projection(
        self, block_index: int, projected: torch.Tensor,
    ) -> None:
        """Capture candidates when a dense fallback already materialized full QKV."""
        self.pending_qkv_dense_projection_calls += 1
        self.pending_qkv_current_step_dense_projection_calls += 1
        self.pending_qkv_dense_projection_shapes.add(str(tuple(projected.shape)))
        if (not self.pending_qkv_capture_enabled or self.sequence_length is None
                or projected.ndim != 2 or projected.shape[1] % 3):
            return
        start = self.pending_qkv_dense_projection_offsets.get(block_index, 0)
        if start + projected.shape[0] > self.sequence_length:
            start = 0
        end = start + projected.shape[0]
        if end > self.sequence_length:
            return
        self.pending_qkv_dense_projection_offsets[block_index] = end
        source_rows = torch.arange(start, end, device=projected.device)
        self.capture_pending_qkv_chunk(block_index, projected, source_rows)

    def set_pending_qkv_projection_source_rows(
        self, block_index: int, source_rows: torch.Tensor,
    ) -> None:
        self.pending_qkv_projection_source_rows[block_index] = source_rows

    def pop_pending_qkv_projection_source_rows(
        self, block_index: int,
    ) -> torch.Tensor | None:
        return self.pending_qkv_projection_source_rows.pop(block_index, None)

    def pending_qkv_missing_sequence_rows(self, block_index: int) -> torch.Tensor:
        """Return accepted-candidate source rows absent from a layer's QKV chunks."""
        candidates = self.pending_qkv_candidate_ids
        captured = self.pending_kv_captured_slots.get(block_index)
        if candidates is None or self.video_span is None:
            device = (self.pending_kv_outputs[block_index].device
                      if block_index in self.pending_kv_outputs else torch.device("cpu"))
            return torch.empty(0, dtype=torch.long, device=device)
        missing = candidates if captured is None else candidates[~captured]
        return missing + self.video_span[0]

    def capture_pending_qkv_input_rows(
        self, block_index: int, qkv_inputs: torch.Tensor,
    ) -> None:
        """Keep the exact normalized/modulated QKV inputs for candidate video rows."""
        if (not self.pending_qkv_capture_enabled or self.pending_qkv_candidate_ids is None
                or self.sequence_length is None or self.video_span is None
                or qkv_inputs.ndim != 2 or qkv_inputs.shape[0] < self.sequence_length):
            return
        candidate_rows = self.pending_qkv_candidate_ids + self.video_span[0]
        self.pending_qkv_input_outputs[block_index] = (
            qkv_inputs.index_select(0, candidate_rows).detach().clone()
        )

    def capture_pending_qkv_missing_rows(
        self, block_index: int, projection: Callable[[torch.Tensor], torch.Tensor], qkv_inputs: torch.Tensor,
    ) -> None:
        """Project skipped candidate rows from this attention pass's exact QKV inputs."""
        self.pending_qkv_missing_capture_attempts += 1
        self.pending_qkv_missing_capture_last_shape = tuple(qkv_inputs.shape)
        if not self.pending_qkv_capture_enabled:
            reason = "capture_disabled"
        elif self.sequence_length is None:
            reason = "sequence_length_missing"
        elif qkv_inputs.ndim != 2 or qkv_inputs.shape[0] < self.sequence_length:
            reason = "qkv_input_not_full_sequence"
        else:
            reason = None
        if reason is not None:
            self.pending_qkv_missing_capture_skips[reason] = (
                self.pending_qkv_missing_capture_skips.get(reason, 0) + 1
            )
            return
        missing_rows = self.pending_qkv_missing_sequence_rows(block_index)
        self.pending_qkv_missing_capture_last_rows = missing_rows.numel()
        captured = self.pending_kv_captured_slots.get(block_index)
        self.pending_qkv_missing_capture_snapshot_counts[block_index] = (
            0 if captured is None else int(captured.sum().item())
        )
        if not missing_rows.numel():
            reason = "no_unprojected_candidates"
            self.pending_qkv_missing_capture_skips[reason] = (
                self.pending_qkv_missing_capture_skips.get(reason, 0) + 1
            )
            return
        self.set_pending_qkv_projection_source_rows(block_index, missing_rows)
        try:
            projection(qkv_inputs.index_select(0, missing_rows))
        finally:
            self.pop_pending_qkv_projection_source_rows(block_index)
        self.pending_qkv_repaired_token_rows += missing_rows.numel()

    def _repair_pending_qkv_candidate_rows(self, source_slots: torch.Tensor) -> None:
        """Repair unprojected carriers using the exact normalized QKV inputs."""
        repaired_rows = 0
        for block_index, projection in enumerate(self.pending_qkv_repair_projections):
            captured = self.pending_kv_captured_slots.get(block_index)
            cache = self.pending_kv_outputs.get(block_index)
            inputs = self.pending_qkv_input_outputs.get(block_index)
            if captured is None or cache is None or inputs is None or projection is None:
                continue
            captured_for_seed = captured.index_select(0, source_slots)
            missing_slots = source_slots[~captured_for_seed]
            if not missing_slots.numel():
                continue
            qkv = projection(inputs.index_select(0, missing_slots))
            if qkv.ndim != 2 or qkv.shape[0] != missing_slots.numel() or qkv.shape[1] % 3:
                raise ValueError("QKV repair projection did not return candidate rows")
            kv = qkv[:, qkv.shape[1] // 3:]
            copy_rows_(cache, kv, dst_indices=missing_slots)
            captured.index_fill_(0, missing_slots, True)
            repaired_rows += missing_slots.numel()
        self.pending_qkv_repaired_token_rows += repaired_rows

    def _measure_pending_qkv_parity(self, source_slots: torch.Tensor) -> float | None:
        """Check sampled carriers against the cached exact QKV input activations."""
        sample_slots = source_slots[:min(8, source_slots.numel())]
        errors: list[torch.Tensor] = []
        for block_index, projection in enumerate(self.pending_qkv_repair_projections):
            inputs = self.pending_qkv_input_outputs.get(block_index)
            cache = self.pending_kv_outputs.get(block_index)
            if projection is None or inputs is None or cache is None:
                return None
            expected = projection(inputs.index_select(0, sample_slots))
            expected_kv = expected[:, expected.shape[1] // 3:].float()
            actual_kv = cache.index_select(0, sample_slots).float()
            errors.append(torch.linalg.vector_norm(expected_kv - actual_kv))
        if not errors:
            return None
        error_norm = torch.stack(errors).sum()
        reference_norm = torch.stack([
            torch.linalg.vector_norm(
                self.pending_kv_outputs[block_index].index_select(0, sample_slots).float()
            )
            for block_index in range(len(errors))
        ]).sum().clamp_min(1e-12)
        self.pending_qkv_parity_relative_error = float((error_norm / reference_norm).item())
        return self.pending_qkv_parity_relative_error

    def capture_pending_qkv_active_rows(
        self, block_index: int, projected: torch.Tensor,
    ) -> None:
        """Retain candidate K/V from an already compact active-row projection."""
        self.pending_qkv_active_capture_calls += 1
        if (not self.pending_qkv_capture_enabled
                or self.pending_qkv_candidate_ids is None
                or self.active_row_positions is None):
            return
        if projected.ndim != 2 or projected.shape[1] % 3:
            raise ValueError("pending active projection must contain fused QKV rows")
        assert self.video_span is not None
        candidate_rows = self.pending_qkv_candidate_ids + self.video_span[0]
        positions = self.active_row_positions.index_select(0, candidate_rows)
        torch._assert_async(
            (positions >= 0).all(), "pending QKV candidates must remain active during capture"
        )
        cache = self._pending_kv_cache(block_index, projected)
        candidate_kv = projected.index_select(0, positions)[:, projected.shape[1] // 3:]
        copy_rows_(cache, candidate_kv)
        self.pending_kv_captured_slots[block_index].fill_(True)

    def commit_pending_qkv(self, token_ids: torch.Tensor, destination_slots: torch.Tensor) -> int:
        """Publish prior-forward K/V carriers when confirmed cubes meet the sparse gate."""
        self.pending_qkv_commit_attempts += 1
        captured_layers = set(self.pending_kv_outputs)
        self.pending_qkv_commit_capture_enabled = self.pending_qkv_capture_enabled
        self.pending_qkv_commit_candidate_count = (
            0 if self.pending_qkv_candidate_ids is None
            else self.pending_qkv_candidate_ids.numel()
        )
        self.pending_qkv_commit_capture_step = self.pending_qkv_capture_step
        self.pending_qkv_commit_step_capture_blocks = sorted(
            self.pending_qkv_current_step_capture_blocks
        )
        self.pending_qkv_commit_step_chunk_capture_calls = (
            self.pending_qkv_current_step_chunk_capture_calls
        )
        self.pending_qkv_commit_step_dense_projection_calls = (
            self.pending_qkv_current_step_dense_projection_calls
        )
        self.pending_qkv_commit_captured_layer_count = len(captured_layers)
        self.pending_qkv_commit_missing_layers = sorted(
            set(range(self.transformer_blocks)) - captured_layers
        )
        self.pending_qkv_commit_capture_slot_counts = (
            torch.stack([
                captured.sum()
                for captured in self.pending_kv_captured_slots.values()
            ]).to(device="cpu").tolist()
            if self.pending_kv_captured_slots else []
        )
        self.pending_qkv_commit_missing_candidate_counts = []
        self.pending_qkv_commit_missing_candidate_ids = []
        self.pending_qkv_commit_mismatched_token_count = 0
        self.pending_qkv_commit_mismatched_token_ids = []
        if (not self.pending_qkv_capture_enabled
                or self.pending_qkv_slot_by_token is None
                or self.pending_qkv_candidate_ids is None):
            reason = "no_pending_candidates"
        elif not self.native_query_cache_ready:
            reason = "sparse_gate_not_ready"
        elif not self.transformer_blocks:
            reason = "no_transformer_blocks"
        elif len(self.pending_kv_outputs) != self.transformer_blocks:
            reason = "incomplete_layer_capture"
        else:
            reason = None
        if reason is not None:
            self.pending_qkv_commit_skips[reason] = (
                self.pending_qkv_commit_skips.get(reason, 0) + 1
            )
            return 0
        if token_ids.numel() != destination_slots.numel():
            raise ValueError("pending QKV token IDs and destination slots must align")
        assert self.pending_qkv_slot_by_token is not None
        assert self.pending_qkv_candidate_ids is not None
        pending_slot_by_token = self.pending_qkv_slot_by_token
        candidate_ids = self.pending_qkv_candidate_ids
        source_slots = pending_slot_by_token.index_select(0, token_ids)
        torch._assert_async(
            (source_slots >= 0).all(),
            "confirmed tokens must have been candidate QKV rows in the prior forward",
        )
        mapped_token_ids = candidate_ids.index_select(0, source_slots)
        mismatch = mapped_token_ids != token_ids
        mismatch_count = int(mismatch.sum().item())
        self.pending_qkv_commit_mismatched_token_count = mismatch_count
        self.pending_qkv_commit_mismatched_token_ids = (
            token_ids[mismatch][:64].to(device="cpu").tolist()
        )
        self._repair_pending_qkv_candidate_rows(source_slots)
        missing_counts = torch.stack([
            (~self.pending_kv_captured_slots[block_index].index_select(0, source_slots)).sum()
            for block_index in range(self.transformer_blocks)
        ]).to(device="cpu").tolist()
        self.pending_qkv_commit_missing_candidate_counts = [
            int(count) for count in missing_counts
        ]
        first_capture_mask = self.pending_kv_captured_slots[0].index_select(0, source_slots)
        missing_source_slots = source_slots[~first_capture_mask]
        missing_candidate_ids = candidate_ids.index_select(
            0, missing_source_slots,
        )
        self.pending_qkv_commit_missing_candidate_ids = (
            missing_candidate_ids[:64].to(device="cpu").tolist()
        )
        if any(self.pending_qkv_commit_missing_candidate_counts):
            reason = "incomplete_candidate_capture"
            self.pending_qkv_commit_skips[reason] = (
                self.pending_qkv_commit_skips.get(reason, 0) + 1
            )
            return 0
        parity_error = self._measure_pending_qkv_parity(source_slots)
        if parity_error is None or parity_error > 0.01:
            reason = "carrier_parity_failed"
            self.pending_qkv_commit_skips[reason] = (
                self.pending_qkv_commit_skips.get(reason, 0) + 1
            )
            return 0
        for block_index in range(self.transformer_blocks):
            pending = self.pending_kv_outputs[block_index]
            cache = self.qkv_outputs.get(block_index)
            capacity = (
                self.token_count if self.cache_count >= max(1, self.token_count // 4)
                else min(self.token_count, ((self.cache_count + 1023) // 1024) * 1024)
            )
            if cache is None:
                cache = pending.new_empty((capacity, pending.shape[1]))
                self.qkv_outputs[block_index] = cache
            elif cache.shape[1] == pending.shape[1] * 3 // 2:
                cache = cache[:, pending.shape[1] // 2:].contiguous()
                self.qkv_outputs[block_index] = cache
            elif cache.shape[1] != pending.shape[1]:
                raise ValueError("prior-forward K/V cache width changed during sampling")
            if cache.shape[0] < self.cache_count:
                expanded = pending.new_empty((capacity, pending.shape[1]))
                copy_rows_(expanded, cache, row_count=cache.shape[0])
                cache = expanded
                self.qkv_outputs[block_index] = cache
            values = pending.index_select(0, source_slots)
            copy_rows_(cache, values, dst_indices=destination_slots)
            self.kv_only_qkv_blocks.add(block_index)
            self.pending_kv_outputs.pop(block_index, None)
            self.pending_kv_captured_slots.pop(block_index, None)
        seeded: int = token_ids.numel()
        self.qkv_rows_reused += seeded * self.transformer_blocks
        self.previous_forward_kv_seed_tokens += seeded
        self.qkv_bootstrap_projection_rows_avoided += self.ready_count * self.transformer_blocks
        return seeded

    def _seed_from_previous_forward(self) -> bool:
        if (not self.pending_capture_valid or self.pending_initial_hidden is None
                or len(self.pending_block_outputs) != self.transformer_blocks
                or self.new_sequence_rows is None or self.new_slot_ids is None
                or self.new_token_ids is None):
            self._clear_pending_previous_forward()
            return False
        start, end = self.video_span or (0, 0)
        if end - start != self.pending_initial_hidden.shape[0]:
            self._clear_pending_previous_forward()
            return False
        outputs = [self.pending_block_outputs.get(i) for i in range(self.transformer_blocks)]
        if any(output is None or output.shape[0] != end - start for output in outputs):
            self._clear_pending_previous_forward()
            return False

        # Captured tensors already contain every video row from the deciding
        # forward. Keep their storage and use token-local indices rather than
        # copying each accepted row into compact per-block caches.
        self.initial_hidden = self.pending_initial_hidden
        self.dense_initial_hidden = True
        self.block_outputs = {i: output for i, output in enumerate(outputs) if output is not None}
        self.dense_block_cache_indices = set(range(self.transformer_blocks))
        self.dense_block_cache_local_indices = set(range(self.transformer_blocks))
        self.previous_forward_seed_tokens += self.new_token_ids.numel()
        assert self.ready_tokens is not None and self.frozen_tokens is not None
        self.ready_tokens.copy_(self.frozen_tokens)
        self.ready_count = self.cache_count
        self._refresh_sequence_rows(indices_already_ready=True)
        self._clear_pending_previous_forward()
        return True

    def active_denoise_mask(
        self, video: torch.Tensor, denoise_mask: torch.Tensor | None
    ) -> torch.Tensor | None:
        if not self.cache_count:
            return denoise_mask
        assert self._frozen_video_mask is not None
        active = (~self._frozen_video_mask).to(device=video.device, dtype=video.dtype)
        if denoise_mask is None:
            return active
        return denoise_mask * active.to(device=denoise_mask.device, dtype=denoise_mask.dtype)

    def project_committed_video(self, video: torch.Tensor) -> None:
        """Restore early-exit x0 at a solver/model boundary, not in its callback."""
        if not self.cache_count:
            return
        assert self._frozen_video_mask is not None and self.committed_video is not None
        video.copy_(torch.where(self._frozen_video_mask, self.committed_video, video))

    def _refresh_sequence_rows(self, *, indices_already_ready: bool = False) -> None:
        if self.frozen_tokens is None:
            return
        assert self._empty_indices is not None
        assert self.ready_tokens is not None
        assert self.slot_by_token is not None
        if indices_already_ready:
            # finish_forward has just made every pending token reusable. The
            # old and pending compact ID/slot lists already describe exactly
            # the new ready set, so reuse them instead of repeating a full-token
            # nonzero scan and cache-slot gather on the activation step. Keep
            # token IDs sorted and apply the same permutation to
            # their cache slots, matching the normal mask-scan ordering.
            assert self.cached_token_ids is not None and self.new_token_ids is not None
            assert self.cached_slot_ids is not None and self.new_slot_ids is not None
            if self.cached_token_ids.numel():
                token_ids = torch.cat((self.cached_token_ids, self.new_token_ids))
                slot_ids = torch.cat((self.cached_slot_ids, self.new_slot_ids))
                order = token_ids.argsort()
                self.cached_token_ids = token_ids.index_select(0, order)
                self.cached_slot_ids = slot_ids.index_select(0, order)
            else:
                self.cached_token_ids = self.new_token_ids
                self.cached_slot_ids = self.new_slot_ids
            self.new_token_ids = self._empty_indices
            self.new_slot_ids = self._empty_indices
        else:
            self.cached_token_ids = (
                (self.frozen_tokens & self.ready_tokens).nonzero(as_tuple=False).flatten()
                if self.ready_count else self._empty_indices
            )
            self.new_token_ids = (
                (self.frozen_tokens & ~self.ready_tokens).nonzero(as_tuple=False).flatten()
                if self.cache_count > self.ready_count else self._empty_indices
            )
            self.cached_slot_ids = (
                self.slot_by_token.index_select(0, self.cached_token_ids)
                if self.ready_count else self._empty_indices
            )
            self.new_slot_ids = (
                self.slot_by_token.index_select(0, self.new_token_ids)
                if self.cache_count > self.ready_count else self._empty_indices
            )
        if self.sequence_length is not None and self.video_span is not None:
            self._refresh_sequence_layout()

    def _refresh_sequence_layout(self) -> None:
        if (self.frozen_tokens is None or self.sequence_length is None
                or self.video_span is None):
            return
        assert self.cached_token_ids is not None and self.cached_slot_ids is not None
        assert self.new_token_ids is not None and self.new_slot_ids is not None
        assert self._empty_indices is not None
        start, end = self.video_span
        if end - start != self.frozen_tokens.numel():
            raise ValueError("MiniMax-H3 video span does not match the 2x2 latent token grid")
        device = self.frozen_tokens.device
        if self.cached_rows is None:
            self.cached_rows = torch.zeros(self.sequence_length, dtype=torch.bool, device=device)
        else:
            self.cached_rows.zero_()
        self.cached_sequence_rows = (
            self.cached_token_ids + start if self.ready_count else self._empty_indices
        )
        if self.cached_slot_by_sequence_row is None:
            self.cached_slot_by_sequence_row = torch.full(
                (self.sequence_length,), -1, dtype=torch.long, device=device
            )
        else:
            self.cached_slot_by_sequence_row.fill_(-1)
        if self.ready_count:
            self.cached_slot_by_sequence_row[self.cached_sequence_rows] = self.cached_slot_ids
        self.new_sequence_rows = (
            self.new_token_ids + start
            if self.cache_count > self.ready_count else self._empty_indices
        )
        if self.new_slot_by_sequence_row is None:
            self.new_slot_by_sequence_row = torch.full(
                (self.sequence_length,), -1, dtype=torch.long, device=device
            )
        else:
            self.new_slot_by_sequence_row.fill_(-1)
        if self.new_sequence_rows.numel():
            self.new_slot_by_sequence_row[self.new_sequence_rows] = self.new_slot_ids
        if self.qkv_slot_by_sequence_row is None:
            self.qkv_slot_by_sequence_row = torch.full(
                (self.sequence_length,), -1, dtype=torch.long, device=device
            )
        else:
            self.qkv_slot_by_sequence_row.fill_(-1)
        if self.ready_count:
            self.qkv_slot_by_sequence_row[self.cached_sequence_rows] = self.cached_slot_ids
        if self.new_sequence_rows.numel():
            self.qkv_slot_by_sequence_row[self.new_sequence_rows] = self.new_slot_ids
        if self.ready_count:
            self.cached_rows[self.cached_sequence_rows] = True
            self.active_rows = (~self.cached_rows).nonzero(as_tuple=False).flatten()
        elif self.active_rows is None:
            self.active_rows = torch.arange(self.sequence_length, device=device)
        if self.active_row_positions is None:
            self.active_row_positions = torch.empty(
                self.sequence_length, dtype=torch.long, device=device
            )
        self.active_row_positions.fill_(-1)
        self.active_row_positions[self.active_rows] = torch.arange(
            self.active_rows.numel(), dtype=torch.long, device=device
        )

    def configure_layout(self, sequence_length: int, video_span: tuple[int, int]) -> None:
        if self.sequence_length is not None:
            if self.sequence_length != sequence_length or self.video_span != video_span:
                raise ValueError("packed MiniMax-H3 layout changed during token freezing")
            return
        self.sequence_length = int(sequence_length)
        self.video_span = (int(video_span[0]), int(video_span[1]))
        if self.cached_token_ids is not None:
            self._refresh_sequence_layout()
        else:
            self._refresh_sequence_rows()
        self._refresh_pending_qkv_sequence_layout()

    def begin_forward(self) -> None:
        if self.seed_mode == "previous_forward":
            self.begin_previous_forward_capture()
        self._prepare_pending_qkv_capture()
        self.pending_qkv_dense_projection_offsets.clear()
        self.pending_qkv_projection_source_rows.clear()
        if self.frozen_tokens is not None:
            self.active_video_tokens_per_eval.append(
                self.token_count - self.ready_count
            )

    def finish_forward(self) -> None:
        if self.cache_count > self.ready_count:
            assert self.ready_tokens is not None and self.frozen_tokens is not None
            self.ready_tokens.copy_(self.frozen_tokens)
            self.ready_count = self.cache_count
            self._refresh_sequence_rows(indices_already_ready=True)

    def record_active_query_blocks(
        self,
        evaluation: int,
        active_blocks: torch.Tensor,
        valid_rows: torch.Tensor | None = None,
    ) -> None:
        """Keep one asynchronous active-block count per denoising evaluation."""
        if active_blocks.dtype != torch.bool or active_blocks.ndim != 1:
            raise ValueError("VSA active query blocks must be a one-dimensional boolean tensor")
        if valid_rows is None:
            valid_rows = torch.full_like(active_blocks, 64, dtype=torch.int32)
        if (valid_rows.dtype not in (torch.int32, torch.int64)
                or valid_rows.device != active_blocks.device or valid_rows.shape != active_blocks.shape):
            raise ValueError("VSA query block lengths must be integer counts on the mask device")
        evaluation = int(evaluation)
        if evaluation in self.query_blocks_per_eval:
            return
        self.query_blocks_per_eval[evaluation] = (
            active_blocks.sum(dtype=torch.int64),
            active_blocks.numel(),
            torch.where(active_blocks, 0, valid_rows).sum(dtype=torch.int64),
        )

    def active_query_plan(
        self,
        evaluation: int,
        source_rows: torch.Tensor,
        valid_rows: torch.Tensor,
    ) -> tuple[torch.Tensor, torch.Tensor | None]:
        """Build the original-query mask and compact block IDs once per evaluation."""
        evaluation = int(evaluation)
        cached = self.active_query_plans.get(evaluation)
        if cached is not None:
            return cached
        if self.cached_rows is None:
            raise RuntimeError("active query planning requires the cached sequence-row mask")
        if source_rows.ndim != 1 or source_rows.dtype not in (torch.int32, torch.int64):
            raise ValueError("VSA source rows must be a one-dimensional integer tensor")
        if source_rows.device != self.cached_rows.device:
            raise ValueError("VSA source rows and cached-row mask must share a device")
        safe_rows = source_rows.clamp_min(0).to(torch.long)
        if self.dense_reference:
            # Keep the optimized native VSA kernel selected for an apples-to-
            # apples reference, but mark every valid block active so no query
            # block is skipped and no compact block list is produced.
            live_rows = source_rows >= 0
        else:
            live_rows = (source_rows >= 0) & ~self.cached_rows.index_select(0, safe_rows)
        if live_rows.numel() % 64:
            raise ValueError("VSA query rows must be grouped into complete 64-row blocks")
        active_blocks = live_rows.reshape(-1, 64).any(dim=1)
        if valid_rows.shape != active_blocks.shape or valid_rows.device != active_blocks.device:
            raise ValueError("VSA block lengths do not match the active-query geometry")
        # Padding queries are not useful to the attention output and need no
        # compact CTA. The full-length K/V preparation still retains its layout.
        active_blocks &= valid_rows > 0
        if self.freeze_granularity.startswith("vsa_cube"):
            cached_source_rows = (
                (source_rows >= 0) & self.cached_rows.index_select(0, safe_rows)
            )
            cached_blocks = cached_source_rows.reshape(-1, 64).any(dim=1)
            torch._assert_async(
                ~(active_blocks & cached_blocks).any(),
                "VSA cube freezing must not leave cached Q rows in an active query block",
            )
        active_blocks = active_blocks.contiguous()
        active_ids = None
        if self.compact_active_queries:
            active_ids = torch.nonzero(active_blocks, as_tuple=False).flatten()
            active_ids = active_ids.to(dtype=torch.int32).contiguous()
        self.record_active_query_blocks(evaluation, active_blocks, valid_rows)
        self.active_query_plans[evaluation] = (active_blocks, active_ids)
        return active_blocks, active_ids

    @property
    def active_query_cache_ready(self) -> bool:
        """Only switch VSA/query projection paths after enough rows amortize setup."""
        return self.cache_count >= max(64, self.token_count // 4)

    @property
    def native_query_cache_ready(self) -> bool:
        """Enable native sparse attention only when at least half the rows amortize it."""
        minimum = max(64, (self.token_count + 1) // 2)
        return self.ready_count >= minimum

    def kv_only_qkv_cache_enabled(self, active_query_blocks: torch.Tensor | None) -> bool:
        """Drop cached Q only when cube-aligned blocks have sparse query masks."""
        return (
            active_query_blocks is not None
            and self.freeze_granularity.startswith("vsa_cube")
        )

    def qkv_cache_ready(self, block_index: int) -> bool:
        cache = self.qkv_outputs.get(block_index)
        return cache is not None and cache.shape[0] >= self.cache_count

    def should_bootstrap_qkv_cache(
        self, block_index: int, evaluation: int,
    ) -> bool:
        """Seed QKV only when a later evaluation can reuse the cache."""
        if not self.active_query_cache_ready or self.qkv_cache_ready(block_index):
            return False
        if int(evaluation) < self.total_steps - 1:
            return True
        self.qkv_cache_bootstrap_skipped_final = True
        return False

    def cached_tokens_for_block(self, block_index: int) -> torch.Tensor:
        del block_index  # one clean refresh makes each frozen token ready in every block
        if self.cached_token_ids is None:
            return torch.zeros(0, dtype=torch.long)
        return self.cached_token_ids

    def _ensure_block_cache(self, block_index: int, hidden_size: int, x: torch.Tensor) -> None:
        if not self.cache_count:
            return
        if (block_index in self.dense_block_cache_indices
                or (self.seed_mode == "activation" and self.ready_count == 0)):
            return
        capacity = (
            self.token_count if self.cache_count >= max(1, self.token_count // 4)
            else min(self.token_count, ((self.cache_count + 1023) // 1024) * 1024)
        )
        cache = self.block_outputs.get(block_index)
        if cache is None:
            self.block_outputs[block_index] = x.new_empty((capacity, hidden_size))
        elif cache.shape[0] < self.cache_count:
            expanded = x.new_empty((capacity, hidden_size))
            copy_rows_(expanded, cache, row_count=cache.shape[0])
            self.block_outputs[block_index] = expanded
        if block_index == 0:
            if self.dense_initial_hidden:
                return
            cache = self.initial_hidden
            if cache is None:
                self.initial_hidden = x.new_empty((capacity, hidden_size))
            elif cache.shape[0] < self.cache_count:
                expanded = x.new_empty((capacity, hidden_size))
                copy_rows_(expanded, cache, row_count=cache.shape[0])
                self.initial_hidden = expanded

    def prepare_block(
        self,
        block_index: int,
        x: torch.Tensor,
        video_span: tuple[int, int],
        *,
        input_restored_by_previous_block: bool = False,
    ) -> tuple[torch.Tensor, torch.Tensor, torch.Tensor]:
        """Restore cached inputs and return cached-row, new-row, and row indices."""
        if type(input_restored_by_previous_block) is not bool:
            raise TypeError("input_restored_by_previous_block must be a boolean")
        if input_restored_by_previous_block and block_index == 0:
            raise ValueError("the first transformer block has no previous-block output")
        start, end = video_span
        if end - start != self.token_count:
            raise ValueError("packed video rows do not match the frozen token grid")
        if self.frozen_tokens is None or self.ready_tokens is None or self.slot_by_token is None:
            empty = torch.zeros(0, dtype=torch.long, device=x.device)
            return torch.zeros(x.shape[0], dtype=torch.bool, device=x.device), empty, empty
        self.configure_layout(x.shape[0], video_span)
        cached_rows = self.cached_sequence_rows
        new_rows = self.new_sequence_rows
        assert self.cached_rows is not None and cached_rows is not None and new_rows is not None
        self._ensure_block_cache(block_index, x.shape[-1], x)
        # In the sequential H3 forward, finish_block has already put the exact
        # cached rows into the previous block's returned tensor. Re-copying
        # those rows here only applies at block zero, whose input comes from
        # the sampler and must be restored from the saved initial hidden state.
        if self.ready_count and not input_restored_by_previous_block:
            cache_in = self.initial_hidden if block_index == 0 else self.block_outputs[block_index - 1]
            if cache_in is None:
                raise RuntimeError("frozen token hidden-state cache is missing its prior block")
            if block_index == 0:
                src_rows = cached_rows - start if self.dense_initial_hidden else self.cached_slot_ids
            elif block_index - 1 in self.dense_block_cache_indices:
                src_rows = (
                    cached_rows - start
                    if block_index - 1 in self.dense_block_cache_local_indices
                    else cached_rows
                )
            else:
                src_rows = self.cached_slot_ids
            copy_rows_(x, cache_in, dst_indices=cached_rows, src_indices=src_rows)
            self.cached_block_input_rows_restored += cached_rows.numel()
        if block_index == 0 and new_rows.numel():
            if self.dense_initial_hidden:
                assert self.initial_hidden is not None
                copy_rows_(
                    self.initial_hidden, x,
                    dst_indices=new_rows - start, src_indices=new_rows,
                )
            elif self.ready_count == 0:
                # Keep the contiguous video span as a dense cache. A single
                # span copy avoids a selected-row gather and gives block 0 a
                # stable snapshot even if its implementation mutates inputs.
                self.initial_hidden = x[start:end].detach().clone()
                self.dense_initial_hidden = True
            else:
                assert self.initial_hidden is not None
                copy_rows_(
                    self.initial_hidden, x,
                    dst_indices=self.new_slot_ids, src_indices=new_rows,
                )
        return self.cached_rows, cached_rows, new_rows

    def project_active_qkv_rows(
        self, block_index: int, hidden: torch.Tensor,
        projection: Callable[[torch.Tensor], torch.Tensor], *, kv_only: bool = False,
    ) -> torch.Tensor:
        """Project live rows and publish newly accepted carriers to the layer cache.

        The result is compact in ``active_rows`` order. Consumers should gather
        only the producer chunk they need via ``gather_qkv_rows``.
        """
        if not self.cache_count or self.active_rows is None:
            return projection(hidden)
        if type(kv_only) is not bool:
            raise TypeError("kv_only must be a boolean")
        if kv_only and not self.freeze_granularity.startswith("vsa_cube"):
            raise ValueError("KV-only caching requires query-aligned VSA cube freezing")
        if hidden.ndim != 2 or hidden.shape[0] != self.sequence_length:
            raise ValueError("active QKV projection needs packed [tokens, hidden] rows")
        active = self.active_rows
        # On the first evaluation after tokens are committed, none of their
        # per-block states is ready yet, so every row remains active. Preserve
        # the contiguous hidden tensor rather than copying the whole sequence
        # through an identity index_select before the QKV projection.
        projection_input = (
            hidden if self.ready_count == 0 and active.numel() == hidden.shape[0]
            else hidden.index_select(0, active)
        )
        projected = projection(projection_input)
        if (projected.ndim != 2 or projected.shape[0] != active.numel()
                or projected.shape[1] % 3):
            raise ValueError("H3 QKV projection must return [active_rows, 3 * hidden]")
        self.capture_pending_qkv_active_rows(block_index, projected)
        width = projected.shape[1]
        cached = self.qkv_outputs.get(block_index)
        hidden_width = width // 3
        cache_width = hidden_width * 2 if kv_only else width
        capacity = (
            self.token_count if self.cache_count >= max(1, self.token_count // 4)
            else min(self.token_count, ((self.cache_count + 1023) // 1024) * 1024)
        )
        if cached is None:
            cached = projected.new_empty((capacity, cache_width))
            self.qkv_outputs[block_index] = cached
            if kv_only:
                self.kv_only_qkv_blocks.add(block_index)
        elif cached.shape[1] != cache_width:
            if kv_only and cached.shape[1] == width:
                cached = cached[:, hidden_width:].contiguous()
                self.qkv_outputs[block_index] = cached
                self.kv_only_qkv_blocks.add(block_index)
            else:
                raise ValueError("QKV cache width changed during sampling")
        if kv_only:
            self.kv_only_qkv_blocks.add(block_index)
        if cached.shape[0] < self.cache_count:
            expanded = projected.new_empty((capacity, cache_width))
            copy_rows_(expanded, cached, row_count=cached.shape[0])
            cached = expanded
            self.qkv_outputs[block_index] = cached

        # Newly accepted rows are still in this evaluation's active set. Save
        # their exact fused QKV now; finish_forward publishes them as reusable
        # only after every block has captured its corresponding carriers.
        if self.new_sequence_rows is not None and self.new_sequence_rows.numel():
            projected_cache_rows = projected[:, hidden_width:] if kv_only else projected
            if self.ready_count == 0 and active.numel() == self.sequence_length:
                # The activation evaluation projects the full sequence in
                # original row order. Scatter new carriers directly from that
                # projection instead of materializing a second large tensor.
                copy_rows_(
                    cached, projected_cache_rows,
                    dst_indices=self.new_slot_ids, src_indices=self.new_sequence_rows,
                )
            else:
                assert self.active_row_positions is not None
                active_positions = self.active_row_positions.index_select(
                    0, self.new_sequence_rows
                )
                new_values = projected_cache_rows.index_select(0, active_positions)
                copy_rows_(cached, new_values, dst_indices=self.new_slot_ids)

        self.qkv_rows_projected += active.numel()
        self.qkv_rows_reused += self.ready_count
        self.dense_qkv_materialization_bytes_avoided += (
            self.sequence_length * width * projected.element_size()
        )
        return projected

    def cache_frozen_qkv_chunk(
        self, block_index: int, projected: torch.Tensor, source_rows: torch.Tensor,
        *, kv_only: bool = False,
    ) -> None:
        """Save cached and pending frozen QKV rows from one producer chunk."""
        if (self.qkv_slot_by_sequence_row is None or self.sequence_length is None
                or not self.cache_count):
            return
        if (projected.ndim != 2 or source_rows.ndim != 1
                or projected.shape[0] != source_rows.numel()):
            raise ValueError("chunk QKV rows must align with their source sequence rows")
        if source_rows.device != projected.device:
            raise ValueError("chunk QKV source rows must share the projection device")
        if type(kv_only) is not bool:
            raise TypeError("kv_only must be a boolean")
        if kv_only and not self.freeze_granularity.startswith("vsa_cube"):
            raise ValueError("KV-only caching requires query-aligned VSA cube freezing")

        cache = self.qkv_outputs.get(block_index)
        q_width = projected.shape[1] // 3
        cache_values = projected[:, q_width:] if kv_only else projected
        cache_width = cache_values.shape[1]
        capacity = (
            self.token_count if self.cache_count >= max(1, self.token_count // 4)
            else min(self.token_count, ((self.cache_count + 1023) // 1024) * 1024)
        )
        if cache is None:
            cache = projected.new_empty((capacity, cache_width))
            self.qkv_outputs[block_index] = cache
            self.qkv_rows_projected += self.sequence_length
            self.dense_qkv_materialization_bytes_avoided += (
                self.sequence_length * cache_width * projected.element_size()
            )
        elif cache.shape[1] != cache_width:
            if kv_only and cache.shape[1] == projected.shape[1]:
                cache = cache[:, q_width:].contiguous()
                self.qkv_outputs[block_index] = cache
                self.kv_only_qkv_blocks.add(block_index)
            else:
                raise ValueError("QKV cache width changed during sampling")
        if kv_only:
            self.kv_only_qkv_blocks.add(block_index)
        if cache.shape[0] < self.cache_count:
            expanded = projected.new_empty((capacity, cache_width))
            copy_rows_(expanded, cache, row_count=cache.shape[0])
            cache = expanded
            self.qkv_outputs[block_index] = cache

        safe_rows = source_rows.clamp_min(0).to(torch.long)
        destination_slots = self.qkv_slot_by_sequence_row.index_select(0, safe_rows)
        destination_slots.masked_fill_(source_rows < 0, -1)
        scatter_selected_rows_(cache, cache_values, destination_slots)

    def gather_qkv_rows(
        self, block_index: int, active_projection: torch.Tensor, source_rows: torch.Tensor
    ) -> torch.Tensor:
        """Assemble one VSA producer chunk from live projections and cached rows."""
        if source_rows.ndim != 1 or source_rows.dtype not in (torch.int32, torch.int64):
            raise ValueError("producer source rows must be a one-dimensional integer tensor")
        if source_rows.device != active_projection.device:
            raise ValueError("producer source rows must be on the projection device")
        if (self.cached_slot_by_sequence_row is None or self.active_row_positions is None
                or self.sequence_length is None):
            raise RuntimeError("sequence row maps are unavailable for active QKV packing")
        if self.ready_count == 0 and active_projection.shape[0] == self.sequence_length:
            # No frozen carriers are reusable during activation. The active
            # projection already holds every sequence row, so avoid the
            # cache-slot gathers and two full chunk-sized where intermediates.
            valid = (source_rows >= 0) & (source_rows < self.sequence_length)
            safe_rows = source_rows.clamp(0, self.sequence_length - 1).to(torch.long)
            gathered = active_projection.index_select(0, safe_rows)
            gathered.masked_fill_(~valid[:, None], 0)
            self.qkv_chunk_gather_rows += source_rows.numel()
            return gathered
        valid = (source_rows >= 0) & (source_rows < self.sequence_length)
        safe_rows = source_rows.clamp(0, self.sequence_length - 1).to(torch.long)
        cached_slots = self.cached_slot_by_sequence_row.index_select(0, safe_rows)
        cached_rows = valid & (cached_slots >= 0)
        active_positions = self.active_row_positions.index_select(0, safe_rows)
        torch._assert_async(
            ~(valid & ~cached_rows & (active_positions < 0)).any(),
            "live producer row is absent from the active QKV projection",
        )
        cache = self.qkv_outputs.get(block_index)
        if cache is None:
            raise RuntimeError("layer QKV cache is unavailable for frozen producer rows")
        cached_slots.masked_fill_(~cached_rows, -1)
        active_positions.masked_fill_(~valid | cached_rows, -1)
        if block_index in self.kv_only_qkv_blocks:
            result = gather_cached_kv_active_qkv(
                cache, active_projection, cached_slots, active_positions
            )
        else:
            result = gather_cached_active_rows(
                cache, active_projection, cached_slots, active_positions
            )
        trace_callback = getattr(self, "debug_qkv_trace", None)
        if callable(trace_callback):
            trace_callback(block_index, source_rows, result)
        self.qkv_chunk_gather_rows += source_rows.numel()
        return result

    def project_qkv_rows(
        self, block_index: int, hidden: torch.Tensor,
        projection: Callable[[torch.Tensor], torch.Tensor],
    ) -> torch.Tensor:
        """Compatibility helper that reconstructs the historical dense tensor."""
        if block_index in self.kv_only_qkv_blocks:
            raise RuntimeError("dense QKV reconstruction is unavailable after KV-only caching")
        projected = self.project_active_qkv_rows(block_index, hidden, projection)
        if not self.cache_count or self.active_rows is None:
            return projected
        assert self.sequence_length is not None
        result = projected.new_zeros((self.sequence_length, projected.shape[1]))
        result.index_copy_(0, self.active_rows, projected)
        if self.ready_count:
            assert self.cached_sequence_rows is not None and self.cached_slot_ids is not None
            cache = self.qkv_outputs[block_index]
            copy_rows_(result, cache, dst_indices=self.cached_sequence_rows,
                       src_indices=self.cached_slot_ids)
        return result

    def finish_block(
        self,
        block_index: int,
        new_inputs: torch.Tensor | None,
        outputs: torch.Tensor,
        cached_rows: torch.Tensor,
        new_rows: torch.Tensor,
    ) -> None:
        dense_cache = block_index in self.dense_block_cache_indices
        if new_rows.numel() and not dense_cache and self.ready_count == 0:
            # This is the first full activation pass. Retaining the output
            # tensor removes a compact gather/scatter for every transformer
            # block; later block inputs can address the frozen sequence rows
            # directly. The reference is replaced by each subsequent forward
            # after cached rows have been restored into that forward's output.
            self.block_outputs[block_index] = outputs.detach()
            self.dense_block_cache_indices.add(block_index)
            dense_cache = True
        if new_rows.numel() and not dense_cache:
            slots = self.new_slot_ids
            if block_index == 0:
                assert self.initial_hidden is not None
                if new_inputs is not None:
                    copy_rows_(self.initial_hidden, new_inputs, dst_indices=slots)
            copy_rows_(
                self.block_outputs[block_index], outputs,
                dst_indices=slots, src_indices=new_rows,
            )
        if cached_rows.numel():
            if dense_cache and block_index in self.dense_block_cache_local_indices:
                if self.video_span is None:
                    raise RuntimeError("dense video cache has no packed sequence span")
                src_rows = cached_rows - self.video_span[0]
            else:
                assert self.cached_slot_ids is not None
                src_rows = cached_rows if dense_cache else self.cached_slot_ids
            copy_rows_(
                outputs, self.block_outputs[block_index],
                dst_indices=cached_rows, src_indices=src_rows,
            )
        if dense_cache:
            # Keep a reference to this pass's complete, corrected output. It
            # includes newly accepted rows plus exact restored rows for tokens
            # already cached.
            self.block_outputs[block_index] = outputs.detach()
            self.dense_block_cache_local_indices.discard(block_index)

    def report(self) -> dict[str, object]:
        total = self.token_count
        committed_steps = []
        # Accepted step k can only be skipped starting at k+1 because this
        # activation mode builds reusable clean hidden state on the next pass.
        activation_delay = 1 if self.seed_mode == "activation" else 0
        for step, count in enumerate(self.accepted_per_step, start=1):
            committed_steps.extend([
                min(step + activation_delay, self.total_steps)
            ] * count)
        remaining = max(0, total - len(committed_steps))
        committed_steps.extend([self.total_steps] * remaining)
        baseline_evaluations = total * self.total_steps
        effective_evaluations = sum(committed_steps)
        query_blocks_skipped = sum(
            total_blocks - int(active_blocks.item())
            for active_blocks, total_blocks, _rows_skipped in self.query_blocks_per_eval.values()
        )
        query_rows_skipped = sum(
            int(rows_skipped.item()) for _active, _total, rows_skipped
            in self.query_blocks_per_eval.values()
        )
        return {
            "schema": "comfystream/speculative-forcing-freeze/1",
            "threshold": self.threshold,
            "steps": self.total_steps,
            "stability_observations_required": self.stability_observations,
            "stability_mode": self.stability_mode,
            "freeze_granularity": self.freeze_granularity,
            "early_threshold": self.early_threshold,
            "early_accepted_per_step": self.early_accepted_per_step,
            "seed_mode": self.seed_mode,
            "previous_forward_seed_tokens": self.previous_forward_seed_tokens,
            "previous_forward_seed_fallbacks": self.previous_forward_seed_fallbacks,
            "tokens": total,
            "accepted_per_step": self.accepted_per_step,
            "active_video_tokens_per_eval": self.active_video_tokens_per_eval,
            "mean_effective_denoising_evals_per_token": (
                effective_evaluations / total if total else float(self.total_steps)
            ),
            "estimated_token_eval_reduction_fraction": (
                1.0 - effective_evaluations / baseline_evaluations
                if baseline_evaluations else 0.0
            ),
            "ffn_rows_skipped": self.ffn_rows_skipped,
            "patch_lifecycle": "comfy-object-patches-v1",
            "execution_optimization": "fused-row-plan-dynamic-fp4-v2",
            "out_projection_rows_skipped": self.out_projection_rows_skipped,
            "cached_block_input_rows_restored": self.cached_block_input_rows_restored,
            "qkv_rows_projected": self.qkv_rows_projected,
            "qkv_rows_reused": self.qkv_rows_reused,
            "kv_only_qkv_blocks": len(self.kv_only_qkv_blocks),
            "dense_qkv_materialization_bytes_avoided": (
                self.dense_qkv_materialization_bytes_avoided
            ),
            "qkv_chunk_gather_rows": self.qkv_chunk_gather_rows,
            "qkv_cache_bootstrap_skipped_final": self.qkv_cache_bootstrap_skipped_final,
            "previous_forward_kv_seed_tokens": self.previous_forward_kv_seed_tokens,
            "qkv_preseed_candidate_preparations": self.pending_qkv_candidate_preparations,
            "qkv_preseed_candidate_rows": self.pending_qkv_candidate_rows,
            "qkv_preseed_layer_capture_blocks": sorted(self.pending_qkv_layer_capture_blocks),
            "qkv_preseed_commit_attempts": self.pending_qkv_commit_attempts,
            "qkv_preseed_commit_skips": dict(self.pending_qkv_commit_skips),
            "qkv_preseed_commit_captured_layers": (
                self.pending_qkv_commit_captured_layer_count
            ),
            "qkv_preseed_commit_missing_layers": (
                self.pending_qkv_commit_missing_layers
            ),
            "qkv_preseed_commit_missing_candidate_counts": (
                self.pending_qkv_commit_missing_candidate_counts
            ),
            "qkv_preseed_commit_missing_candidate_ids": (
                self.pending_qkv_commit_missing_candidate_ids
            ),
            "qkv_preseed_commit_mismatched_token_count": (
                self.pending_qkv_commit_mismatched_token_count
            ),
            "qkv_preseed_commit_mismatched_token_ids": (
                self.pending_qkv_commit_mismatched_token_ids
            ),
            "qkv_preseed_repaired_token_rows": self.pending_qkv_repaired_token_rows,
            "qkv_preseed_carrier_parity_relative_error": (
                self.pending_qkv_parity_relative_error
            ),
            "qkv_preseed_missing_capture_attempts": self.pending_qkv_missing_capture_attempts,
            "qkv_preseed_missing_capture_skips": dict(self.pending_qkv_missing_capture_skips),
            "qkv_preseed_missing_capture_last_shape": (
                self.pending_qkv_missing_capture_last_shape
            ),
            "qkv_preseed_missing_capture_last_rows": self.pending_qkv_missing_capture_last_rows,
            "qkv_preseed_missing_capture_snapshot_counts": dict(
                self.pending_qkv_missing_capture_snapshot_counts
            ),
            "qkv_preseed_commit_capture_slot_counts": (
                self.pending_qkv_commit_capture_slot_counts
            ),
            "qkv_preseed_commit_capture_enabled": getattr(
                self, "pending_qkv_commit_capture_enabled", False
            ),
            "qkv_preseed_commit_candidate_count": getattr(
                self, "pending_qkv_commit_candidate_count", 0
            ),
            "qkv_preseed_commit_capture_step": getattr(
                self, "pending_qkv_commit_capture_step", None
            ),
            "qkv_preseed_commit_step_capture_blocks": getattr(
                self, "pending_qkv_commit_step_capture_blocks", []
            ),
            "qkv_preseed_commit_step_chunk_capture_calls": getattr(
                self, "pending_qkv_commit_step_chunk_capture_calls", 0
            ),
            "qkv_preseed_commit_step_dense_projection_calls": getattr(
                self, "pending_qkv_commit_step_dense_projection_calls", 0
            ),
            "qkv_preseed_chunk_capture_calls": self.pending_qkv_chunk_capture_calls,
            "qkv_preseed_disabled_chunk_capture_calls": (
                self.pending_qkv_disabled_chunk_capture_calls
            ),
            "qkv_preseed_active_capture_calls": self.pending_qkv_active_capture_calls,
            "qkv_preseed_dense_projection_calls": self.pending_qkv_dense_projection_calls,
            "qkv_preseed_dense_projection_shapes": sorted(
                self.pending_qkv_dense_projection_shapes
            ),
            "qkv_bootstrap_projection_rows_avoided": (
                self.qkv_bootstrap_projection_rows_avoided
            ),
            "vsa_query_blocks_skipped": query_blocks_skipped * self.transformer_blocks,
            "producer_query_prep_skipped_blocks": (
                query_blocks_skipped * self.transformer_blocks
            ),
            "producer_query_prep_skip_enabled": bool(self.query_blocks_per_eval),
            "vsa_query_rows_skipped": query_rows_skipped * self.transformer_blocks,
            "vsa_query_blocks_launched": sum(
                int(active_ids.numel()) if active_ids is not None else
                int(self.query_blocks_per_eval[evaluation][0].item())
                for evaluation, (_mask, active_ids) in self.active_query_plans.items()
            ) * self.transformer_blocks,
            "active_query_blocks_enabled": bool(self.query_blocks_per_eval),
            "query_execution_mode": (
                "compact" if self.compact_active_queries else
                "masked" if self.query_blocks_per_eval else "disabled"
            ),
            "active_query_kernel": (
                "sol-attn-native-compact-v1"
                if any(active_ids is not None for _, active_ids in self.active_query_plans.values()) else
                "sol-attn-native-mask-v1" if self.query_blocks_per_eval else None
            ),
            "context_strategy": (
                "per-layer hidden-state and K/V reuse; Q omitted for frozen cube-aligned blocks"
                if self.kv_only_qkv_blocks else
                "per-layer hidden-state and Q/K/V reuse; full K/V context with frozen VSA query blocks skipped"
                if self.query_blocks_per_eval else
                "per-layer hidden-state reuse; VSA processes the full query sequence"
            ),
            "dense_reference": self.dense_reference,
        }


def _selective_linear(
    module: object, original: Callable[[torch.Tensor], torch.Tensor],
    x: torch.Tensor, kind: str,
) -> torch.Tensor:
    active = _ACTIVE_ROWS.get()
    if active is None or x.ndim < 2:
        return original(x)
    state = _ACTIVE_FREEZE.get()
    if state is None:
        return original(x)
    # H3's attention output projection receives [sequence, hidden], while its
    # MLP uses a batch-one 3D layout. Active-row indices address the packed
    # sequence dimension, which may be either leading dimension in 3D tensors.
    row_count = prod(x.shape[:-1])
    if active.numel() >= row_count:
        return original(x)
    sequence_dims = [
        dim for dim, size in enumerate(x.shape[:-1])
        if size == row_count
        and prod(size for i, size in enumerate(x.shape[:-1]) if i != dim) == 1
    ]
    if len(sequence_dims) != 1:
        return original(x)
    sequence_dim = sequence_dims[0]

    def capture_debug(selected_input: torch.Tensor, selected_output: torch.Tensor) -> None:
        callback = state.debug_linear_trace
        block_index = _ACTIVE_BLOCK_INDEX.get()
        if (not callable(callback) or state.cache_count == 0 or state.ready_count == 0
                or block_index is None or block_index >= 4 or state.video_span is None):
            return
        start, end = state.video_span
        video_rows = active[(active >= start) & (active < end)]
        if not video_rows.numel():
            return
        video_selection = ((active >= start) & (active < end)).nonzero(
            as_tuple=False
        ).flatten()
        left = selected_input.reshape(-1, selected_input.shape[-1]).index_select(
            0, video_selection
        )
        right = selected_output.reshape(-1, selected_output.shape[-1]).index_select(
            0, video_selection
        )
        callback(block_index, kind, left, right)

    if state.dense_reference:
        if active.numel() < row_count:
            dense_selected_input = x.index_select(sequence_dim, active)
        else:
            dense_selected_input = x
        fc1 = getattr(module, "fc1", None)
        if (kind == "mlp"
                and getattr(fc1, "_nvfp4_layout", None) == "TensorCoreNVFP4Layout"
                and active.numel() < row_count):
            try:
                from .precision import nvfp4_input_scale_override, nvfp4_tensor_scale
            except ImportError:  # Standalone custom-node test imports.
                from precision import (  # type: ignore[no-redef]
                    nvfp4_input_scale_override,
                    nvfp4_tensor_scale,
                )
            with nvfp4_input_scale_override(nvfp4_tensor_scale(dense_selected_input)):
                result = original(x)
        else:
            result = original(x)
        if active.numel() < row_count:
            capture_debug(
                dense_selected_input,
                result.index_select(sequence_dim, active),
            )
        return result

    skipped = row_count - active.numel()
    if skipped <= 0:
        return original(x)
    if kind == "mlp":
        state.ffn_rows_skipped += skipped
    else:
        state.out_projection_rows_skipped += skipped
    selected_input = x.index_select(sequence_dim, active)
    fc1 = getattr(module, "fc1", None)
    if (kind == "mlp"
            and getattr(fc1, "_nvfp4_layout", None) == "TensorCoreNVFP4Layout"):
        try:
            from .precision import nvfp4_input_scale_override, nvfp4_tensor_scale
        except ImportError:  # Standalone custom-node test imports.
            from precision import (  # type: ignore[no-redef]
                nvfp4_input_scale_override,
                nvfp4_tensor_scale,
            )
        # NVFP4's FC1 activation scale is global over the row batch. Keep the
        # live-row batch's scale explicit while projecting only live rows.
        active_input_scale = nvfp4_tensor_scale(selected_input)
        with nvfp4_input_scale_override(active_input_scale):
            selected = original(selected_input)
    else:
        selected = original(selected_input)
    capture_debug(selected_input, selected)
    output_shape = list(x.shape)
    output_shape[-1] = selected.shape[-1]
    if state.active_row_positions is not None:
        return scatter_active_rows(
            selected.reshape(-1, selected.shape[-1]), state.active_row_positions
        ).reshape(output_shape)
    output = selected.new_zeros(output_shape)
    output.index_copy_(sequence_dim, active, selected)
    return output


@contextmanager
def install_token_freezing(
    model_patcher: object, controller: TokenFreezeController,
) -> Iterator[TokenFreezeController]:
    """Install request-scoped H3 block reuse and restore every patched method."""
    get_model_object = getattr(model_patcher, "get_model_object", None)
    if not callable(get_model_object):
        raise TypeError("token freezing needs a Comfy ModelPatcher")
    diffusion = get_model_object("diffusion_model")
    blocks = getattr(diffusion, "blocks", None)
    if blocks is None or not len(blocks):
        raise TypeError("token freezing only supports the packed MiniMax-H3 transformer")
    controller.transformer_blocks = len(blocks)

    # Comfy owns these mutable monkeypatch targets and their preexisting values.
    restores: list[tuple[object, str, object, str, object, object]] = []
    controller.pending_qkv_repair_projections = [None] * len(blocks)
    missing = object()
    object_patches = getattr(model_patcher, "object_patches", None)
    object_backups = getattr(model_patcher, "object_patches_backup", None)
    add_object_patch = getattr(model_patcher, "add_object_patch", None)

    def effective_forward(obj: object, path: str) -> object:
        if isinstance(object_patches, dict) and path in object_patches:
            forward = get_model_object(path)
        else:
            forward = cast(_ForwardOwner, obj).forward
        return forward

    def replace(obj: object, name: str, new: object, path: str) -> None:
        old = getattr(obj, name)
        old_patch = object_patches.get(path, missing) if isinstance(object_patches, dict) else missing
        old_backup = object_backups.get(path, missing) if isinstance(object_backups, dict) else missing
        restores.append((obj, name, old, path, old_patch, old_backup))
        # Comfy reapplies registered forwards while loading the model inside
        # sampling. Register our composed wrapper there as well as updating
        # the live method, so the fused MLP cannot overwrite token freezing.
        if callable(add_object_patch) and isinstance(object_patches, dict):
            add_object_patch(path, new)
        setattr(obj, name, new)

    original_model_forward = cast(_ModelForward, effective_forward(
        diffusion, "diffusion_model.forward"
    ))

    def model_forward(
        x: _TensorStreams, timestep: torch.Tensor, context: torch.Tensor,
        transformer_options: dict[str, object] | None = None, minimax_payload: object = None,
        denoise_mask: torch.Tensor | None = None, audio_denoise_mask: torch.Tensor | None = None,
        **kwargs: object,
    ) -> object:
        video = x[0]
        # RES updates its state after invoking the sampler callback. Restore
        # committed rows here so clean refresh and cached blocks see the x0.
        controller.project_committed_video(video)
        active_mask = controller.active_denoise_mask(video, denoise_mask)
        controller.begin_forward()
        trace_callback = controller.debug_model_input_trace
        if callable(trace_callback):
            trace_callback(
                x, timestep, context, transformer_options, minimax_payload,
                active_mask, audio_denoise_mask,
            )
        output = original_model_forward(
            x, timestep, context, transformer_options=transformer_options,
            minimax_payload=minimax_payload, denoise_mask=active_mask,
            audio_denoise_mask=audio_denoise_mask, **kwargs,
        )
        controller.finish_forward()
        return output

    token = None
    try:
        replace(diffusion, "forward", model_forward, "diffusion_model.forward")
        for block_index, block in enumerate(blocks):
            block_path = f"diffusion_model.blocks.{block_index}"
            attention = getattr(block, "attn", None)
            qkv_projection = getattr(attention, "qkv_proj", None)
            if qkv_projection is not None:
                qkv_path = f"{block_path}.attn.qkv_proj.forward"
                original_qkv_forward = cast(Callable[[torch.Tensor], torch.Tensor], effective_forward(
                    qkv_projection, qkv_path
                ))
                controller.pending_qkv_repair_projections[block_index] = (
                    original_qkv_forward
                )

                def qkv_forward(
                    x: torch.Tensor, *, _index: int = block_index,
                    _original: Callable[[torch.Tensor], torch.Tensor] = original_qkv_forward,
                ) -> torch.Tensor:
                    projected = _original(x)
                    state = _ACTIVE_FREEZE.get()
                    if state is not None:
                        source_rows = state.pop_pending_qkv_projection_source_rows(_index)
                        if source_rows is not None:
                            state.capture_pending_qkv_chunk(
                                _index, projected, source_rows,
                            )
                        elif (state.active_rows is not None
                              and projected.ndim == 2
                              and projected.shape[0] == state.active_rows.numel()):
                            state.capture_pending_qkv_active_rows(_index, projected)
                        else:
                            state.capture_pending_qkv_dense_projection(_index, projected)
                    return projected

                replace(qkv_projection, "forward", qkv_forward, qkv_path)
            original_block_forward = cast(_BlockForward, effective_forward(
                block, f"{block_path}.forward"
            ))

            def block_forward(
                x: torch.Tensor, t_emb: torch.Tensor, mod_segments: object, rope_freqs: object,
                transformer_options: dict[str, object] | None = None, attention: object = None,
                *, _index: int = block_index,
                _original: _BlockForward = original_block_forward,
            ) -> torch.Tensor:
                state = _ACTIVE_FREEZE.get()
                options = transformer_options or {}
                span = options.get("sol_h3_video_span")
                if state is None or span is None:
                    return _original(x, t_emb, mod_segments, rope_freqs,
                                     transformer_options=transformer_options, attention=attention)
                typed_span = cast(tuple[int, int], span)
                video_span = (int(typed_span[0]), int(typed_span[1]))
                if state.cache_count == 0:
                    if not state.should_capture_previous_hidden:
                        result = _original(
                            x, t_emb, mod_segments, rope_freqs,
                            transformer_options=transformer_options, attention=attention,
                        )
                        return result
                    state.configure_layout(x.shape[0], video_span)
                    start, end = video_span
                    state.capture_previous_forward_block_input(_index, x[start:end])
                    result = _original(
                        x, t_emb, mod_segments, rope_freqs,
                        transformer_options=transformer_options, attention=attention,
                    )
                    state.capture_previous_forward_block_output(_index, result[start:end])
                    return result
                state.configure_layout(x.shape[0], video_span)
                assert state.video_span is not None
                row_mask, cached_rows, new_rows = state.prepare_block(
                    _index, x, state.video_span,
                    input_restored_by_previous_block=_index > 0,
                )
                trace_callback = getattr(state, "debug_block_trace", None)
                if (
                    state.cache_count > 0
                    and state.ready_count > 0
                    and callable(trace_callback)
                ):
                    trace_callback(_index, "input", x)
                start, end = video_span
                state.capture_previous_forward_block_input(_index, x[start:end])
                cached_token = _CACHED_ROWS.set(row_mask)
                active_token = _ACTIVE_ROWS.set(state.active_rows)
                block_token = _ACTIVE_BLOCK_INDEX.set(_index)
                try:
                    result = _original(
                        x, t_emb, mod_segments, rope_freqs,
                        transformer_options=transformer_options, attention=attention,
                    )
                finally:
                    _ACTIVE_BLOCK_INDEX.reset(block_token)
                    _ACTIVE_ROWS.reset(active_token)
                    _CACHED_ROWS.reset(cached_token)
                state.finish_block(_index, None, result, cached_rows, new_rows)
                if callable(trace_callback) and state.cache_count > 0 and state.ready_count > 0:
                    trace_callback(_index, "output", result)
                state.capture_previous_forward_block_output(_index, result[start:end])
                return result

            replace(block, "forward", block_forward, f"{block_path}.forward")
            for module in (block.mlp, block.attn.out_proj):
                kind = "mlp" if module is block.mlp else "out_proj"
                module_path = f"{block_path}.{'mlp' if kind == 'mlp' else 'attn.out_proj'}.forward"
                original_forward = cast(Callable[[torch.Tensor], torch.Tensor], effective_forward(module, module_path))

                def linear_forward(
                    x: torch.Tensor, *, _module: object = module,
                    _original: Callable[[torch.Tensor], torch.Tensor] = original_forward, _kind: str = kind,
                ) -> torch.Tensor:
                    return _selective_linear(_module, _original, x, _kind)

                replace(module, "forward", linear_forward, module_path)

        token = _ACTIVE_FREEZE.set(controller)
        yield controller
    finally:
        if token is not None:
            _ACTIVE_FREEZE.reset(token)
        for obj, name, old, path, old_patch, old_backup in reversed(restores):
            setattr(obj, name, old)
            for mapping, value in ((object_patches, old_patch), (object_backups, old_backup)):
                if isinstance(mapping, dict):
                    if value is missing:
                        mapping.pop(path, None)
                    else:
                        mapping[path] = value


def active_freeze_state() -> TokenFreezeController | None:
    return _ACTIVE_FREEZE.get()


def active_freeze_block_index() -> int | None:
    return _ACTIVE_BLOCK_INDEX.get()
