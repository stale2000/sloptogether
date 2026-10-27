# FastH3 generation node

This package provides SlopTogether's first-stage H3 video generation nodes for
ComfyUI. It includes the sampler, conditioning, VAE decode, and streamed output
path used by the pinned worker recipes. The package does not include model
weights; use the model revisions and hashes in
[`fasth3-environment.json`](../../vast/fasth3-environment.json).

## Product vision: live AI video at consumer-GPU economics

SlopTogether aims to make always-on, interactive AI video practical on
consumer-class GPUs, with a target GPU operating cost below $2 per hour. The
long-term ambition is up to 200× lower cost than higher-cost video-generation
alternatives—potentially opening up always-on streams, interactive storytelling,
community-driven worlds, and experiments that per-clip pricing makes difficult.

These figures describe goals, not measured claims. This repository does not
establish a 200× apples-to-apples saving, an end-to-end cost below $2/hour, or a
"best in the world" ranking. The current runtime targets Linux/NVIDIA workers;
consumer-GPU and RTX 4090/WSL2 operation still need hardware qualification.

## Runtime

The pinned worker targets Linux, NVIDIA GPUs, Python 3.12, CUDA 13, and the
ComfyUI/Kitchen versions recorded in the environment manifest. Model weights
are downloaded separately and are not redistributed by this package. Follow
the [worker deployment guide](../../vast/README.md) to prepare the runtime.

The standard generation workflow uses `FastH3OptimizedLoader`,
`ComfyStreamerH3ImageToVideo`, `FastH3BenchmarkSampler`,
`FastH3BenchmarkVAEDecode`, `FastH3BenchmarkVAEDecodeAudio`, and
`FastH3BenchmarkOutput`. `ClipProjApply` is supplied by the separately pinned
ComfyUI-ClipProj extension. FastH3 generation and the optional SoL refinement
stage are separate nodes and workers.

The node supports the pinned five-step Trim workflow and its configured VSA
attention path. The five-step schedule is exploratory; this repository does
not establish production quality, continuous real-time reliability, or support
for every GPU/model combination.

## Install and use

Use the deployment package and pinned dependencies from this repository rather
than cloning a different public node repository. Install the ComfyUI-ClipProj
dependency and model assets as described in the
[worker deployment guide](../../vast/README.md), then load the SlopTogether
generation recipe. No weights, private credentials, or sample videos are
bundled here.

The optional adaptive VSA route redistributes a fixed per-head attention
budget. Its current speed comparison was effectively tied with fixed routing,
and its visual quality has not been evaluated. The loader's `fixed` setting
remains available as the reference route.

This project is licensed under the [MIT License](LICENSE). Third-party
components retain their included licenses and notices.
