"""Persistent cache for the TorchAO-quantized SoL transformer."""

from __future__ import annotations

import hashlib
import importlib.metadata
import json
import os
import shutil
import tempfile
from pathlib import Path
from types import ModuleType, TracebackType
from typing import TYPE_CHECKING, BinaryIO, Protocol, Self

if TYPE_CHECKING:
    from torch import dtype


class _CheckpointTransformer(Protocol):
    def save_pretrained(self, save_directory: str, *, safe_serialization: bool) -> None: ...


class _TransformerLoader(Protocol):
    def from_pretrained(
        self, pretrained_model_name_or_path: str, *, local_files_only: bool,
        use_safetensors: bool, torch_dtype: dtype,
    ) -> _CheckpointTransformer: ...

_CACHE_SCHEMA = 1
_QUANTIZER_SCHEMA = "torchao-nvfp4-dynamic-activation-weight-triton-v1"
_RECEIPT = "comfystream-nvfp4-cache.json"


class NVFP4CheckpointCache:
    """Serialize and restore a compatible quantized transformer on persistent storage."""

    def __init__(
        self,
        torch: ModuleType,
        model_id: str,
        model_revision: str,
        *,
        video_only_refiner: bool,
    ) -> None:
        self.root = Path(os.environ.get(
            "COMFYSTREAM_SOL_H3_NVFP4_CACHE_DIR",
            "/data/comfystream/sol-h3/nvfp4",
        ))
        capability = torch.cuda.get_device_capability()
        self.identity = {
            "schema": _CACHE_SCHEMA,
            "model_id": model_id,
            "model_revision": model_revision,
            "video_only_refiner": video_only_refiner,
            "quantizer": _QUANTIZER_SCHEMA,
            "torch": str(torch.__version__),
            "cuda": str(torch.version.cuda),
            "torchao": importlib.metadata.version("torchao"),
            "diffusers": importlib.metadata.version("diffusers"),
            "gpu": torch.cuda.get_device_name(0),
            "compute_capability": list(capability),
        }
        encoded = json.dumps(self.identity, sort_keys=True, separators=(",", ":"))
        self.path = self.root / hashlib.sha256(encoded.encode("utf-8")).hexdigest()
        self.lock_file: BinaryIO | None = None
        self.enabled = False

    def __enter__(self) -> Self:
        try:
            import fcntl

            self.root.mkdir(parents=True, exist_ok=True)
            self.lock_file = (self.root / ".cache.lock").open("a+b")
            fcntl.flock(self.lock_file.fileno(), fcntl.LOCK_EX)
        except (ImportError, OSError) as error:
            if self.lock_file is not None:
                self.lock_file.close()
                self.lock_file = None
            print(f"[sol-refiner] NVFP4 disk cache disabled: {error}", flush=True)
            return self
        self.enabled = True
        return self

    def __exit__(
        self,
        _exc_type: type[BaseException] | None,
        _exc: BaseException | None,
        _traceback: TracebackType | None,
    ) -> None:
        if self.lock_file is None:
            return
        import fcntl

        fcntl.flock(self.lock_file.fileno(), fcntl.LOCK_UN)
        self.lock_file.close()
        self.lock_file = None

    def release(self) -> None:
        self.__exit__(None, None, None)

    def load(
        self,
        transformer_class: _TransformerLoader,
        *,
        torch_dtype: dtype,
    ) -> tuple[_CheckpointTransformer, tuple[str, ...], int] | None:
        if not self.enabled or not self._is_valid():
            return None
        try:
            transformer = transformer_class.from_pretrained(
                str(self.path),
                local_files_only=True,
                use_safetensors=False,
                torch_dtype=torch_dtype,
            )
            receipt = json.loads((self.path / _RECEIPT).read_text(encoding="utf-8"))
            names = tuple(receipt["quantized_linear_names"])
            video_only_blocks = int(receipt.get("video_only_transformer_blocks", 0))
        except Exception as error:  # noqa: BLE001 - a bad cached artifact falls back to rebuild
            print(
                f"[sol-refiner] NVFP4 checkpoint could not be loaded; rebuilding it: "
                f"{type(error).__name__}: {error}",
                flush=True,
            )
            return None
        print(f"[sol-refiner] restored NVFP4 transformer from {self.path}", flush=True)
        return transformer, names, video_only_blocks

    def has_valid_checkpoint(self) -> bool:
        """Check whether the source BF16 transformer can be skipped during prefetch."""
        return self.enabled and self._is_valid()

    def save(
        self,
        transformer: _CheckpointTransformer,
        quantized_linear_names: tuple[str, ...],
        *,
        video_only_transformer_blocks: int,
    ) -> None:
        if not self.enabled:
            return
        temporary: Path | None = None
        try:
            temporary = Path(tempfile.mkdtemp(prefix=".nvfp4-", dir=self.root))
            transformer.save_pretrained(
                str(temporary),
                safe_serialization=False,
            )
            files = sorted(
                path for path in temporary.iterdir()
                if path.is_file() and path.name != _RECEIPT
            )
            weights = [path for path in files if path.name.endswith(".bin")]
            if not weights:
                raise RuntimeError("Diffusers did not write a PyTorch transformer checkpoint")
            receipt = {
                "identity": self.identity,
                "quantized_linear_names": list(quantized_linear_names),
                "video_only_transformer_blocks": video_only_transformer_blocks,
                "files": {path.name: self._stat(path) for path in files},
            }
            (temporary / _RECEIPT).write_text(
                json.dumps(receipt, sort_keys=True) + "\n", encoding="utf-8",
            )
            if self.path.exists():
                shutil.rmtree(self.path)
            os.replace(temporary, self.path)
        except Exception as error:  # noqa: BLE001 - persistence is optional; log and keep serving
            if temporary is not None:
                shutil.rmtree(temporary, ignore_errors=True)
            print(
                f"[sol-refiner] NVFP4 checkpoint was not persisted: "
                f"{type(error).__name__}: {error}",
                flush=True,
            )
            return
        print(f"[sol-refiner] persisted NVFP4 transformer at {self.path}", flush=True)

    def _is_valid(self) -> bool:
        try:
            receipt = json.loads((self.path / _RECEIPT).read_text(encoding="utf-8"))
            if not isinstance(receipt, dict) or receipt.get("identity") != self.identity:
                return False
            files = receipt.get("files")
            names = receipt.get("quantized_linear_names")
            video_only_blocks = receipt.get("video_only_transformer_blocks", 0)
            if (
                not isinstance(files, dict)
                or not files
                or any(not isinstance(name, str) or not isinstance(item, dict) for name, item in files.items())
                or not isinstance(names, list)
                or any(not isinstance(name, str) or not name for name in names)
                or isinstance(video_only_blocks, bool)
                or not isinstance(video_only_blocks, int)
                or video_only_blocks < 0
            ):
                return False
            return all(self._stat(self.path / name) == identity for name, identity in files.items())
        except (OSError, KeyError, TypeError, ValueError, AttributeError):
            return False

    @staticmethod
    def _stat(path: Path) -> dict[str, int]:
        status = path.stat()
        return {
            "size": status.st_size,
            "mtime_ns": status.st_mtime_ns,
            "inode": status.st_ino,
        }
