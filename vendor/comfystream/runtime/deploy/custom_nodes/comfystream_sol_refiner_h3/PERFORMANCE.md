# H3 SoL Refiner performance findings

> Paths shown in code below refer to local ignored evidence artifacts; they are not distributed with Git. They are available only when the matching evidence bundle is present. The result summaries and limitations remain in this document.

## Shared-VAE timing and overlap limits

The current latent transfer path synchronizes the source and destination CUDA
devices. A reported transfer time can therefore include queued inference on
the destination, and returning a completed chunk can wait for its sibling
chunk on the source. The VAE/transformer role split is functional, but these
device-wide waits limit decode/refine overlap. Use the complete worker and
end-to-end timings for comparisons; do not treat `latent_transfer_s` as an
isolated link benchmark. The current candidate queues copies on a dedicated
peer stream, passes a CUDA event to the consuming thread, and retains source
buffers until the copy event completes. `latent_transfer_s` now reports the
CUDA-event copy duration; `latent_transfer_submit_s` records host enqueue time.
These are summed per transfer, so they are not end-to-end wall time. The
`scripts/benchmark_cuda_p2p.py` preflight measures both GPU directions and
fails below 5,000 MiB/s before model downloads or inference begin.
The saved node default remains `blocking` for existing workflows; the shared-
VAE benchmark runner defaults to `peer_event` so the two paths can be compared.

## Current transformer-compile default (2026-10-04)

`pruna_fast` compiles repeated transformer blocks by default at every output
size. Set `COMFYSTREAM_SOL_H3_COMPILE_TRANSFORMER=0` to opt out; `diffusion`
mode remains eager. The default applies broadly by request, while the directly
measured warm compile gains remain shape-specific: 5.8% at 1184×666 and 6.9%
at 1280×720.

The live 1600×900 shared-VAE test ran with compilation enabled, and every
successful shared worker report recorded `transformer_compiled=true`. After
cold initialization, warm worker totals ranged from 14.63 to about 15.25
seconds for 15.0 seconds of media, with audio preserved. The first compiled
1600 request included 134.08 seconds of model load/compile and 31.21 seconds
of inference; keep the worker warm. These results verify the 1600 code path but
do not establish that every resolution receives the same speedup. See the
[live 1600 test log](../../../benchmark-results/obs-live-1600-shared-vae-e2e-20261004/RUNNING.md).

## 1184x666 transformer compilation (2026-10-02)

The deployed 1184x666 fast profile now enables repeated-transformer-block
`torch.compile` by default. On the replacement RTX PRO 6000 WS, the compiled
arm was bracketed around a same-source, same-prompt, fixed-conditioning
uncompiled control. Three measured warm calls before and three after the control
had a **13.62 s compiled median** (13.51–13.77 s) against a **14.56 s
uncompiled median** (14.54–14.64 s): **0.84 s / 5.8% lower**. Refiner inference
medians were 12.22 s versus 13.21 s. Each arm was deterministic across its
repeated calls and used 50.52 GiB peak allocated. The compiled and eager MP4
hashes differed, so compilation is not bitwise identical. Full decoded-video
comparison measured **40.69 dB PSNR / 0.9884 SSIM** across the 362-frame output;
sampled frames looked very similar. Both outputs retained 1184×666, 24 fps,
362 frames, and audio. Treat this as a measured numeric difference and limited
single-clip quality check, not a zero-difference claim. Worker receipts confirmed
`transformer_compiled=true` for every compiled measurement.

The first compiled call took 34.03 s, including 7.61 s for model load and
compile work. After the compile cache was warm, the first call after a process
restart took 28.05 s. Keep the worker warm for live streaming. The measured
0.84-second saving helps the 15-second supply margin but does not by itself
qualify continuous OBS playback or remove the sibling-publication wait. Exact
calls and GPU telemetry are in
[`compiled-1184-20261002`](../../../benchmark-results/obs-stutter-debug-20261002/compiled-1184-20261002/).


## Fixed preservation prompt and final conditioning (2026-10-02)

Production OBS upscaling now uses one generic preservation prompt with
`cache_conditioning=true`. The saved artifact holds post-connector embeddings,
so it bypasses both text encoder and connectors and releases their parameters.
Exact prompt, model/runtime/encoding-source identity changes invalidate reuse.
Direct node requests retain opt-in caching.

On the replacement RTX PRO 6000 at 1184×666, bracketed warm controls measured
14.878 s versus 14.815 s with saved conditioning: 0.063 s / 0.42%, within control
drift. There is no demonstrated meaningful throughput gain. Peak allocated GPU
memory fell from 78.7 to 50.5 GiB. Same-prompt video was byte-identical; source
audio was preserved, and fresh-worker artifact reuse passed. This does not
qualify uninterrupted OBS playback. Full evidence and limitations:
[fixed-conditioning report](../../../benchmark-results/obs-stutter-debug-20261002/fixed-conditioning-20261002/REPORT.md).

The checkpoint loads an encoder-only LTX VAE; `pruna_fast` returns denoised
latents and delegates final pixels to Pruna. The separate Pruna VAE also drops
its unused encoder. There is no additional LTX VAE decoder resident to remove.

## Current default: NVFP4 dynamic (2026-10-02)

The H3 node and production coordinator default to `transformer_precision=nvfp4`
on Blackwell. This uses TorchAO's dynamic activation and NVFP4 weight path with
the fused Triton activation kernel enabled (requires MSLK 1.3.0+cu130). It quantizes 1,360 compatible
transformer Linear layers; text/connector components, VAEs, norms, and the
output decoder remain BF16. MXFP8 and BF16 remain explicit overrides.

At 1184×666 on the RTX PRO 6000, the three-call NVFP4 warm median was 12.371 s
versus a 12.997 s average of MXFP8 runs bracketing it. Peak allocated memory
fell 8.27 GiB (33.43 → 25.16 GiB), and peak reserved memory fell 5.56 GiB.
Full-video output comparison showed visible generated-detail differences
(PSNR 26.17 dB, SSIM 0.8895); one ticket changed from “300” to “306”. This
default prioritizes measured speed and memory, not MXFP8 output parity. The
first NVFP4 load/compile call was 140.5 s, so keep the worker warm. See the
[full benchmark and samples](../../../benchmark-results/obs-stutter-debug-20261002/nvfp4-1184-20261002/REPORT.md).

On a 30-second clip on one RTX 5090, the fused path completed 960×600 twice;
the previous unfused run OOMed at that size by about 207 MiB. The warm full-flow
time was 28.89 seconds for a 30.04-second output. It still OOMed at 1280×800,
later during output rescaling. This is a measured resolution-specific gain,
not a general guarantee for larger clips or targets. See the
[fused-kernel trial](../../../benchmark-results/lium-upscale-optimization-20261003/nvfp4-triton/REPORT.md).

## Historical MXFP8 default and benchmark (2026-10-02)

At the time of this benchmark, the H3 node and ComfyStreamer production
workflow defaulted to `transformer_precision=mxfp8`; the current NVFP4 default
and its tradeoffs are described above. This
quantizes transformer Linear layers with both dimensions at least 1024 using
TorchAO dynamic activations. The text path, connectors, VAE, norms, and output
decoder remain BF16. Standard worker installation pins
`torchao==0.17.0+cu130`. MXFP8 requires Blackwell (SM 10.0+) and fails clearly
on incompatible hardware or kernels; it does not silently fall back.

On the replacement RTX PRO 6000 at 1184×666, compiled MXFP8 saved an average
**0.91 s / 6.65%** per clip against compiled BF16 and reduced peak allocated
memory **50.52 → 33.43 GiB** (17.09 GiB). Across the paired encoded MP4s,
PSNR was 32.46 dB and SSIM was 0.9663. Sampled frames looked close to BF16 and
all 647 source AAC packet payloads matched. The measured pixel difference is
documented; BF16 remains available for a manual quality override. Full A/B and
quality receipts:
[`mxfp8-1184-20261002`](../../../benchmark-results/obs-stutter-debug-20261002/mxfp8-1184-20261002/REPORT.md).

## Loaded-clock regression and allocator isolation (2026-10-02)

A subsequent rental took approximately 26 seconds per 15-second clip despite
matching Torch 2.13.0+cu130, CUDA 13.0, model and algorithm source. Synchronized
profiling found approximately 971–975 MHz under H3 load versus 2362 MHz in the
prior busy benchmark. Independent BF16 compute also stayed near 885 MHz at a
reported 600 W with software power capping. Idle-phase clock snapshots had
missed the problem. The exact host/card fault requires provider diagnosis;
do not attribute this result to CUDA versions without evidence.

ComfyUI also leaked its legacy async allocator alias into the isolated worker,
overriding the configuration string previously reported. That inheritance and
reporting issue is fixed, including normalization before a dependency imports
Torch. A matched native/async A/B did not restore performance. Worker reports
now include effective allocator, Torch build, cuDNN and SDP flags. Vast startup
screens loaded clocks before ComfyUI launch; passing that screen still needs
an actual warm H3 job and OBS continuity test. Details and raw evidence are in
[gpu2-root-cause.md](../../../benchmark-results/obs-stutter-debug-20261002/gpu2-root-cause.md).

## Near-1200-width warm-path timing (2026-10-02)

The node only accepts even output dimensions and enforces the source's exact
16:9 ratio, so a literal 1200×675 output is invalid. The closest lower legal
size is 1184×666. Ten measured warm node calls on the same single 600 W RTX PRO
6000 had a **14.313 s median** (14.102–14.389 s); all ten were under 15 s.
Compared with the same-runner 1280×720 median of 15.912 s, this was 1.599 s
(10.1%) faster with 14.4% fewer output pixels. This is timing evidence only;
the run did not compare image quality. Full results and per-call receipts are
in
[`h3-fullpower-1184x666-20261002`](../../../sol-refiner-vast-benchmark-2026-09-30/results/h3-fullpower-1184x666-20261002/).

The warm `inference_s` median was 13.136 s, but that timer combines the refiner
pipeline and Pruna VAE decode; the current worker does not report separate
input/text encoding, transformer, or decoder durations. Do not claim that
14.313 s is a transformer-only time or infer those sub-stages from it.

## Default-resolution OBS two-GPU validation (2026-10-02)

The installed OBS plugin routed FastH3 to one RTX PRO 6000 WS and the H3 SoL
upscaler to a second. FastH3 remained at 512×288; OBS selected the new default
1184×666 target. Fifty-eight upscale-worker reports succeeded at 1184×666,
24 fps, with audio. Their 57 warm calls had a 15.002 s median worker total
(14.678–15.137 s); 54 of 57 completed within the 15.083 s input duration.
The first cold request took 31.709 s including 11.666 s model loading.

OBS displayed the generated/refined stream after refreshing the Browser Source
once. The coordinator published 870 HLS segments. Its per-upscale stage timer
was slower (36.802 s median, 23.906–54.163 s) because it also includes media
staging and transfer. The live buffer became low/empty during the continuous
run, with up to 77 reported stall events; treat this as a successful functional
two-GPU validation, not a stall-free real-time qualification. The
[complete OBS run record](../../../sol-refiner-vast-benchmark-2026-09-30/results/obs-e2e-default-1184-20261002/RUN-REPORT.md)
contains the paired MP4 sample, worker reports, and 600 W power evidence.

## Verified full-power 1280×720 node run (2026-10-02)

The actual ComfyUI node completed ten warm 15-second/360-frame calls on one
RTX PRO 6000 Blackwell Workstation GPU. Its current/requested/default/max power
limits were 600 W; the NVENC smoke encode and isolated worker version checks
passed before model loading. The host-node median was 15.912 s (15.690–16.003
s), with all outputs validated at 1280×720, 24 fps, 360 frames, and copied AAC
audio. The first call was a cold setup outlier at 579.815 s, including 537.427
s to download/load the model; the second warmup was 16.325 s.

The worker exposes a 14.653 s median timer for the refiner pipeline plus Pruna
VAE decode, and a 0.752 s median aggregate MP4 export. It does **not** separate
input VAE encode, text encode, transformer, and decoder time. Do not infer those
individual stage costs from this run. CUDA pack median was 0.037 s; pipe write
was 0.394 s; FFmpeg wait was 0.307 s. The complete run report and raw receipts
are in
[`h3-fullpower-1280-20261002`](../../../sol-refiner-vast-benchmark-2026-09-30/results/h3-fullpower-1280-20261002/).

The full-power run is also the regression check for the setup failures below:
the worker executable path must preserve its venv symlink, and an NVENC-capable
container must be created with the `video` driver capability. Keep both checks
in the preflight so failure happens before model loading.

## Benchmark launch preflight failures (2026-10-02)

Two setup failures were found while preparing a full-power 1280×720 RTX PRO
6000 run. The first worker launch resolved the `.worker/bin/python` symlink to
`/usr/bin/python3.12`, so the worker could not import its isolated Diffusers
packages. Preserve the venv executable path; do not call `Path.resolve()` on it.
`benchmark_h3_node_calls.py` now preserves that symlink path, probes the exact
worker runtime, and has a regression test for the path behavior.

The first Vast container also launched without the NVIDIA `video` driver
capability. FFmpeg listed `h264_nvenc`, but it could not load
`libnvidia-encode.so.1`; the node then failed with `BrokenPipeError` during MP4
export after doing inference. Create NVENC benchmark containers with
`NVIDIA_DRIVER_CAPABILITIES=compute,utility,video`. The benchmark harness now
smoke-encodes a frame before model loading and records GPU power/clock samples
during the measured run. Changing an already-running container's environment
did not add the driver library; set the capability at container creation.

The RTX PRO 6000 offer advertises 600 W, and this host reports 600 W current,
requested, and default limits while idle. Full-power operation still needs the
same current-limit and power-draw evidence under actual benchmark load; do not
infer it from the offer's hardware maximum.

## Hardware power preflight correction (2026-10-01)

The recent safe-Pruna, prompt-cache and inference-mode trials used offer
33693061. Their preflight recorded the **600 W hardware maximum**, not the
applied/enforced limit. Vast currently advertises that offer at **300 W**,
consistent with its approximately 300 W draw in saved conversation samples.
The historical enforced limit was not saved. Their metadata now marks that
limit unknown, and these runs must not be labelled verified full-power 600 W
results. Their paired comparisons and pixel/audio checks remain valid on the
tested host; no full-power speed prediction follows from them.

See the [further investigation](../../../sol-refiner-vast-benchmark-2026-09-30/FREE-WINS-INVESTIGATION-20261001.md)
for the offer snapshot, full-power preflight requirements, and newly identified
fixed-prompt memory/caching opportunities.

## Target and current result

This node refines an existing MiniMax-H3 video. The comparison below uses the
benchmark workload: 360 frames at 24 fps (15 seconds), 512×288 input, and
1024×576 output, with source audio preserved. On an RTX PRO 6000 Blackwell
Workstation Edition (96 GB), the persistent ComfyUI graph produced a warm MP4 in
about 24.6 seconds and completed MP4 validation in about 25.6 seconds. That is
about 0.61× real-time throughput (15 / 24.6).

The measured `pruna_fast` decoder mode now reaches a warm MP4 in 7.43 seconds
(2.02× real-time), with all 360 frames and source audio preserved at 1K. It
keeps the H3 LTX-2.5 encoder, upsampler, and transformer and replaces only the
final diffusion decoder. The first request in a fresh worker was 15.49 seconds
including 6.90 seconds of model loading, so the strict 15-second threshold is
met on the persistent warm path; worker startup and the first public-weight
download are setup costs. The node defaults to this fast mode and retains
`diffusion` as the higher-quality option. See the benchmark report for temporal
and pixel-quality comparisons.

## 1280x720 transformer compilation (2026-10-01)

The 1280x720, 360-frame warm worker baseline was about 15.48 seconds in the
bracketed control arms. Three low-risk export changes did not produce a useful
gain: removing the Pruna output copy, using `torch.aminmax`, and changing NVENC
from p4 to p2/p1. The best combined small-change arm measured 15.47 seconds
(0.05% faster, within noise). Keep the copy, separate min/max validation, and
p4 encoder preset as their defaults.

Repeated transformer-block compilation was the only clear measured speedup.
In the 1280x720 screen, five measured requests had a 14.41-second median and
14.45-second maximum, versus a 15.48-second bracketed control median (6.9%
lower median). Peak PyTorch reservation was 81.45 GiB versus 81.99 GiB for
control, within the 10 GiB memory-headroom gate. A repeated candidate block
measured 14.29 seconds against a 15.03-second adjacent control. At the time of
this 2026-10-01 screen, the measured 1280x720 `pruna_fast` path enabled
repeated-block compilation by default; compilation remained off at other
output sizes and in `diffusion` mode. The current, broader default is
documented at the top of this file.

The warm result remains above the preferred 13-second target, and the first
screened compile request took 27.4 seconds. Treat compilation and model loading
as cold-start costs; the measured gain applies after the transformer has been
compiled in the persistent worker. The compile default is limited to the measured 1280x720 and 1184x666
profiles.

The matching control and compiled MP4s and detailed worker receipts are saved
under [`h3-speed-compile-1280-20261001`](../../../sol-refiner-vast-benchmark-2026-09-30/results/h3-speed-compile-1280-20261001/).
Frame samples looked alike in the rendered review, and the two encoded MP4s
measured 38.57 dB PSNR / 0.9847 SSIM against each other. That encoded-video
comparison is only a visual/consistency check; full pre-encode RGB24 quality
metrics and the ten-call Comfy host timing check were not completed because
fresh workers repeatedly tried to fetch uncached model files from the
unauthenticated Hub.

## Live LSF configuration check (2026-10-01)

The later two-GPU OBS/LSF run confirmed the benchmark-winning configuration was
active on real jobs. The live worker reports showed `decoder_mode=pruna_fast`,
`transformer_compiled=true`, `model_residency=cuda`,
`cpu_offload_enabled=false`, `pruna_output_contiguous=true`,
`gpu_aminmax=false`, NVENC with preset `p4`, and effectively zero model-load
time. The workflow provider explicitly selects `pruna_fast` and NVENC; the node
defaults to those too. At the time of this 2026-10-01 run, repeated
transformer-block compilation defaulted on for 1280×720 and remained off
elsewhere unless an operator explicitly overrode it. The current default
enables it for every `pruna_fast` output size.

That run took 19.0–19.3 seconds per 362-frame / 15.083-second Comfy job. Its
worker report measured roughly 16.0 seconds of inference and 1.9 seconds of
NVENC export. This does not contradict the 14.41-second benchmark: that was a
warm median over a fixed 360-frame / 15-second clip on a different Vast host,
with a fixed short prompt; its median inference was 13.56 seconds and its NVENC
export was about 0.69 seconds. The live Comfy graph forwarded the full LSF
story prompt—including dialogue and sound instructions—unchanged to the
upscaler. It did not supply a separate short upscale prompt. The compile,
decoder, and encoder settings and pinned model/runtime matched, so a missing
configured optimization does not explain the gap. This boolean does not prove
the live 369-processed-frame shape was warmed: the benchmark processed 361
frames. Prompt content differs, but the pinned text path pads both to 1024
slots and the connectors replace padding with learned registers; shortening
the prompt is not an established way to reduce that compute. The available
receipts do not isolate these differences from host/load variation;
the live host's GPU clock was sampled under load, while the old benchmark only
recorded clocks after calls had ended. The A/B comparison is therefore not
controlled enough to attribute the slowdown to one cause.

See the [full inference and overlap review](../../../sol-refiner-vast-benchmark-2026-09-30/INFERENCE-REVIEW-20261001.md)
for processor placement, unused audio-branch work, exact-shape warmup, and
quality-preserving streaming experiments. CPU video preparation can overlap
CUDA text encoding within the same clip; neural VAE stages run on CUDA.
Pruna currently returns the entire video before export, so FastH3-style
decoder/export overlap requires a context-preserving streaming interface.

The optimizations that produced the 14.41-second result are already defaults
for their measured profile. Do not globally enable `aminmax`, remove the Pruna
contiguous-output copy, or switch to NVENC `p1`/`p2`: the controlled speed screen
found no reliable gain from those changes.

## 369-frame inference candidate screen (2026-10-01)

A new matched screen used the actual 362-source-frame / 369-processed-frame
shape at 1280×720 on an RTX PRO 6000 Blackwell Workstation GPU running at its
600 W limit. It used the same source, prompt, seeds, BF16 one-step `pruna_fast`
path, two warmups and five measured requests per arm. The four bracketed
control medians were 20.64, 20.48, 21.07 and 21.76 seconds; the 6.1% control
drift means small apparent changes cannot be attributed to an optimization.
The outputs retained 362 frames at 24 fps and all 651 source audio packets.

| Candidate | Median worker time | Output check | Decision |
|---|---:|---|---|
| Video-only transformer forwarding | 21.52 s | MP4 byte-identical to control | No measured speed win; keep opt-in off |
| Async NVENC staging | 20.77 s | MP4 byte-identical to control | No reliable speed win; keep opt-in off |
| Video-only + async staging | 20.00 s | MP4 byte-identical to control | Apparent gain is below control drift; keep opt-in off |
| CPU input preprocessing overlapped with prompt encoding | 19.08 s vs 19.46 s control in a separate 3-sample screen | Identical CUDA YUV input hash, MP4 hash and 651 audio packets | Safe scheduling change, but timing is too noisy to promote |
| Compile Pruna decoder | 25.00 s | 46.00 dB PSNR / 0.9917 SSIM; failed the 0.995 SSIM gate | Slower and below quality gate; keep off |

The fastest individual combined request took 16.15 seconds end to end, while
its median was 20.00 seconds. This screen therefore does not meet the strict
15-second worker-time target. The previous 14.41-second result remains the
validated result for its own 360-frame / 361-processed-frame benchmark; this
longer temporal shape and different host run are not a controlled
before/after comparison. Raw arm receipts, output hashes and a sample MP4 are in
[`h3-inference-final-20261001`](../../../sol-refiner-vast-benchmark-2026-09-30/results/h3-inference-final-20261001/).

## Safe Pruna memory/copy changes (2026-10-01)

Two behavior-preserving Pruna changes are now enabled by default. The output
path crops/trims before pixel normalization, skips the one-item batch stack,
and retains the final contiguous frame buffer. The loader drops the unused
Pruna encoder before moving the VAE to CUDA; source conditioning continues to
use the separate refiner encoder. Both have control switches for benchmark or
rollback:
`COMFYSTREAM_SOL_H3_PRUNA_OUTPUT_COPY_OPT=0` and
`COMFYSTREAM_SOL_H3_PRUNA_DROP_ENCODER=0`.

They were A/B-tested on the same RTX PRO 6000 WS offer with the pinned CUDA 13
worker, 362 source frames / 369 processed frames, 1280×720, BF16, the same
prompt and seeds, two warmups and five measured calls per arm. All candidate
MP4 SHA-256 hashes matched the control exactly; FFmpeg quality comparison was
infinite PSNR / 1.0 SSIM. Every output retained 362 frames at 24 fps and all
651 source audio packets.

The bracketed control medians were 20.858, 21.094 and 21.124 seconds (1.26%
drift). The combined candidate median was 21.124 seconds, 0.14% above the
median control block, so these are not throughput wins. The Pruna encoder
change reduced measured peak PyTorch allocated and reserved memory by 0.594
GiB, matching the 637,873,794 encoder-weight bytes removed before CUDA
transfer. The output-copy change alone did not move the run's peak PyTorch
memory high-water mark; its full-video temporary copy is removed, but that
copy was not the run's peak. The strict 15-second target remains unmet.

Receipts, exact samples, hashes, metadata, and the sample MP4 are under
`h3-pruna-safe-20261001` (`sol-refiner-vast-benchmark-2026-09-30/results/h3-pruna-safe-20261001`).

## Repeated-prompt conditioning cache (2026-10-01)

The persistent worker now keeps an exact-key LRU of prompt embeddings and the
attention mask. The key includes the exact prompt, runtime device/dtypes,
loaded text/connector module identities and video-only mode. The cache holds at
most four entries / 64 MiB; the tested prompt used 8,396,800 bytes. Each hit
returns private tensor copies so downstream code cannot mutate the stored
conditioning. It is enabled by default; set
`COMFYSTREAM_SOL_H3_PROMPT_CACHE=0` to disable it.

The repeated-prompt A/B used the same 362-frame source and prompt for two
warmups and five measured calls per arm on an RTX PRO 6000 WS. The cache
arm reported a miss on its first call and hits on all five measured calls.
Control medians were 20.871 and 21.185 seconds; the control drift was 1.49%.
Cached median was 20.965 seconds, only 0.30% below the midpoint between those
controls, so a whole-worker speedup was not established. All outputs remained
byte-identical to control, with 362 frames and 651 source audio packets. This
uses 8.4 MB in the tested profile; keep the default only where repeated exact
prompts are expected. It does not close the 15-second target gap.

The prompt-cache timing, hit receipts and paired MP4s are under
`h3-prompt-cache-20261001` (`sol-refiner-vast-benchmark-2026-09-30/results/h3-prompt-cache-20261001`).

## Pruna `inference_mode` test (2026-10-01)

The worker can wrap only the frozen Pruna VAE forward in
`torch.inference_mode()` with `COMFYSTREAM_SOL_H3_PRUNA_INFERENCE_MODE=1`.
It is default-off. A matched CUDA 13 A/B kept the prompt cache, transformer
compile, copy cleanup, and unused-encoder removal identical in both arms. The
five measured inference-mode calls had a 21.024-second median; the bracketed
control medians were 20.770 and 21.092 seconds (1.54% drift). Relative to the
control midpoint, the candidate was 0.44% slower, so this test does not
establish a speed gain. All five cache-hit outputs matched control MP4 bytes
exactly, retained all frames and audio, and had equal quality metrics. Keep
inference mode opt-in until a future run shows a repeatable improvement.

The raw benchmark receipts (`sol-refiner-vast-benchmark-2026-09-30/results/h3-inference-mode-20261001`)
include per-call flags, timing and output hashes.

### Export profiling before further NVENC changes

The live worker's roughly 1.9-second `encode_seconds` is an aggregate FFmpeg
interval, not an isolated NVENC kernel time. It includes writing packed RGB
frames through a host pipe, FFmpeg input/color processing, H.264 encode, copying
source audio, and MP4 `faststart` relocation. In the controlled benchmark, CUDA
packing was about 14 ms and device-to-host copying about 18 ms, while aggregate
export was about 0.69 seconds. A later live job's 1.9-second value therefore
needed stage timing before attributing it to NVENC. That timing is now in the
worker report as `pipe_write_seconds` and `ffmpeg_wait_seconds`.

The lower-byte YUV420P input path is now the NVENC default, with the original
RGB24 path available through
`COMFYSTREAM_SOL_H3_NVENC_INPUT_FORMAT=rgb24`. It converts RGB to limited-range
BT.601 YUV420P on CUDA before the host copy. On the same 362-frame, 1280×720
LSF input, two warm worker calls measured 1.862 seconds median aggregate export
for RGB24 versus 1.180 seconds for YUV420P; median total worker time improved
from 18.092 to 17.376 seconds. Pipe-write time fell from 1.622 to 0.886 seconds
median. Raw frame-pipe volume and four-frame pinned staging both halved from
11.06 MB to 5.53 MB per batch. Model inference medians were effectively the
same (15.672 versus 15.667 seconds), isolating the gain to export.

The output stayed 1280×720, 362 frames, 24 fps, 15.083 seconds, and all 647
source audio packet payloads matched exactly. The RGB/YUV encoded outputs
measured 48.31 dB PSNR / 0.9932 SSIM; the reviewed contact sheet showed no
visible difference. They are not pixel-identical, but this path passed the
visual and audio-preservation checks for this H3 workload. See
`rgb-vs-yuv.png` (`sol-refiner-vast-benchmark-2026-09-30/results/yuv420p-transport-ab/rgb-vs-yuv.png`).
The export gain is measurable, but the complete model path still exceeds
real-time throughput.

The `p1`/`p2` presets already showed no reliable improvement. Direct
GPU-resident frame transfer into NVENC could reduce pipe traffic further, but
requires an export-path rewrite and its own audio, seekability, and visual
comparison. Keep that approach experimental until measured.

### Reuse across the FastH3 custom node

The production FastH3 B1 path already uses its own fused Triton packer
(BCTHW→RGB24 uint8), then copies through pinned host buffers on a dedicated
CUDA stream into a bounded queue serviced by a background PyAV encoder. It
already selects H.264 NVENC for the production provider path; the generic
encoder class's libx264 default is not the production workflow setting. Thus
the SoL export fix is **not already present** in FastH3: it still transfers
three-byte RGB24 frames and lets PyAV/libav convert to YUV420P. At FastH3's
default 512×288 / 362-frame shape, RGB24 is about 160 MB and YUV420P about 80
MB, but the existing transfer/encode overlap may hide much of that cost.

A FastH3 YUV420P variant is feasible, but must keep FastH3's BT.709 color tags,
its existing RGB truncation semantics, PyAV planar-plane line sizes, pinned
DMA ownership, queue backpressure, and its generated AAC audio. SoL's measured
BT.601 conversion and source-audio packet-copy test must not be copied
unchanged. Profile FastH3's existing `transfer`, `prepare`, `mp4_encode`, and
first-packet timings first, then use the same captured latent/audio with an
alternating RGB/YUV A/B and visual/audio checks before promoting anything.

The reverse transfer is smaller: FastH3's bounded producer/encoder queue and
separate CUDA copy stream could overlap SoL's YUV packing, D2H copy, and FFmpeg
pipe writes. SoL currently synchronizes each four-frame copy then blocks on its
pipe write, but export runs after model inference, so this can only shorten
export by a few tenths of a second; it cannot hide the refiner's inference.
Architecture-specific fusions do not transfer: FastH3's MiniMax VAE,
FP4/SwiGLU, and attention kernels do not match the LTX-2.5 refiner internals,
and SoL's Pruna decoder consumes LTX latents rather than MiniMax-H3 latents.
Both nodes already keep their model weights on CUDA and disable CPU offload.

The media audit also found that the previous exporter applied a global `-t`
limit while copying AAC audio with a negative priming timestamp; those older
single-output files contained 641 of the source's 647 audio packets. The
exporter now bounds only video with `-frames:v`. A real FFmpeg regression test
and remux of the saved 1K/1280 samples confirmed all 647 source audio packet
payloads are retained while each video bitstream remains unchanged at 360
frames / 24 fps / 15 seconds. The square comparison already contained all 647
packets.

The speed screen predates this audio-mux correction. Transformer inference is
unchanged, but full worker time after the mux fix has not been remeasured.

A diffusion-decoder-only 1024-pixel spatial tile reached 20.85 seconds MP4-ready and
21.79 seconds including validation in one warm run. This is still above the
15-second target: it needs another 1.39× speedup to meet the MP4-ready target.
The run peaked at 89.94 GiB allocated and 93.21 GiB reserved out of 95.59 GiB
visible to PyTorch, so it leaves little room for ComfyUI, other nodes, or
external CUDA allocations. It is not the production default.

The 768-pixel default's instrumented warm runs averaged 24.88 seconds MP4-ready.
Within inference, the diffusion decoder took about 18.3 seconds, the refiner
denoising call about 4.6 seconds, video encode about 0.55 seconds, text encode
about 0.17 seconds, and latent upsample about 0.06 seconds. With the full-width
tile the diffusion decoder fell to 14.39 seconds. The decoder, especially
overlapping spatial tiles, is the largest measured target. The MP4-ready clock
includes input decode, output packing, video encode, and audio mux; validation
is reported separately.

Detailed receipts and quality caveats are in
[`GPU_RESIDENT_RESULTS.md`](../../../sol-refiner-vast-benchmark-2026-09-30/GPU_RESIDENT_RESULTS.md)
and the adjacent `results/h3-ltx25-*` benchmark JSON files.

## Prioritized options

1. **Improve the fast decoder's quality without losing its latency.** The
   public Pruna LTX decoder reduces warm MP4-ready time from 24.64 to 7.43
   seconds. It changes fine detail and shows a small eight-phase sharpness
   variation, so a decoder distilled or tuned on H3-conditioned LTX-2.5 latents
   could improve quality. Preserve the 1K/360-frame/audio contract and repeat
   the temporal check before replacing the fast default.

2. **Reduce decoder overlap or use a larger decoder tile when VRAM allows.**
   The 1024-pixel full-width tile completed about 4.0 seconds faster than the
   768-pixel tiled benchmark, but used 89.94 GiB allocated and 93.21 GiB
   reserved. Keep it an opt-in profile for a dedicated 96 GB GPU until it has
   repeated runs, ComfyUI headroom measurements, and quality checks. Larger
   decode tiles are also recommended by the official LTX-2.5 ComfyUI workflow
   notes, which state that fewer tiles run faster at the cost of memory.

3. **Keep transformer compilation explicit and measurable.** Repeated-block
   `torch.compile` improved warm worker latency by 6.9% at 1280×720 and 5.8% at
   1184×666. It is now the default at every `pruna_fast` output size, with an
   environment opt-out for diagnosis or compatibility. Track cold compile
   costs and validate new shapes independently; CUDA graphs, compiled diffusion
   decode, and additional fused kernels remain unmeasured hypotheses.

4. **Benchmark a compatible attention backend and reduced precision.** The
   transformer defaults to dynamic NVFP4 on Blackwell, with MXFP8 and BF16 as
   manual overrides; the reference decoder uses native NATTEN. The measured
   NVFP4 path is faster and uses less memory, but differs visibly from MXFP8
   (full-video SSIM 0.8895). Check quality on motion-heavy and detail-sensitive
   content before broad use. Do not expect generic SDPA or FP16 advice to
   automatically help. SageAttention documents LTX support, but model
   compatibility and quality still need checking for this specific pipeline.

5. **Lower the work contract when acceptable.** Fewer frames, lower output
   resolution, or a lower frame rate reduces video-token and decode work. For
   example, returning 832×468 instead of 1024×576 or using a 15 fps output can
   trade spatial detail or motion smoothness for latency. Measure the actual
   end-to-end effect; the input duration can remain 15 seconds while the number
   of processed frames or output pixels falls. Optional interpolation or a
   separate super-resolution stage may restore appearance, but its cost and
   artifacts belong in the same timing budget.

6. **Try cache methods only where repeated evaluations exist.** This node's
   H3-conditioned transformer denoising is already configured for one
   conditional step, so timestep caching cannot skip additional transformer
   steps there. The diffusion decoder may expose repeated evaluations that
   could benefit from attention/feature caching, but compatibility must be
   established from its implementation. Diffusers' PAB, FasterCache, and
   TaylorSeer methods trade exact computation for cache reuse and can alter
   quality; use them as decoder experiments, not as an assumed speedup.

7. **Use a faster GPU or supported multi-GPU execution.** A higher-throughput
   GPU with enough VRAM may speed the decoder without changing the model.
   Sequence/tensor parallel execution may also reduce wall time if the decoder
   supports it, but communication and model changes can erase the gain. Record
   the exact GPU and cost per completed video; no multi-GPU result is available
   for this node.

8. **Treat a new distilled generator as a product-level alternative, not a
   drop-in refiner optimization.** Public research and implementations report
   real-time or faster video generation for other models and workloads. For
   example, TurboDiffusion reports 5 seconds of Wan2.1 480p output in 1.9
   seconds on an RTX 5090 using sparse attention and timestep distillation.
   This demonstrates that the broad latency target is possible for a different
   model/workload; it does not preserve this node's H3-conditioned refinement
   behavior or establish performance here.

## What is already optimized

- Single conditional denoising step, dynamic NVFP4 transformer weights on
  Blackwell, MXFP8/BF16 selectable, and full CUDA residency.
- The default Pruna fast convolutional decoder skips loading the large
  diffusion-decoder component; measured peak allocated VRAM is 76.70 GiB.
- Native NATTEN and fused, bit-exact rotary math are used by the reference
  diffusion-decoder mode. Fast mode skips both with that decoder.
- CPU model offload is intentionally disabled for both latency paths.
- CUDA-side YUV420P packing with bounded pinned-memory batches and NVENC output;
  RGB24 remains available as an opt-out for A/B or rollback.
- Persistent worker and allocator configuration to avoid model reload and
  allocator retries on repeated requests.

The earlier CPU-offload run took about 50.6 seconds MP4-ready, so offload is a
memory fallback, not a speed optimization. The current denoiser is already
one-step; reducing its step count is not an available shortcut without
retraining or replacing model components.

## Research sources

- [Lightricks LTX-2.5 ComfyUI workflows](https://github.com/Lightricks/ComfyUI-LTXVideo/blob/master/example_workflows/2.5/README.md): single-stage distilled workflow is described as faster/lighter; larger decode tiles reduce tiling overhead at higher VRAM use.
- [Diffusers caching guide](https://huggingface.co/docs/diffusers/v0.36.0/en/optimization/cache): PAB, FasterCache, and TaylorSeer reuse attention or intermediate features across denoising steps, with speed/memory/quality tradeoffs.
- [SageAttention](https://github.com/thu-ml/SageAttention): includes LTX-Video examples and compile options; integration is model-specific, and the upstream examples call out warm-up and compatibility caveats.
- [TeaCache paper](https://arxiv.org/abs/2411.19108): reports up to 4.41× on Open-Sora-Plan; this is a different model and multi-step workload, not a forecast for the one-step H3 transformer.
- [TurboDiffusion](https://github.com/thu-ml/TurboDiffusion): reports a 1.9-second Wan2.1 1.3B 480p/5-second generation on RTX 5090; it combines model-specific sparse attention and timestep distillation and is not an H3 refinement benchmark.
- [Hugging Face Diffusers optimization guide](https://huggingface.co/docs/diffusers/en/optimization/fp16): documents attention backends, compilation, reduced precision, and warm-up/shape considerations for diffusion inference.

## Benchmark acceptance criteria

Use the same 15-second input, prompt, seed, output resolution, frame count,
audio, GPU, and software pins for each comparison. Synchronize CUDA around
measured stages. Report cold load/compile separately; for the target, time from
node request start until the valid MP4 with copied audio is ready. Include
multiple warm runs, median and spread, peak allocated and reserved VRAM, and
visual/temporal quality checks. The goal is **less than 15 seconds MP4-ready**
at the agreed 360-frame, 1024×576 quality contract; denoiser-only timing does
not satisfy it.
## Optional shared VAE GPU experiment

The [shared VAE benchmark](../../../docs/experiments/shared-vae-upscale-benchmark-2026-10-02.md)
adds a dedicated VAE/latent-upsample/Pruna GPU with two to four transformer GPUs,
bounded tensor transfers, overlap blending, and one final video encode. It
removes the split/chunk-file/assembly pipeline. CPU and real FFmpeg media tests
verify scheduling and media contracts; three-GPU latency and visual quality
were benchmarked on a 15-second clip: warm end-to-end medians were 17.46 s for
one RTX 5090, 18.68 s for two-GPU splitting, and 11.07 s for the shared VAE
topology. This is one scene, with a prompt/source semantic mismatch; review the
[runbook and output](../../../benchmark-results/shared-vae-h3-5090-3gpu-20261002/REPORT.md)
before inferring general quality. Compare end-to-end wall times, since stage
sums and the streaming encoder lifetime overlap. The optional node remains a
benchmark; it was not made the default.
