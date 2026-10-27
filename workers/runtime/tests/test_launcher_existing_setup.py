from __future__ import annotations

import importlib.util
import tempfile
import unittest
from pathlib import Path
from unittest.mock import Mock, patch

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('windows_worker_launcher_existing', ROOT / 'launcher.py')
launcher = importlib.util.module_from_spec(spec)
spec.loader.exec_module(launcher)


class ExistingComfySetupTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        (self.root / 'worker.generation.toml').write_text(
            "[worker]\nplatform='wsl'\ncomfy_url='http://127.0.0.1:8188'\n"
            "comfy_input_dir='\\\\wsl.localhost\\Ubuntu-24.04\\home\\alice\\ComfyUI\\input'\n"
        )
        (self.root / 'Install-ComfyStreamerNodes.ps1').touch()
        system = self.root / 'System32'
        powershell = system / 'WindowsPowerShell/v1.0/powershell.exe'
        powershell.parent.mkdir(parents=True)
        powershell.touch()
        (system / 'wsl.exe').touch()
        self.python = '/home/alice/ComfyUI/custom-env/bin/python'

    def test_selected_python_is_installed_then_reused_for_comfy_and_models(self):
        with patch.dict(launcher.os.environ, {'SystemRoot': str(self.root)}, clear=True), \
             patch.object(launcher.subprocess, 'run', return_value=Mock(returncode=0)) as run, \
             patch.object(launcher.subprocess, 'Popen') as start, \
             patch.object(launcher.socket, 'create_connection', side_effect=OSError):
            self.assertEqual(launcher._install_existing_dependencies(self.root, 'generation', self.python), 0)
            args = run.call_args.args[0]
            self.assertIn('-InstallDependencies', args)
            self.assertEqual(args[args.index('-ComfyPython') + 1], self.python)
            self.assertEqual(launcher._start_comfy(self.root, 'generation'), 0)
            self.assertIn(self.python, start.call_args.args[0])
            self.assertEqual(launcher._generation_models(self.root, 'generation', login=True), 0)
            self.assertEqual(run.call_args.args[0][-3:], ['/home/alice/ComfyUI/custom-env/bin/hf', 'auth', 'login'])
            self.assertEqual(launcher._generation_models(self.root, 'generation', login=False), 0)
            args = run.call_args.args[0]
            self.assertEqual(args[args.index('-ComfyPython') + 1], self.python)

    def test_unsafe_python_path_never_launches_installer(self):
        with patch.dict(launcher.os.environ, {'SystemRoot': str(self.root)}, clear=True), \
             patch.object(launcher.subprocess, 'run') as run:
            for value in ['/tmp/python', '/home/alice/ComfyUI/../other/python', '/home/alice/ComfyUI/x;touch/p']:
                with self.subTest(value=value):
                    self.assertEqual(launcher._install_existing_dependencies(self.root, 'generation', value), 1)
            run.assert_not_called()
        self.assertFalse((self.root / 'worker.generation.comfy-python').exists())

    def test_failed_install_preserves_previous_python_choice(self):
        choice = self.root / 'worker.generation.comfy-python'
        choice.write_text('/home/alice/ComfyUI/original/bin/python\n')
        with patch.dict(launcher.os.environ, {'SystemRoot': str(self.root)}, clear=True), \
             patch.object(launcher.subprocess, 'run', return_value=Mock(returncode=1)):
            self.assertEqual(launcher._install_existing_dependencies(self.root, 'generation', self.python), 1)
        self.assertEqual(choice.read_text(), '/home/alice/ComfyUI/original/bin/python\n')

    def test_menu_passes_explicit_python_to_dependency_action(self):
        choices = iter(['10', self.python, '0'])
        install = Mock(return_value=0)
        with patch('builtins.print'):
            self.assertEqual(launcher.interactive_menu(self.root, read_input=lambda _: next(choices),
                                                       run_dependencies=install), 0)
        install.assert_called_once_with(self.root, 'generation', self.python)


if __name__ == '__main__':
    unittest.main()
