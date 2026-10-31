#!/usr/bin/env bash
set -euo pipefail

node_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
runtime_python="${PYTHON_BIN:-python3}"
worker_dir="$node_dir/.worker"
build_only=0
check_only=0
prepare_shared_vae_conditioning=0
for argument in "$@"; do
  case "$argument" in
    --build-only) build_only=1 ;;
    --check-only) check_only=1 ;;
    --prepare-shared-vae-conditioning) prepare_shared_vae_conditioning=1 ;;
    # Backward-compatible alias; the TorchAO FP4/FP8 runtime is installed by default.
    --with-fp8-experiment) ;;
    *)
      echo "Usage: install_runtime.sh [--build-only|--check-only|--prepare-shared-vae-conditioning]" >&2
      exit 2
      ;;
  esac
done

if [[ "$prepare_shared_vae_conditioning" == "1" ]]; then
  worker_python="$worker_dir/bin/python"
  repo_root="${COMFYSTREAM_ROOT:-/workspace/comfystream}"
  comfy_root="${COMFYUI_ROOT:-/workspace/ComfyUI}"
  [[ -x "$worker_python" ]] || {
    echo "Missing SoL worker runtime: $worker_python; install the worker first" >&2
    exit 1
  }
  [[ -f "$repo_root/scripts/prepare_h3_upscale_conditioning.py" ]] || {
    echo "Missing conditioning preparation script in $repo_root/scripts" >&2
    exit 1
  }
  HF_HOME="${HF_HOME:-/workspace/hf-cache}" \
    env -u PIP_CONSTRAINT -u UV_CONSTRAINT -u UV_PYTHON -u VIRTUAL_ENV \
    -u PYTHONPATH -u PYTHONHOME \
    "$worker_python" "$repo_root/scripts/prepare_h3_upscale_conditioning.py" \
    --comfyui-root "$comfy_root"
  exit 0
fi

"$runtime_python" - <<'PY'
import sys
import torch

if sys.version_info[:2] != (3, 12):
    raise SystemExit(f"SoL H3 refiner requires Python 3.12; found {sys.version.split()[0]}")
if torch.__version__ != "2.14.0+cu130" or torch.version.cuda != "13.0":
    raise SystemExit(
        "SoL H3 host must use FastH3's pinned PyTorch 2.14.0+cu130 / CUDA 13.0 "
        f"runtime; found {torch.__version__} / CUDA {torch.version.cuda}"
    )
PY

# The ComfyUI host's dependencies are provisioned by its profile's hash-locked
# environment. Do not run a second resolver here; only the isolated worker has
# a separate requirements lock to install.
if [[ "$check_only" == 1 ]]; then
  [[ -x "$worker_dir/bin/python" ]] || {
    echo "Missing SoL worker runtime: $worker_dir/bin/python" >&2
    exit 1
  }
elif [[ "$build_only" == 1 ]]; then
  "$runtime_python" "$node_dir/install.py" --prepare-worker "$worker_dir"
elif [[ ! -x "$worker_dir/bin/python" ]]; then
  "$runtime_python" -m venv "$worker_dir"
fi
worker_python="$worker_dir/bin/python"
# ComfyUI-Manager injects host constraints and a pip shim into its install.py
# subprocesses. These must not steer the independent Torch 2.13 worker.
worker_run() {
  env -u PIP_CONSTRAINT -u UV_CONSTRAINT -u UV_PYTHON -u VIRTUAL_ENV \
    -u PYTHONPATH -u PYTHONHOME "$worker_python" "$@"
}
if [[ "$check_only" != 1 ]]; then
  worker_run -m ensurepip --upgrade
  [[ -f "$node_dir/requirements-worker.lock" ]] || {
    echo "Missing hash-locked SoL worker requirements: $node_dir/requirements-worker.lock" >&2
    exit 1
  }
  worker_run -m pip install --require-hashes --only-binary=:all: \
    -r "$node_dir/requirements-worker.lock"
  # The resolver lock carries dependencies, while the existing immutable Git ref
  # supplies the pure-Python Diffusers source. Install it without resolving again.
  worker_run -m pip install --no-deps --no-build-isolation \
    "diffusers @ git+https://github.com/huggingface/diffusers.git@e0abab83b5df05de9e7abd788643c1a7c1e42e28"
fi

verify_cuda=0
if [[ "$build_only" == 1 || "$check_only" == 1 ]]; then verify_cuda=1; fi
worker_run - "$verify_cuda" <<'PY'
import sys
from importlib.metadata import version

import natten
import mslk
import torch
import triton
from torchao.prototype.mx_formats.inference_workflow import (
    MXDynamicActivationMXWeightConfig,
    NVFP4DynamicActivationNVFP4WeightConfig,
)

if sys.version_info[:2] != (3, 12):
    raise SystemExit(f"Expected worker Python 3.12; found {sys.version.split()[0]}")
if torch.__version__ != "2.13.0+cu130" or torch.version.cuda != "13.0":
    raise SystemExit(f"Unexpected worker runtime: {torch.__version__} / {torch.version.cuda}")
if sys.argv[1] != "1" and not torch.cuda.is_available():
    raise SystemExit("Worker PyTorch cannot access CUDA")
if not getattr(natten, "HAS_LIBNATTEN", False):
    raise SystemExit("Native NATTEN wheel did not load; refusing OOM-prone Flex backend")
if version("natten") != "0.21.7+torch2130cu130":
    raise SystemExit(f"Unexpected worker NATTEN wheel: {version('natten')}")
if triton.__version__ != "3.7.1":
    raise SystemExit(f"Expected worker Triton 3.7.1; found {triton.__version__}")
if version("torchao") != "0.17.0+cu130":
    raise SystemExit(f"Expected TorchAO 0.17.0+cu130; found {version('torchao')}")
if version("mslk") != "1.3.0+cu130":
    raise SystemExit(f"Expected MSLK 1.3.0+cu130; found {version('mslk')}")
MXDynamicActivationMXWeightConfig(
    activation_dtype=torch.float8_e4m3fn,
    weight_dtype=torch.float8_e4m3fn,
)
NVFP4DynamicActivationNVFP4WeightConfig(use_triton_kernel=True)
print(f"Worker runtime verified: PyTorch {torch.__version__}, CUDA {torch.version.cuda}, "
      f"NATTEN {natten.__version__}, TorchAO {version('torchao')}, "
      f"MSLK {version('mslk')}, native libnatten")
PY
