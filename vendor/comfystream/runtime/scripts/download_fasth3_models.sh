#!/usr/bin/env bash
set -euo pipefail

models_root="${COMFYUI_ROOT:-/workspace/ComfyUI}/models"
manifest="${COMFYSTREAM_MANIFEST:-${COMFYSTREAM_ROOT:-/workspace/comfystream}/deploy/vast/fasth3-environment.json}"
download_root="${HF_ENDPOINT:-https://huggingface.co}"
python_bin="${PYTHON_BIN:-python3}"
trusted_model_stats="${COMFYSTREAM_TRUSTED_MODEL_STATS:-/opt/comfystream/deploy/fal/fasth3-b1/shared-model-stat-receipt.json}"

[[ -f "$manifest" ]] || { echo "Missing environment manifest: $manifest" >&2; exit 1; }
manifest_revision() {
  "$python_bin" - "$manifest" "$1" <<'PY'
import json
import sys

manifest = json.loads(open(sys.argv[1], encoding="utf-8").read())
print(manifest["model_revisions"][sys.argv[2]])
PY
}

fastvideo_revision="${HF_REVISION_FASTVIDEO:?HF_REVISION_FASTVIDEO must be a reviewed Hugging Face commit SHA}"
qwen_revision="${HF_REVISION_QWEN3_VL:-$(manifest_revision qwen3vl_4b_fp8_scaled.safetensors)}"
clipproj_revision="${HF_REVISION_CLIPPROJ:-$(manifest_revision mmh3-4b-ClipProj-v3.1-mlp.safetensors)}"
audio_vae_revision="${HF_REVISION_AUDIO_VAE:-$(manifest_revision minimax_h3_audio_vae_fp32.safetensors)}"
kijai_revision="${HF_REVISION_KIJAI:-$(manifest_revision minimax_h3_video_vae_int8_convrot.safetensors)}"
for revision in "$fastvideo_revision" "$qwen_revision" "$clipproj_revision" \
  "$audio_vae_revision" "$kijai_revision"; do
  if [[ ! "$revision" =~ ^[0-9a-fA-F]{40}$ ]]; then
    echo "model revisions must be 40-character commit SHAs: $revision" >&2
    exit 1
  fi
done
command -v curl >/dev/null || { echo "curl is required" >&2; exit 1; }
command -v sha256sum >/dev/null || { echo "sha256sum is required" >&2; exit 1; }

hash_and_evict() {
  "$python_bin" - "$1" <<'PY'
import hashlib
import os
import sys

path = sys.argv[1]
digest = hashlib.sha256()
offset = 0
with open(path, "rb") as stream:
    while chunk := stream.read(8 * 1024 * 1024):
        digest.update(chunk)
        advice = getattr(os, "POSIX_FADV_DONTNEED", None)
        fadvise = getattr(os, "posix_fadvise", None)
        if advice is not None and callable(fadvise):
            try:
                fadvise(stream.fileno(), offset, len(chunk), advice)
            except OSError:
                pass
        offset += len(chunk)
print(digest.hexdigest())
PY
}

stat_receipt_matches() {
  "$python_bin" - "$trusted_model_stats" "$1" "$2" <<'PY'
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
)
matches = matches and (
    record.get("mtime_ns") == stat.st_mtime_ns
    and record.get("inode") == stat.st_ino
)
raise SystemExit(0 if matches else 1)
PY
}

# Keep bearer credentials out of curl's process arguments. The private config is
# mode 0600 and removed on normal exit or termination.
auth_config=""
cleanup_auth_config() {
  if [[ -n "$auth_config" ]]; then
    rm -f -- "$auth_config"
  fi
}
trap cleanup_auth_config EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM
if [[ -n "${HF_TOKEN:-}" ]]; then
  if [[ ! "$HF_TOKEN" =~ ^[A-Za-z0-9_-]+$ ]]; then
    echo "HF_TOKEN contains unsupported characters" >&2
    exit 1
  fi
  umask 077
  auth_config="$(mktemp "${TMPDIR:-/tmp}/hf-curl.XXXXXX")"
  printf 'header = "Authorization: Bearer %s"\n' "$HF_TOKEN" > "$auth_config"
  unset HF_TOKEN
fi
curl_download() {
  if [[ -n "$auth_config" ]]; then
    curl --config "$auth_config" "$@"
  else
    curl "$@"
  fi
}

download_model() {
  local relative_path="$1"
  local repository="$2"
  local source_path="${3:-$relative_path}"
  local revision="$4"
  local target="$models_root/$relative_path"
  local url="$download_root/$repository/resolve/$revision/$source_path?download=true"
  local current="$models_root"
  local component
  local -a components
  IFS='/' read -r -a components <<< "$relative_path"
  for component in "${components[@]}"; do
    current="$current/$component"
    if [[ -L "$current" ]]; then
      echo "Refusing to download through a model symlink: $current" >&2
      exit 1
    fi
  done
  mkdir -p "$(dirname "$target")"
  local expected_hash
  expected_hash="$("$python_bin" - "$manifest" "$(basename "$relative_path")" <<'PY'
import json
import sys
print(json.load(open(sys.argv[1], encoding="utf-8"))["models"][sys.argv[2]])
PY
)"
  if [[ -f "$target" ]]; then
    if stat_receipt_matches "$target" "$expected_hash"; then
      echo "Stat-verified existing $relative_path"
      return
    fi
    if [[ "$(hash_and_evict "$target")" == "$expected_hash" ]]; then
      echo "Verified existing $relative_path"
      return
    fi
  fi
  if [[ -f "$target" && "${COMFYSTREAM_NO_REPLACE_MODELS:-0}" == "1" ]]; then
    echo "Refusing to replace a shared model whose hash differs: $target" >&2
    return 1
  fi
  echo "Downloading $relative_path"
  local resumed=true
  if ! curl_download --fail --location --retry 3 --retry-all-errors --continue-at - \
    "$url" --output "$target"; then
    # Some endpoints ignore Range and curl exits 33. With set -e, catch that
    # resume failure here so the verified byte-zero fallback still runs.
    resumed=false
  fi
  local actual_hash
  actual_hash=""
  if [[ "$resumed" == true && -f "$target" ]]; then
    actual_hash="$(hash_and_evict "$target")"
  fi
  if [[ "$actual_hash" != "$expected_hash" ]]; then
    local fresh_download
    fresh_download="$(mktemp "${target}.download.XXXXXX")"
    echo "Resume failed or hash mismatched; retrying $relative_path from byte zero"
    if ! curl_download --fail --location --retry 3 --retry-all-errors \
      "$url" --output "$fresh_download"; then
      rm -f "$fresh_download"
      return 1
    fi
    actual_hash="$(hash_and_evict "$fresh_download")"
    if [[ "$actual_hash" != "$expected_hash" ]]; then
      rm -f "$fresh_download"
      echo "$relative_path hash mismatch after fresh download: expected $expected_hash, got $actual_hash" >&2
      return 1
    fi
    mv -f "$fresh_download" "$target"
  fi
}

if [[ "${FASTH3_TRIM_ONLY:-0}" == "1" ]]; then
  echo "Skipping the alternate 8-step checkpoint; this app is pinned to the Trim model"
else
  download_model "diffusion_models/fastvideo_fasth3_8step_v2_pruned_int8_convrot.safetensors" \
    "FastVideo/FastVideo-FastH3-Comfy" \
    "diffusion_models/fastvideo_fasth3_8step_v2_pruned_int8_convrot.safetensors" "$fastvideo_revision"
fi
download_model "text_encoders/qwen3vl_4b_fp8_scaled.safetensors" \
  "Comfy-Org/Qwen3-VL" \
  "text_encoders/qwen3vl_4b_fp8_scaled.safetensors" "$qwen_revision"
download_model "clip_projections/mmh3-4b-ClipProj-v3.1-mlp.safetensors" \
  "NicoLab28/ClipProj-MiniMax-H3" \
  "mmh3-4b-ClipProj-v3.1-mlp.safetensors" "$clipproj_revision"
download_model "vae/minimax_h3_audio_vae_fp32.safetensors" \
  "Comfy-Org/MiniMax-H3" \
  "vae/minimax_h3_audio_vae_fp32.safetensors" "$audio_vae_revision"
download_model "vae/minimax_h3_video_vae_int8_convrot.safetensors" \
  "Kijai/MiniMax-H3-experimental" \
  "minimax_h3_video_vae_int8_convrot.safetensors" "$kijai_revision"

# Each selected file was already checked by download_model. Startup can skip
# the redundant second pass over all model bytes when explicitly requested.
if [[ "${FASTH3_SKIP_FINAL_REHASH:-0}" == "1" ]]; then
  echo "FASTH3_MODELS_OK"
  exit 0
fi

"$python_bin" - "$manifest" "$models_root" <<'PY'
import hashlib
import json
import os
import sys
from pathlib import Path

manifest_path = Path(sys.argv[1])
models_root = Path(sys.argv[2])
manifest = json.loads(manifest_path.read_text())
model_paths = manifest.get("model_paths", {})
errors = []
for filename, expected in manifest["models"].items():
    relative = model_paths.get(filename)
    if relative is not None:
        relative_path = Path(relative)
        if (
            not isinstance(relative, str)
            or relative_path.is_absolute()
            or ".." in relative_path.parts
            or "" in relative_path.parts
        ):
            errors.append(f"{filename}: invalid model path in manifest")
            continue
        matches = [models_root / relative_path]
        matches = [path for path in matches if path.is_file()]
    else:
        matches = list(models_root.rglob(filename))
    if len(matches) != 1:
        errors.append(f"{filename}: expected one file, found {len(matches)}")
        continue
    digest = hashlib.sha256()
    with matches[0].open("rb") as handle:
        offset = 0
        for block in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(block)
            advice = getattr(os, "POSIX_FADV_DONTNEED", None)
            fadvise = getattr(os, "posix_fadvise", None)
            if advice is not None and callable(fadvise):
                try:
                    fadvise(handle.fileno(), offset, len(block), advice)
                except OSError:
                    pass
            offset += len(block)
    actual = digest.hexdigest()
    if actual != expected:
        errors.append(f"{filename}: expected {expected}, got {actual}")
if errors:
    raise SystemExit("\n".join(errors))
print("FASTH3_MODELS_OK")
PY
