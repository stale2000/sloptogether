"""C4: fold ViT3DDecoder permute+contiguous into a single reshape.

Default path keeps ``permute().contiguous().reshape()``. The opt-in
``reshape`` mode drops the explicit contiguous; PyTorch still copies if the
permuted view is not compatible with the destination layout.
"""
from __future__ import annotations

from typing import TYPE_CHECKING, Protocol

if TYPE_CHECKING:
    from torch import Tensor


class DecoderGeometry(Protocol):
    out_channels: int
    patch_size_t: int
    patch_size: int


def fold_vit3d_output(output: Tensor, decoder: DecoderGeometry, *, skip_contiguous: bool = False) -> Tensor:
    B = output.shape[0]
    folded = output.permute(0, 4, 1, 5, 2, 6, 3, 7)
    if not skip_contiguous:
        folded = folded.contiguous()
    return folded.reshape(
        B,
        decoder.out_channels,
        output.shape[1] * decoder.patch_size_t,
        output.shape[2] * decoder.patch_size,
        output.shape[3] * decoder.patch_size,
    )
