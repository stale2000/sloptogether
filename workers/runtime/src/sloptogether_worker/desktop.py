"""Small Twitch-styled Windows UI for the SlopTogether GPU worker."""

from __future__ import annotations

import ipaddress
import os
import queue
import subprocess
import sys
import threading
import time
import tomllib
import urllib.error
import urllib.request
from pathlib import Path
from typing import Callable
from urllib.parse import urlsplit


PURPLE = "#9147ff"
BG = "#0e0e10"
PANEL = "#18181b"
PANEL_HI = "#252529"
TEXT = "#efeff1"
MUTED = "#adadb8"


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
    from tkinter import simpledialog, ttk

    class WorkerWindow:
        def __init__(self) -> None:
            self.root = tk.Tk()
            self.root.title("SlopTogether Worker")
            self.root.geometry("900x620")
            self.root.minsize(760, 520)
            self.root.configure(bg=BG)
            self.role = tk.StringVar(value="generation")
            self.status = tk.StringVar(value="Offline")
            self.queue: queue.Queue[tuple[str, str]] = queue.Queue()
            self.process: subprocess.Popen[str] | None = None
            self.busy = False
            self._styles(ttk)
            self._build(tk, ttk)
            self.root.after(150, self._drain_queue)
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
            ttk.Label(card, text="QUEUE", style="PanelMuted.TLabel").pack(anchor="w")
            ttk.Label(card, text="Ready to work", style="Section.TLabel").pack(anchor="w", pady=(4, 2))
            ttk.Label(card, text="The worker checks SlopTogether for approved jobs.",
                      style="PanelMuted.TLabel").pack(anchor="w")

            tools = ttk.Frame(main, style="Panel.TFrame", padding=14)
            tools.pack(fill="x", pady=(0, 14))
            ttk.Label(tools, text="SETUP", style="PanelMuted.TLabel").grid(row=0, column=0, columnspan=2, sticky="w", pady=(0, 8))
            ttk.Button(tools, text="Install ComfyUI", style="Worker.TButton",
                       command=lambda: self._run_helper("Install ComfyUI", self._install_comfy)).grid(row=1, column=0, sticky="ew", padx=(0, 6), pady=3)
            ttk.Button(tools, text="Install nodes", style="Worker.TButton",
                       command=lambda: self._run_helper("Install nodes", self._install_nodes)).grid(row=1, column=1, sticky="ew", padx=(6, 0), pady=3)
            ttk.Button(tools, text="Download models", style="Worker.TButton",
                       command=lambda: self._run_helper("Download models", self._download_models)).grid(row=2, column=0, sticky="ew", padx=(0, 6), pady=3)
            ttk.Button(tools, text="Install dependencies", style="Worker.TButton",
                       command=self._install_dependencies).grid(row=2, column=1, sticky="ew", padx=(6, 0), pady=3)
            tools.columnconfigure(0, weight=1)
            tools.columnconfigure(1, weight=1)

            log_panel = ttk.Frame(main, style="Panel.TFrame", padding=14)
            log_panel.pack(fill="both", expand=True)
            ttk.Label(log_panel, text="ACTIVITY", style="PanelMuted.TLabel").pack(anchor="w", pady=(0, 8))
            self.log = tk.Text(log_panel, height=9, bg="#111114", fg=TEXT, insertbackground=TEXT,
                               relief="flat", wrap="word", font=("Consolas", 9), padx=10, pady=8,
                               state="disabled")
            self.log.pack(fill="both", expand=True)
            self._write("Worker ready. Choose a role, connect Twitch, and start the worker.")

        @property
        def config_path(self) -> Path:
            return root / f"worker.{self.role.get()}.toml"

        def _refresh_role(self) -> None:
            role = self.role.get()
            self.role_title.configure(text="Generation" if role == "generation" else "Upscale")
            self._write(f"Selected {role} worker.")

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

        def _run_cli_action(self, action: str) -> None:
            if self.busy or self.process is not None:
                return
            if not self.config_path.is_file():
                self._write("Run setup for this role first.")
                return
            self._launch(self._command(action), action.title())

        def _launch(self, command: list[str], label: str) -> None:
            self.busy = True
            self.status.set(f"{label}…")
            self._set_controls()
            self._write(f"{label} started.")

            def execute() -> None:
                try:
                    flags = getattr(subprocess, "CREATE_NO_WINDOW", 0)
                    process = subprocess.Popen(command, cwd=root, stdout=subprocess.PIPE,
                                               stderr=subprocess.STDOUT, text=True, encoding="utf-8",
                                               errors="replace", bufsize=1, creationflags=flags)
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
            self.busy = True
            self.status.set("Starting ComfyUI…")
            self._set_controls()
            self._write("Starting ComfyUI before the worker…")

            def execute() -> None:
                try:
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
                                               errors="replace", bufsize=1, creationflags=flags)
                    self.process = process
                    self.queue.put(("worker_started", "Worker is running."))
                    if process.stdout:
                        for line in process.stdout:
                            self.queue.put(("log", line.rstrip()))
                    status = process.wait()
                    self.queue.put(("done", f"Worker finished ({status})."))
                except (OSError, KeyError, TypeError, ValueError, tomllib.TOMLDecodeError) as error:
                    self.queue.put(("done", f"Could not start worker: {type(error).__name__}."))

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

        def _run_helper(self, label: str, callback: Callable[[], int]) -> None:
            if self.busy or self.process is not None:
                return
            self.busy = True
            self.status.set(f"{label}…")
            self._set_controls()
            self._write(f"{label} started.")

            def execute() -> None:
                try:
                    result = callback()
                    message = f"{label} finished ({result})."
                except Exception as error:  # show a concise failure without exposing environment values
                    message = f"{label} failed: {type(error).__name__}."
                self.queue.put(("done", message))

            threading.Thread(target=execute, daemon=True).start()

        def _install_comfy(self) -> int:
            return helpers["setup"](root, self.role.get(), True)

        def _install_nodes(self) -> int:
            return helpers["setup"](root, self.role.get(), False)

        def _download_models(self) -> int:
            return helpers["models"](root, self.role.get())

        def _install_dependencies(self) -> None:
            if not self.config_path.is_file():
                self._write("Run setup for this role first.")
                return
            python_path = simpledialog.askstring(
                "ComfyUI Python",
                "WSL Python path inside the configured ComfyUI folder:",
                initialvalue="/home/USER/ComfyUI/.venv/bin/python",
                parent=self.root,
            )
            if python_path:
                role = self.role.get()
                self._run_helper("Install dependencies", lambda: helpers["dependencies"](root, role, python_path))

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
                        self._write(message)
                    elif kind == "worker_started":
                        self._write(message)
                        self.busy = False
                        self.status.set("Running")
                        self.stop_button.configure(state="normal")
                        self._set_controls()
                    else:
                        self._write(message)
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
