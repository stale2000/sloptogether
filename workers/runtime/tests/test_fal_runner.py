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
                        "SLOPTOGETHER_WORKER_MAX_RUNTIME_SECONDS": "1" if timed else "28800",
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
             patch.object(pwd, "getpwnam", side_effect=users.__getitem__), \
             patch.object(grp, "getgrnam", return_value=SimpleNamespace(gr_gid=10003)):
            identities = fal_runner._fal_process_identities(environment)
        self.assertIsNotNone(identities)
        self.assertNotEqual(identities[0]["uid"], identities[1]["uid"])
        users["sloptogether-worker"] = SimpleNamespace(pw_uid=10002, pw_gid=10001)
        with patch("sloptogether_worker.fal_runner.os.geteuid", return_value=0), \
             patch.object(pwd, "getpwnam", side_effect=users.__getitem__), \
             patch.object(grp, "getgrnam", return_value=SimpleNamespace(gr_gid=10003)):
            with self.assertRaisesRegex(ValueError, "fal_process_users_must_be_distinct"):
                fal_runner._fal_process_identities(environment)

    def test_worker_process_uses_dedicated_uid_and_shared_input_group(self):
        from unittest.mock import patch as local_patch
        from sloptogether_worker import fal_runner

        identity = {"name": "sloptogether-worker", "uid": 10001, "gid": 10001, "media_gid": 10003}
        with local_patch("sloptogether_worker.fal_runner.os.getgrouplist", return_value=[44, 10003]):
            options = fal_runner._worker_process_identity_options(identity)
        self.assertEqual(options, {"user": 10001, "group": 10001, "extra_groups": [44, 10003]})

    def test_fal_directories_are_owned_by_comfy_worker_and_shared_media_group(self):
        from unittest.mock import patch as local_patch
        from sloptogether_worker import fal_runner

        identities = (
            {"name": "sloptogether-comfy", "uid": 10002, "gid": 10002, "media_gid": 10003},
            {"name": "sloptogether-worker", "uid": 10001, "gid": 10001, "media_gid": 10003},
        )
        env = {
            "SLOPTOGETHER_FAL_MEDIA_GROUP": "sloptogether-media",
            "SLOPTOGETHER_COMFY_INPUT_DIR": "/opt/ComfyUI/input",
            "SLOPTOGETHER_COMFY_WRITABLE_DIRS": "/tmp/slop-comfy-cache",
            "SLOPTOGETHER_COMFY_HOME": "/tmp/slop-comfy-home",
            "SLOPTOGETHER_WORKER_HOME": "/tmp/slop-worker-home",
        }
        with local_patch("pathlib.Path.mkdir"), local_patch("os.chown") as chown, local_patch("os.chmod") as chmod:
            fal_runner._prepare_fal_directories(env, identities)
        self.assertIn((Path("/opt/ComfyUI/input"), 0, 10003), [call.args for call in chown.call_args_list])
        self.assertIn((Path("/tmp/slop-comfy-cache").resolve(), 10002, 10002), [call.args for call in chown.call_args_list])
        self.assertIn((Path("/tmp/slop-worker-home").resolve(), 10001, 10001), [call.args for call in chown.call_args_list])
        self.assertIn((Path("/opt/ComfyUI/input"), 0o2770), [call.args for call in chmod.call_args_list])

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
