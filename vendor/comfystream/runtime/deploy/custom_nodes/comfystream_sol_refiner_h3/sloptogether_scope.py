"""Worker-owned output scoping for private SlopTogether upscale artifacts."""

from __future__ import annotations

import uuid
from pathlib import Path


def refiner_output_directory(output_dir: Path, scope: str) -> Path:
    if not scope:
        return output_dir / f"sol-refiner-h3-{uuid.uuid4().hex[:12]}"
    if "\\" in scope or scope.startswith("/"):
        raise ValueError("SlopTogether output scope is invalid")
    parts = scope.split("/")
    if len(parts) != 3 or parts[0] != "sloptogether":
        raise ValueError("SlopTogether output scope is invalid")
    try:
        if any(str(uuid.UUID(value)) != value for value in parts[1:]):
            raise ValueError("SlopTogether output scope is invalid")
    except ValueError:
        raise ValueError("SlopTogether output scope is invalid") from None
    return output_dir.joinpath(*parts, "sol-upscale")
