from __future__ import annotations

import json
import os
import signal
import subprocess
import sys
import tempfile
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from unittest import skipIf
from unittest.mock import Mock, patch


@skipIf(os.name == "nt", "Fal runner process groups are Linux-only")
class FalRunnerTests(unittest.TestCase):
    def test_starts_one_shared_worker_after_comfy_is_ready_and_keeps_key_away_from_comfy(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            fake_package = root / "sloptogether_worker"
            fake_package.mkdir()
            (fake_package / "__init__.py").write_text("")
            (fake_package / "__main__.py").write_text(
                "import json,os,sys\n"
                "import time\n"
                "role=os.getenv('SLOPTOGETHER_WORKER_ROLE','').upper()\n"
                "open(os.environ['TEST_WORKER_MARKER'],'w').write(json.dumps({'argv':sys.argv,'pid':os.getpid(),'platform':os.getenv('SLOPTOGETHER_WORKER_PLATFORM'),'output_dir':os.getenv('SLOPTOGETHER_COMFY_OUTPUT_DIR'),'key':bool(os.getenv('SLOPTOGETHER_WORKER_KEY') or os.getenv('SLOPTOGETHER_WORKER_KEY_'+role)),'fal_key':bool(os.getenv('FAL_KEY')),'generic_key':bool(os.getenv('SLOPTOGETHER_WORKER_KEY')),'moderation_key':bool(os.getenv('SLOPTOGETHER_OPENAI_MODERATION_KEY')),'comfy_cloud_key':bool(os.getenv('SLOPTOGETHER_COMFY_API_KEY') or os.getenv('COMFY_API_KEY')),'comfy_bearer':bool(os.getenv('SLOPTOGETHER_COMFY_BEARER')),'bits_secret':bool(os.getenv('SLOPTOGETHER_BITS_RECONCILE_SECRET'))}))\n"
                "time.sleep(float(os.getenv('TEST_WORKER_SLEEP_SECONDS','0')))\n"
            )

            class HealthHandler(BaseHTTPRequestHandler):
                def do_GET(self):
                    self.send_response(200)
                    self.end_headers()
                    self.wfile.write(b"{}")

                def log_message(self, *_args):
                    pass

            server = ThreadingHTTPServer(("127.0.0.1", 0), HealthHandler)
            thread = threading.Thread(target=server.serve_forever, daemon=True)
            thread.start()
            try:
                runner_script = str(Path(__file__).parents[1] / "src" / "sloptogether_worker" / "fal_runner.py")
                command = [
                    sys.executable, runner_script, "--",
                    sys.executable, "-c",
                    "import json,os,time; open(os.environ['TEST_COMFY_MARKER'],'w').write(json.dumps({'worker_key':any(k.startswith('SLOPTOGETHER_WORKER_KEY') for k in os.environ),'fal_key':bool(os.getenv('FAL_KEY')),'moderation_key':bool(os.getenv('SLOPTOGETHER_OPENAI_MODERATION_KEY')),'comfy_cloud_key':bool(os.getenv('SLOPTOGETHER_COMFY_API_KEY') or os.getenv('COMFY_API_KEY')),'comfy_bearer':bool(os.getenv('SLOPTOGETHER_COMFY_BEARER')),'bits_secret':bool(os.getenv('SLOPTOGETHER_BITS_RECONCILE_SECRET'))})); open(os.environ['TEST_COMFY_PID_MARKER'],'w').write(str(os.getpid())); time.sleep(60)",
                ]
                base_environment = os.environ.copy()
                source_root = str(Path(__file__).parents[1] / "src")
                base_environment["PYTHONPATH"] = os.pathsep.join((str(root), source_root, base_environment.get("PYTHONPATH", "")))
                base_environment.update({
                    "FAL_KEY": "dummy-fal-key-for-test",
                    "SLOPTOGETHER_WORKER_KEY": "dummy-generic-worker-key-for-test",
                    "SLOPTOGETHER_OPENAI_MODERATION_KEY": "dummy-moderation-key-for-test",
                    "SLOPTOGETHER_COMFY_API_KEY": "dummy-comfy-cloud-key-for-test",
                    "COMFY_API_KEY": "dummy-comfy-cli-key-for-test",
                    "SLOPTOGETHER_COMFY_BEARER": "dummy-comfy-bearer-for-test",
                    "SLOPTOGETHER_BITS_RECONCILE_SECRET": "dummy-bits-secret-for-test",
                    "SLOPTOGETHER_COMFY_HEALTH_URL": f"http://127.0.0.1:{server.server_port}/system_stats",
                    "SLOPTOGETHER_COMFY_STARTUP_TIMEOUT_SECONDS": "5",
                })
                base_environment.pop("SLOPTOGETHER_COMFY_OUTPUT_DIR",None)
                for role, timed in (("generation", False), ("upscale", False), ("generation", True)):
                    suffix = f"{role}-timed" if timed else role
                    marker = root / f"{suffix}-worker.json"
                    comfy_env_marker = root / f"{suffix}-comfy-env.json"
                    comfy_pid_marker = root / f"{suffix}-comfy-pid"
                    environment = base_environment | {
                        "SLOPTOGETHER_WORKER_ROLE": role,
                        f"SLOPTOGETHER_WORKER_KEY_{role.upper()}": f"dummy-{role}-key-for-test",
                        "SLOPTOGETHER_WORKER_MAX_RUNTIME_SECONDS": "1" if timed else "7200",
                        "TEST_WORKER_MARKER": str(marker),
                        "TEST_COMFY_MARKER": str(comfy_env_marker),
                        "TEST_COMFY_PID_MARKER": str(comfy_pid_marker),
                        "TEST_WORKER_SLEEP_SECONDS": "60" if timed else "0",
                    }
                    result = subprocess.run(command, env=environment, capture_output=True, text=True, timeout=10)
                    self.assertEqual(result.returncode, 0, result.stderr)
                    worker = json.loads(marker.read_text())
                    self.assertEqual(worker["argv"][1:], ["--role", role, "run", "--headless"])
                    self.assertNotIn(f"dummy-{role}-key-for-test", worker["argv"])
                    self.assertEqual(worker["platform"], "fal")
                    self.assertEqual(worker["output_dir"],"/tmp/fasth3-output" if role=="generation" else "/opt/ComfyUI/output")
                    self.assertTrue(worker["key"])
                    self.assertFalse(worker["generic_key"])
                    self.assertFalse(worker["fal_key"])
                    self.assertFalse(worker["moderation_key"])
                    self.assertFalse(worker["comfy_cloud_key"])
                    self.assertTrue(worker["comfy_bearer"])
                    self.assertFalse(worker["bits_secret"])
                    self.assertEqual(json.loads(comfy_env_marker.read_text()), {
                        "worker_key": False,
                        "fal_key": False,
                        "moderation_key": False,
                        "comfy_cloud_key": False,
                        "comfy_bearer": False,
                        "bits_secret": False,
                    })
                    if timed:
                        self.assertIn("fal_worker_max_runtime_reached", result.stderr)
                    for pid in (worker["pid"], int(comfy_pid_marker.read_text())):
                        with self.assertRaises(ProcessLookupError):
                            os.kill(pid, 0)
            finally:
                server.shutdown()
                server.server_close()
                thread.join(timeout=2)

    def test_requires_a_headless_key_before_starting_comfy(self):
        with tempfile.TemporaryDirectory() as temporary:
            marker = Path(temporary) / "started"
            runner_script = str(Path(__file__).parents[1] / "src" / "sloptogether_worker" / "fal_runner.py")
            environment = os.environ.copy()
            environment.pop("SLOPTOGETHER_WORKER_KEY_GENERATION", None)
            environment["SLOPTOGETHER_WORKER_KEY"] = "dummy-generic-worker-key-for-test"
            environment.update({"SLOPTOGETHER_WORKER_ROLE": "generation", "TEST_MARKER": str(marker)})
            result = subprocess.run(
                [sys.executable, runner_script, "--", sys.executable, "-c", "import os,pathlib; pathlib.Path(os.environ['TEST_MARKER']).touch()"],
                env=environment, capture_output=True, text=True, timeout=5,
            )
            self.assertEqual(result.returncode, 2)
            self.assertIn("fal_worker_role_scoped_key_required", result.stderr)
            self.assertFalse(marker.exists())

    def test_rejects_non_loopback_health_endpoints(self):
        from sloptogether_worker import fal_runner

        previous = os.environ.get("SLOPTOGETHER_COMFY_HEALTH_URL")
        try:
            os.environ["SLOPTOGETHER_COMFY_HEALTH_URL"] = "http://example.com/system_stats"
            with self.assertRaisesRegex(ValueError, "comfy_health_url_must_be_loopback_http"):
                fal_runner._health_url()
        finally:
            if previous is None:
                os.environ.pop("SLOPTOGETHER_COMFY_HEALTH_URL", None)
            else:
                os.environ["SLOPTOGETHER_COMFY_HEALTH_URL"] = previous

    def test_shutdown_signal_interrupts_the_comfy_readiness_wait(self):
        from sloptogether_worker import fal_runner

        process = Mock()
        process.poll.return_value = None
        with patch("sloptogether_worker.fal_runner.urlopen", side_effect=AssertionError("health request should not run")):
            self.assertFalse(fal_runner._wait_for_comfy("http://127.0.0.1:8188/system_stats", process, 3600, should_stop=lambda: True))

    def test_fal_identity_config_requires_distinct_non_root_users(self):
        from types import SimpleNamespace
        import grp
        import pwd
        from sloptogether_worker import fal_runner

        users = {
            "sloptogether-comfy": SimpleNamespace(pw_uid=10002, pw_gid=10002),
            "sloptogether-worker": SimpleNamespace(pw_uid=10001, pw_gid=10001),
        }
        environment = {
            "SLOPTOGETHER_FAL_COMFY_USER": "sloptogether-comfy",
            "SLOPTOGETHER_FAL_WORKER_USER": "sloptogether-worker",
            "SLOPTOGETHER_FAL_MEDIA_GROUP": "sloptogether-media",
        }
        with patch("sloptogether_worker.fal_runner.os.geteuid", return_value=0), \
             patch("sloptogether_worker.fal_runner.os.getgrouplist", return_value=[10003]), \
             patch.object(pwd, "getpwnam", side_effect=users.__getitem__), \
             patch.object(grp, "getgrnam", return_value=SimpleNamespace(gr_gid=10003)):
            identities = fal_runner._fal_process_identities(environment)
        self.assertIsNotNone(identities)
        self.assertNotEqual(identities[0]["uid"], identities[1]["uid"])
        users["sloptogether-worker"] = SimpleNamespace(pw_uid=10002, pw_gid=10001)
        with patch("sloptogether_worker.fal_runner.os.geteuid", return_value=0), \
             patch("sloptogether_worker.fal_runner.os.getgrouplist", return_value=[10003]), \
             patch.object(pwd, "getpwnam", side_effect=users.__getitem__), \
             patch.object(grp, "getgrnam", return_value=SimpleNamespace(gr_gid=10003)):
            with self.assertRaisesRegex(ValueError, "fal_process_users_must_be_distinct"):
                fal_runner._fal_process_identities(environment)

        users["sloptogether-comfy"] = SimpleNamespace(pw_uid=0, pw_gid=10002)
        with patch("sloptogether_worker.fal_runner.os.geteuid", return_value=0), \
             patch("sloptogether_worker.fal_runner.os.getgrouplist", return_value=[10003]), \
             patch.object(pwd, "getpwnam", side_effect=users.__getitem__), \
             patch.object(grp, "getgrnam", return_value=SimpleNamespace(gr_gid=10003)):
            with self.assertRaisesRegex(ValueError, "fal_process_identities_must_be_unprivileged"):
                fal_runner._fal_process_identities(environment)
        users["sloptogether-comfy"] = SimpleNamespace(pw_uid=10002, pw_gid=10002)
        users["sloptogether-worker"] = SimpleNamespace(pw_uid=10001, pw_gid=10001)
        with patch("sloptogether_worker.fal_runner.os.geteuid", return_value=0), \
             patch("sloptogether_worker.fal_runner.os.getgrouplist", return_value=[10003]), \
             patch.object(pwd, "getpwnam", side_effect=users.__getitem__), \
             patch.object(grp, "getgrnam", return_value=SimpleNamespace(gr_gid=0)):
            with self.assertRaisesRegex(ValueError, "fal_process_identities_must_be_unprivileged"):
                fal_runner._fal_process_identities(environment)
        with patch("sloptogether_worker.fal_runner.os.geteuid", return_value=0), \
             patch("sloptogether_worker.fal_runner.os.getgrouplist", return_value=[0, 10003]), \
             patch.object(pwd, "getpwnam", side_effect=users.__getitem__), \
             patch.object(grp, "getgrnam", return_value=SimpleNamespace(gr_gid=10003)):
            with self.assertRaisesRegex(ValueError, "fal_process_root_supplementary_group_rejected"):
                fal_runner._fal_process_identities(environment)

    def test_child_environments_remove_all_fal_credentials(self):
        from sloptogether_worker.fal_runner import _unprivileged_environment

        environment = {"FAL_KEY": "secret", "FAL_KEY_ID": "id", "FAL_KEY_SECRET": "secret",
                       "FAL_API_TOKEN": "secret", "ANTHROPIC_API_KEY": "secret", "HF_TOKEN": "secret",
                       "AWS_SECRET_ACCESS_KEY": "secret", "SLOPTOGETHER_UPLOAD_TICKET_KEY": "secret",
                       "HF_HUB_CACHE": "/data/preferred-hub", "HUGGINGFACE_HUB_CACHE": "/data/legacy-hub",
                       "HUGGINGFACE_TOKEN": "secret", "HUGGINGFACE_API_KEY": "secret",
                       "SLOPTOGETHER_COMFY_BEARER": "loopback",
                       "SLOPTOGETHER_WORKER_PLATFORM": "fal"}
        for keep_bearer in (False, True):
            result = _unprivileged_environment(environment, "/tmp/private", preserve_comfy_bearer=keep_bearer)
            self.assertFalse(any(name.startswith("FAL_") for name in result))
            for name in ("ANTHROPIC_API_KEY", "HF_TOKEN", "HUGGINGFACE_TOKEN", "HUGGINGFACE_API_KEY", "AWS_SECRET_ACCESS_KEY", "SLOPTOGETHER_UPLOAD_TICKET_KEY"):
                self.assertNotIn(name, result)
            self.assertEqual(result["HF_HUB_CACHE"], "/data/preferred-hub")
            self.assertEqual(result["HUGGINGFACE_HUB_CACHE"], "/data/legacy-hub")
            self.assertEqual("SLOPTOGETHER_COMFY_BEARER" in result, keep_bearer)
            self.assertEqual(result["SLOPTOGETHER_WORKER_PLATFORM"], "fal")

    def test_worker_process_uses_dedicated_uid_and_shared_input_group(self):
        from unittest.mock import patch as local_patch
        from sloptogether_worker import fal_runner

        identity = {"name": "sloptogether-worker", "uid": 10001, "gid": 10001, "media_gid": 10003}
        with local_patch("sloptogether_worker.fal_runner.os.getgrouplist", return_value=[44, 10003]):
            options = fal_runner._worker_process_identity_options(identity)
        self.assertEqual(options, {"user": 10001, "group": 10001, "extra_groups": [44, 10003]})

    def test_cache_access_probe_uses_comfy_identity_without_inheriting_secrets(self):
        from sloptogether_worker import fal_runner
        identity = {"name": "sloptogether-comfy", "uid": 10002, "gid": 10002, "media_gid": 10003}
        with patch("os.getgrouplist", return_value=[44, 10003]), patch("subprocess.run") as run:
            run.return_value.returncode = 0
            self.assertTrue(fal_runner._cache_accessible_as_comfy(Path("/data/cache"), identity, os.R_OK | os.W_OK | os.X_OK))
            self.assertEqual(run.call_args.kwargs["user"], 10002)
            self.assertEqual(run.call_args.kwargs["group"], 10002)
            self.assertEqual(run.call_args.kwargs["extra_groups"], [44, 10003])
            self.assertEqual(set(run.call_args.kwargs["env"]), {"PATH"})
            run.return_value.returncode = 1
            self.assertFalse(fal_runner._cache_accessible_as_comfy(Path("/data/cache"), identity, os.R_OK))

    def test_conditioning_identity_uses_pinned_worker_and_scrubbed_environment(self):
        from sloptogether_worker import fal_runner
        identity = {"name": "sloptogether-comfy", "uid": 10002, "gid": 10002, "media_gid": 10003}
        environment = {"SLOPTOGETHER_COMFY_HOME": "/tmp/slop-home", "FAL_KEY_SECRET": "secret", "SLOPTOGETHER_WORKER_KEY_UPSCALE": "secret"}
        with patch("os.getgrouplist", return_value=[10003]), patch("subprocess.run") as run:
            run.return_value.returncode = 0
            run.return_value.stdout = "a" * 64 + ".pt\n"
            self.assertEqual(fal_runner._conditioning_artifact_name(environment, identity), "a" * 64 + ".pt")
            self.assertIn(".worker/bin/python", run.call_args.args[0][0])
            self.assertNotIn("FAL_KEY_SECRET", run.call_args.kwargs["env"])
            self.assertNotIn("SLOPTOGETHER_WORKER_KEY_UPSCALE", run.call_args.kwargs["env"])
            self.assertEqual(run.call_args.kwargs["user"], 10002)

    def test_startup_deadline_includes_directory_preparation(self):
        from sloptogether_worker import fal_runner
        clock = [0.0]
        def prepare(_environment, _identities, *, should_stop):
            self.assertFalse(should_stop())
            clock[0] = 2.0
            self.assertTrue(should_stop())
            raise ValueError("fal_worker_startup_interrupted")
        environment = {"SLOPTOGETHER_WORKER_ROLE": "generation", "SLOPTOGETHER_WORKER_KEY_GENERATION": "test",
                       "SLOPTOGETHER_WORKER_MAX_RUNTIME_SECONDS": "1"}
        with patch.dict(os.environ, environment, clear=True), patch.object(sys, "argv", ["runner", "--", "comfy"]), \
             patch("signal.signal"), patch("time.monotonic", side_effect=lambda: clock[0]), \
             patch.object(fal_runner, "_fal_process_identities", return_value=None), \
             patch.object(fal_runner, "_prepare_fal_directories", side_effect=prepare), \
             patch("subprocess.Popen") as popen:
            self.assertEqual(fal_runner.main(), 0)
            popen.assert_not_called()

    def test_shutdown_signal_is_handled_during_directory_preparation(self):
        from sloptogether_worker import fal_runner
        handlers = {}
        def install(number, handler):
            previous = handlers.get(number, signal.SIG_DFL)
            handlers[number] = handler
            return previous
        def prepare(_environment, _identities, *, should_stop):
            handlers[signal.SIGTERM](signal.SIGTERM, None)
            self.assertTrue(should_stop())
            raise ValueError("fal_worker_startup_interrupted")
        environment = {"SLOPTOGETHER_WORKER_ROLE": "generation", "SLOPTOGETHER_WORKER_KEY_GENERATION": "test"}
        with patch.dict(os.environ, environment, clear=True), patch.object(sys, "argv", ["runner", "--", "comfy"]), \
             patch("signal.signal", side_effect=install), patch.object(fal_runner, "_fal_process_identities", return_value=None), \
             patch.object(fal_runner, "_prepare_fal_directories", side_effect=prepare), patch("subprocess.Popen") as popen:
            self.assertEqual(fal_runner.main(), 128 + signal.SIGTERM)
            popen.assert_not_called()

    def test_startup_logs_only_known_isolation_codes(self):
        from contextlib import redirect_stderr
        from io import StringIO
        from sloptogether_worker import fal_runner
        environment = {"SLOPTOGETHER_WORKER_ROLE": "generation", "SLOPTOGETHER_WORKER_KEY_GENERATION": "test"}
        for error, expected in (("fal_shared_model_cache_unreadable", "fal_shared_model_cache_unreadable"),
                                ("fal_untrusted_secret_value", "ValueError")):
            captured = StringIO()
            with self.subTest(error=error), patch.dict(os.environ, environment, clear=True), \
                 patch.object(sys, "argv", ["runner", "--", "comfy"]), patch("signal.signal"), \
                 patch.object(fal_runner, "_fal_process_identities", side_effect=ValueError(error)), redirect_stderr(captured):
                self.assertEqual(fal_runner.main(), 2)
            self.assertIn(f"fal_worker_process_isolation_invalid: {expected}", captured.getvalue())
            if error != expected:
                self.assertNotIn(error, captured.getvalue())

    def test_fal_directories_are_owned_by_comfy_worker_and_shared_media_group(self):
        from unittest.mock import patch as local_patch
        from sloptogether_worker import fal_runner

        identities = (
            {"name": "sloptogether-comfy", "uid": 10002, "gid": 10002, "media_gid": 10003},
            {"name": "sloptogether-worker", "uid": 10001, "gid": 10001, "media_gid": 10003},
        )
        for role, output_dir in (("generation", "/tmp/slop-generation-output"), ("upscale", "/tmp/slop-upscale-output")):
            with self.subTest(role=role):
                env = {
                    "SLOPTOGETHER_WORKER_ROLE": role,
                    "SLOPTOGETHER_FAL_MEDIA_GROUP": "sloptogether-media",
                    "SLOPTOGETHER_COMFY_INPUT_DIR": "/opt/ComfyUI/input",
                    "SLOPTOGETHER_COMFY_OUTPUT_DIR": output_dir,
                    "SLOPTOGETHER_COMFY_WRITABLE_DIRS": f"/tmp/slop-comfy-cache:{output_dir}",
                    "SLOPTOGETHER_COMFY_HOME": "/tmp/sloptogether-test-comfy-home",
                    "SLOPTOGETHER_WORKER_HOME": "/tmp/sloptogether-test-worker-home",
                }
                with local_patch("pathlib.Path.mkdir"), local_patch("pathlib.Path.is_file", return_value=True), \
                     local_patch("sloptogether_worker.fal_runner._conditioning_artifact_name", return_value="a" * 64 + ".pt"), \
                     local_patch("sloptogether_worker.fal_runner._stage_conditioning_artifact"), \
                     local_patch("os.chown") as chown, local_patch("os.chmod") as chmod:
                    fal_runner._prepare_fal_directories(env, identities)
                ownership = [call.args for call in chown.call_args_list]
                permissions = [call.args for call in chmod.call_args_list]
                self.assertIn((Path("/opt/ComfyUI/input"), 0, 10003), ownership)
                self.assertIn((Path("/tmp/slop-comfy-cache").resolve(), 10002, 10002), ownership)
                self.assertIn((Path(output_dir).resolve(), 10002, 10003), ownership)
                self.assertIn((Path("/tmp/sloptogether-test-worker-home").resolve(), 10001, 10001), ownership)
                self.assertIn((Path("/opt/ComfyUI/input"), 0o2770), permissions)

    def test_prebuilt_h3_conditioning_copies_only_the_exact_artifact(self):
        from sloptogether_worker import fal_runner
        identity = {"name": "sloptogether-comfy", "uid": 10002, "gid": 10002, "media_gid": 10003}
        with tempfile.TemporaryDirectory(dir="/tmp") as folder:
            shared = Path(folder) / "shared"
            shared.mkdir()
            selected = shared / ("a" * 64 + ".pt")
            other = shared / ("b" * 64 + ".pt")
            selected.write_bytes(b"selected conditioning")
            other.write_bytes(b"unrelated conditioning")
            selected.chmod(0o600)
            target = Path(folder) / "private" / selected.name
            with patch("os.chown") as chown, patch("os.fchown"):
                fal_runner._stage_conditioning_artifact(selected, target, identity)
            self.assertEqual(target.read_bytes(), selected.read_bytes())
            self.assertEqual(selected.stat().st_mode & 0o777, 0o600)
            self.assertEqual([p.name for p in target.parent.iterdir()], [selected.name])
            self.assertEqual([call.args[0] for call in chown.call_args_list], [target.parent])

    def test_shared_fal_caches_are_left_unchanged(self):
        from sloptogether_worker import fal_runner

        identities = (
            {"name": "sloptogether-comfy", "uid": 10002, "gid": 10002, "media_gid": 10003},
            {"name": "sloptogether-worker", "uid": 10001, "gid": 10001, "media_gid": 10003},
        )
        shared = {Path("/data/.cache/huggingface"), Path("/data/triton")}
        env = {
            "SLOPTOGETHER_WORKER_ROLE": "generation",
            "SLOPTOGETHER_COMFY_INPUT_DIR": "/opt/ComfyUI/input",
            "SLOPTOGETHER_COMFY_OUTPUT_DIR": "/tmp/slop-upscale-output",
            "SLOPTOGETHER_COMFY_WRITABLE_DIRS": "/data/.cache/huggingface:/data/triton:/tmp/slop-upscale-output",
            "SLOPTOGETHER_COMFY_HOME": "/tmp/sloptogether-test-comfy-home",
            "SLOPTOGETHER_WORKER_HOME": "/tmp/sloptogether-test-worker-home",
            "HF_HOME": "/data/.cache/huggingface",
            "TRITON_CACHE_DIR": "/data/triton",
        }
        with patch.object(Path, "exists", lambda path: path in shared), \
             patch.object(Path, "is_dir", lambda path: path in shared), \
             patch.object(Path, "mkdir"), patch("os.walk", return_value=[]) as walk, \
             patch("sloptogether_worker.fal_runner._cache_accessible_as_comfy", return_value=True), \
             patch("os.chown") as chown, patch("os.chmod") as chmod:
            fal_runner._prepare_fal_directories(env, identities)

        for path in shared:
            self.assertNotIn(path, [call.args[0] for call in chown.call_args_list])
            self.assertNotIn(path, [call.args[0] for call in chmod.call_args_list])
            self.assertNotIn(path, [call.args[0] for call in walk.call_args_list])
        self.assertEqual(env["HF_HOME"], "/data/.cache/huggingface")
        self.assertEqual(env["TRITON_CACHE_DIR"], "/data/triton")

    def test_missing_shared_caches_use_role_scoped_fallbacks(self):
        from sloptogether_worker import fal_runner

        identities = (
            {"name": "sloptogether-comfy", "uid": 10002, "gid": 10002, "media_gid": 10003},
            {"name": "sloptogether-worker", "uid": 10001, "gid": 10001, "media_gid": 10003},
        )
        env = {
            "SLOPTOGETHER_WORKER_ROLE": "generation",
            "SLOPTOGETHER_COMFY_INPUT_DIR": "/opt/ComfyUI/input",
            "SLOPTOGETHER_COMFY_OUTPUT_DIR": "/tmp/slop-upscale-output",
            "SLOPTOGETHER_COMFY_WRITABLE_DIRS": "/data/.cache/huggingface:/data/triton:/tmp/slop-upscale-output",
            "SLOPTOGETHER_COMFY_HOME": "/tmp/sloptogether-test-comfy-home",
            "SLOPTOGETHER_WORKER_HOME": "/tmp/sloptogether-test-worker-home",
            "HF_HOME": "/data/.cache/huggingface",
            "TRITON_CACHE_DIR": "/data/triton",
        }
        with patch.object(Path, "exists", return_value=False), patch.object(Path, "mkdir"), \
             patch("os.walk", return_value=[]) as walk, patch("os.chown") as chown, patch("os.chmod"):
            fal_runner._prepare_fal_directories(env, identities)

        self.assertEqual(env["HF_HOME"], "/data/sloptogether/generation/huggingface")
        self.assertEqual(env["TRITON_CACHE_DIR"], "/data/sloptogether/generation/triton")
        self.assertIn((Path(env["HF_HOME"]), 10002, 10002), [call.args for call in chown.call_args_list])
        self.assertNotIn(Path(env["HF_HOME"]), [call.args[0] for call in walk.call_args_list])

    def test_inaccessible_shared_huggingface_cache_fails_without_mutation(self):
        from sloptogether_worker import fal_runner
        identities = (
            {"name": "sloptogether-comfy", "uid": 10002, "gid": 10002, "media_gid": 10003},
            {"name": "sloptogether-worker", "uid": 10001, "gid": 10001, "media_gid": 10003},
        )
        shared = Path("/data/.cache/huggingface")
        env = {"SLOPTOGETHER_WORKER_ROLE": "generation", "SLOPTOGETHER_COMFY_WRITABLE_DIRS": str(shared), "HF_HOME": str(shared)}
        with patch.object(Path, "exists", return_value=True), patch.object(Path, "is_dir", return_value=True), \
             patch.object(Path, "mkdir"), patch("os.chown") as chown, patch("os.chmod"), \
             patch("sloptogether_worker.fal_runner._cache_accessible_as_comfy", return_value=False):
            with self.assertRaisesRegex(ValueError, "fal_shared_huggingface_cache_not_accessible"):
                fal_runner._prepare_fal_directories(env, identities)
        self.assertNotIn(shared, [call.args[0] for call in chown.call_args_list])

    def test_unwritable_shared_compiler_cache_uses_private_path(self):
        from sloptogether_worker import fal_runner
        identities = (
            {"name": "sloptogether-comfy", "uid": 10002, "gid": 10002, "media_gid": 10003},
            {"name": "sloptogether-worker", "uid": 10001, "gid": 10001, "media_gid": 10003},
        )
        shared = Path("/data/triton")
        env = {"SLOPTOGETHER_WORKER_ROLE": "generation", "SLOPTOGETHER_COMFY_WRITABLE_DIRS": str(shared), "TRITON_CACHE_DIR": str(shared)}
        with patch.object(Path, "exists", return_value=True), patch.object(Path, "is_dir", return_value=True), \
             patch.object(Path, "mkdir"), patch("os.chown") as chown, patch("os.chmod"), patch("os.walk", return_value=[]), \
             patch("sloptogether_worker.fal_runner._cache_accessible_as_comfy", return_value=False):
            fal_runner._prepare_fal_directories(env, identities)
        self.assertEqual(env["TRITON_CACHE_DIR"], "/data/sloptogether/generation/triton")
        self.assertNotIn(shared, [call.args[0] for call in chown.call_args_list])

    def test_explicit_hub_override_must_be_readable_by_comfy(self):
        from sloptogether_worker import fal_runner
        identities = (
            {"name": "sloptogether-comfy", "uid": 10002, "gid": 10002, "media_gid": 10003},
            {"name": "sloptogether-worker", "uid": 10001, "gid": 10001, "media_gid": 10003},
        )
        shared = Path("/data/root-owned-hub")
        env = {"SLOPTOGETHER_WORKER_ROLE": "generation", "SLOPTOGETHER_COMFY_WRITABLE_DIRS": "/tmp/sloptogether-test-cache",
               "HF_HUB_CACHE": str(shared)}
        with patch.object(Path, "is_dir", return_value=True), patch.object(Path, "mkdir"), patch("os.walk", return_value=[]), \
             patch("os.chown") as chown, patch("os.chmod"), \
             patch("sloptogether_worker.fal_runner._cache_accessible_as_comfy", return_value=False):
            with self.assertRaisesRegex(ValueError, "fal_shared_model_cache_unreadable"):
                fal_runner._prepare_fal_directories(env, identities)
        self.assertNotIn(shared, [call.args[0] for call in chown.call_args_list])

    def test_hub_cache_override_precedence_matches_child_environment(self):
        from sloptogether_worker import fal_runner
        identities = (
            {"name": "sloptogether-comfy", "uid": 10002, "gid": 10002, "media_gid": 10003},
            {"name": "sloptogether-worker", "uid": 10001, "gid": 10001, "media_gid": 10003},
        )
        for preferred in (None, "/data/preferred-hub"):
            env = {"SLOPTOGETHER_WORKER_ROLE": "generation", "SLOPTOGETHER_COMFY_WRITABLE_DIRS": "/tmp/sloptogether-test-cache",
                   "HUGGINGFACE_HUB_CACHE": "/data/legacy-hub"}
            if preferred:
                env["HF_HUB_CACHE"] = preferred
            with patch.object(Path, "is_dir", return_value=True), patch.object(Path, "mkdir"), patch("os.walk", return_value=[]), \
                 patch("os.chown"), patch("os.chmod"), \
                 patch("sloptogether_worker.fal_runner._cache_accessible_as_comfy", return_value=True) as probe:
                fal_runner._prepare_fal_directories(env, identities)
            effective = preferred or env["HUGGINGFACE_HUB_CACHE"]
            self.assertTrue(any(call.args[0] == Path(effective) for call in probe.call_args_list))
            child = fal_runner._unprivileged_environment(env, "/tmp/private")
            self.assertEqual(child.get("HF_HUB_CACHE") or child.get("HUGGINGFACE_HUB_CACHE"), effective)

    def test_upscale_stages_exact_shared_conditioning_into_default_private_home(self):
        from sloptogether_worker import fal_runner
        identities = (
            {"name": "sloptogether-comfy", "uid": 10002, "gid": 10002, "media_gid": 10003},
            {"name": "sloptogether-worker", "uid": 10001, "gid": 10001, "media_gid": 10003},
        )
        name = "a" * 64 + ".pt"
        env = {"SLOPTOGETHER_WORKER_ROLE": "upscale", "SLOPTOGETHER_COMFY_WRITABLE_DIRS": "/data/.cache/huggingface",
               "HF_HOME": "/data/.cache/huggingface"}
        with patch.object(Path, "exists", return_value=True), patch.object(Path, "is_dir", return_value=True), \
             patch.object(Path, "is_file", return_value=True), patch.object(Path, "mkdir"), patch("os.chown") as chown, \
             patch("os.chmod"), patch("sloptogether_worker.fal_runner._cache_accessible_as_comfy", return_value=True), \
             patch("sloptogether_worker.fal_runner._conditioning_artifact_name", return_value=name) as derive, \
             patch("sloptogether_worker.fal_runner._stage_conditioning_artifact") as stage:
            fal_runner._prepare_fal_directories(env, identities)
        source = Path("/data/.cache/huggingface/comfystream/h3-conditioning") / name
        target = Path(env["SLOPTOGETHER_COMFY_HOME"]) / "conditioning" / name
        stage.assert_called_once_with(source, target, identities[0])
        self.assertEqual(env["COMFYSTREAM_SOL_H3_CONDITIONING_ARTIFACT"], str(target))
        self.assertEqual(derive.call_args.args[0]["SLOPTOGETHER_COMFY_HOME"], str(Path("/tmp/sloptogether-comfy-home").resolve()))
        self.assertNotIn(source, [call.args[0] for call in chown.call_args_list])

    def test_shared_or_root_home_paths_are_rejected_without_mutating_them(self):
        from sloptogether_worker import fal_runner
        identities = (
            {"name": "sloptogether-comfy", "uid": 10002, "gid": 10002, "media_gid": 10003},
            {"name": "sloptogether-worker", "uid": 10001, "gid": 10001, "media_gid": 10003},
        )
        for home in ("/tmp", "/data/.cache/huggingface", "/opt/ComfyUI"):
            env = {"SLOPTOGETHER_WORKER_ROLE": "generation", "SLOPTOGETHER_COMFY_WRITABLE_DIRS": "/tmp/sloptogether-test-cache",
                   "SLOPTOGETHER_COMFY_HOME": home}
            with self.subTest(home=home), patch.object(Path, "mkdir"), patch("os.walk", return_value=[]), \
                 patch("os.chown") as chown, patch("os.chmod"):
                with self.assertRaisesRegex(ValueError, "fal_private_home_required"):
                    fal_runner._prepare_fal_directories(env, identities)
                self.assertNotIn(Path(home).resolve(), [call.args[0] for call in chown.call_args_list])

    def test_writable_root_itself_is_rejected(self):
        from sloptogether_worker import fal_runner
        identities = (
            {"name": "sloptogether-comfy", "uid": 10002, "gid": 10002, "media_gid": 10003},
            {"name": "sloptogether-worker", "uid": 10001, "gid": 10001, "media_gid": 10003},
        )
        env = {"SLOPTOGETHER_WORKER_ROLE": "generation", "SLOPTOGETHER_COMFY_WRITABLE_DIRS": "/tmp"}
        with patch.object(Path, "mkdir"), patch("os.chown"), patch("os.chmod"):
            with self.assertRaisesRegex(ValueError, "fal_writable_root_rejected"):
                fal_runner._prepare_fal_directories(env, identities)

    def test_process_group_is_killed_even_if_its_leader_has_exited(self):
        from sloptogether_worker import fal_runner

        process = Mock()
        process.pid = 1234
        process.poll.return_value = 0
        sent: list[int] = []
        ticks = iter((0.0, 0.0, 3.0))

        def kill_group(_pid: int, sig: int) -> None:
            sent.append(sig)

        with patch("sloptogether_worker.fal_runner.os.killpg", side_effect=kill_group), \
             patch("sloptogether_worker.fal_runner.time.monotonic", side_effect=lambda: next(ticks)), \
             patch("sloptogether_worker.fal_runner.time.sleep"):
            fal_runner._stop(process)
        self.assertIn(signal.SIGTERM, sent)
        self.assertIn(signal.SIGKILL, sent)


if __name__ == "__main__":
    unittest.main()
