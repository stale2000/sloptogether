# MiniMax-H3 SoL upscaler node

This is a separate second-stage ComfyUI node for refining an existing MiniMax-H3
video. It does not generate the source video. Connect the generator's `VIDEO`
output to this node and provide the source scene prompt. It returns a
file-backed `VIDEO`, preserving the source audio track when present. Output
dimensions must be even and preserve the input aspect ratio; silent input is
also supported.

## Product vision: live AI video at consumer-GPU economics

Together with the FastH3 generator, this node is part of SlopTogether's effort
to make always-on, interactive AI video practical on consumer-class GPUs. The
target GPU operating cost is below $2 per hour; the long-term ambition is up to
200× lower cost than higher-cost video-generation alternatives. That could make
always-on streams, interactive storytelling, community-driven worlds, and new
creative experiments more accessible.

These are goals, not measured claims. This repository does not establish a
200× apples-to-apples saving, an end-to-end cost below $2/hour, or a "best in
the world" ranking. The imported runtime targets Linux/NVIDIA workers; consumer
GPU and RTX 4090/WSL2 operation still need hardware qualification. The Ada
upscale path also requires at least 128 GiB of system RAM.

## Runtime and installation

The upstream refiner implementation is vendored under `sol_refiner_h3/` from
NVlabs/Sana (Apache-2.0).
Model weights are downloaded on first use from
`Efficient-Large-Model/SoL-Refiner-LTX-2.5-for-MiniMax-H3` at revision
`4655337474c1c77fb52e9ac55111552e625e779c`; they are not bundled here. The
Pruna fast decoder weights are also downloaded and verified separately.

The ComfyUI host follows the FastH3 Python/Torch/CUDA pins. The isolated SoL
worker has its own Torch environment, recorded in `runtime.json`. Install its
dependencies from the custom-node directory:

```bash
PYTHON_BIN=/path/to/comfy/python bash install_runtime.sh
```

The node runs inference in a persistent isolated Python worker to avoid mixing
Torch builds inside ComfyUI. It requires Linux with an NVIDIA GPU, CUDA 13, and
NVENC support for the default encoder. Set
`NVIDIA_DRIVER_CAPABILITIES=compute,utility,video` in containers that need
NVENC. Select `libx264` if the installed FFmpeg does not provide NVENC.

See the [worker deployment guide](../../vast/README.md) for the pinned
environment and model setup.

## GPU profiles and limitations

SlopTogether's `auto` profile selects resident NVFP4 on Blackwell GPUs with at
least 94 GiB total and 90 GiB free VRAM. Ada GPUs with at least 24 GB VRAM use
per-row FP8 with sequential CPU offload and require at least 128 GiB system
RAM. The Ada path can be substantially slower because weights move over PCIe.
The NVFP4 path requires Blackwell (SM 10.0+) and 90 GiB free VRAM. If the
persistent refiner worker holds that memory, `auto` stops it and checks again;
the request fails if the reserve remains unavailable. MXFP8 and BF16 are
explicit overrides.

The default `pruna_fast` decoder uses a distilled convolutional decoder. The
optional `diffusion` decoder uses the reference diffusion decoder and native
NATTEN. Decoder choice can affect fine detail. Reduced precision can also
change generated details. Evaluate output quality and latency on the intended
hardware and workload before deployment.

The RTX 4090/WSL2 path has not been qualified for memory use, latency, output
quality, or continuous playback. A GPU profile passing its memory admission
checks is not evidence of runtime or quality support.

## Conditioning and output handling

The source prompt remains active during refinement. For a dedicated worker that
always uses the same exact prompt, set
`COMFYSTREAM_SOL_H3_CONDITIONING_ARTIFACT` to a persistent artifact path before
starting ComfyUI. The first request creates the artifact; later runs validate
its model, runtime, prompt, and tensor identity before reuse. Changing the
prompt requires a new artifact or returning to ordinary dynamic conditioning.

The SlopTogether recipe supplies a server-issued attempt scope. The node keeps
its MP4 and intermediate files under that scope so the worker can remove them
after download. Each successful call also writes a runtime/timing report beside
the output. Keep the request scope enabled for worker use.

## Multi-GPU benchmark node

The package also exports a separate experimental multi-GPU benchmark node. It
splits work across GPUs visible to the same ComfyUI host; it does not dispatch
to remote workers. It loads a model copy per GPU, can change temporal seams and
noise behavior, and has no production profile or demonstrated speedup. The
standard single-GPU upscaler remains the supported workflow path.

This project is licensed under the [MIT License](../../../../LICENSE). The
vendored refiner and other third-party components retain their included
licenses and notices.
