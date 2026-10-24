from __future__ import annotations

import importlib.util
from pathlib import Path

ROOT = Path(__file__).parents[2] / "runtime/deploy/custom_nodes/fasth3_deploy"
SPEC = importlib.util.spec_from_file_location("fasth3_trim_five_step_contract", ROOT / "contract.py")
assert SPEC and SPEC.loader
contract = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(contract)


def test_five_step_trim_schedule_keeps_four_step_points_and_adds_published_125() -> None:
    sigmas = contract.video_sigmas("v2-5step-subsampled")
    assert len(sigmas) - 1 == 5
    assert sigmas == tuple(
        10.0 * position / (1.0 + 9.0 * position)
        for position in (0.999, 0.749, 0.5, 0.25, 0.125, 0.0)
    )
