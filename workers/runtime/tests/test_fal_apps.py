from __future__ import annotations

import importlib.util
import os
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

_SCRIPT = Path(__file__).parents[1] / "fal" / "prepare_fal_apps.py"
_SPEC = importlib.util.spec_from_file_location("prepare_fal_apps", _SCRIPT)
assert _SPEC and _SPEC.loader
_MODULE = importlib.util.module_from_spec(_SPEC)
_SPEC.loader.exec_module(_MODULE)


class FalAppPreparationTests(unittest.TestCase):
    def test_generated_generation_entrypoint_honors_cache_paths_and_defaults(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            generation = _MODULE.prepare_apps(root / "apps") / "generation"
            dockerfile = (generation / "Dockerfile").read_text()
            marker = "RUN python3 - <<'PY'\nfrom pathlib import Path\npath=Path('/opt/fasth3-entrypoint.sh')\n"
            start = dockerfile.index(marker) + len("RUN python3 - <<'PY'\n")
            end = dockerfile.index("\nPY\n", start)
            patch_script = dockerfile[start:end]
            script = root / "entrypoint.sh"
            shutil.copyfile(generation / "context/comfystream/deploy/fal/fasth3-b1/entrypoint.sh", script)
            patch_script = patch_script.replace("Path('/opt/fasth3-entrypoint.sh')", f"Path({str(script)!r})", 1)
            subprocess.run([sys.executable, "-c", patch_script], check=True, capture_output=True, text=True)

            patched = script.read_text()
            self.assertIn("exec runuser --preserve-environment --user=sloptogether-comfy", patched)
            # Execute the real patched initialization while substituting only
            # mkdir, so no model, GPU, or account-wide filesystem is touched.
            preamble = patched.split('if [[ "${FASTH3_BUILD_NATIVE_VC:-0}"', 1)[0]
            binary_dir = root / "bin"
            binary_dir.mkdir()
            mkdir = binary_dir / "mkdir"
            mkdir.write_text('#!/bin/sh\nprintf "%s\\n" "$@" > "$MKDIR_CAPTURE"\n')
            mkdir.chmod(0o755)
            capture = root / "mkdir-args"
            variables = ("HF_HOME", "TORCHINDUCTOR_CACHE_DIR", "TRITON_CACHE_DIR", "CUDA_CACHE_PATH")
            base = os.environ.copy()
            for name in variables:
                base.pop(name, None)
            base.update({"PATH": f"{binary_dir}:{os.defpath}", "MKDIR_CAPTURE": str(capture)})
            command = preamble + '\nprintf "%s\\n" "$HF_HOME" "$TORCHINDUCTOR_CACHE_DIR" "$TRITON_CACHE_DIR" "$CUDA_CACHE_PATH"\n'
            for overrides, expected in (
                ({}, ["/data/.cache/huggingface", "/data/torchinductor", "/data/triton", "/data/cuda-cache"]),
                ({name: str(root / f"scoped cache {index}") for index, name in enumerate(variables)},
                 [str(root / f"scoped cache {index}") for index in range(4)]),
            ):
                result = subprocess.run(["bash", "-c", command], env=base | overrides, check=True, capture_output=True, text=True)
                self.assertEqual(result.stdout.splitlines(), expected)
                self.assertEqual(capture.read_text().splitlines(), ["-p", "/data/fasth3-models", *expected])

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
