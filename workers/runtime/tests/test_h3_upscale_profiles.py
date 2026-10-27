from __future__ import annotations

import importlib.util
import tempfile
import sys
import unittest
from pathlib import Path
from types import ModuleType, SimpleNamespace
from unittest.mock import Mock, patch

ROOT = Path(__file__).resolve().parents[3]
NODE_ROOT = ROOT / "vendor/comfystream/runtime/deploy/custom_nodes/comfystream_sol_refiner_h3"


def load_module(name: str, path: Path):
    spec = importlib.util.spec_from_file_location(name, path)
    if spec is None or spec.loader is None:
        raise AssertionError(f"could not load {path}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class AutomaticUpscaleProfileTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.profiles = load_module("sloptogether_h3_hardware_profiles", NODE_ROOT / "hardware_profiles.py")

    def test_4090_class_hardware_uses_ada_fp8_profile(self):
        profile = self.profiles.select_transformer_precision((8, 9), 24_564 * 1024**2, 23 * 1024**3)
        self.assertEqual(profile, "fp8")

    def test_large_blackwell_requires_the_resident_memory_reserve(self):
        total = 96 * 1024**3
        self.assertEqual(self.profiles.select_transformer_precision((10, 0), total, 90 * 1024**3), "nvfp4")
        with self.assertRaisesRegex(RuntimeError, "90 GiB free VRAM"):
            self.profiles.select_transformer_precision((10, 0), total, 80 * 1024**3)

    def test_blackwell_releases_its_resident_child_before_rechecking_memory(self):
        release = Mock()
        probe = Mock(return_value=91 * 1024**3)
        profile = self.profiles.select_transformer_precision(
            (10, 0), 96 * 1024**3, 20 * 1024**3,
            release_resident_worker=release, probe_free_memory=probe,
        )
        self.assertEqual(profile, "nvfp4")
        release.assert_called_once_with()
        probe.assert_called_once_with()

    def test_blackwell_fails_if_releasing_child_does_not_restore_reserve(self):
        release = Mock()
        with self.assertRaisesRegex(RuntimeError, "90 GiB free VRAM"):
            self.profiles.select_transformer_precision(
                (10, 0), 96 * 1024**3, 20 * 1024**3,
                release_resident_worker=release, probe_free_memory=lambda: 80 * 1024**3,
            )
        release.assert_called_once_with()

    def test_hardware_below_the_adaptive_profile_fails_closed(self):
        for capability, memory in [((8, 6), 24 * 1024**3), ((8, 9), 16 * 1024**3)]:
            with self.subTest(capability=capability, memory=memory), self.assertRaises(RuntimeError):
                self.profiles.select_transformer_precision(capability, memory, memory)

    def test_ada_fp8_uses_sequential_offload_without_moving_the_full_pipeline_first(self):
        pipeline = Mock(transformer_precision="fp8")
        self.profiles.configure_pipeline_device(pipeline)
        pipeline.enable_sequential_cpu_offload.assert_called_once_with(gpu_id=0)
        pipeline.to.assert_not_called()
        self.assertEqual(pipeline.model_residency, "cpu-sequential-offload")
        self.assertTrue(pipeline.cpu_offload_enabled)

    def test_blackwell_resident_path_keeps_its_existing_device_behavior(self):
        pipeline = Mock(transformer_precision="nvfp4")
        self.profiles.configure_pipeline_device(pipeline)
        pipeline.to.assert_called_once_with("cuda")
        pipeline.enable_sequential_cpu_offload.assert_not_called()
        self.assertEqual(pipeline.model_residency, "cuda")
        self.assertFalse(pipeline.cpu_offload_enabled)


class SoLHostMemorySamplerTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.runtime = load_module("sloptogether_h3_model_runtime_memory", NODE_ROOT / "model_runtime.py")

    def test_reports_peak_process_and_cgroup_usage_and_lowest_available_ram(self):
        sampler = self.runtime.HostMemorySampler(reader=lambda: {})
        sampler.observe({
            "process_rss_bytes": 2 * 1024**3,
            "system_total_bytes": 128 * 1024**3,
            "system_available_bytes": 96 * 1024**3,
            "cgroup_current_bytes": 4 * 1024**3,
            "cgroup_limit_bytes": 120 * 1024**3,
        })
        sampler.observe({
            "process_rss_bytes": 12 * 1024**3,
            "system_total_bytes": 128 * 1024**3,
            "system_available_bytes": 48 * 1024**3,
            "cgroup_current_bytes": 24 * 1024**3,
            "cgroup_limit_bytes": 120 * 1024**3,
        })
        sampler.observe({
            "process_rss_bytes": 8 * 1024**3,
            "system_total_bytes": 128 * 1024**3,
            "system_available_bytes": 64 * 1024**3,
            "cgroup_current_bytes": 16 * 1024**3,
            "cgroup_limit_bytes": 120 * 1024**3,
        })
        self.assertEqual(sampler.report(), {
            "host_memory_sample_count": 3,
            "host_memory_sample_interval_ms": 250,
            "host_process_rss_start_bytes": 2 * 1024**3,
            "host_process_rss_peak_bytes": 12 * 1024**3,
            "host_system_total_bytes": 128 * 1024**3,
            "host_system_available_min_bytes": 48 * 1024**3,
            "host_cgroup_memory_peak_bytes": 24 * 1024**3,
            "host_cgroup_memory_limit_bytes": 120 * 1024**3,
            "host_cgroup_memory_available_min_bytes": 96 * 1024**3,
        })

    def test_unavailable_measurement_sources_do_not_create_fake_zero_metrics(self):
        sampler = self.runtime.HostMemorySampler(reader=lambda: {})
        sampler.observe({})
        report = sampler.report()
        self.assertIsNone(report["host_process_rss_peak_bytes"])
        self.assertIsNone(report["host_system_available_min_bytes"])
        self.assertIsNone(report["host_cgroup_memory_peak_bytes"])


class SoLCheckpointPrefetchTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.runtime = load_module("sloptogether_h3_model_runtime_prefetch", NODE_ROOT / "model_runtime.py")

    def test_ada_offload_does_not_prime_an_entire_checkpoint_into_container_page_cache(self):
        with patch.object(self.runtime, "_prefetch_cached_safetensors") as prefetch:
            self.runtime._prefetch_pipeline_weights(
                Path("unused"), transformer_precision="fp8", decoder_mode="pruna_fast",
                fixed_conditioning=True, cached_transformer=False,
            )
        prefetch.assert_not_called()

    def test_only_components_the_pipeline_will_load_are_read(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            for component in ("transformer", "vae", "diffusion_decoder", "text_encoder", "connectors"):
                (root / component).mkdir()
                (root / component / "weights.safetensors").write_bytes(b"weights")
            opened = []
            original_open = Path.open

            def track_open(path, *args, **kwargs):
                opened.append(path.parent.name)
                return original_open(path, *args, **kwargs)

            with patch.object(Path, "open", track_open):
                self.runtime._prefetch_pipeline_weights(
                    root, transformer_precision="nvfp4", decoder_mode="pruna_fast",
                    fixed_conditioning=True, cached_transformer=True,
                )
            self.assertEqual(opened, ["vae"])


class AdaFloat8QuantizationTest(unittest.TestCase):
    def test_windows_ram_probe_uses_physical_memory_limit(self):
        from sloptogether_worker import runner

        def read_status(pointer):
            pointer._obj.ullTotalPhys = 128 * 1024**3
            return 1

        kernel32 = SimpleNamespace(GlobalMemoryStatusEx=read_status)
        with patch.object(runner.sys, "platform", "win32"), patch.object(
            runner.ctypes, "windll", SimpleNamespace(kernel32=kernel32), create=True,
        ):
            self.assertEqual(runner.detect_system_memory(), 128 * 1024**3)

    def test_windows_wsl_ram_probe_uses_the_distribution_memory_limit(self):
        from sloptogether_worker import runner

        result=SimpleNamespace(returncode=0,stdout="67108864\n")
        with patch.object(runner.sys,"platform","win32"),patch.object(runner.shutil,"which",return_value="wsl.exe"),patch.object(
            runner.subprocess,"run",return_value=result,
        ) as run:
            self.assertEqual(runner.detect_system_memory(wsl_distro="Ubuntu-24.04"),64*1024**3)
        self.assertEqual(run.call_args.args[0][1:4],["--distribution","Ubuntu-24.04","--exec"])
        self.assertFalse(run.call_args.kwargs["shell"])

    def test_windows_wsl_ram_probe_fails_closed_when_the_distribution_is_unavailable(self):
        from sloptogether_worker import runner

        with patch.object(runner.sys,"platform","win32"),patch.object(runner.shutil,"which",return_value=None):
            self.assertIsNone(runner.detect_system_memory(wsl_distro="Ubuntu-24.04"))

    def test_uses_torchao_fp8_per_row_only_on_ada_or_newer(self):
        quantize = Mock()
        config = Mock(return_value="rowwise-fp8")
        per_row = Mock(return_value="per-row")

        class Linear:
            def __init__(self, size: int):
                self.in_features = size
                self.out_features = size

        class Transformer:
            def named_modules(self):
                return [("large", Linear(1024)), ("small", Linear(512))]

        torch_module = SimpleNamespace(
            cuda=SimpleNamespace(is_available=lambda: True, get_device_capability=lambda: (8, 9)),
            nn=SimpleNamespace(Linear=Linear),
        )
        torchao_module = ModuleType("torchao")
        torchao_quantization = ModuleType("torchao.quantization")
        torchao_quantization.Float8DynamicActivationFloat8WeightConfig = config
        torchao_quantization.PerRow = per_row
        torchao_quantization.quantize_ = quantize
        torchao_module.quantization = torchao_quantization
        module = load_module("sloptogether_h3_fp8_optimizations", NODE_ROOT / "fp8_optimizations.py")
        with patch.dict(sys.modules, {"torch": torch_module, "torchao": torchao_module, "torchao.quantization": torchao_quantization}):
            self.assertEqual(module.enable_transformer_fp8(Transformer()), ("large",))

        config.assert_called_once_with(granularity="per-row")
        quantize.assert_called_once()
        self.assertEqual(quantize.call_args.args[0].__class__.__name__, "Transformer")
        self.assertEqual(quantize.call_args.args[1], "rowwise-fp8")
        self.assertTrue(quantize.call_args.kwargs["filter_fn"](Linear(1024), "large"))
        self.assertFalse(quantize.call_args.kwargs["filter_fn"](Linear(512), "small"))

    def test_rejects_pre_ada_gpus(self):
        torch_module = SimpleNamespace(
            cuda=SimpleNamespace(is_available=lambda: True, get_device_capability=lambda: (8, 6)),
            nn=SimpleNamespace(Linear=type("Linear", (), {})),
        )
        module = load_module("sloptogether_h3_fp8_optimizations_sm86", NODE_ROOT / "fp8_optimizations.py")
        with patch.dict(sys.modules, {"torch": torch_module}):
            with self.assertRaisesRegex(RuntimeError, "Ada"):
                module.enable_transformer_fp8(object())


if __name__ == "__main__":
    unittest.main()
