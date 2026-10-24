from __future__ import annotations

import argparse
import hashlib
import json
import shutil
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
STAGE_SCHEMA = "sloptogether-fal-worker-context/1"
RELATIVE_SOURCE = Path("workers/runtime")
INCLUDED_SUFFIXES = {".py", ".toml", ".json"}


def _digest(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def _sources() -> dict[str, Path]:
    source_root = ROOT / RELATIVE_SOURCE
    selected: dict[str, Path] = {"pyproject.toml": source_root / "pyproject.toml"}
    package_root = source_root / "src" / "sloptogether_worker"
    for path in sorted(package_root.rglob("*")):
        if path.is_file() and path.suffix in INCLUDED_SUFFIXES and "__pycache__" not in path.parts:
            selected[path.relative_to(source_root).as_posix()] = path
    return selected


def _layout(app_directory: Path) -> tuple[Path, Path]:
    if app_directory.is_symlink() or not app_directory.is_dir():
        raise ValueError("fal_app_directory_must_be_a_real_directory")
    app_root = app_directory.resolve()
    for required in ("Dockerfile", "pyproject.toml"):
        candidate = app_root / required
        if candidate.is_symlink() or not candidate.is_file():
            raise ValueError(f"fal_app_file_missing:{required}")
    context = app_root / "context"
    destination = context / "sloptogether-worker"
    manifest = context / "sloptogether-worker.manifest.json"
    return destination, manifest


def check_context(app_directory: Path) -> None:
    destination, manifest_path = _layout(app_directory)
    if not destination.is_dir() or destination.is_symlink() or not manifest_path.is_file() or manifest_path.is_symlink():
        raise ValueError("fal_worker_context_missing")
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    if not isinstance(manifest, dict) or manifest.get("schema") != STAGE_SCHEMA:
        raise ValueError("fal_worker_context_manifest_invalid")
    source_map = _sources()
    expected = {name: _digest(path) for name, path in source_map.items()}
    if manifest.get("source_files") != expected:
        raise ValueError("fal_worker_context_source_changed")
    actual: dict[str, str] = {}
    for path in sorted(destination.rglob("*")):
        if path.is_symlink():
            raise ValueError("fal_worker_context_symlink_rejected")
        if path.is_file():
            actual[path.relative_to(destination).as_posix()] = _digest(path)
    if actual != expected:
        raise ValueError("fal_worker_context_content_changed")


def stage_context(app_directory: Path) -> Path:
    destination, manifest_path = _layout(app_directory)
    source_map = _sources()
    hashes = {name: _digest(path) for name, path in source_map.items()}
    context = destination.parent
    context.mkdir(parents=True, exist_ok=True)
    if destination.exists():
        check_context(app_directory)

    with tempfile.TemporaryDirectory(prefix=".sloptogether-fal-worker-", dir=context) as temporary:
        staged = Path(temporary) / "sloptogether-worker"
        staged.mkdir()
        for relative, source in source_map.items():
            target = staged / relative
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(source, target)
        staged_manifest = Path(temporary) / "sloptogether-worker.manifest.json"
        staged_manifest.write_text(json.dumps({"schema": STAGE_SCHEMA, "source_files": hashes}, indent=2, sort_keys=True) + "\n", encoding="utf-8")
        if destination.exists():
            shutil.rmtree(destination)
        staged.rename(destination)
        staged_manifest.replace(manifest_path)
    return destination


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Stage the shared SlopTogether worker package into an isolated Fal app build context.")
    parser.add_argument("app_directory", type=Path, help="Fal app folder containing Dockerfile and pyproject.toml")
    parser.add_argument("--check", action="store_true", help="verify the generated worker context without changing files")
    args = parser.parse_args(argv)
    try:
        if args.check:
            check_context(args.app_directory)
            print("SlopTogether Fal worker context is current")
        else:
            print(stage_context(args.app_directory))
        return 0
    except (OSError, ValueError, json.JSONDecodeError) as error:
        print(f"fal_worker_context_error: {error}", file=__import__("sys").stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
