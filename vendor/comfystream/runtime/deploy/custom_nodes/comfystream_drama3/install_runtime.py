"""Explicit native dependency installation; no Python packages or import-time downloads."""

import argparse
import hashlib
import os
import platform
import re
import shutil
import subprocess
import urllib.request
from pathlib import Path
from typing import Literal, overload

AUDIOCPP_URL = "https://github.com/0xShug0/audio.cpp.git"
AUDIOCPP_REVISION = "337d429692b0a2e627abcc9937a880e02aad2bf7"
MODEL_REPOSITORY = "Jmica/Drama-3-GGUF"
MODEL_REVISION = "17a5b40c5dc2c2be986f5371a7e650108b828e29"
MODEL_FILENAME = "drama-3-backbone-8bit-experts-Q4_K_S.gguf"
MODEL_SHA256 = "05af716baf78e7c20863b9ccebb3ebdeca9607dd3ea7d0b72c35079e675b212b"
MODEL_SIZE = 24596497888


@overload
def _run(
    command: list[str], *, cwd: Path | None = None,
    capture_output: bool = False, text: Literal[True],
) -> subprocess.CompletedProcess[str]: ...


@overload
def _run(
    command: list[str], *, cwd: Path | None = None,
    capture_output: bool = False, text: Literal[False] = False,
) -> subprocess.CompletedProcess[bytes]: ...


def _run(
    command: list[str], *, cwd: Path | None = None,
    capture_output: bool = False, text: bool = False,
) -> subprocess.CompletedProcess[str] | subprocess.CompletedProcess[bytes]:
    return subprocess.run(command, check=True, cwd=cwd, capture_output=capture_output, text=text)


def preflight() -> None:
    if platform.system() != "Linux":
        raise RuntimeError("Drama 3 resident CUDA installation requires Linux")
    for command in ("git", "cmake", "c++", "nvcc"):
        if not shutil.which(command):
            raise RuntimeError(f"Drama 3 installation requires {command} on PATH")
    version = _run(["nvcc", "--version"], capture_output=True, text=True).stdout
    match = re.search(r"release (\d+)\.(\d+)", version)
    if not match or tuple(map(int, match.groups())) < (12, 8):
        raise RuntimeError("RTX 5090 compilation requires CUDA toolkit 12.8 or newer")


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for block in iter(lambda: source.read(8 * 1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def download_model(root: Path) -> Path:
    destination = root / "models" / MODEL_FILENAME
    destination.parent.mkdir(parents=True, exist_ok=True)
    if destination.exists():
        if destination.stat().st_size != MODEL_SIZE or sha256(destination) != MODEL_SHA256:
            raise RuntimeError(f"Existing model fails pinned size/SHA256 validation: {destination}")
    else:
        temporary = destination.with_suffix(".gguf.part")
        url = f"https://huggingface.co/{MODEL_REPOSITORY}/resolve/{MODEL_REVISION}/{MODEL_FILENAME}"
        try:
            with urllib.request.urlopen(url, timeout=120) as response, temporary.open("wb") as output:
                shutil.copyfileobj(response, output, length=8 * 1024 * 1024)
            if temporary.stat().st_size != MODEL_SIZE or sha256(temporary) != MODEL_SHA256:
                raise RuntimeError("Downloaded Drama 3 model fails pinned size/SHA256 validation")
            temporary.replace(destination)
        finally:
            temporary.unlink(missing_ok=True)
    # Keep the model's license and attribution beside the checkpoint.
    for filename in ("LICENSE", "NOTICE"):
        url = f"https://huggingface.co/{MODEL_REPOSITORY}/resolve/{MODEL_REVISION}/{filename}"
        with urllib.request.urlopen(url, timeout=120) as response:
            (destination.parent / filename).write_bytes(response.read())
    return destination


def install(root: Path, jobs: int = 4) -> None:
    preflight()
    root = root.expanduser().resolve()
    source = Path(os.environ.get("COMFYSTREAM_DRAMA3_SOURCE_DIR", root / "audio.cpp"))
    source = source.expanduser().resolve()
    if source.exists():
        # Never reset an existing checkout or discard edits on an install rerun.
        status = _run(["git", "status", "--porcelain"], cwd=source,
                      capture_output=True, text=True).stdout.strip()
        revision = _run(["git", "rev-parse", "HEAD"], cwd=source,
                        capture_output=True, text=True).stdout.strip()
        if status or revision != AUDIOCPP_REVISION:
            raise RuntimeError("Existing audio.cpp checkout is modified or has a different revision; "
                               "use a fresh --prefix")
    else:
        source.mkdir(parents=True)
        _run(["git", "init", str(source)])
        _run(["git", "remote", "add", "origin", AUDIOCPP_URL], cwd=source)
        _run(["git", "fetch", "--depth", "1", "origin", AUDIOCPP_REVISION], cwd=source)
        _run(["git", "checkout", "--detach", AUDIOCPP_REVISION], cwd=source)
    _run([
        "git", "-c", ("submodule.external/audio.cpp-server-frontends.url="
                      "https://github.com/0xShug0/audio.cpp-server-frontends.git"),
        "submodule", "update", "--init", "--recursive",
    ], cwd=source)
    _run([
        "bash", "scripts/build_linux.sh", "--cuda", "on", "--cuda-arch", "120",
        "--model-set", "custom", "--models", "fish_drama3", "--deployment-build",
        "--target", "audiocpp_cli", "--jobs", str(jobs),
    ], cwd=source)
    build = source / "build/linux-cuda-release"
    _run(["cmake", "--build", str(build), "--parallel", str(jobs),
          "--target", "audiocpp_server"], cwd=source)
    cli = source / "build/linux-cuda-release/bin/audiocpp_cli"
    server = source / "build/linux-cuda-release/bin/audiocpp_server"
    if not cli.is_file() or not os.access(cli, os.X_OK):
        raise RuntimeError(f"CUDA build did not produce executable {cli}")
    if not server.is_file() or not os.access(server, os.X_OK):
        raise RuntimeError(f"CUDA build did not produce executable {server}")
    model = download_model(root)
    print(f"COMFYSTREAM_DRAMA3_CLI={cli}")
    print(f"COMFYSTREAM_DRAMA3_SERVER={server}")
    print(f"COMFYSTREAM_DRAMA3_MODEL={model}")


def main(argv: list[str] | None = None) -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--install", action="store_true", required=True,
                        help="build pinned CUDA runtime and download the 22.91 GiB model")
    parser.add_argument("--prefix", type=Path, default=Path(os.environ.get(
        "COMFYSTREAM_DRAMA3_RUNTIME", str(Path(__file__).resolve().parent / ".runtime"),
    )))
    parser.add_argument("--jobs", type=int, default=4)
    args = parser.parse_args(argv)
    if args.jobs < 1:
        parser.error("--jobs must be positive")
    install(args.prefix, args.jobs)


if __name__ == "__main__":
    main()
