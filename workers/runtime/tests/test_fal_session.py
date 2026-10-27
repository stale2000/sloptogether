from __future__ import annotations

import json
import os
import tempfile
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from queue import SimpleQueue
from unittest import skipIf
from unittest.mock import patch

from sloptogether_worker.fal_session import FalSessionError, _STOP, _heartbeat, run_session
from threading import Event, Thread


@skipIf(os.name == "nt", "Fal CLI session controller targets Linux/macOS operator hosts")
class FalSessionTests(unittest.TestCase):
    def _fake_fal(self, root: Path) -> tuple[Path, Path, Path]:
        state = root / "state.json"
        calls = root / "calls.jsonl"
        executable = root / "fal"
        executable.write_text(
            "#!/usr/bin/env python3\n"
            "import json,os,sys\n"
            "state_path=os.environ['FAL_TEST_STATE']; calls_path=os.environ['FAL_TEST_CALLS']\n"
            "try: state=json.load(open(state_path))\n"
            "except FileNotFoundError: state={}\n"
            "args=sys.argv[1:]\n"
            "with open(calls_path,'a') as f: f.write(json.dumps(args)+'\\n')\n"
            "if args[:2]==['apps','scale']:\n"
            " app=args[2]; minimum=args[args.index('--min-concurrency')+1]\n"
            " if os.getenv('FAL_TEST_FAIL_APP')==app and minimum=='0' and args[args.index('--keep-alive')+1]=='60': sys.exit(4)\n"
            " if minimum=='0' and args[args.index('--keep-alive')+1]=='60': state[app]=[{'id':'runner-'+app}]\n"
            " json.dump(state,open(state_path,'w')); sys.exit(0)\n"
            "if args[:2]==['apps','runners']:\n"
            " print(json.dumps({'runners':state.get(args[2],[])})); sys.exit(0)\n"
            "if args[:2]==['runners','stop'] or args[:2]==['runners','kill']:\n"
            " runner_id=args[2]\n"
            " for app in list(state): state[app]=[r for r in state[app] if r['id']!=runner_id]\n"
            " json.dump(state,open(state_path,'w')); sys.exit(0)\n"
            "sys.exit(3)\n"
        )
        executable.chmod(0o755)
        return executable, state, calls

    def test_scales_two_roles_up_then_stops_every_runner_at_deadline(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            fal, state, calls = self._fake_fal(root)
            authorization_headers: list[str | None] = []

            class Handler(BaseHTTPRequestHandler):
                def do_GET(self):
                    authorization_headers.append(self.headers.get("authorization"))
                    self.send_response(200)
                    self.end_headers()
                    self.wfile.write(b"{}")

                def log_message(self, *_args):
                    pass

            server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
            thread = threading.Thread(target=server.serve_forever, daemon=True)
            thread.start()
            try:
                generation_url = f"http://127.0.0.1:{server.server_port}/generation"
                upscale_url = f"http://127.0.0.1:{server.server_port}/upscale"
                with patch.dict(os.environ, {"FAL_TEST_STATE": str(state), "FAL_TEST_CALLS": str(calls)}):
                    run_session("slop-generation", "slop-upscale", generation_url=generation_url, upscale_url=upscale_url,
                                fal_key="dummy-fal-key-for-test", fal_cli=str(fal), runtime_seconds=1)
                self.assertEqual(json.loads(state.read_text()), {"slop-generation": [], "slop-upscale": []})
                self.assertEqual(authorization_headers.count("Key dummy-fal-key-for-test"), 2)
                commands = [json.loads(line) for line in calls.read_text().splitlines()]
                self.assertNotIn("dummy-fal-key-for-test", [value for args in commands for value in args])
                scales = [(args[2], args[args.index("--min-concurrency") + 1]) for args in commands if args[:2] == ["apps", "scale"]]
                self.assertIn(("slop-generation", "0"), scales)
                self.assertIn(("slop-upscale", "0"), scales)
                self.assertIn(["runners", "stop", "runner-slop-generation"], commands)
                self.assertIn(["runners", "stop", "runner-slop-upscale"], commands)
            finally:
                server.shutdown()
                server.server_close()
                thread.join(timeout=2)

    def test_generation_only_session_does_not_start_or_ping_upscale_app(self):
        with tempfile.TemporaryDirectory() as temporary:
            root=Path(temporary)
            fal,state,calls=self._fake_fal(root)
            authorization_headers=[]

            class Handler(BaseHTTPRequestHandler):
                def do_GET(self):
                    authorization_headers.append(self.headers.get("authorization"))
                    self.send_response(200)
                    self.end_headers()
                    self.wfile.write(b"{}")

                def log_message(self,*_args):
                    pass

            server=ThreadingHTTPServer(("127.0.0.1",0),Handler)
            thread=threading.Thread(target=server.serve_forever,daemon=True)
            thread.start()
            try:
                generation_url=f"http://127.0.0.1:{server.server_port}/generation"
                with patch.dict(os.environ,{"FAL_TEST_STATE":str(state),"FAL_TEST_CALLS":str(calls)}):
                    run_session("slop-generation",None,generation_url=generation_url,upscale_url=None,
                        fal_key="dummy-fal-key-for-test",fal_cli=str(fal),runtime_seconds=1)
                self.assertEqual(json.loads(state.read_text()),{"slop-generation":[]})
                self.assertEqual(authorization_headers,["Key dummy-fal-key-for-test"])
                commands=[json.loads(line) for line in calls.read_text().splitlines()]
                apps={args[2] for args in commands if args[:2]==["apps","scale"]}
                self.assertEqual(apps,{"slop-generation"})
                self.assertIn(["runners","stop","runner-slop-generation"],commands)
            finally:
                server.shutdown()
                server.server_close()
                thread.join(timeout=2)

    def test_failed_second_start_scales_the_first_role_back_down(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            fal, state, calls = self._fake_fal(root)
            with patch.dict(os.environ, {"FAL_TEST_STATE": str(state), "FAL_TEST_CALLS": str(calls), "FAL_TEST_FAIL_APP": "slop-upscale"}):
                with self.assertRaises(FalSessionError):
                    run_session("slop-generation", "slop-upscale", generation_url="https://fal.run/test/slop-generation",
                                upscale_url="https://fal.run/test/slop-upscale", fal_key="dummy-key",
                                fal_cli=str(fal), runtime_seconds=1)
                self.assertEqual(json.loads(state.read_text()), {"slop-generation": []})
                commands = [json.loads(line) for line in calls.read_text().splitlines()]
                self.assertIn(["apps", "scale", "slop-generation", "--min-concurrency", "0", "--max-concurrency", "1", "--keep-alive", "0"], commands)

    def test_stop_during_startup_scales_down_without_waiting_for_a_runner(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            fal, state, calls = self._fake_fal(root)
            ping_started = threading.Event()
            release_ping = threading.Event()
            errors: list[BaseException] = []

            def slow_ping(*_args, **_kwargs):
                ping_started.set()
                release_ping.wait(timeout=2)

            def start_session():
                try:
                    run_session("slop-generation", "slop-upscale", generation_url="https://fal.run/test/slop-generation",
                                upscale_url="https://fal.run/test/slop-upscale", fal_key="dummy-key",
                                fal_cli=str(fal), runtime_seconds=30)
                except BaseException as error:
                    errors.append(error)

            _STOP.clear()
            with patch.dict(os.environ, {"FAL_TEST_STATE": str(state), "FAL_TEST_CALLS": str(calls)}), \
                    patch("sloptogether_worker.fal_session._ping_endpoint", side_effect=slow_ping):
                thread = Thread(target=start_session, daemon=True)
                thread.start()
                self.assertTrue(ping_started.wait(timeout=2))
                _STOP.set()
                thread.join(timeout=2)
                release_ping.set()
                self.assertFalse(thread.is_alive())
                self.assertTrue(any(isinstance(error, FalSessionError) and "stopped_during_startup" in str(error) for error in errors))
                self.assertEqual(json.loads(state.read_text()), {"slop-generation": [], "slop-upscale": []})
            _STOP.clear()

    def test_runtime_cannot_exceed_two_hours(self):
        with self.assertRaisesRegex(FalSessionError, "2_hours"):
            run_session("generation", "upscale", generation_url="https://fal.run/test/gen",
                        upscale_url="https://fal.run/test/up", fal_key="dummy-key", runtime_seconds=7201)

    def test_controller_repeats_wake_ping_while_session_is_alive(self):
        stop = Event()
        ready = Event()
        failures: SimpleQueue[str] = SimpleQueue()
        calls: list[tuple[str, str]] = []

        def fake_ping(url: str, key: str, *, timeout_seconds: int) -> None:
            calls.append((url, key, timeout_seconds))

        with patch("sloptogether_worker.fal_session._ping_endpoint", side_effect=fake_ping):
            thread = Thread(target=_heartbeat, args=("app", "https://fal.run/test/app", "key", 0.01, stop, failures, ready), daemon=True)
            thread.start()
            threading.Event().wait(0.05)
            stop.set()
            thread.join(timeout=1)
        self.assertGreaterEqual(len(calls), 2)
        self.assertTrue(ready.is_set())
        self.assertTrue(all(key == "key" for _url, key, _timeout in calls))
        self.assertEqual(calls[0][2], 3600)
        self.assertTrue(all(timeout == 15 for _url, _key, timeout in calls[1:]))

    def test_hosted_endpoint_must_match_the_scaled_app_alias(self):
        with self.assertRaisesRegex(FalSessionError, "fal_app_url_mismatch"):
            run_session("sloptogether-h3-generation", "sloptogether-h3-upscale",
                        generation_url="https://fal.run/example/other-generation",
                        upscale_url="https://fal.run/example/sloptogether-h3-upscale",
                        fal_key="dummy-key", runtime_seconds=1)


if __name__ == "__main__":
    unittest.main()
