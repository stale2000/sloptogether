"""The Triton JIT launch surface consumed by the local GPU adapters."""
from __future__ import annotations

from collections.abc import Callable
from typing import Protocol, overload


class TritonKernel(Protocol):
    # Triton adds launch-only keywords (num_warps, num_stages, etc.) to the JIT signature.
    def __getitem__(self, grid: tuple[int, ...]) -> Callable[..., None]: ...  # type: ignore[explicit-any]


class TritonJit(Protocol):
    @overload
    def __call__[**P](self, function: Callable[P, None], /) -> TritonKernel: ...

    @overload
    def __call__[**P](self, *, do_not_specialize: list[str]) -> Callable[[Callable[P, None]], TritonKernel]: ...
