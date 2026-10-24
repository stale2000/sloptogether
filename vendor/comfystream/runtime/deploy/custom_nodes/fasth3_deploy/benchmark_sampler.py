"""Comfy sampler benchmark node."""

from __future__ import annotations

import math
import time
from collections.abc import Callable, Iterator, Mapping, Sized
from contextlib import contextmanager
from typing import TYPE_CHECKING, Protocol, cast

if TYPE_CHECKING:
    import torch
    from comfy.model_patcher import ModelPatcher
    from comfy.nested_tensor import NestedTensor
    from comfy.samplers import KSAMPLER

    from .speculative_forcing_freeze import TokenFreezeController
    from .speculative_forcing_probe import DenoisingTraceRecorder

type _SampleTensor = torch.Tensor | NestedTensor


class _Guider(Protocol):
    model_patcher: ModelPatcher

    def sample(
        self, noise: _SampleTensor, latent: _SampleTensor, sampler: KSAMPLER,
        sigmas: torch.Tensor, *, denoise_mask: object,
        callback: Callable[[int, _SampleTensor, _SampleTensor, int], None], disable_pbar: bool, seed: int,
    ) -> _SampleTensor: ...


class _NoiseStream(Protocol):
    def generate_noise(self, latent: dict[str, object]) -> _SampleTensor: ...


class _RemovableHook(Protocol):
    def remove(self) -> None: ...

from .benchmark_clock import _residency_snapshot, residency_restored
from .benchmark_report import (
    _GPU_LOCK,
    _blank_report,
    _json_safe,
    _note_vram,
    _safe_exception_text,
    _stats,
    logger,
    report_json,
    serialize_report,
)


def _noise(seed: int) -> _NoiseStream:
    class Noise:
        def __init__(self, value: int) -> None:
            self.seed = value

        def generate_noise(self, latent: dict[str, object]) -> _SampleTensor:
            import comfy.sample

            noise: _SampleTensor = comfy.sample.prepare_noise(
                latent["samples"], self.seed, latent.get("batch_index")
            )
            return noise

    return Noise(seed)


@contextmanager
def _capture_model_inputs(
    trace_recorder: DenoisingTraceRecorder | None,
    freeze_controller: TokenFreezeController | None, model_patcher: object,
) -> Iterator[None]:
    if trace_recorder is None:
        yield
        return
    if freeze_controller is None or not trace_recorder.capture_forward_inputs:
        with trace_recorder.capture_model_inputs(model_patcher):
            yield
        return
    previous = freeze_controller.debug_model_input_trace
    freeze_controller.debug_model_input_trace = trace_recorder.record_model_input
    try:
        yield
    finally:
        freeze_controller.debug_model_input_trace = previous


def _is_dmad_profile(profile: object) -> bool:
    if not isinstance(profile, dict):
        return False
    # `sampling_contract` is the current loader/report field. Accept the older
    # `sampler_contract` alias for saved candidate workflows.
    contract = profile.get("sampling_contract", profile.get("sampler_contract"))
    return contract == "dmad-h3-4step-renoise/1"


def _sampler_name(sampler: object) -> str | None:
    name = getattr(sampler, "name", None) or getattr(sampler, "sampler", None)
    if isinstance(name, str):
        return name
    sampler_function = getattr(sampler, "sampler_function", None)
    function_name = getattr(sampler_function, "__name__", None)
    return function_name.removeprefix("sample_") if isinstance(function_name, str) else None


def _expected_attention_calls(model: object, expected_nfe: int, *, require_model: bool) -> tuple[int, int]:
    """Return the loaded H3 block count and expected VSA calls for this run.

    FastH3 V2 has 50 transformer blocks; FastH3 Trim has 42. Derive the
    expected attention count from the loaded model so the strict B1 evidence
    check accepts both checkpoint shapes without weakening per-block checks.
    """
    block_count = None
    get_model_object = getattr(model, "get_model_object", None)
    if callable(get_model_object):
        diffusion_model = get_model_object("diffusion_model")
        blocks = getattr(diffusion_model, "blocks", None)
        try:
            candidate = len(cast(Sized, blocks))
        except TypeError:
            candidate = None
        if candidate in (42, 50):
            block_count = candidate
    if block_count is None:
        if require_model:
            raise RuntimeError(
                "B1 attention evidence requires a loaded 42- or 50-block H3 transformer"
            )
        block_count = 50
    return block_count, block_count * expected_nfe


@contextmanager
def _capture_h3_attention_calls(model: object, enabled: bool) -> Iterator[list[int]]:
    """Count forward calls per H3 block and always remove installed hooks."""
    counts: list[int] = []
    handles: list[_RemovableHook] = []
    try:
        if enabled:
            get_model_object = getattr(model, "get_model_object", None)
            diffusion_model = (
                get_model_object("diffusion_model") if callable(get_model_object) else None
            )
            blocks = getattr(diffusion_model, "blocks", None)
            if blocks is None:
                raise RuntimeError("cannot capture attention calls without a loaded H3 transformer")
            for index, block in enumerate(blocks):
                attention = getattr(block, "attn", None)
                register_hook = getattr(attention, "register_forward_hook", None)
                if not callable(register_hook):
                    raise TypeError(f"H3 block {index} has no hookable attention module")
                counts.append(0)

                def count_call(
                    _module: object, _inputs: tuple[object, ...], _output: object,
                    *, block_index: int = index,
                ) -> None:
                    counts[block_index] += 1

                handles.append(register_hook(count_call))
        yield counts
    finally:
        for handle in reversed(handles):
            handle.remove()


def _record_transformer_compile(report: dict[str, object], profile: object) -> None:
    compile_report = profile.get("transformer_compile") if isinstance(profile, dict) else None
    if not isinstance(compile_report, dict):
        return
    initial = report.get("transformer_compile", {})
    before = initial.get("dynamo_counters_before_sample") if isinstance(initial, dict) else None
    compile_report = cast(dict[str, object], _json_safe(compile_report))
    if compile_report.get("enabled") is True:
        after = compile_report.get("dynamo_counters_after")
        compile_report["dynamo_counters_before_sample"] = before
        compile_report["compiled_graphs_added_this_sample"] = None
        compile_report["captured_ops_added_this_sample"] = None
        compile_report["counter_scope"] = "process-global Dynamo counters, not GPU coverage"
        compile_report["captured_calls_semantics"] = "FX call nodes, not transformer invocations"
        if isinstance(before, dict) and isinstance(after, dict):
            before_stats = before.get("stats", {})
            after_stats = after.get("stats", {})
            compile_report["compiled_graphs_added_this_sample"] = (
                after_stats.get("unique_graphs", 0) - before_stats.get("unique_graphs", 0)
            )
            compile_report["captured_ops_added_this_sample"] = (
                after_stats.get("calls_captured", 0) - before_stats.get("calls_captured", 0)
            )
    report["transformer_compile"] = compile_report
    cast(dict[str, object], report.setdefault("run_knobs", {}))["transformer_compile"] = compile_report


@contextmanager
def _inference_feature_scope(
    patcher: ModelPatcher, flags: Mapping[str, bool], report: dict[str, object] | None = None,
) -> Iterator[None]:
    """Apply request-local inference experiments for DMAD runs."""
    from . import memory_features
    from .inference_features import inference_experiments

    with memory_features.feature_scope(flags):
        try:
            with inference_experiments(patcher):
                yield
        finally:
            if report is not None:
                memory_features.annotate(report)


class ComfyStreamerH3BenchmarkSampler:
    """Run a checked FastH3 sampler contract from the selected loader profile."""

    RETURN_TYPES = ("LATENT", "H3_RUN_REPORT")
    RETURN_NAMES = ("output", "report")
    FUNCTION = "sample"
    CATEGORY = "ComfyStreamerH3/Deploy"

    @classmethod
    def INPUT_TYPES(cls) -> dict[str, dict[str, tuple[object, ...]]]:
        return {
            "required": {
                "model": ("MODEL",),
                "sampler": ("SAMPLER",),
                "sigmas": ("SIGMAS",),
                "conditioning": ("GUIDER",),
                "latent_image": ("LATENT",),
                "seed": ("INT", {"default": 42424242, "min": 0, "max": 0xFFFFFFFFFFFFFFFF}),
                "run_nonce": ("STRING", {"default": ""}),
                "profile": ("H3_PROFILE",),
                "mode": (["normal"], {"default": "normal"}),
            },
            "optional": {
                "profile_memory": ("BOOLEAN", {"default": False}),
                "noise_stream": ("DMAD_NOISE",),
                "benchmark_output_backend": (["nvenc", "parallel"], {"default": "nvenc"}),
            },
        }

    def sample(
        self,
        model: ModelPatcher,
        sampler: KSAMPLER,
        sigmas: torch.Tensor,
        conditioning: object,
        latent_image: dict[str, object],
        seed: int,
        run_nonce: str,
        profile: dict[str, object] | None = None,
        mode: str = "normal",
        profile_memory: bool = False,
        noise_stream: _NoiseStream | None = None,
        benchmark_output_backend: str = "nvenc",
    ) -> tuple[dict[str, object], dict[str, object]]:
        if not isinstance(run_nonce, str) or not run_nonce.strip():
            raise ValueError("run_nonce must be a non-empty string")
        if mode != "normal":
            raise ValueError("ComfyStreamerH3 Sampler supports only mode='normal'")
        if benchmark_output_backend not in {"nvenc", "parallel"}:
            raise ValueError("benchmark_output_backend must be 'nvenc' or 'parallel'")
        is_dmad = _is_dmad_profile(profile)
        if is_dmad and noise_stream is None:
            raise ValueError("DMAD sampling requires its sampler/noise object pair")
        if is_dmad and getattr(noise_stream, "seed", None) != seed:
            raise ValueError("DMAD noise seed must match the benchmark seed")
        if noise_stream is not None and not is_dmad:
            raise ValueError("A DMAD noise object cannot be combined with a non-DMAD profile")
        report = _blank_report(run_nonce=run_nonce, seed=seed, profile=profile)
        profile_data = profile if profile is not None else {}
        worker_clock = (
            latent_image.get("fasth3_worker_clock")
            if isinstance(latent_image, dict) else None
        )
        if worker_clock is not None:
            if (not isinstance(worker_clock, dict)
                    or worker_clock.get("nonce") != run_nonce
                    or type(worker_clock.get("started_monotonic")) not in (int, float)
                    or not math.isfinite(float(worker_clock["started_monotonic"]))
                    or not isinstance(worker_clock.get("residency_start"), dict)):
                raise ValueError("benchmark worker clock receipt is invalid or belongs to another run")
            if not isinstance(latent_image.get("fasth3_encoder_execution"), dict):
                raise RuntimeError("conditioning execution receipt missing for worker-clock request")
            report["benchmark_receipt"] = {
                "conditioning_executed": True,
                "sampler_executed": False,
                "cached_latent": False,
                "cache_policy": str(worker_clock.get("text_cache_policy", "")),
                "residency_policy": str(worker_clock.get("residency_policy", "")),
                "worker_started_monotonic": float(worker_clock["started_monotonic"]),
                "worker_clock_state": worker_clock["residency_start"],
            }
        if is_dmad:
            from .dmad_sampling import _latent_parts

            video_latent, audio_latent = _latent_parts(latent_image)
            latent_frames, latent_height, latent_width = (
                int(video_latent.shape[2]),
                int(video_latent.shape[3]),
                int(video_latent.shape[4]),
            )
            if (latent_frames - 2) % 5:
                raise ValueError("DMAD video latent does not follow the native 17*n+5 frame grid")
            frames = ((latent_frames - 2) // 5) * 17 + 5
            report.update(
                model_family="dmad",
                model_variant=profile_data["model_variant"],
                base_model_id=profile_data["base_model_id"],
                base_revision=profile_data["base_revision"],
                dmad_comfy_manifest_sha256=profile_data["dmad_comfy_manifest_sha256"],
                width=latent_width * 16,
                height=latent_height * 16,
                internal_width=latent_width * 16,
                internal_height=latent_height * 16,
                frames=frames,
                fps=24.0,
                audio_enabled=True,
                audio_latent_frames=int(audio_latent.shape[-1]),
                audio_target_sample_rate=32000,
                attention_status=profile_data["attention_mode"],
                gate_compress=False,
                run_knobs=dict(
                    cast(Mapping[str, object], report.get("run_knobs") or {}),
                    precision_mode=profile_data["precision_mode"],
                    video_shift=profile_data["video_shift"],
                    audio_shift=profile_data["audio_shift"],
                    kitchen_vae_fusions=profile_data["kitchen_vae_fusions"],
                    vae_precision_policy=profile_data["vae_precision_policy"],
                ),
            )
        report["profile_memory"] = bool(profile_memory)
        report["benchmark_output_backend"] = benchmark_output_backend
        if isinstance(latent_image, dict) and "fasth3_encoder_execution" in latent_image:
            report["encoder_optimization"] = _json_safe(latent_image["fasth3_encoder_execution"])
        sampler_name = _sampler_name(sampler)
        report["sampler"] = sampler_name
        if report.get("kitchen_baseline") and sampler_name != profile_data.get("sampler"):
            raise ValueError(
                f"actual sampler {sampler_name!r} differs from Kitchen baseline "
                f"{profile_data.get('sampler')!r}"
            )
        observed_nfe = [0]
        try:
            report["actual_nfe"] = max(0, len(sigmas) - 1)
        except TypeError:
            report["actual_nfe"] = None
        try:
            sigma_tensor = sigmas
            if callable(getattr(sigma_tensor, "detach", None)):
                report["sigma_positions"] = sigma_tensor.detach().to(device="cpu").tolist()
        except Exception as exc:  # noqa: BLE001 - receipt conversion must not change sampling
            report["sigma_positions"] = {"unavailable": type(exc).__name__}

        with _GPU_LOCK:
            import torch

            compile_receipt = report.get("transformer_compile")
            if isinstance(compile_receipt, dict) and compile_receipt.get("enabled") is True:
                from .transformer_compile import _dynamo_counter_snapshot

                compile_receipt["dynamo_counters_before_sample"] = _dynamo_counter_snapshot(torch)
            if torch.cuda.is_available():
                torch.cuda.synchronize()
                torch.cuda.reset_peak_memory_stats()
                report["gpu_name"] = torch.cuda.get_device_name(0)
                cap = torch.cuda.get_device_capability()
                report["gpu_capability"] = f"{cap[0]}.{cap[1]}"
                gpu_uuid = getattr(torch.cuda.get_device_properties(0), "uuid", None)
                if gpu_uuid is not None:
                    report["gpu_uuid"] = str(gpu_uuid)
            started = time.perf_counter()
            report["status"] = "SAMPLING"
            report["vram_snapshots"] = {}
            _note_vram(report, "sample_begin")
            _stats(reset=True)
            step_marks: list[float] = [started]
            execution = {}
            memory = None
            try:
                from .attention_execution import (
                    capture_attention_execution,
                    finalize_attention_execution,
                )
                from .memory_evidence import memory_evidence
                from .native_attention import request_stage_timings

                with (
                    capture_attention_execution() as execution,
                    request_stage_timings() as native_timings,
                    memory_evidence(profile_memory) as memory,
                ):
                    if is_dmad:
                        patcher = getattr(conditioning, "model_patcher", model)
                        with _inference_feature_scope(patcher, cast(Mapping[str, bool], profile_data.get("memory_flags", {})), report):
                            result = self._run_sample(
                                model,
                                sampler,
                                sigmas,
                                conditioning,
                                latent_image,
                                seed,
                                observed_nfe,
                                step_marks,
                                noise_stream=noise_stream,
                            )
                    else:
                        result = self._run_sample(
                            model,
                            sampler,
                            sigmas,
                            conditioning,
                            latent_image,
                            seed,
                            observed_nfe,
                            step_marks,
                            noise_stream=noise_stream,
                        )
                if memory is not None:
                    cast(dict[str, object], report.setdefault("memory_evidence", {}))["sampling"] = memory
                if torch.cuda.is_available():
                    torch.cuda.synchronize()
                    _note_vram(report, "sample_end")
                    report["peak_vram_bytes"] = torch.cuda.max_memory_allocated()
                receipt = report.get("benchmark_receipt")
                if isinstance(receipt, dict):
                    receipt["sampler_executed"] = True
                    receipt["residency_start"] = _residency_snapshot()
                    receipt["residency_end"] = _residency_snapshot()
                    receipt["residency_restored"] = residency_restored(
                        receipt["residency_start"], receipt["residency_end"],
                    )
                timing_evidence = native_timings.resolve()
                if timing_evidence["timed_calls"]:
                    execution.update(timing_evidence)
                report["actual_nfe"] = observed_nfe[0] or None
                if len(step_marks) >= 2:
                    step_timings = [
                        round((step_marks[i] - step_marks[i - 1]) * 1000.0, 3)
                        for i in range(1, len(step_marks))
                    ]
                    cast(dict[str, object], report["timings_ms"])["denoising_steps"] = step_timings
                    if is_dmad:
                        report["renoise_step_ms"] = step_timings
                    else:
                        report["euler_step_ms"] = step_timings
                        cast(dict[str, object], report["timings_ms"])["euler_steps"] = step_timings
                report["status"] = "SAMPLED"
                report["sample_started_monotonic"] = started
                report["sample_finished_monotonic"] = time.perf_counter()
                cast(dict[str, object], report["timings_ms"])["sampling"] = (time.perf_counter() - started) * 1000.0
                _record_transformer_compile(report, profile)
                report["attention_execution"] = finalize_attention_execution(execution)
                if execution.get("calibration_clipped"):
                    raise RuntimeError("native NVFP4 calibration clipped operands; reject this run")
                counters = _stats()
                report["dispatch"] = _json_safe(counters)
                primary_attention_counter = (
                    "sparse" if report.get("attention_option") == "cute_sol" else "producer"
                )
                report["actual_sparse_calls"] = counters.get(primary_attention_counter, 0)
                report["fallback_calls"] = counters.get("dense_fallback", 0) + counters.get(
                    "errors", 0
                )
                report["hard_fallback_calls"] = counters.get("errors", 0)
                expected_nfe = profile_data.get("steps", 4) if isinstance(profile, dict) else 4
                if not isinstance(expected_nfe, int) or expected_nfe < 1:
                    expected_nfe = 4
                transformer_block_count, expected_sparse_calls = _expected_attention_calls(
                    model, expected_nfe, require_model=bool(report.get("kitchen_baseline"))
                )
                report["transformer_block_count"] = transformer_block_count
                report["expected_attention_calls"] = expected_sparse_calls
                nfe_ok = report["actual_nfe"] == expected_nfe
                fallback_ok = (
                    report["hard_fallback_calls"] == 0
                    if report.get("attention_option") == "cute_sol"
                    else report["fallback_calls"] == 0
                )
                producer_ok = report["actual_sparse_calls"] == expected_sparse_calls
                if (
                    report.get("kitchen_baseline")
                    and execution["calls"] != expected_sparse_calls
                ):
                    raise RuntimeError(
                        f"attention execution evidence missing: {execution['calls']} "
                        f"completed calls, expected {expected_sparse_calls}"
                    )
                if is_dmad:
                    attention_mode = profile_data.get("attention_mode")
                    if attention_mode == "dense":
                        producer_ok = report["actual_sparse_calls"] == 0
                        fallback_ok = report["hard_fallback_calls"] == 0
                    elif attention_mode == "vsa_fine_only":
                        producer_ok = report["actual_sparse_calls"] == expected_sparse_calls
                        fallback_ok = report["hard_fallback_calls"] == 0
                    else:
                        raise RuntimeError(f"unsupported DMAD attention mode: {attention_mode!r}")
                    stream = getattr(noise_stream, "stream", None)
                    if (
                        stream is None
                        or (stream.initial_draws, stream.resample_draws) != (2, 8)
                        or observed_nfe[0] != 4
                    ):
                        raise RuntimeError(
                            "DMAD run did not record the initial pair and four video/audio re-noise draws"
                        )
                    report["model_family"] = "dmad"
                    report["sampling_contract"] = profile_data["sampling_contract"]
                    report["dmad_noise_stream"] = {
                        "initial_component_draws": stream.initial_draws,
                        "resample_component_draws": stream.resample_draws,
                        "sampler_contract": profile_data["sampling_contract"],
                    }
                    report["attention_status"] = attention_mode
                if not (nfe_ok and fallback_ok and producer_ok):
                    raise RuntimeError(
                        "strict FastH3 dispatch check failed: "
                        f"nfe={report['actual_nfe']}, "
                        f"producer={report['actual_sparse_calls']}, fallback={report['fallback_calls']}, "
                        f"expected_nfe={expected_nfe}, expected_producer={expected_sparse_calls}"
                    )
                report["cleanup_status"] = "complete"
                logger.info("FASTH3_BENCHMARK_REPORT %s", report_json(report))
                return result, serialize_report(report)
            except Exception as exc:
                report["status"] = "FAILED"
                report["failure_stage"] = "sampling"
                _record_transformer_compile(report, profile)
                report["attention_execution"] = _json_safe(execution)
                failure_counters = _stats()
                report["dispatch"] = _json_safe(failure_counters)
                primary_attention_counter = (
                    "sparse" if report.get("attention_option") == "cute_sol" else "producer"
                )
                report["actual_sparse_calls"] = failure_counters.get(primary_attention_counter, 0)
                report["fallback_calls"] = failure_counters.get(
                    "dense_fallback", 0
                ) + failure_counters.get("errors", 0)
                report["hard_fallback_calls"] = failure_counters.get("errors", 0)
                report["actual_nfe"] = observed_nfe[0]
                if memory is not None:
                    cast(dict[str, object], report.setdefault("memory_evidence", {}))["sampling"] = memory
                report["error"] = _safe_exception_text(exc)
                cast(dict[str, object], report["timings_ms"])["sampling"] = (time.perf_counter() - started) * 1000.0
                report["cleanup_status"] = "complete"
                logger.info("FASTH3_BENCHMARK_REPORT %s", report_json(report))
                raise

    @staticmethod
    def _run_sample(
        model: ModelPatcher,
        sampler: KSAMPLER,
        sigmas: torch.Tensor,
        conditioning: object,
        latent_image: dict[str, object],
        seed: int,
        observed_nfe: list[int],
        step_marks: list[float] | None = None,
        noise_stream: _NoiseStream | None = None,
        trace_recorder: DenoisingTraceRecorder | None = None,
        freeze_controller: TokenFreezeController | None = None,
    ) -> dict[str, object]:
        """Use the pinned advanced guider path; retain a stock fallback for tests/old Comfy."""
        latent = dict(latent_image)
        latent["samples"] = latent_image["samples"]

        def callback(*_args: object, **_kwargs: object) -> None:
            observed_nfe[0] += 1
            from .attention_execution import set_evaluation

            set_evaluation(observed_nfe[0])
            if step_marks is not None:
                step_marks.append(time.perf_counter())
            if trace_recorder is not None or freeze_controller is not None:
                from .speculative_forcing_probe import video_clean_estimate

                estimate = _kwargs.get("x0")
                if estimate is None and len(_args) > 1:
                    estimate = _args[1]
                if estimate is None:
                    raise RuntimeError("sampler callback did not expose its clean x0 estimate")
                video_x0 = video_clean_estimate(estimate)
                if trace_recorder is not None:
                    sample_video = _kwargs.get("x")
                    if sample_video is None and len(_args) > 2:
                        sample_video = _args[2]
                    if sample_video is not None:
                        sample_video = video_clean_estimate(sample_video)
                    trace_recorder(len(trace_recorder.steps), video_x0, sample_video)
                if freeze_controller is not None:
                    sample = _kwargs.get("x")
                    if sample is None and len(_args) > 2:
                        sample = _args[2]
                    if sample is None:
                        raise RuntimeError("sampler callback did not expose its live sample")
                    freeze_controller.observe(
                        observed_nfe[0], video_x0, video_clean_estimate(sample)
                    )
        if hasattr(conditioning, "sample"):
            guider = cast(_Guider, conditioning)
            try:
                import comfy.sample

                latent["samples"] = comfy.sample.fix_empty_latent_channels(
                    guider.model_patcher,
                    latent["samples"],
                    latent.get("downscale_ratio_spacial"),
                    latent.get("downscale_ratio_temporal"),
                )
            except (ImportError, AttributeError):
                pass

            def _guider_sample(
                noise: _SampleTensor, latent_samples: _SampleTensor, stage_sigmas: torch.Tensor,
            ) -> _SampleTensor:
                samples: _SampleTensor = guider.sample(
                    noise,
                    latent_samples,
                    sampler,
                    stage_sigmas,
                    denoise_mask=latent.get("noise_mask"),
                    callback=callback,
                    disable_pbar=True,
                    seed=seed,
                )
                return samples

            noise = (_noise(seed) if noise_stream is None else noise_stream).generate_noise(latent)
            if trace_recorder is not None:
                trace_recorder.record_inputs(
                    noise=noise,
                    latent=latent["samples"],
                    conditioning=getattr(conditioning, "original_conds", None),
                )
            patcher = getattr(conditioning, "model_patcher", model)
            with _capture_model_inputs(trace_recorder, freeze_controller, patcher):
                if freeze_controller is None:
                    samples = _guider_sample(noise, latent["samples"], sigmas)
                else:
                    from .speculative_forcing_freeze import install_token_freezing

                    with install_token_freezing(patcher, freeze_controller):
                        samples = _guider_sample(noise, latent["samples"], sigmas)
            out = latent.copy()
            out.pop("downscale_ratio_spacial", None)
            out.pop("downscale_ratio_temporal", None)
            if freeze_controller is not None:
                from .speculative_forcing_probe import video_clean_estimate

                freeze_controller.project_committed_video(video_clean_estimate(samples))
            out["samples"] = samples
            return out

        import comfy.sample

        def _custom_sample(
            noise: _SampleTensor, latent_samples: _SampleTensor, stage_sigmas: torch.Tensor,
        ) -> _SampleTensor:
            samples: _SampleTensor = comfy.sample.sample_custom(
                model,
                noise,
                1.0,
                sampler,
                stage_sigmas,
                conditioning,
                None,
                latent_samples,
                noise_mask=latent.get("noise_mask"),
                callback=callback,
                disable_pbar=True,
                seed=seed,
            )
            return samples

        noise = (_noise(seed) if noise_stream is None else noise_stream).generate_noise(latent)
        if trace_recorder is not None:
            trace_recorder.record_inputs(
                noise=noise,
                latent=latent["samples"],
                conditioning=getattr(conditioning, "original_conds", None),
            )
        patcher = getattr(conditioning, "model_patcher", model)
        with _capture_model_inputs(trace_recorder, freeze_controller, patcher):
            if freeze_controller is None:
                samples = _custom_sample(noise, latent["samples"], sigmas)
            else:
                from .speculative_forcing_freeze import install_token_freezing

                with install_token_freezing(patcher, freeze_controller):
                    samples = _custom_sample(noise, latent["samples"], sigmas)
        out = latent.copy()
        out.pop("downscale_ratio_spacial", None)
        out.pop("downscale_ratio_temporal", None)
        if freeze_controller is not None:
            from .speculative_forcing_probe import video_clean_estimate

            freeze_controller.project_committed_video(video_clean_estimate(samples))
        out["samples"] = samples
        return out
