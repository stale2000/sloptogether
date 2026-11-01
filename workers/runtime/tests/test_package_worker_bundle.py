from __future__ import annotations

import hashlib
import shutil
import subprocess
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
            def read_bytes(self):
                source=self.resource.read_bytes().replace(b"\r\n",b"\n")
                return source.replace(b"\n",b"\r\n")

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
                "SlopTogetherWorkerCli.exe":dist/"SlopTogetherWorkerCli.exe",
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
            for relative in ("SlopTogetherWorker.exe","SlopTogetherWorkerCli.exe","worker.example.toml","worker.wsl.example.toml","Setup-SlopTogetherWorker.ps1","Install-ComfyStreamerNodes.ps1","ComfyStreamer-Wsl-runtime.zip","README.txt"):
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
        installer=(ROOT/"Install-ComfyStreamerNodes.ps1").read_text(encoding="utf-8")
        self.assertIn("[switch]$CheckOnly",installer)
        self.assertIn("[switch]$CheckModels",installer)
        self.assertIn("SLOPTOGETHER_INSTALL_OK",installer)
        self.assertIn("FASTH3_MODELS_OK",installer)
        self.assertIn("FASTH3_MODELS_NEEDED",installer)
        self.assertIn("verify_fasth3_models.py",installer)
        sol_runtime=(ROOT.parent.parent/"vendor/comfystream/runtime/deploy/custom_nodes/comfystream_sol_refiner_h3/install_runtime.sh").read_text(encoding="utf-8")
        self.assertIn("--check-only",sol_runtime)
        self.assertIn('if [[ "$check_only" != 1 ]]',sol_runtime)
        self.assertNotRegex(script,r"(?m)^\s*&\s*\$Executable.*\b(pair|run)\b")
        self.assertNotIn("WORKER_KEY",script)

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

    @unittest.skipUnless(shutil.which("pwsh") or shutil.which("powershell.exe"), "PowerShell unavailable")
    def test_rerun_updates_only_wsl_paths_and_preserves_target_settings(self) -> None:
        powershell = shutil.which("pwsh") or shutil.which("powershell.exe")
        with tempfile.TemporaryDirectory() as directory:
            harness = Path(directory) / "verify.ps1"
            harness.write_text(r'''
param([string]$Setup)
$tokens = $null; $parseErrors = $null
$ast = [System.Management.Automation.Language.Parser]::ParseFile($Setup, [ref]$tokens, [ref]$parseErrors)
if ($parseErrors.Count) { throw "setup does not parse" }
$node = $ast.Find({ param($item) $item -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $item.Name -eq 'Set-WorkerComfyPaths' }, $true)
if (-not $node) { throw "path update function missing" }
. ([scriptblock]::Create($node.Extent.Text))
$config = @'
[worker]
platform = "wsl"
role = "generation"
channel_id = "31825889"
stream_slug = "cartoon-demo"
state_dir = "~/.sloptogether/generation"
comfy_url = "http://127.0.0.1:8188"
comfy_input_dir = 'old-input'
comfy_output_dir = 'old-output'
'@
$updated = Set-WorkerComfyPaths $config 'generation' 'new-input' 'new-output'
foreach ($required in @('channel_id = "31825889"','stream_slug = "cartoon-demo"','state_dir = "~/.sloptogether/generation"','comfy_url = "http://127.0.0.1:8188"')) {
  if ($updated -notlike "*$required*") { throw "setting was lost: $required" }
}
if ($updated -notlike "*comfy_input_dir = 'new-input'*") { throw "input path was not refreshed" }
if ($updated -notlike "*comfy_output_dir = 'new-output'*") { throw "output path was not refreshed" }
try { $null = Set-WorkerComfyPaths $config 'upscale' 'input' 'output'; throw 'role mismatch accepted' }
catch { if ($_.Exception.Message -eq 'role mismatch accepted') { throw } }
''' .strip(), encoding="utf-8")
            subprocess.run([powershell, "-NoProfile", "-File", str(harness), str(ROOT / "Setup-SlopTogetherWorker.ps1")],
                           capture_output=True, text=True, check=True)


if __name__=="__main__":
    unittest.main()
