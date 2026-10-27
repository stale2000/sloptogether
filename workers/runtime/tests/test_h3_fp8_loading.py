from __future__ import annotations

import importlib.util
import sys
import unittest
from contextlib import contextmanager
from pathlib import Path
from types import ModuleType, SimpleNamespace
from unittest.mock import Mock, patch


ROOT = Path(__file__).resolve().parents[3]
SOURCE = ROOT / "vendor/comfystream/runtime/deploy/custom_nodes/comfystream_sol_refiner_h3/fp8_loading.py"


class LoadTimeFP8Test(unittest.TestCase):
    def setUp(self):
        package = ModuleType("sloptogether_h3_fp8_test")
        package.__path__ = [str(SOURCE.parent)]
        package_patch = patch.dict(sys.modules, {package.__name__: package})
        package_patch.start()
        self.addCleanup(package_patch.stop)
        spec = importlib.util.spec_from_file_location(f"{package.__name__}.fp8_loading", SOURCE)
        self.module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(self.module)
        self.meta_active = False

        class Float8Tensor:
            pass

        class Linear:
            def __init__(self, input_size, output_size, weight=None):
                self.in_features = input_size
                self.out_features = output_size
                self.weight = weight

        self.Float8Tensor = Float8Tensor
        self.Linear = Linear
        self.modules = [
            ("blocks.0.attn.to_q", Linear(1024, 2048)),
            ("blocks.0.attn.to_k", Linear(4096, 512)),
            ("projection", Linear(2048, 1024)),
            ("normalization", object()),
        ]

        @contextmanager
        def empty_weights(**kwargs):
            self.assertEqual(kwargs, {"include_buffers": True})
            self.meta_active = True
            try:
                yield
            finally:
                self.meta_active = False

        def from_config(config):
            self.assertTrue(self.meta_active, "architecture must be created without real weights")
            self.assertEqual(config, {"model": "pinned"})
            return SimpleNamespace(named_modules=lambda: self.modules)

        self.loaded = SimpleNamespace(named_modules=lambda: [
            ("blocks.0.attn.to_q", Linear(1024, 2048, Float8Tensor())),
            ("blocks.0.attn.to_k", Linear(4096, 512, SimpleNamespace(dtype="bf16"))),
            ("projection", Linear(2048, 1024, Float8Tensor())),
        ])
        self.loader = SimpleNamespace(
            load_config=Mock(return_value={"model": "pinned"}),
            from_config=Mock(side_effect=from_config),
            from_pretrained=Mock(return_value=self.loaded),
        )
        self.torchao_config = Mock(return_value="torchao-config")
        self.fp8_config = Mock(return_value="per-row-fp8")
        self.per_row = Mock(return_value="per-row")
        self.mock_modules = {}
        for name in ("torch", "accelerate", "diffusers", "torchao", "torchao.quantization",
                     "torchao.quantization.quantize_", "torchao.quantization.quantize_.workflows"):
            self.mock_modules[name] = ModuleType(name)
        self.mock_modules["torch"].bfloat16 = "bf16"
        self.mock_modules["torch"].nn = SimpleNamespace(Linear=Linear)
        self.mock_modules["torch"].cuda = SimpleNamespace(
            is_available=lambda: True, get_device_capability=lambda: (8, 9),
        )
        self.mock_modules["accelerate"].init_empty_weights = empty_weights
        self.mock_modules["diffusers"].TorchAoConfig = self.torchao_config
        self.mock_modules["torchao.quantization"].Float8DynamicActivationFloat8WeightConfig = self.fp8_config
        self.mock_modules["torchao.quantization"].PerRow = self.per_row
        self.mock_modules["torchao.quantization.quantize_.workflows"].Float8Tensor = Float8Tensor
        self.patch = patch.dict(sys.modules, self.mock_modules)
        self.patch.start()
        self.addCleanup(self.patch.stop)

    def load(self):
        return self.module.load_transformer_fp8(self.loader, "model/repository", "a" * 40)

    def test_streams_per_row_fp8_weights_with_same_large_linear_selection(self):
        transformer, names = self.load()
        self.assertIs(transformer, self.loaded)
        self.assertEqual(names, ("blocks.0.attn.to_q", "projection"))
        self.loader.load_config.assert_called_once_with(
            "model/repository", subfolder="transformer", revision="a" * 40,
        )
        self.fp8_config.assert_called_once_with(granularity="per-row")
        self.torchao_config.assert_called_once_with(
            "per-row-fp8", modules_to_not_convert=["blocks.0.attn.to_k"],
        )
        self.loader.from_pretrained.assert_called_once_with(
            "model/repository", subfolder="transformer", revision="a" * 40,
            torch_dtype="bf16", low_cpu_mem_usage=True, use_safetensors=True,
            quantization_config="torchao-config",
        )
        # Explicit CPU device maps make pinned Diffusers skip CPU quantization.
        self.assertNotIn("device_map", self.loader.from_pretrained.call_args.kwargs)

    def test_rejects_silent_bf16_weights_instead_of_claiming_fp8(self):
        self.loaded.named_modules = lambda: [
            (name, self.Linear(1024, 1024, object())) for name in ("blocks.0.attn.to_q", "projection")
        ]
        with self.assertRaisesRegex(RuntimeError, "FP8.*not quantized"):
            self.load()
        self.loader.from_pretrained.assert_called_once()

    def test_rejects_changes_to_small_linear_precision(self):
        modules = list(self.loaded.named_modules())
        modules[1][1].weight = self.Float8Tensor()
        self.loaded.named_modules = lambda: modules
        with self.assertRaisesRegex(RuntimeError, "excluded Linear"):
            self.load()

    def test_no_matching_layers_never_loads_checkpoint(self):
        self.modules = [("small", self.Linear(512, 512))]
        with self.assertRaisesRegex(RuntimeError, "no transformer Linear"):
            self.load()
        self.loader.from_pretrained.assert_not_called()

    def test_checkpoint_failure_does_not_retry_a_full_bf16_load(self):
        self.loader.from_pretrained.side_effect = OSError("incomplete checkpoint")
        with self.assertRaisesRegex(OSError, "incomplete checkpoint"):
            self.load()
        self.loader.from_pretrained.assert_called_once()

    def test_rejects_non_ada_hardware_before_loading_architecture(self):
        self.mock_modules["torch"].cuda.get_device_capability = lambda: (8, 6)
        with self.assertRaisesRegex(RuntimeError, "Ada"):
            self.load()
        self.loader.load_config.assert_not_called()

    def test_rejects_missing_cuda_before_loading_architecture(self):
        self.mock_modules["torch"].cuda.is_available = lambda: False
        with self.assertRaisesRegex(RuntimeError, "CUDA GPU"):
            self.load()
        self.loader.load_config.assert_not_called()

    def test_requires_immutable_model_revision(self):
        with self.assertRaisesRegex(ValueError, "immutable model commit"):
            self.module.load_transformer_fp8(self.loader, "model/repository", "main")
        self.loader.load_config.assert_not_called()

    def test_rejects_missing_selected_layer_after_loading(self):
        self.loaded.named_modules = lambda: [("projection", self.Linear(2048, 1024, self.Float8Tensor()))]
        with self.assertRaisesRegex(RuntimeError, "to_q.*not quantized"):
            self.load()


class ModelRuntimeFP8IntegrationTest(unittest.TestCase):
    def test_injects_quantized_transformer_once_and_reuses_pipeline_without_requantizing(self):
        package_name = "sloptogether_h3_runtime_fp8_test"
        package = ModuleType(package_name)
        package.__path__ = [str(SOURCE.parent)]
        transformer = object()
        selected = ("blocks.0.attn.to_q", "projection")
        load_fp8 = Mock(return_value=(transformer, selected))
        full_transformer_loader = Mock(side_effect=AssertionError("full BF16 load is forbidden"))
        old_quantizer = Mock(side_effect=AssertionError("second quantization is forbidden"))
        pipeline = SimpleNamespace(transformer=transformer, diffusion_decoder=None)
        pipeline_loader = Mock(return_value=pipeline)
        registry = {"existing": ["save", "load"]}
        loading_utils = SimpleNamespace(LOADABLE_CLASSES={"sol_refiner_h3": registry})
        modules = {package_name: package}
        for name in (
            "torch", "diffusers", "diffusers.pipelines", "huggingface_hub", "sol_refiner_h3",
            f"{package_name}.fp8_loading", f"{package_name}.fp8_optimizations",
            f"{package_name}.sol_refiner_h3", f"{package_name}.sol_refiner_h3.attention",
        ):
            modules[name] = ModuleType(name)
        modules["torch"].bfloat16 = "bf16"
        modules["torch"].cuda = SimpleNamespace(is_available=lambda: True, is_bf16_supported=lambda: True)
        modules["diffusers"].LTX2VideoTransformer3DModel = SimpleNamespace(from_pretrained=full_transformer_loader)
        modules["diffusers.pipelines"].pipeline_loading_utils = loading_utils
        modules[f"{package_name}.fp8_loading"].load_transformer_fp8 = load_fp8
        modules[f"{package_name}.fp8_optimizations"].enable_transformer_fp8 = old_quantizer
        modules[f"{package_name}.sol_refiner_h3"].SoLRefinerH3Pipeline = SimpleNamespace(from_pretrained=pipeline_loader)
        modules[f"{package_name}.sol_refiner_h3.attention"].LocalNattenProcessor = Mock()
        keep_pipeline = Mock()
        with patch.dict(sys.modules, modules):
            spec = importlib.util.spec_from_file_location(
                f"{package_name}.model_runtime", SOURCE.parent / "model_runtime.py",
            )
            runtime = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(runtime)
            owner = runtime.ModelRuntime()
            options = {
                "decoder_mode": "pruna_fast",
                "transformer_precision": "fp8",
                "transformer_flags": lambda *_args: False,
                "precision_mode": lambda mode: mode,
                "experiment_flag": lambda _name, default=False: default,
                "validate_runtime": Mock(),
                "natten_backend_name": lambda: "libnatten",
                "ensure_source_path": Mock(return_value="runtime"),
                "keep_pipeline_on_cuda": keep_pipeline,
            }
            self.assertIs(owner.load_pipeline("model/repository", **options), pipeline)
            self.assertIs(owner.load_pipeline("model/repository", **options), pipeline)
        load_fp8.assert_called_once_with(
            modules["diffusers"].LTX2VideoTransformer3DModel, "model/repository", runtime.MODEL_REVISION,
        )
        pipeline_loader.assert_called_once_with(
            "model/repository", revision=runtime.MODEL_REVISION, torch_dtype="bf16",
            low_cpu_mem_usage=True, transformer=transformer, diffusion_decoder=None,
        )
        self.assertEqual(pipeline.transformer_fp8_linear_names, selected)
        self.assertEqual(pipeline.transformer_precision, "fp8")
        self.assertIs(loading_utils.LOADABLE_CLASSES["sol_refiner_h3"], registry)
        full_transformer_loader.assert_not_called()
        old_quantizer.assert_not_called()
        keep_pipeline.assert_called_once_with(pipeline)


if __name__ == "__main__":
    unittest.main()
