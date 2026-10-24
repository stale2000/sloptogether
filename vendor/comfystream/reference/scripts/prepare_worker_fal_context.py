#!/usr/bin/env python3
"""Stage canonical worker source for a targeted Fal Docker build, without deploying."""

from __future__ import annotations

import argparse
from pathlib import Path

try:
    from scripts.assemble_worker_artifact import ROOT, assemble, check_artifact
except ModuleNotFoundError:
    from assemble_worker_artifact import (  # type: ignore[import-not-found, no-redef]
        ROOT,
        assemble,
        check_artifact,
    )

APPS = {
    "fasth3": Path("deploy/fal/fasth3-b1"),
    "h3-upscaler": Path("deploy/fal/h3-sol-upscaler"),
}


def main(argv: list[str] | None = None) -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--profile", choices=APPS, required=True)
    parser.add_argument("--check", action="store_true")
    args = parser.parse_args(argv)
    destination = ROOT / APPS[args.profile] / "context/comfystream"
    if args.check:
        check_artifact(destination, ROOT, args.profile)
    else:
        manifest = assemble(destination, ROOT, args.profile)
        print(f"{args.profile}: {manifest['artifact_digest']}")


if __name__ == "__main__":
    main()
