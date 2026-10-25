import os
import tempfile
import tomllib
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from sloptogether_worker.config import WorkerConfig, _https_service_url, _is_wsl_unc_path, _platform_matches_os, _require_wsl2_backend, _wsl_distro_from_unc_path, read_worker_secret


class WorkerConfigurationTest(unittest.TestCase):
    def test_worker_api_is_https_except_literal_loopback(self) -> None:
        self.assertEqual(_https_service_url("https://www.clips.gg/sloptogether/api/v1", "api"), "https://www.clips.gg/sloptogether/api/v1")
        self.assertEqual(_https_service_url("http://127.0.0.1:8188", "comfy", allow_loopback_http=True), "http://127.0.0.1:8188")
        for url in ("http://clips.gg/sloptogether/api/v1", "http://127.0.0.1.evil:8188", "https://user:secret@host.invalid"):
            with self.subTest(url=url), self.assertRaises(ValueError):
                _https_service_url(url, "api", allow_loopback_http=True)

    def test_owner_upload_hosts_are_explicit(self) -> None:
        with tempfile.TemporaryDirectory() as folder:
            config_path = Path(folder) / "worker.toml"
            config_path.write_text(chr(10).join(['[worker]', 'role="generation"', 'upload_hosts=["acct.r2.cloudflarestorage.com"]', '']))
            with patch.dict(os.environ, {"SLOPTOGETHER_WORKER_HOME": folder}, clear=True):
                config = WorkerConfig.from_sources(config_path=config_path, role_override=None)
            self.assertEqual(config.allowed_upload_hosts, ("acct.r2.cloudflarestorage.com",))

    def test_fal_upload_hosts_can_be_set_in_the_app_environment(self) -> None:
        with tempfile.TemporaryDirectory() as folder:
            config_path=Path(folder)/"worker.toml"
            config_path.write_text('[worker]\nrole="generation"\n')
            with patch.dict(os.environ,{"SLOPTOGETHER_WORKER_HOME":folder,"SLOPTOGETHER_ALLOWED_UPLOAD_HOSTS":"acct.r2.cloudflarestorage.com,uploads.clips.gg"},clear=True):
                config=WorkerConfig.from_sources(config_path=config_path,role_override=None)
            self.assertEqual(config.allowed_upload_hosts,("acct.r2.cloudflarestorage.com","uploads.clips.gg"))
            with patch.dict(os.environ,{"SLOPTOGETHER_WORKER_HOME":folder,"SLOPTOGETHER_ALLOWED_UPLOAD_HOSTS":"https://evil.example/path"},clear=True):
                with self.assertRaisesRegex(ValueError,"upload_host_invalid"):
                    WorkerConfig.from_sources(config_path=config_path,role_override=None)

    def test_local_s3_upload_endpoint_is_loopback_only_and_local_platform_only(self) -> None:
        with tempfile.TemporaryDirectory() as folder:
            config_path=Path(folder)/"worker.toml"
            config_path.write_text('[worker]\nrole="generation"\n')
            with patch.dict(os.environ,{"SLOPTOGETHER_WORKER_HOME":folder,"SLOPTOGETHER_LOCAL_S3_ENDPOINT":"http://127.0.0.1:9000"},clear=True):
                config=WorkerConfig.from_sources(config_path=config_path,role_override=None)
            self.assertEqual(config.local_s3_endpoint,"http://127.0.0.1:9000")
            with patch.dict(os.environ,{"SLOPTOGETHER_WORKER_HOME":folder,"SLOPTOGETHER_LOCAL_S3_ENDPOINT":"http://public.example:9000"},clear=True):
                with self.assertRaisesRegex(ValueError,"must_use_https"):
                    WorkerConfig.from_sources(config_path=config_path,role_override=None)

    def test_worker_platform_cannot_be_overridden_to_claim_windows_on_posix(self) -> None:
        with tempfile.TemporaryDirectory() as folder:
            config_path=Path(folder)/"worker.toml"
            config_path.write_text('[worker]\nrole="generation"\nplatform="windows"\n')
            with patch.dict(os.environ,{"SLOPTOGETHER_WORKER_HOME":folder},clear=True):
                if os.name != "nt":
                    with self.assertRaisesRegex(ValueError,"worker_platform_must_match_operating_system"):
                        WorkerConfig.from_sources(config_path=config_path,role_override=None)

    def test_wsl_platform_requires_a_windows_worker_client(self) -> None:
        self.assertTrue(_is_wsl_unc_path(r"\\wsl.localhost\Ubuntu\home\user\ComfyUI\input"))
        self.assertTrue(_is_wsl_unc_path(r"\\wsl$\Ubuntu\home\user\ComfyUI\input"))
        self.assertFalse(_is_wsl_unc_path(r"C:\ComfyUI\input"))
        self.assertEqual(_wsl_distro_from_unc_path(r"\\wsl.localhost\Ubuntu\home\user\ComfyUI\input"),"Ubuntu")
        self.assertIsNone(_wsl_distro_from_unc_path(r"\\wsl.localhost\..\ComfyUI\input"))
        with tempfile.TemporaryDirectory() as folder:
            config_path=Path(folder)/"worker.toml"
            config_path.write_text(f'[worker]\nrole="generation"\nplatform="wsl"\ncomfy_input_dir="{folder}"\n')
            self.assertTrue(_platform_matches_os("wsl","nt"))
            self.assertFalse(_platform_matches_os("wsl","posix"))
            if os.name!="nt":
                with patch.dict(os.environ,{"SLOPTOGETHER_WORKER_HOME":folder},clear=True):
                    with self.assertRaisesRegex(ValueError,"worker_platform_must_match_operating_system"):
                        WorkerConfig.from_sources(config_path=config_path,role_override=None)
                    with self.assertRaisesRegex(ValueError,"worker_platform_must_match_operating_system"):
                        WorkerConfig.from_sources(config_path=None,role_override=None,platform_override="wsl")

    def test_wsl_preflight_requires_a_wsl2_kernel_for_the_configured_distro(self) -> None:
        path=r"\\wsl.localhost\Ubuntu\home\user\ComfyUI\input"
        with patch("sloptogether_worker.config.shutil.which",return_value="wsl.exe"), patch(
            "sloptogether_worker.config.subprocess.run",return_value=SimpleNamespace(returncode=0,stdout="5.15.167.4-microsoft-standard-WSL2\n"),
        ) as run:
            _require_wsl2_backend(path)
        self.assertEqual(run.call_args.args[0], ["wsl.exe","--distribution","Ubuntu","--exec","uname","-r"])
        with patch("sloptogether_worker.config.shutil.which",return_value="wsl.exe"), patch(
            "sloptogether_worker.config.subprocess.run",return_value=SimpleNamespace(returncode=0,stdout="4.4.0-Microsoft\n"),
        ):
            with self.assertRaisesRegex(ValueError,"wsl2_runtime_unavailable"):
                _require_wsl2_backend(path)

    def test_wsl_worker_template_is_secret_free_and_uses_a_distro_unc(self) -> None:
        path=Path(__file__).parents[1]/"worker.wsl.example.toml"
        worker=tomllib.loads(path.read_text(encoding="utf-8"))["worker"]
        self.assertEqual(worker["platform"],"wsl")
        self.assertTrue(_is_wsl_unc_path(worker["comfy_input_dir"]))
        self.assertTrue(_is_wsl_unc_path(worker["comfy_output_dir"]))
        self.assertEqual(_wsl_distro_from_unc_path(worker["comfy_input_dir"]),_wsl_distro_from_unc_path(worker["comfy_output_dir"]))
        self.assertEqual(worker["upload_hosts"],["uploads.clips.gg","42741bd068def2af3e3f6cd52a353cdf.r2.cloudflarestorage.com"])
        self.assertNotIn("WORKER_KEY",path.read_text(encoding="utf-8"))

    def test_default_worker_template_allows_only_the_deployed_upload_hosts(self) -> None:
        path=Path(__file__).parents[1]/"worker.example.toml"
        worker=tomllib.loads(path.read_text(encoding="utf-8"))["worker"]
        self.assertEqual(worker["upload_hosts"],["uploads.clips.gg","42741bd068def2af3e3f6cd52a353cdf.r2.cloudflarestorage.com"])

    def test_adaptive_trim_profile_is_limited_to_the_pinned_fal_deployment(self) -> None:
        with tempfile.TemporaryDirectory() as folder:
            config_path = Path(folder) / "worker.toml"
            config_path.write_text('[worker]\nrole="generation"\n')
            with patch.dict(os.environ, {"SLOPTOGETHER_WORKER_HOME": folder}, clear=True):
                local = WorkerConfig.from_sources(config_path=config_path, role_override=None)
            self.assertEqual(local.trim_vsa_budget_policy, "fixed")
            with patch.dict(os.environ, {
                "SLOPTOGETHER_WORKER_HOME": folder,
                "SLOPTOGETHER_TRIM_VSA_BUDGET_POLICY": "adaptive",
            }, clear=True):
                with self.assertRaisesRegex(ValueError, "adaptive_trim_vsa_requires_pinned_fal_generation_profile"):
                    WorkerConfig.from_sources(config_path=config_path, role_override=None)
            with patch.dict(os.environ, {
                "SLOPTOGETHER_WORKER_HOME": folder,
                "SLOPTOGETHER_WORKER_PLATFORM": "fal",
                "SLOPTOGETHER_WORKER_ROLE": "upscale",
                "SLOPTOGETHER_TRIM_VSA_BUDGET_POLICY": "adaptive",
            }, clear=True):
                with self.assertRaisesRegex(ValueError, "adaptive_trim_vsa_requires_pinned_fal_generation_profile"):
                    WorkerConfig.from_sources(config_path=config_path, role_override=None)
            with patch.dict(os.environ, {
                "SLOPTOGETHER_WORKER_HOME": folder,
                "SLOPTOGETHER_WORKER_PLATFORM": "fal",
                "SLOPTOGETHER_WORKER_ROLE": "generation",
                "SLOPTOGETHER_TRIM_VSA_BUDGET_POLICY": "adaptive",
            }, clear=True):
                fal = WorkerConfig.from_sources(config_path=config_path, role_override=None)
            self.assertEqual(fal.trim_vsa_budget_policy, "adaptive")

    def test_credential_file_must_be_private_on_posix(self) -> None:
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / "key"
            path.write_text("super-secret-worker-key-value")
            path.chmod(0o644)
            if os.name != "nt":
                with self.assertRaisesRegex(ValueError, "permissions"):
                    read_worker_secret({"credential_file": str(path)}, default_path=path)

    def test_fal_role_key_is_scoped_and_wins_over_the_generic_key(self) -> None:
        default = Path("/tmp/nonexistent-sloptogether-worker-key")
        with patch.dict(os.environ, {
            "SLOPTOGETHER_WORKER_KEY": "generic-test-key-value-at-least-32-bytes",
            "SLOPTOGETHER_WORKER_KEY_GENERATION": "generation-test-key-value-at-least-32-bytes",
            "SLOPTOGETHER_WORKER_KEY_UPSCALE": "upscale-test-key-value-at-least-32-bytes",
        }, clear=True):
            self.assertEqual(read_worker_secret({}, default_path=default, role="generation"), "generation-test-key-value-at-least-32-bytes")
            self.assertEqual(read_worker_secret({}, default_path=default, role="upscale"), "upscale-test-key-value-at-least-32-bytes")

    def test_empty_fal_role_key_does_not_fall_back_to_a_broader_generic_key(self) -> None:
        with patch.dict(os.environ, {
            "SLOPTOGETHER_WORKER_KEY": "generic-test-key-value-at-least-32-bytes",
            "SLOPTOGETHER_WORKER_KEY_GENERATION": "",
        }, clear=True):
            with self.assertRaisesRegex(ValueError, "worker_key_environment_value_invalid"):
                read_worker_secret({}, default_path=Path("/tmp/nonexistent-sloptogether-worker-key"), role="generation")


if __name__ == "__main__":
    unittest.main()
