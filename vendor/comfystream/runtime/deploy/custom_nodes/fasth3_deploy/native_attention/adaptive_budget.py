"""Per-query FastH3 VSA budget allocator and GPU-resident fast path.

The deterministic CPU implementation is the reference policy. The device
implementation applies the same water-filling choices without copying the
score matrix to the host. Rows represent one video query cube/head each, and
keys are eligible video KV cubes. Prefix keys are handled by the caller.
Scores are raw log2 routing logits, not attention probabilities.
"""

from __future__ import annotations

from typing import TYPE_CHECKING

if TYPE_CHECKING:
    import torch

    from .runtime import Prepared

import heapq
import math
from collections.abc import Sequence

MAX_ADAPTIVE_SCORE_BYTES = 32 * 1024 * 1024


def video_cube_coordinate(
    block_id: int, prefix_blocks: int, cube_grid: Sequence[int],
) -> tuple[int, int, int]:
    """Map a VSA video block ID to its time/height/width cube coordinates."""
    cube_grid = tuple(cube_grid)
    if len(cube_grid) != 3 or any(type(value) is not int or value <= 0 for value in cube_grid):
        raise ValueError("cube_grid must contain three positive integers")
    index = int(block_id) - int(prefix_blocks)
    total = math.prod(cube_grid)
    if not 0 <= index < total:
        raise ValueError("block_id is outside the video cube grid")
    _time_cubes, height_cubes, width_cubes = cube_grid
    time_id, spatial = divmod(index, height_cubes * width_cubes)
    height_id, width_id = divmod(spatial, width_cubes)
    return time_id, height_id, width_id


def allocate_query_budget(
    scores: Sequence[Sequence[float]],
    eligible: Sequence[Sequence[bool]],
    mandatory: Sequence[Sequence[bool]],
    *,
    target_total: int,
    min_counts: Sequence[int] | None = None,
    max_counts: Sequence[int] | None = None,
) -> tuple[tuple[int, ...], ...]:
    """Allocate an exact count of video KV keys across query/head rows.

    Every row starts with its mandatory keys and enough high-score keys to meet
    its lower bound. Remaining slots go to the eligible row with the lowest
    retained normalized proxy-score mass. Ties prefer the lower row ID, then
    the lower key ID. This is deterministic water filling, not an optimality
    guarantee. Prefix keys are outside this budget and should be retained by
    the caller exactly as in FastH3 VSA.
    """
    scores = tuple(tuple(float(value) for value in row) for row in scores)
    eligible = tuple(tuple(bool(value) for value in row) for row in eligible)
    mandatory = tuple(tuple(bool(value) for value in row) for row in mandatory)
    row_count = len(scores)
    if not row_count or len(eligible) != row_count or len(mandatory) != row_count:
        raise ValueError("scores, eligible, and mandatory must have the same nonzero row count")
    key_count = len(scores[0])
    if key_count == 0 or any(len(row) != key_count for row in (*scores, *eligible, *mandatory)):
        raise ValueError("all score and mask rows must share a nonzero key count")
    if type(target_total) is not int or target_total < 0:
        raise ValueError("target_total must be a nonnegative integer")

    if min_counts is None:
        min_counts = tuple(sum(row) for row in mandatory)
    else:
        min_counts = tuple(min_counts)
    if max_counts is None:
        max_counts = tuple(sum(row) for row in eligible)
    else:
        max_counts = tuple(max_counts)
    if len(min_counts) != row_count or len(max_counts) != row_count:
        raise ValueError("min_counts and max_counts must have one value per row")

    ranked: list[tuple[int, ...]] = []
    weights: list[tuple[float, ...]] = []
    lower: list[int] = []
    upper: list[int] = []
    for row_id in range(row_count):
        valid_ids = [key_id for key_id, valid in enumerate(eligible[row_id]) if valid]
        mandatory_ids = [key_id for key_id, required in enumerate(mandatory[row_id]) if required]
        if any(not eligible[row_id][key_id] for key_id in mandatory_ids):
            raise ValueError("mandatory keys must be eligible")
        if any(not math.isfinite(scores[row_id][key_id]) for key_id in valid_ids):
            raise ValueError("eligible routing scores must be finite")
        if any(math.isnan(value) or value == math.inf for value in scores[row_id]):
            raise ValueError("routing scores must not contain NaN or positive infinity")

        row_min, row_max = min_counts[row_id], max_counts[row_id]
        if type(row_min) is not int or type(row_max) is not int:
            raise ValueError("per-row count bounds must be integers")
        row_min = max(row_min, len(mandatory_ids))
        if row_min < 0 or row_max < row_min or row_max > len(valid_ids):
            raise ValueError("per-row count bounds are infeasible for eligible keys")
        if row_min > len(valid_ids):
            raise ValueError("lower bound exceeds eligible key count")

        # Stable score order is shared by initialization and all later adds.
        order = tuple(sorted(valid_ids, key=lambda key_id: (-scores[row_id][key_id], key_id)))
        ranked.append(order)
        lower.append(row_min)
        upper.append(row_max)

        # Normalize raw log2 routing logits without overflowing. Ineligible
        # keys have zero mass, including negative-infinity padding sentinels.
        if valid_ids:
            maximum = max(scores[row_id][key_id] for key_id in valid_ids)
            row_weights = tuple(
                math.exp2(scores[row_id][key_id] - maximum) if eligible[row_id][key_id] else 0.0
                for key_id in range(key_count)
            )
        else:
            row_weights = (0.0,) * key_count
        weights.append(row_weights)

    if sum(lower) > target_total:
        raise ValueError("target_total is below the mandatory/lower-bound count")
    if sum(upper) < target_total:
        raise ValueError("target_total exceeds the eligible/upper-bound count")

    selected: list[set[int]] = []
    for row_id in range(row_count):
        chosen = {key_id for key_id, required in enumerate(mandatory[row_id]) if required}
        for key_id in ranked[row_id]:
            if len(chosen) >= lower[row_id]:
                break
            chosen.add(key_id)
        selected.append(chosen)

    remaining = target_total - sum(map(len, selected))
    denominators = [sum(row) for row in weights]
    retained_mass = [
        sum(weights[row_id][key_id] for key_id in selected[row_id])
        for row_id in range(row_count)
    ]
    next_positions = []
    heap = []
    for row_id in range(row_count):
        position = 0
        while position < len(ranked[row_id]) and ranked[row_id][position] in selected[row_id]:
            position += 1
        next_positions.append(position)
        if len(selected[row_id]) < upper[row_id] and position < len(ranked[row_id]):
            denominator = denominators[row_id]
            coverage = retained_mass[row_id] / denominator if denominator else 0.0
            heap.append((coverage, row_id))
    heapq.heapify(heap)

    # This is the same deterministic water-filling choice as scanning every
    # row after every slot, but the heap avoids that O(budget × rows) rescan.
    while remaining:
        if not heap:
            raise ValueError("unable to allocate target_total under the supplied bounds")
        _, row_id = heapq.heappop(heap)
        position = next_positions[row_id]
        while position < len(ranked[row_id]) and ranked[row_id][position] in selected[row_id]:
            position += 1
        if position >= len(ranked[row_id]):
            raise ValueError("unable to allocate target_total under the supplied bounds")
        key_id = ranked[row_id][position]
        selected[row_id].add(key_id)
        next_positions[row_id] = position + 1
        retained_mass[row_id] += weights[row_id][key_id]
        remaining -= 1
        if len(selected[row_id]) < upper[row_id] and next_positions[row_id] < len(ranked[row_id]):
            denominator = denominators[row_id]
            coverage = retained_mass[row_id] / denominator if denominator else 0.0
            heapq.heappush(heap, (coverage, row_id))

    return tuple(tuple(sorted(row)) for row in selected)


def allocate_query_budget_torch(scores: torch.Tensor, eligible: torch.Tensor, mandatory: torch.Tensor, target_total: torch.Tensor) -> torch.Tensor:
    """GPU-friendly water filling over [heads, queries, keys] score tensors.

    The CPU reference repeatedly pops the least-covered query from a heap.
    Since each query's retained normalized score mass increases monotonically
    as its keys are added in descending score order, the same deterministic
    choices are the first ``target_total - mandatory`` events in a stable sort
    of every query's pre-add coverage. This turns the Python per-slot loop into
    device-side row sorts, prefix sums, and one stable event sort.

    ``target_total`` is a per-head tensor so the fast path never synchronizes
    the GPU to discover a Python scalar.
    """
    import torch

    if scores.ndim != 3:
        raise ValueError("scores must have shape [heads, queries, keys]")
    heads, queries, keys = scores.shape
    if tuple(eligible.shape) not in ((queries, keys), (heads, queries, keys)):
        raise ValueError("eligible must have shape [queries, keys] or [heads, queries, keys]")
    if tuple(mandatory.shape) not in ((queries, keys), (heads, queries, keys)):
        raise ValueError("mandatory must have shape [queries, keys] or [heads, queries, keys]")
    if scores.device != eligible.device or scores.device != mandatory.device:
        raise ValueError("scores and masks must be on the same device")
    if target_total.ndim != 1 or target_total.numel() != heads:
        raise ValueError("target_total must have one value per head")

    eligible = eligible.to(dtype=torch.bool)
    mandatory = mandatory.to(dtype=torch.bool)
    if eligible.ndim == 2:
        eligible = eligible.unsqueeze(0).expand(heads, -1, -1)
    if mandatory.ndim == 2:
        mandatory = mandatory.unsqueeze(0).expand(heads, -1, -1)
    candidate = eligible & ~mandatory

    # Use float64 for the proxy masses to preserve the reference's exp2
    # coverage ordering; routing logits and their ranking remain float32.
    logits = scores.to(torch.float64)
    masked_logits = logits.masked_fill(~eligible, -torch.inf)
    row_max = masked_logits.amax(dim=-1, keepdim=True)
    row_max = torch.where(torch.isfinite(row_max), row_max, torch.zeros_like(row_max))
    weights = torch.exp2(masked_logits - row_max)
    denominator = weights.sum(dim=-1, keepdim=True)
    safe_denominator = denominator.clamp_min(torch.finfo(torch.float64).tiny)
    mandatory_mass = (weights * mandatory).sum(dim=-1, keepdim=True)

    # Stable key ordering matches the CPU reference's (-score, key_id) order.
    candidate_logits = logits.masked_fill(~candidate, -torch.inf)
    ranked_logits, ranked_keys = torch.sort(
        candidate_logits, dim=-1, descending=True, stable=True,
    )
    ranked_valid = torch.isfinite(ranked_logits)
    ranked_weights = weights.gather(-1, ranked_keys).masked_fill(~ranked_valid, 0.0)
    cumulative_before = torch.cumsum(ranked_weights, dim=-1) - ranked_weights
    coverage_events = (mandatory_mass + cumulative_before) / safe_denominator
    coverage_events = coverage_events.masked_fill(~ranked_valid, torch.inf)

    event_count = queries * keys
    event_order = torch.argsort(
        coverage_events.reshape(heads, event_count), dim=-1, stable=True,
    )
    event_rank = torch.empty_like(event_order)
    event_rank.scatter_(
        1,
        event_order,
        torch.arange(event_count, device=scores.device, dtype=event_order.dtype)
        .expand_as(event_order),
    )
    mandatory_total = mandatory.sum(dim=(1, 2)).to(dtype=torch.int64)
    target_total = target_total.to(dtype=torch.int64)
    eligible_total = eligible.sum(dim=(1, 2)).to(dtype=torch.int64)
    torch._assert_async(
        torch.all(target_total >= mandatory_total),
        "target_total is below the mandatory VSA route budget",
    )
    torch._assert_async(
        torch.all(target_total <= eligible_total),
        "target_total exceeds the eligible VSA route budget",
    )
    remaining = target_total - mandatory_total
    selected_events = event_rank < remaining[:, None]
    added_per_query = selected_events.reshape(heads, queries, keys).sum(dim=-1)

    rank_positions = torch.arange(keys, device=scores.device).view(1, 1, keys)
    selected_ranked = ranked_valid & (rank_positions < added_per_query.unsqueeze(-1))
    selected_candidates = torch.zeros_like(ranked_valid)
    selected_candidates.scatter_(-1, ranked_keys, selected_ranked)
    return selected_candidates | mandatory


def _reallocate_video_routes_device(
    prepared: Prepared, route_ids: torch.Tensor, route_counts: torch.Tensor, route_scores: torch.Tensor, *, sink_end: int,
    query_end: int,
) -> None:
    """Rebuild adaptive routes without leaving the producer CUDA stream."""
    import torch

    x = prepared
    assert x.lengths is not None
    n, heads = x.plan["NTB"], x.h
    device = route_scores.device
    block_ids = torch.arange(n, device=device, dtype=torch.int64)
    live_blocks = x.lengths.reshape(-1) > 0
    video_keys = (block_ids >= sink_end) & live_blocks
    video_queries = (block_ids >= query_end) & live_blocks
    eligible = video_queries[:, None] & video_keys[None, :]
    mandatory = eligible & ((block_ids[:, None] - block_ids[None, :]).abs() <= 1)

    # The live fixed route supplies the exact per-head interaction budget.
    ids = route_ids[0].to(dtype=torch.int64)
    counts = route_counts[0].to(dtype=torch.int64)
    slot_ids = torch.arange(n, device=device, dtype=torch.int64).view(1, 1, n)
    in_live_route = slot_ids < counts.unsqueeze(-1)
    fixed_video = (
        in_live_route & (ids >= sink_end) & (ids < n)
        & video_queries.view(1, n, 1)
    )
    target_total = fixed_video.sum(dim=(1, 2))

    selected_video = allocate_query_budget_torch(
        route_scores[0], eligible, mandatory, target_total,
    )
    prefix_keys = (block_ids < sink_end) & live_blocks
    selected = selected_video | (prefix_keys.view(1, 1, n) & video_queries.view(1, n, 1))

    # Stable compaction in key-ID order emits prefix keys first, followed by
    # ascending video IDs, matching the existing fine-kernel route contract.
    positions = selected.to(dtype=torch.int32).cumsum(dim=-1) - 1
    output_width = 2 * n
    compact_ids = torch.zeros((heads, n, output_width), device=device, dtype=torch.int32)
    key_values = block_ids.to(dtype=torch.int32).view(1, 1, n).expand(heads, n, n)
    # Unselected keys get unique scratch destinations beyond the returned
    # route capacity, avoiding duplicate-index writes in scatter_.
    target_positions = torch.where(selected, positions, n + key_values)
    compact_ids.scatter_(-1, target_positions, key_values)
    adaptive_ids = compact_ids[..., :n]
    adaptive_counts = selected.sum(dim=-1).to(dtype=torch.int32)
    inactive_slots = torch.arange(n, device=device).view(1, 1, n) >= adaptive_counts.unsqueeze(-1)
    adaptive_ids = adaptive_ids.masked_fill(inactive_slots, -1)

    # Non-video query rows keep the exact fixed route.
    adaptive_ids = torch.where(video_queries.view(1, n, 1), adaptive_ids, route_ids[0])
    adaptive_counts = torch.where(video_queries.view(1, n), adaptive_counts, route_counts[0])
    adaptive_ids = adaptive_ids.unsqueeze(0)
    adaptive_counts = adaptive_counts.unsqueeze(0)

    workspace_ids = x.view("idx", torch.uint16, tuple(route_ids.shape))
    workspace_counts = x.view("cnt", torch.int32, tuple(route_counts.shape))
    workspace_ids.copy_(adaptive_ids.clamp_min(0).to(torch.uint16))
    workspace_counts.copy_(adaptive_counts)
    route_ids.copy_(adaptive_ids)
    route_counts.copy_(adaptive_counts)
    x.route_metadata = {"selected_id_counts": route_counts}


def reallocate_video_routes(
    prepared: Prepared,
    route_ids: torch.Tensor,
    route_counts: torch.Tensor,
    route_scores: torch.Tensor | None,
    *,
    score_byte_limit: int = MAX_ADAPTIVE_SCORE_BYTES,
    collect_diagnostics: bool = True,
    video_grid: Sequence[int] | None = None,
    video_cube_grid: Sequence[int] | None = None,
    video_cube_size: Sequence[int] | None = None,
) -> dict[str, object] | None:
    """Replace native fixed-count routes while retaining sinks and neighbors.

    The B1 route is already computed on this request's current Q/K carriers.
    Its actual per-head video-key count becomes the adaptive budget. The
    no-diagnostics CUDA path keeps scores, allocation, and route IDs on-device;
    the CPU reference remains available for diagnostics and non-CUDA tests.
    """
    import torch

    if route_scores is None:
        raise TypeError("adaptive routing requires prepared state and route scores")
    x = prepared
    assert x.lengths is not None
    n, heads = x.plan["NTB"], x.h
    expected = (1, heads, n, n)
    if tuple(route_ids.shape) != expected or tuple(route_scores.shape) != expected:
        raise ValueError("route IDs and scores must have matching [1, heads, blocks, blocks] shapes")
    if tuple(route_counts.shape) != (1, heads, n):
        raise ValueError("route counts must have shape [1, heads, query blocks]")
    if type(score_byte_limit) is not int or score_byte_limit <= 0:
        raise ValueError("score_byte_limit must be a positive integer")
    if type(collect_diagnostics) is not bool:
        raise TypeError("collect_diagnostics must be a boolean")
    score_bytes = route_scores.numel() * route_scores.element_size()
    if score_bytes > score_byte_limit:
        raise MemoryError(
            f"adaptive VSA score export needs {score_bytes} bytes; "
            f"limit is {score_byte_limit}"
        )

    sink_start, sink_end = x.sinks
    query_start, query_end = x.sink_queries
    if (sink_start != 0 or query_start != 0 or query_end != sink_end
            or sink_end < 0 or sink_end >= n):
        raise ValueError("adaptive VSA test currently requires one dense protected prefix")

    if route_scores.device.type == "cuda" and not collect_diagnostics:
        _reallocate_video_routes_device(
            x, route_ids, route_counts, route_scores,
            sink_end=sink_end, query_end=query_end,
        )
        return None

    # NumPy keeps the bounded transfer compact; .tolist() on the full score
    # matrix would expand every float into a Python object and multiply memory.
    scores_cpu = route_scores.detach().to("cpu").numpy()[0]
    ids_cpu = route_ids.detach().to("cpu").numpy()[0].copy()
    counts_cpu = route_counts.detach().to("cpu").numpy()[0].copy()
    lengths_cpu = x.lengths.detach().to("cpu").numpy()
    if lengths_cpu.ndim != 1 or lengths_cpu.shape[0] != n:
        raise ValueError("native block lengths do not match the routed grid")

    key_ids = [key for key in range(sink_end, n) if int(lengths_cpu[key]) > 0]
    query_ids = [query for query in range(query_end, n) if int(lengths_cpu[query]) > 0]
    if not key_ids or not query_ids:
        raise ValueError("adaptive VSA test requires live video query and key blocks")
    if video_grid is not None:
        video_grid = tuple(int(value) for value in video_grid)
        if len(video_grid) != 3 or any(value <= 0 for value in video_grid):
            raise ValueError("video_grid must contain positive temporal/height/width dimensions")
    if video_cube_grid is not None:
        video_cube_grid = tuple(int(value) for value in video_cube_grid)
        if len(video_cube_grid) != 3 or any(value <= 0 for value in video_cube_grid):
            raise ValueError("video_cube_grid must contain positive temporal/height/width dimensions")
        if math.prod(video_cube_grid) != len(key_ids):
            raise ValueError("video_cube_grid does not match the live VSA video blocks")
    if video_cube_size is not None:
        video_cube_size = tuple(int(value) for value in video_cube_size)
        if len(video_cube_size) != 3 or any(value <= 0 for value in video_cube_size):
            raise ValueError("video_cube_size must contain positive temporal/height/width dimensions")
        if video_grid is not None and video_cube_grid is not None:
            expected_grid = tuple(
                (dimension + cube - 1) // cube
                for dimension, cube in zip(video_grid, video_cube_size)
            )
            if expected_grid != video_cube_grid:
                raise ValueError("video_cube_grid does not match video_grid and video_cube_size")
    eligible_rows = [[True] * len(key_ids) for _ in query_ids]
    mandatory_rows = [
        [abs(query - key) <= 1 for key in key_ids]
        for query in query_ids
    ]
    mandatory_total = sum(map(sum, mandatory_rows))

    adaptive_ids = ids_cpu.copy()
    adaptive_counts = counts_cpu.copy()
    per_head: list[dict[str, object]] | None = [] if collect_diagnostics else None
    representative_query_routes: list[dict[str, object]] | None = (
        [] if collect_diagnostics else None
    )
    for head in range(heads):
        score_rows = scores_cpu[head][query_ids][:, key_ids].tolist()
        baseline_rows = []
        target_total = 0
        for query in query_ids:
            count = int(counts_cpu[head, query])
            baseline_ids = [int(key) for key in ids_cpu[head, query, :count] if int(key) >= 0]
            baseline_video = [key for key in baseline_ids if key >= sink_end]
            required = [key for key in key_ids if abs(query - key) <= 1]
            if any(key not in baseline_video for key in required):
                raise RuntimeError("B1 fixed route did not retain every mandatory neighbor")
            target_total += len(baseline_video)
            baseline_rows.append(baseline_video)

        if target_total < mandatory_total:
            raise RuntimeError("B1 video-key budget is below mandatory VSA routing")
        chosen_rows = allocate_query_budget(
            score_rows,
            eligible_rows,
            mandatory_rows,
            target_total=target_total,
            min_counts=tuple(sum(row) for row in mandatory_rows),
            max_counts=(len(key_ids),) * len(query_ids),
        )
        prefix_ids = [key for key in range(sink_start, sink_end)
                      if int(lengths_cpu[key]) > 0]
        if collect_diagnostics:
            adaptive_video_counts = [len(chosen) for chosen in chosen_rows]
            fixed_video_counts = [len(row) for row in baseline_rows]
            changed_queries = sum(
                fixed != adaptive
                for fixed, adaptive in zip(fixed_video_counts, adaptive_video_counts)
            )
            fixed_count_histogram: dict[str, int] = {}
            adaptive_count_histogram: dict[str, int] = {}
            for count in fixed_video_counts:
                fixed_count_histogram[str(count)] = fixed_count_histogram.get(str(count), 0) + 1
            for count in adaptive_video_counts:
                adaptive_count_histogram[str(count)] = adaptive_count_histogram.get(str(count), 0) + 1
        if representative_query_routes is not None and head == 0:
            route_samples = sorted({
                round(index * (len(query_ids) - 1) / 11)
                for index in range(min(12, len(query_ids)))
            })
            for row_index in route_samples:
                query = query_ids[row_index]
                score_row = score_rows[row_index]
                maximum = max(score_row)
                weights = [math.exp2(score - maximum) for score in score_row]
                denominator = sum(weights)
                adaptive_video_ids = [key_ids[index] for index in chosen_rows[row_index]]
                fixed_video_ids = baseline_rows[row_index]
                representative_query_routes.append({
                    "query_block": query,
                    "fixed_video_key_count": len(fixed_video_ids),
                    "adaptive_video_key_count": len(adaptive_video_ids),
                    "fixed_video_key_blocks": fixed_video_ids,
                    "adaptive_video_key_blocks": adaptive_video_ids,
                    "fixed_proxy_score_mass_retained": (
                        sum(weights[key_ids.index(key)] for key in fixed_video_ids) / denominator
                        if denominator else 0.0
                    ),
                    "adaptive_proxy_score_mass_retained": (
                        sum(weights[index] for index in chosen_rows[row_index]) / denominator
                        if denominator else 0.0
                    ),
                })
                if video_cube_grid is not None:
                    representative_query_routes[-1].update({
                        "query_cube_coordinate": video_cube_coordinate(
                            query, sink_end, video_cube_grid,
                        ),
                        "fixed_video_key_cube_coordinates": [
                            video_cube_coordinate(key, sink_end, video_cube_grid)
                            for key in fixed_video_ids
                        ],
                        "adaptive_video_key_cube_coordinates": [
                            video_cube_coordinate(key, sink_end, video_cube_grid)
                            for key in adaptive_video_ids
                        ],
                    })
        for query, chosen in zip(query_ids, chosen_rows):
            selected_video_ids = [key_ids[index] for index in chosen]
            selected = prefix_ids + selected_video_ids
            if len(set(selected)) != len(selected) or len(selected) > n:
                raise RuntimeError("adaptive route contains duplicate or overflowing key IDs")
            adaptive_ids[head, query, :] = -1
            adaptive_ids[head, query, :len(selected)] = selected
            adaptive_counts[head, query] = len(selected)
        if per_head is not None:
            per_head.append({
                "query_rows": len(query_ids),
                "b1_video_key_interactions": target_total,
                "adaptive_video_key_interactions": sum(map(len, chosen_rows)),
                "changed_query_rows": changed_queries,
                "min_video_keys_per_query": min(map(len, chosen_rows)),
                "max_video_keys_per_query": max(map(len, chosen_rows)),
                "fixed_min_video_keys_per_query": min(fixed_video_counts),
                "fixed_max_video_keys_per_query": max(fixed_video_counts),
                "fixed_video_key_count_histogram": fixed_count_histogram,
                "adaptive_video_key_count_histogram": adaptive_count_histogram,
            })

    adaptive_ids_device = torch.as_tensor(adaptive_ids, device=route_ids.device, dtype=torch.int32)
    adaptive_counts_device = torch.as_tensor(adaptive_counts, device=route_counts.device, dtype=torch.int32)
    workspace_ids = x.view("idx", torch.uint16, expected)
    workspace_counts = x.view("cnt", torch.int32, (1, heads, n))
    # Fine reads only IDs below each count; zero-filled uint16 padding avoids
    # converting Python -1 sentinels to 65535 in the native workspace.
    workspace_ids.copy_(adaptive_ids_device.clamp_min(0).to(torch.uint16))
    workspace_counts.copy_(adaptive_counts_device)
    route_ids.copy_(adaptive_ids_device)
    route_counts.copy_(adaptive_counts_device)
    diagnostics = None
    if collect_diagnostics:
        diagnostics = {
            "policy": "query_adaptive_proxy_coverage_v1",
            "score_semantics": "raw_log2_pooled_qk_router_scores",
            "score_bytes": score_bytes,
            "budget_source": "live_fixed_b1_routes_on_current_qk",
            "prefix_query_policy": "fixed_b1_dense",
            "prefix_key_policy": "fixed_b1_protected",
            "video_grid": None if video_grid is None else list(video_grid),
            "video_cube_grid": None if video_cube_grid is None else list(video_cube_grid),
            "video_cube_size": None if video_cube_size is None else list(video_cube_size),
            "video_prefix_blocks": sink_end,
            "heads": per_head,
            "representative_query_routes_head_0": representative_query_routes,
        }
    x.route_metadata = diagnostics if diagnostics is not None else {}
    return diagnostics
