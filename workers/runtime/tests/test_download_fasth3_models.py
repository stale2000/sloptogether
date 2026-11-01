from __future__ import annotations

import hashlib
import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
SCRIPT = ROOT / "vendor/comfystream/runtime/scripts/download_fasth3_models.sh"
INSTALLER = ROOT / "workers/runtime/Install-ComfyStreamerNodes.ps1"
TRIM = "fastvideo_fasth3_trim_8step_int8_convrot.safetensors"
ALTERNATE = "fastvideo_fasth3_8step_v2_pruned_int8_convrot.safetensors"
MODEL_PATHS = {
    TRIM: f"diffusion_models/{TRIM}",
    ALTERNATE: f"diffusion_models/{ALTERNATE}",
    "qwen3vl_4b_fp8_scaled.safetensors": "text_encoders/qwen3vl_4b_fp8_scaled.safetensors",
    "mmh3-4b-ClipProj-v3.1-mlp.safetensors": "clip_projections/mmh3-4b-ClipProj-v3.1-mlp.safetensors",
    "minimax_h3_audio_vae_fp32.safetensors": "vae/minimax_h3_audio_vae_fp32.safetensors",
    "minimax_h3_video_vae_int8_convrot.safetensors": "vae/minimax_h3_video_vae_int8_convrot.safetensors",
}


class FastH3DownloaderTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.models_root = self.root / "ComfyUI" / "models"
        self.manifest = self.root / "manifest.json"
        self.log = self.root / "requests.jsonl"
        self.fake_bin = self.root / "bin"
        self.fake_bin.mkdir()
        manifest = {
            "models": {name: hashlib.sha256(name.encode()).hexdigest() for name in MODEL_PATHS},
            "model_paths": MODEL_PATHS,
            "model_revisions": {name: "a" * 40 for name in MODEL_PATHS if name != ALTERNATE},
        }
        self.manifest.write_text(json.dumps(manifest))
        curl = self.fake_bin / "curl"
        curl.write_text("""#!/usr/bin/env python3
import json, os, sys
from pathlib import Path
from urllib.parse import urlsplit
args = sys.argv[1:]
url = next(arg for arg in args if arg.startswith('https://'))
target = Path(args[args.index('--output') + 1])
name = urlsplit(url).path.rsplit('/', 1)[-1]
with open(os.environ['FAKE_CURL_LOG'], 'a', encoding='utf-8') as log:
    log.write(json.dumps({'url': url, 'output': str(target)}) + '\\n')
target.write_bytes((('wrong:' if os.environ.get('FAKE_CORRUPT') == name else '') + name).encode())
""")
        curl.chmod(0o755)

    def run_downloader(self, *, trim_only: bool, fastvideo_revision: str | None = None, corrupt: str | None = None):
        env = dict(os.environ)
        for key in tuple(env):
            if key.startswith("HF_REVISION_") or key in {"FASTH3_SKIP_FINAL_REHASH", "COMFYSTREAM_NO_REPLACE_MODELS", "FAKE_CORRUPT"}:
                env.pop(key, None)
        env.update({
            "COMFYUI_ROOT": str(self.models_root.parent),
            "COMFYSTREAM_MANIFEST": str(self.manifest),
            "COMFYSTREAM_TRUSTED_MODEL_STATS": str(self.root / "no-receipt.json"),
            "PYTHON_BIN": sys.executable,
            "HF_ENDPOINT": "https://download.example.invalid",
            "HF_TOKEN": "fake-token-for-offline-test",
            "PATH": str(self.fake_bin) + os.pathsep + os.environ.get("PATH", ""),
            "TMPDIR": str(self.root),
            "FAKE_CURL_LOG": str(self.log),
            "FASTH3_TRIM_ONLY": "1" if trim_only else "0",
        })
        if fastvideo_revision is not None:
            env["HF_REVISION_FASTVIDEO"] = fastvideo_revision
        if corrupt is not None:
            env["FAKE_CORRUPT"] = corrupt
        result = subprocess.run(["bash", str(SCRIPT)], env=env, text=True, capture_output=True, timeout=20)
        self.assertNotIn("fake-token-for-offline-test", result.stdout + result.stderr)
        self.assertEqual(list(self.root.glob("hf-curl.*")), [], "temporary auth configuration must be removed")
        return result

    def requests(self):
        return [json.loads(line) for line in self.log.read_text().splitlines()] if self.log.exists() else []

    def test_trim_only_downloads_pinned_trim_and_verifies_without_alternate_revision(self):
        result = self.run_downloader(trim_only=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("FASTH3_MODELS_OK", result.stdout)
        self.assertEqual(len(self.requests()), 5)
        self.assertEqual({p.name for p in self.models_root.rglob("*.safetensors")}, set(MODEL_PATHS) - {ALTERNATE})
        trim_url = next(row["url"] for row in self.requests() if TRIM in row["url"])
        self.assertIn(f"/FastVideo/FastVideo-FastH3-Trim-Comfy/resolve/{'a' * 40}/diffusion_models/{TRIM}", trim_url)

    def test_full_profile_downloads_both_checkpoints_and_verifies(self):
        result = self.run_downloader(trim_only=False, fastvideo_revision="b" * 40)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("FASTH3_MODELS_OK", result.stdout)
        self.assertEqual({p.name for p in self.models_root.rglob("*.safetensors")}, set(MODEL_PATHS))
        urls = [row["url"] for row in self.requests()]
        self.assertTrue(any(f"/FastVideo/FastVideo-FastH3-Comfy/resolve/{'b' * 40}/" in url for url in urls))
        self.assertTrue(any(f"/FastVideo/FastVideo-FastH3-Trim-Comfy/resolve/{'a' * 40}/" in url for url in urls))

    def test_alternate_revision_is_required_only_for_full_profile(self):
        for revision in (None, "not-a-commit"):
            with self.subTest(revision=revision):
                result = self.run_downloader(trim_only=False, fastvideo_revision=revision)
                self.assertNotEqual(result.returncode, 0)
                self.assertEqual(self.requests(), [])

    def test_hash_mismatch_never_reports_a_complete_model_set(self):
        result = self.run_downloader(trim_only=True, corrupt=TRIM)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("hash mismatch", result.stderr)
        self.assertNotIn("FASTH3_MODELS_OK", result.stdout)

    def test_installer_uses_the_selected_wsl_distribution_for_file_copy_paths(self):
        source = INSTALLER.read_text(encoding="utf-8")
        self.assertIn("$comfyRootWindows = '\\\\wsl$\\' + $Distro + $ComfyRoot.Replace('/', '\\')", source)
        self.assertIn('Join-Path $comfyRootWindows "custom_nodes"', source)
        self.assertIn('Join-Path $comfyRootWindows ".sloptogether-runtime"', source)
        self.assertNotIn('Join-Path (($ComfyRoot.Replace', source)


if __name__ == "__main__":
    unittest.main()
