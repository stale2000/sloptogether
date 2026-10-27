# Fal generation and upscale runbook

For current status, use [the completion plan](completion-plan-2026-10-27.md)
and [October 27 review](review-fixes-2026-10-27.md). The snapshots below are
historical and can describe earlier deployments or publisher configurations.

This runbook records the October 26, 2026 investigation. Fal workers, the web
API, the Cloudflare upload gateway, and the media publisher are separately
deployed components. A change in one component does not update the others.
Record each deployed revision and the worker build's `source-manifest.json`
before drawing conclusions from a test. Never put worker keys, signed URLs,
upload tickets, or their query strings in logs or this document.

## Historical October 26–27 progress snapshot

The current web deployment with the trust fix is Vercel deployment
`dpl_6DE9NP2qRzf3Aok17YW4WKTXDRq4`. Fal generation revision
`8106197a-20a5-463c-b0e1-71dad5d394bd` and upscale revision
`14736929-7ccf-419e-9105-75a4adc0335e` were observed. After the user-directed
pause, both apps had minimum concurrency 0 and keep-alive 0. `fal runners list`
showed no pending, setup, idle, running, or crash-backoff runners, and
`fal runners gpus --json` reported total 0. There were no active generation or
upscale jobs. Recheck effective revisions and runner states before any new
test. Real Fal upscale job
`9174b2fd-d9c6-4d3c-8c3b-43a695bb17f5` succeeded on its first attempt. Its
asset `eedc8623-79c4-4ca3-a06d-5cda1a41ba86` is 1184×666 and 15.083 seconds;
it was uploaded, validated, previewed, and human-approved. Its scene was
already committed, so the derivative is not in HLS.

The broadcaster reaffirmed the existing Fal generation binding without
changing its scopes; the database showed binding and channel revision 2. For a
Twitch-submitted, voted scene from proposal
`72f330e8-0d1c-4e99-9063-f7c14594d47d`, five-step base job
`1e74a656-ce05-4d32-a19f-e7af789c4c9b` was automatically approved through
`trusted_execution_policy`. Its pre-air upscale job
`dbd84b4d-d251-443a-bf91-440521a90d1c` produced asset
`50cacd2b-ce76-48db-8ff8-c6d69292bad7`, which was manually approved and
committed as program item `9fe73dc2-dd87-4b43-b243-863393abb739`. Its actual
endpoint passed automatic screening and clip 8 visibly played in the browser.
Upscaler auto-trust approval remains a user decision; do not treat the base
auto-approval as proof of an unattended full pipeline.

The local publisher process was restarted with its dedicated moderation key
restored from local configuration; that key returned HTTP 200 for a benign
OpenAI test request. Its database URL targets `127.0.0.1:56432/sloptogether`,
so it does not poll the live Clips.gg database and is not a production publisher.
Durable production publication remains unverified. A prior generated base
endpoint was screened, while screening of future generated endpoints still
requires verification. Keep the publisher environment protected as described
below before any restart.

Migration `020_preair_upscale.sql` was applied only in the `sloptogether`
schema. Pre-air upscale settings default off and were enabled on `stale2000`
for a live test. A voted scene completed pre-air upscale selection and played
in browser HLS as described below. Both approvals were manual in the scene 7 test;
unattended operation remains unverified. Previously built hosted worker images
remain unsupported for the new capability until rebuilt and qualified.

The refreshed Twitch Extension `0.0.1` ZIP is in Hosted Test and active as
Panel 1 on `stale2000`, with identity linking and `www.clips.gg` fetch domain
configured. The linked broadcaster submitted proposal
`72f330e8-0d1c-4e99-9063-f7c14594d47d` and a free vote through Twitch; the
panel showed one vote and the database confirmed one ballot. A separate
viewer's consent flow has not been tested. Bits support remains disabled;
[Twitch's Extension policy §6.2.8](https://dev.twitch.tv/docs/extensions/guidelines-and-policies/) is broad about user-specified Bits experiences. Public precedents include [Twitch’s fixed-menu Streambombs example with a personal message](https://dev.twitch.tv/extensions/bits-extensions-to-try/) and [Sound Alerts’ Bits-priced viewer-typed TTS](https://soundalerts.com/blog/new-feature-text-to-speech-alerts/). This makes a categorical ban on free-form message content too broad; these examples do not guarantee review of AI video prompts. Keep the exact product behind Twitch review, with a fixed SKU, one attempt, screening, moderation and reconciliation.

Historically, the two-app test session and separate shutdown guardian had a
fixed eight-hour cutoff at October 27, 2026 06:04:35 UTC. The user has since set
a strict two-hour maximum for every GPU session. The old deadline is not an
active work schedule; keep using an external two-hour controller and verify
zero runners and zero GPUs at shutdown.

## What has been demonstrated

The `stale2000` browser program had eight clips in the latest observed snapshot.
Fal base generation job `738003f2-bec8-447d-85bf-c0d502f071bb` succeeded and
was published; a later 512×288 base job
`d653dfda-e3c9-4b09-a13f-da024f3d734a` also published, and its endpoint passed
automatic screening. An upscale attempt for job
`6371e343-61f7-4b48-80a3-6969e30d4c33` completed Comfy inference, but its
output upload failed; subsequent attempts failed the GPU memory check. That
failed attempt did not produce an accepted upscale.

The subsequent pre-air test used scene 7 base asset
`a42c0847-f474-4e47-b621-749a7c7a75b5`, generated at 512×288. Upscale job
`d8e59538-9a30-4876-8c7e-180ce83bbc3c` produced 1184×666 asset
`a49d2595-fff4-44bc-856d-4b281f2b304d`. Both the base and upscale were
manually approved. The pre-air request selected the upscale and program item
`c4833fc1-fef9-4f3a-bb67-c5c6cc061f5f` committed that exact asset. Its actual
endpoint passed automatic screening, and clip 7 visibly played in the browser.
This verifies the observed pre-air path with manual review, not an unattended
continuous stream, a separate viewer's Twitch consent flow, or the Windows
worker.

A real signed upload PUT from Fal received Cloudflare HTTP 403 with error code
1010. A synthetic otherwise comparable request using Python urllib's default
User-Agent reproduced that response; using `SlopTogether-Worker/0.1` reached
the Worker and returned its expected JSON invalid-ticket response. The upload
path lacked an explicit User-Agent. A real signed 10-byte diagnostic PUT from
Fal using `SlopTogether-Worker/0.1` subsequently returned HTTP 201 from
`uploads.clips.gg`. A subsequent real upscale video was also uploaded and
validated, as recorded above. The original reservation's `expires_at` was
forcibly shortened when the attempt failed, so that field does not establish
the ticket's original lifetime. Lease expiry was a hypothesis, not a proven
cause of that rejection.

The eight-clip program is a test, not a limit on stream length. A successful
upscale upload alone does not prove it is in the HLS program: current approved
upscale previews and committed browser playback must be checked separately.
The Windows/WSL2 RTX 4090 generation and upscale profiles remain unqualified
until measured on that hardware.

## 2026-10-27 private Fal FastH3 style test

After the user rejected Wan, the local Wan workflow, variants, MP4s, previews,
and its local Comfy run journal were removed. The three saved 448×256 style
frames were then uploaded directly to the private SlopTogether generation
app's ComfyUI input API and rendered with the deployed five-step FastH3 recipe:

| Style | Fal Comfy prompt ID | Result |
|---|---|---|
| Anime cel | `afc0e46e-a17a-4726-bcf1-6ba972c78d4d` | `outputs/fal-fast-h3/anime-cel.mp4` |
| Flat cartoon | `722561ef-3976-4aa5-b254-01e28873c626` | `outputs/fal-fast-h3/flat-cartoon.mp4` |
| Watercolor | `baf5452c-9e1a-45e3-bcb1-7ed18a12fc5c` | `outputs/fal-fast-h3/watercolor.mp4` |

`comfy preview` verified each base at 448×256, 24 fps, 15.083 seconds, with
audio. The anime-cel result was then sent to the private upscale app. Its first
attempt correctly rejected 448×256 because that source is 7:4 while the
requested target is 16:9. Padding the base to 512×288 produced a valid source;
SoL job `b3f94f66-0b5a-4329-8bbd-71c67337fbb3` completed and the actual node 3
output verified at 1184×666, 24 fps, 15.083 seconds with audio. The MP4 and
contact sheet are `outputs/fal-fast-h3/anime-cel-upscaled-1184.mp4` and
`outputs/fal-fast-h3/anime-cel-upscaled-1184.preview.png`.

This confirms inference on both deployed Fal GPU apps and local retrieval of
their Comfy outputs. It bypassed the SlopTogether job API, upload gateway,
media moderation, publisher and live HLS program. Keep that distinction clear:
these three comparison clips were not published to the channel. The two-hour
external session controller was stopped after the test; both apps returned to
minimum concurrency 0, keep-alive 0, no runners and Fal GPU total 0.

## 2026-10-27 low-resolution FastH3 style test

The user rejected Wan workflows. The Wan comparison workflow and downloaded
Wan clips were removed from the local style-test project. Three saved 448×256
anime-cel, flat-cartoon and watercolor keyframes were uploaded to the private
generation app and rendered directly through its ComfyUI API using the pinned
FastH3 five-step recipe. The clips are in
`comfy-cloud-smoke/style-video-comparison/outputs/fal-fast-h3/`; each is
448×256, 24 fps and 15.083 seconds with audio. This was an isolated GPU
inference test; it did not create a channel job, upload through the gateway,
moderate, publish or update HLS.

The anime-cel output was also passed through the private SoL app. Its first
upscale attempt correctly rejected the source's 7:4 aspect ratio when asked
for 16:9. Padding the source to the app's 512×288 base profile fixed the
geometry. The SoL job completed at 1184×666, 24 fps and 15.083 seconds. Its
preview and MP4 are beside the base clips. The direct app run verified GPU
inference and output retrieval, not the production worker lease/upload path.
Both app runners were stopped; minimum concurrency and keep-alive are zero,
and Fal reported no runners and zero GPUs after shutdown.

## Comparison with the original ComfyStream work

The original checkout is `/Users/stale2000/comfy/comfystream`. It contains the
same FastH3 Trim five-step generation family and SoL H3 refiner used by the
imported worker, but its benchmark results are separate workloads. The original
Fal RTX PRO generation report measured the five-step Trim B1 candidate at
512×320, with a 12.72-second median for three warm 15.083-second clips; it calls
the five-step schedule exploratory, since Trim was distilled for eight steps.
See `benchmark-results/fasth3-trim-fal-b1-5step-20261009/REPORT.md` in that
checkout. This is not a measurement of the current SlopTogether deployment.

The original RTX 5090 warm SoL reference used 512×288 input and 1184×666
output, reporting 14.943 seconds for a 15.083-second clip. See
`docs/optimization-report/benchmark-notes.md` and its cited benchmark reports
in the original checkout. That is a separate GPU and test from the Trim B1
generation benchmark; neither number proves the combined pipeline's latency.
The current SlopTogether test queues an already published 1280×720 clip for a
1920×1080 upscale (`apps/web/src/lib/server/worker-service.ts`). Its output has
about 2.63 times as many pixels as 1184×666, so the earlier timing and memory
measurements cannot be assumed to apply. Measure this exact shape, audio,
quality, and end-to-end latency on the intended hardware.

The current source code changes new pull-worker base renders to 512×288 and
selects 1184×666 for upscaling low-resolution clips. Existing 1280×720 clips
continue to use the 1920×1080 target. See
`apps/web/src/lib/server/generation-profile.ts` and
`apps/web/src/lib/server/worker-service.ts`. The new base profile has been
published and its endpoint screened. A low-resolution upscale has been
validated and approved. Scene 7 also verified pre-air selection and browser
HLS playback with manual approvals. The pre-air setting defaults off and is
enabled for the current `stale2000` test; do not treat a separate upscale
preview as stream playback.

The original checkout also records a separate combined Fal RTX PRO 6000 live
test in `benchmark-results/fal-rtxpro6000-gen-upscale-20261012/ROOT_CAUSE.md`.
Its corrected direct-port setup completed a 724.6-second cold SoL warmup with
`cache_conditioning=true`, then measured warm 1184×666 upscales at 9.3–9.9
seconds per 15-second clip. Its local browser HLS preview advanced with roughly
100 seconds buffered at the observed checkpoint. That report also records a
prior proxy that returned 405 for ComfyUI GET routes, and identifies direct port
routing plus the matching cached-conditioning warmup as its fixes. The report
does not establish long-duration or low-latency operation, and its 1184×666
results do not qualify the current 1920×1080 workload.

The original `deploy/fal/h3-sol-upscaler/Dockerfile` starts ComfyUI directly.
SlopTogether's `workers/runtime/fal/prepare_fal_apps.py` wraps that server with
the lease worker and runs the two processes as separate Unix users. That
integration introduced the shared input-file and prebuilt conditioning-cache
permission issues described below. The differences explain why a working
standalone ComfyStream benchmark did not by itself verify this upload, approval,
and playback integration. The missing upload User-Agent was isolated; both a
small signed diagnostic PUT and a subsequent real upscale video upload and
validation succeeded as described above. The scene 7 pre-air HLS path also
played successfully in the browser with manual approvals.

## Fixes and constraints

- **Private input reads:** workers receive a short-lived, scoped read ticket
  through the web API and read the exact object through the Cloudflare gateway.
  A storage-host 401 or 403 is classified separately from a rejected worker
  key. Do not assume an input-read failure means the worker key needs rotating.
- **Shared files:** Comfy and the worker run as different unprivileged users.
  The shared input directory uses a media group; the worker writes input videos
  group-readable (`0640`). The supervisor normalizes ownership of the narrow
  prebuilt H3 conditioning cache subtree for the Comfy user and media group.
  Do not recursively open unrelated caches or weaken worker-key isolation.
- **Shared cache startup:** a previous Fal supervisor recursively changed
  ownership and modes under shared `/data` Hugging Face and compiler cache
  directories, causing multi-minute startup on the shared mount. A scoped cache
  change has passed local tests and has not yet been deployed. Do not assume the
  original shared permissions are known or have been restored. Verify the
  affected paths and existing owners before any repair; avoid another broad
  recursive ownership or mode change on the account-wide cache.
- **Resident GPU memory:** automatic precision selection now runs after Comfy
  unloads its own models. On a Blackwell GPU with at least 94 GiB total VRAM,
  resident NVFP4 requires 90 GiB free. If the persistent single-GPU refiner
  child holds memory below that reserve, the node stops that child and probes
  again. It fails closed if the reserve is still unavailable. This may cost a
  model reload, but avoids mistaking the worker's own cached model for foreign
  GPU use.
- **CPU-offload memory:** the candidate Ada FP8 profile uses sequential CPU
  offload and requires at least 128 GiB system RAM. The observed Fal RTX PRO
  runner had a 100 GiB cgroup limit, so a Blackwell low-VRAM case must not
  silently fall back to that profile. The H100 runner observed during this
  investigation had a 112 GiB cgroup limit, also below the 128 GiB requirement.
  Check the actual cgroup limit as well as host RAM and GPU memory.
- **Persistent worker diagnostics:** the locally tested, undeployed warm-reuse change drains child
  stderr into an 8 KiB in-memory buffer instead of retaining an unlinked file
  in an old attempt directory. It emits only allowlisted operator events, such
  as model loading and CUDA out-of-memory, and reports an exit status or signal
  when available. Raw stderr is not returned to later requests or exposed in
  Comfy output. This change remains unqualified on Fal until deployed and tested.
- **Upload lease:** the server caps an upload reservation by the current
  fenced lease and attempt deadline. The worker now caps periodic heartbeat
  intervals at 30 seconds and sends a synchronous heartbeat immediately before
  requesting an upload grant. A revoked or fenced attempt stops before upload.
  This change addresses a short reservation window; it has not by itself proved
  the original Cloudflare rejection's cause.
- **Upload User-Agent:** `WorkerApi.upload_file` must send an explicit
  `SlopTogether-Worker/0.1` User-Agent when PUTting to the Cloudflare gateway.
  A signed 10-byte diagnostic PUT returned 201; the subsequent real upscale
  video was uploaded and validated on its first attempt. Rebuild older hosted
  worker images before relying on the new capability.

The changes described in the source tree must be included in the deployed
worker image before a live test exercises them. The source image pins ComfyUI,
Python 3.12, CUDA 13, and separate PyTorch versions for the Comfy process and
SoL child. Upgrade the combination deliberately and qualify it on the target
GPU; changing just the Fal CLI does not upgrade or qualify model dependencies.

## Build and deploy a private Fal app

Prepare a new empty staging directory from the repository root:

```sh
python3.12 workers/runtime/fal/prepare_fal_apps.py \
  --output /tmp/sloptogether-fal-apps-review
```

The generated `generation/` and `upscale/` directories each contain a
`Dockerfile`, `pyproject.toml`, build context, and source manifest. Review the
manifest and Dockerfile. The generated config is an image-only Fal **Direct
Server Mode** app with `exposed_port = 8188`; its container starts Comfy and the
SlopTogether worker. Deploy the configured app by name from its directory.
For example, using the CLI version verified during this investigation:

```sh
cd /tmp/sloptogether-fal-apps-review/upscale
uvx --from fal==1.83.0 fal deploy sloptogether-h3-upscale --check
uvx --from fal==1.83.0 fal deploy sloptogether-h3-upscale --yes
```

Use `generation/` and `sloptogether-h3-generation` for the other role. Inspect
the deploy check for authentication, machine type, regions, concurrency, and
the target account before deploying. In particular, the generated config sets
minimum concurrency to zero; preserve or intentionally set any temporary
test configuration and verify the effective scale after rollout. The role
secrets, API base URL, and exact allowed upload hosts belong in Fal's secret
configuration; do not put values in the Dockerfile, build context, command
arguments, or logs. See `workers/runtime/README.md` for secret provisioning.

An earlier attempt wrapped the server in a temporary `fal.App` Python class.
That selected the Python-app loader and its Python 3.11 check, rather than the
image-only path, and the image build failed. The direct-server configuration
deployed successfully using the CLI above. Do not substitute a stub Python app
for the actual server. A successful rollout or an `IDLE` runner establishes
startup only, not successful inference or upload.

## Live test and diagnosis

1. Check the target app revision, configured scale, runner state, and existing
   job state before spending GPU time. Confirm the input is approved, its
   screening is clear and unexpired, and the broadcaster session is authorized.
   Queue one new test from the channel control page. An ordinary upscale worker
   key cannot create a streamer-controlled job.
2. Follow that job and its attempt/fence through claim, private source download,
   Comfy execution, upload reservation, PUT, server validation, moderation,
   publishing, and browser playback. Do not infer success from a completed
   Comfy prompt or an HTTP health flag alone. Verify the approved derivative is
   actually selected in the HLS program if testing upscale playback.
3. If input download fails, use the bounded `asset_download_http_error` fields
   (status, host, provider code, request ID and Cloudflare ray ID). Distinguish
   the API host from the storage/gateway host. Verify ticket scope, object
   existence and matching size/type without copying a signed URL into logs.
4. If upload fails, identify the Cloudflare response and confirm the worker
   sends its explicit User-Agent. HTTP 403 with code 1010 was reproduced with
   urllib's default User-Agent; a synthetic request with the worker User-Agent
   reached the gateway. `cloud_upload_http_error` reports bounded diagnostics
   without printing the signed URL or body. Compare lease and heartbeat timing
   if needed, but do not infer a ticket's issuance lifetime from a reservation
   expiry that was shortened during failure handling.
5. If memory admission fails, inspect the exact runner's GPU free/total memory,
   cgroup RAM limit, active processes, node error and deployed source revision.
   Check whether a resident child was released and memory was re-probed. Avoid
   retrying the FP8 profile on hosts below its 128 GiB RAM requirement.
6. For input or conditioning-cache permission errors, inspect ownership and
   modes only for the configured shared input and H3 conditioning cache. Ensure
   the relevant processes share the media group. Do not make the cache or keys
   world-readable.

The production media publisher was observed running locally during this test;
its process is part of the path from accepted uploads to HLS. Before restarting
or moving it, preserve its working environment securely or reprovision the
required secrets through the authorized secret store. Vercel sensitive values
may not be retrievable after creation, so do not assume they can be pulled back
from Vercel. Never print, commit, or copy secret values into this runbook.

After local code changes, the worker regression suite can be run with:

```sh
PYTHONPATH=workers/runtime/src python3.12 -m unittest discover -s workers/runtime/tests
```

The suite passed 108 tests during this investigation, including the lease and
memory-profile changes. It does not substitute for a real GPU test or a complete
Cloudflare upload and playback acceptance run.

## GPU shutdown and cost control

Fal GPU runners are billable while allocated. The user's hard limit is two hours;
start only the GPUs needed for the test and verify they are shut down by the
deadline. The shared `sloptogether-fal-session` controller starts from a
deadline measured before wake-up, uses `min_concurrency=0`, sends wake pings,
and on exit scales the named apps down and stops remaining runners. Use
`--generation-only` when no upscale job is pending so the upscale GPU is not
awakened. The
in-container eight-hour limit is **not** a sufficient billing safeguard when an
app has `min_concurrency=1`: Fal may replace the stopped runner. A detached
controller also needs its own supervised lifetime and shutdown verification.

At the deadline, or immediately when testing is finished, set minimum
concurrency and keep-alive to zero for each test app, then inspect and stop any
remaining pending, setup, idle, running, or crash-backoff runners. For each
named app, the scale command is:

```sh
fal apps scale sloptogether-h3-upscale --min-concurrency 0 \
  --max-concurrency 1 --keep-alive 0
fal apps runners sloptogether-h3-upscale --json
```

Repeat for `sloptogether-h3-generation` when it was started. Use the returned
runner IDs with `fal runners stop`; if graceful stop fails, use `fal runners
kill` on those same IDs. Re-list the named apps and runners and confirm minimum
concurrency is zero and no nonterminal runners remain. Never act on unrelated
Fal apps or assume a local process exit proves billing has stopped.
