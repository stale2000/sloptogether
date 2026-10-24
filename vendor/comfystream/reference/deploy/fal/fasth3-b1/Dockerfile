FROM pytorch/pytorch:2.14.0-cuda13.0-cudnn9-devel@sha256:cce09744eb864371df6423aaba413145afb65794837be783c33446e7ef615d20

ENV DEBIAN_FRONTEND=noninteractive \
    PIP_CONFIG_FILE=/dev/null \
    PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    COMFYSTREAM_ROOT=/opt/comfystream \
    COMFYUI_ROOT=/opt/ComfyUI \
    COMFYSTREAM_VENV=/opt/venv-fasth3 \
    HF_HOME=/data/.cache/huggingface \
    TORCHINDUCTOR_CACHE_DIR=/data/torchinductor \
    TRITON_CACHE_DIR=/data/triton \
    CUDA_CACHE_PATH=/data/cuda-cache \
    FASTH3_BUILD_NATIVE_VC=1

RUN apt-get update && apt-get install -y --no-install-recommends \
      build-essential ca-certificates curl ffmpeg git libgl1 libglib2.0-0 \
      libsndfile1 python3.12-venv \
    && rm -rf /var/lib/apt/lists/*

# The source manifest changes with every staged worker context. Copying it
# before the context makes the remote build cache key track staged source drift.
COPY source-manifest.json /tmp/comfystream-fasth3-source-manifest.json
# The staged context includes the reviewed shared-model-stat-receipt.json and
# the exact host dependency locks. It contains no model weights.
COPY context/comfystream /opt/comfystream
# fal normalizes uploaded script permissions. Reassemble inside the image so
# its worker manifest records the bytes and modes the runtime will actually use.
RUN python3 /opt/comfystream/scripts/assemble_worker_artifact.py \
      --profile fasth3 --destination /tmp/comfystream-fasth3-worker-artifact \
    && rm -rf /opt/comfystream-source \
    && mv /opt/comfystream /opt/comfystream-source \
    && mv /tmp/comfystream-fasth3-worker-artifact /opt/comfystream \
    && rm -rf /opt/comfystream-source

RUN python3.12 -m venv --system-site-packages /opt/venv-fasth3 \
    && /opt/venv-fasth3/bin/python -m pip install --progress-bar off --require-hashes \
         --only-binary=:all: \
         -r /opt/comfystream/deploy/fal/fasth3-b1/requirements.lock

RUN /opt/venv-fasth3/bin/python - <<'PY'
import torch
assert torch.__version__ == "2.14.0+cu130", torch.__version__
assert torch.version.cuda == "13.0", torch.version.cuda
PY

RUN mkdir -p /tmp/kitchen-wheel \
    && /opt/venv-fasth3/bin/python -m pip download --only-binary=:all: --no-deps \
         --dest /tmp/kitchen-wheel comfy-kitchen==0.2.34 \
    && expected="$(/opt/venv-fasth3/bin/python -c 'import json; print(json.load(open("/opt/comfystream/deploy/vast/fasth3-environment.json"))["kitchen_wheel_sha256"])')" \
    && wheel="$(find /tmp/kitchen-wheel -maxdepth 1 -name '*.whl' -print -quit)" \
    && actual="$(sha256sum "$wheel" | awk '{print $1}')" \
    && test "$actual" = "$expected" \
    && /opt/venv-fasth3/bin/python -m pip install --no-deps "$wheel" \
    && rm -rf /tmp/kitchen-wheel

RUN git clone --filter=blob:none --no-checkout https://github.com/comfyanonymous/ComfyUI.git /opt/ComfyUI \
    && git -C /opt/ComfyUI fetch --depth=1 origin ee71d5c4993f29086b27fde1629a945ae48425bf \
    && git -C /opt/ComfyUI checkout --force FETCH_HEAD \
    && git -C /opt/ComfyUI show HEAD:requirements.txt > /tmp/comfyui-requirements.txt \
    && cmp -s /tmp/comfyui-requirements.txt /opt/comfystream/deploy/fal/fasth3-b1/comfyui-requirements.txt \
    && rm /tmp/comfyui-requirements.txt

RUN mkdir -p /opt/ComfyUI/custom_nodes \
    && cp -a /opt/comfystream/deploy/custom_nodes/fasth3_deploy /opt/ComfyUI/custom_nodes/fasth3_deploy \
    && cp -a /opt/comfystream/deploy/custom_nodes/comfystream_worker_identity /opt/ComfyUI/custom_nodes/comfystream_worker_identity \
    && cp -a /opt/comfystream/deploy/custom_nodes/comfystream_drama3 /opt/ComfyUI/custom_nodes/comfystream_drama3 \
    && clipproj_ref="$(/opt/venv-fasth3/bin/python -c 'import json; print(json.load(open("/opt/comfystream/deploy/vast/fasth3-environment.json"))["clipproj_node_ref"])')" \
    && git clone --filter=blob:none --no-checkout https://github.com/nicolab28/ComfyUI-ClipProj.git /opt/ComfyUI/custom_nodes/ComfyUI-ClipProj \
    && git -C /opt/ComfyUI/custom_nodes/ComfyUI-ClipProj fetch --depth=1 origin "$clipproj_ref" \
    && git -C /opt/ComfyUI/custom_nodes/ComfyUI-ClipProj checkout --force FETCH_HEAD \
    && printf '%s\n' \
         'fasth3:' \
         '  base_path: /data/fasth3-models/models/' \
         '  is_default: true' \
         '  diffusion_models: diffusion_models/' \
         '  text_encoders: text_encoders/' \
         '  clip_projections: clip_projections/' \
         '  vae: vae/' \
         > /opt/ComfyUI/extra_model_paths.yaml \
    && /opt/venv-fasth3/bin/python -m pip check

COPY context/comfystream/deploy/fal/fasth3-b1/entrypoint.sh /opt/fasth3-entrypoint.sh
RUN chmod 0755 /opt/fasth3-entrypoint.sh

EXPOSE 8188
CMD ["/opt/fasth3-entrypoint.sh"]
