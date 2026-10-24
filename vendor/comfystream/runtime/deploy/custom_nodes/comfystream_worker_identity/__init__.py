"""Read-only artifact identity exposed through ComfyUI's existing object_info API."""

from __future__ import annotations

import json
import uuid
from collections.abc import Callable
from pathlib import Path
from typing import Protocol, cast


def artifact_identity() -> dict[str, object]:
    path = Path(__file__).with_name("artifact.json")
    if not path.is_file():
        return {"schema": "comfystream-worker-artifact/1", "status": "unassembled"}
    value: object = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(value, dict) or not all(isinstance(key, str) for key in value):
        raise ValueError("worker artifact identity must be a JSON object")
    return {key: item for key, item in value.items()}


LOADED_IDENTITY = artifact_identity()
RUNTIME_INSTANCE_ID = uuid.uuid4().hex

# ComfyUI's supported extension route registry; this uses its existing server.
# A source-only import remains usable for offline inspection without ComfyUI.
try:
    from server import PromptServer
except ImportError:
    PromptServer = None

if PromptServer is not None:
    from aiohttp import web

    class _Routes(Protocol):
        def get[**P, R](self, path: str) -> Callable[[Callable[P, R]], Callable[P, R]]: ...

    routes = cast(_Routes, PromptServer.instance.routes)

    @routes.get("/comfystream/worker_identity")
    async def worker_identity(request: object) -> web.Response:
        return web.json_response({
            **LOADED_IDENTITY,
            "runtime_instance_id": RUNTIME_INSTANCE_ID,
            "asset_binding": "declared-build-inputs",
        })


class ComfyStreamWorkerCompatibility:
    """Metadata only; this node never starts a worker or submits a prompt."""

    DESCRIPTION = json.dumps(LOADED_IDENTITY, sort_keys=True, separators=(",", ":"))
    CATEGORY = "ComfyStream/metadata"
    RETURN_TYPES = ("STRING",)
    FUNCTION = "identity"

    @classmethod
    def INPUT_TYPES(cls) -> dict[str, dict[str, object]]:
        return {"required": {}}

    def identity(self) -> tuple[str]:
        return (self.DESCRIPTION,)


NODE_CLASS_MAPPINGS = {"ComfyStreamWorkerCompatibility": ComfyStreamWorkerCompatibility}
NODE_DISPLAY_NAME_MAPPINGS = {"ComfyStreamWorkerCompatibility": "ComfyStream Worker Identity"}
