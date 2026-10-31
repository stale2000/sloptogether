"""Small Twitch-styled Windows UI for the SlopTogether GPU worker."""

from __future__ import annotations

import ipaddress
import json
import os
import queue
import re
import subprocess
import sys
import tempfile
import threading
import time
import tomllib
import urllib.error
import urllib.request
import webbrowser
from pathlib import Path
from typing import Callable
from urllib.parse import urlsplit

from .client import WorkerApi
from .config import WorkerConfig
from .errors import WorkerError


PURPLE = "#9147ff"
BG = "#0e0e10"
PANEL = "#18181b"
PANEL_HI = "#252529"
TEXT = "#efeff1"
MUTED = "#adadb8"


def parse_channel_target(value: str, default_stream: str = "main") -> tuple[str, str]:
    parsed = urlsplit(value.strip())
    if (parsed.scheme != "https" or parsed.hostname not in {"clips.gg", "www.clips.gg"}
            or parsed.username or parsed.password or parsed.query or parsed.fragment):
        raise ValueError("Paste a clips.gg channel or stream link.")
    parts = [part for part in parsed.path.split("/") if part]
    if parts and parts[0] == "sloptogether":
        parts = parts[1:]
    if len(parts) < 2 or parts[0] != "channels" or not re.fullmatch(r"[A-Za-z0-9_]{1,25}", parts[1]):
        raise ValueError("Use a link like clips.gg/sloptogether/channels/name/streams/main/output.")
    locator = parts[1]
    stream = default_stream
    if len(parts) >= 4 and parts[2] == "streams":
        stream = parts[3]
    if not re.fullmatch(r"[a-z0-9][a-z0-9-]{0,47}", stream):
        raise ValueError("Stream link has an invalid stream name.")
    return locator, stream


def resolve_channel_target(config_path: Path, role: str, value: str) -> dict[str, object]:
    worker_config = WorkerConfig.from_sources(config_path=config_path, role_override=role)
    locator, stream_slug = parse_channel_target(value, worker_config.stream_slug)
    api = WorkerApi(worker_config)
    paired = api.exchange_session(role)
    channel = api.public_channel(locator)
    channel_id = channel.get("twitchChannelId")
    if not isinstance(channel_id, str) or channel_id != paired.get("channelId"):
        raise ValueError("This Twitch worker is paired to a different channel. Connect it to this channel first.")
    stats = api.worker_stats(role, stream_slug)
    normalized_url = f"https://www.clips.gg/sloptogether/channels/{channel.get('twitchLogin', locator)}/streams/{stream_slug}/output"
    return {"twitchChannelId": channel_id, "twitchLogin": channel.get("twitchLogin", locator),
            "displayName": channel.get("displayName", locator), "streamSlug": stream_slug,
            "url": normalized_url, "availableJobs": stats.get("availableJobs", 0),
            "completedJobs": stats.get("completedJobs", 0),
            "autoApprovedOwnerOutput": bool(stats.get("autoApprovedOwnerOutput"))}


def refresh_channel_stats(config_path: Path, role: str, target: dict[str, object]) -> dict[str, object]:
    worker_config = WorkerConfig.from_sources(config_path=config_path, role_override=role)
    api = WorkerApi(worker_config)
    paired = api.exchange_session(role)
    if paired.get("channelId") != target.get("twitchChannelId"):
        raise ValueError("Worker is paired to another channel. Select the channel again after Twitch pairing.")
    stats = api.worker_stats(role, str(target.get("streamSlug", "main")))
    if stats.get("channel", {}).get("twitchChannelId") != target.get("twitchChannelId"):
        raise ValueError("Selected channel does not match this worker key.")
    return stats


def _read_local_json(path: Path) -> dict[str, object]:
    try:
        if path.is_symlink() or path.stat().st_size > 16_384:
            return {}
        value = json.loads(path.read_text(encoding="utf-8"))
        return value if isinstance(value, dict) else {}
    except (OSError, json.JSONDecodeError):
        return {}


def _write_local_json(path: Path, value: dict[str, object]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    if path.is_symlink():
        raise ValueError("worker state path must not be a symbolic link")
    descriptor, temporary_name = tempfile.mkstemp(prefix=f".{path.name}-", dir=path.parent)
    temporary = Path(temporary_name)
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8") as output:
            output.write(json.dumps(value, separators=(",", ":")) + "\n")
        os.replace(temporary, path)
    finally:
        temporary.unlink(missing_ok=True)


def _comfy_health_url(config_path: Path) -> str:
    worker = tomllib.loads(config_path.read_text(encoding="utf-8"))["worker"]
    if not isinstance(worker, dict):
        raise ValueError("invalid worker configuration")
    value = os.environ.get("SLOPTOGETHER_COMFY_URL", worker.get("comfy_url", "http://127.0.0.1:8188"))
    if not isinstance(value, str):
        raise ValueError("invalid ComfyUI address")
    parsed = urlsplit(value)
    host = parsed.hostname or ""
    try:
        loopback = host.lower() == "localhost" or ipaddress.ip_address(host).is_loopback
    except ValueError:
        loopback = host.lower() == "localhost"
    if (parsed.scheme != "http" or not loopback or parsed.username or parsed.password
            or parsed.path not in {"", "/"} or parsed.query or parsed.fragment):
        raise ValueError("ComfyUI must use a loopback HTTP address")
    return value.rstrip("/") + "/system_stats"


def _probe_comfy(endpoint: str) -> bool:
    try:
        with urllib.request.urlopen(endpoint, timeout=2) as response:
            return 200 <= response.status < 300
    except (OSError, urllib.error.URLError, TimeoutError):
        return False


def wait_for_comfy(
    endpoint: str,
    *,
    timeout: float = 180,
    probe: Callable[[str], bool] = _probe_comfy,
    sleep: Callable[[float], None] = time.sleep,
    monotonic: Callable[[], float] = time.monotonic,
) -> bool:
    """Wait for the local ComfyUI API, not just an open TCP port."""
    deadline = monotonic() + timeout
    while monotonic() < deadline:
        if probe(endpoint):
            return True
        sleep(min(2, max(0, deadline - monotonic())))
    return False


def ensure_comfy_ready(
    root: Path,
    role: str,
    config_path: Path,
    start_comfy: Callable[[Path, str], int],
    *,
    wait: Callable[[str], bool] = wait_for_comfy,
    on_wait: Callable[[], None] = lambda: None,
) -> tuple[bool, str]:
    """Start or reuse local ComfyUI and require its API before worker launch."""
    if start_comfy(root, role) != 0:
        return False, "ComfyUI did not start; worker was not started."
    endpoint = _comfy_health_url(config_path)
    on_wait()
    if not wait(endpoint):
        return False, "ComfyUI did not become ready within 3 minutes; worker was not started."
    return True, "ComfyUI is ready. Starting worker…"


def run_desktop(root: Path, helpers: dict[str, Callable[..., int]]) -> int:
    """Open the worker control window. Tk is part of the supported Windows runtime."""
    import tkinter as tk
    from tkinter import ttk

    class WorkerWindow:
        def __init__(self) -> None:
            self.root = tk.Tk()
            self.root.title("SlopTogether Worker")
            self.root.geometry("1040x760")
            self.root.minsize(900, 660)
            self.root.configure(bg=BG)
            self.role = tk.StringVar(value="generation")
            self.status = tk.StringVar(value="Offline")
            self.queue: queue.Queue[tuple[str, object]] = queue.Queue()
            self.process: subprocess.Popen[str] | None = None
            self.busy = False
            self.target = _read_local_json(root / "worker.target.json")
            self.setup_state = _read_local_json(root / "worker.setup-state.json")
            self.stats_refresh_pending = False
            self._styles(ttk)
            self._build(tk, ttk)
            self.root.after(150, self._drain_queue)
            self.root.after(2000, self._refresh_stats)
            self.root.after(15000, self._schedule_stats_refresh)
            self.root.protocol("WM_DELETE_WINDOW", self._close)
            self._refresh_role()

        def _styles(self, ttk: object) -> None:
            style = ttk.Style(self.root)
            style.theme_use("clam")
            style.configure("TFrame", background=BG)
            style.configure("Panel.TFrame", background=PANEL)
            style.configure("TLabel", background=BG, foreground=TEXT, font=("Segoe UI", 10))
            style.configure("Panel.TLabel", background=PANEL, foreground=TEXT, font=("Segoe UI", 10))
            style.configure("Muted.TLabel", background=BG, foreground=MUTED, font=("Segoe UI", 9))
            style.configure("PanelMuted.TLabel", background=PANEL, foreground=MUTED, font=("Segoe UI", 9))
            style.configure("Title.TLabel", background=BG, foreground=TEXT, font=("Segoe UI Semibold", 20))
            style.configure("Section.TLabel", background=PANEL, foreground=TEXT, font=("Segoe UI Semibold", 12))
            style.configure("Accent.TButton", background=PURPLE, foreground="white", padding=(14, 9),
                            borderwidth=0, font=("Segoe UI Semibold", 10))
            style.map("Accent.TButton", background=[("active", "#772ce8"), ("disabled", "#393044")])
            style.configure("Worker.TButton", background=PANEL_HI, foreground=TEXT, padding=(12, 8),
                            borderwidth=0, font=("Segoe UI", 10))
            style.map("Worker.TButton", background=[("active", "#34343a"), ("disabled", "#222226")])
            style.configure("Ready.TButton", background="#16833b", foreground="white", padding=(12, 8),
                            borderwidth=0, font=("Segoe UI Semibold", 10))
            style.map("Ready.TButton", background=[("active", "#126b30"), ("disabled", "#344b3a")])
            style.configure("Needed.TButton", background="#b42318", foreground="white", padding=(12, 8),
                            borderwidth=0, font=("Segoe UI Semibold", 10))
            style.map("Needed.TButton", background=[("active", "#912018"), ("disabled", "#553432")])
            style.configure("Ready.TCheckbutton", background=PANEL, foreground="#72d591", padding=(4, 6),
                            font=("Segoe UI Semibold", 10))
            style.configure("Needed.TCheckbutton", background=PANEL, foreground="#ff938b", padding=(4, 6),
                            font=("Segoe UI Semibold", 10))
            style.configure("Role.TRadiobutton", background=PANEL, foreground=TEXT, padding=(10, 8),
                            font=("Segoe UI Semibold", 10))
            style.map("Role.TRadiobutton", background=[("selected", "#34234f")],
                      foreground=[("selected", "white")])

        def _build(self, tk: object, ttk: object) -> None:
            outer = ttk.Frame(self.root, padding=(24, 20))
            outer.pack(fill="both", expand=True)
            header = ttk.Frame(outer)
            header.pack(fill="x", pady=(0, 18))
            ttk.Label(header, text="SLOPTOGETHER", font=("Segoe UI Semibold", 11), foreground=PURPLE).pack(anchor="w")
            ttk.Label(header, text="GPU WORKER", style="Muted.TLabel").pack(anchor="w", pady=(2, 7))
            ttk.Label(header, text="Worker control", style="Title.TLabel").pack(anchor="w")

            channel_panel = ttk.Frame(outer, style="Panel.TFrame", padding=14)
            channel_panel.pack(fill="x", pady=(0, 16))
            ttk.Label(channel_panel, text="CHANNEL / STREAM", style="PanelMuted.TLabel").grid(row=0, column=0, columnspan=3, sticky="w", pady=(0, 6))
            self.channel_url = tk.StringVar(value=str(self.target.get("url", "")))
            self.channel_entry = ttk.Entry(channel_panel, textvariable=self.channel_url, font=("Segoe UI", 10))
            self.channel_entry.grid(row=1, column=0, sticky="ew", padx=(0, 8))
            ttk.Button(channel_panel, text="Use channel", style="Accent.TButton",
                       command=self._select_channel).grid(row=1, column=1, padx=(0, 6))
            ttk.Button(channel_panel, text="Open", style="Worker.TButton",
                       command=self._open_channel).grid(row=1, column=2)
            self.channel_summary = ttk.Label(channel_panel, text="No channel selected", style="PanelMuted.TLabel")
            self.channel_summary.grid(row=2, column=0, columnspan=3, sticky="w", pady=(7, 0))
            channel_panel.columnconfigure(0, weight=1)

            body = ttk.Frame(outer)
            body.pack(fill="both", expand=True)
            sidebar = ttk.Frame(body, style="Panel.TFrame", padding=16)
            sidebar.pack(side="left", fill="y", padx=(0, 14))
            ttk.Label(sidebar, text="WORKER", style="PanelMuted.TLabel").pack(anchor="w", pady=(2, 8))
            ttk.Radiobutton(sidebar, text="Generation", value="generation", variable=self.role,
                            style="Role.TRadiobutton", command=self._refresh_role).pack(fill="x", pady=2)
            ttk.Radiobutton(sidebar, text="Upscale", value="upscale", variable=self.role,
                            style="Role.TRadiobutton", command=self._refresh_role).pack(fill="x", pady=2)
            ttk.Separator(sidebar).pack(fill="x", pady=14)
            self.status_label = ttk.Label(sidebar, textvariable=self.status, style="Panel.TLabel")
            self.status_label.pack(anchor="w", pady=(0, 12))
            self.connect_button = ttk.Button(sidebar, text="Connect Twitch", style="Accent.TButton",
                                             command=lambda: self._run_cli_action("pair"))
            self.connect_button.pack(fill="x", pady=4)
            self.start_button = ttk.Button(sidebar, text="Start worker", style="Accent.TButton",
                                           command=self._start_worker)
            self.start_button.pack(fill="x", pady=4)
            self.stop_button = ttk.Button(sidebar, text="Stop worker", style="Worker.TButton",
                                          command=self._stop_worker, state="disabled")
            self.stop_button.pack(fill="x", pady=4)
            ttk.Button(sidebar, text="Check worker", style="Worker.TButton",
                       command=lambda: self._run_cli_action("check")).pack(fill="x", pady=4)
            ttk.Button(sidebar, text="Start ComfyUI", style="Worker.TButton",
                       command=self._start_comfy).pack(fill="x", pady=4)

            main = ttk.Frame(body)
            main.pack(side="left", fill="both", expand=True)
            self.role_title = ttk.Label(main, text="Generation", style="Section.TLabel")
            self.role_title.pack(anchor="w", pady=(0, 8))
            card = ttk.Frame(main, style="Panel.TFrame", padding=16)
            card.pack(fill="x", pady=(0, 14))
            card_header = ttk.Frame(card, style="Panel.TFrame")
            card_header.pack(fill="x")
            ttk.Label(card_header, text="QUEUE", style="PanelMuted.TLabel").pack(side="left")
            ttk.Button(card_header, text="Refresh", style="Worker.TButton", command=self._refresh_stats).pack(side="right")
            counters = ttk.Frame(card, style="Panel.TFrame")
            counters.pack(fill="x", pady=(10, 0))
            available = ttk.Frame(counters, style="Panel.TFrame")
            available.pack(side="left", fill="x", expand=True)
            completed = ttk.Frame(counters, style="Panel.TFrame")
            completed.pack(side="left", fill="x", expand=True)
            self.available_count = tk.StringVar(value="—")
            self.completed_count = tk.StringVar(value="—")
            ttk.Label(available, textvariable=self.available_count, style="Section.TLabel", font=("Segoe UI Semibold", 24)).pack(anchor="w")
            ttk.Label(available, text="available jobs", style="PanelMuted.TLabel").pack(anchor="w")
            ttk.Label(completed, textvariable=self.completed_count, style="Section.TLabel", font=("Segoe UI Semibold", 24)).pack(anchor="w")
            ttk.Label(completed, text="completed by this worker", style="PanelMuted.TLabel").pack(anchor="w")
            self.approval_summary = ttk.Label(card, text="", style="PanelMuted.TLabel")
            self.approval_summary.pack(anchor="w", pady=(8, 0))

            tools = ttk.Frame(main, style="Panel.TFrame", padding=14)
            tools.pack(fill="x", pady=(0, 14))
            ttk.Label(tools, text="SETUP", style="PanelMuted.TLabel").grid(row=0, column=0, columnspan=2, sticky="w", pady=(0, 8))
            self.install_check = tk.BooleanVar(value=False)
            self.models_check = tk.BooleanVar(value=False)
            self.install_check_button = ttk.Checkbutton(tools, text="Needed", variable=self.install_check,
                                                        state="disabled", style="Needed.TCheckbutton")
            self.install_check_button.grid(row=1, column=0, sticky="w", padx=(0, 8), pady=3)
            self.install_button = ttk.Button(tools, text="Install everything", style="Needed.TButton",
                                             command=lambda: self._run_setup_action("installed", "Install everything", True))
            self.install_button.grid(row=1, column=1, sticky="ew", pady=3)
            self.models_check_button = ttk.Checkbutton(tools, text="Needed", variable=self.models_check,
                                                       state="disabled", style="Needed.TCheckbutton")
            self.models_check_button.grid(row=2, column=0, sticky="w", padx=(0, 8), pady=3)
            self.models_button = ttk.Button(tools, text="Download models", style="Needed.TButton",
                                            command=lambda: self._run_setup_action("models", "Download models", False))
            self.models_button.grid(row=2, column=1, sticky="ew", pady=3)
            tools.columnconfigure(1, weight=1)

            log_panel = ttk.Frame(main, style="Panel.TFrame", padding=14)
            log_panel.pack(fill="both", expand=True)
            ttk.Label(log_panel, text="ACTIVITY", style="PanelMuted.TLabel").pack(anchor="w", pady=(0, 8))
            self.log = tk.Text(log_panel, height=9, bg="#111114", fg=TEXT, insertbackground=TEXT,
                               relief="flat", wrap="word", font=("Consolas", 9), padx=10, pady=8,
                               state="disabled")
            self.log.pack(fill="both", expand=True)
            self._write("Worker ready. Choose a role, connect Twitch, and start the worker.")
            self._refresh_target_summary()
            self._refresh_setup_controls()

        @property
        def config_path(self) -> Path:
            return root / f"worker.{self.role.get()}.toml"

        def _refresh_role(self) -> None:
            role = self.role.get()
            self.role_title.configure(text="Generation" if role == "generation" else "Upscale")
            self._write(f"Selected {role} worker.")
            self._refresh_setup_controls()
            self._refresh_stats()

        def _write(self, text: str) -> None:
            self.log.configure(state="normal")
            self.log.insert("end", text.rstrip() + "\n")
            self.log.see("end")
            self.log.configure(state="disabled")

        def _command(self, action: str) -> list[str]:
            if getattr(sys, "frozen", False):
                cli = root / "SlopTogetherWorkerCli.exe"
                return [str(cli), "--config", str(self.config_path), "--role", self.role.get(), action]
            return [sys.executable, "-m", "sloptogether_worker.cli", "--config", str(self.config_path),
                    "--role", self.role.get(), action]

        @staticmethod
        def _worker_environment(target: dict[str, object]) -> dict[str, str]:
            environment = os.environ.copy()
            environment["SLOPTOGETHER_CHANNEL_ID"] = str(target["twitchChannelId"])
            environment["SLOPTOGETHER_STREAM_SLUG"] = str(target["streamSlug"])
            return environment

        def _run_cli_action(self, action: str) -> None:
            if self.busy or self.process is not None:
                return
            if not self.config_path.is_file():
                self._write("Run setup for this role first.")
                return
            self._launch(self._command(action), action.title())

        def _launch(self, command: list[str], label: str, *, environment: dict[str, str] | None = None) -> None:
            self.busy = True
            self.status.set(f"{label}…")
            self._set_controls()
            self._write(f"{label} started.")

            def execute() -> None:
                try:
                    flags = getattr(subprocess, "CREATE_NO_WINDOW", 0)
                    process = subprocess.Popen(command, cwd=root, stdout=subprocess.PIPE,
                                               stderr=subprocess.STDOUT, text=True, encoding="utf-8",
                                               errors="replace", bufsize=1, creationflags=flags, env=environment)
                    self.process = process
                    if process.stdout:
                        for line in process.stdout:
                            self.queue.put(("log", line.rstrip()))
                    status = process.wait()
                    self.queue.put(("done", f"{label} finished ({status})."))
                except OSError as error:
                    self.queue.put(("done", f"Could not start {label}: {type(error).__name__}."))

            threading.Thread(target=execute, daemon=True).start()

        def _start_worker(self) -> None:
            if self.busy or self.process is not None:
                return
            if not self.config_path.is_file():
                self._write("Run setup for this role first.")
                return
            config_path = self.config_path
            role = self.role.get()
            target_url = self.channel_url.get().strip()
            if not target_url:
                self._write("Choose a channel and stream before starting the worker.")
                return
            self.busy = True
            self.status.set("Checking channel…")
            self._set_controls()
            self._write("Checking channel authorization…")

            def execute() -> None:
                try:
                    target = resolve_channel_target(config_path, role, target_url)
                    self.queue.put(("target", target))
                    self.queue.put(("log", f"Using {target['displayName']} / {target['streamSlug']}."))
                    self.queue.put(("log", "Starting ComfyUI before the worker…"))
                    ready, message = ensure_comfy_ready(
                        root,
                        role,
                        config_path,
                        helpers["comfy"],
                        on_wait=lambda: self.queue.put(("log", "Waiting for the ComfyUI API…")),
                    )
                    if not ready:
                        self.queue.put(("done", message))
                        return
                    self.queue.put(("log", message))
                    flags = getattr(subprocess, "CREATE_NO_WINDOW", 0)
                    process = subprocess.Popen(self._command("run"), cwd=root, stdout=subprocess.PIPE,
                                               stderr=subprocess.STDOUT, text=True, encoding="utf-8",
                                               errors="replace", bufsize=1, creationflags=flags,
                                               env=self._worker_environment(target))
                    self.process = process
                    self.queue.put(("worker_started", "Worker is running."))
                    if process.stdout:
                        for line in process.stdout:
                            self.queue.put(("log", line.rstrip()))
                    status = process.wait()
                    self.queue.put(("done", f"Worker finished ({status})."))
                except Exception as error:
                    detail = error.message if isinstance(error, WorkerError) else type(error).__name__
                    self.queue.put(("done", f"Could not start worker: {detail}."))

            threading.Thread(target=execute, daemon=True).start()

        def _stop_worker(self) -> None:
            if self.process is None:
                self._write("No active worker process.")
                return
            self._write("Stopping worker…")
            try:
                self.process.terminate()
            except OSError:
                self._write("Could not stop worker process.")

        def _run_setup_action(self, stage: str, label: str, install_everything: bool) -> None:
            if self.busy or self.process is not None:
                return
            role = self.role.get()
            self.busy = True
            self.status.set(f"{label}…")
            self._set_controls()
            self._write(f"{label} started.")

            def execute() -> None:
                try:
                    if install_everything:
                        result = helpers["setup"](root, role, True)
                    else:
                        result = helpers["models"](root, role)
                except Exception as error:  # show a concise failure without exposing environment values
                    result = 1
                    self.queue.put(("setup_log", f"{label} failed: {type(error).__name__}."))
                self.queue.put(("setup_done", {"role": role, "stage": stage, "label": label, "status": result}))

            threading.Thread(target=execute, daemon=True).start()

        def _refresh_setup_controls(self) -> None:
            role_state = self.setup_state.get(self.role.get(), {})
            if not isinstance(role_state, dict):
                role_state = {}
            install_done = role_state.get("installed") is True
            models_done = role_state.get("models") is True
            self.install_check.set(install_done)
            self.install_check_button.configure(text="Ready" if install_done else "Needed",
                                                style="Ready.TCheckbutton" if install_done else "Needed.TCheckbutton")
            self.install_button.configure(style="Ready.TButton" if install_done else "Needed.TButton")
            self.models_check.set(models_done)
            self.models_check_button.configure(text="Ready" if models_done else "Needed",
                                               style="Ready.TCheckbutton" if models_done else "Needed.TCheckbutton")
            if self.role.get() == "upscale":
                self.models_check_button.configure(text="ComfyUI", style="Ready.TCheckbutton")
                self.models_button.configure(text="Generation models only", state="disabled", style="Worker.TButton")
            else:
                self.models_button.configure(text="Download models", state="normal",
                                             style="Ready.TButton" if models_done else "Needed.TButton")

        def _record_setup_done(self, result: dict[str, object]) -> None:
            role, stage = result.get("role"), result.get("stage")
            if result.get("status") == 0 and role in {"generation", "upscale"} and stage in {"installed", "models"}:
                state = dict(self.setup_state)
                role_state = state.get(str(role))
                if not isinstance(role_state, dict):
                    role_state = {}
                role_state = dict(role_state)
                role_state[str(stage)] = True
                state[str(role)] = role_state
                try:
                    _write_local_json(root / "worker.setup-state.json", state)
                except (OSError, ValueError):
                    self._write("Setup completed, but its local checkmark could not be saved.")
                self.setup_state = state
            label = str(result.get("label", "Setup"))
            status = int(result.get("status", 1))
            self._write(f"{label} {'completed' if status == 0 else 'needs attention'}.")
            self.busy = False
            self.status.set("Running" if self.process is not None else "Offline")
            self._set_controls()
            self._refresh_setup_controls()

        def _select_channel(self) -> None:
            if self.busy or self.process is not None:
                return
            if not self.config_path.is_file():
                self._write("Install everything before choosing a channel.")
                return
            role = self.role.get()
            config_path = self.config_path
            value = self.channel_url.get()
            self.busy = True
            self.status.set("Checking channel…")
            self._set_controls()
            self._write("Checking channel access and stream…")

            def execute() -> None:
                try:
                    target = resolve_channel_target(config_path, role, value)
                    _write_local_json(root / "worker.target.json", target)
                    self.queue.put(("target", target))
                    self.queue.put(("target_done", f"Selected {target['displayName']} / {target['streamSlug']}."))
                except Exception as error:
                    detail = error.message if isinstance(error, WorkerError) else type(error).__name__
                    self.queue.put(("target_error", f"Channel not selected: {detail}."))
                    self.queue.put(("target_done", "Channel check failed."))

            threading.Thread(target=execute, daemon=True).start()

        def _open_channel(self) -> None:
            value = self.channel_url.get().strip()
            try:
                parse_channel_target(value)
            except ValueError as error:
                self._write(str(error))
                return
            webbrowser.open(value)

        def _refresh_target_summary(self) -> None:
            if self.target.get("twitchChannelId"):
                self.channel_summary.configure(text=f"{self.target.get('displayName', self.target.get('twitchLogin', 'Channel'))} · {self.target.get('streamSlug', 'main')}")
                self.available_count.set(str(self.target.get("availableJobs", "—")))
                self.completed_count.set(str(self.target.get("completedJobs", "—")))
                if self.target.get("autoApprovedOwnerOutput") is True:
                    self.approval_summary.configure(text="Owner output auto-approved after safety checks.")
                else:
                    self.approval_summary.configure(text="Worker output waits for channel review.")
            else:
                self.channel_summary.configure(text="Paste a channel or stream link, then choose Use channel.")
                self.available_count.set("—")
                self.completed_count.set("—")
                self.approval_summary.configure(text="")

        def _refresh_stats(self) -> None:
            if self.stats_refresh_pending or self.busy or not self.target.get("twitchChannelId"):
                return
            if not self.config_path.is_file():
                return
            self.stats_refresh_pending = True
            role = self.role.get()
            config_path = self.config_path
            target = dict(self.target)

            def execute() -> None:
                try:
                    stats = refresh_channel_stats(config_path, role, target)
                    self.queue.put(("stats", stats))
                except Exception as error:
                    detail = error.message if isinstance(error, WorkerError) else type(error).__name__
                    self.queue.put(("stats_error", detail))

            threading.Thread(target=execute, daemon=True).start()

        def _schedule_stats_refresh(self) -> None:
            self._refresh_stats()
            self.root.after(15000, self._schedule_stats_refresh)

        def _start_comfy(self) -> None:
            if self.busy or self.process is not None:
                return
            if not self.config_path.is_file():
                self._write("Run setup for this role first.")
                return

            def execute() -> None:
                try:
                    status = helpers["comfy"](root, self.role.get())
                    self.queue.put(("done", f"Start ComfyUI finished ({status})."))
                except Exception as error:
                    self.queue.put(("done", f"Could not start ComfyUI: {type(error).__name__}."))

            self.busy = True
            self.status.set("Starting ComfyUI…")
            self._set_controls()
            self._write("Starting ComfyUI in WSL…")
            threading.Thread(target=execute, daemon=True).start()

        def _set_controls(self) -> None:
            state = "disabled" if self.busy else "normal"
            self.connect_button.configure(state=state)
            self.start_button.configure(state=state if self.process is None else "disabled")

        def _drain_queue(self) -> None:
            try:
                while True:
                    kind, message = self.queue.get_nowait()
                    if kind == "log":
                        self._write(str(message))
                    elif kind == "worker_started":
                        self._write(str(message))
                        self.busy = False
                        self.status.set("Running")
                        self.stop_button.configure(state="normal")
                        self._set_controls()
                    elif kind == "target":
                        self.target = dict(message)  # type: ignore[arg-type]
                        self.channel_url.set(str(self.target.get("url", "")))
                        self._refresh_target_summary()
                    elif kind == "stats":
                        self.stats_refresh_pending = False
                        stats = message if isinstance(message, dict) else {}
                        self.available_count.set(str(stats.get("availableJobs", "—")))
                        self.completed_count.set(str(stats.get("completedJobs", "—")))
                        if stats.get("autoApprovedOwnerOutput") is True:
                            self.approval_summary.configure(text="Owner output auto-approved after safety checks.")
                        else:
                            self.approval_summary.configure(text="Worker output waits for channel review.")
                    elif kind == "stats_error":
                        self.stats_refresh_pending = False
                        self._write(f"Queue refresh failed: {message}.")
                    elif kind == "setup_log":
                        self._write(str(message))
                    elif kind == "setup_done":
                        self._record_setup_done(message if isinstance(message, dict) else {})
                    elif kind == "target_error":
                        self._write(str(message))
                    elif kind == "target_done":
                        self._write(str(message))
                        self.busy = False
                        self.status.set("Running" if self.process is not None else "Offline")
                        self._set_controls()
                        self._refresh_stats()
                    else:
                        self._write(str(message))
                        self.busy = False
                        if self.process is not None and self.process.poll() is not None:
                            self.process = None
                        active = self.process is not None
                        self.status.set("Running" if active else "Offline")
                        self.stop_button.configure(state="normal" if active else "disabled")
                        self._set_controls()
            except queue.Empty:
                pass
            if self.process is not None and self.process.poll() is not None and not self.busy:
                self.process = None
                self.status.set("Offline")
                self.stop_button.configure(state="disabled")
                self._set_controls()
            self.root.after(150, self._drain_queue)

        def _close(self) -> None:
            if self.process is not None and self.process.poll() is None:
                try:
                    self.process.terminate()
                except OSError:
                    pass
            self.root.destroy()

        def show(self) -> int:
            self.root.mainloop()
            return 0

    return WorkerWindow().show()
