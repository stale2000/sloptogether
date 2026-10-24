from __future__ import annotations

import hashlib
import sys
import tempfile
import unittest
import zipfile
from pathlib import Path

ROOT=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT))
from package_worker_bundle import package_bundle  # noqa: E402


class WindowsBundleTest(unittest.TestCase):
    def test_packages_only_the_executable_and_nonsecret_setup_files(self) -> None:
        with tempfile.TemporaryDirectory() as folder:
            root=Path(folder);dist=root/"dist";dist.mkdir()
            files={
                "SlopTogetherWorker.exe":dist/"SlopTogetherWorker.exe",
                "worker.example.toml":dist/"worker.example.toml",
                "worker.wsl.example.toml":dist/"worker.wsl.example.toml",
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
            for relative in ("SlopTogetherWorker.exe","worker.example.toml","worker.wsl.example.toml","README.txt"):
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


if __name__=="__main__":
    unittest.main()
