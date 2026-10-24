#!/usr/bin/env bash
set -euo pipefail

export COMFYSTREAM_ROOT=/opt/comfystream
export COMFYUI_ROOT=/data/fasth3-models
export HF_REVISION_FASTVIDEO=ec1e3aa374a91c57b0b94a1623b7e657c0498cf2
export HF_HOME=/data/.cache/huggingface
export TORCHINDUCTOR_CACHE_DIR=/data/torchinductor
export TRITON_CACHE_DIR=/data/triton
export CUDA_CACHE_PATH=/data/cuda-cache

mkdir -p "$COMFYUI_ROOT" /data/.cache/huggingface /data/torchinductor /data/triton /data/cuda-cache

if [[ "${FASTH3_BUILD_NATIVE_VC:-0}" == "1" ]]; then
  echo "Building the opt-in SM120 native VC attention artifact for this temporary benchmark run" >&2
  /opt/venv-fasth3/bin/python \
    /opt/ComfyUI/custom_nodes/fasth3_deploy/native_attention/build.py --arch 120
fi

PYTHON_BIN=/opt/venv-fasth3/bin/python \
COMFYSTREAM_MANIFEST=/opt/comfystream/deploy/vast/fasth3-environment.json \
FASTH3_SKIP_FINAL_REHASH=1 \
  bash /opt/comfystream/scripts/download_fasth3_models.sh

# The live ComfyStreamer default is the five-step Trim B1 candidate. Keep its
# checkpoint pinned independently from the V2 model set above.
trim_model="$COMFYUI_ROOT/models/diffusion_models/fastvideo_fasth3_trim_8step_int8_convrot.safetensors"
trim_revision="f66c13dc17391dd4da99242a407918b92bf7d5fc"
trim_sha256="ff6e40bc592f7362ea0d7bfcf4e0402bb2c26376d9d1bd4fffb047a5203c2153"
actual_trim_sha256=""
if [[ -f "$trim_model" ]]; then
  if /opt/venv-fasth3/bin/python - \
    /opt/comfystream/deploy/fal/fasth3-b1/shared-model-stat-receipt.json \
    "$trim_model" "$trim_sha256" <<'PY'
import json
import os
import sys
from pathlib import Path

receipt_path, model_path, expected_hash = sys.argv[1:]
try:
    receipt = json.loads(Path(receipt_path).read_text(encoding="utf-8"))
    record = receipt["models"][Path(model_path).name]
    stat = os.stat(model_path)
except (OSError, KeyError, TypeError, ValueError):
    raise SystemExit(1)
matches = (
    receipt.get("schema") == "comfystream-fasth3-stat-receipt/1"
    and record.get("sha256") == expected_hash
    and record.get("size") == stat.st_size
    and record.get("mtime_ns") == stat.st_mtime_ns
    and record.get("inode") == stat.st_ino
)
raise SystemExit(0 if matches else 1)
PY
  then
    actual_trim_sha256="$trim_sha256"
    echo "Stat-verified existing Trim checkpoint"
  else
    actual_trim_sha256="$(sha256sum "$trim_model" | awk '{print $1}')"
  fi
fi
if [[ "$actual_trim_sha256" != "$trim_sha256" ]]; then
  /opt/venv-fasth3/bin/hf download FastVideo/FastVideo-FastH3-Trim-Comfy \
    diffusion_models/fastvideo_fasth3_trim_8step_int8_convrot.safetensors \
    --revision "$trim_revision" --local-dir "$COMFYUI_ROOT/models"
  actual_trim_sha256="$(sha256sum "$trim_model" | awk '{print $1}')"
fi
[[ "$actual_trim_sha256" == "$trim_sha256" ]] || {
  echo "Trim checkpoint SHA mismatch: $actual_trim_sha256" >&2
  exit 1
}

/opt/venv-fasth3/bin/python - <<'PY'
import importlib.metadata
import json
from pathlib import Path
import torch

manifest = json.loads(Path("/opt/comfystream/deploy/vast/fasth3-environment.json").read_text())
assert torch.cuda.is_available(), "Fal runner has no CUDA device"
assert torch.cuda.device_count() == 1, f"Expected exactly one GPU; found {torch.cuda.device_count()}"
assert torch.__version__ == manifest["torch"], torch.__version__
assert torch.version.cuda == manifest["torch_cuda"], torch.version.cuda
for package in ("torchvision", "torchaudio", "comfy-kitchen", "comfy-aimdo", "triton"):
    actual = importlib.metadata.version(package)
    assert actual == manifest[package], f"{package}: expected {manifest[package]}, found {actual}"
name = torch.cuda.get_device_name(0)
print(json.dumps({
    "gpu_count": torch.cuda.device_count(),
    "gpu_name": name,
    "torch": torch.__version__,
    "cuda": torch.version.cuda,
    "profile": "fp4-mlp-fused-fasth3-trim-5step-vsa20-b1-candidate",
}, sort_keys=True), flush=True)
PY

ffmpeg -hide_banner -loglevel error -f lavfi -i color=c=black:s=256x256:d=0.1 \
  -frames:v 1 -c:v h264_nvenc -f null -

mkdir -p /tmp/fasth3-user /tmp/fasth3-output /tmp/fasth3-temp
exec /opt/venv-fasth3/bin/python /opt/ComfyUI/main.py \
  --listen 0.0.0.0 --port 8188 \
  --extra-model-paths-config /opt/ComfyUI/extra_model_paths.yaml \
  --user-directory /tmp/fasth3-user \
  --output-directory /tmp/fasth3-output \
  --temp-directory /tmp/fasth3-temp \
  --disable-cuda-malloc --reserve-vram 8
