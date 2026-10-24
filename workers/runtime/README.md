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

GPU admission checks the same adapter that ComfyUI sees: the first `CUDA_VISIBLE_DEVICES` entry, or adapter `0` when unset. Set `SLOPTOGETHER_GPU_ID` when ComfyUI uses an explicit `--cuda-device` or a different adapter. For two local GPU roles, point each worker at a ComfyUI instance bound to its own adapter and set the matching ID. The Ada upscale profile requires SM 8.9+, at least 24 GB VRAM, 22 GiB free VRAM, and 128 GiB system RAM; the worker rejects lower-memory hosts before leasing an upscale job.

On worker startup, if free VRAM is below the pinned recipe's reservation and its ComfyUI queue is idle, the worker unloads ComfyUI's warm models and waits up to 30 seconds for memory to return. Give the worker a dedicated ComfyUI instance; active queued work is never unloaded.

`build-windows.ps1` packages a one-file launcher on Windows plus a ZIP bundle containing the executable, secret-free `worker.example.toml`, `worker.wsl.example.toml`, and a copy of this README in `dist/`. The stdlib packager validates the file set and prints the bundle SHA-256 for the release catalog. Running that script on macOS does not make a Windows executable, and the archive is not code-signed. The full ComfyUI/Torch/GPU runtime and licensed model files are separate installations; it checks for a loopback ComfyUI server with the pinned nodes and required local models.

The imported FastH3 and SoL custom-node runtimes target Linux. The Windows executable can use them through a Windows Subsystem for Linux 2 ComfyUI backend: install the supported Linux nodes and licensed model files inside WSL2, expose ComfyUI on `127.0.0.1:8188`, and run with `--platform wsl` (or set `platform="wsl"` in the config). Start the distro and set both `comfy_input_dir` and `comfy_output_dir` to existing UNC paths in that same distro (for example `\\wsl.localhost\Ubuntu\home\USER\ComfyUI\input` and `...\output`); WSL mode checks the distro's kernel is WSL2 and both directories are accessible before pairing. It removes uploaded frames/clips and the job's isolated MP4/sidecar outputs after each attempt. The WSL worker uses the same Windows client and Twitch pairing flow but is recorded separately as `wsl`; the server continues to reject native `windows` inference claims. Pairing records a client platform claim, not hardware attestation. This is an execution path, not a signed runtime installer or a hardware qualification.

For the Windows bundle, copy `worker.wsl.example.toml` to `worker.toml`, edit the distro paths, then run these commands from PowerShell:

```powershell
.\SlopTogetherWorker.exe --config worker.toml check
.\SlopTogetherWorker.exe --config worker.toml pair
.\SlopTogetherWorker.exe --config worker.toml run
```

NVIDIA documents CUDA acceleration in WSL2 with the Windows host driver and Linux-side CUDA applications in its [CUDA on WSL guide](https://docs.nvidia.com/cuda/wsl-user-guide/). Keep this profile experimental until an actual WSL2 RTX 4090 runs both generation and upscale, meets measured VRAM/system-RAM headroom, and passes output/audio/playback checks. The one-file launcher still does not install WSL2, ComfyUI, custom nodes or model weights.

The pinned Trim graph defaults to fixed Kitchen VSA on local Linux/WSL workers. The generated Fal generation image explicitly opts into adaptive native VC for its pinned `GPU-RTXPRO6000` profile, whose packaged kernels target SM120; startup fails closed if the reported GPU is not SM120. This avoids selecting kernels from a separate ComfyUI process's potentially different GPU. It prevents an Ada 4090 from passing admission and then failing when the node requests an absent SM120 kernel. The fixed Ada route remains unqualified: actual WSL2 4090 VRAM, latency, output quality and continuity must be measured before release.

## Linux/fal

Fal GPU images can launch ComfyUI and this same package under `sloptogether-fal-worker`. Install the package into the image's existing Python environment, keep the worker key in Fal's secret configuration, and set `SLOPTOGETHER_WORKER_ROLE=generation` or `upscale`. Start the existing Comfy entrypoint through the worker supervisor:

```dockerfile
COPY context/sloptogether-worker /opt/sloptogether-worker
RUN /opt/venv-fasth3/bin/python -m pip install --no-deps /opt/sloptogether-worker
CMD ["/opt/venv-fasth3/bin/sloptogether-fal-worker", "--", "/opt/fasth3-entrypoint.sh"]
```

Prepare isolated generation/upscale app directories and their worker build contexts with `python3.12 workers/runtime/fal/prepare_fal_apps.py --output /tmp/sloptogether-fal-apps`. The script stages only the pinned Comfy runtime and shared worker source; it does not deploy or start GPUs. Review each generated Dockerfile before deployment. Use the image's Python path and Comfy entrypoint for the selected profile. The supervisor checks loopback Comfy readiness, starts the normal worker CLI in headless mode with the owner-issued key, and stops both process groups if either exits, the session reaches eight hours, or the container receives `SIGTERM`. Provider, database and owner keys are scrubbed from both child environments. The Comfy bearer is retained only for the worker process that calls the loopback API, never for ComfyUI or its custom nodes. The role key is passed only to its SlopTogether worker process. Each private app declares its role key, `SLOPTOGETHER_API_BASE_URL`, and `SLOPTOGETHER_ALLOWED_UPLOAD_HOSTS`. Set the reachable HTTPS API URL, exact R2/gateway hostnames and each role-scoped key in the Fal environment, then run `workers/runtime/fal/set_worker_secrets.py` with the Python interpreter used by the Fal CLI. The helper validates values and stores them without default exposure. It never prints keys or puts them in command arguments. The container still needs its pinned Comfy nodes, model files and matching CUDA environment; this is a process wrapper, not a substitute for the upstream Fal image build.

Fal serverless runners scale to zero when `min_concurrency=0` and there is no request. Keep both private role apps at `min_concurrency=0`, `max_concurrency=1`, and `keep_alive=60`. Start the owner session controller from a machine with the Fal CLI and `FAL_KEY` configured:

```sh
sloptogether-fal-session \
  sloptogether-h3-generation sloptogether-h3-upscale \
  --generation-url https://fal.run/YOUR_HANDLE/sloptogether-h3-generation \
  --upscale-url https://fal.run/YOUR_HANDLE/sloptogether-h3-upscale
```

The Fal images run ComfyUI and the SlopTogether worker under separate non-root users; the Comfy process cannot read its sibling worker's environment through same-UID `/proc` access. Both users share only the Comfy input directory through a dedicated group. The controller triggers both private apps and sends an authenticated `/system_stats` wake ping every 20 seconds. Warm-runner pings time out after 15 seconds; the initial ping may wait up to the configured 3600-second app startup/request timeout for a cold image/model boot. If the controller disappears during a cold start, that one request may remain queued until Fal's timeout; the in-container supervisor still imposes an eight-hour wall-clock limit from runner process start. After a successful wake, short heartbeats keep the runner active and the 60-second idle scale-down is the fallback if the controller crashes. The controller leaves `min_concurrency=0`, scales each app to at most one runner, and stops remaining runners at the eight-hour deadline, Ctrl-C, or a failed start. Its deadline begins before it wakes either GPU. Provision each role key only to its matching Fal app; never put it in a Dockerfile, build context, CLI argument or public endpoint. Source code does not deploy Fal apps, and no Fal worker image has been GPU-qualified by this workspace. See Fal's [app lifecycle](https://fal.ai/docs/documentation/getting-started/lifespan) and [runner pricing](https://fal.ai/serverless) for current lifecycle and billing behavior.

## Qualification limits

The reference five-step Trim profile is exploratory; the checkpoint was distilled for eight steps. The SoL upscaler now has an Ada FP8/sequential-offload candidate and keeps the resident NVFP4 path for sufficiently large Blackwell cards. The Ada profile is not hardware-qualified: no Windows RTX 4090 inference, memory trace, quality comparison, or latency run has been completed. Keep its release status experimental until those checks pass. Node/model presence or an imported source snapshot is not evidence of successful inference.

The worker scales/pads each result to the channel's exact 16:9 frame and preserves its actual duration, including Trim's362 frames at24fps (~15.08s). The server still needs an independent media validator and HLS packager before an uploaded result can be published to the browser program.

## Provenance

Assets under `src/sloptogether_worker/assets/recipes/` are byte-preserving workflow snapshots listed in `provenance.json`. The loaded ComfyStreamer custom nodes remain under `vendor/comfystream/runtime/` with source/license digests in its import manifest. No model weights are bundled. No Windows build, local/fal inference or CUDA qualification has been run.
