from __future__ import annotations

import os
import contextlib
import io
import signal
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT / "vendor/comfystream/runtime"))
from deploy.custom_nodes.comfystream_sol_refiner_h3.worker_client import (  # noqa: E402
    _MAX_RESPONSE_BYTES,
    _STDERR_TAIL_LIMIT,
    PersistentWorkerClient,
    WorkerClientRegistry,
)


class PersistentWorkerStderrTest(unittest.TestCase):
    @unittest.skipIf(os.name == "nt", "POSIX process-group identity test")
    def test_already_reaped_leader_never_signals_an_unverified_group(self):
        with tempfile.TemporaryDirectory() as directory:
            client = PersistentWorkerClient(("runtime",), [sys.executable, "-u", "-c", "import time; time.sleep(30)"],
                                            dict(os.environ), Path(directory)/"worker.log", label="test")
            client._exchange_lock.acquire()
            try:
                client.process.terminate()
                client.process.wait(timeout=3)  # simulate an unexpected external reaper
                with patch("deploy.custom_nodes.comfystream_sol_refiner_h3.worker_client.os.killpg") as kill_group:
                    client.close()
                    kill_group.assert_not_called()
            finally:
                client._exchange_lock.release()
                client.close()

    @unittest.skipIf(os.name == "nt", "POSIX inherited pipe test")
    def test_parent_exit_is_reported_promptly_and_its_stdout_holding_descendant_is_killed(self):
        registry = WorkerClientRegistry()
        with tempfile.TemporaryDirectory() as directory:
            pid_path = Path(directory)/"descendant.pid"
            descendant = "import os,sys,time; from pathlib import Path; Path(sys.argv[1]).write_text(str(os.getpid())); time.sleep(30)"
            script = ("import subprocess,sys,time; from pathlib import Path; sys.stdin.readline(); "
                      f"subprocess.Popen([sys.executable,'-u','-c',{descendant!r},{str(pid_path)!r}]); "
                      f"p=Path({str(pid_path)!r}); "
                      "deadline=time.monotonic()+2;\nwhile not p.exists() and time.monotonic()<deadline: time.sleep(.01)\nsys.exit(4)")
            started = time.monotonic()
            child_pid = None
            try:
                with self.assertRaisesRegex(RuntimeError, "exit code 4"):
                    registry.request("single", ("runtime",), [sys.executable,"-u","-c",script],
                                     dict(os.environ), Path(directory)/"worker.log", {"output":"test"},
                                     timeout=10, label="test")
                self.assertLess(time.monotonic()-started, 3)
                self.assertTrue(pid_path.exists())
                child_pid = int(pid_path.read_text())
                deadline = time.monotonic()+2
                while time.monotonic()<deadline:
                    state = subprocess.run(["ps","-p",str(child_pid),"-o","state="],capture_output=True,text=True,check=False).stdout.strip()
                    if not state or state.startswith("Z"):
                        break
                    time.sleep(.02)
                self.assertTrue(not state or state.startswith("Z"), "worker descendant remained running")
            finally:
                registry.close("single")
                if child_pid is not None:
                    command=subprocess.run(["ps","-p",str(child_pid),"-o","command="],capture_output=True,text=True,check=False).stdout
                    if str(pid_path) in command:
                        try: os.kill(child_pid, signal.SIGKILL)
                        except ProcessLookupError: pass

    @unittest.skipIf(os.name == "nt", "POSIX inherited pipe test")
    def test_complete_buffered_response_is_accepted_when_parent_exits(self):
        registry = WorkerClientRegistry()
        with tempfile.TemporaryDirectory() as directory:
            pid_path = Path(directory)/"descendant.pid"
            descendant = "import os,sys,time; from pathlib import Path; Path(sys.argv[1]).write_text(str(os.getpid())); time.sleep(30)"
            script = ("import json,subprocess,sys,time; from pathlib import Path; sys.stdin.readline(); "
                      f"subprocess.Popen([sys.executable,'-u','-c',{descendant!r},{str(pid_path)!r}]); "
                      f"p=Path({str(pid_path)!r}); deadline=time.monotonic()+2;\n"
                      "while not p.exists() and time.monotonic()<deadline: time.sleep(.01)\n"
                      "print(json.dumps({'status':'failed','error':'current request'}),flush=True); sys.exit(0)")
            child_pid = None
            try:
                response, _, _ = registry.request("single", ("runtime",), [sys.executable,"-u","-c",script],
                    dict(os.environ), Path(directory)/"worker.log", {"output":"test"}, timeout=5, label="test")
                self.assertEqual(response, {"status":"failed","error":"current request"})
                self.assertTrue(pid_path.exists())
                child_pid = int(pid_path.read_text())
                deadline = time.monotonic()+2
                while time.monotonic()<deadline:
                    state=subprocess.run(["ps","-p",str(child_pid),"-o","state="],capture_output=True,text=True,check=False).stdout.strip()
                    if not state or state.startswith("Z"): break
                    time.sleep(.02)
                self.assertTrue(not state or state.startswith("Z"), "worker descendant remained running")
            finally:
                registry.close("single")
                if child_pid is not None:
                    command=subprocess.run(["ps","-p",str(child_pid),"-o","command="],capture_output=True,text=True,check=False).stdout
                    if str(pid_path) in command:
                        try: os.kill(child_pid, signal.SIGKILL)
                        except ProcessLookupError: pass

    def test_oversized_protocol_output_is_bounded_and_not_disclosed(self):
        registry = WorkerClientRegistry()
        script = ("import sys,time; sys.stdin.readline(); "
                  f"sys.stdout.write('private-value'*({_MAX_RESPONSE_BYTES}//13+2)); "
                  "sys.stdout.flush(); time.sleep(10)")
        with tempfile.TemporaryDirectory() as directory:
            with self.assertRaisesRegex(RuntimeError, "invalid or oversized") as error:
                registry.request("single", ("runtime",), [sys.executable,"-u","-c",script],
                                 dict(os.environ), Path(directory)/"worker.log", {"output":"test"},
                                 timeout=10, label="test")
            self.assertNotIn("private-value", str(error.exception))
        self.assertEqual(registry.keys(), ())

    @unittest.skipIf(os.name == "nt", "POSIX inherited pipe test")
    def test_descendant_continuously_writing_stderr_cannot_hold_disposal_open(self):
        registry = WorkerClientRegistry()
        errors = []
        with tempfile.TemporaryDirectory() as directory:
            pid_path = Path(directory) / "descendant.pid"
            descendant = ("import os,sys,time; from pathlib import Path; "
                          "Path(sys.argv[1]).write_text(str(os.getpid())); "
                          "end=time.monotonic()+3;\n"
                          "while time.monotonic()<end: os.write(2,b'x'*4096)")
            script = ("import subprocess,sys,time; sys.stdin.readline(); "
                      f"subprocess.Popen([sys.executable,'-u','-c',{descendant!r},{str(pid_path)!r}],stderr=sys.stderr); "
                      "time.sleep(10)")
            def run():
                try:
                    registry.request("single", ("runtime",), [sys.executable, "-u", "-c", script],
                                     dict(os.environ), Path(directory)/"worker.log", {"output":"test"},
                                     timeout=2, label="test")
                except Exception as error:
                    errors.append(error)
            thread = threading.Thread(target=run)
            thread.start()
            client = None
            descendant_pid = None
            try:
                deadline = time.monotonic()+1.5
                while time.monotonic()<deadline:
                    client = registry.compatible_token("single", ("runtime",))
                    if client is not None and pid_path.exists():
                        descendant_pid = int(pid_path.read_text())
                        break
                    time.sleep(0.01)
                self.assertIsNotNone(client)
                self.assertIsNotNone(descendant_pid)
                self.assertEqual(os.getpgid(descendant_pid), client.process.pid)
                thread.join(4)
                self.assertFalse(thread.is_alive())
                self.assertEqual(len(errors), 1)
                self.assertIsInstance(errors[0], TimeoutError)
                self.assertFalse(client._stderr_thread.is_alive())
                self.assertEqual(bytes(client._stderr_tail), b"")
                deadline = time.monotonic()+2
                while time.monotonic()<deadline:
                    state = subprocess.run(["ps", "-p", str(descendant_pid), "-o", "state="],
                                           capture_output=True, text=True, check=False).stdout.strip()
                    if not state or state.startswith("Z"):
                        break
                    time.sleep(0.02)
                self.assertTrue(not state or state.startswith("Z"), "worker descendant remained running")
            finally:
                registry.close("single")
                thread.join(4)
                if descendant_pid is not None:
                    result = subprocess.run(["ps", "-p", str(descendant_pid), "-o", "command="],
                                            capture_output=True, text=True, check=False).stdout
                    if str(pid_path) in result:
                        try:
                            os.kill(descendant_pid, signal.SIGKILL)
                        except ProcessLookupError:
                            pass

    def test_gpu_oom_crash_emits_safe_diagnostic_without_private_stderr(self):
        registry = WorkerClientRegistry()
        captured = io.StringIO()
        script = "import sys; sys.stdin.readline(); sys.stderr.write('torch.OutOfMemoryError: CUDA out of memory private-channel-value\\n'); sys.stderr.flush(); sys.exit(1)"
        with tempfile.TemporaryDirectory() as directory, contextlib.redirect_stderr(captured):
            with self.assertRaises(RuntimeError) as error:
                registry.request("single", ("runtime",), [sys.executable, "-u", "-c", script],
                                 dict(os.environ), Path(directory)/"worker.log", {"output":"test"},
                                 timeout=3, label="test")
        self.assertIn("cuda_out_of_memory", captured.getvalue())
        self.assertIn("check memory and runtime logs", str(error.exception))
        self.assertIn("exit code 1", str(error.exception))
        self.assertNotIn("private-channel-value", captured.getvalue()+str(error.exception))

    @unittest.skipIf(os.name == "nt", "POSIX signal status")
    def test_signal_exit_is_reported_without_stderr_contents(self):
        registry = WorkerClientRegistry()
        script = "import os,signal,sys; sys.stdin.readline(); os.kill(os.getpid(),signal.SIGKILL)"
        with tempfile.TemporaryDirectory() as directory:
            with self.assertRaisesRegex(RuntimeError, "signal 9"):
                registry.request("single", ("runtime",), [sys.executable, "-u", "-c", script],
                                 dict(os.environ), Path(directory)/"worker.log", {"output":"test"},
                                 timeout=3, label="test")

    def test_failure_to_start_stderr_reader_reaps_child(self):
        registry = WorkerClientRegistry()
        spawned = []
        real_popen = subprocess.Popen
        def launch(*args, **kwargs):
            process = real_popen(*args, **kwargs)
            spawned.append(process)
            return process
        with tempfile.TemporaryDirectory() as directory, \
                patch("deploy.custom_nodes.comfystream_sol_refiner_h3.worker_client.subprocess.Popen", side_effect=launch), \
                patch("deploy.custom_nodes.comfystream_sol_refiner_h3.worker_client.threading.Thread.start", side_effect=RuntimeError("reader start failed")):
            with self.assertRaisesRegex(RuntimeError, "reader start failed"):
                registry.request("single", ("runtime",), [sys.executable, "-c", "import time; time.sleep(30)"],
                                 dict(os.environ), Path(directory)/"worker.log", {"output":"test"},
                                 timeout=2, label="test")
        self.assertEqual(registry.keys(), ())
        self.assertIsNotNone(spawned[0].poll())
        self.assertTrue(spawned[0].stdin.closed and spawned[0].stdout.closed and spawned[0].stderr.closed)

    def test_noisy_stuck_request_is_bounded_and_times_out_without_stderr_disclosure(self):
        registry = WorkerClientRegistry()
        errors = []
        script = "import os,sys; sys.stdin.readline();\nwhile True: os.write(2,b'private-marker-'+b'x'*4096)"
        with tempfile.TemporaryDirectory() as directory:
            def run():
                try:
                    registry.request("single", ("runtime",), [sys.executable, "-u", "-c", script],
                                     dict(os.environ), Path(directory)/"worker.log", {"output":"test"},
                                     timeout=0.8, label="test")
                except Exception as error:
                    errors.append(error)
            thread = threading.Thread(target=run)
            thread.start()
            client = None
            deadline = time.monotonic()+0.6
            while time.monotonic()<deadline:
                client = registry.compatible_token("single", ("runtime",))
                if client is not None:
                    with client._stderr_lock:
                        if client._stderr_tail:
                            self.assertLessEqual(len(client._stderr_tail), _STDERR_TAIL_LIMIT)
                            break
                time.sleep(0.01)
            self.assertIsNotNone(client)
            thread.join(3)
            self.assertFalse(thread.is_alive())
            self.assertEqual(len(errors), 1)
            self.assertIsInstance(errors[0], TimeoutError)
            self.assertNotIn("private-marker", str(errors[0]))
            self.assertEqual(bytes(client._stderr_tail), b"")
            self.assertEqual(registry.keys(), ())

    def test_stderr_remains_bounded_after_attempt_cleanup_and_never_leaks_to_next_channel(self):
        script = r'''
import json, os, sys
for line in sys.stdin:
    request=json.loads(line)
    os.write(2, (request["marker"]+"\n").encode())
    if request.get("noisy"):
        block=b"x"*4096
        for _ in range(768): os.write(2, block)
        os.write(2, b"\nend-of-noisy-output\n")
    if request.get("die"):
        os._exit(1)
    print(json.dumps({"status":"failed", "error":"current request"}), flush=True)
'''
        registry = WorkerClientRegistry()
        with tempfile.TemporaryDirectory() as directory:
            attempt = Path(directory) / "first-attempt"
            attempt.mkdir()
            old_log = attempt / "worker.log"
            command = [sys.executable, "-u", "-c", script]
            signature = ("runtime",)
            try:
                response, pid, log = registry.request(
                    "single", signature, command, dict(os.environ), old_log,
                    {"output":"first.mp4", "marker":"channel-a-private"}, timeout=5, label="test",
                )
                self.assertEqual(response["status"], "failed")
                self.assertIsNone(log)
                self.assertFalse(old_log.exists())
                attempt.rmdir()
                token = registry.compatible_token("single", signature, expected_pid=pid)
                self.assertIsNotNone(token)
                response, second_pid, _ = registry.request(
                    "single", signature, command, dict(os.environ), Path(directory) / "second.log",
                    {"output":"second.mp4", "marker":"channel-b-private", "noisy":True},
                    timeout=10, label="test", required_token=token,
                )
                self.assertEqual(response["status"], "failed")
                self.assertEqual(pid, second_pid)
                deadline = time.monotonic() + 2
                while time.monotonic() < deadline:
                    with token._stderr_lock:
                        captured = bytes(token._stderr_tail)
                    if b"end-of-noisy-output" in captured:
                        break
                    time.sleep(0.01)
                self.assertIn(b"end-of-noisy-output", captured)
                self.assertLessEqual(len(captured), _STDERR_TAIL_LIMIT)
                with self.assertRaises(RuntimeError) as error:
                    registry.request(
                        "single", signature, command, dict(os.environ), Path(directory) / "third.log",
                        {"output":"third.mp4", "marker":"channel-c-private", "die":True},
                        timeout=5, label="test", required_token=token,
                    )
                self.assertNotIn("channel-a-private", str(error.exception))
                self.assertNotIn("channel-b-private", str(error.exception))
                self.assertNotIn("channel-c-private", str(error.exception))
                self.assertEqual(registry.keys(), ())
                self.assertEqual(bytes(token._stderr_tail), b"")
            finally:
                registry.close("single")


if __name__ == "__main__":
    unittest.main()
