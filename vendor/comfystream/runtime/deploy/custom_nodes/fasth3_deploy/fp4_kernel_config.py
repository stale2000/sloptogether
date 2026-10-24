"""Process-wide NVFP4 fused-MLP kernel knobs, set at model load for a request."""
from __future__ import annotations

from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from .vendor.fused_mlp.kernel import choose_blocks_per_program
else:
    try:
        from .vendor.fused_mlp.kernel import choose_blocks_per_program
    except ImportError:  # pragma: no cover - standalone contract tests import this file first
        from vendor.fused_mlp.kernel import choose_blocks_per_program as _standalone_choose_blocks_per_program  # noqa: I001

        choose_blocks_per_program = _standalone_choose_blocks_per_program

_state = {"blocks_per_program": 0}


def set_fp4_kernel(*, blocks_per_program: int | None = None) -> dict[str, int]:
    if blocks_per_program is not None:
        if blocks_per_program != 0:
            choose_blocks_per_program(1, blocks_per_program)
        _state["blocks_per_program"] = int(blocks_per_program)
    return dict(_state)


def fp4_kernel_options() -> dict[str, int]:
    return dict(_state)
