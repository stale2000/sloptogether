"""Persistent JSON worker transport with process and exchange ownership."""

from __future__ import annotations

import hashlib
import ctypes
import errno
import json
import os
import queue
import select
import signal
import subprocess
import sys
import threading
import time
from pathlib import Path
from typing import TypeVar

from .protocol import WorkerRequest, WorkerResponse, parse_worker_response

_STDERR_TAIL_LIMIT = 8192
_STDERR_FINAL_DRAIN_LIMIT = 64 * 1024
_MAX_RESPONSE_BYTES = 8 * 1024 * 1024
_STDERR_DIAGNOSTICS = (
    (b"cuda out of memory", "cuda_out_of_memory"),
    (b"torch.outofmemoryerror", "cuda_out_of_memory"),
    (b"loading checkpoint shards", "loading_checkpoint"),
    (b"loading pipeline components", "loading_pipeline"),
    (b"[sol-refiner] primed", "checkpoint_cache_primed"),
    (b"traceback (most recent call last)", "worker_exception"),
)

_T = TypeVar("_T")


class _WorkerExited(Exception):
    pass


def _darwin_child_waitable(pid: int) -> bool:
    """Check child ownership on macOS without consuming its exit status."""
    try:
        waitid = ctypes.CDLL(None, use_errno=True).waitid
        waitid.argtypes = (ctypes.c_int, ctypes.c_uint, ctypes.c_void_p, ctypes.c_int)
        waitid.restype = ctypes.c_int
        # Darwin sys/wait.h: P_PID=1, WNOHANG=1, WEXITED=4, WNOWAIT=32.
        # The aligned buffer is larger than Darwin's siginfo_t; we do not
        # inspect its ABI-specific fields.
        info = (ctypes.c_long * 64)()
        for _ in range(3):
            if waitid(1, pid, ctypes.byref(info), 1 | 4 | 32) == 0:
                return True
            if ctypes.get_errno() != errno.EINTR:
                return False
    except (AttributeError, OSError, TypeError, ValueError):
        return False
    return False


class _ExitObserver:
    """Observe exit without reaping the process-group leader on POSIX."""

    def __init__(self, process: subprocess.Popen[str]) -> None:
        self.process = process
        self._lock = threading.RLock()
        self._exited = False
        self._reaped = False
        self._kqueue = None
        self._waitid = False
        if os.name == "nt":
            return
        if all(hasattr(os, name) for name in ("waitid", "P_PID", "WEXITED", "WNOHANG", "WNOWAIT")):
            self._waitid = True
        elif hasattr(select, "kqueue") and hasattr(select, "KQ_NOTE_EXIT"):
            self._kqueue = select.kqueue()
            event = select.kevent(process.pid, filter=select.KQ_FILTER_PROC,
                                  flags=select.KQ_EV_ADD | select.KQ_EV_ENABLE,
                                  fflags=select.KQ_NOTE_EXIT)
            try:
                self._kqueue.control([event], 0, 0)
            except ProcessLookupError:
                # It may have been auto-reaped (e.g. SIGCHLD ignored). Never
                # signal a numerical PID or group without verified ownership.
                self._reaped = True
                self._exited = True
        else:
            raise RuntimeError("non-reaping worker exit observation is unavailable")

    @property
    def group_safe(self) -> bool:
        with self._lock:
            if self._reaped or self.process.returncode is not None:
                return False
            if os.name == "nt":
                return True
            if signal.getsignal(signal.SIGCHLD) != signal.SIG_DFL:
                return False
            # Confirm the leader is still our unwaited-for child immediately
            # before using its numeric process-group ID. WNOWAIT never reaps.
            if self._waitid:
                try:
                    os.waitid(os.P_PID, self.process.pid, os.WEXITED | os.WNOHANG | os.WNOWAIT)
                    return True
                except (ChildProcessError, OSError):
                    self._reaped = True
                    return False
            if sys.platform == "darwin":
                return _darwin_child_waitable(self.process.pid)
            return False

    def exited(self) -> bool:
        with self._lock:
            if self._exited:
                return True
            if self.process.returncode is not None:
                self._reaped = True
                self._exited = True
            elif os.name == "nt":
                self._exited = self.process.poll() is not None
            elif self._waitid:
                try:
                    self._exited = os.waitid(os.P_PID, self.process.pid, os.WEXITED | os.WNOHANG | os.WNOWAIT) is not None
                except ChildProcessError:
                    self._reaped = True
                    self._exited = True
            elif self._kqueue is not None:
                self._exited = bool(self._kqueue.control(None, 1, 0))
            return self._exited

    def close(self) -> None:
        with self._lock:
            if self._kqueue is not None:
                self._kqueue.close()
                self._kqueue = None


def _wait_exchange_result(results: queue.Queue[_T], observer: _ExitObserver, deadline: float) -> _T:
    """Notice a dead parent even when a descendant keeps a pipe open."""
    while True:
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            raise queue.Empty
        try:
            return results.get(timeout=min(0.1, remaining))
        except queue.Empty:
            if observer.exited():
                try:
                    return results.get_nowait()
                except queue.Empty:
                    raise _WorkerExited from None


def _exit_suffix(status: int | None) -> str:
    if status is None:
        return ""
    if status < 0 and os.name != "nt":
        return f" (signal {-status})"
    return f" (exit code {status})"

_WORKER_ENVIRONMENT_IDENTITY_KEYS = (
    "COMFYSTREAM_SOL_H3_COMPILE_TRANSFORMER",
    "COMFYSTREAM_SOL_H3_VIDEO_ONLY_REFINER",
    "COMFYSTREAM_SOL_H3_CPU_TEXT_ENCODER",
    "COMFYSTREAM_SOL_H3_CPU_PREPROCESS_OVERLAP",
    "COMFYSTREAM_SOL_H3_CONDITIONING_ARTIFACT",
    "COMFYSTREAM_SOL_H3_PROMPT_CACHE",
    "COMFYSTREAM_SOL_H3_PRUNA_CONTIGUOUS_OUTPUT",
    "COMFYSTREAM_SOL_H3_COMPILE_PRUNA_DECODER",
    "COMFYSTREAM_SOL_H3_PRUNA_OUTPUT_COPY_OPT",
    "COMFYSTREAM_SOL_H3_PRUNA_DROP_ENCODER",
    "COMFYSTREAM_SOL_H3_PRUNA_INFERENCE_MODE",
    "COMFYSTREAM_SOL_H3_NVENC_PRESET",
    "COMFYSTREAM_SOL_H3_NVENC_INPUT_FORMAT",
    "COMFYSTREAM_SOL_H3_GPU_AMINMAX",
    "COMFYSTREAM_SOL_H3_ASYNC_NVENC_STAGING",
    "COMFYSTREAM_SOL_H3_HASH_NVENC_INPUT",
    "CUDA_VISIBLE_DEVICES",
    "PYTORCH_ALLOC_CONF",
    "HOME",
    "USERPROFILE",
    "HF_HOME",
    "HF_HUB_CACHE",
    "HUGGINGFACE_HUB_CACHE",
    "TRANSFORMERS_CACHE",
    "HF_XET_CACHE",
    "HF_ASSETS_CACHE",
    "HF_ENDPOINT",
    "HF_HUB_OFFLINE",
    "TRANSFORMERS_OFFLINE",
    "TORCH_HOME",
    "CUDA_HOME",
    "CUDA_PATH",
    "PATH",
    "PYTHONPATH",
    "PYTHONHOME",
    "PYTHONUSERBASE",
    "PYTHONNOUSERSITE",
    "VIRTUAL_ENV",
    "CONDA_PREFIX",
    "CMAKE_PREFIX_PATH",
    "LD_LIBRARY_PATH",
    "LD_PRELOAD",
    "DYLD_LIBRARY_PATH",
    "DYLD_FALLBACK_LIBRARY_PATH",
)


def worker_environment_fingerprint(environment: dict[str, str]) -> str:
    """Hash behavior-bearing child settings without recording credentials."""
    identity = [(key, environment.get(key)) for key in _WORKER_ENVIRONMENT_IDENTITY_KEYS]
    payload = json.dumps(identity, separators=(",", ":"), ensure_ascii=True).encode()
    return hashlib.sha256(payload).hexdigest()


class PersistentWorkerClient:
    """Own one child process and serialize each complete request/response exchange."""

    def __init__(
        self,
        signature: tuple[object, ...],
        command: list[str],
        environment: dict[str, str],
        log_path: Path,
        *,
        label: str,
    ) -> None:
        self.signature = signature
        self.label = label
        self._exchange_lock = threading.Lock()
        self._state_lock = threading.RLock()
        self._close_lock = threading.Lock()
        self._closed = False
        # The child outlives each attempt directory. Keep bounded diagnostics
        # in memory, never under Comfy's public output tree, and never include
        # this cross-request buffer in a response to another channel.
        self._stderr_tail = bytearray()
        self._stderr_seen: set[str] = set()
        self._stderr_lock = threading.Lock()
        self._stderr_stop = threading.Event()
        self._stderr_thread: threading.Thread | None = None
        self._child_pgid: int | None = None
        self._exit_observer: _ExitObserver | None = None
        self._stdout_fd: int | None = None
        self._stdout_buffer = bytearray()
        try:
            self.process = subprocess.Popen(
                command,
                stdin=subprocess.PIPE,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True,
                errors="replace",
                bufsize=1,
                env=environment,
                start_new_session=(os.name != "nt"),
            )
            self._child_pgid = self.process.pid if os.name != "nt" else None
            self._exit_observer = _ExitObserver(self.process)
            if self.process.stderr is None or self.process.stdout is None:
                raise RuntimeError(f"{label} worker pipe is unavailable")
            self._stdout_fd = os.dup(self.process.stdout.fileno())
            os.set_blocking(self._stdout_fd, False)
            fd = os.dup(self.process.stderr.fileno())
            try:
                os.set_blocking(fd, False)
                stderr_thread = threading.Thread(
                    target=self._drain_stderr, args=(fd,),
                    name=f"sol-h3-stderr-{label.replace(' ', '-')}", daemon=True,
                )
                stderr_thread.start()
                self._stderr_thread = stderr_thread
            except BaseException:
                os.close(fd)
                raise
        except BaseException:
            if hasattr(self, "process"):
                self._dispose()
            raise

    def _drain_stderr(self, fd: int) -> None:
        final_remaining = _STDERR_FINAL_DRAIN_LIMIT
        try:
            while True:
                observer = self._exit_observer
                if (not self._stderr_stop.is_set() and observer is not None and observer.exited()
                        and self._exchange_lock.acquire(blocking=False)):
                    try:
                        self._dispose()
                    finally:
                        self._exchange_lock.release()
                    return
                stopping = self._stderr_stop.is_set()
                if stopping and final_remaining <= 0:
                    break
                try:
                    chunk = os.read(fd, 4096)
                except BlockingIOError:
                    if self._stderr_stop.is_set():
                        break
                    self._stderr_stop.wait(0.05)
                    continue
                except OSError:
                    break
                if not chunk:
                    break
                if stopping:
                    final_remaining -= len(chunk)
                with self._stderr_lock:
                    self._stderr_tail.extend(chunk)
                    del self._stderr_tail[:-_STDERR_TAIL_LIMIT]
                    lowered = bytes(self._stderr_tail).lower()
                    notices = {label for marker, label in _STDERR_DIAGNOSTICS
                               if marker in lowered and label not in self._stderr_seen}
                    self._stderr_seen.update(notices)
                for label in notices:
                    try:
                        print(f"[sol-refiner] worker diagnostic: {label}", file=sys.stderr, flush=True)
                    except (OSError, ValueError):
                        pass
        finally:
            os.close(fd)

    def _read_response_line(self, observer: _ExitObserver, deadline: float) -> str:
        """Read one bounded protocol line without a blocking pipe thread."""
        if self._stdout_fd is None:
            raise RuntimeError(f"{self.label} response pipe is unavailable")
        exit_drain_deadline: float | None = None
        while True:
            newline = self._stdout_buffer.find(b"\n")
            if newline >= 0:
                if newline > _MAX_RESPONSE_BYTES:
                    raise ValueError("worker response exceeds size limit")
                line = bytes(self._stdout_buffer[:newline])
                del self._stdout_buffer[:newline + 1]
                return line.decode("utf-8")
            if len(self._stdout_buffer) > _MAX_RESPONSE_BYTES:
                raise ValueError("worker response exceeds size limit")
            if exit_drain_deadline is not None and time.monotonic() >= exit_drain_deadline:
                raise _WorkerExited
            try:
                chunk = os.read(self._stdout_fd, min(65536, _MAX_RESPONSE_BYTES + 1 - len(self._stdout_buffer)))
            except BlockingIOError:
                chunk = None
            if chunk:
                self._stdout_buffer.extend(chunk)
                if exit_drain_deadline is None and observer.exited():
                    # A response already in the pipe may be larger than one
                    # read. Bound how long a surviving descendant can keep
                    # the reader busy after its parent has exited.
                    exit_drain_deadline = time.monotonic() + 0.25
                continue
            if chunk == b"":
                return ""
            if observer.exited():
                raise _WorkerExited
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise TimeoutError(f"{self.label} did not respond within the request deadline")
            time.sleep(min(0.05, remaining))

    def request(
        self,
        request: WorkerRequest,
        *,
        timeout: float,
    ) -> tuple[WorkerResponse, int, None]:
        """Exchange one complete protocol message, disposing the child on bad I/O."""
        deadline = time.monotonic() + timeout
        if not self._exchange_lock.acquire(timeout=max(0.0, deadline - time.monotonic())):
            self._dispose()
            raise TimeoutError(f"{self.label} request queue exceeded {timeout:g} seconds")
        try:
            with self._state_lock:
                if self._closed:
                    raise RuntimeError(f"{self.label} is closed")
                process = self.process
                if not self.is_alive() or process.stdin is None or process.stdout is None:
                    self._dispose()
                    raise RuntimeError(f"{self.label} stopped before its request")
                stdin = process.stdin
                stdout = process.stdout
                observer = self._exit_observer
                if observer is None:
                    raise RuntimeError(f"{self.label} exit observer is unavailable")

            writes: queue.Queue[Exception | None] = queue.Queue(maxsize=1)

            def write_request() -> None:
                try:
                    stdin.write(json.dumps(request, sort_keys=True) + "\n")
                    stdin.flush()
                    writes.put(None)
                except (BrokenPipeError, OSError, ValueError) as exc:
                    writes.put(exc)

            writer = threading.Thread(
                target=write_request,
                name=f"sol-h3-writer-{self.label.replace(' ', '-')}",
                daemon=True,
            )
            writer.start()
            try:
                write_error = _wait_exchange_result(writes, observer, deadline)
            except _WorkerExited:
                self._dispose()
                writer.join(timeout=1)
                raise RuntimeError(f"{self.label} exited during its request{_exit_suffix(process.returncode)}; check memory and runtime logs") from None
            except queue.Empty as exc:
                self._dispose()
                raise TimeoutError(
                    f"{self.label} request write exceeded {timeout:g} seconds"
                ) from exc
            if write_error is not None:
                self._dispose()
                raise RuntimeError(f"{self.label} connection failed") from write_error

            try:
                line = self._read_response_line(observer, deadline)
            except _WorkerExited:
                self._dispose()
                raise RuntimeError(f"{self.label} exited without a response{_exit_suffix(process.returncode)}; check memory and runtime logs") from None
            except TimeoutError:
                self._dispose()
                raise TimeoutError(f"{self.label} did not respond within {timeout:g} seconds.") from None
            except (OSError, ValueError, UnicodeError) as exc:
                self._dispose()
                raise RuntimeError(f"{self.label} returned an invalid or oversized protocol response") from exc
            if not line:
                # EOF may arrive just before the non-reaping exit notification.
                limit = min(deadline, time.monotonic() + 0.2)
                while not observer.exited() and time.monotonic() < limit:
                    time.sleep(0.01)
                had_exited = observer.exited()
                self._dispose()
                exit_status = process.returncode if had_exited else None
                raise RuntimeError(f"{self.label} exited without a response{_exit_suffix(exit_status)}; check memory and runtime logs")
            try:
                response = parse_worker_response(json.loads(line), expected_output=request["output"])
            except (json.JSONDecodeError, TypeError, ValueError) as exc:
                self._dispose()
                raise RuntimeError(f"{self.label} returned an invalid protocol response") from exc
            pid = process.pid
            if observer.exited():
                self._dispose()
            return response, pid, None
        finally:
            self._exchange_lock.release()

    def close(self) -> None:
        """Stop the child immediately so active and queued requests cannot reuse it."""
        self._dispose()

    def is_alive(self) -> bool:
        with self._state_lock:
            return not self._closed and self._exit_observer is not None and not self._exit_observer.exited()

    def _dispose(self) -> None:
        with self._close_lock:
            with self._state_lock:
                if self._closed:
                    return
                self._closed = True
                self._stderr_stop.set()
                process = self.process
                stdin = process.stdin
                stdout = process.stdout
                stderr = process.stderr
            try:
                # Terminate before closing stdin: a writer blocked on a full pipe
                # must not hold shutdown hostage while close waits for that write.
                group_signaled = False
                group_safe = self._exit_observer is None or self._exit_observer.group_safe
                if self._child_pgid is not None and group_safe:
                    try:
                        os.killpg(self._child_pgid, signal.SIGTERM)
                        # Do not reap the leader between these signals: its
                        # PID pins the process-group ID against reuse.
                        os.killpg(self._child_pgid, signal.SIGKILL)
                        group_signaled = True
                    except OSError:
                        pass
                if not group_signaled and process.returncode is None and (os.name == "nt" or group_safe):
                    try:
                        process.terminate()
                    except ProcessLookupError:
                        pass
                if not group_safe and os.name != "nt":
                    try:
                        process.wait(timeout=0)
                    except (ChildProcessError, subprocess.TimeoutExpired):
                        pass
                else:
                    process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                try:
                    process.terminate()
                except ProcessLookupError:
                    pass
                try:
                    process.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    try:
                        process.kill()
                    except ProcessLookupError:
                        pass
                    process.wait()
            finally:
                if self._stdout_fd is not None:
                    try:
                        os.close(self._stdout_fd)
                    except OSError:
                        pass
                    self._stdout_fd = None
                self._stdout_buffer.clear()
                if self._stderr_thread is not None and self._stderr_thread is not threading.current_thread():
                    self._stderr_thread.join(timeout=1)
                if self._exit_observer is not None:
                    self._exit_observer.close()
                if stdin is not None:
                    try:
                        stdin.close()
                    except (OSError, ValueError):
                        pass
                if stdout is not None:
                    try:
                        stdout.close()
                    except (OSError, ValueError):
                        pass
                if stderr is not None:
                    try:
                        stderr.close()
                    except (OSError, ValueError):
                        pass
                with self._stderr_lock:
                    self._stderr_tail.clear()


class WorkerClientRegistry:
    """Own clients by logical worker slot while allowing independent slots to run."""

    def __init__(self) -> None:
        self._lock = threading.RLock()
        self._clients: dict[str, PersistentWorkerClient] = {}

    def request(
        self,
        key: str,
        signature: tuple[object, ...],
        command: list[str],
        environment: dict[str, str],
        log_path: Path,
        request: WorkerRequest,
        *,
        timeout: float,
        label: str,
        required_token: object | None = None,
    ) -> tuple[WorkerResponse, int, None]:
        with self._lock:
            client = self._clients.get(key)
            if required_token is not None and (
                client is not required_token
                or client.signature != signature
                or not client.is_alive()
            ):
                raise RuntimeError(f"{label} changed before its reserved warm request")
            if (
                client is None
                or client.signature != signature
                or not client.is_alive()
            ):
                if client is not None:
                    self._clients.pop(key, None)
                    client.close()
                client = PersistentWorkerClient(
                    signature, command, environment, log_path, label=label,
                )
                self._clients[key] = client
        try:
            return client.request(request, timeout=timeout)
        except (RuntimeError, TimeoutError, ValueError, OSError, TypeError):
            self._remove_if_current(key, client)
            raise

    def close(self, key: str) -> None:
        with self._lock:
            client = self._clients.pop(key, None)
            if client is not None:
                client.close()

    def close_matching(self, prefix: str) -> None:
        with self._lock:
            keys = tuple(key for key in self._clients if key.startswith(prefix))
            for key in keys:
                client = self._clients.pop(key, None)
                if client is not None:
                    client.close()

    def keys(self, prefix: str = "") -> tuple[str, ...]:
        with self._lock:
            return tuple(key for key in self._clients if key.startswith(prefix))

    def contains(self, key: str) -> bool:
        with self._lock:
            return key in self._clients

    def compatible_token(self, key: str, signature: tuple[object, ...], *, expected_pid: int | None = None) -> object | None:
        """Return an opaque identity only for the exact live child and runtime."""
        with self._lock:
            client = self._clients.get(key)
            if (client is None or client.signature != signature or not client.is_alive()
                    or (expected_pid is not None and client.process.pid != expected_pid)):
                return None
            return client

    def _remove_if_current(self, key: str, client: PersistentWorkerClient) -> None:
        with self._lock:
            if self._clients.get(key) is client:
                self._clients.pop(key, None)
                client.close()


__all__ = ["WorkerClientRegistry"]
