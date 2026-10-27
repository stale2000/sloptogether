from __future__ import annotations

import importlib.util
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
