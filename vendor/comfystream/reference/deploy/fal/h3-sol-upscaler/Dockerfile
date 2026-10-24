FROM pytorch/pytorch:2.14.0-cuda13.0-cudnn9-devel@sha256:cce09744eb864371df6423aaba413145afb65794837be783c33446e7ef615d20

ENV DEBIAN_FRONTEND=noninteractive \
    PIP_CONFIG_FILE=/dev/null \
    PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    COMFYSTREAM_ROOT=/opt/comfystream \
    COMFYUI_ROOT=/opt/ComfyUI \
    HF_HOME=/data/.cache/huggingface \
    COMFYSTREAM_SOL_H3_NVFP4_CACHE_DIR=/data/comfystream/sol-h3/nvfp4 \
    TORCHINDUCTOR_CACHE_DIR=/data/torchinductor \
    TRITON_CACHE_DIR=/data/triton \
    CUDA_CACHE_PATH=/data/cuda-cache \
    COMFYSTREAM_REQUIRE_MODELS=0 \
    COMFYSTREAM_INSTALL_SOL_H3_REFINER=1 \
    COMFYSTREAM_SOL_H3_DECODER_MODE=pruna_fast \
    COMFYSTREAM_SOL_H3_TRANSFORMER_PRECISION=nvfp4 \
    COMFYSTREAM_SOL_H3_CPU_TEXT_ENCODER=1 \
    COMFYSTREAM_SOL_H3_TIMEOUT_SECONDS=3600 \
    COMFYSTREAM_SOL_H3_COMPILE_TRANSFORMER=0

RUN apt-get update && apt-get install -y --no-install-recommends \
      build-essential ca-certificates curl ffmpeg git libgl1 libglib2.0-0 \
      libsndfile1 python3.12-venv \
    && rm -rf /var/lib/apt/lists/*

COPY deploy/fal/h3-sol-upscaler/context/comfystream /opt/comfystream
# Fal's build-context file sync drops executable bits; restore those needed by
# the artifact manifest before verifying the staged source.
RUN chmod +x \
      /opt/comfystream/deploy/custom_nodes/comfystream_sol_refiner_h3/install_runtime.sh \
      /opt/comfystream/scripts/assemble_worker_artifact.py \
      /opt/comfystream/scripts/prepare_h3_upscale_conditioning.py
RUN python3 /opt/comfystream/scripts/assemble_worker_artifact.py \
      --profile h3-upscaler --destination /opt/comfystream --check

RUN python3.12 -m venv --system-site-packages /opt/venv-comfy \
    && /opt/venv-comfy/bin/python -m pip install --progress-bar off --require-hashes \
         --only-binary=:all: -r /opt/comfystream/deploy/fal/h3-sol-upscaler/requirements.lock

RUN mkdir -p /tmp/kitchen-wheel \
    && /opt/venv-comfy/bin/python -m pip download --only-binary=:all: --no-deps \
         --dest /tmp/kitchen-wheel comfy-kitchen==0.2.34 \
    && expected="$(/opt/venv-comfy/bin/python -c 'import json; print(json.load(open("/opt/comfystream/deploy/vast/fasth3-environment.json"))["kitchen_wheel_sha256"])')" \
    && wheel="$(find /tmp/kitchen-wheel -maxdepth 1 -name '*.whl' -print -quit)" \
    && actual="$(sha256sum "$wheel" | awk '{print $1}')" \
    && test "$actual" = "$expected" \
    && /opt/venv-comfy/bin/python -m pip install --no-deps "$wheel" \
    && rm -rf /tmp/kitchen-wheel

RUN git clone --filter=blob:none --no-checkout https://github.com/comfyanonymous/ComfyUI.git /opt/ComfyUI \
    && git -C /opt/ComfyUI fetch --depth=1 origin ee71d5c4993f29086b27fde1629a945ae48425bf \
    && git -C /opt/ComfyUI checkout --force FETCH_HEAD \
    && git -C /opt/ComfyUI show HEAD:requirements.txt > /tmp/comfyui-requirements.txt \
    && cmp -s /tmp/comfyui-requirements.txt /opt/comfystream/deploy/fal/h3-sol-upscaler/comfyui-requirements.txt \
    && rm /tmp/comfyui-requirements.txt

COPY deploy/fal/h3-sol-upscaler/context/comfystream/deploy/custom_nodes/comfystream_sol_refiner_h3 /opt/ComfyUI/custom_nodes/comfystream_sol_refiner_h3
COPY deploy/fal/h3-sol-upscaler/context/comfystream/deploy/custom_nodes/comfystream_worker_identity /opt/ComfyUI/custom_nodes/comfystream_worker_identity
COPY deploy/fal/h3-sol-upscaler/context/comfystream/scripts/prepare_h3_upscale_conditioning.py /opt/comfystream/scripts/prepare_h3_upscale_conditioning.py
COPY deploy/fal/h3-sol-upscaler/context/comfystream/deploy/vast/fasth3-environment.json /opt/comfystream/deploy/vast/fasth3-environment.json
COPY deploy/fal/h3-sol-upscaler/context/comfystream/worker-manifest.json /opt/comfystream/worker-manifest.json

RUN /opt/venv-comfy/bin/python - <<'PY'
import torch
assert torch.__version__ == "2.14.0+cu130", torch.__version__
assert torch.version.cuda == "13.0", torch.version.cuda
PY
RUN worker=/opt/ComfyUI/custom_nodes/comfystream_sol_refiner_h3/.worker \
    && /opt/venv-comfy/bin/python -m venv "$worker" \
    && printf 'relocatable = true\n' > "$worker/pyvenv.cfg" \
    && touch "$worker/.portable-runtime"
RUN PYTHON_BIN=/opt/venv-comfy/bin/python COMFYUI_ROOT=/opt/ComfyUI \
    COMFYSTREAM_ROOT=/opt/comfystream \
    bash /opt/ComfyUI/custom_nodes/comfystream_sol_refiner_h3/install_runtime.sh --build-only

EXPOSE 8188
CMD ["/opt/venv-comfy/bin/python", "/opt/ComfyUI/main.py", "--listen", "0.0.0.0", "--port", "8188", "--disable-cuda-malloc"]
