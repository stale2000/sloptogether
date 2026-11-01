#!/usr/bin/env python3
"""Supervise one owner story producer without keeping credentials in service files."""
from __future__ import annotations

import argparse
import hashlib
import os
import plistlib
import re
import stat
import subprocess
import sys
import tomllib
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
MODULE_ROOT = ROOT / "workers/runtime/src"
SCRIPT = Path(__file__).resolve()


def private_file(path: Path, label: str) -> None:
    try:
        info = path.lstat()
    except OSError:
        raise ValueError(f"{label} is missing or inaccessible") from None
    if (not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid()
            or stat.S_IMODE(info.st_mode) & 0o077):
        raise ValueError(f"{label} must be a regular file owned by this user with mode 0600")


def validate_config(path: Path) -> tuple[str, str]:
    if not path.is_absolute() or path.is_symlink() or not path.is_file():
        raise ValueError("config must be an absolute path to a regular file")
    worker = tomllib.loads(path.read_text(encoding="utf-8")).get("worker")
    if not isinstance(worker, dict):
        raise ValueError("config requires a worker section")
    channel, stream = worker.get("channel_id"), worker.get("stream_slug", "main")
    if not isinstance(channel, str) or not re.fullmatch(r"[A-Za-z0-9_]{1,32}", channel):
        raise ValueError("config requires a channel ID or Twitch login")
    if not isinstance(stream, str) or not re.fullmatch(r"[a-z0-9][a-z0-9-]{0,47}", stream):
        raise ValueError("config requires a valid stream slug")
    key_setting = worker.get("credential_file")
    state_setting = worker.get("state_dir", "~/.sloptogether")
    if key_setting is None and isinstance(state_setting, str):
        key_setting = str(Path(state_setting).expanduser() / "worker.key")
    if not isinstance(key_setting, str):
        raise ValueError("credential_file must be a private absolute path")
    key_path = Path(key_setting).expanduser()
    if not key_path.is_absolute():
        raise ValueError("credential_file must be a private absolute path")
    private_file(key_path, "worker key")
    return channel, stream


def instance_name(config: Path) -> str:
    return hashlib.sha256(os.fsencode(str(config))).hexdigest()[:16]


def paths(config: Path, platform: str, home: Path) -> tuple[str, Path]:
    instance = instance_name(config)
    if platform == "darwin":
        label = f"com.clipsgg.sloptogether.story-producer.{instance}"
        return label, home / "Library/LaunchAgents" / f"{label}.plist"
    if platform == "linux":
        label = f"sloptogether-story-producer-{instance}.service"
        return label, home / ".config/systemd/user" / label
    raise ValueError("service installation requires macOS or Linux")


def command(config: Path, python: Path) -> list[str]:
    return [str(python), str(SCRIPT), "run", "--config", str(config)]


def render(config: Path, python: Path, platform: str, home: Path) -> bytes:
    label, _ = paths(config, platform, home)
    args = command(config, python)
    if platform == "darwin":
        logs = home / "Library/Logs/SlopTogether"
        value = {"Label": label, "ProgramArguments": args, "WorkingDirectory": str(ROOT),
                 "RunAtLoad": True, "KeepAlive": True, "ThrottleInterval": 10,
                 "StandardOutPath": str(logs / f"story-producer-{instance_name(config)}.log"),
                 "StandardErrorPath": str(logs / f"story-producer-{instance_name(config)}-error.log")}
        return plistlib.dumps(value, fmt=plistlib.FMT_XML, sort_keys=True)
    def quote(value: str) -> str:
        if any(ord(c) < 32 or ord(c) == 127 for c in value):
            raise ValueError("service paths cannot contain control characters")
        return '"' + value.replace('\\', '\\\\').replace('"', '\\"').replace('%', '%%').replace('$', '$$') + '"'
    content = ("[Unit]\nDescription=SlopTogether story producer\nAfter=network-online.target\n"
               "Wants=network-online.target\nStartLimitIntervalSec=0\n\n[Service]\nType=simple\n"
               f"WorkingDirectory={quote(str(ROOT))}\nExecStart={' '.join(map(quote, args))}\n"
               "Restart=always\nRestartSec=10\nTimeoutStopSec=30\nNoNewPrivileges=yes\nUMask=0077\n\n"
               "[Install]\nWantedBy=default.target\n")
    return content.encode("utf-8")


def run(config: Path) -> None:
    validate_config(config)
    # Do not leak provider keys or inherit a broad worker key: this service is
    # configured to use only its private scoped credential and free templates.
    environment = {name: os.environ[name] for name in ("HOME", "PATH", "LANG", "TMPDIR") if name in os.environ}
    environment["PYTHONPATH"] = str(MODULE_ROOT)
    environment["OPENAI_API_KEY"] = ""
    os.chdir(ROOT)
    os.execve(sys.executable, [sys.executable, "-m", "sloptogether_worker", "--config", str(config),
                               "--role", "story-producer", "run", "--headless"], environment)


def control(action: str, config: Path, platform: str, home: Path) -> None:
    label, target = paths(config, platform, home)
    if action == "install":
        validate_config(config)
        python = Path(sys.executable).resolve()
        if sys.version_info[:2] != (3, 12):
            raise ValueError("Python 3.12 is required")
        if target.exists() or target.is_symlink():
            raise ValueError("service already exists; uninstall it before reinstalling")
        target.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
        if platform == "darwin":
            (home / "Library/Logs/SlopTogether").mkdir(mode=0o700, parents=True, exist_ok=True)
        data = render(config, python, platform, home)
        # Exclusive create refuses to overwrite any existing service.
        fd = os.open(target, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(fd, "wb") as output:
            output.write(data)
        if platform == "darwin":
            subprocess.run(["launchctl", "bootstrap", f"gui/{os.getuid()}", str(target)], check=True)
        else:
            subprocess.run(["systemctl", "--user", "daemon-reload"], check=True)
            subprocess.run(["systemctl", "--user", "enable", "--now", label], check=True)
        print(f"Story producer started for {config.name}.")
        return
    if not target.is_file() or target.is_symlink():
        raise ValueError("service is not installed")
    if action == "status":
        args = (["launchctl", "list", label] if platform == "darwin" else
                ["systemctl", "--user", "status", label, "--no-pager"])
        subprocess.run(args, check=True)
        return
    if action == "uninstall":
        args = (["launchctl", "bootout", f"gui/{os.getuid()}", str(target)] if platform == "darwin" else
                ["systemctl", "--user", "disable", "--now", label])
        subprocess.run(args, check=True)
        target.unlink()
        if platform == "linux":
            subprocess.run(["systemctl", "--user", "daemon-reload"], check=True)
        print("Story producer stopped and removed; config and credentials were kept.")
        return
    raise ValueError("unsupported service action")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=("install", "status", "uninstall", "render", "run"))
    parser.add_argument("--config", type=Path, required=True)
    args = parser.parse_args()
    try:
        config = args.config.expanduser().absolute()
        if args.action == "run":
            run(config)
        platform = "darwin" if sys.platform == "darwin" else "linux" if sys.platform.startswith("linux") else "unsupported"
        if args.action == "render":
            validate_config(config)
            sys.stdout.buffer.write(render(config, Path(sys.executable).resolve(), platform, Path.home()))
        else:
            control(args.action, config, platform, Path.home())
        return 0
    except ValueError as error:
        print(f"story_producer_service_error: {error}", file=sys.stderr)
        return 1
    except (OSError, subprocess.CalledProcessError) as error:
        print(f"story_producer_service_error: {type(error).__name__}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
