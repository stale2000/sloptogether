# Fal H3 SoL Upscaler

This deployment exposes ComfyUI directly on port 8188. Keep it in raw
`exposed_port` mode: ComfyStreamer uses GET for `/system_stats`, `/object_info`,
`/queue`, `/history`, and `/view`, plus POST for uploads and prompts. A
`fal.App` catch-all endpoint only accepts POST and breaks output delivery with
HTTP 405.

ComfyStreamer defaults to the single-GPU SoL upscaler profile. The experimental
`shared_vae_benchmark` profile requires multiple visible CUDA devices on one
worker and should be selected explicitly only for a benchmark deployment.

## Why the first run was slow

Fal mounts `/data` as JuiceFS backed by GCS. The SoL snapshot is about 66 GiB;
loading it cold from that mount took many minutes. A warm SoL worker stays in
the same ComfyUI process and can process later clips without that cold load.
The exact H3 preservation conditioning artifact is also required. Upscale
workflows must set `cache_conditioning=true` so they skip the extra text
encoder, tokenizer, and connector weights.

### Cold-start phases and mitigation

The first request to a new runner pays three separate costs: Fal pulls the
container image, Diffusers reads the 66 GiB SoL snapshot from `/data`, and the
worker converts the transformer to NVFP4. The converted transformer is saved
under `/data/comfystream/sol-h3/nvfp4` with a runtime/model/GPU identity and a
file-stat receipt. Later runners load that cached NVFP4 transformer directly,
skip loading the original transformer shards, and skip requantization. Each
runner still loads the other pipeline components and performs its own GPU model
load. The worker also caches the loaded pipeline in-process, so later clips on
the same worker do not repeat startup. `COMFYSTREAM_SOL_H3_COMPILE_TRANSFORMER=0`
removes the separate `torch.compile` phase.

The SoL model is already cached under `HF_HOME=/data/.cache/huggingface`; the
long shard reads are from Fal's shared JuiceFS/GCS mount. The next upscaler
revision will pre-read cached safetensors shards with parallel readers before
Diffusers loads them sequentially, following Fal's [parallel file loading
guidance](https://fal.ai/docs/documentation/serverless/optimizations/parallel-file-loading).
If the pinned snapshot is not already cached, the pre-read step skips itself
and leaves first-time downloading to Hugging Face.

Before opening OBS, keep `min_concurrency=1`, prepare the exact conditioning
artifact, and run the existing warmup script to completion against an existing
H3 clip. This pays model loading and NVFP4 conversion before the live run. Keep
the runner alive through evaluation; `keep_alive` only applies when the app is
allowed to scale to zero.

Do not deploy or kill a runner while ComfyUI has accepted prompts in its local
queue. Those prompt IDs and histories belong to the worker process; terminating
it discards queued upscale work while the coordinator still records the
attempts as accepted. Drain the queue and confirm each output is saved before
replacing the worker. If a runner is already gone, only use a linked retry
after verifying that the exact old runner is terminated, the replacement has
no matching queue/history entry, and no output has been admitted.

The OBS test deployment sets `COMFYSTREAM_SOL_H3_COMPILE_TRANSFORMER=0`.
Compiling the repeated transformer blocks on first cold use kept the live test
worker busy for longer than its request window. Re-enable compilation only
after a warm-worker throughput comparison shows it helps this route.

If the Fal runner remains in `DOCKER_PULL` for an unusually long time, inspect
it with `fal apps runners comfystream-h3-sol-upscaler --json` and check its
in-flight request count. When the runner has no work, kill that runner with
`fal runners kill <runner-id>`; with minimum concurrency set to 1, Fal schedules
a replacement. Confirm the new runner reaches `IDLE` before sending workflows.

The earlier manual warmup took much longer because it left
`cache_conditioning=false`. The live `ReplacementPipeline` already sets it to
`true`; the warmup helper below now uses the same production workflow.

## Prewarm before going live

Keep one runner alive while the stream is active. Each RTX PRO 6000 costs $4
per GPU-hour; keeping the generator and upscaler warm costs $8 per hour total.

1. Scale the upscaler to one warm runner and a ten-minute keep-alive:

   ```sh
   fal apps scale comfystream-h3-sol-upscaler --min-concurrency 1 --keep-alive 600
   ```

2. On its runner, download pinned snapshots and prepare the exact production
   prompt conditioning. `fal apps runners ... --json` provides the runner ID.

   ```sh
   fal runners exec RUNNER_ID sh -c '/opt/ComfyUI/custom_nodes/comfystream_sol_refiner_h3/.worker/bin/python /opt/comfystream/scripts/prepare_h3_upscale_conditioning.py --comfyui-root /opt/ComfyUI'
   ```

3. From the project root, run one warmup against an already-generated H3 clip.
   Set `FAL_KEY` in the environment; do not put it on the command line.

   To inspect the workflow without a Fal request or GPU charge, add
   `--dry-run` to the command.

   ```sh
   python3.12 scripts/prewarm_fal_h3_upscaler.py \
     --endpoint https://fal.run/stale2000/comfystream-h3-sol-upscaler \
     --source benchmark-results/fal-rtxpro6000-gen-upscale-20261012/courier-fast-h3-source.mp4
   ```

The command exits successfully only after ComfyUI records a completed upscale
and saved MP4. It also checks `/system_stats` and `/object_info`, so a POST-only
Fal wrapper fails immediately before a live run.

In the 2026-10-12 Fal RTX PRO 6000 run, the warmed worker took about 9.3–9.9
seconds per 15-second upscale. FastH3 generation took 17.6–19.8 seconds per
30-second pair. The local HLS preview played without reported stalls, with
about 100 seconds buffered. Keep the warmup: cold startup is not a live clip
timing measurement.

After warmup, start the ComfyStreamer broadcast in OBS with output mode
`upscaled`. Keep both runners warm for the live session. Use the shutdown
procedure below at the end of the session; `keep_alive=60` only waits for
idle expiration and is not an immediate shutdown.

## Stop and resume the two GPU apps

First stop ComfyStreamer generation in the control panel connected to the
coordinator. Verify the coordinator has no active run; a desktop panel showing
`STOPPED` is not sufficient if it is disconnected from the coordinator:

```sh
curl -fsS http://127.0.0.1:50826/api/comfystream/v1/broadcast
```

The response must have `data.channel.active_run_id: null`. If it still contains
a run ID, stop that broadcast through the control page connected to this
coordinator. A control panel can say `STOPPED` while a different coordinator
still has an active run. If the page is disconnected, use the private local
connection record to send a preconditioned stop command; do not kill the
supervised coordinator process, because it can restart and restore the active
run:

```sh
python3 - <<'PY'
import json
import uuid
from pathlib import Path
from urllib.request import Request, urlopen

record = json.loads((Path.home() / "Library/Application Support/ComfyStreamer/bootstrap/connection-v1.json").read_text())
base = record["endpoint"].rstrip("/")
with urlopen(base + "/api/comfystream/v1/broadcast", timeout=5) as response:
    channel = json.load(response)["data"]["channel"]
run_id = channel.get("active_run_id")
if run_id is None:
    print("broadcast already stopped")
else:
    payload = {
        "command_id": "shutdown-" + uuid.uuid4().hex,
        "expected_run_id": run_id,
        "expected_lifecycle_revision": channel["lifecycle_revision"],
        "options": {},
    }
    request = Request(
        base + "/api/comfystream/v1/broadcast/stop",
        data=json.dumps(payload).encode(),
        headers={"Content-Type": "application/json", "X-Operator-Token": record["operator_token"]},
        method="POST",
    )
    with urlopen(request, timeout=10) as response:
        print("stop status:", response.status)
    with urlopen(base + "/api/comfystream/v1/broadcast", timeout=5) as response:
        stopped = json.load(response)["data"]["channel"].get("active_run_id") is None
    print("active run cleared:", stopped)
PY
```

Wait for any in-flight generation/upscale work to finish. This prevents the
active stream from submitting requests that wake GPU workers again.

Then set both serverless apps to zero minimum concurrency and zero keep-alive:

```sh
fal apps scale fasth3-b1 --min-concurrency 0 --keep-alive 0
fal apps scale comfystream-h3-sol-upscaler --min-concurrency 0 --keep-alive 0
```

Check the app configuration and runner state:

```sh
fal apps list --filter fasth3-b1 --json
fal apps list --filter comfystream --json
fal apps runners fasth3-b1 --state all --json
fal apps runners comfystream-h3-sol-upscaler --state all --json
fal queue size fasth3-b1
fal queue size comfystream-h3-sol-upscaler
fal apps gpus fasth3-b1
fal apps gpus comfystream-h3-sol-upscaler
```

Both app records should report `min_concurrency: 0` and `keep_alive: 0`, and
both queues should be empty. Confirm there are no live runner states and no
GPU usage for either app:

```sh
fal runners list --state pending setup idle running --json
fal apps gpus fasth3-b1
fal apps gpus comfystream-h3-sol-upscaler
```

There must be no live runner states. The GPU usage command should show zero;
after usage data rolls off, this fal account returned “Application not found
in metrics” for both apps, alongside empty live-runner lists and zero queues.
`fal apps list` can retain a stale nonzero `active_runners` value even after
the runner records are `DEAD`, so do not use that field alone as proof that a
GPU is still allocated. Fal may also briefly show a `PENDING`, `SETUP`,
`DOCKER_PULL`, or `TERMINATING` runner while a scale-down or rollout settles.
`PENDING` and image-pull time are not billed, but wait until the all-state
runner list shows only `DEAD` records for these apps. If a live runner remains
after the broadcast is stopped and queues are empty, confirm
`in_flight_requests: 0`, then use the exact runner ID with the graceful stop
command (without `--replace`):

```sh
fal runners stop RUNNER_ID
```

If a zero-request runner remains after graceful stop, force a rollout only
after confirming the broadcast is stopped and both queues are empty:

```sh
fal apps rollout --force fasth3-b1
fal apps rollout --force comfystream-h3-sol-upscaler
```

Then repeat the checks until the all-state runner list shows only `DEAD`
records, the queues are empty, and GPU usage is zero or absent for both apps.
Keep the apps deployed; do not delete them. The
live stream must be stopped before manually stopping runners, or ongoing
requests can cause Fal to start replacement workers. A single immediate
runner-list snapshot is not proof that shutdown has settled.

To resume a live session, set the generator and upscaler to one warm runner
with a ten-minute keep-alive, then run the conditioning preparation and
production-equivalent prewarm above before starting generation:

```sh
fal apps scale fasth3-b1 --min-concurrency 1 --keep-alive 600
fal apps scale comfystream-h3-sol-upscaler --min-concurrency 1 --keep-alive 600
```

## Deployment notes

- `request_timeout` and `COMFYSTREAM_SOL_H3_TIMEOUT_SECONDS` are both 3600 so
  the first cold load cannot be mistaken for a dead worker.
- The exact production flow is separate FastH3 generation and SoL upscale
  workers, with `cache_conditioning=true`, `pruna_fast`, and NVFP4 at 1184×666.
- Do not start platform streaming from the OBS dock unless the user asks; the
  coordinator publishes a local HLS preview for OBS.
