from __future__ import annotations

import os
import re
import sys
from typing import Protocol
from urllib.parse import urlsplit


class SecretStore(Protocol):
    def set(self, name: str, value: str, environment_name: str | None = None, default_exposed: bool | None = None) -> None: ...


ROLE_SECRETS = (
    "SLOPTOGETHER_WORKER_KEY_GENERATION",
    "SLOPTOGETHER_WORKER_KEY_UPSCALE",
)
APP_SECRETS = (
    "SLOPTOGETHER_API_BASE_URL",
    "SLOPTOGETHER_ALLOWED_UPLOAD_HOSTS",
)


def set_worker_secrets(client: SecretStore, values: dict[str, str]) -> None:
    supplied: dict[str, str] = {}
    for name in ROLE_SECRETS:
        value = values.get(name, "")
        if len(value) < 32 or len(value) > 512 or any(character.isspace() for character in value):
            raise ValueError(f"fal_worker_secret_invalid:{name}")
        supplied[name] = value
    api_url=values.get("SLOPTOGETHER_API_BASE_URL", "").strip()
    parsed=urlsplit(api_url)
    if parsed.scheme!="https" or not parsed.hostname or parsed.path.rstrip("/")!="/sloptogether/api/v1" or parsed.username or parsed.password or parsed.query or parsed.fragment:
        raise ValueError("fal_worker_api_url_invalid")
    supplied["SLOPTOGETHER_API_BASE_URL"]=api_url.rstrip("/")
    hosts=values.get("SLOPTOGETHER_ALLOWED_UPLOAD_HOSTS", "").split(",")
    normalized=tuple(host.strip() for host in hosts if host.strip())
    if not normalized or any(not re.fullmatch(r"[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?",host) or ".." in host for host in normalized):
        raise ValueError("fal_worker_upload_hosts_invalid")
    supplied["SLOPTOGETHER_ALLOWED_UPLOAD_HOSTS"]=",".join(dict.fromkeys(normalized))
    for name, value in supplied.items():
        client.set(name, value, default_exposed=False)


def main() -> int:
    try:
        from fal.api import SyncServerlessClient
    except ImportError:
        print("run_this_helper_with_the_python_environment_used_by_fal", file=sys.stderr)
        return 2
    try:
        set_worker_secrets(SyncServerlessClient(), os.environ)
    except Exception as error:
        print(f"fal_worker_secret_setup_failed: {type(error).__name__}", file=sys.stderr)
        return 1
    print("Stored generation and upscale worker credentials with default exposure disabled.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
