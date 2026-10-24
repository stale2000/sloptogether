# ComfyStream MiniMax-H3 SoL Upscaler

This is a **separate second-stage ComfyUI node** for an existing MiniMax-H3
video. It runs NVIDIA's H3-specific SoL Refiner, which is an LTX-2.5 refiner
trained/configured for MiniMax-H3 inputs. It does not load or run the H3
generator.

Connect the `VIDEO` output of the existing H3 workflow to `video`, and provide
the same scene prompt used to create the source. The node returns a new,
file-backed `VIDEO` at the selected resolution and preserves the source audio
stream when present. Its default is 1184×666 for the native 512×288 H3 source;
the output must remain even-sized and preserve the source aspect ratio. Silent
input videos are supported and produce silent output.

## Runtime

The upstream implementation is vendored under `sol_refiner_h3/` from NVlabs/Sana
revision `670482d8a857d578ac8a2ea89b052d0fb47badba` (Apache-2.0). The model
weights remain under their published license and are downloaded from
`Efficient-Large-Model/SoL-Refiner-LTX-2.5-for-MiniMax-H3` at revision
`4655337474c1c77fb52e9ac55111552e625e779c` on the first actual upscale
request. Merely installing or importing this node does not load the refiner.

Use the **same pinned Python/Torch/CUDA environment as the FastH3 deployment**.
The node checks those runtime pins before loading its weights. Run the installer
to add the node packages in that environment:

```bash
PYTHON_BIN=/path/to/comfy/python bash install_runtime.sh
```

On a dedicated upscaler host, set `COMFYSTREAM_REQUIRE_MODELS=0` in the Vast
deployment environment and keep `COMFYSTREAM_INSTALL_SOL_H3_REFINER=1`. This
skips the FastH3 **generator** checkpoint download; it does not skip the
H3-specific SoL Refiner weights this node loads when used. Generator hosts
continue to use `COMFYSTREAM_REQUIRE_MODELS=1`.

The ComfyUI host Python/Torch/CUDA versions match the FastH3 runtime manifest at
`deploy/vast/fasth3-environment.json`: Python 3.12, PyTorch 2.14.0+cu130,
CUDA runtime 13.0, torchvision 0.29.0+cu130, and torchaudio 2.11.0+cu130.
`runtime.json` records both runtimes. `requirements.txt` does not replace host
Torch. `install_runtime.sh` creates `.worker`, an isolated Python 3.12 / PyTorch
2.13.0+cu130 process environment with the published native
`natten==0.21.7+torch2130cu130` wheel. CUDA remains 13.0 in both environments.
The node sends the source file and inference request to that worker process;
this avoids mixing Torch builds inside ComfyUI. The reference diffusion
decoder requires native NATTEN; the default fast convolutional decoder skips
that component. The worker pin is needed because the host's Torch 2.14
build has no matching NATTEN wheel: the Flex fallback attempted to allocate a
91 GiB decoder attention mask and OOMed on the 96 GiB test GPU.

The `decoder_mode` input defaults to `pruna_fast` to meet the real-time target.
Select `diffusion` for the sharper reference decoder. Fast mode keeps the H3
LTX-2.5 refiner and uses a pinned distilled LTX convolutional decoder for the
final latent decode. It downloads and verifies the public Pruna weights (about
1.33 GB) on first use and caches them.
The decoder can change grain and fine detail; see the benchmark notes before
choosing it for quality-sensitive work.

The upstream node defaults to dynamic NVFP4 transformer Linear weights on
Blackwell, one conditional denoising step, and full GPU residency. SlopTogether
uses the `auto` profile: it selects resident NVFP4 on Blackwell cards with at
least 94 GiB total/90 GiB free VRAM, or Ada-compatible per-row FP8 with
sequential CPU offload on SM 8.9+ cards with at least 24 GB VRAM and less than
94 GiB total. The latter requires 128 GiB system RAM. A large Blackwell card
below its 90 GiB free reserve is rejected before leasing; it does not fall
back to host offload. MXFP8 and BF16 remain explicit overrides. The
reference decoder uses native NATTEN in the isolated worker and 768-pixel
overlapping decoder tiles at 1024×576. For output no larger than 832×468 it
automatically uses a full spatial tile to reduce duplicated overlap work; video
is still processed as continuous temporal tiles. The upstream documentation
notes that tiled decode can differ from untiled decode. Video length is padded
by repeating its last frame to the next valid `1 + 8k` length, then trimmed back
to the original frame count so the node does not silently shorten the source.
Output is H.264 NVENC by default; select `libx264` if the current FFmpeg build
lacks NVENC.

When running in a Vast/Docker container with NVENC, create the container with
`NVIDIA_DRIVER_CAPABILITIES=compute,utility,video`. The default
`compute,utility` capabilities expose CUDA but omit `libnvidia-encode.so.1`:
FFmpeg may list `h264_nvenc` yet fail when opening the encoder, after inference
has completed. Run a one-frame NVENC smoke encode before downloading models or
starting a benchmark. The H3 node benchmark harness performs this preflight.
NVFP4 workers keep every refiner component on CUDA. Ada FP8 workers use
Diffusers sequential CPU offload; this reduces GPU residency but moves model
weights over PCIe and can be much slower. Neither profile silently falls back
after an allocation failure. The 4090 path is not hardware-qualified until
memory, output quality and latency checks pass on Windows.
The serialized worker persists between node calls, preserving loaded GPU
weights. It exits with ComfyUI and restarts when its code or runtime contract
changes. Its diagnostics are written to the first request's `worker.log`.
Worker responses have a 30-minute timeout by default. Set
`COMFYSTREAM_SOL_H3_TIMEOUT_SECONDS` to a larger positive number for longer
clips; a timed-out worker is stopped so the next request can start cleanly.

### Optional exact fixed-prompt conditioning

The prompt remains part of refinement. This mode precomputes its exact final
video embeddings and attention mask; it does not replace the prompt with an
empty string, shorten it, or switch to unconditional refinement. The ordinary
mode remains the default and accepts changing scene prompts with its bounded
conditioning cache. The combined H3 flow forwards the original scene prompt.

For a dedicated deployment with an identical prompt on every clip, set this
environment variable before starting ComfyUI/the worker:

```bash
export COMFYSTREAM_SOL_H3_CONDITIONING_ARTIFACT=/persistent/conditioning/scene.pt
```

If that file is absent, the first request loads the text components, encodes the
exact supplied prompt, atomically saves a tensor-only artifact, then unregisters
the text encoder, tokenizer and connectors. NVFP4 video model weights stay on
CUDA; the Ada FP8 profile uses sequential CPU offload. If the file exists on a later start, the loader
validates it and passes those three optional components as `None`, skipping
their model loading. Subsequent requests use private copies of the same
conditioning tensors. One artifact is bound to one exact prompt, including
whitespace; a different prompt raises an error rather than using stale text.

Artifacts bind the checkpoint revisions of all text components, the encoding
schema and local encoder-source hashes, Torch/Diffusers/Transformers versions,
video-only connector mode, BF16
embedding shape (1×1024×4096), int64 mask shape (1×1024), and a SHA-256 checksum.
Loading uses `torch.load(weights_only=True, map_location="cpu")` with archive
size bounds and tensor/value validation. Use artifacts from your own trusted
deployment. Output dimensions and clip duration are deliberately independent
of this text-only artifact. Restart the worker after changing environment or
artifact files; a running worker owns its already loaded template.

To change prompts, unset this variable and restart for ordinary dynamic mode,
or restart with a different artifact path and the new exact prompt. Keep the
original scene prompt as the control for prompt experiments: this is a
generative refiner, so another prompt can steer reconstructed detail and is
not an established quality improvement. The [authors' release](https://github.com/NVlabs/Sana/tree/670482d8a857d578ac8a2ea89b052d0fb47badba/models/sol-refiner/MiniMax-H3)
accepts an existing H3 video and a prompt.

Reports include `fixed_conditioning_enabled`, `text_encoder_loaded`, artifact
checksum, preparation time, and removed parameter bytes. The latter counts
parameters removed in this process; it is zero when those components were
never loaded. It is not measured CUDA memory freed. Checkpoint text weights
alone are approximately 22.277 GiB; actual GPU memory savings and output parity
must be verified on the pinned CUDA worker before enabling this in live service.
CPU artifact/loader tests passed; no GPU benchmark was run for this addition.

### Hardware requirement for the next GPU benchmark

Require a reliable RTX PRO 6000 workstation 96 GB offer under $2/hour including
storage, with provider-advertised `gpu_max_power` of at least 550 W (prefer
600 W) and the pinned CUDA 13 runtime. Before accepting absolute timings, save
`nvidia-smi -q -d POWER,PERFORMANCE,CLOCK` at idle and under the actual workload,
plus applied/requested/enforced power limits, power draw, SM clocks and throttle
reasons. `power.max_limit=600 W` proves only the hardware maximum setting.
Do not raise a rented host's power limit blindly.

The three recent safe-Pruna/cache/inference-mode suites were not verified at
full power. The audited offer advertises 300 W, while historical enforced
limits were not recorded. Their same-host A/B comparisons remain useful;
absolute timing comparisons need a new verified host. This is a requirement
for future testing, not authorization to rent or start a GPU now. See the
[remaining optimization plan](../../../docs/experiments/realtime-upscale/README.md).

The H3 encoder, upsampler, and transformer weights are unchanged in both
modes. `pruna_fast` compiles the transformer's repeated blocks by default at
every output size. Set `COMFYSTREAM_SOL_H3_COMPILE_TRANSFORMER=0` to opt out;
`diffusion` mode remains eager. Warm compile speed gains were measured at
1184×666 (5.8%) and 1280×720 (6.9%). At 1600×900, the live shared-VAE worker
reported `transformer_compiled=true`; see the [OBS run notes](../../../benchmark-results/obs-live-1600-shared-vae-e2e-20261004/RUNNING.md).
The first request is slower while the worker loads and compiles.
The default uses the pinned fast convolutional decoder; it uses one 1024-pixel
spatial tile at 1K. Selecting `diffusion` loads the reference diffusion decoder
with native NATTEN, cached rotary tables, and a fused FP32 rotary kernel that
disables FMA contraction to preserve eager rounding. Triton 3.7.1 is pinned in
the worker. The checkpoint loads an [encoder-only LTX VAE](sol_refiner_h3/encoder.py);
the final-pixel decoders are separate components. `pruna_fast` therefore does
not keep a duplicate LTX VAE decoder resident.
GPU output packing follows Diffusers' normalized RGB and round-to-even byte
conversion. For NVENC, it converts to limited-range YUV420P on CUDA and transfers
four-frame batches through reused pinned staging to FFmpeg, cutting raw pipe
size in half compared with RGB24. Set
`COMFYSTREAM_SOL_H3_NVENC_INPUT_FORMAT=rgb24` to revert to the original
transport. The YUV420P path was A/B-tested at 1280×720: dimensions, frame count,
and all 647 source audio packet payloads matched. The reviewed contact sheet
showed no visible difference; the encoded outputs measured 48.31 dB PSNR and
0.9932 SSIM against each other. Warm worker time improved from an 18.09-second
RGB24 median to 17.38 seconds with YUV420P. Completed conditioning buffers are
released before decode.
The worker defaults to `PYTORCH_ALLOC_CONF=expandable_segments:True` to avoid
allocator retries; an explicitly supplied allocator setting is preserved.
Each successful node call also writes its runtime and timing report beside the
returned MP4.

## Transformer precision

`transformer_precision` defaults to `nvfp4` on the upstream H3 upscaler.
SlopTogether's pinned workflow requests `auto`. Its Ada profile uses TorchAO's
stable `Float8DynamicActivationFloat8WeightConfig` per-row path, then
sequentially offloads pipeline modules to system RAM. That profile requires at
least 128 GiB RAM and 24 GB GPU memory; no RTX 4090 inference or quality
qualification has been run. Standard worker
installation includes pinned TorchAO 0.17.0+cu130 and MSLK 1.3.0+cu130 for its
fused Triton activation quantizer. Dynamic NVFP4 applies only
to transformer Linear layers with both dimensions at least 1024 and divisible
by 16; the text path, connectors, VAE, norms, and output decoder remain BF16.
It requires Blackwell SM 10.0+ and fails explicitly when unsupported. Choose
`mxfp8` or `bf16` in the node to override precision.

At 1184×666 on an RTX PRO 6000, NVFP4 was 4.8% faster warm and saved 8.27 GiB
peak allocated memory against bracketed MXFP8 runs. It also visibly changed
generated details: full-video SSIM was 0.8895 and PSNR 26.17 dB against MXFP8.
This is a speed/memory default, not a quality-equivalent precision mode. See
the [NVFP4 report](../../../benchmark-results/obs-stutter-debug-20261002/nvfp4-1184-20261002/REPORT.md).

See [PERFORMANCE.md](PERFORMANCE.md) for measured latency, the real-time target
gap, and a prioritized list of acceleration options with quality and hardware
caveats.

On one RTX 5090, the fused activation path completed a 30-second clip at
960×600 where the unfused path previously OOMed. It still OOMed at 1280×800
during later NVFP4 output rescaling. Treat this as a partial memory improvement,
not support for that larger resolution; see the
[trial report](../../../benchmark-results/lium-upscale-optimization-20261003/nvfp4-triton/REPORT.md).

## Scope and limits

This is the NVIDIA H3-specific **LTX-2.5** refiner, not the generic LTX-2.3
benchmark and not Kijai's experimental H3 generator/decoder weights. Existing
FastH3 model fusions are architecture-specific and are intentionally not
applied to LTX. Reused safe patterns are lazy model caching, GPU residency,
bounded output packing, and explicit buffer/process cleanup. H3's truncating
uint8 packer is not reused because its rounding differs from Diffusers.

The node preserves the original audio packets by stream-copying the first audio
track. It produces a file-backed Comfy `VIDEO` to avoid materializing a second
full-resolution float video in downstream nodes.

### Experimental local multi-GPU benchmark node

An additional optional `ComfyStreamMiniMaxH3SoLSharedVAEBenchmark` node dedicates
one GPU to VAE encoding/latent upsampling/Pruna decoding and one to four other
GPUs to upscaling transformers. It passes latent tensors on one host and uses
one final streaming encoder, with no intermediate chunk MP4s. Use
`scripts/benchmark_h3_upscale.py --mode all --devices 1` to compare single GPU
with the two-GPU shared-VAE profile on a two-card host. Use
`--mode shared-vae --vae-device 0 --devices 1,2` for two transformer GPUs.
Prepare exact fixed-prompt conditioning first
with `scripts/prepare_h3_conditioning.py` in the pinned worker runtime. See the
[shared VAE runbook](../../../docs/experiments/shared-vae-upscale-benchmark-2026-10-02.md)
for commands, stage timing scopes, artifact regeneration, and GPU validation
limitations. This adds a standalone test option; the default node is unchanged.

The shared-VAE node exposes `interpolate_overlaps`, a boolean defaulting to
false. Disabled, it selects the next chunk's prediction across the shared
frames and does not RGB-crossfade two predictions. Enable it only to restore
the old crossfade. This controls chunk seams inside each input video; the H3
paired-video last-frame handoff between 15-second clips is a separate path and
is unchanged.

Chunk noise consistency uses `global_latent`: one clip-wide seeded noise field
is sliced on the LTX eight-frame latent grid, so matching overlap positions get
the same noise on every transformer GPU. `legacy_rgb` is deprecated and
rejected. This removes per-chunk RNG restarts; chunk-local VAE context and
transformer attention can still differ at boundaries.

Add the separate `MiniMax-H3 SoL Upscaler (Multi-GPU Benchmark)` node and enter
two to four distinct CUDA-visible device ordinals, such as `0,1`. The existing
`MiniMax-H3 SoL Upscaler` node and its whole-video path remain unchanged. The
benchmark node splits the video into frame ranges with shared temporal context
and starts one persistent isolated refiner process per selected GPU,
cross-fades each overlap and returns
one assembled video. The node records per-worker and split/assembly timings in
its JSON report. Lossless H.264 is used for split inputs and chunk outputs;
the selected output encoder is used once for the assembled video.

This is a benchmark experiment. It runs on multiple GPUs visible to this one
ComfyUI host; it does not dispatch to remote ComfyUI servers. Each GPU loads a
full model copy. The model restarts the temporal coordinate and random-noise
sequence in each chunk, so matching whole-video output is not promised.
The input must be constant-frame-rate YUV420P H3 video.
Inspect each overlap before using the result. Begin with a 16-frame overlap,
then compare larger overlaps on representative motion. Use the original node
as the quality and latency baseline. There is no production profile or measured
speedup claim yet.
The per-GPU model processes stay resident for warm benchmark runs. Running the
original single-GPU node shuts down the benchmark workers before inference;
exiting ComfyUI also releases them.

The existing ComfyStreamer desktop viewer at `http://127.0.0.1:8765/live`
plays the coordinator's committed broadcast. Standalone benchmark previews use
direct ComfyUI output URLs and do not publish into that live stream.

#### Coordinated benchmark and optional end-to-end test

With ComfyUI running locally and both H3 upscale nodes installed, compare the
single-GPU and multi-GPU nodes on one source using the optional coordinator
script:

```bash
python3 scripts/benchmark_h3_upscale.py input.mp4 \
  --prompt "Preserve the source scene and motion" \
  --devices 0,1 --mode both --repeats 3 --open-results
```

The script submits both profiles to the local ComfyUI queue, waits for saved
MP4s, probes each browser preview URL with an HTTP range request, and writes a
JSON timing receipt under `benchmark-results/distributed-h3/`. The receipt
includes one browser URL per result plus the frame ranges to inspect at each
join. `--open-results` opens the URLs automatically. The default ComfyUI
address is `http://127.0.0.1:8188`; use `--comfyui-base-url` for a different
local port. The script does not create or rent GPUs.

CPU contract tests run with:

```bash
python3 -m unittest discover -s tests -p 'test_h3_upscale_benchmark.py' -v
```

The full ComfyUI/GPU test is skipped unless
`COMFYSTREAM_H3_E2E_SOURCE` points to a real source MP4. With a local ComfyUI
server and two ready CUDA devices, run:

```bash
COMFYSTREAM_H3_E2E_SOURCE=/path/to/h3.mp4 \
python3 -m unittest discover -s tests -p 'test_h3_upscale_benchmark.py' -v
```

## Tests

Pure contract tests can run without ComfyUI, CUDA, Diffusers, or NATTEN:

```bash
python -m unittest discover -s tests -p 'test_sol_refiner_h3_node.py' -v
```

An actual model run still requires an NVIDIA CUDA GPU and the dependencies
above. This package adds a separate H3 upscaler node; it does not change the
existing H3 generator node.
