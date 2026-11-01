from __future__ import annotations

import argparse
import logging
import os
import signal
import sys
import time
import uuid
import webbrowser
from pathlib import Path

from .client import WorkerApi
from .config import WorkerConfig, load_config
from .credential_store import save_secret
from .errors import ApiError, WorkerError
from .service import WorkerService

def parser() -> argparse.ArgumentParser:
    cli = argparse.ArgumentParser(
        prog="sloptogether-worker",
        description="Join a Twitch channel and run a bounded SlopTogether GPU worker.",
    )
    cli.add_argument("--config", type=Path, help="Path to nonsecret worker settings in TOML")
    cli.add_argument("--role", choices=("generation", "upscale", "story-producer"), help="Worker role")
    cli.add_argument("--platform", choices=("windows", "wsl", "linux"), help="Execution client platform; use wsl for a Linux ComfyUI in WSL2")
    commands = cli.add_subparsers(dest="command")
    commands.add_parser("check", help="Check the local ComfyUI node/GPU capability")
    commands.add_parser("pair", help="Pair this installation with Twitch in a browser")
    run = commands.add_parser("run", help="Poll the service and run eligible jobs")
    run.add_argument("--once", action="store_true", help="Claim and process at most one eligible item")
    run.add_argument("--headless", action="store_true", help="Never launch a browser for missing credentials")
    return cli


def _device_id(state_dir: Path) -> str:
    state_dir.mkdir(mode=0o700, parents=True, exist_ok=True)
    path = state_dir / "device-id"
    if path.exists():
        value = path.read_text(encoding="ascii").strip()
        try:
            return str(uuid.UUID(value))
        except ValueError:
            raise WorkerError("device_identity_invalid", "Local worker device identity needs reset.") from None
    value = str(uuid.uuid4())
    descriptor = os.open(path, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
    with os.fdopen(descriptor, "w", encoding="ascii") as output:
        output.write(value + "\n")
    return value


def _pair(config: WorkerConfig, api: WorkerApi, *, open_browser: bool, config_path: Path | None = None) -> None:
    if config.platform not in {"windows", "wsl", "linux"}:
        raise WorkerError("pairing_platform_unsupported", "Headless fal workers must use an issued channel worker key.")
    if config.role == "story-producer":
        raise WorkerError("story_producer_key_required", "Story producer access must use a broadcaster-issued scoped key.")
    scoped_key = f"SLOPTOGETHER_WORKER_KEY_{config.role.upper()}"
    if os.environ.get("SLOPTOGETHER_WORKER_KEY") or scoped_key in os.environ or load_config(config_path).get("credential_file"):
        raise WorkerError("pairing_credential_override", "Remove the credential file or worker-key environment override before pairing.")
    instructions = api.create_pairing({
        "installationId": _device_id(config.state_dir),
        "displayName": {"windows":"Windows GPU worker","wsl":"Windows WSL2 GPU worker","linux":"Linux GPU worker"}.get(config.platform,"fal GPU worker"),
        "platform": config.platform,
        "roles": [config.role],
        "clientVersion": "0.1.0",
    })
    if open_browser:
        webbrowser.open(instructions.verification_uri)
    print("Connect this worker while signed into the authorized Twitch account.")
    print(f"Open {instructions.verification_uri} and enter {instructions.user_code}.")
    deadline = min(time.time() + 10 * 60, _parse_expiry(instructions.expires_at))
    while time.time() < deadline:
        token = api.poll_pairing(instructions)
        if token:
            save_secret(config.state_dir / "worker.key", token)
            api.token = token
            print("Worker paired. Its credential is stored for this operating-system user.")
            return
        time.sleep(3)
    raise WorkerError("pairing_expired", "Twitch pairing expired. Start a new worker connection.")


def _parse_expiry(value: str) -> float:
    from datetime import datetime

    return datetime.fromisoformat(value.replace("Z", "+00:00")).timestamp()


def main() -> int:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    args = parser().parse_args()
    command = args.command or "run"
    try:
        config = WorkerConfig.from_sources(config_path=args.config, role_override=args.role, platform_override=getattr(args,"platform",None))
        api = WorkerApi(config)
        if command == "pair":
            WorkerService(config, api=api).check()
            _pair(config, api, open_browser=True, config_path=args.config)
            return 0
        if command == "check":
            profiles = WorkerService(config, api=api).check()
            print("Available local profiles: " + ", ".join(profiles))
            return 0
        if command != "run":
            raise WorkerError("command_unsupported", "Worker command is not supported.")
        service = WorkerService(config, api=api)
        if not api.token:
            if config.role == "story-producer":
                raise WorkerError("story_producer_key_required", "Set a broadcaster-issued story producer key before starting this role.")
            if getattr(args, "headless", False):
                raise WorkerError("worker_key_required", "Set a paired worker key for headless execution.")
            service.check()
            _pair(config, api, open_browser=True, config_path=args.config)
        def stop_handler(_signum: int, _frame: object) -> None:
            service.stop.set()

        for signal_name in ("SIGINT", "SIGTERM"):
            signal_value = getattr(signal, signal_name, None)
            if signal_value is not None:
                signal.signal(signal_value, stop_handler)
        return service.run(once=getattr(args, "once", False))
    except ApiError as error:
        print(f"{error.code}: {error.message}", file=sys.stderr)
        return 2
    except WorkerError as error:
        print(f"{error.code}: {error.message}", file=sys.stderr)
        return 2
    except (OSError, ValueError) as error:
        print(f"worker_configuration_error: {type(error).__name__}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
