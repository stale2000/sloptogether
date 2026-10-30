# Shared GPU worker

This Python 3.12 source program is the common job engine for the signed Windows contributor executable and the headless Linux/fal build. Platform images/installers wrap the same source, pinned Comfy nodes and recipes; they are not separate inference implementations.

## Roles

- `generation`: run the pinned TrimH3 base workflow.
- `upscale`: upscale the exact accepted base MP4.
- `story-producer`: optional owner story writer. It requests a fenced story-producer lease and a short-lived per-attempt claim token, makes one bounded low-cost structured OpenAI call when `OPENAI_API_KEY` is configured (otherwise uses a safe template), compiles an H3 prompt, and submits the proposal to the server for validation. Retries keep the same idempotency key and scene seed; parallel processes cannot claim the same active plan. It does not grant streamer-control authority and must only use the owner-controlled deployment.

Every claim uses a server-authorized lease, attempt ID and monotonic fence. Credentials come from the OS-protected worker file or the SLOPTOGETHER_WORKER_KEY environment variable; never pass keys on the command line or embed them in container images. Ordinary Windows pairing uses the Twitch browser flow. Headless keys are issued by a channel broadcaster and scoped to a channel and role. A full streamer-control grant is separate. Overrides are audited and fence stale jobs.

The worker polls ComfyUI's pinned `/api/jobs/{prompt_id}` output contract and uses the legacy `/history/{prompt_id}` route only when the job route returns 404. Other server failures are surfaced and never treated as API-version fallback.

Only server-allowlisted recipe IDs execute. The worker does not run viewer-provided workflow graphs, Python, shell, package or model-URL inputs. Outputs use attempt-scoped upload tickets. The server snapshots and validates media and controls policy approval/publication.

## Windows development/build

Install into a Python 3.12 environment with `python -m pip install .`, then check ComfyUI and node capability with `python -m sloptogether_worker --config worker.toml check`. Pair the device using `python -m sloptogether_worker --config worker.toml pair`, then run `python -m sloptogether_worker --config worker.toml run`.

GPU admission checks the same adapter that ComfyUI sees: the first `CUDA_VISIBLE_DEVICES` entry, or adapter `0` when unset. Set `SLOPTOGETHER_GPU_ID` when ComfyUI uses an explicit `--cuda-device` or a different adapter. For two local GPU roles, point each worker at a ComfyUI instance bound to its own adapter and set the matching ID. The Ada upscale profile requires SM 8.9+, at least 24 GB VRAM, 22 GiB free VRAM, and 128 GiB system RAM; WSL workers check the selected distro's `/proc/meminfo` limit instead of trusting the larger Windows host total.

On worker startup, if free VRAM is below the pinned recipe's reservation and its ComfyUI queue is idle, the worker unloads ComfyUI's warm models and waits up to 30 seconds for memory to return. Give the worker a dedicated ComfyUI instance; active queued work is never unloaded.

`build-windows.ps1` packages a windowed one-file desktop launcher and a console worker executable on Windows, then creates a ZIP containing both executables, secret-free example configs, setup scripts, a small weight-free archive of the pinned ComfyStreamer nodes and dependency locks, and this README. The desktop UI uses the console executable for worker actions so it can show logs in its activity panel. The stdlib packager validates the file set and prints the bundle SHA-256 for the release catalog. Running that script on macOS does not make a Windows executable, and the archive is not code-signed.

Download the [corrected Windows x64 test package](https://github.com/stale2000/sloptogether/releases/download/windows-worker-test-2026-10-29-2/SlopTogetherWorker-windows-x64.zip) (built from commit `0e4617775acc781bde2d413c110e3e6f591aa76a`). SHA-256: `e2eace4b5e4864cf5703c11cd81534a3f2e920f7c731353ba28e5e878d624724`. The manual Windows build passed its CRLF workflow integrity regression test, executable help smoke test, exact ZIP file-set check, and runtime packaging tests in [workflow run 40975353208](https://github.com/stale2000/sloptogether/actions/runs/40975353208). The previous package failed before generation began and should be replaced with this corrected build. This build is unsigned; WSL2 inference remains experimental and is not qualified on a 4090.

When started without arguments, the Windows executable opens a Twitch-themed desktop window for role selection, setup, starting the WSL ComfyUI backend, checking the runtime, Twitch pairing and starting or stopping work. It uses a dark Twitch-purple palette, keeps worker output in an activity panel and launches long-running work off the UI thread. Explicit CLI arguments continue to use the command-line interface. Newly generated role configurations use separate `~/.sloptogether/generation` and `~/.sloptogether/upscale` state directories so their role-scoped credentials cannot overwrite each other. Existing configurations are preserved; pairing is refused when both role configurations share one state directory. For an existing ComfyUI environment, use **Install dependencies** after setup and enter its WSL Python path under the configured ComfyUI directory. The launcher remembers that interpreter for ComfyUI startup and model setup.

The Windows menu's **Install ComfyUI** and **Set up existing ComfyUI** actions download the pinned generation model files after setup. If Hugging Face isn't authorized in WSL yet, the launcher opens `hf auth login`; first accept the model access on the linked Hugging Face pages and complete login there. The model downloader verifies pinned hashes. It never embeds weights in the Windows ZIP. After setup completes, choose **Start worker**; it polls for ready jobs in the configured channel and `stream_slug`. The supplied WSL example targets the temporary `cartoon-demo` test stream, which currently has one ready generation job. Set `stream_slug` to the stream you intend to contribute to when using another channel stream. Upscale still requires separately configured SoL dependencies and weights; its setup does not download a new base-generation model.

The imported FastH3 and SoL custom-node runtimes target Linux. The Windows executable can use them through a Windows Subsystem for Linux 2 ComfyUI backend: install the supported Linux nodes and licensed model files inside WSL2, expose ComfyUI on `127.0.0.1:8188`, and run with `--platform wsl` (or set `platform="wsl"` in the config). The setup script checks the distro kernel and creates matching Windows UNC config paths. WSL mode verifies those paths before pairing, then removes uploaded frames/clips and the job's isolated MP4/sidecar outputs after each attempt. The WSL worker uses the same Windows client and Twitch pairing flow but is recorded separately as `wsl`; the server continues to reject native `windows` inference claims. Pairing records a client platform claim, not hardware attestation. The bundle remains unsigned and does not qualify WSL2 hardware.

For a new WSL2 install, run `Setup-SlopTogetherWorker.ps1 -Role generation -InstallComfyUI` or `-Role upscale -InstallComfyUI`. It defaults to Ubuntu 24.04 for Python 3.12, clones ComfyUI at the pinned commit, creates a dedicated `.venv`, installs the hash-locked runtime, installs the role's node source, and writes the worker config. It may use `sudo apt-get` for Git, curl, Python 3.12, venv, FFmpeg and shared libraries; enter the WSL Linux password when prompted. Generation also clones the pinned ComfyUI-ClipProj commit; upscale prepares the isolated SoL runtime. These installs download substantial Python packages, but do not fetch model weights or submit a GPU job. For an existing pinned ComfyUI checkout, use `-InstallNodes`; add `-InstallDependencies -ComfyPython /home/USER/ComfyUI/.venv/bin/python` to update its explicitly selected Python environment. The upscale role requires 128 GiB host RAM and a WSL memory limit of at least 128 GiB. If WSL is missing, rerun from an Administrator PowerShell with `-InstallWsl`, finish the distro's first-run Linux user setup, then rerun the setup script. Use `-Force` only when you intend to replace an existing role config. `-Check` runs the worker's local capability check; no pairing or job is started by setup.

The scripts do not install model weights or NVIDIA drivers. After `-InstallNodes`, use `-InstallDependencies` with the same Python environment that launches ComfyUI, or install the lock manually:

```sh
<ComfyUI venv Python> -m pip install --require-hashes -r <ComfyUI>/.sloptogether-runtime/deploy/vast/requirements.lock
```

The upscale role also needs the isolated SoL runtime; `-InstallDependencies` runs `comfystream_sol_refiner_h3/install_runtime.sh` with the same pinned ComfyUI Python. Generation model downloads remain a separate opt-in step: first accept the required Hugging Face model access, then authenticate from WSL with `wsl -d Ubuntu-24.04 -- /home/USER/ComfyUI/.venv/bin/hf auth login`. Use the launcher’s **Download generation models** action, or run the node installer with `-Role generation -DownloadModels`. The Trim checkpoint revision and digest are pinned in the bundled manifest; no alternate FastVideo revision is needed. The downloader retrieves the saved token through `huggingface_hub.get_token()` and keeps it inside WSL; it writes credentials to a temporary private curl config and never passes them through PowerShell. It uses the Trim profile by default and skips the alternate 8-step checkpoint. See [Hugging Face authentication](https://huggingface.co/docs/huggingface_hub/package_reference/authentication). Model files are hash-verified and not included in the bundle. The worker check must pass before pairing. Then run these commands from PowerShell:

```powershell
.\SlopTogetherWorker.exe --config .\worker.generation.toml check
.\SlopTogetherWorker.exe --config .\worker.generation.toml pair
.\SlopTogetherWorker.exe --config .\worker.generation.toml run
```

NVIDIA documents CUDA acceleration in WSL2 with the Windows host driver and Linux-side CUDA applications in its [CUDA on WSL guide](https://docs.nvidia.com/cuda/wsl-user-guide/). Keep this profile experimental until an actual WSL2 RTX 4090 runs both generation and upscale, meets measured VRAM/system-RAM headroom, and passes output/audio/playback checks. The optional `-InstallWsl` switch requests WSL installation. ComfyUI installation and model downloads require their respective explicit options; the scripts do not install NVIDIA drivers.

The pinned Trim graph defaults to fixed Kitchen VSA on local Linux/WSL workers. The generated Fal generation image explicitly opts into adaptive native VC for its pinned `GPU-RTXPRO6000` profile, whose packaged kernels target SM120; startup fails closed if the reported GPU is not SM120. This avoids selecting kernels from a separate ComfyUI process's potentially different GPU. It prevents an Ada 4090 from passing admission and then failing when the node requests an absent SM120 kernel. The fixed Ada route remains unqualified: actual WSL2 4090 VRAM, latency, output quality and continuity must be measured before release.

## Linux/fal

Fal GPU images can launch ComfyUI and this same package under `sloptogether-fal-worker`. Install the package into the image's existing Python environment, keep the worker key in Fal's secret configuration, and set `SLOPTOGETHER_WORKER_ROLE=generation` or `upscale`. Start the existing Comfy entrypoint through the worker supervisor:

```dockerfile
COPY context/sloptogether-worker /opt/sloptogether-worker
RUN /opt/venv-fasth3/bin/python -m pip install --no-deps /opt/sloptogether-worker
CMD ["/opt/venv-fasth3/bin/sloptogether-fal-worker", "--", "/opt/fasth3-entrypoint.sh"]
```

Prepare isolated generation/upscale app directories and their worker build contexts with `python3.12 workers/runtime/fal/prepare_fal_apps.py --output /tmp/sloptogether-fal-apps`. The script stages only the pinned Comfy runtime and shared worker source; it does not deploy or start GPUs. Review each generated Dockerfile before deployment. Use the image's Python path and Comfy entrypoint for the selected profile. The supervisor checks loopback Comfy readiness, starts the normal worker CLI in headless mode with the owner-issued key, and stops both process groups if either exits, the session reaches two hours, or the container receives `SIGTERM`. Provider, database and owner keys are scrubbed from both child environments. The Comfy bearer is retained only for the worker process that calls the loopback API, never for ComfyUI or its custom nodes. The role key is passed only to its SlopTogether worker process. Each private app declares its role key, `SLOPTOGETHER_API_BASE_URL`, and `SLOPTOGETHER_ALLOWED_UPLOAD_HOSTS`. Set the reachable HTTPS API URL, exact R2/gateway hostnames and each role-scoped key in the Fal environment, then run `workers/runtime/fal/set_worker_secrets.py` with the Python interpreter used by the Fal CLI. The helper validates values and stores them without default exposure. It never prints keys or puts them in command arguments. The container still needs its pinned Comfy nodes, model files and matching CUDA environment; this is a process wrapper, not a substitute for the upstream Fal image build.

Fal serverless runners scale to zero when `min_concurrency=0` and there is no request. Keep both private role apps at `min_concurrency=0`, `max_concurrency=1`, and `keep_alive=60`. Start the owner session controller from a machine with the Fal CLI and `FAL_KEY` configured:

```sh
sloptogether-fal-session \
  sloptogether-h3-generation sloptogether-h3-upscale \
  --generation-url https://fal.run/YOUR_HANDLE/sloptogether-h3-generation \
  --upscale-url https://fal.run/YOUR_HANDLE/sloptogether-h3-upscale
```

For a generation-only acceptance test, pass just the generation app and `--generation-only`; the upscale GPU is not woken:

```sh
sloptogether-fal-session sloptogether-h3-generation \
  --generation-url https://fal.run/YOUR_HANDLE/sloptogether-h3-generation \
  --generation-only
```

The Fal images run ComfyUI and the SlopTogether worker under separate non-root users; the Comfy process cannot read its sibling worker's environment through same-UID `/proc` access. Both users share the Comfy input directory and the dedicated SlopTogether output spool through a media group. The worker can delete only UUID-scoped attempt output directories after it has read and uploaded the result. The controller triggers only the selected private apps and sends an authenticated `/system_stats` wake ping every 20 seconds. Warm-runner pings time out after 15 seconds; the initial ping may wait up to the configured 3600-second app startup/request timeout for a cold image/model boot. If the controller disappears during a cold start, that one request may remain queued until Fal's timeout; the in-container supervisor still imposes a two-hour wall-clock limit from runner process start. After a successful wake, short heartbeats keep the runner active and the 60-second idle scale-down is the fallback if the controller crashes. The controller leaves `min_concurrency=0`, scales each selected app to at most one runner, and stops remaining runners at the two-hour deadline, Ctrl-C, or a failed start. Its deadline begins before it wakes any GPU. It starts teardown before the requested deadline, reserving 10% of the session duration up to five minutes. It checks both elapsed and wall-clock time and does not start additional wake requests after a stop or deadline. Provider delays, an in-flight wake request, or loss of the operator host can still prevent a guaranteed physical shutdown; use an independent guardian and verify the selected app runners are gone. Provision each role key only to its matching Fal app; never put it in a Dockerfile, build context, CLI argument or public endpoint. Source code does not deploy Fal apps. Real Fal RTX PRO tests have generated Trim clips and completed and approved a 1184×666 SoL upscale; see the [Fal runbook](../../docs/fal-upscale-runbook.md) for exact scope and evidence. See Fal's [app lifecycle](https://fal.ai/docs/documentation/getting-started/lifespan) and [runner pricing](https://fal.ai/serverless) for current lifecycle and billing behavior.

The staged Fal cache-isolation and warm-reuse fixes have passed local tests but
are not yet deployed. A previous supervisor recursively changed ownership and
modes under shared `/data` caches, causing slow startup. The prior permissions
are unknown and have not been verified restored; inspect affected paths before
repair and do not recursively change account-wide caches. See the
[Fal runbook](../../docs/fal-upscale-runbook.md) for the current rollout and
shutdown status.

## Qualification limits

The reference five-step Trim profile is exploratory; the checkpoint was distilled for eight steps. The SoL upscaler now has an Ada FP8/sequential-offload candidate and keeps the resident NVFP4 path for sufficiently large Blackwell cards. The Ada profile is not hardware-qualified: no Windows RTX 4090 inference, memory trace, quality comparison, or latency run has been completed. Keep its release status experimental until those checks pass. Node/model presence or an imported source snapshot is not evidence of successful inference.

New pull-worker base assets use 512×288; legacy 720p assets remain supported. The worker preserves actual clip duration, including Trim's 362 frames at 24 fps (~15.08 seconds). After independent validation and approval, the media publisher packages the selected base or pre-air upscale as HLS and scales playback to the channel dimensions. A real 1184×666 Fal SoL result was selected before airing and visibly played through HLS after manual review. The complete unattended pipeline remains unqualified.

## Provenance

Assets under `src/sloptogether_worker/assets/recipes/` are byte-preserving workflow snapshots listed in `provenance.json`. The loaded ComfyStreamer custom nodes remain under `vendor/comfystream/runtime/` with source/license digests in its import manifest. No model weights are bundled. No signed Windows release or RTX 4090 inference qualification has been completed.
