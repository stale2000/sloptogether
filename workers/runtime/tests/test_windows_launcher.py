from __future__ import annotations

import importlib.util
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import Mock, patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))
spec = importlib.util.spec_from_file_location("windows_worker_launcher", ROOT / "launcher.py")
launcher = importlib.util.module_from_spec(spec)
spec.loader.exec_module(launcher)


class WindowsLauncherTest(unittest.TestCase):
    def setUp(self):
        patcher = patch("builtins.print")
        patcher.start()
        self.addCleanup(patcher.stop)

    def test_role_menu_dispatches_to_the_matching_config(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            for role in ("generation", "upscale"):
                (root / f"worker.{role}.toml").write_text(
                    f"[worker]\nstate_dir='{root / role}'\n"
                )
            commands = Mock(return_value=0)
            setup = Mock(return_value=0)
            choices = iter(["1", "6", "2", "3", "0"])
            self.assertEqual(launcher.interactive_menu(root, read_input=lambda _prompt: next(choices),
                                                       run_command=commands, run_setup=setup), 0)
            self.assertEqual(commands.call_args_list, [
                unittest.mock.call(["--config", str(root / "worker.generation.toml"), "--role", "generation", "check"]),
                unittest.mock.call(["--config", str(root / "worker.upscale.toml"), "--role", "upscale", "pair"]),
                unittest.mock.call(["--config", str(root / "worker.upscale.toml"), "--role", "upscale", "run"]),
            ])
            setup.assert_not_called()

    def test_missing_config_never_starts_or_pairs_a_worker(self):
        with tempfile.TemporaryDirectory() as directory:
            commands = Mock()
            choices = iter(["2", "3", "0"])
            launcher.interactive_menu(Path(directory), read_input=lambda _prompt: next(choices),
                                      run_command=commands, run_setup=Mock())
            commands.assert_not_called()

    def test_pairing_wont_overwrite_a_legacy_shared_role_key(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            legacy = root / "legacy"
            legacy.mkdir()
            credential = legacy / "worker.key"
            credential.write_text("existing protected credential")
            for role in ("generation", "upscale"):
                (root / f"worker.{role}.toml").write_text(
                    f"[worker]\nrole='{role}'\nstate_dir='{legacy}'\n"
                )
            commands = Mock(return_value=0)
            choices = iter(["2", "0"])
            launcher.interactive_menu(root, read_input=lambda _prompt: next(choices),
                                      run_command=commands, run_setup=Mock())
            commands.assert_not_called()
            self.assertEqual(credential.read_text(), "existing protected credential")

    def test_pairing_allows_distinct_role_key_directories(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            for role in ("generation", "upscale"):
                (root / f"worker.{role}.toml").write_text(
                    f"[worker]\nrole='{role}'\nstate_dir='{root / role}'\n"
                )
            commands = Mock(return_value=0)
            choices = iter(["2", "6", "2", "0"])
            launcher.interactive_menu(root, read_input=lambda _prompt: next(choices),
                                      run_command=commands, run_setup=Mock())
            self.assertEqual(commands.call_count, 2)

    def test_pairing_rejects_overriding_credentials_without_disclosing_them(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            config = root / "worker.generation.toml"
            for config_line, env in [
                ("credential_file='legacy.key'\n", {}),
                ("", {"SLOPTOGETHER_WORKER_KEY": "private-key-value"}),
                ("", {"SLOPTOGETHER_WORKER_KEY_GENERATION": "private-scoped-key-value"}),
            ]:
                with self.subTest(config_line=config_line, env=bool(env)):
                    config.write_text("[worker]\n" + config_line)
                    commands = Mock(return_value=0)
                    choices = iter(["2", "0"])
                    with patch.dict(launcher.os.environ, env, clear=True):
                        launcher.interactive_menu(root, read_input=lambda _prompt: next(choices),
                                                  run_command=commands, run_setup=Mock())
                    commands.assert_not_called()

    def test_existing_comfy_setup_reuses_configured_wsl_location_and_preserves_settings(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            setup = root / "Setup-SlopTogetherWorker.ps1"
            setup.touch()
            powershell = root / "System32/WindowsPowerShell/v1.0/powershell.exe"
            powershell.parent.mkdir(parents=True)
            powershell.touch()
            with patch.dict(launcher.os.environ, {"SystemRoot": str(root)}), \
                    patch.object(launcher.subprocess, "run", return_value=Mock(returncode=0)) as run:
                self.assertEqual(launcher._run_setup(root, "generation", False), 0)
                self.assertIn("-InstallNodes", run.call_args.args[0])
                config = root / "worker.generation.toml"
                config.write_text(
                    "[worker]\nrole='generation'\nplatform='wsl'\n"
                    "comfy_input_dir='\\\\wsl.localhost\\Ubuntu-24.04\\home\\alice\\ComfyUI\\input'\n"
                    "comfy_output_dir='\\\\wsl.localhost\\Ubuntu-24.04\\home\\alice\\ComfyUI\\output'\n"
                    "stream_slug='main'\nchannel_id='123'\n"
                )
                original = config.read_text()
                run.reset_mock()
                self.assertEqual(launcher._run_setup(root, "generation", False), 0)
                args = run.call_args.args[0]
                self.assertIn("Ubuntu-24.04", args)
                self.assertIn("/home/alice/ComfyUI", args)
                self.assertEqual(config.read_text(), original)

    def test_model_actions_use_existing_wsl_config_without_a_revision_or_secret(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "worker.generation.toml").write_text(
                "[worker]\nplatform='wsl'\n"
                "comfy_input_dir='\\\\wsl.localhost\\Ubuntu-24.04\\home\\alice\\ComfyUI\\input'\n"
            )
            (root / "Install-ComfyStreamerNodes.ps1").touch()
            system = root / "System32"
            powershell = system / "WindowsPowerShell/v1.0/powershell.exe"
            powershell.parent.mkdir(parents=True)
            powershell.touch()
            (system / "wsl.exe").touch()
            with patch.dict(launcher.os.environ, {"SystemRoot": str(root)}, clear=True), \
                    patch.object(launcher.subprocess, "run", return_value=Mock(returncode=0)) as run:
                self.assertEqual(launcher._generation_models(root, "generation", login=False), 0)
                argv = run.call_args.args[0]
                self.assertIn("-DownloadModels", argv)
                self.assertNotIn("-FastVideoRevision", argv)
                self.assertIn("/home/alice/ComfyUI/.venv/bin/python", argv)
                self.assertEqual(launcher._generation_models(root, "generation", login=True), 0)
                self.assertEqual(run.call_args.args[0][-3:], ["/home/alice/ComfyUI/.venv/bin/hf", "auth", "login"])
                run.reset_mock()
                self.assertEqual(launcher._generation_models(root, "upscale", login=False), 1)
                run.assert_not_called()

    def test_setup_actions_are_explicit_and_use_current_role(self):
        setup = Mock(return_value=0)
        choices = iter(["4", "6", "5", "0"])
        with patch.object(launcher, "_download_models_after_setup", return_value=0) as download:
            launcher.interactive_menu(Path("unused"), read_input=lambda _prompt: next(choices),
                                       run_command=Mock(), run_setup=setup)
        self.assertEqual(setup.call_args_list, [unittest.mock.call(Path("unused"), "generation", False),
                                                unittest.mock.call(Path("unused"), "upscale", True)])
        download.assert_called_once_with(Path("unused"), "generation")

    def test_generation_setup_automatically_downloads_models(self):
        setup = Mock(return_value=0)
        download = Mock(return_value=0)
        choices = iter(["5", "0"])
        with patch("builtins.print"), patch.object(launcher, "_download_models_after_setup", download):
            self.assertEqual(launcher.interactive_menu(Path("worker-root"), read_input=lambda _prompt: next(choices),
                                                       run_command=Mock(), run_setup=setup,
                                                       run_models=Mock(), run_dependencies=Mock()), 0)
        download.assert_called_once_with(Path("worker-root"), "generation")

    def test_post_setup_download_authenticates_then_fetches_generation_models(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "worker.generation.toml").write_text(
                "[worker]\nplatform='wsl'\n"
                "comfy_input_dir='\\\\wsl.localhost\\Ubuntu-24.04\\home\\alice\\ComfyUI\\input'\n"
            )
            wsl = root / "System32" / "wsl.exe"
            wsl.parent.mkdir(parents=True)
            wsl.touch()
            with patch.dict(launcher.os.environ, {"SystemRoot": str(root)}, clear=True), \
                 patch.object(launcher.subprocess, "run", side_effect=[Mock(returncode=1), Mock(returncode=0)]) as run, \
                 patch.object(launcher, "_generation_models", side_effect=[0, 0]) as models:
                self.assertEqual(launcher._download_models_after_setup(root, "generation"), 0)
            self.assertEqual(run.call_args.args[0][-3:], ["/home/alice/ComfyUI/.venv/bin/hf", "auth", "whoami"])
            self.assertEqual(models.call_args_list, [
                unittest.mock.call(root, "generation", login=True),
                unittest.mock.call(root, "generation", login=False),
            ])

    def test_comfy_start_uses_the_configured_wsl_distribution_and_root(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            config = root / "worker.generation.toml"
            config.write_text("[worker]\nplatform='wsl'\n"
                              "comfy_url='http://127.0.0.1:8188'\n"
                              "comfy_input_dir='\\\\wsl.localhost\\Ubuntu-24.04\\home\\alice\\ComfyUI\\input'\n")
            wsl = root / "System32" / "wsl.exe"
            wsl.parent.mkdir()
            wsl.touch()
            with patch.dict(launcher.os.environ, {"SystemRoot": str(root)}), \
                    patch.object(launcher.socket, "create_connection", side_effect=OSError), \
                    patch.object(launcher.subprocess, "Popen") as spawn:
                self.assertEqual(launcher._start_comfy(root, "generation"), 0)
            self.assertEqual(spawn.call_args.args[0], [str(wsl), "--distribution", "Ubuntu-24.04", "--cd",
                "/home/alice/ComfyUI", "--exec", "/home/alice/ComfyUI/.venv/bin/python", "main.py",
                "--listen", "127.0.0.1", "--port", "8188"])
            self.assertNotIn("shell", spawn.call_args.kwargs)

    def test_comfy_start_rejects_non_loopback_and_unsafe_wsl_paths(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            config = root / "worker.generation.toml"
            for url, path in [("http://example.com:8188", r"\\wsl.localhost\Ubuntu\home\alice\ComfyUI\input"),
                              ("http://127.0.0.1:8188", r"\\wsl.localhost\Ubuntu\home\alice\..\input")]:
                config.write_text(f"[worker]\nplatform='wsl'\ncomfy_url='{url}'\ncomfy_input_dir='{path}'\n")
                with patch.object(launcher.subprocess, "Popen") as spawn:
                    self.assertEqual(launcher._start_comfy(root, "generation"), 1)
                    spawn.assert_not_called()

    def test_explicit_arguments_still_use_the_existing_cli(self):
        with patch.object(launcher.sys, "argv", ["SlopTogetherWorker.exe", "--help"]), \
             patch.object(launcher, "worker_main", return_value=0) as worker, \
             patch.object(launcher, "interactive_menu") as menu:
            self.assertEqual(launcher.main(), 0)
            worker.assert_called_once_with()
            menu.assert_not_called()

    def test_frozen_windows_launch_opens_desktop_ui(self):
        with patch.object(launcher.sys, "platform", "win32"), \
             patch.object(launcher.sys, "frozen", True, create=True), \
             patch.object(launcher.sys, "argv", ["SlopTogetherWorker.exe"]), \
             patch.object(launcher, "_bundle_root", return_value=Path("worker-root")), \
             patch("sloptogether_worker.desktop.run_desktop", return_value=0) as desktop, \
             patch.object(launcher, "worker_main") as worker:
            self.assertEqual(launcher.main(), 0)
            desktop.assert_called_once()
            self.assertEqual(desktop.call_args.args[0], Path("worker-root"))
            self.assertEqual(set(desktop.call_args.args[1]), {"setup", "models", "dependencies", "comfy"})
            worker.assert_not_called()

    def test_cli_arguments_are_restored_after_a_command_failure(self):
        original = ["SlopTogetherWorker.exe"]
        with patch.object(sys, "argv", original), patch.object(launcher, "worker_main", side_effect=RuntimeError("test")):
            with self.assertRaisesRegex(RuntimeError, "test"):
                launcher._run_cli(["check"])
            self.assertIs(sys.argv, original)

    @unittest.skipUnless(shutil.which("pwsh") or shutil.which("powershell.exe"), "PowerShell unavailable")
    def test_setup_generates_independent_role_state_directories_without_touching_old_credentials(self):
        powershell = shutil.which("pwsh") or shutil.which("powershell.exe")
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            credential = root / "worker.key"
            credential.write_text("legacy credential")
            harness = root / "verify.ps1"
            harness.write_text(r'''
param([string]$Setup, [string]$Template)
$tokens = $null; $parseErrors = $null
$ast = [System.Management.Automation.Language.Parser]::ParseFile($Setup, [ref]$tokens, [ref]$parseErrors)
if ($parseErrors.Count) { throw "setup does not parse" }
$node = $ast.Find({ param($item) $item -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $item.Name -eq 'Set-RoleStateDirectory' }, $true)
if (-not $node) { throw "role state function missing" }
. ([scriptblock]::Create($node.Extent.Text))
$config = [IO.File]::ReadAllText($Template)
$generation = Set-RoleStateDirectory $config 'generation'
$upscale = Set-RoleStateDirectory $config 'upscale'
if ($generation -notmatch '(?m)^state_dir = "~/.sloptogether/generation"$') { throw "generation state path incorrect" }
if ($upscale -notmatch '(?m)^state_dir = "~/.sloptogether/upscale"$') { throw "upscale state path incorrect" }
try { $null = Set-RoleStateDirectory '[worker]' 'generation'; throw 'invalid template accepted' } catch { if ($_.Exception.Message -eq 'invalid template accepted') { throw } }
''', encoding="utf-8")
            subprocess.run([powershell, "-NoProfile", "-File", str(harness),
                            str(ROOT / "Setup-SlopTogetherWorker.ps1"), str(ROOT / "worker.wsl.example.toml")],
                           capture_output=True, text=True, check=True)
            self.assertEqual(credential.read_text(), "legacy credential")

    @unittest.skipUnless(shutil.which("pwsh") or shutil.which("powershell.exe"), "PowerShell unavailable")
    def test_installed_nodes_allow_bytecode_but_reject_changed_source_and_other_cache_files(self):
        powershell = shutil.which("pwsh") or shutil.which("powershell.exe")
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source, target = root / "source", root / "target"
            source.mkdir(); target.mkdir()
            (source / "node.py").write_text("node source", encoding="utf-8")
            (target / "node.py").write_text("node source", encoding="utf-8")
            cache = target / "__pycache__"
            cache.mkdir()
            (cache / "node.cpython-312.pyc").write_bytes(b"compiled")
            (cache / "node.cpython-312.opt-1.pyc").write_bytes(b"compiled")
            link = cache / "link.cpython-312.pyc"
            try:
                link.symlink_to(target / "node.py")
                has_link = True
            except OSError:
                has_link = False
            # The symlink is added later so the first comparison can succeed.
            if has_link:
                link.unlink()
            harness = root / "verify-tree.ps1"
            harness.write_text(r'''
param([string]$Installer, [string]$Source, [string]$Target, [string]$TestLink)
$tokens = $null; $errors = $null
$ast = [System.Management.Automation.Language.Parser]::ParseFile($Installer, [ref]$tokens, [ref]$errors)
if ($errors.Count) { throw 'installer does not parse' }
$node = $ast.Find({ param($item) $item -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $item.Name -eq 'Test-IdenticalTree' }, $true)
if (-not $node) { throw 'tree comparison missing' }
. ([scriptblock]::Create($node.Extent.Text))
if (-not (Test-IdenticalTree $Source $Target)) { throw 'generated bytecode blocked matching nodes' }
$unexpected = Join-Path $Target '__pycache__/unexpected.pyc'
[IO.File]::WriteAllText($unexpected, 'unexpected')
if (Test-IdenticalTree $Source $Target) { throw 'unexpected file was ignored' }
Remove-Item -LiteralPath $unexpected
$file = Join-Path $Target 'node.py'
[IO.File]::WriteAllText($file, 'modified')
if (Test-IdenticalTree $Source $Target) { throw 'modified source was ignored' }
[IO.File]::WriteAllText($file, 'node source')
if ($TestLink -eq 'yes') {
    $link = Join-Path $Target '__pycache__/link.cpython-312.pyc'
    New-Item -ItemType SymbolicLink -Path $link -Target $file | Out-Null
    try { $null = Test-IdenticalTree $Source $Target; throw 'reparse point was ignored' }
    catch { if ($_.Exception.Message -eq 'reparse point was ignored') { throw } }
}
''', encoding="utf-8")
            subprocess.run([powershell, "-NoProfile", "-File", str(harness),
                            str(ROOT / "Install-ComfyStreamerNodes.ps1"), str(source), str(target),
                            "yes" if has_link else "no"], capture_output=True, text=True, check=True)


if __name__ == "__main__":
    unittest.main()
