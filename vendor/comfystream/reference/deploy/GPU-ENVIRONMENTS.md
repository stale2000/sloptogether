# GPU deployment environment inventory

This inventory separates maintained deployment profiles from benchmark and test
images. A profile marked **pending** has known runtime facts, but does not yet
have target build and GPU qualification evidence, or still has external inputs
such as an operator-supplied base image or OS/compiler identity. A consumed
package lock alone does not qualify a deployment.

Vast and H3 upscaler source manifests record input digests, consumed locks,
source and model refs, base-image identity, and explicit pending qualification
status. They intentionally omit themselves from their file maps. Verify them
without writes, or regenerate after reviewed source changes:

```sh
uv run --locked --group dev python scripts/deployment_source_manifest.py --profile vast-fasth3 --check
uv run --locked --group dev python scripts/deployment_source_manifest.py --profile fal-h3-sol-upscaler --check
```

To update a reviewed manifest, replace `--check` with `--write` for that
profile, then run its read-only check again.

## Maintained profiles

| Profile | Build inputs and source | Known runtime | Lock and reproducibility status |
| --- | --- | --- | --- |
| Vast FastH3 generator | `scripts/vast_fasth3_bootstrap.sh`, `deploy/vast/fasth3-environment.json`, pinned ComfyUI ref in that manifest; operator supplies a CUDA 13/Python 3.12 base image; provenance in `deploy/vast/source-manifest.json` | Python 3.12; Torch 2.14.0+cu130 / CUDA 13.0; torchvision 0.29.0+cu130; torchaudio 2.11.0+cu130; Kitchen 0.2.34; Aimdo 0.5.3; Triton 3.8.0; model SHA256s and Git revisions in the manifest | **Python closure consumed and hash-locked** by `deploy/vast/requirements.lock`, compiled for Python 3.12/x86_64/manylinux and installed with pip hash enforcement. The exact Kitchen wheel is installed separately after comparing against its manifest SHA256. The operator image has no recorded immutable identity; OS package inputs and native compiler identity depend on that image. Target build and GPU qualification are pending. |
| Fal FastH3 B1 | `deploy/fal/fasth3-b1/Dockerfile`, `entrypoint.sh`, `pyproject.toml`, staged by `scripts/prepare_fasth3_fal_context.py` | Python 3.12; Torch 2.14.0+cu130 / CUDA 13.0; torchvision 0.29.0+cu130; torchaudio 2.11.0+cu130; ComfyUI `ee71d5c4993f29086b27fde1629a945ae48425bf`; Kitchen 0.2.34; Aimdo 0.5.3; Triton 3.8.0; main model revisions and hashes in `deploy/vast/fasth3-environment.json`; Trim checkpoint `f66c13dc17391dd4da99242a407918b92bf7d5fc`, SHA256 `ff6e40bc592f7362ea0d7bfcf4e0402bb2c26376d9d1bd4fffb047a5203c2153` in the entrypoint | **Python closure consumed and hash-locked** by `deploy/fal/fasth3-b1/requirements.lock`; Kitchen is separately installed after its manifest SHA256 check. The Dockerfile pins registry digest `sha256:cce09744eb864371df6423aaba413145afb65794837be783c33446e7ef615d20` for linux/amd64. Apt package snapshot and runtime native-extension compiler/toolchain are not pinned; target build and GPU qualification remain pending. |
| Fal H3 SoL upscaler | `deploy/fal/h3-sol-upscaler/Dockerfile`; ComfyUI ref shared with the FastH3 manifest; `custom_nodes/comfystream_sol_refiner_h3/requirements-worker.txt`; provenance in `deploy/fal/h3-sol-upscaler/source-manifest.json` | Host Python/Torch/CUDA follows the FastH3 host tuple. The isolated worker intentionally uses Torch 2.13.0+cu130, CUDA 13.0, torchvision 0.28.0+cu130, Triton 3.7.1 and NATTEN 0.21.7+torch2130cu130, as recorded by the node's runtime manifest. | **Host and worker closures consumed and hash-locked** by profile/worker `requirements.lock` files; Kitchen is separately installed after its manifest SHA256 check. The Dockerfile pins the same verified linux/amd64 base digest as B1. The worker's Diffusers source is pinned to commit `e0abab83b5df05de9e7abd788643c1a7c1e42e28` and installed with the hash-locked dependencies. Apt and native-extension compiler/toolchain inputs are not pinned; target build and GPU qualification remain pending. |

## Test and experiment images

These paths are retained for named tests or experiments. Their presence in the
repository does not establish ongoing deployment support or reproducibility:

| Profile | Evidence and current classification |
| --- | --- |
| `deploy/fal/drama3-h3-test` | Test image; Dockerfile and README identify a Drama3 test deployment. Dependency closure pending if promoted to maintained. |
| `deploy/fal/fasth3-drama3-obs-test` | Explicit OBS test deployment; experiment pending qualification. |
| `deploy/fal/forcingbooster-trim` | Trim/speculative probe candidate described as exploratory in its README; do not treat as the maintained B1 baseline. |
| `deploy/fal/sm120-attn-bench` | Attention benchmark artifact; not a general worker image. |

## Qualification rule

The current records preserve known CUDA, Torch, ComfyUI, model and node-runtime
selections. The Fal Docker profiles pin an immutable registry digest and platform;
Vast operators supply the base image and must record its own identity. Python
locks include hashes for the complete resolved package closure and are consumed
by the build/bootstrap. The SoL worker separates its immutable Git source from
its binary-only hash lock. Apt packages and native CUDA compiler inputs remain
bounded reproducibility exceptions. Target builds, package checks, startup/import
checks and GPU workload evidence are separate gates; CPU checks do not qualify
a GPU image.
