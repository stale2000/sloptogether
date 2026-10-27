from __future__ import annotations

import ipaddress
import os
import re
import signal
import stat
import subprocess
import sys
import tempfile
import time
from pathlib import Path
from urllib.error import URLError
from urllib.parse import urlsplit
from urllib.request import urlopen

_ISOLATION_ERROR_CODES = frozenset({
    "fal_cache_access_probe_failed", "fal_comfy_input_directory_invalid", "fal_comfy_writable_directories_required",
    "fal_conditioning_artifact_changed", "fal_conditioning_artifact_invalid", "fal_conditioning_artifact_symlink_rejected",
    "fal_conditioning_identity_unavailable", "fal_conditioning_override_unreadable", "fal_conditioning_prompts_diverged",
    "fal_exact_conditioning_artifact_missing", "fal_private_home_required", "fal_process_identities_must_be_unprivileged",
    "fal_process_identity_configuration_invalid", "fal_process_root_supplementary_group_rejected", "fal_process_users_must_be_distinct",
    "fal_runtime_directory_invalid", "fal_runtime_directory_symlink_rejected", "fal_shared_cache_missing",
    "fal_shared_cache_not_directory", "fal_shared_huggingface_cache_not_accessible", "fal_shared_model_cache_unreadable",
    "fal_worker_startup_interrupted", "fal_writable_root_rejected",
})


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
    if min(comfy_user.pw_uid, comfy_user.pw_gid, worker_user.pw_uid, worker_user.pw_gid, media_group.gr_gid) <= 0:
        raise ValueError("fal_process_identities_must_be_unprivileged")
    if (0 in os.getgrouplist(comfy_name, comfy_user.pw_gid)
            or 0 in os.getgrouplist(worker_name, worker_user.pw_gid)):
        raise ValueError("fal_process_root_supplementary_group_rejected")
    if comfy_user.pw_uid == worker_user.pw_uid:
        raise ValueError("fal_process_users_must_be_distinct")
    return (
        {"name": comfy_name, "uid": comfy_user.pw_uid, "gid": comfy_user.pw_gid, "media_gid": media_group.gr_gid},
        {"name": worker_name, "uid": worker_user.pw_uid, "gid": worker_user.pw_gid, "media_gid": media_group.gr_gid},
    )


def _worker_process_identity_options(identity: dict[str, object]) -> dict[str, object]:
    groups = set(os.getgrouplist(str(identity["name"]), int(identity["gid"])))
    groups.add(int(identity["media_gid"]))
    if 0 in groups:
        raise ValueError("fal_process_root_supplementary_group_rejected")
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


def _cache_accessible_as_comfy(path: Path, identity: dict[str, object], mode: int) -> bool:
    """Probe with the real child UID and groups, never root's access rights."""
    result = subprocess.run(
        [sys.executable, "-c", "import os,sys; sys.exit(0 if os.access(sys.argv[1],int(sys.argv[2])) else 1)", str(path), str(mode)],
        env={"PATH": os.defpath}, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
        timeout=15, check=False, **_worker_process_identity_options(identity),
    )
    if result.returncode not in (0, 1):
        raise ValueError("fal_cache_access_probe_failed")
    return result.returncode == 0


def _conditioning_artifact_name(environment: dict[str, str], identity: dict[str, object]) -> str:
    """Derive the exact cache key using the pinned SoL child runtime."""
    from .recipes import RECIPES, SOL_UPSCALE_ID, SOL_UPSCALE_1184_ID, _workflow

    prompts = [_workflow(RECIPES[name])["2"]["inputs"]["prompt"] for name in (SOL_UPSCALE_ID, SOL_UPSCALE_1184_ID)]
    if not isinstance(prompts[0], str) or not prompts[0] or prompts[0] != prompts[1]:
        raise ValueError("fal_conditioning_prompts_diverged")
    child_environment = _unprivileged_environment(environment, environment["SLOPTOGETHER_COMFY_HOME"])
    child_environment["PYTHONPATH"] = "/opt/ComfyUI/custom_nodes"
    code = (
        "import os,sys; "
        "from comfystream_sol_refiner_h3.fixed_conditioning import conditioning_cache_path,conditioning_identity; "
        "from comfystream_sol_refiner_h3.model_runtime import MODEL_ID,MODEL_REVISION; "
        "from comfystream_sol_refiner_h3.media_export import _experiment_flag; "
        "print(conditioning_cache_path(conditioning_identity(sys.stdin.read(),MODEL_ID,MODEL_REVISION,"
        "_experiment_flag('COMFYSTREAM_SOL_H3_VIDEO_ONLY_REFINER'))).name)"
    )
    result = subprocess.run(
        ["/opt/ComfyUI/custom_nodes/comfystream_sol_refiner_h3/.worker/bin/python", "-c", code],
        input=prompts[0], env=child_environment, capture_output=True, text=True, timeout=60,
        check=False, **_worker_process_identity_options(identity),
    )
    name = result.stdout.strip()
    if result.returncode != 0 or not re.fullmatch(r"[a-f0-9]{64}\.pt", name):
        raise ValueError("fal_conditioning_identity_unavailable")
    return name


def _stage_conditioning_artifact(source: Path, target: Path, identity: dict[str, object]) -> None:
    """Copy one bounded artifact without mutating its shared source."""
    if source.is_symlink() or target.parent.is_symlink():
        raise ValueError("fal_conditioning_artifact_symlink_rejected")
    source_fd = os.open(source, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0))
    temporary = None
    try:
        source_stat = os.fstat(source_fd)
        if not stat.S_ISREG(source_stat.st_mode) or not 0 < source_stat.st_size <= 64 * 1024**2:
            raise ValueError("fal_conditioning_artifact_invalid")
        target.parent.mkdir(parents=True, exist_ok=True)
        os.chown(target.parent, int(identity["uid"]), int(identity["gid"]))
        os.chmod(target.parent, 0o700)
        fd, temporary = tempfile.mkstemp(prefix=".conditioning-", dir=target.parent)
        with os.fdopen(fd, "wb") as out, os.fdopen(source_fd, "rb", closefd=False) as src:
            copied = 0
            while chunk := src.read(1024 * 1024):
                copied += len(chunk)
                if copied > source_stat.st_size:
                    raise ValueError("fal_conditioning_artifact_changed")
                out.write(chunk)
            after = os.fstat(source_fd)
            if copied != source_stat.st_size or (after.st_dev, after.st_ino, after.st_size, after.st_mtime_ns) != (
                source_stat.st_dev, source_stat.st_ino, source_stat.st_size, source_stat.st_mtime_ns
            ):
                raise ValueError("fal_conditioning_artifact_changed")
            out.flush()
            os.fchown(out.fileno(), int(identity["uid"]), int(identity["gid"]))
            os.fchmod(out.fileno(), 0o600)
        os.replace(temporary, target)
        temporary = None
    finally:
        os.close(source_fd)
        if temporary is not None:
            Path(temporary).unlink(missing_ok=True)


def _prepare_fal_directories(environment: dict[str, str], identities: tuple[dict[str, object], dict[str, object]] | None, *, should_stop=lambda: False) -> None:
    if identities is None:
        return
    def ensure_active() -> None:
        if should_stop():
            raise ValueError("fal_worker_startup_interrupted")

    ensure_active()
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
    configured_output = _safe_runtime_directory(
        environment.get(
            "SLOPTOGETHER_COMFY_OUTPUT_DIR",
            "/tmp/fasth3-output" if environment.get("SLOPTOGETHER_WORKER_ROLE") == "generation" else "/opt/ComfyUI/output",
        )
    )
    # Fal's /data mount is shared by the account. Existing model and compiler
    # caches can belong to unrelated apps, so never recursively change their
    # ownership or permissions. If a configured shared cache does not exist,
    # use a role-specific SlopTogether cache rather than creating it globally.
    shared_data = Path("/data").resolve(strict=False)
    role = environment.get("SLOPTOGETHER_WORKER_ROLE", "")
    private_cache_root = shared_data / "sloptogether" / role
    fallback_caches = {
        "HF_HOME": "huggingface",
        "TORCHINDUCTOR_CACHE_DIR": "torchinductor",
        "TRITON_CACHE_DIR": "triton",
        "CUDA_CACHE_PATH": "cuda-cache",
        "COMFYSTREAM_SOL_H3_NVFP4_CACHE_DIR": "nvfp4",
    }
    for value in writable:
        ensure_active()
        path = _safe_runtime_directory(value)
        if path in {shared_data, Path("/tmp").resolve(strict=False), Path("/opt/ComfyUI").resolve(strict=False)}:
            raise ValueError("fal_writable_root_rejected")
        if path == shared_data or shared_data in path.parents:
            if path == private_cache_root or private_cache_root in path.parents:
                pass
            else:
                if path.exists():
                    if not path.is_dir():
                        raise ValueError("fal_shared_cache_not_directory")
                    if _cache_accessible_as_comfy(path, comfy, os.R_OK | os.W_OK | os.X_OK):
                        if environment.get("HF_HOME") == value:
                            hub = path / "hub"
                            if hub.exists() and not _cache_accessible_as_comfy(hub, comfy, os.R_OK | os.X_OK):
                                raise ValueError("fal_shared_model_cache_unreadable")
                        continue
                    if environment.get("HF_HOME") == value:
                        raise ValueError("fal_shared_huggingface_cache_not_accessible")
                matches = [name for name in fallback_caches if environment.get(name) == value]
                if len(matches) != 1 or role not in {"generation", "upscale"}:
                    raise ValueError("fal_shared_cache_missing")
                name = matches[0]
                path = _safe_runtime_directory(str(private_cache_root / fallback_caches[name]))
                environment[name] = str(path)
        path.mkdir(parents=True, exist_ok=True)
        # The worker removes only its UUID-scoped output folder after reading
        # the clip back from ComfyUI. Give the dedicated output spool the same
        # media group as the input directory, while keeping Comfy's caches and
        # home private to the Comfy user.
        group = int(comfy["media_gid"]) if path == configured_output else int(comfy["gid"])
        os.chown(path, int(comfy["uid"]), group)
        os.chmod(path, 0o2770)
        # The role-specific persistent cache is created by the unprivileged
        # runtime after its root is prepared. Walking it on every startup can
        # require thousands of network filesystem metadata operations.
        if path == shared_data or shared_data in path.parents:
            continue
        for parent, directories, _files in os.walk(path, followlinks=False):
            ensure_active()
            parent_path = Path(parent)
            for name in directories:
                child = parent_path / name
                if child.is_symlink():
                    raise ValueError("fal_runtime_directory_symlink_rejected")
                os.chown(child, int(comfy["uid"]), group)
                os.chmod(child, 0o2770)
    explicit_hub = environment.get("HF_HUB_CACHE") or environment.get("HUGGINGFACE_HUB_CACHE")
    if explicit_hub:
        ensure_active()
        hub = _safe_runtime_directory(explicit_hub)
        if not hub.is_dir() or not _cache_accessible_as_comfy(hub, comfy, os.R_OK | os.X_OK):
            raise ValueError("fal_shared_model_cache_unreadable")
    for env_name, default, identity in (
        ("SLOPTOGETHER_COMFY_HOME", "/tmp/sloptogether-comfy-home", comfy),
        ("SLOPTOGETHER_WORKER_HOME", "/tmp/sloptogether-worker", worker),
    ):
        ensure_active()
        home = _safe_runtime_directory(environment.get(env_name, default))
        temporary_root = Path("/tmp").resolve(strict=False)
        temporary_home = home.parent == temporary_root and home.name.startswith("sloptogether-")
        private_home = private_cache_root in home.parents
        if not temporary_home and not private_home:
            raise ValueError("fal_private_home_required")
        home.mkdir(parents=True, exist_ok=True)
        os.chown(home, int(identity["uid"]), int(identity["gid"]))
        os.chmod(home, 0o700)
        environment[env_name] = str(home)
    if role == "upscale":
        ensure_active()
        override = environment.get("COMFYSTREAM_SOL_H3_CONDITIONING_ARTIFACT", "").strip()
        if override:
            source = _safe_runtime_directory(override)
            if not source.is_file() or not _cache_accessible_as_comfy(source, comfy, os.R_OK):
                raise ValueError("fal_conditioning_override_unreadable")
        else:
            name = _conditioning_artifact_name(environment, comfy)
            ensure_active()
            hf_home = _safe_runtime_directory(environment.get("HF_HOME", "/data/.cache/huggingface"))
            source = _safe_runtime_directory(str(hf_home / "comfystream" / "h3-conditioning" / name))
            if not source.is_file():
                raise ValueError("fal_exact_conditioning_artifact_missing")
            target = _safe_runtime_directory(str(Path(environment["SLOPTOGETHER_COMFY_HOME"]) / "conditioning" / name))
            _stage_conditioning_artifact(source, target, comfy)
            ensure_active()
            environment["COMFYSTREAM_SOL_H3_CONDITIONING_ARTIFACT"] = str(target)


def _unprivileged_environment(
    environment: dict[str, str], home: str, *, preserve_comfy_bearer: bool = False
) -> dict[str, str]:
    child = environment.copy()
    child["HOME"] = home
    for name in (
        "FAL_KEY",
        "OPENAI_API_KEY",
        "ANTHROPIC_API_KEY",
        "HF_TOKEN",
        "HUGGING_FACE_HUB_TOKEN",
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
        secret_setting = name.startswith("SLOPTOGETHER_") and any(
            part in name for part in ("SECRET", "TOKEN", "PASSWORD", "API_KEY", "TICKET_KEY", "HASH_PEPPER")
        )
        if secret_setting or (name != "HUGGINGFACE_HUB_CACHE" and name.startswith(("FAL_", "R2_", "TWITCH_", "OPENAI_", "ANTHROPIC_", "AWS_", "GOOGLE_", "HUGGINGFACE_", "SLOPTOGETHER_WORKER_KEY"))):
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
        max_runtime_seconds = int(os.environ.get("SLOPTOGETHER_WORKER_MAX_RUNTIME_SECONDS", "7200"))
        if not 1 <= max_runtime_seconds <= 7200:
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
        try:
            identities = _fal_process_identities(environment)
            _prepare_fal_directories(
                environment, identities,
                should_stop=lambda: interrupted or time.monotonic() >= session_deadline,
            )
        except (KeyError, OSError, ValueError, subprocess.TimeoutExpired) as error:
            if interrupted:
                return 128 + interrupted_signal
            if time.monotonic() >= session_deadline:
                print("fal_worker_max_runtime_reached", file=sys.stderr)
                return 0
            detail = str(error) if isinstance(error, ValueError) else ""
            code = detail if detail in _ISOLATION_ERROR_CODES else type(error).__name__
            print(f"fal_worker_process_isolation_invalid: {code}", file=sys.stderr)
            return 2
        if interrupted:
            return 128 + interrupted_signal
        if time.monotonic() >= session_deadline:
            print("fal_worker_max_runtime_reached", file=sys.stderr)
            return 0
        comfy_environment = _unprivileged_environment(
            environment, environment.get("SLOPTOGETHER_COMFY_HOME", "/tmp/sloptogether-comfy-home")
        )
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
