from __future__ import annotations

import importlib.util
import tempfile
import unittest
from pathlib import Path

_SCRIPT = Path(__file__).parents[1] / "fal" / "prepare_fal_apps.py"
_SPEC = importlib.util.spec_from_file_location("prepare_fal_apps", _SCRIPT)
assert _SPEC and _SPEC.loader
_MODULE = importlib.util.module_from_spec(_SPEC)
_SPEC.loader.exec_module(_MODULE)


class FalAppPreparationTests(unittest.TestCase):
    def test_creates_isolated_private_role_apps_with_the_shared_worker(self):
        with tempfile.TemporaryDirectory() as temporary:
            output = _MODULE.prepare_apps(Path(temporary) / "apps")
            generation = output / "generation"
            upscale = output / "upscale"
            generation_config = (generation / "pyproject.toml").read_text()
            upscale_config = (upscale / "pyproject.toml").read_text()
            self.assertIn('"SLOPTOGETHER_WORKER_KEY_GENERATION"', generation_config)
            self.assertIn('"SLOPTOGETHER_WORKER_KEY_UPSCALE"', upscale_config)
            for name in ("SLOPTOGETHER_API_BASE_URL", "SLOPTOGETHER_ALLOWED_UPLOAD_HOSTS"):
                self.assertIn(f'"{name}"', generation_config)
                self.assertIn(f'"{name}"', upscale_config)
            self.assertIn("min_concurrency = 0", generation_config)
            self.assertIn("min_concurrency = 0", upscale_config)
            for app, venv, command in (
                (generation, "/opt/venv-fasth3", "/opt/fasth3-entrypoint.sh"),
                (upscale, "/opt/venv-comfy", "/opt/ComfyUI/main.py"),
            ):
                dockerfile = (app / "Dockerfile").read_text()
                self.assertIn("COPY context/sloptogether-worker /opt/sloptogether-worker", dockerfile)
                self.assertIn("COPY context/sloptogether-markdown /tmp/sloptogether-markdown", dockerfile)
                self.assertIn(f"{venv}/bin/sloptogether-fal-worker", dockerfile)
                self.assertIn(command, dockerfile)
                self.assertTrue((app / "context/sloptogether-worker.manifest.json").is_file())
                self.assertTrue((app / "source-manifest.json").is_file())
            self.assertIn("SLOPTOGETHER_WORKER_ROLE=generation", (generation / "Dockerfile").read_text())
            self.assertIn("SLOPTOGETHER_WORKER_ROLE=upscale", (upscale / "Dockerfile").read_text())
            generation_dockerfile = (generation / "Dockerfile").read_text()
            upscale_dockerfile = (upscale / "Dockerfile").read_text()
            self.assertIn("SLOPTOGETHER_TRIM_VSA_BUDGET_POLICY=adaptive", generation_dockerfile)
            self.assertNotIn("SLOPTOGETHER_TRIM_VSA_BUDGET_POLICY", upscale_dockerfile)
            for dockerfile in (generation_dockerfile, upscale_dockerfile):
                self.assertIn("useradd --system --gid sloptogether-comfy", dockerfile)
                self.assertIn("useradd --system --gid sloptogether-worker", dockerfile)
            self.assertIn("runuser --preserve-environment --user=sloptogether-comfy", generation_dockerfile)
            self.assertIn('"runuser", "--preserve-environment", "--user=sloptogether-comfy"', upscale_dockerfile)
            self.assertIn("runuser --preserve-environment --user=sloptogether-comfy -- /opt/venv-fasth3/bin/python", generation_dockerfile)
            self.assertTrue((upscale / "context/sloptogether-markdown/deploy/fal/h3-sol-upscaler/README.md.slopdoc").is_file())
            self.assertIn("source.rglob('*.slopdoc')", upscale_dockerfile)
            self.assertNotIn("FAL_KEY", generation_config + upscale_config)
            self.assertNotIn("SLOPTOGETHER_WORKER_KEY", generation_config.replace("SLOPTOGETHER_WORKER_KEY_GENERATION", "").replace("SLOPTOGETHER_WORKER_KEY_UPSCALE", ""))

    def test_refuses_to_overwrite_a_nonempty_output_directory(self):
        with tempfile.TemporaryDirectory() as temporary:
            output = Path(temporary) / "apps"
            output.mkdir()
            existing = output / "keep.txt"
            existing.write_text("unrelated")
            with self.assertRaisesRegex(ValueError, "must_be_empty"):
                _MODULE.prepare_apps(output)
            self.assertEqual(existing.read_text(), "unrelated")


if __name__ == "__main__":
    unittest.main()
