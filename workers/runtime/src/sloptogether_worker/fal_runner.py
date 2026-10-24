from __future__ import annotations

import ipaddress
import os
import signal
import subprocess
import sys
import time
from pathlib import Path
from urllib.error import URLError
from urllib.parse import urlsplit
from urllib.request import urlopen


def _health_url() -> str:
    value = os.environ.get("SLOPTOGETHER_COMFY_HEALTH_URL", "http://127.0.0.1:8188/system_stats")
    parsed = urlsplit(value)
    try:
        loopback = parsed.hostname == "localhost" or ipaddress.ip_address(parsed.hostname or "").is_loopback
    except ValueError:
        loopback = parsed.hostname == "localhost"
    if parsed.scheme != "http" or not loopback or parsed.username or parsed.password or parsed.query or parsed.fragment:
        raise ValueError("comfy_health_url_must_be_loopback_http")
    return value


def _wait_for_comfy(
    url: str,
    process: subprocess.Popen[bytes],
    timeout_seconds: float,
    *,
    should_stop=lambda: False,
) -> bool:
    deadline = time.monotonic() + timeout_seconds
    while time.monotonic() < deadline:
        if should_stop() or process.poll() is not None:
            return False
        try:
            with urlopen(url, timeout=2) as response:
                if response.status == 200:
                    response.read(1)
                    return True
        except (OSError, URLError):
            pass
        time.sleep(1)
    return False


def _stop(process: subprocess.Popen[bytes] | None) -> None:
    if process is None:
        return
    try:
        if os.name == "nt":
            if process.poll() is not None:
                return
            process.terminate()
            process.wait(timeout=2)
        else:
            os.killpg(process.pid, signal.SIGTERM)
            deadline = time.monotonic() + 2
            while time.monotonic() < deadline:
                try:
                    os.killpg(process.pid, 0)
                except ProcessLookupError:
                    break
                time.sleep(0.05)
            else:
                os.killpg(process.pid, signal.SIGKILL)
            if process.poll() is None:
                process.wait(timeout=1)
    except (OSError, subprocess.TimeoutExpired):
        try:
            if os.name == "nt":
                process.kill()
            else:
                os.killpg(process.pid, signal.SIGKILL)
        except OSError:
            pass
        try:
            if process.poll() is None:
                process.wait(timeout=1)
        except subprocess.TimeoutExpired:
            pass


def _fal_process_identities(environment: dict[str, str]) -> tuple[dict[str, object], dict[str, object]] | None:
    comfy_name = environment.get("SLOPTOGETHER_FAL_COMFY_USER")
    worker_name = environment.get("SLOPTOGETHER_FAL_WORKER_USER")
    media_name = environment.get("SLOPTOGETHER_FAL_MEDIA_GROUP")
    if not any((comfy_name, worker_name, media_name)):
        return None
    if os.name == "nt" or not comfy_name or not worker_name or not media_name or os.geteuid() != 0:
        raise ValueError("fal_process_identity_configuration_invalid")
    import grp
    import pwd

    comfy_user = pwd.getpwnam(comfy_name)
    worker_user = pwd.getpwnam(worker_name)
    media_group = grp.getgrnam(media_name)
    if comfy_user.pw_uid == worker_user.pw_uid:
        raise ValueError("fal_process_users_must_be_distinct")
    return (
        {"name": comfy_name, "uid": comfy_user.pw_uid, "gid": comfy_user.pw_gid, "media_gid": media_group.gr_gid},
        {"name": worker_name, "uid": worker_user.pw_uid, "gid": worker_user.pw_gid, "media_gid": media_group.gr_gid},
    )


def _worker_process_identity_options(identity: dict[str, object]) -> dict[str, object]:
    groups = set(os.getgrouplist(str(identity["name"]), int(identity["gid"])))
    groups.add(int(identity["media_gid"]))
    return {
        "user": int(identity["uid"]),
        "group": int(identity["gid"]),
        "extra_groups": sorted(groups),
    }


def _safe_runtime_directory(value: str) -> Path:
    path = Path(value)
    if not path.is_absolute() or ".." in path.parts or any(part.is_symlink() and part != Path("/tmp") for part in (path, *path.parents)):
        raise ValueError("fal_runtime_directory_invalid")
    resolved = path.resolve(strict=False)
    roots = (Path("/tmp"), Path("/data"), Path("/opt/ComfyUI"))
    if not any(resolved == root.resolve(strict=False) or root.resolve(strict=False) in resolved.parents for root in roots):
        raise ValueError("fal_runtime_directory_invalid")
    return resolved


def _prepare_fal_directories(environment: dict[str, str], identities: tuple[dict[str, object], dict[str, object]] | None) -> None:
    if identities is None:
        return
    comfy, worker = identities
    input_directory = _safe_runtime_directory(environment.get("SLOPTOGETHER_COMFY_INPUT_DIR", "/opt/ComfyUI/input"))
    if input_directory != Path("/opt/ComfyUI/input"):
        raise ValueError("fal_comfy_input_directory_invalid")
    input_directory.mkdir(parents=True, exist_ok=True)
    os.chown(input_directory, 0, int(comfy["media_gid"]))
    os.chmod(input_directory, 0o2770)
    writable = [value for value in environment.get("SLOPTOGETHER_COMFY_WRITABLE_DIRS", "").split(":") if value]
    if not writable:
        raise ValueError("fal_comfy_writable_directories_required")
    for value in writable:
        path = _safe_runtime_directory(value)
        path.mkdir(parents=True, exist_ok=True)
        os.chown(path, int(comfy["uid"]), int(comfy["gid"]))
        os.chmod(path, 0o2770)
        for parent, directories, _files in os.walk(path, followlinks=False):
            parent_path = Path(parent)
            for name in directories:
                child = parent_path / name
                if child.is_symlink():
                    raise ValueError("fal_runtime_directory_symlink_rejected")
                os.chown(child, int(comfy["uid"]), int(comfy["gid"]))
                os.chmod(child, 0o2770)
    for env_name, default, identity in (
        ("SLOPTOGETHER_COMFY_HOME", "/tmp/sloptogether-comfy-home", comfy),
        ("SLOPTOGETHER_WORKER_HOME", "/tmp/sloptogether-worker", worker),
    ):
        home = _safe_runtime_directory(environment.get(env_name, default))
        home.mkdir(parents=True, exist_ok=True)
        os.chown(home, int(identity["uid"]), int(identity["gid"]))
        os.chmod(home, 0o700)
        environment[env_name] = str(home)


def _unprivileged_environment(
    environment: dict[str, str], home: str, *, preserve_comfy_bearer: bool = False
) -> dict[str, str]:
    child = environment.copy()
    child["HOME"] = home
    for name in (
        "FAL_KEY",
        "OPENAI_API_KEY",
        "COMFY_API_KEY",
        "SLOPTOGETHER_COMFY_API_KEY",
        "SLOPTOGETHER_OPENAI_MODERATION_KEY",
        "SLOPTOGETHER_BITS_RECONCILE_SECRET",
        "DATABASE_URL",
        "SLOPTOGETHER_TOKEN_ENCRYPTION_KEY",
        "SLOPTOGETHER_KEY_HASH_PEPPER",
    ):
        child.pop(name, None)
    for name in tuple(child):
        if name.startswith(("R2_", "TWITCH_", "SLOPTOGETHER_WORKER_KEY")):
            child.pop(name, None)
    if not preserve_comfy_bearer:
        child.pop("SLOPTOGETHER_COMFY_BEARER", None)
    return child


def main() -> int:
    command = sys.argv[1:]
    if command and command[0] == "--":
        command = command[1:]
    if not command:
        print("fal_worker_comfy_command_required", file=sys.stderr)
        return 2

    role = os.environ.get("SLOPTOGETHER_WORKER_ROLE", "")
    if role not in {"generation", "upscale"}:
        print("fal_worker_role_invalid", file=sys.stderr)
        return 2
    scoped_key_name = f"SLOPTOGETHER_WORKER_KEY_{role.upper()}"
    key_name = scoped_key_name
    if not os.environ.get(scoped_key_name):
        print("fal_worker_role_scoped_key_required", file=sys.stderr)
        return 2
    try:
        timeout_seconds = int(os.environ.get("SLOPTOGETHER_COMFY_STARTUP_TIMEOUT_SECONDS", "3600"))
        if not 1 <= timeout_seconds <= 7200:
            raise ValueError
        max_runtime_seconds = int(os.environ.get("SLOPTOGETHER_WORKER_MAX_RUNTIME_SECONDS", "28800"))
        if not 1 <= max_runtime_seconds <= 28800:
            raise ValueError
        health_url = _health_url()
    except ValueError:
        print("fal_worker_startup_config_invalid", file=sys.stderr)
        return 2

    environment = os.environ.copy()
    environment["SLOPTOGETHER_WORKER_PLATFORM"] = "fal"
    environment["SLOPTOGETHER_COMFY_URL"] = "http://127.0.0.1:8188"
    environment.setdefault("SLOPTOGETHER_COMFY_INPUT_DIR", "/opt/ComfyUI/input")
    environment.setdefault("SLOPTOGETHER_COMFY_OUTPUT_DIR", "/tmp/fasth3-output" if role=="generation" else "/opt/ComfyUI/output")
    environment.setdefault("SLOPTOGETHER_WORKER_HOME", "/tmp/sloptogether-worker")
    try:
        identities = _fal_process_identities(environment)
        _prepare_fal_directories(environment, identities)
    except (KeyError, OSError, ValueError) as error:
        print(f"fal_worker_process_isolation_invalid: {type(error).__name__}", file=sys.stderr)
        return 2
    comfy_environment = _unprivileged_environment(
        environment, environment.get("SLOPTOGETHER_COMFY_HOME", "/tmp/sloptogether-comfy-home")
    )
    comfy: subprocess.Popen[bytes] | None = None
    worker: subprocess.Popen[bytes] | None = None
    interrupted = False
    interrupted_signal = signal.SIGTERM
    original_handlers: dict[int, signal.Handlers] = {}
    session_deadline = time.monotonic() + max_runtime_seconds

    def stop_handler(signal_number: int, _frame: object) -> None:
        nonlocal interrupted, interrupted_signal
        interrupted = True
        interrupted_signal = signal_number

    for signal_number in (signal.SIGTERM, signal.SIGINT):
        original_handlers[signal_number] = signal.signal(signal_number, stop_handler)
    try:
        comfy = subprocess.Popen(command, shell=False, env=comfy_environment, start_new_session=os.name != "nt", preexec_fn=(lambda: os.umask(0o002)) if identities is not None and os.name != "nt" else None)
        startup_remaining = min(timeout_seconds, session_deadline - time.monotonic())
        if startup_remaining <= 0 or not _wait_for_comfy(health_url, comfy, startup_remaining, should_stop=lambda: interrupted):
            print("fal_worker_comfy_startup_failed", file=sys.stderr)
            return 1
        worker_environment = _unprivileged_environment(
            environment,
            environment.get("SLOPTOGETHER_WORKER_HOME", "/tmp/sloptogether-worker"),
            preserve_comfy_bearer=True,
        )
        if key_name in os.environ:
            worker_environment[key_name] = os.environ[key_name]
        worker_options: dict[str, object] = {"shell": False, "env": worker_environment, "start_new_session": os.name != "nt"}
        if identities is not None:
            worker_options.update(_worker_process_identity_options(identities[1]))
        worker = subprocess.Popen(
            [sys.executable, "-m", "sloptogether_worker", "--role", role, "run", "--headless"],
            **worker_options,
        )
        while not interrupted:
            if time.monotonic() >= session_deadline:
                print("fal_worker_max_runtime_reached", file=sys.stderr)
                return 0
            comfy_status = comfy.poll()
            worker_status = worker.poll()
            if comfy_status is not None:
                print("fal_worker_comfy_exited", file=sys.stderr)
                return comfy_status or 1
            if worker_status is not None:
                print("fal_worker_runtime_exited", file=sys.stderr)
                return worker_status
            time.sleep(min(0.25, max(0.01, session_deadline - time.monotonic())))
        return 128 + interrupted_signal
    except OSError as error:
        print(f"fal_worker_process_start_failed: {type(error).__name__}", file=sys.stderr)
        return 1
    finally:
        _stop(worker)
        _stop(comfy)
        for signal_number, handler in original_handlers.items():
            signal.signal(signal_number, handler)


if __name__ == "__main__":
    raise SystemExit(main())
