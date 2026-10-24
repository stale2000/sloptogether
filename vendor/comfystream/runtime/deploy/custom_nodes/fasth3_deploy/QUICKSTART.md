# Quick start

Install the node pack, models, and `ComfyUI-ClipProj` extension
([setup](README.md#runtime-and-models)), then install `comfy-cli` and FFmpeg.
The demo discovers ready supported GPUs through Comfy CLI and launches its
prompt page from this repository:

```bash
python3 examples/continuous_demo.py
```

Open `http://127.0.0.1:8765` and submit a prompt. Press `Ctrl+C` to stop the
server. The prompt API is unauthenticated, so the demo refuses non-loopback
bind addresses. Sign in to Comfy CLI to include ready Developer Platform
deployments in discovery.

## Submit one MP4 through the ComfyUI API

```bash
curl -X POST http://127.0.0.1:8188/prompt \
  -H 'Content-Type: application/json' \
  --data-binary @examples/basic_text_to_video_api.json
```

The response includes a `prompt_id`; ComfyUI saves the clip under
`output/comfystreamerh3/quickstart/`.
