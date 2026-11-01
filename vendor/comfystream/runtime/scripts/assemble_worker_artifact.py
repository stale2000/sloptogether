#!/usr/bin/env python3
"""Assemble or verify an offline, deterministic worker source artifact.

Only reviewed source roots are copied. No dependency installation, network access,
model download, environment capture, or worker startup occurs here.
"""

from __future__ import annotations

import argparse
import ast
import hashlib
import json
import os
import re
import shutil
import subprocess
import tempfile
from pathlib import Path
from typing import TYPE_CHECKING, cast

if TYPE_CHECKING:
    from comfystream.json_values import JsonValue

ROOT = Path(__file__).resolve().parents[1]
SCHEMA = "comfystream-worker-artifact/1"
ENVIRONMENT = Path("deploy/vast/fasth3-environment.json")
IDENTITY = Path("deploy/custom_nodes/comfystream_worker_identity")
PROFILES = {
    "fasth3": ("fasth3_deploy", "comfystream_drama3"),
    "h3-upscaler": ("comfystream_sol_refiner_h3",),
    "vast": ("fasth3_deploy", "comfystream_sol_refiner_h3", "comfystream_drama3"),
}
SOURCE_SUFFIXES = {
    ".py", ".sh", ".cu", ".cuh", ".c", ".cpp", ".h", ".inl", ".js",
    ".json", ".toml", ".yaml", ".txt", ".in", ".lock", ".md", ".flash-attention",
}
SOURCE_JSON_NAMES = {"VENDORED.json", "runtime.json"}
EXCLUDED_DIRECTORIES = {"__pycache__", ".worker", ".venv", "build", "dist", "examples"}
# These upstream engineering notes are retained in the source snapshot for
# provenance, but are not operator documentation and do not belong in a worker
# runtime artifact.
EXCLUDED_RELEASE_DOCS = {
    "ADAPTIVE_ATTENTION_PLAN.md",
    "ADAPTIVE_ATTENTION_RESEARCH.md",
    "DMAD_BENCHMARK.md",
    "PERFORMANCE.md",
    "QUICKSTART.md",
}


def encoded(value: object) -> bytes:
    return (json.dumps(value, sort_keys=True, indent=2) + "\n").encode()


def digest(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def source_files(root: Path, relative: Path) -> list[Path]:
    source = root / relative
    if source.is_symlink():
        raise ValueError(f"source symlink is forbidden: {relative}")
    if source.is_file():
        return [relative]
    if not source.is_dir():
        raise FileNotFoundError(source)
    result = []
    for path in sorted(source.rglob("*")):
        parts = path.relative_to(source).parts
        if any(part.startswith(".") or part in EXCLUDED_DIRECTORIES for part in parts):
            continue
        if path.is_symlink():
            raise ValueError(f"source symlink is forbidden: {path}")
        if not path.is_file():
            continue
        if path.name in EXCLUDED_RELEASE_DOCS:
            continue
        if path.suffix == ".json" and path.name not in SOURCE_JSON_NAMES:
            continue
        if path.suffix in SOURCE_SUFFIXES or path.name in {"LICENSE", "NOTICE"}:
            result.append(path.relative_to(root))
    return result


def tracked_executable_modes(root: Path) -> dict[str, bool]:
    """Read executable bits from Git so Windows checkouts retain Linux modes."""
    try:
        result = subprocess.run(
            ["git", "-C", str(root), "ls-files", "-s", "--", "."],
            check=True, capture_output=True, text=True,
        )
    except (OSError, subprocess.CalledProcessError):
        return {}
    modes: dict[str, bool] = {}
    for line in result.stdout.splitlines():
        metadata, separator, name = line.partition("\t")
        if not separator:
            continue
        mode = metadata.split(maxsplit=1)[0]
        modes[Path(name).as_posix()] = mode == "100755"
    return modes


def artifact_inputs(root: Path, profile: str) -> tuple[dict[Path, bytes], dict[str, JsonValue]]:
    roots = [IDENTITY, ENVIRONMENT, Path("scripts/assemble_worker_artifact.py")]
    roots.extend(Path("deploy/custom_nodes") / name for name in PROFILES[profile])
    # Fal consumes the app Dockerfile as the build definition and omits it from
    # the image's uploaded context. The Fal deployment manifest separately
    # binds that Dockerfile's digest, so it is not a runtime artifact input.
    if profile in {"fasth3", "vast"}:
        roots.extend((
            Path("scripts/download_fasth3_models.sh"),
            Path("scripts/verify_fasth3_models.py"),
            Path("deploy/fal/fasth3-b1/entrypoint.sh"),
            Path("deploy/fal/fasth3-b1/pyproject.toml"),
            Path("deploy/fal/fasth3-b1/uv.lock"),
            Path("deploy/fal/fasth3-b1/requirements.in"),
            Path("deploy/fal/fasth3-b1/requirements.lock"),
            Path("deploy/fal/fasth3-b1/comfyui-requirements.txt"),
            Path("deploy/fal/fasth3-b1/shared-model-stat-receipt.json"),
        ))
    if profile in {"h3-upscaler", "vast"}:
        roots.extend((
            Path("scripts/prepare_h3_upscale_conditioning.py"),
            Path("deploy/fal/h3-sol-upscaler/README.md"),
            Path("deploy/fal/h3-sol-upscaler/pyproject.toml"),
            Path("deploy/fal/h3-sol-upscaler/uv.lock"),
            Path("deploy/fal/h3-sol-upscaler/requirements.in"),
            Path("deploy/fal/h3-sol-upscaler/requirements.lock"),
            Path("deploy/fal/h3-sol-upscaler/comfyui-requirements.txt"),
        ))
    if profile == "vast":
        roots.extend((
            Path("deploy/vast/README.md"),
            Path("deploy/vast/requirements.in"),
            Path("deploy/vast/requirements.lock"),
            Path("deploy/vast/comfyui-requirements.txt"),
        ))
    files = {path: (root / path).read_bytes() for source in roots
             for path in source_files(root, source)}
    tracked_modes = tracked_executable_modes(root)

    def executable(path: Path) -> bool:
        name = path.as_posix()
        if name in tracked_modes:
            return tracked_modes[name]
        return bool((root / path).stat().st_mode & 0o111)

    environment = json.loads(files[ENVIRONMENT])
    assets = {key: environment[key] for key in ("models", "model_paths", "model_revisions")}
    receipt = Path("deploy/fal/fasth3-b1/shared-model-stat-receipt.json")
    if profile in {"fasth3", "vast"}:
        entrypoint = files[Path("deploy/fal/fasth3-b1/entrypoint.sh")].decode()
        trim = {}
        for name in ("trim_revision", "trim_sha256"):
            # Git's Windows checkout may convert this shell file to CRLF.
            match = re.search(rf'^{name}="([^"]+)"\r?$', entrypoint, re.MULTILINE)
            if match is None:
                raise ValueError(f"FastH3 entrypoint must pin {name}")
            trim[name] = match.group(1)
        assets["trim"] = trim
        assets["stat_receipt_sha256"] = digest(files[receipt])
    if profile in {"h3-upscaler", "vast"}:
        model_source = files[Path("deploy/custom_nodes/comfystream_sol_refiner_h3/model_runtime.py")]
        constants = {}
        for node in ast.parse(model_source).body:
            if isinstance(node, ast.Assign) and isinstance(node.value, ast.Constant):
                for target in node.targets:
                    if isinstance(target, ast.Name) and target.id in {"MODEL_ID", "MODEL_REVISION"}:
                        constants[target.id] = node.value.value
        if set(constants) != {"MODEL_ID", "MODEL_REVISION"}:
            raise ValueError("upscaler model identity must be literal and pinned")
        assets["upscaler"] = constants
        decoder = ast.parse(files[Path(
            "deploy/custom_nodes/comfystream_sol_refiner_h3/fast_decoder.py")])
        assets["decoder"] = {
            target.id: ast.literal_eval(node.value)
            for node in decoder.body if isinstance(node, ast.Assign)
            for target in node.targets if isinstance(target, ast.Name)
            and target.id in {"PRUNA_REPO", "PRUNA_REVISION", "ARTIFACT_SHA256"}
        }
    # The environment file contains model hashes as well as runtime pins. Hash
    # runtime pins separately so a model-only manifest change is not code drift.
    code_files = {path.as_posix(): {"sha256": digest(data), "executable": executable(path)} for path, data in files.items()
        if path not in {ENVIRONMENT, receipt}}
    runtime = {key: value for key, value in environment.items() if key not in assets}
    compatibility = {"comfyui_api": "prompt-history-object_info/1"}
    if "fasth3_deploy" in PROFILES[profile]:
        compatibility["generator_node"] = "FastH3BenchmarkSampler"
        compatibility["output_node"] = "FastH3BenchmarkOutput"
        compatibility["drama3_package"] = "comfystream_drama3"
    if "comfystream_sol_refiner_h3" in PROFILES[profile]:
        compatibility["upscaler_node"] = "ComfyStreamMiniMaxH3SoLUpscaler"
    manifest: dict[str, JsonValue] = {
        "schema": SCHEMA,
        "profile": profile,
        "code_digest": digest(encoded({"files": code_files, "runtime": runtime})),
        "asset_digest": digest(encoded(assets)),
        "assets": assets,
        "runtime": runtime,
        "compatibility": compatibility,
        "files": {path.as_posix(): {"sha256": digest(data), "executable": executable(path)} for path, data in sorted(files.items())},
    }
    manifest["artifact_digest"] = digest(encoded(manifest))
    return files, manifest


def expected_files(root: Path, profile: str) -> dict[Path, tuple[bytes, int]]:
    files, manifest = artifact_inputs(root, profile)
    expected = {path: (data, 0o755 if cast("dict[str, dict[str, JsonValue]]", manifest["files"])[path.as_posix()]["executable"] else 0o644)
                for path, data in files.items()}
    expected[Path("worker-manifest.json")] = (encoded(manifest), 0o644)
    # object_info descriptions carry the compact immutable identity; file hashes
    # remain in the adjacent build manifest for audit/freshness checks.
    identity = {key: value for key, value in manifest.items() if key != "files"}
    expected[IDENTITY / "artifact.json"] = (encoded(identity), 0o644)
    return expected


def check_artifact(destination: Path, root: Path, profile: str) -> None:
    expected = expected_files(root, profile)
    if destination.is_symlink() or any(path.is_symlink() for path in destination.rglob("*")):
        raise ValueError("worker artifact symlinks are forbidden")
    actual = {path.relative_to(destination) for path in destination.rglob("*") if path.is_file()}
    if actual != set(expected):
        raise ValueError("stale worker artifact file set; assemble it again")
    for relative, (content, mode) in expected.items():
        path = destination / relative
        if path.is_symlink():
            raise ValueError(f"worker artifact contains a symlink: {relative}")
        actual_mode = path.stat().st_mode & 0o777
        actual_content = path.read_bytes()
        if actual_content != content:
            detail = ""
            if relative.name == "worker-manifest.json":
                try:
                    actual_manifest = json.loads(actual_content)
                    expected_manifest = json.loads(content)
                except (UnicodeDecodeError, json.JSONDecodeError):
                    pass
                else:
                    changed_keys = [
                        key for key in expected_manifest
                        if expected_manifest.get(key) != actual_manifest.get(key)
                    ]
                    detail = f"; differing manifest fields={changed_keys}"
                    if "files" in changed_keys:
                        expected_manifest_files = expected_manifest["files"]
                        actual_files = actual_manifest.get("files", {})
                        changed_files = [
                            name for name in expected_manifest_files
                            if expected_manifest_files[name] != actual_files.get(name)
                        ]
                        detail += f"; differing file records={changed_files}"
            raise ValueError(
                f"stale worker artifact: {relative}; expected sha256={digest(content)}, "
                f"found sha256={digest(actual_content)}{detail}; assemble it again"
            )
        if os.name != "nt" and actual_mode != mode:
            raise ValueError(
                f"stale worker artifact mode: {relative}; expected {mode:o}, "
                f"found {actual_mode:o}; assemble it again"
            )


def assemble(destination: Path, root: Path = ROOT, profile: str = "vast") -> dict[str, JsonValue]:
    if destination.is_symlink():
        raise ValueError("artifact destination must not be a symlink")
    destination = destination.resolve()
    root = root.resolve()
    # Never permit a destination that would replace canonical input trees.
    protected = [root / "deploy/custom_nodes", root / "scripts", root / "deploy/vast"]
    if any(destination == path or destination in path.parents or path in destination.parents
           for path in protected):
        raise ValueError("artifact destination overlaps canonical sources")
    legacy_contexts = {root / "deploy/fal" / app / "context/comfystream"
                       for app in ("fasth3-b1", "h3-sol-upscaler")}
    if (destination.is_dir() and any(destination.iterdir())
            and not (destination / "worker-manifest.json").is_file()
            and destination not in legacy_contexts):
        raise ValueError("refusing to replace a directory that is not a worker artifact")
    expected = expected_files(root, profile)
    destination.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix=".worker-artifact-", dir=destination.parent) as temp:
        staging = Path(temp) / "source"
        for relative, (content, mode) in expected.items():
            path = staging / relative
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(content)
            path.chmod(mode)
            os.utime(path, (0, 0))
        if destination.is_symlink():
            raise ValueError("artifact destination must not be a symlink")
        if destination.exists():
            shutil.rmtree(destination)
        staging.rename(destination)
    payload = json.loads(expected[Path("worker-manifest.json")][0])
    if not isinstance(payload, dict):
        raise TypeError("manifest/report must be a JSON object")
    return payload


def main(argv: list[str] | None = None) -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--profile", choices=PROFILES, required=True)
    parser.add_argument("--destination", type=Path, required=True)
    parser.add_argument("--check", action="store_true", help="fail if source or staged files drift")
    args = parser.parse_args(argv)
    if args.check:
        check_artifact(args.destination, ROOT, args.profile)
    else:
        manifest = assemble(args.destination, ROOT, args.profile)
        print(json.dumps({key: manifest[key] for key in (
            "schema", "profile", "code_digest", "asset_digest", "artifact_digest")}))


if __name__ == "__main__":
    main()
