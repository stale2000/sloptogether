"""Persistent isolated multi-device worker for the optional shared VAE test."""
from __future__ import annotations

import json
import os
import sys
from contextlib import redirect_stdout
from pathlib import Path

os.environ.pop("PYTORCH_CUDA_ALLOC_CONF", None)
os.environ.setdefault("PYTORCH_ALLOC_CONF", "expandable_segments:True")
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from comfystream_sol_refiner_h3.protocol import parse_worker_request, serve_requests
from comfystream_sol_refiner_h3.shared_vae import run


def serve() -> None:
    serve_requests(run)


def main() -> None:
    if len(sys.argv) != 2:
        raise SystemExit("usage: shared_vae_worker.py REQUEST.json | --serve")
    if sys.argv[1] == "--serve":
        serve()
        return
    request = parse_worker_request(json.loads(Path(sys.argv[1]).read_text()))
    with redirect_stdout(sys.stderr):
        report = run(request)
    print(json.dumps(report, sort_keys=True), flush=True)


if __name__ == "__main__":
    main()
