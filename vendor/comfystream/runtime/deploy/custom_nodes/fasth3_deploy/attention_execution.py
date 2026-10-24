"""Request-local evidence for attention dispatch, separate from loader intent."""

from __future__ import annotations

from contextlib import contextmanager
from contextvars import ContextVar
from typing import TYPE_CHECKING, Protocol, cast

if TYPE_CHECKING:
    from .native_attention.grouped import NativeState
from collections.abc import Iterator, Mapping


class _DeviceCounter(Protocol):
    def detach(self) -> _DeviceCounter: ...
    def cpu(self) -> _DeviceCounter: ...
    def tolist(self) -> object: ...


_execution: ContextVar[dict[str, object] | None] = ContextVar('fasth3_attention_execution', default=None)
_states: ContextVar[dict[object, NativeState] | None] = ContextVar('fasth3_native_states', default=None)
_evaluation: ContextVar[int | None] = ContextVar('fasth3_evaluation', default=None)
_adaptive_budget_evaluations: ContextVar[set[int] | None] = ContextVar(
    'fasth3_adaptive_budget_evaluations', default=None,
)


@contextmanager
def capture_attention_execution() -> Iterator[dict[str, object]]:
    report: dict[str, object] = {
        "calls": 0,
        "backends": {},
        "options": {},
        "per_evaluation": {},
        "producer_chunks": 0,
    }
    token = _execution.set(report)
    states: dict[object, NativeState] = {}
    states_token = _states.set(states)
    evaluation_token = _evaluation.set(0)
    adaptive_budget_token = _adaptive_budget_evaluations.set(set())
    try:
        yield report
    finally:
        states.clear()
        _adaptive_budget_evaluations.reset(adaptive_budget_token)
        _states.reset(states_token)
        _evaluation.reset(evaluation_token)
        _execution.reset(token)


def native_layer_state(key: object) -> NativeState:
    states = _states.get()
    # Calls outside the request-aware sampler get no cross-call state reuse.
    return {} if states is None else states.setdefault(key, {})


def current_evaluation() -> int | None:
    return _evaluation.get()


def set_evaluation(index: int) -> None:
    if _states.get() is not None:
        _evaluation.set(index)


def claim_adaptive_budget_call(evaluation_index: int | None) -> bool:
    """Run one adaptive routing probe per denoising evaluation in a request."""
    seen = _adaptive_budget_evaluations.get()
    if seen is None:
        return False
    key = -1 if evaluation_index is None else int(evaluation_index)
    if key in seen:
        return False
    seen.add(key)
    return True


def record_attention(backend: str, option: str, diagnostics: Mapping[str, object] | None=None) -> None:
    report = _execution.get()
    if report is not None:
        report["calls"] = cast(int, report["calls"]) + 1
        for name, value in (("backends", backend), ("options", option)):
            counts = cast(dict[str, int], report[name])
            counts[value] = counts.get(value, 0) + 1
        # Preserve actual per-evaluation dispatch so segmented samplers can
        # distinguish measured attention calls from a count inferred from NFE.
        evaluation = _evaluation.get()
        key = "unassigned" if evaluation is None else str(int(evaluation))
        per_evaluation = cast(dict[str, dict[str, object]], report.setdefault("per_evaluation", {}))
        row = per_evaluation.setdefault(
            key, {"calls": 0, "backends": {}, "options": {}},
        )
        row["calls"] = cast(int, row["calls"]) + 1
        for name, value in (("backends", backend), ("options", option)):
            counts = cast(dict[str, int], row[name])
            counts[value] = counts.get(value, 0) + 1
        if diagnostics:
            omega = cast(Mapping[str, object] | None, diagnostics.get("omega_config"))
            if omega is not None:
                identity = omega.get("identity")
                previous = report.get("omega_identity")
                if previous is None:
                    report["omega_identity"] = identity
                elif previous != identity:
                    identities = cast(list[object], report.setdefault("omega_identities", [previous]))
                    if identity not in identities:
                        identities.append(identity)
                report["omega_config"] = omega
            details = cast(dict[str, dict[str, object]], report.setdefault("native_details", {}))
            entry = details.setdefault(backend, {"calls": 0})
            entry["calls"] = cast(int, entry["calls"]) + 1
            current = {key: diagnostics[key] for key in (
                "executed_backend", "policy", "groups", "token_aug", "calibration_measured",
                "direct_prefix_output_requested", "output_savings", "workspace_accounting",
                "omega_config", "triton_launch", "kernel_resources",
            ) if key in diagnostics}
            build_report = diagnostics.get("build_report")
            if isinstance(build_report, dict):
                current["native_artifact"] = {
                    key: build_report[key] for key in (
                        "library_sha256", "architectures",
                    ) if key in build_report
                }
            # Preserve the first value and retain every later change.  Native
            # diagnostics are cumulative request evidence; a last-layer
            # overwrite hides whether a flag ran consistently across calls.
            observed = cast(dict[str, list[object]], entry.setdefault("observed_values", {}))
            for key, observed_value in current.items():
                if key not in entry:
                    entry[key] = observed_value
                    continue
                if entry[key] != observed_value:
                    values = observed.setdefault(key, [entry[key]])
                    if observed_value not in values:
                        values.append(observed_value)
            workspace = cast(int, diagnostics.get("workspace_bytes", 0))
            report["max_workspace_bytes"] = max(cast(int, report.get("max_workspace_bytes", 0)), workspace)
            counters = cast(dict[str, int], report.setdefault("native_stage_calls", {}))
            for name, count in cast(Mapping[str, int], diagnostics.get("counters") or
                                diagnostics.get("kitchen_counters") or {}).items():
                counters[name] = counters.get(name, 0) + count
            device = {key: diagnostics[key] for key in (
                "phase_calls", "phase_pairs", "nvfp4_clipping_counts_q_k_v", "vc_nvfp4_clipping_counts",
            ) if key in diagnostics}
            if device:
                cast(list[dict[str, object]], report.setdefault("_device_evidence", [])).append(device)
            stage_timings = diagnostics.get("stage_timings_ms")
            if isinstance(stage_timings, dict):
                totals = cast(dict[str, float], report.setdefault("stage_timings_ms", {}))
                for name, value in stage_timings.items():
                    totals[name] = totals.get(name, 0.0) + float(value)


def record_adaptive_budget_probe(adaptive_budget: Mapping[str, object]) -> None:
    """Capture compact route evidence directly from the adaptive allocator."""
    report = _execution.get()
    if report is None:
        return
    if not isinstance(adaptive_budget, dict):
        raise TypeError("adaptive budget diagnostics must be a dictionary")

    heads = adaptive_budget.get("heads")
    if not isinstance(heads, (list, tuple)):
        heads = []
    probe: dict[str, object] = {
        "diagnostic_keys": sorted(str(key) for key in adaptive_budget),
        "score_semantics": adaptive_budget.get("score_semantics"),
        "budget_source": adaptive_budget.get("budget_source"),
        "score_bytes": int(cast(int, adaptive_budget.get("score_bytes", 0))),
        "video_grid": adaptive_budget.get("video_grid"),
        "video_cube_grid": adaptive_budget.get("video_cube_grid"),
        "video_cube_size": adaptive_budget.get("video_cube_size"),
        "video_prefix_blocks": adaptive_budget.get("video_prefix_blocks"),
        "heads": [dict(head) for head in heads if isinstance(head, dict)],
        "representative_query_routes_head_0": list(
            cast(list[object], adaptive_budget.get("representative_query_routes_head_0", ()))
        ),
    }
    cast(list[dict[str, object]], report.setdefault("adaptive_vsa_budget_probes", [])).append(probe)

    summary = cast(dict[str, object], report.setdefault("adaptive_vsa_budget", {
        "calls": 0,
        "score_semantics": probe["score_semantics"],
        "budget_source": probe["budget_source"],
        "score_bytes_max": 0,
        "b1_video_key_interactions": 0,
        "adaptive_video_key_interactions": 0,
        "changed_query_rows": 0,
        "query_rows": 0,
        "fixed_video_key_count_histogram": {},
        "adaptive_video_key_count_histogram": {},
    }))
    summary["calls"] = cast(int, summary["calls"]) + 1
    summary["score_bytes_max"] = max(cast(int, summary["score_bytes_max"]), cast(int, probe["score_bytes"]))
    for head in cast(list[dict[str, object]], probe["heads"]):
        for metric in (
            "b1_video_key_interactions",
            "adaptive_video_key_interactions",
            "changed_query_rows",
            "query_rows",
        ):
            summary[metric] = cast(int, summary[metric]) + int(cast(int, head.get(metric, 0)))
        for source, target in (
            ("fixed_video_key_count_histogram", "fixed_video_key_count_histogram"),
            ("adaptive_video_key_count_histogram", "adaptive_video_key_count_histogram"),
        ):
            combined = cast(dict[str, int], summary[target])
            for count, rows in cast(Mapping[str, int], head.get(source, {})).items():
                combined[count] = combined.get(count, 0) + int(rows)
    if "representative_attention_call" not in summary:
        summary["representative_attention_call"] = len(
            cast(list[object], report["adaptive_vsa_budget_probes"])
        ) - 1
        summary["representative_head_0_query_routes"] = probe[
            "representative_query_routes_head_0"
        ]


def finalize_attention_execution(report: dict[str, object]) -> dict[str, object]:
    """Read tiny device counters after sampling synchronization, never per layer."""
    def host(value: object) -> object:
        if isinstance(value, dict):
            return {key: host(item) for key, item in value.items()}
        return cast(_DeviceCounter, value).detach().cpu().tolist() if hasattr(value, "detach") else value

    evidence = cast(list[dict[str, object]], report.pop("_device_evidence", []))
    for entry in evidence:
        data = cast(dict[str, object], host(entry))
        for key in ("phase_calls", "phase_pairs"):
            if isinstance(data.get(key), dict):
                total = cast(dict[str, int], report.setdefault(key, {}))
                for phase, value in cast(Mapping[str, int], data[key]).items():
                    total[phase] = total.get(phase, 0) + value
        clipped = cast(list[int] | None, data.get("nvfp4_clipping_counts_q_k_v"))
        if clipped is not None:
            totals = cast(list[int], report.setdefault("nvfp4_clipping_counts_q_k_v", [0, 0, 0]))
            for i, count in enumerate(clipped):
                totals[i] += count
        vc_clipped = cast(list[int] | None, data.get("vc_nvfp4_clipping_counts"))
        if vc_clipped is not None:
            totals = cast(list[int], report.setdefault("vc_nvfp4_clipping_counts", [0, 0]))
            for i, count in enumerate(vc_clipped):
                totals[i] += count
    report["calibration_clipped"] = (any(cast(list[int], report.get("nvfp4_clipping_counts_q_k_v", [])))
                                     or any(cast(list[int], report.get("vc_nvfp4_clipping_counts", []))))
    return report


def record_producer_chunk() -> None:
    report = _execution.get()
    if report is not None:
        report["producer_chunks"] = cast(int, report["producer_chunks"]) + 1
