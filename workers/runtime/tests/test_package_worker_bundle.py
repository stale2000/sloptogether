from __future__ import annotations

import hashlib
import sys
import tempfile
import unittest
import zipfile
from pathlib import Path
from unittest.mock import patch

ROOT=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT))
sys.path.insert(0,str(ROOT/"src"))
from package_worker_bundle import package_bundle  # noqa: E402
from sloptogether_worker.recipes import RECIPES, TRIM_FIVE_STEP_ID, _workflow  # noqa: E402


class WindowsBundleTest(unittest.TestCase):
    def test_trim_recipe_accepts_windows_checkout_line_endings(self) -> None:
        import importlib.resources

        recipe=RECIPES[TRIM_FIVE_STEP_ID]
        root=importlib.resources.files("sloptogether_worker")

        class CrlfWorkflow:
            def __init__(self, resource): self.resource=resource
            def read_bytes(self): return self.resource.read_bytes().replace(b"\n",b"\r\n")

        class CrlfPackage:
            def joinpath(self, *parts):
                resource=root.joinpath(*parts)
                return CrlfWorkflow(resource) if parts and parts[-1]==recipe.workflow_file else resource

        with patch("sloptogether_worker.recipes.importlib.resources.files",return_value=CrlfPackage()):
            _workflow(recipe)

    def test_packages_only_the_executable_and_nonsecret_setup_files(self) -> None:
        with tempfile.TemporaryDirectory() as folder:
            root=Path(folder);dist=root/"dist";dist.mkdir()
            files={
                "SlopTogetherWorker.exe":dist/"SlopTogetherWorker.exe",
                "worker.example.toml":dist/"worker.example.toml",
                "worker.wsl.example.toml":dist/"worker.wsl.example.toml",
                "Setup-SlopTogetherWorker.ps1":dist/"Setup-SlopTogetherWorker.ps1",
                "Install-ComfyStreamerNodes.ps1":dist/"Install-ComfyStreamerNodes.ps1",
                "ComfyStreamer-Wsl-runtime.zip":dist/"ComfyStreamer-Wsl-runtime.zip",
                "README.txt":dist/"README.txt",
            }
            for name,path in files.items():path.write_bytes(("synthetic:"+name).encode())
            (dist/"worker.key").write_text("must-not-be-packaged")

            bundle,digest=package_bundle(root)
            with zipfile.ZipFile(bundle) as archive:
                self.assertEqual(set(archive.namelist()),set(files))
            self.assertEqual(hashlib.sha256(bundle.read_bytes()).hexdigest(),digest)

    def test_rejects_missing_inputs_and_symlinked_package_sources(self) -> None:
        with tempfile.TemporaryDirectory() as folder:
            root=Path(folder);dist=root/"dist";dist.mkdir()
            for relative in ("SlopTogetherWorker.exe","worker.example.toml","worker.wsl.example.toml","Setup-SlopTogetherWorker.ps1","Install-ComfyStreamerNodes.ps1","ComfyStreamer-Wsl-runtime.zip","README.txt"):
                (dist/relative).write_text("test")
            (dist/"worker.wsl.example.toml").unlink()
            with self.assertRaisesRegex(ValueError,"worker_bundle_file_missing"):
                package_bundle(root)

            (dist/"worker.wsl.example.toml").write_text("test")
            (dist/"worker.wsl.example.toml").unlink()
            try:
                (dist/"worker.wsl.example.toml").symlink_to(dist/"README.txt")
            except OSError:
                self.skipTest("symlink creation is unavailable on this platform")
            with self.assertRaisesRegex(ValueError,"worker_bundle_file_missing"):
                package_bundle(root)

    def test_windows_setup_checks_wsl_gpu_and_never_starts_a_worker(self) -> None:
        script=(ROOT/"Setup-SlopTogetherWorker.ps1").read_text(encoding="utf-8")
        self.assertIn('"uname", "-r"',script)
        self.assertIn('"nvidia-smi"',script)
        self.assertIn('"worker.$Role.toml"',script)
        self.assertIn("[switch]$InstallWsl",script)
        self.assertIn("[switch]$InstallComfyUI",script)
        self.assertIn("[switch]$InstallNodes",script)
        self.assertIn("[switch]$InstallDependencies",script)
        self.assertIn("[switch]$DownloadModels",script)
        self.assertIn("FastVideoRevision",script)
        self.assertIn("MemTotal",script)
        self.assertIn("128 * 1024 * 1024",script)
        self.assertNotRegex(script,r"(?m)^\s*&\s*\$Executable.*\b(pair|run)\b")
        self.assertNotIn("WORKER_KEY",script)

        installer=(ROOT/"Install-ComfyStreamerNodes.ps1").read_text(encoding="utf-8")
        self.assertIn("clipproj_node_ref",installer)
        self.assertIn("comfyui_ref",installer)
        self.assertIn("https://github.com/Comfy-Org/ComfyUI.git",installer)
        self.assertIn("sudo apt-get install -y git curl python3.12 python3.12-venv",installer)
        self.assertIn("requirements.lock",installer)
        self.assertIn("FASTH3_TRIM_ONLY=1",installer)
        self.assertIn("67108864",installer)
        self.assertIn("safetensors",installer)
        self.assertIn("--require-hashes",installer)
        self.assertIn('if ($Role -eq "generation")',installer)
        self.assertNotIn("HF_TOKEN",installer)


if __name__=="__main__":
    unittest.main()
