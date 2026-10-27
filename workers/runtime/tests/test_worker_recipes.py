import hashlib
import importlib.util
import json
import unittest
from dataclasses import replace
from datetime import datetime, timezone
from importlib.resources import files
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock, patch

from sloptogether_worker.errors import WorkerError
from sloptogether_worker.models import WorkerJob
from sloptogether_worker.runner import ComfyRecipeRunner, inspect_media
from sloptogether_worker.recipes import (
    RECIPES, SOL_UPSCALE_ID, SOL_UPSCALE_1184_ID, SUBSCRIBER_TRIM_ID, TRIM_FIVE_STEP_ID, build_workflow,
    validate_comfy_capabilities, validate_device_recipe, validate_free_vram,
)


class PinnedRecipeTest(unittest.TestCase):
    def job(self, *, end_boundary=None, end_asset=None, recipe_id=TRIM_FIVE_STEP_ID):
        return WorkerJob(
            job_id="00000000-0000-4000-8000-000000000001",
            lease_id="lease-1",
            channel_id="123456789",
            stage="generation",
            kind=None,
            require_audio=False,
            execution_mode="pull_worker",
            recipe_id=recipe_id,
            recipe_sha256=RECIPES[recipe_id].source_digest,
            input_sha256="a" * 64,
            attempt_id="00000000-0000-4000-8000-000000000002",
            fence=1,
            attempt_deadline_at=datetime.now(timezone.utc),
            segment_revision_id="00000000-0000-4000-8000-000000000003",
            prompt="One continuous cartoon shot; the astronaut waves.",
            start_frame_asset_id="00000000-0000-4000-8000-000000000004",
            end_frame_asset_id=end_asset,
            requested_end_boundary_revision_id=end_boundary,
            endpoint_resolution_id=None,
            width=448,
            height=256,
            fps_num=24,
            fps_den=1,
            frame_count=RECIPES[recipe_id].frame_count or 362,
            source_asset_id=None,
        )

    def test_imported_workflows_match_the_recorded_bytes(self):
        records = json.loads(
            files("sloptogether_worker").joinpath("assets/recipes/provenance.json").read_text()
        )
        for record in records:
            data = files("sloptogether_worker").joinpath(
                "assets/recipes", record["destination"].split("/")[-1]
            ).read_bytes()
            self.assertEqual(hashlib.sha256(data).hexdigest(), record["sha256"])

    def test_continuation_uses_optional_end_not_the_start_frame(self):
        recipe = RECIPES[TRIM_FIVE_STEP_ID]
        node_id, graph = build_workflow(self.job(), recipe, {"20": "start-abc.png"})
        self.assertEqual(node_id, "12")
        self.assertNotIn("21", graph)
        node = graph["5"]
        self.assertEqual(node["inputs"]["first_frame"], ["20", 0])
        self.assertNotIn("last_frame", node["inputs"])

    def test_planned_anchor_uses_a_separate_end_image(self):
        _, graph = build_workflow(
            self.job(end_boundary="00000000-0000-4000-8000-000000000005",
                     end_asset="00000000-0000-4000-8000-000000000006"),
            RECIPES[TRIM_FIVE_STEP_ID],
            {"20": "start-abc.png", "21": "end-def.png"},
        )
        self.assertEqual(graph["5"]["inputs"]["last_frame"], ["21", 0])
        self.assertEqual(graph["21"]["inputs"]["image"], "end-def.png")

    def test_subscriber_interrupt_recipe_renders_ten_second_native_trim(self):
        recipe=RECIPES[SUBSCRIBER_TRIM_ID]
        job=self.job(recipe_id=SUBSCRIBER_TRIM_ID)
        _,graph=build_workflow(job,recipe,{"20":"start-abc.png"})
        length=graph["5"]["inputs"]["length"]
        self.assertEqual(length,243)
        self.assertAlmostEqual(length/24,10.125)
        self.assertEqual((length-5)%17,0)

    def test_trim_vsa_policy_is_explicitly_selected_by_the_deployment_profile(self):
        recipe = RECIPES[TRIM_FIVE_STEP_ID]
        _, fixed_graph = build_workflow(self.job(), recipe, {"20": "start.png"}, vsa_budget_policy="fixed")
        _, adaptive_graph = build_workflow(self.job(), recipe, {"20": "start.png"}, vsa_budget_policy="adaptive")
        self.assertEqual(fixed_graph["1"]["inputs"]["vsa_budget_policy"], "fixed")
        self.assertEqual(adaptive_graph["1"]["inputs"]["vsa_budget_policy"], "adaptive")
        with self.assertRaises(WorkerError) as raised:
            build_workflow(self.job(), recipe, {"20": "start.png"}, vsa_budget_policy="native")
        self.assertEqual(raised.exception.code, "trim_vsa_budget_policy_invalid")

    def test_generation_capability_requires_the_configured_vsa_budget_selector(self):
        object_info = {name: {} for name in RECIPES[TRIM_FIVE_STEP_ID].required_nodes}
        object_info["FastH3OptimizedLoader"] = {
            "input": {"optional": {"vsa_budget_policy": [["adaptive", "fixed"], {"default": "adaptive"}]}}
        }
        self.assertEqual(
            validate_comfy_capabilities(object_info, "generation", compute_capability=(8, 9), vsa_budget_policy="fixed"),
            [TRIM_FIVE_STEP_ID,SUBSCRIBER_TRIM_ID],
        )
        self.assertEqual(
            validate_comfy_capabilities(object_info,"generation",compute_capability=(8,9),platform="wsl",vsa_budget_policy="fixed"),
            [TRIM_FIVE_STEP_ID,SUBSCRIBER_TRIM_ID],
        )
        self.assertEqual(
            validate_comfy_capabilities(object_info, "generation", compute_capability=(12, 0), platform="fal", vsa_budget_policy="adaptive"),
            [TRIM_FIVE_STEP_ID,SUBSCRIBER_TRIM_ID],
        )
        self.assertEqual(
            validate_comfy_capabilities(object_info, "generation", compute_capability=(8, 9), vsa_budget_policy="adaptive"),
            [],
        )
        object_info["FastH3OptimizedLoader"]["input"]["optional"].pop("vsa_budget_policy")
        self.assertEqual(validate_comfy_capabilities(object_info, "generation", compute_capability=(8, 9)), [])

    def test_prompt_and_seed_are_server_job_bound(self):
        job = self.job()
        _, graph = build_workflow(job, RECIPES[TRIM_FIVE_STEP_ID], {"20": "start-abc.png"})
        self.assertEqual(graph["5"]["inputs"]["prompt"], job.prompt)
        self.assertEqual(graph["8"]["inputs"]["run_nonce"], f"slop-{job.job_id}-{job.attempt_id}-{job.fence}")
        self.assertEqual(graph["12"]["inputs"]["filename_prefix"],f"sloptogether/{job.job_id}/{job.attempt_id}/clip")

    def test_required_audio_rejects_a_soundtrack_dropped_by_upscale(self):
        metadata={"streams":[{"codec_type":"video","width":1920,"height":1080,"avg_frame_rate":"24/1"}],"format":{"duration":"15.0"}}
        with patch("sloptogether_worker.runner.shutil.which",return_value="ffprobe"), patch(
            "sloptogether_worker.runner.subprocess.run",return_value=SimpleNamespace(stdout=json.dumps(metadata)),
        ):
            with self.assertRaises(WorkerError) as raised:
                inspect_media(Path("upscaled.mp4"),expected_fps=None,require_audio=True)
        self.assertEqual(raised.exception.code,"worker_output_audio_missing")

    def test_unpinned_recipe_cannot_be_substituted(self):
        job = self.job()
        job = replace(job, recipe_sha256="b" * 64)
        with self.assertRaises(WorkerError):
            build_workflow(job, RECIPES[TRIM_FIVE_STEP_ID], {"20": "start-abc.png"})

    def test_upscale_uses_each_qualified_target_in_the_workflow(self):
        source = self.job()
        self.assertNotEqual(RECIPES[SOL_UPSCALE_1184_ID].source_digest, RECIPES[SOL_UPSCALE_ID].source_digest)
        for recipe_id, width, height in ((SOL_UPSCALE_1184_ID, 1184, 666), (SOL_UPSCALE_ID, 1920, 1080)):
            with self.subTest(width=width, height=height):
                job = replace(source, stage="upscale", recipe_id=recipe_id,
                              recipe_sha256=RECIPES[recipe_id].source_digest,
                              width=width, height=height, output_width=width, output_height=height,
                              source_asset_id="00000000-0000-4000-8000-000000000007")
                _, graph = build_workflow(job, RECIPES[recipe_id], {"source_video": "source.mp4"})
                self.assertEqual(graph["1"]["inputs"]["file"], "source.mp4")
                self.assertEqual((graph["2"]["inputs"]["width"], graph["2"]["inputs"]["height"]), (width, height))
                self.assertEqual(graph["2"]["inputs"]["transformer_precision"], "auto")
                self.assertEqual(graph["2"]["inputs"]["sloptogether_scope"],f"sloptogether/{job.job_id}/{job.attempt_id}")
                self.assertEqual(graph["3"]["inputs"]["filename_prefix"],f"sloptogether/{job.job_id}/{job.attempt_id}/clip")

    def test_upscale_rejects_unqualified_or_mismatched_targets(self):
        source = replace(self.job(), stage="upscale", recipe_id=SOL_UPSCALE_1184_ID,
                         recipe_sha256=RECIPES[SOL_UPSCALE_1184_ID].source_digest,
                         width=1184, height=666, output_width=1184, output_height=666,
                         source_asset_id="00000000-0000-4000-8000-000000000007")
        for job in (replace(source, width=1280, height=720, output_width=1280, output_height=720),
                    replace(source, output_width=1920, output_height=1080),
                    replace(source, recipe_id=SOL_UPSCALE_ID,recipe_sha256=RECIPES[SOL_UPSCALE_ID].source_digest)):
            with self.subTest(job=job), self.assertRaises(WorkerError) as raised:
                build_workflow(job, RECIPES[job.recipe_id], {"source_video": "source.mp4"})
            self.assertEqual(raised.exception.code, "recipe_dimensions_not_qualified")

    def test_sol_intermediates_use_the_current_job_attempt_output_scope(self):
        path=Path(__file__).parents[3]/"vendor/comfystream/runtime/deploy/custom_nodes/comfystream_sol_refiner_h3/sloptogether_scope.py"
        spec=importlib.util.spec_from_file_location("sloptogether_sol_scope",path)
        self.assertIsNotNone(spec)
        assert spec and spec.loader
        module=importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        root=Path("/tmp/comfy-output")
        scope="sloptogether/00000000-0000-4000-8000-000000000001/00000000-0000-4000-8000-000000000002"
        self.assertEqual(module.refiner_output_directory(root,scope),root/"sloptogether"/"00000000-0000-4000-8000-000000000001"/"00000000-0000-4000-8000-000000000002"/"sol-upscale")
        for invalid in ("/tmp/out","sloptogether/../escape/attempt",r"sloptogether\job\attempt"):
            with self.subTest(invalid=invalid), self.assertRaises(ValueError):
                module.refiner_output_directory(root,invalid)

    def test_upscale_capability_requires_auto_precision_node_and_ada_architecture(self):
        object_info = {
            "LoadVideo": {}, "SaveVideo": {},
            "ComfyStreamMiniMaxH3SoLUpscaler": {
                "input": {"optional": {"transformer_precision": [["nvfp4", "auto"], {"default": "nvfp4"}],"sloptogether_scope":["STRING",{"default":""}]}}
            },
        }
        self.assertEqual(validate_comfy_capabilities(object_info, "upscale", compute_capability=(8, 9)), [SOL_UPSCALE_ID,SOL_UPSCALE_1184_ID])
        self.assertEqual(validate_comfy_capabilities(object_info,"upscale",compute_capability=(8,9),platform="wsl"),[SOL_UPSCALE_ID,SOL_UPSCALE_1184_ID])
        self.assertEqual(
            validate_comfy_capabilities(object_info, "upscale", compute_capability=(8, 9), platform="windows"),
            [],
        )
        self.assertEqual(validate_comfy_capabilities(object_info, "upscale", compute_capability=(8, 6)), [])
        object_info["ComfyStreamMiniMaxH3SoLUpscaler"]["input"]["optional"]["transformer_precision"][0].remove("auto")
        self.assertEqual(validate_comfy_capabilities(object_info, "upscale", compute_capability=(8, 9)), [])
        object_info["ComfyStreamMiniMaxH3SoLUpscaler"]["input"]["optional"]["transformer_precision"][0].append("auto")
        object_info["ComfyStreamMiniMaxH3SoLUpscaler"]["input"]["optional"].pop("sloptogether_scope")
        self.assertEqual(validate_comfy_capabilities(object_info,"upscale",compute_capability=(8,9)),[])

    def test_ada_upscale_requires_system_ram_but_large_blackwell_does_not(self):
        validate_device_recipe(SOL_UPSCALE_ID, (8, 9), 24_564 * 1024**2, 128 * 1024**3)
        with self.assertRaises(WorkerError) as raised:
            validate_device_recipe(SOL_UPSCALE_ID, (8, 9), 24_564 * 1024**2, 64 * 1024**3)
        self.assertEqual(raised.exception.code, "recipe_system_memory_unsupported")
        with self.assertRaises(WorkerError) as missing:
            validate_device_recipe(SOL_UPSCALE_ID, (8, 9), 24_564 * 1024**2)
        self.assertEqual(missing.exception.code, "recipe_system_memory_unsupported")
        validate_device_recipe(SOL_UPSCALE_ID, (10, 0), 96 * 1024**3)

    def test_unqualified_windows_runtime_fails_before_it_can_claim_a_recipe(self):
        object_info = {
            "LoadVideo": {}, "SaveVideo": {},
            "ComfyStreamMiniMaxH3SoLUpscaler": {
                "input": {"optional": {"transformer_precision": [["auto"], {"default": "auto"}]}}
            },
        }
        comfy = Mock()
        comfy.object_info.return_value = object_info
        worker = ComfyRecipeRunner(SimpleNamespace(platform="windows"), comfy)
        with patch("sloptogether_worker.runner.shutil.which", return_value="tool"), \
                patch("sloptogether_worker.runner.detect_gpu_capability", return_value=((8, 9), 24_564 * 1024**2, "RTX 4090")), \
                patch("sloptogether_worker.runner.detect_gpu_free_memory", return_value=23 * 1024**3):
            with self.assertRaises(WorkerError) as raised:
                worker.check_compatible_nodes("upscale")
        self.assertEqual(raised.exception.code, "windows_inference_runtime_unavailable")
        comfy.queue_is_idle.assert_not_called()

    def test_blackwell_resident_upscale_reserves_90_gib_before_leasing(self):
        validate_free_vram(SOL_UPSCALE_ID, 90 * 1024**3, (10, 0), 96 * 1024**3)
        with self.assertRaises(WorkerError) as raised:
            validate_free_vram(SOL_UPSCALE_ID, 80 * 1024**3, (10, 0), 96 * 1024**3)
        self.assertEqual(raised.exception.code, "gpu_memory_reservation_insufficient")
        validate_free_vram(SOL_UPSCALE_ID, 22 * 1024**3, (8, 9), 24_564 * 1024**2)


if __name__ == "__main__":
    unittest.main()
