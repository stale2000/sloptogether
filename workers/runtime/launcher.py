"""Windows desktop launcher; explicit arguments retain the normal worker CLI."""

from __future__ import annotations

import os
import ipaddress
import re
import signal
import socket
import subprocess
import sys
import tempfile
import tomllib
from pathlib import Path
from typing import Callable
from urllib.parse import urlsplit

from sloptogether_worker.cli import main as worker_main


def _bundle_root() -> Path:
    return Path(sys.executable if getattr(sys, "frozen", False) else __file__).resolve().parent


def _run_cli(arguments: list[str]) -> int:
    original_argv = sys.argv
    previous_handlers = {number: signal.getsignal(number) for number in (signal.SIGINT, signal.SIGTERM)}
    sys.argv = [original_argv[0], *arguments]
    try:
        return worker_main()
    except KeyboardInterrupt:
        print("Stopped.")
        return 130
    finally:
        sys.argv = original_argv
        for number, handler in previous_handlers.items():
            signal.signal(number, handler)


def _run_setup(root: Path, role: str, install_comfy: bool) -> int:
    script = root / "Setup-SlopTogetherWorker.ps1"
    system_root = os.environ.get("SystemRoot")
    if not script.is_file() or not system_root:
        print("Setup script or Windows PowerShell is unavailable.")
        return 1
    powershell = Path(system_root) / "System32" / "WindowsPowerShell" / "v1.0" / "powershell.exe"
    if not powershell.is_file():
        print("Windows PowerShell is unavailable.")
        return 1
    arguments = [str(powershell), "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", str(script), "-Role", role]
    config_path = root / f"worker.{role}.toml"
    if config_path.exists():
        try:
            _config, distro, comfy_root = _wsl_location(root, role)
        except (KeyError, OSError, TypeError, ValueError, tomllib.TOMLDecodeError):
            print("Existing worker settings are not a valid WSL configuration; they were left unchanged.")
            return 1
        arguments.extend(["-Distro", distro, "-ComfyRoot", comfy_root])
    if install_comfy:
        print("Installing ComfyUI and dependencies. Generation model weights download automatically after setup.")
        arguments.append("-InstallComfyUI")
    else:
        arguments.append("-InstallNodes")
    try:
        status = subprocess.run(arguments, check=False).returncode
        if status == 0 and not install_comfy:
            print("Use option 10 to install dependencies into the Python environment used by this ComfyUI.")
        return status
    except OSError:
        print("Could not start setup.")
        return 1


def _wsl_location(root: Path, role: str) -> tuple[dict, str, str]:
    if role not in {"generation", "upscale"}:
        raise ValueError("invalid worker role")
    config = tomllib.loads((root / f"worker.{role}.toml").read_text(encoding="utf-8"))["worker"]
    if not isinstance(config, dict) or config.get("platform") != "wsl":
        raise ValueError("WSL configuration required")
    input_dir = os.environ.get("SLOPTOGETHER_COMFY_INPUT_DIR", config.get("comfy_input_dir", ""))
    if not isinstance(input_dir, str):
        raise ValueError("invalid input directory")
    match = re.fullmatch(
        r"\\\\(?:wsl\.localhost|wsl\$)\\([A-Za-z0-9._-]+)\\(home(?:\\[A-Za-z0-9._-]+)+)\\input",
        input_dir.replace("/", "\\"), re.IGNORECASE,
    )
    if not match or any(part in {".", ".."} for part in (match[1], *match[2].split("\\"))):
        raise ValueError("invalid WSL path")
    return config, match[1], "/" + match[2].replace("\\", "/")


def _validate_comfy_python(comfy_root: str, value: str) -> str:
    if (not isinstance(value, str) or not value.startswith(comfy_root + "/")
            or not re.fullmatch(r"/[A-Za-z0-9._/-]+", value)
            or any(part in {"", ".", ".."} for part in value[1:].split("/"))):
        raise ValueError("ComfyUI Python must be an absolute path under its WSL root")
    return value


def _comfy_python(root: Path, role: str, comfy_root: str) -> str:
    choice = root / f"worker.{role}.comfy-python"
    if choice.exists():
        if choice.stat().st_size > 2048:
            raise ValueError("ComfyUI Python path is too long")
        value = choice.read_text(encoding="utf-8").strip()
    else:
        value = f"{comfy_root}/.venv/bin/python"
    return _validate_comfy_python(comfy_root, value)


def _install_existing_dependencies(root: Path, role: str, python_path: str) -> int:
    try:
        _config, distro, comfy_root = _wsl_location(root, role)
        python_path = _validate_comfy_python(comfy_root, python_path)
        system_root = os.environ.get("SystemRoot")
        if not system_root:
            raise ValueError("Windows system directory unavailable")
        powershell = Path(system_root) / "System32" / "WindowsPowerShell" / "v1.0" / "powershell.exe"
        installer = root / "Install-ComfyStreamerNodes.ps1"
        if not powershell.is_file() or not installer.is_file():
            raise ValueError("installer unavailable")
        result = subprocess.run([str(powershell), "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", str(installer),
                                 "-Distro", distro, "-ComfyRoot", comfy_root, "-Role", role,
                                 "-ComfyPython", python_path, "-InstallDependencies"], check=False)
        if result.returncode != 0:
            return result.returncode
        # Keep the existing TOML and any Twitch credential untouched. Record
        # this explicit interpreter only after dependency installation succeeds.
        descriptor, temporary_name = tempfile.mkstemp(prefix=f".worker.{role}.python-", dir=root)
        try:
            with os.fdopen(descriptor, "w", encoding="utf-8") as output:
                output.write(python_path + "\n")
            os.replace(temporary_name, root / f"worker.{role}.comfy-python")
        finally:
            Path(temporary_name).unlink(missing_ok=True)
        print("ComfyUI dependencies installed for this worker role.")
        return 0
    except (KeyError, OSError, TypeError, ValueError, tomllib.TOMLDecodeError):
        print("Could not install dependencies. Use an absolute Python path under the configured WSL ComfyUI folder.")
        return 1


def _start_comfy(root: Path, role: str) -> int:
    try:
        config, distro, comfy_root = _wsl_location(root, role)
        comfy_python = _comfy_python(root, role, comfy_root)
        value = os.environ.get("SLOPTOGETHER_COMFY_URL", config.get("comfy_url", "http://127.0.0.1:8188"))
        if not isinstance(value, str):
            raise ValueError("invalid ComfyUI address")
        url = urlsplit(value)
        host = url.hostname or ""
        try:
            loopback = host.lower() == "localhost" or ipaddress.ip_address(host).is_loopback
        except ValueError:
            loopback = host.lower() == "localhost"
        if (url.scheme != "http" or not loopback or url.username or url.password
                or url.path not in {"", "/"} or url.query or url.fragment):
            raise ValueError("ComfyUI must use a loopback HTTP address")
        port = url.port or 80
        system_root = os.environ.get("SystemRoot")
        if not system_root:
            raise ValueError("Windows system directory unavailable")
        wsl = Path(system_root) / "System32" / "wsl.exe"
        if not wsl.is_file():
            raise ValueError("WSL unavailable")
    except (KeyError, OSError, TypeError, ValueError, tomllib.TOMLDecodeError):
        print("Could not use this WSL configuration. Run setup for this role first.")
        return 1

    try:
        with socket.create_connection((host, port), timeout=0.5):
            print("The ComfyUI port is already in use. Use Check worker to verify it.")
            return 0
    except OSError:
        pass
    try:
        subprocess.Popen([str(wsl), "--distribution", distro, "--cd", comfy_root,
                          "--exec", comfy_python, "main.py",
                          "--listen", host, "--port", str(port)],
                         creationflags=getattr(subprocess, "CREATE_NEW_CONSOLE", 0))
    except OSError:
        print("Could not start ComfyUI in WSL.")
        return 1
    print("ComfyUI is starting in a new window. Use Check worker when it is ready.")
    return 0


def _generation_models(root: Path, role: str, *, login: bool) -> int:
    if role != "generation":
        print("Switch to generation for Hugging Face login and model downloads.")
        return 1
    try:
        _config, distro, comfy_root = _wsl_location(root, role)
        comfy_python = _comfy_python(root, role, comfy_root)
        system_root = os.environ.get("SystemRoot")
        if not system_root:
            raise ValueError("Windows system directory unavailable")
        system = Path(system_root) / "System32"
        if login:
            executable = system / "wsl.exe"
            arguments = [str(executable), "--distribution", distro, "--exec", f"{comfy_python.rsplit('/', 1)[0]}/hf", "auth", "login"]
        else:
            executable = system / "WindowsPowerShell" / "v1.0" / "powershell.exe"
            installer = root / "Install-ComfyStreamerNodes.ps1"
            if not installer.is_file():
                raise ValueError("model installer unavailable")
            arguments = [str(executable), "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", str(installer),
                         "-Distro", distro, "-ComfyRoot", comfy_root, "-ComfyPython", comfy_python,
                         "-Role", "generation", "-DownloadModels"]
        if not executable.is_file():
            raise ValueError("required Windows executable unavailable")
        return subprocess.run(arguments, check=False).returncode
    except (KeyError, OSError, TypeError, ValueError, tomllib.TOMLDecodeError):
        print("Could not use this WSL configuration. Run setup for generation first.")
        return 1


def _download_models_after_setup(root: Path, role: str) -> int:
    """Download generation weights after setup, obtaining WSL Hugging Face auth if needed."""
    if role != "generation":
        return 0
    try:
        _config, distro, comfy_root = _wsl_location(root, role)
        comfy_python = _comfy_python(root, role, comfy_root)
        system_root = os.environ.get("SystemRoot")
        if not system_root:
            raise ValueError("Windows system directory unavailable")
        wsl = Path(system_root) / "System32" / "wsl.exe"
        if not wsl.is_file():
            raise ValueError("WSL unavailable")
        hf = f"{comfy_python.rsplit('/', 1)[0]}/hf"
        auth = subprocess.run([str(wsl), "--distribution", distro, "--exec", hf, "auth", "whoami"],
                              check=False, capture_output=True, text=True)
    except (KeyError, OSError, TypeError, ValueError, tomllib.TOMLDecodeError):
        print("Could not check Hugging Face access. Run model setup from the worker menu.")
        return 1
    if auth.returncode != 0:
        print("Accept access to the FastH3 Trim and MiniMax H3 models, then sign in to Hugging Face in WSL.")
        print("https://huggingface.co/FastVideo/FastVideo-FastH3-Trim-Comfy")
        print("https://huggingface.co/Comfy-Org/MiniMax-H3")
        if _generation_models(root, role, login=True) != 0:
            return 1
    print("Downloading and verifying the pinned generation models. This may take a while.")
    return _generation_models(root, role, login=False)


def _check_setup_status(root: Path, role: str) -> dict[str, bool]:
    if role not in {"generation", "upscale"}:
        return {"installed": False, "models": False}
    try:
        system_root = os.environ.get("SystemRoot")
        if not system_root:
            return {"installed": False, "models": False}
        wsl = Path(system_root) / "System32" / "wsl.exe"
        config_path = root / f"worker.{role}.toml"
        if config_path.is_file():
            _config, distro, comfy_root = _wsl_location(root, role)
        else:
            distro = os.environ.get("SLOPTOGETHER_WSL_DISTRO", "Ubuntu-24.04")
            if not re.fullmatch(r"[A-Za-z0-9._-]+", distro) or not wsl.is_file():
                return {"installed": False, "models": False}
            user = subprocess.run([str(wsl), "--distribution", distro, "--exec", "id", "-un"],
                                  check=False, capture_output=True, text=True, timeout=8)
            linux_user = user.stdout.strip()
            if user.returncode != 0 or not re.fullmatch(r"[a-z_][a-z0-9_-]*", linux_user):
                return {"installed": False, "models": False}
            comfy_root = os.environ.get("SLOPTOGETHER_COMFY_ROOT", f"/home/{linux_user}/ComfyUI")
            if not re.fullmatch(r"/home/[A-Za-z0-9._/-]+", comfy_root) or ".." in comfy_root:
                return {"installed": False, "models": False}
        comfy_python = _comfy_python(root, role, comfy_root)
        powershell = Path(system_root) / "System32" / "WindowsPowerShell" / "v1.0" / "powershell.exe"
        installer = root / "Install-ComfyStreamerNodes.ps1"
        if not powershell.is_file() or not installer.is_file():
            return {"installed": False, "models": False}
        result = subprocess.run(
            [str(powershell), "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", str(installer),
             "-Distro", distro, "-ComfyRoot", comfy_root, "-ComfyPython", comfy_python,
             "-Role", role, "-CheckOnly", "-CheckModels"],
            check=False, capture_output=True, text=True,
        )
        output = (result.stdout or "") + "\n" + (result.stderr or "")
        return {
            "installed": "SLOPTOGETHER_INSTALL_OK" in output,
            "models": "FASTH3_MODELS_OK" in output or "FASTH3_MODELS_NOT_REQUIRED" in output,
        }
    except (KeyError, OSError, subprocess.SubprocessError, TypeError, ValueError, tomllib.TOMLDecodeError):
        return {"installed": False, "models": False}


def _roles_share_state(root: Path) -> bool:
    configs = [root / "worker.generation.toml", root / "worker.upscale.toml"]
    if not all(path.is_file() for path in configs):
        return False
    try:
        states = []
        for path in configs:
            worker = tomllib.loads(path.read_text(encoding="utf-8"))["worker"]
            if not isinstance(worker, dict):
                return True
            value = os.environ.get("SLOPTOGETHER_WORKER_HOME", worker.get("state_dir", "~/.sloptogether"))
            if not isinstance(value, str) or not value:
                return True
            states.append(os.path.normcase(str(Path(value).expanduser().resolve())))
        return states[0] == states[1]
    except (KeyError, OSError, ValueError, tomllib.TOMLDecodeError):
        return True


def _pairing_has_credential_override(config: Path, role: str) -> bool:
    if os.environ.get("SLOPTOGETHER_WORKER_KEY") or f"SLOPTOGETHER_WORKER_KEY_{role.upper()}" in os.environ:
        return True
    try:
        worker = tomllib.loads(config.read_text(encoding="utf-8"))["worker"]
        return not isinstance(worker, dict) or bool(worker.get("credential_file"))
    except (KeyError, OSError, ValueError, tomllib.TOMLDecodeError):
        return True


def interactive_menu(
    root: Path,
    *,
    read_input: Callable[[str], str] = input,
    run_command: Callable[[list[str]], int] = _run_cli,
    run_setup: Callable[[Path, str, bool], int] = _run_setup,
    run_comfy: Callable[[Path, str], int] = _start_comfy,
    run_models: Callable[[Path, str, bool], int] = lambda root, role, login: _generation_models(root, role, login=login),
    run_dependencies: Callable[[Path, str, str], int] = _install_existing_dependencies,
) -> int:
    role = "generation"
    while True:
        print(f"\nSlopTogether — {role}\n"
              "1. Check worker\n2. Connect Twitch\n3. Start worker\n"
              "4. Set up existing ComfyUI and install nodes\n5. Install ComfyUI\n6. Switch role\n"
              "7. Start ComfyUI\n8. Log in to Hugging Face\n9. Download generation models\n"
              "10. Install dependencies for an existing ComfyUI\n0. Quit")
        try:
            choice = read_input("Select: ").strip()
        except (EOFError, KeyboardInterrupt):
            print()
            return 0
        if choice == "0":
            return 0
        if choice == "6":
            role = "upscale" if role == "generation" else "generation"
            continue
        if choice in {"4", "5"}:
            setup_status = run_setup(root, role, choice == "5")
            if setup_status != 0:
                print("Setup did not complete.")
            elif role == "generation" and _download_models_after_setup(root, role) != 0:
                print("Setup completed, but the generation models are not ready. Fix the message above, then retry model setup.")
            continue
        if choice == "7":
            run_comfy(root, role)
            continue
        if choice in {"8", "9"}:
            if run_models(root, role, choice == "8") != 0:
                print("Model setup did not complete.")
            continue
        if choice == "10":
            try:
                python_path = read_input("WSL ComfyUI Python path: ").strip()
            except (EOFError, KeyboardInterrupt):
                print()
                return 0
            if run_dependencies(root, role, python_path) != 0:
                print("Dependency installation did not complete.")
            continue
        command = {"1": "check", "2": "pair", "3": "run"}.get(choice)
        if command is None:
            print("Choose an option from the menu.")
            continue
        config = root / f"worker.{role}.toml"
        if not config.is_file():
            print("Run setup for this role first.")
            continue
        if command == "pair" and _roles_share_state(root):
            print("Both roles share credential storage. Give each worker config a separate state_dir before pairing.")
            continue
        if command == "pair" and _pairing_has_credential_override(config, role):
            print("Remove the credential_file or worker-key environment override before pairing in the menu.")
            continue
        if command == "run":
            print("Press Ctrl+C to stop this worker.")
        status = run_command(["--config", str(config), "--role", role, command])
        if status not in (0, 130):
            print(f"Worker stopped with error {status}.")


def main() -> int:
    if sys.platform == "win32" and getattr(sys, "frozen", False) and len(sys.argv) == 1:
        from sloptogether_worker.desktop import run_desktop

        root = _bundle_root()

        def install_dependencies(bundle_root: Path, role: str, _unused: str) -> int:
            _config, _distro, comfy_root = _wsl_location(bundle_root, role)
            return _install_existing_dependencies(bundle_root, role, _comfy_python(bundle_root, role, comfy_root))

        def setup(bundle_root: Path, role: str, install_comfy: bool) -> int:
            return _run_setup(bundle_root, role, install_comfy)

        return run_desktop(root, {
            "setup": setup,
            "models": _download_models_after_setup,
            "dependencies": install_dependencies,
            "comfy": _start_comfy,
            "status": _check_setup_status,
        })
    return worker_main()


if __name__ == "__main__":
    raise SystemExit(main())
