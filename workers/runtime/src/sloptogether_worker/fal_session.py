from __future__ import annotations

import argparse
import ipaddress
import json
import re
import os
import signal
import subprocess
import sys
import time
from queue import Empty, SimpleQueue
from datetime import datetime, timezone
from threading import Event, Thread
from urllib.error import URLError
from urllib.parse import urlsplit
from urllib.request import Request, urlopen

MAX_SESSION_SECONDS = 2 * 60 * 60
_STOP = Event()


class FalSessionError(RuntimeError):
    pass


def _endpoint_url(value: str) -> str:
    parsed = urlsplit(value)
    try:
        loopback = parsed.hostname == "localhost" or ipaddress.ip_address(parsed.hostname or "").is_loopback
    except ValueError:
        loopback = parsed.hostname == "localhost"
    parts = [part for part in parsed.path.split("/") if part]
    valid_components = all(re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_-]{0,63}", part) for part in parts)
    if parsed.scheme == "https" and parsed.hostname == "fal.run":
        valid_path = len(parts) == 2 and valid_components
    else:
        valid_path = loopback and parsed.scheme == "http" and bool(parts) and valid_components
    if not valid_path or parsed.username or parsed.password or parsed.query or parsed.fragment:
        raise FalSessionError("fal_endpoint_url_invalid")
    return value.rstrip("/")


def _ping_endpoint(url: str, fal_key: str, *, timeout_seconds: int) -> None:
    request = Request(f"{url}/system_stats", headers={"Authorization": f"Key {fal_key}"})
    try:
        with urlopen(request, timeout=timeout_seconds) as response:
            if response.status != 200:
                raise FalSessionError("fal_worker_ping_failed")
            response.read(1)
    except (OSError, URLError) as error:
        raise FalSessionError("fal_worker_ping_failed") from error


def _heartbeat(app: str, url: str, fal_key: str, interval: float, stop: Event, failures: SimpleQueue[str], ready: Event | None = None) -> None:
    first_wake = True
    while not stop.is_set():
        try:
            _ping_endpoint(url, fal_key, timeout_seconds=3600 if first_wake else 15)
        except FalSessionError:
            failures.put(app)
            stop.set()
            return
        if first_wake and ready is not None:
            ready.set()
        first_wake = False
        if stop.wait(interval):
            return


def _command(args: list[str]) -> str:
    try:
        result = subprocess.run(args, check=True, capture_output=True, text=True, timeout=60)
    except (OSError, subprocess.SubprocessError) as error:
        raise FalSessionError(f"fal_command_failed:{args[1] if len(args) > 1 else 'unknown'}") from error
    return result.stdout


def _active_runner_ids(app: str, fal_cli: str) -> list[str]:
    try:
        result = _command([fal_cli, "apps", "runners", app, "--state", "pending", "setup", "idle", "running", "crash_backoff", "--json"])
        runners = json.loads(result).get("runners")
    except (json.JSONDecodeError, AttributeError, TypeError) as error:
        raise FalSessionError(f"fal_runner_list_invalid:{app}") from error
    if not isinstance(runners, list):
        raise FalSessionError(f"fal_runner_list_invalid:{app}")
    ids: list[str] = []
    for runner in runners:
        runner_id = (runner.get("id") or runner.get("runner_id")) if isinstance(runner, dict) else None
        if not isinstance(runner_id, str) or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_-]{0,127}", runner_id):
            raise FalSessionError(f"fal_runner_id_missing:{app}")
        ids.append(runner_id)
    return ids


def _scale_down(apps: tuple[str, ...], fal_cli: str) -> None:
    failures: list[str] = []
    for app in apps:
        try:
            _command([fal_cli, "apps", "scale", app, "--min-concurrency", "0", "--max-concurrency", "1", "--keep-alive", "0"])
        except FalSessionError:
            failures.append(f"scale:{app}")

    for app in apps:
        try:
            for runner_id in _active_runner_ids(app, fal_cli):
                try:
                    _command([fal_cli, "runners", "stop", runner_id])
                except FalSessionError:
                    try:
                        _command([fal_cli, "runners", "kill", runner_id])
                    except FalSessionError:
                        failures.append(f"stop:{runner_id}")
        except FalSessionError:
            failures.append(f"list:{app}")

    deadline = time.monotonic() + 30
    while time.monotonic() < deadline:
        remaining: list[str] = []
        for app in apps:
            try:
                remaining.extend(_active_runner_ids(app, fal_cli))
            except FalSessionError:
                failures.append(f"verify:{app}")
        if not remaining:
            break
        for runner_id in remaining:
            try:
                _command([fal_cli, "runners", "kill", runner_id])
            except FalSessionError:
                failures.append(f"kill:{runner_id}")
        time.sleep(1)
    else:
        failures.append("runners_still_active")
    if failures:
        raise FalSessionError("fal_shutdown_incomplete:" + ",".join(sorted(set(failures))))


def run_session(
    generation_app: str,
    upscale_app: str,
    *,
    generation_url: str,
    upscale_url: str,
    fal_key: str,
    fal_cli: str = "fal",
    runtime_seconds: int = MAX_SESSION_SECONDS,
    heartbeat_seconds: int = 20,
) -> None:
    if not generation_app or not upscale_app or generation_app == upscale_app:
        raise FalSessionError("fal_apps_must_be_distinct")
    if type(runtime_seconds) is not int or not 1 <= runtime_seconds <= MAX_SESSION_SECONDS:
        raise FalSessionError("fal_session_runtime_must_be_between_1_second_and_2_hours")
    if type(heartbeat_seconds) is not int or not 5 <= heartbeat_seconds <= 45:
        raise FalSessionError("fal_heartbeat_must_be_between_5_and_45_seconds")
    if not fal_key or len(fal_key) > 8192 or any(character.isspace() for character in fal_key):
        raise FalSessionError("fal_key_required")
    urls = (_endpoint_url(generation_url), _endpoint_url(upscale_url))
    apps = (generation_app, upscale_app)
    for app, url in zip(apps, urls, strict=True):
        if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_-]{0,63}", app):
            raise FalSessionError("fal_app_name_invalid")
        parsed = urlsplit(url)
        if parsed.hostname == "fal.run" and parsed.path.split("/")[-1] != app:
            raise FalSessionError("fal_app_url_mismatch")
    started: list[str] = []
    deadline = time.time() + runtime_seconds
    primary_error: BaseException | None = None
    heartbeat_stop = Event()
    heartbeat_failures: SimpleQueue[str] = SimpleQueue()
    heartbeat_threads: list[Thread] = []
    ready_events = {app: Event() for app in apps}
    try:
        for app in apps:
            started.append(app)
            _command([fal_cli, "apps", "scale", app, "--min-concurrency", "0", "--max-concurrency", "1", "--keep-alive", "60"])
        for app, url in zip(apps, urls, strict=True):
            thread = Thread(target=_heartbeat, args=(app, url, fal_key, heartbeat_seconds, heartbeat_stop, heartbeat_failures, ready_events[app]), daemon=True)
            heartbeat_threads.append(thread)
            thread.start()
        print("Fal apps launched; waiting for generation and upscale to wake.", flush=True)
        while not all(event.is_set() for event in ready_events.values()):
            if _STOP.is_set():
                raise FalSessionError("fal_session_stopped_during_startup")
            try:
                failed_app=heartbeat_failures.get_nowait()
            except Empty:
                failed_app=None
            if failed_app:
                raise FalSessionError(f"fal_worker_wake_failed:{failed_app}")
            remaining=deadline-time.time()
            if remaining<=0:
                raise FalSessionError("fal_worker_wake_deadline_exceeded")
            for event in ready_events.values():
                if not event.is_set():
                    event.wait(min(0.1,remaining))
        print(f"Both Fal workers are awake until {datetime.fromtimestamp(deadline, timezone.utc).isoformat()} or session stop.", flush=True)
        while not _STOP.is_set():
            remaining = deadline - time.time()
            if remaining <= 0:
                break
            _STOP.wait(min(1, remaining))
            try:
                failed_app = heartbeat_failures.get_nowait()
            except Empty:
                continue
            raise FalSessionError(f"fal_worker_ping_failed:{failed_app}")
    except BaseException as error:
        primary_error = error
        raise
    finally:
        heartbeat_stop.set()
        try:
            _scale_down(tuple(started), fal_cli)
            print("Fal worker session stopped; active runners are drained or terminated.", flush=True)
        except FalSessionError:
            if primary_error is None:
                raise
            print("fal_shutdown_incomplete; check the Fal dashboard and stop remaining runners.", file=sys.stderr, flush=True)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Run two private SlopTogether Fal workers for at most two hours.")
    parser.add_argument("generation_app", help="Isolated generation app alias")
    parser.add_argument("upscale_app", help="Isolated upscale app alias")
    parser.add_argument("--generation-url", required=True, help="Private generation endpoint URL")
    parser.add_argument("--upscale-url", required=True, help="Private upscale endpoint URL")
    parser.add_argument("--runtime-seconds", type=int, default=MAX_SESSION_SECONDS, help="Maximum active GPU session, up to 7200 seconds")
    parser.add_argument("--fal-cli", default="fal", help="Fal CLI executable")
    args = parser.parse_args(argv)
    fal_key = os.environ.get("FAL_KEY", "")
    _STOP.clear()
    handlers: dict[int, signal.Handlers] = {}
    for number in (signal.SIGINT, signal.SIGTERM, getattr(signal, "SIGHUP", signal.SIGTERM)):
        if number not in handlers:
            handlers[number] = signal.signal(number, lambda _number, _frame: _STOP.set())
    try:
        run_session(args.generation_app, args.upscale_app, generation_url=args.generation_url,
                    upscale_url=args.upscale_url, fal_key=fal_key, fal_cli=args.fal_cli,
                    runtime_seconds=args.runtime_seconds)
        return 0
    except FalSessionError as error:
        print(str(error), file=sys.stderr)
        return 1
    finally:
        for number, handler in handlers.items():
            signal.signal(number, handler)


if __name__ == "__main__":
    raise SystemExit(main())
