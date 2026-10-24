# Vast FastH3 workers

Use the shared [deployment guide](../../docs/operations/deployment.md) for
the supported Comfy deployment workflow, and the [recovery guide](../../docs/operations/recovery.md)
when an existing worker or preview fails. This page owns Vast-specific offer
quoting, storage, bootstrap, private-bundle, SSH, and recovery details. The
environment contract is [`fasth3-environment.json`](fasth3-environment.json).

Vast workers must use [`fasth3-environment.json`](fasth3-environment.json).
Generic CUDA smoke-test images are not ComfyUI/FastH3 workers. Use a
CUDA 13.0-compatible Python 3.12 base image; the bootstrap and manifest define
the worker environment.

For the complete two-worker OBS test procedure, cold-start costs, warm-restart
steps, and historical live test record, see the [OBS E2E runbook](obs-dual-gpu-obs-runbook.md)
and its [historical live-test record](../../benchmark-results/obs-stutter-debug-20261002/live-test-status.md).
For the opt-in **Drama 3 on the FastH3 generator + separate SoL upscaler** OBS
experiment, see the [RTX 6000 E2E test procedure](../../docs/experiments/obs-fasth3-drama3-rtx6000-e2e-test.md).

SoL-upscaler bootstrap also runs
[`qualify_h3_upscale_gpu.py`](../../scripts/qualify_h3_upscale_gpu.py) before
launching ComfyUI. It tests loaded clocks with a five-second BF16 probe and
writes `h3-gpu-qualification.json`. A 600 W advertisement or an idle clock
does not prove performance: the 2026-10-02 rental stayed near 885–975 MHz
under load and failed. A median below 1500 MHz, reduced power allowance, or
inadequate loaded samples blocks launch. This screens severe underclocking;
the actual warm H3 timing and OBS continuity checks remain required. See the
[GPU 2 diagnosis](../../benchmark-results/obs-stutter-debug-20261002/gpu2-root-cause.md).

The `COMFYSTREAM_INSTALL_SOL_H3_REFINER=1` bootstrap path requires exactly
one visible RTX PRO 6000 Blackwell Workstation GPU for this qualification.
It runs the check even when `COMFYSTREAM_SKIP_LAUNCH=1`. For RTX 5090 refiner
benchmarks, install the isolated runtime separately as described in the
[Lium deployment notes](../lium/README.md#rtx-5090-deployment-notes), and
qualify that hardware with the corresponding warm workload measurements.

Required runtime:

These ComfyUI and Kitchen pins match the v0.36 / Kitchen 0.2.34 stack used
for the reviewed FastH3 benchmarks. `fasth3-environment.json` is authoritative;
keep the Vast bootstrap, Comfy build spec, and benchmark setup aligned with it.

| Component | Value |
| --- | --- |
| Python | 3.12.x |
| ComfyUI | 0.36.0 (`ee71d5c4993f29086b27fde1629a945ae48425bf`) |
| PyTorch | 2.14.0+cu130 |
| Torch CUDA runtime | 13.0 |
| torchvision | 0.29.0+cu130 |
| torchaudio | 2.11.0+cu130 |
| comfy-kitchen | 0.2.34 |
| comfy-aimdo | 0.5.3 |
| Triton | 3.8.0 |

The Kitchen wheel is hash-pinned in the manifest; do not substitute a same-
version rebuild or another Kitchen release without rerunning the benchmarks.

## Model source contract

`download_fasth3_models.sh` separates the Hugging Face source path from the
ComfyUI install path. Keep this mapping intact; the Kijai video-VAE artifact is
stored at repository root but must be installed below `models/vae/`.

| Installed path | Source repository | Source path |
| --- | --- | --- |
| `models/diffusion_models/fastvideo_fasth3_8step_v2_pruned_int8_convrot.safetensors` | `FastVideo/FastVideo-FastH3-Comfy` | `diffusion_models/fastvideo_fasth3_8step_v2_pruned_int8_convrot.safetensors` |
| `models/diffusion_models/fastvideo_fasth3_trim_8step_int8_convrot.safetensors` | `FastVideo/FastVideo-FastH3-Trim-Comfy` | `diffusion_models/fastvideo_fasth3_trim_8step_int8_convrot.safetensors` |
| `models/text_encoders/qwen3vl_4b_fp8_scaled.safetensors` | `Comfy-Org/Qwen3-VL` | `text_encoders/qwen3vl_4b_fp8_scaled.safetensors` |
| `models/clip_projections/mmh3-4b-ClipProj-v3.1-mlp.safetensors` | `NicoLab28/ClipProj-MiniMax-H3` | `mmh3-4b-ClipProj-v3.1-mlp.safetensors` |
| `models/vae/minimax_h3_audio_vae_fp32.safetensors` | `Comfy-Org/MiniMax-H3` | `vae/minimax_h3_audio_vae_fp32.safetensors` |
| `models/vae/minimax_h3_video_vae_int8_convrot.safetensors` | `Kijai/MiniMax-H3-experimental` | `minimax_h3_video_vae_int8_convrot.safetensors` |

The manifest hashes are authoritative. A download that completes but fails a
hash check is not a usable model set and must not be loaded by ComfyUI.
The bootstrap also installs `ComfyUI-ClipProj` at the pinned commit in the
manifest, so the B1 workflow's `ClipProjApply` node is available at startup.
The FastVideo repository is revision-pinned by the operator because its
revision is access-controlled; set `HF_REVISION_FASTVIDEO` to the reviewed
commit used for the deployment. The Qwen, ClipProj, audio VAE, and video VAE
sources use the pinned commits in `fasth3-environment.json`.

## Startup contract

`scripts/vast_fasth3_onstart.sh` pins a Git checkout using an explicit
40-character `COMFYSTREAM_REF` commit SHA. For a private repository, use the
local bundle procedure below instead of an anonymous clone.

The onstart script starts preparation in the background so Vast can finish
bringing up SSH while a bundle, dependencies, or models are being prepared.
The defaults are `/workspace/fasth3-bootstrap.log` and
`/workspace/fasth3-bootstrap.pid`; override them with
`COMFYSTREAM_BOOTSTRAP_LOG` and `COMFYSTREAM_BOOTSTRAP_PID` when needed.
`COMFYSTREAM_BOOTSTRAP_FOREGROUND=1` runs preparation in the foreground for
diagnosis. Startup holds a `flock` lock across preparation and the worker
process, so a repeated startup does not launch a duplicate preparation.
`flock` must be available; `COMFYSTREAM_BOOTSTRAP_LOCK` overrides the default
`/workspace/fasth3-bootstrap.lock`. The PID file is informational. A returned
onstart command or a PID file does not prove readiness.

`scripts/vast_fasth3_bootstrap.sh` installs and validates the package family
before launching ComfyUI. It uses an available Python 3.12 interpreter or
creates the pinned conda environment when installation is enabled and conda
is available. When using `/usr/bin/python3`, a root Ubuntu worker installs
`python3.12-venv` if `ensurepip` is missing. Other Python installations must
already support venv creation.

Before downloading another PyTorch stack, bootstrap compares installed
`torch`, `torchvision`, `torchaudio`, and `triton` package metadata against the
manifest. When all four match exactly, it creates the venv with
`--system-site-packages` and reuses those base packages, avoiding duplicate
downloads. The final environment validation still runs before launch.

With `COMFYSTREAM_INSTALL=1`, bootstrap downloads the model set by default
before validation. `COMFYSTREAM_DOWNLOAD_MODELS=1` also enables downloads when
using an existing environment. The downloader reuses existing files only
after their hashes match the manifest. It resumes incomplete files. If the
resumed download's hash is wrong, it downloads again from byte zero into a
temporary file beside the target, verifies the hash, then atomically replaces
the target. A failed fresh download or hash check does not install that file.
The unauthenticated path also supports Bash 3 with `set -u`.
Set `HF_REVISION_FASTVIDEO` to a
reviewed 40-character commit SHA; access-controlled downloads may also need
`HF_TOKEN` supplied through the operator's authorized runtime environment.
Keep credentials out of the project bundle and documentation.

FastH3 **generator** hosts must keep `COMFYSTREAM_REQUIRE_MODELS=1` (the
default). A dedicated H3 SoL **upscaler** host does not run the FastH3
generator and should set `COMFYSTREAM_REQUIRE_MODELS=0` to skip downloading
and validating the generator's 20.6 GB checkpoint. Keep
`COMFYSTREAM_INSTALL_SOL_H3_REFINER=1` so the upscaler node and its isolated
runtime are installed. The H3 SoL Refiner weights are separate and are loaded
on the first upscaler request, not when ComfyUI imports the node. Setting
`COMFYSTREAM_REQUIRE_MODELS=0` on a generator host still does not make it ready
to generate. A FastH3 generator fails closed if it detects CUDA 12, Python
3.11, mismatched package versions, or missing or invalid generator models.

## Quote and create with the same storage allocation

Include the requested disk in the offer search:

```sh
vastai search offers '<reviewed-offer-filter>' --storage 120 --raw
```

For the 2026-09-29 replacement, the initial $1.0727/hour quote used the search
default of 5 GB. The operator approved $1.2111/hour total for the worker with
120 GB. Future launches must check their current total quote; these incident
prices describe that replacement.

Example creation for a repository the worker can read:

```sh
vastai create instance <RTX5090_OFFER> \
  --image <CUDA13_PYTHON312_IMAGE> \
  --disk 120 --ssh --direct \
  --label comfystream-fasth3-v036 \
  --env '-e COMFYSTREAM_INSTALL=1 -e COMFYSTREAM_REF=<reviewed-commit> -e HF_REVISION_FASTVIDEO=<reviewed-model-commit>' \
  --onstart scripts/vast_fasth3_onstart.sh
```

The create command's `--onstart` argument is a local **filename**: the
installed Vast CLI reads that file and sends its contents. Confirm the saved
startup command contains the script, not merely a path.

## Private repository: upload a reviewed local bundle

Create a bundle from a reviewed commit and record its checksum:

```sh
git archive --format=tar <reviewed-commit> -o /tmp/comfystream-reviewed.tar
tar -tf /tmp/comfystream-reviewed.tar
shasum -a 256 /tmp/comfystream-reviewed.tar
```

Review the archive contents before transfer. A commit archive contains tracked
files and omits `.git`; tracked files still need review for credentials. If
deploying local fixes before committing them, package only the reviewed
tracked file snapshot and record both its base commit and archive checksum.
An archive of the base commit alone will not contain those uncommitted fixes.

Use the creation command above with `COMFYSTREAM_LOCAL_BUNDLE=1` added to
`--env`. The startup process waits for
`/workspace/comfystream/.vast-bundle-ready`. Upload and extract the bundle
before creating that marker:

```sh
scp -P <ssh-port> /tmp/comfystream-reviewed.tar root@<ssh-host>:/workspace/
ssh -p <ssh-port> root@<ssh-host> \
  'mkdir -p /workspace/comfystream && tar -xf /workspace/comfystream-reviewed.tar -C /workspace/comfystream && touch /workspace/comfystream/.vast-bundle-ready'
```

The local bundle mode does not fetch or validate `COMFYSTREAM_REF`; the
operator must establish its provenance with the reviewed commit and bundle
checksum. Do not upload a local GitHub credential store or an SSH private key.

If the authorized SSH key has a nondefault local filename, add a local SSH
configuration entry:

```sshconfig
Host ssh*.vast.ai
  IdentityFile ~/.ssh/<authorized-private-key-file>
  IdentitiesOnly yes
```

For a direct-IP endpoint, add its own matching host entry or use
`ssh -i ~/.ssh/<authorized-private-key-file> -p <ssh-port> root@<ssh-host>`.
Only the corresponding public key is registered with Vast.

## Update startup without changing the script into a path

For the installed CLI used in this deployment, **update** `--onstart` accepts
literal script text, unlike create. Update `--env` takes a JSON object with
plain variable names and must preserve the other existing environment values.
The API also required `--image` on the update, including environment-only
updates. Use the current image unless intentionally replacing it.

Prepare a reviewed JSON file containing the complete desired environment,
then pass the script contents as a single subprocess argument:

```python
import json
import subprocess
from pathlib import Path

environment = json.loads(Path("<reviewed-environment.json>").read_text())
# Example keys: {"COMFYSTREAM_LOCAL_BUNDLE": "1",
#                "COMFYSTREAM_REQUIRE_MODELS": "1"}
subprocess.run(
    [
        "vastai", "update", "instance", "<instance-id>",
        "--image", "<current-image>",
        "--env", json.dumps(environment),
        "--onstart", Path("scripts/vast_fasth3_onstart.sh").read_text(),
    ],
    check=True,
)
```

Inspect the saved configuration after an update. Failed log or SSH access
after an update calls for checking actual instance state and connectivity;
it does not establish data loss or the cause of the outage.

## Recover from unavailable SSH or a stalled model copy

A remote model copy is an optimization, not evidence that the models are
installed. Verify the destination files and hashes before using a copied
cache. During this incident, copying approximately 39 GB from the original
worker was attempted, but completion was not verified.

If the instance remains in `Receiving copy...`, check its actual state,
transfer progress, SSH endpoint, and available logs. An accepted copy-cancel
request does not prove the container is healthy. If recovery requires a stop
and restart, verify that the actual instance state has reached exited/stopped
before issuing the restart. A log timeout alone does not prove a live
operation has ended.

For a dependency download failing with `NameResolutionError`, check current
name resolution and retry after connectivity recovers. The incident recovery
did not change DNS configuration; later name-resolution checks succeeded.
Use the manifest-matched base package reuse above when available, and retain
the final environment and model validation gates.

## Verify worker and OBS readiness

The base image is not the environment contract; the bootstrap and manifest
are. Read the preparation log and validate the installed worker:

```sh
ssh -p <ssh-port> root@<ssh-host> 'tail -n 80 /workspace/fasth3-bootstrap.log'

# Run this on the worker, after model preparation:
/workspace/venv-fasth3/bin/python \
  /workspace/comfystream/scripts/validate_fasth3_environment.py \
  --comfyui-root /workspace/ComfyUI --require-models
```

Confirm the ComfyUI endpoint is reachable, then complete a generation through
ComfyStreamer and verify the generated video is playing in OBS. Keep OBS
streaming off when the request is local generation only. A reachable endpoint
or connected source is not evidence that generated video reached OBS.

The [release qualification guide](../../docs/architecture/release-qualification.md)
records the last observed deployment status. Recheck the live worker before
acting on that dated snapshot.
