#!/usr/bin/env python3
"""Verify the hash-pinned FastH3 model set without downloading files."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
from pathlib import Path, PurePosixPath

ALTERNATE_MODEL = "fastvideo_fasth3_8step_v2_pruned_int8_convrot.safetensors"
SHA256 = re.compile(r"^[0-9a-f]{64}$")


def verified_models(manifest_path: Path, models_root: Path, *, trim_only: bool = False) -> tuple[str, ...]:
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    models = manifest.get("models")
    paths = manifest.get("model_paths")
    if not isinstance(models, dict) or not isinstance(paths, dict):
        raise ValueError("fasth3_model_manifest_invalid")
    if models_root.is_symlink():
        raise ValueError("fasth3_models_root_symlink_forbidden")
    verified: list[str] = []
    failures: list[str] = []
    for filename, expected in sorted(models.items()):
        if trim_only and filename == ALTERNATE_MODEL:
            continue
        relative = paths.get(filename)
        if (not isinstance(filename, str) or not isinstance(expected, str) or not SHA256.fullmatch(expected)
                or not isinstance(relative, str)):
            failures.append(f"{filename}: invalid manifest entry")
            continue
        relative_path = PurePosixPath(relative)
        if relative_path.is_absolute() or ".." in relative_path.parts or not relative_path.parts:
            failures.append(f"{filename}: invalid model path in manifest")
            continue
        target = models_root.joinpath(*relative_path.parts)
        current = models_root
        has_symlink = False
        for part in relative_path.parts:
            current = current / part
            has_symlink = has_symlink or current.is_symlink()
        if has_symlink or not target.is_file():
            failures.append(f"{filename}: expected one regular file")
            continue
        digest = hashlib.sha256()
        with target.open("rb") as handle:
            offset = 0
            for block in iter(lambda: handle.read(1024 * 1024), b""):
                digest.update(block)
                advice = getattr(os, "POSIX_FADV_DONTNEED", None)
                fadvise = getattr(os, "posix_fadvise", None)
                if advice is not None and callable(fadvise):
                    try:
                        fadvise(handle.fileno(), offset, len(block), advice)
                    except OSError:
                        pass
                offset += len(block)
        actual = digest.hexdigest()
        if actual != expected:
            failures.append(f"{filename}: expected {expected}, got {actual}")
            continue
        verified.append(filename)
    if failures:
        raise ValueError("\n".join(failures))
    return tuple(verified)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("manifest", type=Path)
    parser.add_argument("models_root", type=Path)
    parser.add_argument("trim_only", choices=("0", "1"))
    args = parser.parse_args()
    try:
        verified_models(args.manifest, args.models_root, trim_only=args.trim_only == "1")
    except (OSError, UnicodeDecodeError, json.JSONDecodeError, ValueError) as error:
        parser.error(str(error))
    print("FASTH3_MODELS_OK")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
