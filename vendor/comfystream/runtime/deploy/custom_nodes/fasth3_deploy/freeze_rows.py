"""Exact row movement for token freezing, with runtime-sized CUDA launches."""
from __future__ import annotations

from typing import TYPE_CHECKING, cast

if TYPE_CHECKING:
    from .kernel_types import TritonJit

import torch

try:
    import triton
    import triton.language as tl

    TRITON_AVAILABLE = True
except (ImportError, OSError, RuntimeError):  # pragma: no cover - deployment dependent
    triton = None
    tl = None
    TRITON_AVAILABLE = False


if TRITON_AVAILABLE:

    @cast("TritonJit", triton.jit)(do_not_specialize=[
        "row_count", "dst_stride", "src_stride", "dst_column_stride", "src_column_stride",
    ])
    def _copy_rows_kernel(
        dst: tl.tensor, src: tl.tensor, dst_indices: tl.tensor, src_indices: tl.tensor, row_count: tl.tensor,
        dst_stride: tl.tensor, src_stride: tl.tensor, dst_column_stride: tl.tensor, src_column_stride: tl.tensor,
        WIDTH: tl.constexpr, SKIP_NEGATIVE_DEST: tl.constexpr,
    ) -> None:
        offsets = tl.program_id(0) * 1024 + tl.arange(0, 1024)
        rows = offsets // WIDTH
        columns = offsets % WIDTH
        live = rows < row_count
        dst_rows = rows
        src_rows = rows
        if dst_indices is not None:
            dst_rows = tl.load(dst_indices + rows, mask=live, other=0)
            if SKIP_NEGATIVE_DEST:
                live &= dst_rows >= 0
        if src_indices is not None:
            src_rows = tl.load(src_indices + rows, mask=live, other=0)
        values = tl.load(
            src + src_rows * src_stride + columns * src_column_stride,
            mask=live, other=0,
        )
        tl.store(
            dst + dst_rows * dst_stride + columns * dst_column_stride,
            values, mask=live,
        )

    @cast("TritonJit", triton.jit)(do_not_specialize=[
        "row_count", "active_stride", "active_column_stride",
    ])
    def _scatter_active_kernel(
        active: tl.tensor, row_positions: tl.tensor, output: tl.tensor, row_count: tl.tensor, active_stride: tl.tensor, active_column_stride: tl.tensor,
        WIDTH: tl.constexpr,
    ) -> None:
        offsets = tl.program_id(0) * 1024 + tl.arange(0, 1024)
        rows = offsets // WIDTH
        columns = offsets % WIDTH
        live = rows < row_count
        positions = tl.load(row_positions + rows, mask=live, other=-1)
        values = tl.load(
            active + positions * active_stride + columns * active_column_stride,
            mask=live & (positions >= 0), other=0,
        )
        tl.store(output + offsets, values, mask=live)

    @cast("TritonJit", triton.jit)(do_not_specialize=[
        "row_count", "cache_stride", "active_stride",
    ])
    def _gather_cached_active_kernel(
        cache: tl.tensor, active: tl.tensor, cache_slots: tl.tensor, active_positions: tl.tensor, output: tl.tensor, row_count: tl.tensor,
        cache_stride: tl.tensor, active_stride: tl.tensor, WIDTH: tl.constexpr,
    ) -> None:
        offsets = tl.program_id(0) * 1024 + tl.arange(0, 1024)
        rows = offsets // WIDTH
        columns = offsets % WIDTH
        live = rows < row_count
        slots = tl.load(cache_slots + rows, mask=live, other=-1)
        positions = tl.load(active_positions + rows, mask=live, other=-1)
        cached = live & (slots >= 0)
        active_row = live & (slots < 0) & (positions >= 0)
        cached_values = tl.load(
            cache + slots * cache_stride + columns,
            mask=cached, other=0,
        )
        active_values = tl.load(
            active + positions * active_stride + columns,
            mask=active_row, other=0,
        )
        values = tl.where(cached, cached_values, active_values)
        tl.store(output + offsets, values, mask=live)

    @cast("TritonJit", triton.jit)(do_not_specialize=[
        "row_count", "cache_stride", "active_stride",
    ])
    def _gather_cached_kv_active_qkv_kernel(
        kv_cache: tl.tensor, active_qkv: tl.tensor, cache_slots: tl.tensor, active_positions: tl.tensor, output: tl.tensor, row_count: tl.tensor,
        cache_stride: tl.tensor, active_stride: tl.tensor, WIDTH: tl.constexpr, Q_WIDTH: tl.constexpr,
    ) -> None:
        offsets = tl.program_id(0) * 1024 + tl.arange(0, 1024)
        rows = offsets // WIDTH
        columns = offsets % WIDTH
        live = rows < row_count
        slots = tl.load(cache_slots + rows, mask=live, other=-1)
        positions = tl.load(active_positions + rows, mask=live, other=-1)
        cached = live & (slots >= 0)
        active_row = live & (slots < 0) & (positions >= 0)
        query_column = columns < Q_WIDTH
        q_values = tl.load(
            active_qkv + positions * active_stride + columns,
            mask=active_row & query_column, other=0,
        )
        kv_cache_values = tl.load(
            kv_cache + slots * cache_stride + columns - Q_WIDTH,
            mask=cached & ~query_column, other=0,
        )
        kv_active_values = tl.load(
            active_qkv + positions * active_stride + columns,
            mask=active_row & ~query_column, other=0,
        )
        values = tl.where(
            query_column, q_values,
            tl.where(cached, kv_cache_values, kv_active_values),
        )
        tl.store(output + offsets, values, mask=live)


def _check_indices(indices: torch.Tensor | None, device: torch.device, name: str) -> None:
    if indices is not None and (
        indices.ndim != 1 or indices.dtype not in (torch.int32, torch.int64)
        or indices.device != device
    ):
        raise ValueError(f"{name} must be a one-dimensional integer tensor on {device}")


def copy_rows_(
    dst: torch.Tensor,
    src: torch.Tensor,
    *,
    dst_indices: torch.Tensor | None = None,
    src_indices: torch.Tensor | None = None,
    row_count: int | None = None,
) -> torch.Tensor:
    """Copy indexed 2D rows exactly; destination indices must be unique.

    Source/destination storage must not overlap. Indices must be in bounds;
    CUDA callers supply validated row plans without host scalar checks.
    Missing indices mean consecutive rows starting at zero.
    """
    if dst.ndim != 2 or src.ndim != 2 or dst.shape[1] != src.shape[1]:
        raise ValueError("row copies require two matrices with matching widths")
    if dst.dtype != src.dtype or dst.device != src.device:
        raise ValueError("row copies require a shared dtype and device")
    _check_indices(dst_indices, dst.device, "dst_indices")
    _check_indices(src_indices, src.device, "src_indices")
    dst_rows = dst.shape[0] if dst_indices is None else dst_indices.numel()
    src_rows = src.shape[0] if src_indices is None else src_indices.numel()
    if row_count is None:
        if dst_indices is not None:
            row_count = dst_rows
        elif src_indices is not None:
            row_count = src_rows
        elif dst_rows == src_rows:
            row_count = dst_rows
        else:
            raise ValueError("different row counts require indices or an explicit row_count")
    if row_count < 0 or row_count > min(dst_rows, src_rows):
        raise ValueError("row_count exceeds source or destination row coverage")
    if not row_count or not dst.shape[1]:
        return dst
    if dst.device.type == "cuda" and TRITON_AVAILABLE:
        _copy_rows_kernel[(triton.cdiv(row_count * dst.shape[1], 1024),)](
            dst, src, dst_indices, src_indices, row_count,
            dst.stride(0), src.stride(0), dst.stride(1), src.stride(1),
            WIDTH=dst.shape[1], SKIP_NEGATIVE_DEST=False,
        )
    else:
        selected = src[:row_count] if src_indices is None else src.index_select(0, src_indices[:row_count])
        if dst_indices is None:
            dst[:row_count].copy_(selected)
        else:
            dst.index_copy_(0, dst_indices[:row_count].to(dtype=torch.long), selected)
    return dst


def scatter_selected_rows_(
    dst: torch.Tensor, src: torch.Tensor, dst_indices: torch.Tensor,
) -> torch.Tensor:
    """Copy source rows whose destination index is non-negative; skip sentinels."""
    if dst.ndim != 2 or src.ndim != 2 or dst.shape[1] != src.shape[1]:
        raise ValueError("row scatters require two matrices with matching widths")
    if dst.dtype != src.dtype or dst.device != src.device:
        raise ValueError("row scatters require a shared dtype and device")
    _check_indices(dst_indices, src.device, "dst_indices")
    if dst_indices.numel() != src.shape[0]:
        raise ValueError("destination indices must cover every source row")
    if not src.shape[0] or not src.shape[1]:
        return dst
    if dst.device.type == "cuda" and TRITON_AVAILABLE:
        _copy_rows_kernel[(triton.cdiv(src.numel(), 1024),)](
            dst, src, dst_indices, None, src.shape[0],
            dst.stride(0), src.stride(0), dst.stride(1), src.stride(1),
            WIDTH=src.shape[1], SKIP_NEGATIVE_DEST=True,
        )
    else:
        selected = dst_indices >= 0
        if selected.any():
            dst.index_copy_(
                0, dst_indices[selected].to(dtype=torch.long), src[selected]
            )
    return dst


def scatter_active_rows(
    active: torch.Tensor, active_row_positions: torch.Tensor,
) -> torch.Tensor:
    """Expand active [rows,width] to full rows; inverse-map -1 entries become zero."""
    if active.ndim != 2:
        raise ValueError("active rows must be a matrix")
    _check_indices(active_row_positions, active.device, "active_row_positions")
    rows, width = active_row_positions.numel(), active.shape[1]
    output = active.new_empty((rows, width))
    if not rows or not width:
        return output
    if active.device.type == "cuda" and TRITON_AVAILABLE:
        _scatter_active_kernel[(triton.cdiv(rows * width, 1024),)](
            active, active_row_positions, output, rows, active.stride(0), active.stride(1),
            WIDTH=width,
        )
    else:
        output.zero_()
        live = active_row_positions >= 0
        output[live] = active.index_select(0, active_row_positions[live])
    return output


def gather_cached_active_rows(
    cache: torch.Tensor,
    active: torch.Tensor,
    cache_slots: torch.Tensor,
    active_positions: torch.Tensor,
) -> torch.Tensor:
    """Select each output row from cache or live QKV in one output pass.

    A nonnegative cache slot takes precedence. Rows with both indices negative
    are zero padded, which lets the CUDA path avoid full-width where buffers.
    """
    if (cache.ndim != 2 or active.ndim != 2 or cache.shape[1] != active.shape[1]
            or cache.dtype != active.dtype or cache.device != active.device):
        raise ValueError("cached and active rows must be compatible matrices")
    _check_indices(cache_slots, cache.device, "cache_slots")
    _check_indices(active_positions, active.device, "active_positions")
    if cache_slots.shape != active_positions.shape:
        raise ValueError("cache slots and active positions must have matching lengths")
    row_count, width = cache_slots.numel(), cache.shape[1]
    output = cache.new_empty((row_count, width))
    if not row_count or not width:
        return output
    if cache.device.type == "cuda" and TRITON_AVAILABLE:
        _gather_cached_active_kernel[(triton.cdiv(row_count * width, 1024),)](
            cache, active, cache_slots, active_positions, output, row_count,
            cache.stride(0), active.stride(0), WIDTH=width,
        )
    else:
        output.zero_()
        cached = cache_slots >= 0
        if cached.any():
            output[cached] = cache.index_select(0, cache_slots[cached].to(torch.long))
        live = ~cached & (active_positions >= 0)
        if live.any():
            output[live] = active.index_select(0, active_positions[live].to(torch.long))
    return output


def gather_cached_kv_active_qkv(
    kv_cache: torch.Tensor,
    active_qkv: torch.Tensor,
    cache_slots: torch.Tensor,
    active_positions: torch.Tensor,
) -> torch.Tensor:
    """Assemble Q/K/V rows from live QKV and cached K/V, zeroing cached Q.

    This is valid when frozen query blocks are skipped. Cached rows still
    provide K/V context, but their Q values are unused by those blocks.
    """
    if (kv_cache.ndim != 2 or active_qkv.ndim != 2
            or active_qkv.shape[1] % 3
            or kv_cache.shape[1] != (active_qkv.shape[1] // 3) * 2
            or kv_cache.dtype != active_qkv.dtype
            or kv_cache.device != active_qkv.device):
        raise ValueError("cached K/V and active QKV rows must have compatible widths")
    _check_indices(cache_slots, kv_cache.device, "cache_slots")
    _check_indices(active_positions, active_qkv.device, "active_positions")
    if cache_slots.shape != active_positions.shape:
        raise ValueError("cache slots and active positions must have matching lengths")
    row_count, width = cache_slots.numel(), active_qkv.shape[1]
    output = active_qkv.new_zeros((row_count, width))
    if not row_count or not width:
        return output
    if active_qkv.device.type == "cuda" and TRITON_AVAILABLE:
        _gather_cached_kv_active_qkv_kernel[(triton.cdiv(row_count * width, 1024),)](
            kv_cache, active_qkv, cache_slots, active_positions, output, row_count,
            kv_cache.stride(0), active_qkv.stride(0),
            WIDTH=width, Q_WIDTH=width // 3,
        )
        return output

    cached = cache_slots >= 0
    if cached.any():
        output[cached, width // 3:] = kv_cache.index_select(
            0, cache_slots[cached].to(dtype=torch.long)
        )
    live = ~cached & (active_positions >= 0)
    if live.any():
        output[live] = active_qkv.index_select(
            0, active_positions[live].to(dtype=torch.long)
        )
    return output
