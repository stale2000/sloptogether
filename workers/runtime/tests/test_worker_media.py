from datetime import datetime, timezone
from pathlib import Path
from types import SimpleNamespace
import json
import tempfile
import unittest
from unittest.mock import Mock, patch

from sloptogether_worker.errors import WorkerError
from sloptogether_worker.comfy import ComfyClient
from sloptogether_worker.runner import ComfyRecipeRunner, MAX_FRAME_BYTES, MAX_VIDEO_BYTES, normalize_16x9, nvidia_smi_gpu_id
from sloptogether_worker import runner as runner_module


class WorkerMediaTest(unittest.TestCase):
    def test_runner_uses_the_bounded_comfy_asset_limits(self) -> None:
        self.assertEqual(MAX_FRAME_BYTES, 16 * 1024 * 1024)
        self.assertEqual(MAX_VIDEO_BYTES, 128 * 1024 * 1024)

    def test_comfy_cleanup_removes_only_worker_named_input_files(self) -> None:
        with tempfile.TemporaryDirectory() as folder:
            root=Path(folder)
            temporary=root/"slop-test-frame.png"
            unrelated=root/"viewer-frame.png"
            temporary.write_bytes(b"temporary")
            unrelated.write_bytes(b"keep")
            client=object.__new__(ComfyClient)
            client.config=SimpleNamespace(comfy_input_dir=root)

            client.remove_temporary_input(temporary.name)
            self.assertFalse(temporary.exists())
            self.assertTrue(unrelated.exists())
            with self.assertRaisesRegex(WorkerError,"non-temporary"):
                client.remove_temporary_input("../viewer-frame.png")

    def test_comfy_cleanup_removes_only_the_current_attempt_output_folder(self) -> None:
        job="00000000-0000-4000-8000-000000000041"
        attempt="00000000-0000-4000-8000-000000000042"
        other="00000000-0000-4000-8000-000000000043"
        with tempfile.TemporaryDirectory() as folder:
            root=Path(folder)
            current=root/"sloptogether"/job/attempt
            sibling=root/"sloptogether"/job/other
            current.mkdir(parents=True)
            sibling.mkdir(parents=True)
            (current/"result.mp4").write_bytes(b"video")
            (current/"result.json").write_text("private prompt metadata")
            (sibling/"keep.mp4").write_bytes(b"other attempt")
            client=object.__new__(ComfyClient)
            client.config=SimpleNamespace(comfy_output_dir=root)

            client.remove_attempt_outputs(job,attempt)
            self.assertFalse(current.exists())
            self.assertTrue((sibling/"keep.mp4").exists())
            with self.assertRaisesRegex(WorkerError,"invalid job attempt"):
                client.remove_attempt_outputs("../../private","../../other")

    def test_comfy_image_upload_uses_unique_temporary_name(self) -> None:
        with tempfile.TemporaryDirectory() as folder:
            image=Path(folder)/"start.png"
            image.write_bytes(b"\x89PNG\r\n\x1a\n"+b"test")
            client=object.__new__(ComfyClient)
            def response(_method,_path,**kwargs):
                body=kwargs["body"]
                start=body.index(b'filename="')+len(b'filename="')
                end=body.index(b'"',start)
                return json.dumps({"name":body[start:end].decode()}).encode()
            client._request=Mock(side_effect=response)
            first=client.upload_image(image)
            second=client.upload_image(image)
            self.assertTrue(first.startswith("slop-") and first.endswith(".png"))
            self.assertNotEqual(first,second)
            with self.assertRaisesRegex(WorkerError,"filename is invalid"):
                client.upload_image(image,r"slop-..\outside.png")

    def test_warm_model_cache_does_not_repeat_cold_vram_admission(self) -> None:
        comfy = Mock()
        comfy.object_info.return_value = {"nodes": True}
        runner = ComfyRecipeRunner(SimpleNamespace(platform="linux"), comfy)
        with patch.object(runner_module.shutil, "which", return_value="/usr/bin/tool"), \
             patch.object(runner_module, "detect_gpu_capability", return_value=((8, 9), 24 * 1024**3, "test GPU")), \
             patch.object(runner_module, "validate_comfy_capabilities", return_value=["trim"]), \
             patch.object(runner_module, "validate_device_recipe"), \
             patch.object(runner_module, "validate_free_vram"), \
             patch.object(runner_module, "detect_gpu_free_memory", return_value=24 * 1024**3) as memory:
            self.assertEqual(runner.check_compatible_nodes("generation"), ["trim"])
            memory.side_effect = AssertionError("warm render must not repeat cold VRAM admission")
            self.assertEqual(runner.check_compatible_nodes("generation"), ["trim"])
            comfy.object_info.assert_called_once()

    def test_adaptive_fal_profile_fails_closed_on_a_non_sm120_gpu(self) -> None:
        comfy=Mock()
        comfy.object_info.return_value={"nodes":True}
        runner=ComfyRecipeRunner(SimpleNamespace(platform="fal",trim_vsa_budget_policy="adaptive"),comfy)
        with patch.object(runner_module.shutil,"which",return_value="/usr/bin/tool"), \
             patch.object(runner_module,"detect_gpu_capability",return_value=((8,9),24*1024**3,"RTX 4090")):
            with self.assertRaises(WorkerError) as raised:
                runner.check_compatible_nodes("generation")
        self.assertEqual(raised.exception.code,"trim_adaptive_gpu_profile_mismatch")

    def test_startup_reclaims_only_an_idle_comfy_model_cache(self) -> None:
        comfy=Mock()
        comfy.object_info.return_value={"nodes":True}
        comfy.queue_is_idle.return_value=True
        runner=ComfyRecipeRunner(SimpleNamespace(platform="linux"),comfy)
        with patch.object(runner_module.shutil,"which",return_value="/usr/bin/tool"), \
             patch.object(runner_module,"detect_gpu_capability",return_value=((8,9),24*1024**3,"test GPU")), \
             patch.object(runner_module,"validate_comfy_capabilities",return_value=["trim"]), \
             patch.object(runner_module,"validate_device_recipe"), \
             patch.object(runner_module,"validate_free_vram",side_effect=[WorkerError("gpu_memory_reservation_insufficient","low VRAM"),None,None]), \
             patch.object(runner_module,"detect_gpu_free_memory",side_effect=[8*1024**3,24*1024**3]), \
             patch.object(runner_module.time,"sleep"):
            self.assertEqual(runner.check_compatible_nodes("generation"),["trim"])
            comfy.release_idle_models.assert_called_once()
            comfy.queue_is_idle.assert_called_once()

    def test_gpu_admission_uses_the_same_visible_adapter_as_comfy(self) -> None:
        self.assertEqual(nvidia_smi_gpu_id({}), "0")
        self.assertEqual(nvidia_smi_gpu_id({"CUDA_VISIBLE_DEVICES": "2,0"}), "2")
        self.assertEqual(nvidia_smi_gpu_id({"CUDA_VISIBLE_DEVICES": "GPU-abc, GPU-def"}), "GPU-abc")
        self.assertEqual(nvidia_smi_gpu_id({"SLOPTOGETHER_GPU_ID": "1", "CUDA_VISIBLE_DEVICES": "0"}), "1")
        self.assertIsNone(nvidia_smi_gpu_id({"CUDA_VISIBLE_DEVICES": "-1"}))

    def test_publication_frame_must_be_exact_16_by_9(self) -> None:
        with self.assertRaisesRegex(WorkerError, "16:9"):
            normalize_16x9(Path("source.mp4"), Path("target.mp4"), 448, 256, datetime.now(timezone.utc))


if __name__ == "__main__":
    unittest.main()
