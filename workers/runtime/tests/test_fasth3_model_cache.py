from __future__ import annotations

import importlib.util
from pathlib import Path
import sys
from types import SimpleNamespace
import unittest


MODULE_PATH = Path(__file__).resolve().parents[3] / "vendor" / "comfystream" / "runtime" / "deploy" / "custom_nodes" / "fasth3_deploy" / "model_cache.py"
SPEC = importlib.util.spec_from_file_location("sloptogether_test_fasth3_model_cache", MODULE_PATH)
assert SPEC is not None and SPEC.loader is not None
MODULE = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = MODULE
SPEC.loader.exec_module(MODULE)


class ComfyUiCoreRevisionTest(unittest.TestCase):
    def test_pinned_fal_checkout_uses_scoped_git_safe_directory(self) -> None:
        commands: list[list[str]] = []

        def runner(args, **_kwargs):
            commands.append(args)
            if "status" in args:
                return SimpleNamespace(returncode=0, stdout="")
            return SimpleNamespace(returncode=0, stdout="a" * 40)

        revision = MODULE.comfyui_core_revision("/opt/ComfyUI/comfy/model_management.py", runner=runner)

        self.assertEqual(revision, "a" * 40)
        self.assertEqual(len(commands), 2)
        for command in commands:
            self.assertEqual(command[:4], ["git", "-c", "safe.directory=/opt/ComfyUI", "-C"])

    def test_local_checkout_does_not_receive_a_global_safe_directory_override(self) -> None:
        with self.subTest("user-controlled checkout"):
            commands: list[list[str]] = []

            def runner(args, **_kwargs):
                commands.append(args)
                if "status" in args:
                    return SimpleNamespace(returncode=0, stdout="")
                return SimpleNamespace(returncode=0, stdout="b" * 40)

            revision = MODULE.comfyui_core_revision("/tmp/user-comfy/comfy/model_management.py", runner=runner)

        self.assertEqual(revision, "b" * 40)
        self.assertTrue(commands)
        self.assertTrue(all("safe.directory=/opt/ComfyUI" not in command for command in commands))


if __name__ == "__main__":
    unittest.main()
