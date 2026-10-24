from __future__ import annotations

import ipaddress
import os
import shutil
import stat
import subprocess
import tomllib
from dataclasses import dataclass
from pathlib import Path
from urllib.parse import urlsplit

from .credential_store import load_secret
from .models import Role


def _https_service_url(value: str, label: str, *, allow_loopback_http: bool = False) -> str:
    parsed = urlsplit(value)
    if not parsed.hostname or parsed.username or parsed.password:
        raise ValueError(f"{label}_url_invalid")
    local = parsed.hostname.lower() == "localhost"
    try:
        local = local or ipaddress.ip_address(parsed.hostname).is_loopback
    except ValueError:
        pass
    if parsed.scheme != "https" and not (allow_loopback_http and local and parsed.scheme == "http"):
        raise ValueError(f"{label}_must_use_https")
    if parsed.query or parsed.fragment:
        raise ValueError(f"{label}_url_query_not_allowed")
    return value.rstrip("/")


def _positive_int(value: object, name: str, minimum: int, maximum: int) -> int:
    if type(value) is not int or not minimum <= value <= maximum:
        raise ValueError(f"{name}_invalid")
    return value


def _platform_matches_os(platform: str, os_name: str) -> bool:
    if platform in {"windows", "wsl"}:
        return os_name == "nt"
    return os_name != "nt"


def _is_wsl_unc_path(value: str) -> bool:
    normalized=value.replace("/","\\").lower()
    return normalized.startswith("\\\\wsl.localhost\\") or normalized.startswith("\\\\wsl$\\")


def _wsl_distro_from_unc_path(value: str) -> str | None:
    normalized=value.replace("/","\\")
    for prefix in ("\\\\wsl.localhost\\","\\\\wsl$\\"):
        if normalized.lower().startswith(prefix):
            distro=normalized[len(prefix):].split("\\",1)[0]
            return distro if distro and distro not in {".",".."} else None
    return None


def _require_wsl2_backend(input_dir: str) -> None:
    distro=_wsl_distro_from_unc_path(input_dir)
    executable=shutil.which("wsl.exe") or shutil.which("wsl")
    if not distro or not executable:
        raise ValueError("wsl2_runtime_unavailable")
    try:
        result=subprocess.run([executable,"--distribution",distro,"--exec","uname","-r"],
            capture_output=True,text=True,timeout=5,check=False)
    except (OSError,subprocess.SubprocessError):
        raise ValueError("wsl2_runtime_unavailable") from None
    if result.returncode!=0 or "WSL2" not in result.stdout.upper():
        raise ValueError("wsl2_runtime_unavailable")


def load_config(path: Path | None) -> dict[str, object]:
    if path is None:
        return {}
    data = tomllib.loads(path.read_text(encoding="utf-8"))
    worker = data.get("worker")
    if not isinstance(worker, dict):
        raise ValueError("config_worker_section_required")
    return worker


def read_worker_secret(config: dict[str, object], *, default_path: Path, role: str | None = None) -> str | None:
    scoped_name = f"SLOPTOGETHER_WORKER_KEY_{role.upper()}" if role in {"generation", "upscale"} else None
    scoped_present = scoped_name is not None and scoped_name in os.environ
    value = os.environ.get(scoped_name) if scoped_present else os.environ.get("SLOPTOGETHER_WORKER_KEY")
    if scoped_present and not value:
        raise ValueError("worker_key_environment_value_invalid")
    if value:
        if len(value) < 32 or len(value) > 512 or any(c.isspace() for c in value):
            raise ValueError("worker_key_environment_value_invalid")
        return value
    key_path_value = config.get("credential_file") or (str(default_path) if default_path.exists() else None)
    if key_path_value is None:
        return None
    if not isinstance(key_path_value, str) or len(key_path_value) > 2048:
        raise ValueError("credential_file_invalid")
    path = Path(key_path_value).expanduser()
    info = path.stat()
    if not stat.S_ISREG(info.st_mode):
        raise ValueError("credential_file_must_be_regular_file")
    if os.name != "nt" and info.st_mode & 0o077:
        raise ValueError("credential_file_permissions_must_be_0600")
    secret = load_secret(path)
    if len(secret) < 32 or len(secret) > 512 or any(c.isspace() for c in secret):
        raise ValueError("credential_file_value_invalid")
    return secret


@dataclass(frozen=True, slots=True)
class WorkerConfig:
    api_base_url: str
    platform: str
    role: Role
    channel_id: str | None
    comfy_url: str
    comfy_input_dir: Path
    comfy_output_dir: Path
    state_dir: Path
    poll_interval_seconds: int
    heartbeat_interval_seconds: int
    request_timeout_seconds: int
    max_output_bytes: int
    comfy_profile_api_token: str | None
    allowed_upload_hosts: tuple[str, ...]
    worker_key: str | None
    local_s3_endpoint: str | None
    trim_vsa_budget_policy: str

    @classmethod
    def from_sources(cls, *, config_path: Path | None, role_override: str | None, platform_override: str | None = None) -> WorkerConfig:
        worker = load_config(config_path)
        role_value = role_override or os.environ.get("SLOPTOGETHER_WORKER_ROLE") or worker.get("role", "generation")
        if role_value not in {"generation", "upscale", "story-producer"}:
            raise ValueError("worker_role_unsupported")
        default_platform = "windows" if os.name == "nt" else "linux"
        platform = platform_override or os.environ.get("SLOPTOGETHER_WORKER_PLATFORM", str(worker.get("platform", default_platform)))
        if platform not in {"windows", "wsl", "linux", "fal"}:
            raise ValueError("worker_platform_unsupported")
        if not _platform_matches_os(platform,os.name):
            raise ValueError("worker_platform_must_match_operating_system")
        trim_vsa_budget_policy = os.environ.get(
            "SLOPTOGETHER_TRIM_VSA_BUDGET_POLICY",
            str(worker.get("trim_vsa_budget_policy", "fixed")),
        )
        if trim_vsa_budget_policy not in {"fixed", "adaptive"}:
            raise ValueError("trim_vsa_budget_policy_invalid")
        if trim_vsa_budget_policy == "adaptive" and (platform != "fal" or role_value != "generation"):
            raise ValueError("adaptive_trim_vsa_requires_pinned_fal_generation_profile")
        api_base = os.environ.get("SLOPTOGETHER_API_BASE_URL", str(worker.get("api_base_url", "https://www.clips.gg/sloptogether/api/v1")))
        comfy = os.environ.get("SLOPTOGETHER_COMFY_URL", str(worker.get("comfy_url", "http://127.0.0.1:8188")))
        local_comfy = _https_service_url(comfy, "comfy", allow_loopback_http=True)
        parsed_local = urlsplit(local_comfy)
        try:
            is_loopback = parsed_local.hostname == "localhost" or ipaddress.ip_address(parsed_local.hostname or "").is_loopback
        except ValueError:
            is_loopback = parsed_local.hostname == "localhost"
        if not is_loopback:
            raise ValueError("comfy_endpoint_must_be_loopback")
        worker_api = _https_service_url(api_base, "worker_api", allow_loopback_http=True)
        configured_hosts=os.environ.get("SLOPTOGETHER_ALLOWED_UPLOAD_HOSTS")
        allowed_hosts_value=([host.strip() for host in configured_hosts.split(",") if host.strip()]
            if configured_hosts is not None else worker.get("upload_hosts", []))
        if not isinstance(allowed_hosts_value, list) or any(not isinstance(host, str) for host in allowed_hosts_value):
            raise ValueError("upload_hosts_invalid")
        hosts = tuple(host.lower() for host in allowed_hosts_value)
        for host in hosts:
            if not host or "/" in host or ":" in host or host.lower() != host:
                raise ValueError("upload_host_invalid")
        local_s3_value=os.environ.get("SLOPTOGETHER_LOCAL_S3_ENDPOINT")
        local_s3_endpoint=None
        if local_s3_value:
            local_s3_endpoint=_https_service_url(local_s3_value,"local_s3",allow_loopback_http=True)
            local_s3=urlsplit(local_s3_endpoint)
            if platform not in {"windows","wsl","linux"} or local_s3.scheme!="http" or local_s3.hostname not in {"localhost","127.0.0.1","::1"}:
                raise ValueError("local_s3_endpoint_must_be_loopback_http")
        root = Path(os.environ.get("SLOPTOGETHER_WORKER_HOME", str(worker.get("state_dir", "~/.sloptogether")))).expanduser()
        input_dir_value=os.environ.get("SLOPTOGETHER_COMFY_INPUT_DIR",str(worker.get("comfy_input_dir","~/ComfyUI/input")))
        output_dir_value=os.environ.get("SLOPTOGETHER_COMFY_OUTPUT_DIR",str(worker.get("comfy_output_dir","~/ComfyUI/output")))
        if platform=="wsl" and not _is_wsl_unc_path(input_dir_value):
            raise ValueError("wsl_comfy_input_dir_must_be_distro_unc")
        if platform=="wsl":
            if not _is_wsl_unc_path(output_dir_value) or _wsl_distro_from_unc_path(input_dir_value)!=_wsl_distro_from_unc_path(output_dir_value):
                raise ValueError("wsl_comfy_output_dir_must_match_input_distro")
            _require_wsl2_backend(input_dir_value)
        input_dir=Path(input_dir_value).expanduser()
        output_dir=Path(output_dir_value).expanduser()
        if platform=="wsl" and not input_dir.is_dir():
            raise ValueError("wsl_comfy_input_dir_unavailable")
        if platform=="wsl" and not output_dir.is_dir():
            raise ValueError("wsl_comfy_output_dir_unavailable")
        return cls(
            api_base_url=worker_api,
            platform=platform,
            role=role_value,  # type: ignore[arg-type]
            channel_id=os.environ.get("SLOPTOGETHER_CHANNEL_ID") or worker.get("channel_id"),
            comfy_url=local_comfy,
            comfy_input_dir=input_dir,
            comfy_output_dir=output_dir,
            state_dir=root,
            poll_interval_seconds=_positive_int(worker.get("poll_interval_seconds", 5), "poll_interval_seconds", 1, 60),
            heartbeat_interval_seconds=_positive_int(worker.get("heartbeat_interval_seconds", 30), "heartbeat_interval_seconds", 5, 60),
            request_timeout_seconds=_positive_int(worker.get("request_timeout_seconds", 30), "request_timeout_seconds", 3, 120),
            max_output_bytes=_positive_int(worker.get("max_output_bytes", 128 * 1024 * 1024), "max_output_bytes", 1_048_576, 512 * 1024 * 1024),
            comfy_profile_api_token=os.environ.get("SLOPTOGETHER_COMFY_BEARER"),
            allowed_upload_hosts=hosts,
            worker_key=read_worker_secret(worker, default_path=root / "worker.key", role=str(role_value)),
            local_s3_endpoint=local_s3_endpoint,
            trim_vsa_budget_policy=trim_vsa_budget_policy,
        )
