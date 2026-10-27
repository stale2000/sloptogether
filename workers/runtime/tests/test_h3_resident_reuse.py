from __future__ import annotations

import os
import sys
import tempfile
import threading
import time
import unittest
from fractions import Fraction
from pathlib import Path
from types import ModuleType, SimpleNamespace
from unittest.mock import Mock, patch

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT / "vendor/comfystream/runtime"))
from deploy.custom_nodes.comfystream_sol_refiner_h3 import node, worker_client  # noqa: E402
from deploy.custom_nodes.comfystream_sol_refiner_h3.hardware_profiles import resident_reuse_is_safe  # noqa: E402

GIB = 1024**3


class ResidentAdmissionTest(unittest.TestCase):
    def test_resident_requires_exact_live_worker_profile_and_free_headroom(self):
        kwargs = dict(capability=(10, 0), total_memory_bytes=96*GIB,
                      free_memory_bytes=70*GIB, peak_reserved_bytes=30*GIB,
                      profile_matches=True, worker_matches=True)
        self.assertTrue(resident_reuse_is_safe(**kwargs))
        for change in ({"profile_matches": False}, {"worker_matches": False},
                       {"free_memory_bytes": 31*GIB}, {"peak_reserved_bytes": None},
                       {"free_memory_bytes": 100*GIB}, {"peak_reserved_bytes": True},
                       {"capability": (8, 9)}):
            with self.subTest(change=change):
                self.assertFalse(resident_reuse_is_safe(**{**kwargs, **change}))

    def test_registry_never_replaces_a_dead_or_changed_reserved_child(self):
        registry = worker_client.WorkerClientRegistry()
        client = Mock(signature=("runtime-a",), _closed=False)
        client.process.pid = 123
        client.is_alive.return_value = True
        registry._clients["single"] = client
        self.assertIs(registry.compatible_token("single", ("runtime-a",)), client)
        self.assertIs(registry.compatible_token("single", ("runtime-a",), expected_pid=123), client)
        self.assertIsNone(registry.compatible_token("single", ("runtime-a",), expected_pid=124))
        self.assertIsNone(registry.compatible_token("single", ("runtime-b",)))
        client.is_alive.return_value = False
        self.assertIsNone(registry.compatible_token("single", ("runtime-a",)))
        with patch.object(worker_client, "PersistentWorkerClient") as spawn:
            with self.assertRaisesRegex(RuntimeError, "changed before"):
                registry.request("single", ("runtime-a",), [], {}, Path("unused"), {},
                                 timeout=1, label="test", required_token=client)
            replacement = Mock(signature=("runtime-a",), _closed=False)
            replacement.is_alive.return_value = True
            registry._clients["single"] = replacement
            with self.assertRaisesRegex(RuntimeError, "changed before"):
                registry.request("single", ("runtime-a",), [], {}, Path("unused"), {},
                                 timeout=1, label="test", required_token=client)
            replacement.request.assert_not_called()
            spawn.assert_not_called()

class NodeResidentReuseTest(unittest.TestCase):
    def test_changed_runtime_geometry_and_external_memory_cannot_reuse(self):
        with tempfile.TemporaryDirectory() as directory:
            source = str(Path(directory) / "source.mp4")
            Path(source).write_bytes(b"input")
            token = object()
            signature = (sys.executable, (("source", 1),), "safe-fingerprint")
            registry = Mock()
            registry.compatible_token.side_effect = lambda _key, value, **_kwargs: token if value == signature else None
            registry.keys.return_value = ("single",)
            video = SimpleNamespace(get_stream_source=lambda: source, get_dimensions=lambda: (512, 288),
                                    get_frame_rate=lambda: Fraction(24, 1))
            meta = {"frames": 360, "width": 512, "height": 288, "fps": Fraction(24, 1)}
            gpu = SimpleNamespace(get_device_capability=lambda: (10, 0),
                                  get_device_properties=lambda _i: SimpleNamespace(total_memory=96*GIB),
                                  mem_get_info=Mock(return_value=(70*GIB, 96*GIB)))
            folder_paths = ModuleType("folder_paths"); folder_paths.get_output_directory = lambda: directory
            latest = ModuleType("comfy_api.latest"); latest.InputImpl = SimpleNamespace(VideoFromFile=lambda p: p)
            package = ModuleType("comfy_api"); package.latest = latest
            torch = ModuleType("torch"); torch.cuda = gpu
            report = {"status":"succeeded", "transformer_precision":"nvfp4", "model_residency":"cuda",
                      "frames":360, "width":1184, "height":666, "fps":"24/1",
                      "worker_pid":123, "peak_reserved_bytes":30*GIB}
            requests = []
            counter_lock = threading.Lock()
            active = 0
            maximum = 0
            def fake_request(_python, request, _target, *, prepared, required_token):
                nonlocal active, maximum
                with counter_lock:
                    active += 1
                    maximum = max(maximum, active)
                try:
                    time.sleep(0.02)
                    requests.append((request.copy(), required_token))
                    Path(request["output"]).write_bytes(b"output")
                    return {**report, "width":request["width"], "height":request["height"],
                            "transformer_precision":request["transformer_precision"],
                            "model_residency":"cuda" if request["transformer_precision"] == "nvfp4" else "cpu-sequential-offload"}
                finally:
                    with counter_lock:
                        active -= 1
            with patch.dict(sys.modules, {"folder_paths":folder_paths, "comfy_api":package,
                                          "comfy_api.latest":latest, "torch":torch}), \
                 patch.dict(os.environ, {"COMFYSTREAM_SOL_H3_PYTHON":sys.executable}), \
                 patch.object(node, "_WORKER_REGISTRY", registry), \
                 patch.object(node, "_RESIDENT_PROOF", None), \
                 patch.object(node, "_release_comfy_models", return_value=True), \
                 patch.object(node, "probe_source_metadata", return_value=meta) as probe, \
                 patch.object(node, "_worker_preparation", return_value=({}, signature[1], signature[2])) as preparation, \
                 patch.object(node, "_request_worker", side_effect=fake_request), \
                 patch.object(node, "_transformer_precision_mode", side_effect=lambda mode: "fp8" if mode == "fp8" else "nvfp4") as cold:
                refiner = node.MiniMaxH3SoLUpscaler()
                args = dict(width=1184, height=666, transformer_precision="auto", decoder_mode="pruna_fast", cache_conditioning=True)
                refiner.refine(video, "same prompt", **args)
                refiner.refine(video, "same prompt", **args)
                self.assertEqual(cold.call_count, 1)
                self.assertIs(requests[1][1], token)
                meta["frames"] = 361
                refiner.refine(video, "same prompt", **args)
                self.assertIsNone(requests[-1][1])
                meta["frames"] = 360
                gpu.mem_get_info.return_value = (31*GIB, 96*GIB)
                refiner.refine(video, "same prompt", **args)
                self.assertIsNone(requests[-1][1])
                gpu.mem_get_info.return_value = (70*GIB, 96*GIB)
                refiner.refine(video, "different prompt", **args)
                self.assertIsNone(requests[-1][1])
                preparation.return_value = ({}, signature[1], "changed-runtime")
                refiner.refine(video, "different prompt", **args)
                self.assertIsNone(requests[-1][1])
                self.assertEqual(cold.call_count, 5)
                probe.side_effect = ValueError("ffprobe output exceeds the bounded limit")
                refiner.refine(video, "same prompt", **args)
                self.assertIsNone(requests[-1][1])
                probe.side_effect = None
                preparation.return_value = ({}, signature[1], signature[2])
                refiner.refine(video, "same prompt", **args)
                refiner.refine(video, "same prompt", **{**args, "width":1920, "height":1080})
                self.assertIsNone(requests[-1][1])
                registry.compatible_token.return_value = None
                registry.compatible_token.side_effect = None
                refiner.refine(video, "same prompt", **args)
                self.assertIsNone(requests[-1][1])
                refiner.refine(video, "same prompt", **{**args, "transformer_precision":"fp8"})
                self.assertIsNone(requests[-1][1])
                self.assertEqual(requests[-1][0]["transformer_precision"], "fp8")
                registry.compatible_token.return_value = token
                failures = []
                def run():
                    try:
                        refiner.refine(video, "same prompt", **args)
                    except Exception as error:
                        failures.append(error)
                first = threading.Thread(target=run); second = threading.Thread(target=run)
                first.start(); second.start(); first.join(3); second.join(3)
                self.assertEqual(failures, [])
                self.assertFalse(first.is_alive() or second.is_alive())
                self.assertEqual(maximum, 1)


if __name__ == "__main__":
    unittest.main()
