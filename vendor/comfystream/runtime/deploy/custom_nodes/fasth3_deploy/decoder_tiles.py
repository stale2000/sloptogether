"""H3 decoder tile grouping, bounded staging, and output assembly."""
from __future__ import annotations

import sys
from collections.abc import Callable, Iterable, Iterator
from contextlib import contextmanager, nullcontext
from typing import TYPE_CHECKING, Protocol, TypedDict, Unpack, cast

if TYPE_CHECKING:
    from comfy.ldm.minimax.vae import MiniMaxH3VideoVAE

import torch

try:
    from .nvtx import nvtx_range
except ImportError:
    def nvtx_range(_name: str) -> nullcontext[None]:  # type: ignore[misc]
        return nullcontext()
class _TensorOwnership(Protocol):
    def _use_count(self) -> int: ...


class _StorageOwnership(Protocol):
    def _storage_Use_Count(self, storage_id: int) -> int: ...
    def _storage_id(self, tensor: torch.Tensor) -> int: ...


class _TensorSplit(Protocol):
    def __call__(self, split_size: int, *, dim: int) -> tuple[torch.Tensor, ...]: ...


class CanvasCache(TypedDict, total=False):
    key: tuple[object, ...]
    canvas: torch.Tensor


class TileBatchOptions(TypedDict, total=False):
    bounded: bool
    reuse_staging: bool
    persistent_canvas: bool
    report: dict[str, int] | None
    staging_capacity: int
    elide_owned_clone: bool


_TILE_BATCH_ATTR = "_fasth3_tile_batch"

def _independently_owned_decode_output(output: torch.Tensor) -> bool:
    """Conservative eager ownership proof; unavailable probes keep the clone.

    A view check alone misses detach() aliases and static graph tensors. Require
    a unique Python reference, TensorImpl, and storage. Query the storage id
    without constructing a Python Storage wrapper (which adds an owner).
    The Python refcount includes the caller, this argument, and getrefcount.
    """
    if type(output) is not torch.Tensor or output._base is not None:
        return False
    try:
        return bool(sys.getrefcount(output) == 3
                and cast(_TensorOwnership, output)._use_count() == 1
                and cast(_StorageOwnership, torch._C)._storage_Use_Count(
                    cast(_StorageOwnership, torch._C)._storage_id(output)
                ) == 1)
    except (AttributeError, RuntimeError, TypeError):
        return False

def iter_decode_tile_groups(decode_fn: Callable[[torch.Tensor], torch.Tensor], tiles: list[torch.Tensor] | tuple[torch.Tensor, ...], batch_size: int=3, staging: dict[tuple[object, ...], torch.Tensor] | None=None, report: dict[str, int] | None=None,
                            *, clone_output: bool | None=None, staging_capacity: int=1, elide_owned_clone: bool=False) -> Iterator[torch.Tensor]:
    """Yield existing batch groups in order; never regroup quantized inputs.

    Staging is request-owned and bounded (one shape by default). Buffers from
    distinct CUDA streams never alias. Default clone protects ``list()`` callers
    when decode returns a view. Optional clone elision requires exclusive eager
    tensor/storage ownership, otherwise it retains the protective clone.
    Bounded tiled_decode copies into the canvas and overlap tails before the next
    group, so pass ``clone_output=False`` there (same B13 falsifier otherwise).
    """
    from .decoder_optimizations import _execution_stream, ensure_omega_decoder_counters
    if batch_size < 1:
        raise ValueError("batch_size must be positive")
    if type(staging_capacity) is not int or staging_capacity not in (1, 2):
        raise ValueError("staging_capacity must be 1 or 2")
    if report is not None:
        ensure_omega_decoder_counters(report)
    if clone_output is None:
        clone_output = staging is not None
    for start in range(0, len(tiles), batch_size):
        group = tiles[start:start + batch_size]
        if report is not None:
            report['groups'] = report.get('groups', 0) + 1
        if len(group) == 1:
            yield decode_fn(group[0])
            continue
        if staging is None or torch.is_grad_enabled():
            stacked = torch.cat(group, dim=0)
            if report is not None:
                report['concat_allocations'] = report.get('concat_allocations', 0) + 1
                report['concat_result_bytes'] = report.get('concat_result_bytes', 0) + stacked.numel() * stacked.element_size()
        else:
            first = group[0]
            stream = _execution_stream(first)
            key = (tuple(first.shape), first.dtype, first.device, len(group), stream)
            if any(t.shape != first.shape or t.dtype != first.dtype or t.device != first.device for t in group):
                raise ValueError('staging requires identical tile shapes, dtypes and devices')
            if key not in staging:
                # A cache entry made on another stream cannot be reused
                # without an event edge.  Keep the stream in the key and
                # expose the invalidation separately from capacity evictions
                # so OMEGA can distinguish a safe miss from bounded-cache
                # pressure.
                if report is not None and any(
                        len(prior) >= 5 and prior[:4] == key[:4] and prior[4] != stream
                        for prior in staging):
                    report['staging_stream_invalidations'] = report.get(
                        'staging_stream_invalidations', 0) + 1
                while len(staging) >= staging_capacity:
                    del staging[next(iter(staging))]
                    if report is not None:
                        report['staging_evictions'] = report.get('staging_evictions', 0) + 1
                staging[key] = first.new_empty((sum(t.shape[0] for t in group), *first.shape[1:]))
                if report is not None:
                    report['staging_allocations'] = report.get('staging_allocations', 0) + 1
                    report['staging_peak_buffers'] = max(report.get('staging_peak_buffers', 0), len(staging))
            elif report is not None:
                report['staging_reuses'] = report.get('staging_reuses', 0) + 1
            stacked = staging[key]
            offset = 0
            for tile in group:
                stacked[offset:offset + tile.shape[0]].copy_(tile)
                offset += tile.shape[0]
                if report is not None:
                    report['staging_copy_calls'] = report.get('staging_copy_calls', 0) + 1
                    report['staging_copy_bytes'] = report.get('staging_copy_bytes', 0) + tile.numel() * tile.element_size()
            if report is not None:
                report['staged_groups'] = report.get('staged_groups', 0) + 1
        output = decode_fn(stacked)
        if clone_output:
            if elide_owned_clone and not torch.is_grad_enabled() and _independently_owned_decode_output(output):
                if report is not None:
                    report['output_clones_avoided'] = report.get('output_clones_avoided', 0) + 1
                    report['output_clone_bytes_avoided'] = report.get('output_clone_bytes_avoided', 0) + output.numel() * output.element_size()
            else:
                output = output.clone()
                if report is not None:
                    report['output_clone_calls'] = report.get('output_clone_calls', 0) + 1
                    report['output_clone_bytes'] = report.get('output_clone_bytes', 0) + output.numel() * output.element_size()
        yield from cast(_TensorSplit, output.split)(1, dim=0)

def decode_tiles_batched(decode_fn: Callable[[torch.Tensor], torch.Tensor], tiles: list[torch.Tensor] | tuple[torch.Tensor, ...], batch_size: int = 3) -> list[torch.Tensor]:
    """Decode same-shaped independent latents, optionally stacked on batch.

    Attention/FF are per-batch-item. Stacking is value-identical to sequential
    calls on deterministic backends; callers must still check equality on GPU.
    """
    if batch_size <= 1 or len(tiles) <= 1:
        return [decode_fn(tile) for tile in tiles]
    outs = []
    for start in range(0, len(tiles), batch_size):
        group = tiles[start:start + batch_size]
        if len(group) == 1:
            outs.append(decode_fn(group[0]))
            continue
        stacked = torch.cat(group, dim=0)
        outs.extend(cast(_TensorSplit, decode_fn(stacked).split)(1, dim=0))
    return outs

def _tiled_decode_batched(vae: MiniMaxH3VideoVAE, z: torch.Tensor, batch_size: int, original: Callable[[torch.Tensor], torch.Tensor], *, bounded: bool=False, staging: dict[tuple[object, ...], torch.Tensor] | None=None,
                          persistent_canvas: CanvasCache | None=None, report: dict[str, int] | None=None, staging_capacity: int=1,
                          elide_owned_clone: bool=False) -> torch.Tensor | None:
    """Native spatial tiled_decode, with one decoder forward per row group."""
    if batch_size <= 1 or z.shape[0] != 1:
        return original(z)
    height, width = z.shape[-2] * vae.vae_ratio, z.shape[-1] * vae.vae_ratio
    y_idx, y_len, y_overlap = vae.split_tiles(height)
    x_idx, x_len, x_overlap = vae.split_tiles(width)
    if len(x_idx) <= 1:
        return original(z)

    canvas = None
    strip = None
    out_y = 0
    for i, (i_pos, i_len) in enumerate(zip(y_idx, y_len)):
        zi, zl = i_pos // vae.vae_ratio, i_len // vae.vae_ratio
        new_strip = None
        left_tail = None
        out_x = 0
        latents = []
        for j_pos, j_len in zip(x_idx, x_len):
            zj, zw = j_pos // vae.vae_ratio, j_len // vae.vae_ratio
            latents.append(z[..., zi:zi + zl, zj:zj + zw])
        decoded: Iterable[torch.Tensor]
        if bounded or staging is not None:
            decoded = iter_decode_tile_groups(
                vae._decode_pixels, latents, batch_size, staging, report,
                clone_output=staging is not None and not bounded,
                staging_capacity=staging_capacity, elide_owned_clone=elide_owned_clone)
            if not bounded:
                decoded = list(decoded)
        else:
            decoded = decode_tiles_batched(vae._decode_pixels, latents, batch_size)
        for j, (j_pos, j_len, tile) in enumerate(zip(x_idx, x_len, decoded)):
            if i > 0:
                assert strip is not None
                tile = vae.blend(strip[..., :, j_pos:j_pos + j_len], tile,
                                 y_overlap[i - 1], dim=-2)
            if j > 0:
                assert left_tail is not None
                tile = vae.blend(left_tail, tile, x_overlap[j - 1], dim=-1)
            left_tail = tile[..., :, -x_overlap[j]:].clone() if j < len(x_idx) - 1 else None
            if j < len(x_idx) - 1:
                tile = tile[..., :, :-x_overlap[j]]
            if i < len(y_idx) - 1:
                if new_strip is None:
                    new_strip = torch.empty(*tile.shape[:-2], y_overlap[i], width,
                                            dtype=tile.dtype, device=tile.device)
                new_strip[..., :, out_x:out_x + tile.shape[-1]].copy_(
                    tile[..., -y_overlap[i]:, :])
                tile = tile[..., :-y_overlap[i], :]
            if canvas is None:
                dtype = tile.dtype
                try:
                    from .temporal_cat import canvas_dtype_name
                except ImportError:
                    from temporal_cat import canvas_dtype_name as _standalone_canvas_dtype_name   # noqa: I001
                    canvas_dtype_name = _standalone_canvas_dtype_name
                cat_name = canvas_dtype_name(vae)
                if cat_name:
                    dtype = getattr(torch, cat_name)
                shape = (*tile.shape[:-2], height, width)
                key = (shape, dtype, tile.device)
                if persistent_canvas is not None:
                    cached = persistent_canvas.get("canvas")
                    if persistent_canvas.get("key") == key and cached is not None:
                        canvas = cached
                        if report is not None:
                            report['canvas_reuses'] = report.get('canvas_reuses', 0) + 1
                    else:
                        canvas = torch.empty(*shape, dtype=dtype, device=tile.device)
                        cast(dict[str, object], persistent_canvas).clear()
                        persistent_canvas.update({"key": key, "canvas": canvas})
                        if report is not None:
                            report['canvas_allocations'] = report.get('canvas_allocations', 0) + 1
                else:
                    canvas = torch.empty(*shape, dtype=dtype, device=tile.device)
            if tile.dtype != canvas.dtype:
                tile = tile.to(dtype=canvas.dtype)
            canvas[..., out_y:out_y + tile.shape[-2], out_x:out_x + tile.shape[-1]].copy_(tile)
            out_x += tile.shape[-1]
        strip = new_strip
        out_y += tile.shape[-2]
    if persistent_canvas is not None:
        # The cached canvas is private and reused on the next request. Return a
        # distinct public IMAGE so Comfy/output consumers cannot observe a
        # later request overwriting this storage.
        if report is not None and canvas is not None:
            report['canvas_public_clone_bytes'] = canvas.numel() * canvas.element_size()
        assert canvas is not None
        return canvas.clone()
    return canvas

def apply_tile_batch(vae: MiniMaxH3VideoVAE, batch_size: int = 3, *, bounded: bool=False, reuse_staging: bool=False,
                     persistent_canvas: bool=False, report: dict[str, int] | None=None, staging_capacity: int=1,
                     elide_owned_clone: bool=False) -> int:
    """Opt-in spatial-row decoder micro-batch. ``1`` restores sequential tiles."""
    if type(staging_capacity) is not int or staging_capacity not in (1, 2):
        raise ValueError("staging_capacity must be 1 or 2")
    restore_tile_batch(vae)
    if batch_size <= 1:
        return 1
    original = vae.tiled_decode
    staging: dict[tuple[object, ...], torch.Tensor] | None = {} if reuse_staging else None
    canvas_cache = getattr(vae, '_fasth3_persistent_canvas_cache', None) if persistent_canvas else None
    if persistent_canvas and canvas_cache is None:
        canvas_cache = {}
        vae._fasth3_persistent_canvas_cache = canvas_cache
    elif not persistent_canvas:
        # Disabling the experiment must release its private retained canvas.
        vae.__dict__.pop('_fasth3_persistent_canvas_cache', None)

    def tiled_decode(z: torch.Tensor) -> torch.Tensor | None:
        return _tiled_decode_batched(vae, z, batch_size, original, bounded=bounded,
                                     staging=staging, persistent_canvas=canvas_cache, report=report,
                                     staging_capacity=staging_capacity, elide_owned_clone=elide_owned_clone)

    vae.tiled_decode = tiled_decode
    setattr(vae, _TILE_BATCH_ATTR, {"original": original, "batch_size": int(batch_size),
                                   "staging": staging, "report": report})
    return int(batch_size)

def restore_tile_batch(vae: MiniMaxH3VideoVAE) -> bool:
    state = getattr(vae, _TILE_BATCH_ATTR, None)
    if state is None:
        return False
    vae.tiled_decode = state["original"]
    if state.get("staging") is not None:
        state["staging"].clear()
        if state.get("report") is not None:
            state["report"]["staging_buffers_after_restore"] = 0
    delattr(vae, _TILE_BATCH_ATTR)
    return True

@contextmanager
def tile_batch(vae: MiniMaxH3VideoVAE, batch_size: int = 3, **kwargs: Unpack[TileBatchOptions]) -> Iterator[int]:
    applied = apply_tile_batch(vae, batch_size, **kwargs)
    try:
        yield applied
    finally:
        restore_tile_batch(vae)

@contextmanager
def tile_timing(vae: MiniMaxH3VideoVAE) -> Iterator[bool]:
    """Bracket each spatial-tile decoder call in a ``decode_tile`` stage range.

    Diagnostic only. The wrapper is installed for the duration of the block and
    always removed, so the measured latency path never carries it. Under native
    defaults at 640 square this fires once per spatial tile per temporal chunk,
    which is how the ~189 tile calls become a measured number instead of an
    arithmetic estimate.
    """
    original = getattr(vae, "_decode_pixels", None)
    if not callable(original):
        # Not the native H3 VAE. Say so rather than silently measuring nothing.
        yield False
        return

    def _decode_pixels(z: torch.Tensor) -> torch.Tensor:
        with nvtx_range("decode_tile"):
            return cast(torch.Tensor, original(z))

    vae._decode_pixels = _decode_pixels
    try:
        yield True
    finally:
        try:
            del vae._decode_pixels
        except AttributeError:
            vae._decode_pixels = original
        if getattr(vae, "_decode_pixels", None) is not original:
            vae._decode_pixels = original
