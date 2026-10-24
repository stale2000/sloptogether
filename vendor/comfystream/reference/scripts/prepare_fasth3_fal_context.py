#!/usr/bin/env python3
"""Stage the exact FastH3 B1 source context for a Fal deployment."""

from __future__ import annotations

import argparse
import fnmatch
import hashlib
import json
import re
import shutil
import subprocess
from pathlib import Path
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from comfystream.json_values import JsonValue

ROOT = Path(__file__).resolve().parents[1]
DEFAULT_APP_DIRECTORY = Path("deploy/fal/fasth3-b1")
IGNORE = shutil.ignore_patterns("__pycache__", "*.pyc", ".pytest_cache", "*.so", "build-report.json", "kernels.sass")
PROFILE_ID = "fal-fasth3-b1"
ENVIRONMENT_LOCK = Path("deploy/fal/fasth3-b1/requirements.lock")


def digest(path: Path) -> str:
    hasher = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            hasher.update(chunk)
    return hasher.hexdigest()


def hash_files(paths: dict[str, str]) -> str:
    """Hash a stable path/digest listing (the receipt itself is intentionally excluded)."""
    hasher = hashlib.sha256()
    for name, value in sorted(paths.items()):
        hasher.update(name.encode("utf-8"))
        hasher.update(b"\0")
        hasher.update(value.encode("ascii"))
        hasher.update(b"\n")
    return hasher.hexdigest()


def staged_files(destination_root: Path) -> dict[str, str]:
    files = sorted(path for path in destination_root.rglob("*") if path.is_file())
    return {path.relative_to(destination_root).as_posix(): digest(path) for path in files}


def expected_inputs(app_directory: Path, destination_root: Path, copy_paths: tuple[Path, ...]) -> dict[str, str]:
    """Return hashes of source files copied to the context and build inputs."""
    copied: dict[str, str] = {}
    for relative in copy_paths:
        source = ROOT / relative
        is_directory = source.is_dir()
        if is_directory:
            paths = sorted(
                path for path in source.rglob("*")
                if path.is_file() and not any(
                    fnmatch.fnmatch(part, pattern)
                    for part in path.relative_to(source).parts
                    for pattern in ("__pycache__", "*.pyc", ".pytest_cache", "*.so", "build-report.json", "kernels.sass")
                )
            )
        else:
            paths = [source]
        for path in paths:
            destination_relative = relative / path.relative_to(source) if is_directory else relative
            copied[destination_relative.as_posix()] = digest(path)

    for name in ("Dockerfile", "README.md", "pyproject.toml", "entrypoint.sh"):
        path = app_directory / name
        if not path.is_file():
            raise FileNotFoundError(f"missing Fal deployment input: {path}")
        copied[f"../{name}"] = digest(path)
    lock_path = ROOT / ENVIRONMENT_LOCK
    copied[f"../{ENVIRONMENT_LOCK.as_posix()}"] = digest(lock_path)
    return copied


def current_git_head() -> str:
    return subprocess.check_output(["git", "-C", str(ROOT), "rev-parse", "HEAD"], text=True).strip()


def docker_base_image(dockerfile: Path) -> str:
    for line in dockerfile.read_text(encoding="utf-8").splitlines():
        instruction = line.strip().split(maxsplit=1)
        if len(instruction) == 2 and instruction[0].upper() == "FROM":
            return instruction[1].split(" AS ", maxsplit=1)[0]
    raise ValueError(f"Dockerfile has no FROM instruction: {dockerfile}")


def base_image_provenance(dockerfile: Path) -> dict[str, str | None]:
    reference = docker_base_image(dockerfile)
    digest_match = re.search(r"@sha256:([0-9a-f]{64})$", reference)
    immutable_digest = f"sha256:{digest_match.group(1)}" if digest_match else None
    known_platforms = {
        "sha256:cce09744eb864371df6423aaba413145afb65794837be783c33446e7ef615d20": "linux/amd64"
    }
    platform = (
        known_platforms.get(immutable_digest)
        if immutable_digest is not None
        else None
    )
    return {
        "reference": reference,
        "platform": platform,
        "digest": immutable_digest,
        "status": "registry_manifest_verified" if platform else "pending_platform_verification",
    }


def additional_model_identity(entrypoint: Path) -> dict[str, str]:
    source = entrypoint.read_text(encoding="utf-8")
    revision = re.search(r'^trim_revision="([0-9a-f]{40})"$', source, re.MULTILINE)
    checksum = re.search(r'^trim_sha256="([0-9a-f]{64})"$', source, re.MULTILINE)
    if revision is None or checksum is None:
        raise ValueError(f"Trim model revision or SHA256 is missing from {entrypoint}")
    return {
        "filename": "fastvideo_fasth3_trim_8step_int8_convrot.safetensors",
        "revision": revision.group(1),
        "sha256": checksum.group(1),
    }


def validate_context(app_directory: Path, destination_root: Path, manifest_path: Path,
                     copy_paths: tuple[Path, ...]) -> list[str]:
    problems: list[str] = []
    if not manifest_path.is_file() or not destination_root.is_dir():
        return ["generated context or source-manifest.json is missing"]
    try:
        manifest = json.loads(manifest_path.read_text())
        expected_source_files = expected_inputs(app_directory, destination_root, copy_paths)
        actual_staged = staged_files(destination_root)
        environment = json.loads((ROOT / "deploy/vast/fasth3-environment.json").read_text())
        expected_manifest = create_manifest(app_directory, destination_root, copy_paths, environment)
    except (OSError, ValueError, FileNotFoundError) as error:
        return [str(error)]
    if manifest.get("source_files") != expected_source_files:
        problems.append("source-manifest.json is stale for current source inputs")
    if manifest.get("context_files") != actual_staged:
        problems.append("staged context files do not match source-manifest.json")
    for field in ("schema", "profile_id", "git_head", "source_digest", "environment_lock",
                  "dockerfile_sha256", "base_image", "model_identities", "model_manifest_sha256",
                  "files", "source_files", "context_files"):
        if manifest.get(field) != expected_manifest[field]:
            problems.append(f"source-manifest.json {field} provenance is stale")
    return problems


def create_manifest(app_directory: Path, destination_root: Path, copy_paths: tuple[Path, ...],
                    environment: dict[str, JsonValue]) -> dict[str, JsonValue]:
    source_files = expected_inputs(app_directory, destination_root, copy_paths)
    context_files = staged_files(destination_root)
    files = {
        **{f"source/{name}": value for name, value in source_files.items()},
        **{f"context/{name}": value for name, value in context_files.items()},
    }
    return {
        "schema": "comfystream-deployment-source/2",
        "profile_id": PROFILE_ID,
        "git_head": current_git_head(),
        "source_digest": hash_files(files),
        "environment_lock": {
            "path": ENVIRONMENT_LOCK.as_posix(),
            "sha256": digest(ROOT / ENVIRONMENT_LOCK),
            "status": "consumed_hash_locked_python_closure",
            "resolver": "uv pip compile",
            "target": "Python 3.12 / x86_64-manylinux_2_28 / cu130",
            "inputs": [
                "deploy/fal/fasth3-b1/comfyui-requirements.txt",
                "deploy/fal/fasth3-b1/requirements.in",
                "deploy/vast/fasth3-environment.json",
            ],
            "separately_verified_wheels": {
                "comfy-kitchen": environment["kitchen_wheel_sha256"],
            },
        },
        "dockerfile_sha256": digest(app_directory / "Dockerfile"),
        "base_image": base_image_provenance(app_directory / "Dockerfile"),
        "model_identities": {
            "revisions": environment.get("model_revisions", {}),
            "sha256": environment.get("models", {}),
            "additional": [additional_model_identity(app_directory / "entrypoint.sh")],
        },
        "model_manifest_sha256": digest(destination_root / "deploy/vast/fasth3-environment.json"),
        "files": files,
        "source_files": source_files,
        "context_files": context_files,
    }


def main(argv: list[str] | None = None) -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--app-directory", type=Path, default=DEFAULT_APP_DIRECTORY,
        help="Fal deployment directory that receives the generated context",
    )
    parser.add_argument("--check", action="store_true", help="verify generated context freshness without modifying it")
    args = parser.parse_args(argv)
    if args.app_directory.is_absolute():
        raise ValueError("--app-directory must be repository-relative")
    app_directory = (ROOT / args.app_directory).resolve()
    if app_directory != ROOT and ROOT not in app_directory.parents:
        raise ValueError("--app-directory must remain inside the repository")
    if not app_directory.is_dir():
        raise FileNotFoundError(f"Fal app directory does not exist: {app_directory}")

    if app_directory == ROOT / DEFAULT_APP_DIRECTORY:
        try:
            from scripts.assemble_worker_artifact import assemble, check_artifact
        except ModuleNotFoundError:
            from assemble_worker_artifact import (  # type: ignore[import-not-found, no-redef]
                assemble,
                check_artifact,
            )
        destination_root = app_directory / "context/comfystream"
        manifest_path = app_directory / "source-manifest.json"
        b1_copy_paths: tuple[Path, ...] = (
            Path("deploy/vast/fasth3-environment.json"),
            Path("deploy/fal/fasth3-b1/shared-model-stat-receipt.json"),
            Path("scripts/download_fasth3_models.sh"),
            Path("scripts/assemble_worker_artifact.py"),
            Path("deploy/fal/fasth3-b1/comfyui-requirements.txt"),
            Path("deploy/fal/fasth3-b1/requirements.in"),
            ENVIRONMENT_LOCK,
        )
        if args.check:
            try:
                check_artifact(destination_root, ROOT, "fasth3")
            except (OSError, ValueError) as error:
                raise SystemExit(f"stale FastH3 worker artifact: {error}") from error
            problems = validate_context(app_directory, destination_root, manifest_path, b1_copy_paths)
            if problems:
                raise SystemExit("stale Fal deployment context: " + "; ".join(problems))
            print(f"{PROFILE_ID} worker artifact and deployment provenance are fresh")
            return

        manifest = assemble(destination_root, ROOT, "fasth3")
        environment = json.loads((ROOT / "deploy/vast/fasth3-environment.json").read_text())
        deployment = create_manifest(app_directory, destination_root, b1_copy_paths, environment)
        manifest_path.write_text(json.dumps(deployment, indent=2, sort_keys=True) + "\n")
        print(json.dumps({
            "profile": "fasth3",
            "artifact_digest": manifest["artifact_digest"],
            "source_digest": deployment["source_digest"],
            "destination": str(destination_root),
        }))
        return

    destination_root = app_directory / "context/comfystream"
    manifest_path = app_directory / "source-manifest.json"
    copy_paths: tuple[Path, ...] = (
        Path("deploy/vast/fasth3-environment.json"),
        Path("deploy/custom_nodes/fasth3_deploy"),
        Path("deploy/custom_nodes/comfystream_drama3"),
        args.app_directory / "shared-model-stat-receipt.json",
        Path("scripts/download_fasth3_models.sh"),
        Path("deploy/fal/fasth3-b1/comfyui-requirements.txt"),
        Path("deploy/fal/fasth3-b1/requirements.in"),
        ENVIRONMENT_LOCK,
    )
    if args.check:
        problems = validate_context(app_directory, destination_root, manifest_path, copy_paths)
        if problems:
            raise SystemExit("stale Fal deployment context: " + "; ".join(problems))
        print(f"{PROFILE_ID} context is fresh")
        return

    if destination_root.exists():
        shutil.rmtree(destination_root)
    for relative in copy_paths:
        source = ROOT / relative
        destination = destination_root / relative
        if source.is_dir():
            shutil.copytree(source, destination, ignore=IGNORE)
        else:
            destination.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(source, destination)
    environment = json.loads((ROOT / "deploy/vast/fasth3-environment.json").read_text())
    manifest = create_manifest(app_directory, destination_root, copy_paths, environment)
    manifest_path.write_text(json.dumps(manifest, indent=2, sort_keys=True) + "\n")
    manifest_files = manifest["files"]
    if not isinstance(manifest_files, dict):
        raise TypeError("source manifest file digest list is invalid")
    print(json.dumps({
        "profile": "b1",
        "staged_files": len(manifest_files),
        "git_head": manifest["git_head"],
        "destination": str(destination_root),
    }))


if __name__ == "__main__":
    main()
