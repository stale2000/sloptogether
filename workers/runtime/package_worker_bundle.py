from __future__ import annotations

import argparse
import hashlib
import os
import tempfile
import zipfile
from pathlib import Path

FILES = {
    "SlopTogetherWorker.exe": Path("dist/SlopTogetherWorker.exe"),
    "worker.example.toml": Path("dist/worker.example.toml"),
    "worker.wsl.example.toml": Path("dist/worker.wsl.example.toml"),
    "Setup-SlopTogetherWorker.ps1": Path("dist/Setup-SlopTogetherWorker.ps1"),
    "Install-ComfyStreamerNodes.ps1": Path("dist/Install-ComfyStreamerNodes.ps1"),
    "ComfyStreamer-Wsl-runtime.zip": Path("dist/ComfyStreamer-Wsl-runtime.zip"),
    "README.txt": Path("dist/README.txt"),
}


def package_bundle(root: Path) -> tuple[Path, str]:
    root = root.resolve()
    dist = root / "dist"
    if not dist.is_dir() or dist.is_symlink():
        raise ValueError("worker_dist_directory_invalid")
    sources = {name: root / relative for name, relative in FILES.items()}
    for path in sources.values():
        if path.is_symlink() or not path.is_file():
            raise ValueError(f"worker_bundle_file_missing:{path.name}")

    destination = dist / "SlopTogetherWorker-windows-x64.zip"
    if destination.is_symlink():
        raise ValueError("worker_bundle_destination_invalid")
    temporary: Path | None = None
    try:
        with tempfile.NamedTemporaryFile(prefix=".worker-bundle-", suffix=".zip", dir=dist, delete=False) as output:
            temporary = Path(output.name)
        with zipfile.ZipFile(temporary, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=9) as archive:
            for name, path in sources.items():
                archive.write(path, arcname=name)
        os.replace(temporary, destination)
    finally:
        if temporary is not None:
            temporary.unlink(missing_ok=True)

    digest = hashlib.sha256()
    with destination.open("rb") as bundle:
        for chunk in iter(lambda: bundle.read(1024 * 1024), b""):
            digest.update(chunk)
    return destination, digest.hexdigest()


def main() -> int:
    parser = argparse.ArgumentParser(description="Bundle the Windows worker executable and nonsecret setup files.")
    parser.add_argument("--root", type=Path, default=Path(__file__).parent)
    args = parser.parse_args()
    try:
        path, digest = package_bundle(args.root)
    except (OSError, ValueError) as error:
        parser.error(str(error))
    print(f"Windows worker bundle: {path}")
    print(f"Bundle SHA-256: {digest}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
