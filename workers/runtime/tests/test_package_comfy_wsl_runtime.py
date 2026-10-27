from __future__ import annotations

import json
import importlib.util
import hashlib
import sys
import tempfile
import unittest
import zipfile
from pathlib import Path

ROOT=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT))
from package_comfy_wsl_runtime import package_runtime  # noqa: E402

VERIFY_SCRIPT=ROOT.parents[1]/"vendor/comfystream/runtime/scripts/verify_fasth3_models.py"
VERIFY_SPEC=importlib.util.spec_from_file_location("verify_fasth3_models",VERIFY_SCRIPT)
VERIFY_MODULE=importlib.util.module_from_spec(VERIFY_SPEC)
assert VERIFY_SPEC.loader is not None
VERIFY_SPEC.loader.exec_module(VERIFY_MODULE)


class ComfyWslRuntimeBundleTest(unittest.TestCase):
    def test_packages_pinned_weight_free_generation_and_upscale_nodes_reproducibly(self) -> None:
        with tempfile.TemporaryDirectory() as folder:
            root=Path(folder)
            first,digest1=package_runtime(root/"first.zip")
            second,digest2=package_runtime(root/"second.zip")
            self.assertEqual(digest1,digest2)
            with zipfile.ZipFile(first) as archive:
                names=set(archive.namelist())
                self.assertIn("worker-manifest.json",names)
                self.assertIn("deploy/vast/requirements.lock",names)
                self.assertIn("scripts/verify_fasth3_models.py",names)
                self.assertIn("deploy/fal/h3-sol-upscaler/requirements.lock",names)
                self.assertIn("deploy/custom_nodes/fasth3_deploy/__init__.py",names)
                self.assertIn("deploy/custom_nodes/comfystream_sol_refiner_h3/__init__.py",names)
                self.assertIn("deploy/custom_nodes/comfystream_worker_identity/__init__.py",names)
                self.assertFalse(any(Path(name).suffix.lower() in {".safetensors",".ckpt",".pt",".pth"} for name in names))
                manifest=json.loads(archive.read("worker-manifest.json"))
                self.assertEqual(manifest["profile"],"vast")
                self.assertIn("models",manifest["assets"])
                downloader=archive.read("scripts/download_fasth3_models.sh").decode()
                self.assertIn("from huggingface_hub import get_token",downloader)
                self.assertIn("FASTH3_TRIM_ONLY",downloader)
                for name in ("scripts/download_fasth3_models.sh","deploy/custom_nodes/comfystream_sol_refiner_h3/install_runtime.sh"):
                    info=archive.getinfo(name)
                    self.assertTrue((info.external_attr>>16)&0o111,name)
                    self.assertTrue(manifest["files"][name]["executable"],name)

    def test_trim_only_model_check_ignores_only_the_alternate_eight_step_checkpoint(self) -> None:
        with tempfile.TemporaryDirectory() as folder:
            root=Path(folder);models=root/"models";models.mkdir()
            trimmed=b"trim model";auxiliary=b"vae model"
            (models/"trim.safetensors").write_bytes(trimmed)
            (models/"vae.safetensors").write_bytes(auxiliary)
            manifest={
                "models":{
                    VERIFY_MODULE.ALTERNATE_MODEL:hashlib.sha256(b"optional alternate").hexdigest(),
                    "trim.safetensors":hashlib.sha256(trimmed).hexdigest(),
                    "vae.safetensors":hashlib.sha256(auxiliary).hexdigest(),
                },
                "model_paths":{
                    VERIFY_MODULE.ALTERNATE_MODEL:"diffusion_models/alternate.safetensors",
                    "trim.safetensors":"diffusion_models/trim.safetensors",
                    "vae.safetensors":"vae/vae.safetensors",
                },
            }
            for relative in manifest["model_paths"].values():
                path=models/relative;path.parent.mkdir(parents=True,exist_ok=True)
                if relative.endswith("alternate.safetensors"):
                    continue
                name=Path(relative).name
                source=models/name
                if source!=path:source.replace(path)
            manifest_path=root/"manifest.json";manifest_path.write_text(json.dumps(manifest))
            checked=VERIFY_MODULE.verified_models(manifest_path,models,trim_only=True)
            self.assertEqual(checked,("trim.safetensors","vae.safetensors"))
            with self.assertRaisesRegex(ValueError,"fastvideo_fasth3_8step"):
                VERIFY_MODULE.verified_models(manifest_path,models,trim_only=False)


if __name__=="__main__":
    unittest.main()
