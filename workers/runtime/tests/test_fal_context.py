from __future__ import annotations

import tempfile
import unittest
import importlib.util
from pathlib import Path

_SCRIPT = Path(__file__).parents[1] / "fal" / "prepare_fal_worker_context.py"
_SPEC = importlib.util.spec_from_file_location("prepare_fal_worker_context", _SCRIPT)
assert _SPEC and _SPEC.loader
_MODULE = importlib.util.module_from_spec(_SPEC)
_SPEC.loader.exec_module(_MODULE)
check_context = _MODULE.check_context
stage_context = _MODULE.stage_context


class FalWorkerContextTests(unittest.TestCase):
    def test_stages_only_runtime_source_and_checks_its_manifest(self):
        with tempfile.TemporaryDirectory() as temporary:
            app = Path(temporary) / "generation"
            app.mkdir()
            (app / "Dockerfile").write_text("FROM python:3.12\n")
            (app / "pyproject.toml").write_text("[project]\nname='slop-test'\n")
            destination = stage_context(app)
            self.assertTrue((destination / "pyproject.toml").is_file())
            self.assertTrue((destination / "src/sloptogether_worker/fal_runner.py").is_file())
            self.assertTrue((destination / "src/sloptogether_worker/fal_session.py").is_file())
            self.assertFalse((destination / "tests").exists())
            check_context(app)
            (destination / "src/sloptogether_worker/fal_runner.py").write_text("changed\n")
            with self.assertRaisesRegex(ValueError, "fal_worker_context_content_changed"):
                check_context(app)

    def test_refuses_to_overwrite_unowned_context(self):
        with tempfile.TemporaryDirectory() as temporary:
            app = Path(temporary) / "upscale"
            app.mkdir()
            (app / "Dockerfile").write_text("FROM python:3.12\n")
            (app / "pyproject.toml").write_text("[project]\nname='slop-test'\n")
            destination = app / "context/sloptogether-worker"
            destination.mkdir(parents=True)
            (destination / "user-file").write_text("preserve me")
            with self.assertRaisesRegex(ValueError, "fal_worker_context_missing"):
                stage_context(app)
            self.assertEqual((destination / "user-file").read_text(), "preserve me")


if __name__ == "__main__":
    unittest.main()
