# SlopTogether production review — October 25, 2026

Reviewed October 25, 2026, America/Los_Angeles (production failures include October 26 UTC timestamps). This is a historical status record. The [October 27 completion plan](completion-plan-2026-10-27.md) and [Fal runbook](fal-upscale-runbook.md) supersede its readiness findings. Next actions and acceptance gates are in the [remaining-work plan](../.omx/plans/sloptogether-remaining-work.md).

## Assessment

The web app and much of the coordination code exist, but the real channel is **not working end to end**. Production sign-in, channel creation, input upload, screening, moderator approval and selecting work have been exercised. The custom Fal generation worker fails while downloading its input, before inference. No production generated clip has reached the committed playback program. The four-clip `localdemo` demonstrates playback of prebuilt media only.

A follow-up fix separated storage download failures from API worker-key failures. It was deployed to generation revision `ddc9a696-8db5-42ec-b934-5bff5090c4f2`; worker tests now cover both cases. Fal deployments briefly create a setup runner while rolling out. After scaling min 0/keep-alive 0 and stopping it, the generation runner is `DEAD`, the upscale runner list is empty, and both apps report zero active runners. This does not assert anything about unrelated Fal applications.

## Verified state and limits

| Area | Evidence | Assessment |
|---|---|---|
| Separate deployment | Public `/sloptogether` child app and API respond; production commit `5a296519bc30389e08638b6bf1ecd1d7111081dc` was observed Ready in Vercel | Mounted without merging repositories. Recheck unrelated Clips.gg routes on subsequent deployments. |
| Production health | Database, Twitch OAuth, OpenAI preflight, Comfy frame generation and R2 flags true; Comfy prompt generation false | These are configuration flags, not end-to-end dependency probes. |
| Twitch identity and inputs | Prior live checks completed broadcaster OAuth, created `stale2000`, uploaded an image, cleared preflight, approved and selected a proposal | Moderator/viewer/whitelist/banned-user matrix still unqualified. |
| Real channel playback | Fresh `/api/v1/channels/stale2000/program`: HTTP 200, zero `programSpans`, `waiting_for_packaging`; database: zero committed program items | No real generated stream to watch yet. |
| Static playback smoke | Earlier browser check: four prebuilt HLS spans, about 60.333 seconds; seeks, clip jumps and center-click pause/resume worked. Fresh output-page request returns 200 | Does not prove custom inference, uploads, production publishing or continuous refill. The fixture program API returns 404; its fixture path is separate from the real channel API. |
| Private storage | Exact submitted input object exists in `sloptogether-media`; real uploads worked after gateway fixes | Fal read of the signed input URL still returns HTTP 403. Upload success does not prove worker read access. |
| Generation app | Deployed revision `da0125c7-5e54-4a0f-afa1-88e831a78999`; latest job had three `asset_download_failed` attempts | Deployment and node startup are not successful inference. |
| Upscale app | Deployed revision `99513125-5c02-4d90-94fc-679e16419474`, now off | No accepted production upscale; older revision needs explicit qualification. |
| Publisher | Local media-publisher process observed; implementation includes validation, HLS, continuations and cleanup | A PID is not evidence of healthy production credentials, queue drainage or durable hosting. |
| Queue/storage hygiene | Database: 7 approved assets, 22 uploading, 1 quarantined; 6 failed jobs, 1 cancelled; 30 pending `storage.delete_staging` events | Inspect age, leases and retry errors. These counts alone do not prove all rows are stale or safe to delete. |
| Comfy start frames | Manual-only broadcaster/moderator code, low-resolution 448×256 Z-Image-Turbo workflow and a local test image | Production `comfy_frame_generations` has no rows. Local test/provider workflow validation does not prove the live app button completes. |
| Twitch Extension | Separate `extension/` source, shared API/JWT and ballot implementation, live assets and Local Test registration from prior checks | Real installed Extension voting, chat synchronization and role/race acceptance remain unverified. |
| Paid Turbo / Bits | Receipt, reconciliation and gated dispatch code exists | Real payments remain disabled/unqualified. Fixed Turbo product does not complete the requested custom paid prompt override. |
| Subscriber interrupts / story worker | EventSub, bounded story planning and worker code exist | No sustained live subscriber-to-video interruption/resumption acceptance. No active story producer observed. |
| Windows donor executable | Worker/packaging source exists; Windows path currently uses WSL2 for inference | Public release endpoint returns `available:false`, `worker_release_not_published`. No signed installer or real RTX 4090 generation/upscale qualification. |

## Main findings

### P0: source-asset read is the current critical-path failure

Latest generation job `883433af-d684-447a-b96b-7ff638a2aef6` failed three attempts around 02:23–02:28 UTC on October 26. The authorized app asset route redirects to signed R2 storage; the worker receives a 403 HTML response of 151 bytes, without an S3 XML error code. The exact source object exists.

Both virtual-hosted and account/path-style URLs have failed. Commit `5a29651` forces path-style R2 signing and is deployed, but did **not** resolve the failure. Earlier attribution to URL style was a hypothesis, not an established root cause. Credentials, request signing, redirect/client behavior and network/proxy response origin still need controlled diagnosis. Do not assume a fresh key or another GPU restart will fix it.

The worker now logs the final host, HTTP status, Cloudflare ray ID, response server, content type, body size/hash and a few safe body markers; it never logs the signed query. The latest live 403 body itself has not yet been observed with this code. Next compare the exact immutable object request across CPU and Fal clients, including method, signature, headers, expiry and redirects. Keep diagnosis separate from model generation until a fresh approved job exists.

### P0: storage errors are misreported as invalid worker keys

`workers/runtime/src/sloptogether_worker/client.py::download_asset` wraps storage HTTP errors as `ApiError(status, "asset_download_failed")`. `workers/runtime/src/sloptogether_worker/service.py::WorkerService.run` treats every `ApiError` 401/403 as `worker_key_invalid` and exits. Thus an R2 denial becomes a misleading credential failure and runner crash/restart. Distinguish API authentication from downstream media-fetch failures, preserve safe cause information, and add a regression before changing retry behavior. The active generation key was not revoked or expired in the database snapshot.

### P0: failed startup must not keep spending

Region changes, redeploys and retries have not produced video. Startup can take minutes, the session helper can wake both roles, and initial health requests may wait up to an hour. A per-container two-hour limit does not by itself stop replacement runners when app minimum concurrency remains nonzero. Require role-selective sessions, a deadline outside the container, cancellation of outstanding requests, and verified zero runners after any exit/startup failure. Two hours is an upper bound, not a target test duration.

### P1: CPU publication and cleanup need operational qualification

Prove the publisher's schema-scoped database/R2 access and its ability to consume durable work. Investigate the 30 pending deletion events and 22 uploading rows by age, eligibility and last failure. Never delete accepted source/approved media as a cleanup shortcut. Host the publisher under supervision, expose queue age/failure/readiness evidence, and prove restart recovery. This must be ready before a successful GPU MP4 can become a playable stream.

### P1/P2: feature code is ahead of acceptance evidence

Current unit tests do not establish real GPU correctness, seamless fresh-output supply, Twitch-hosted Extension identity/voting, Bits economics, subscriber interrupts or 24 GB Windows inference. Keep these as explicit release gates. Volunteers are untrusted: digest/fence checks protect protocol integrity but cannot prove a malicious donor actually ran the model. Moderation and trust policy remain required.

## Automated verification in this review

| Command | Result |
|---|---|
| `npm run lint` | Passed, zero-warning ESLint gate. |
| `npm run typecheck` | Passed. |
| `npm test` | 104 Vitest tests passed, 2 skipped; another 9 Extension/fixture/guard tests passed. The follow-up added 2 worker regressions (now 96 worker tests). |
| `npm run media-test` | 39 passed. |
| `npm run worker-test` | 96 passed after adding R2/error-classification regressions. |
| `node --test workers/upload-gateway/tests/index.test.mjs` | 3 passed. |
| `npm run build` | Passed production build. |

The skipped tests are the opt-in Postgres program/subscriber integration suites (`SLOPTOGETHER_RUN_DB_INTEGRATION=1`). Do not run them against the shared production database without inspecting their isolation/setup. Test logs are under `/tmp/sloptogether-audit-*.log` and are disposable. Vite reports a future native-config-loader warning; Node reports an upload-gateway module-type warning. These are minor tooling hygiene items, not the production failure.

CodeGraph was unavailable (not initialized; CLI not installed), so focused direct source reads were used. This is a readiness review, not a claim of exhaustive line-by-line security analysis. Browser playback evidence above is from earlier live checks; this turn used fresh public HTTP/SQL/CLI checks and did not repeat browser playback against nonexistent production clips.

## Source and deployment hygiene

`main` is pushed at the deployed signing fix, but the working tree contains earlier worker, upload-gateway and ComfyStream extraction changes/deletions, generated outputs and build metadata. Web production, Fal generation, Fal upscale and the upload Worker are independently deployed artifacts. Establish and record each artifact's exact source revision/hash before another acceptance run; do not infer that deploying the web app updates other workers. Review the existing changes without reverting others' work, exclude secrets/caches/output images from commits, and retain only the required imported runtime with provenance/license checks.

## Decisions still open

1. What exact Twitch-permitted paid action will satisfy the requested custom-prompt priority/lock? Confirm the applicable policy, eligibility, Bits product, precedence, net revenue and actual generation cost before enabling it. Do not silently replace the requirement with the current fixed Turbo offer.
2. Where will the persistent CPU publisher and optional owner story producer run? Local supervised processes are acceptable for a demo; a public product needs durable hosting, budgets and monitoring.
3. Which generation/upscale profile can actually fit a Windows RTX 4090 with acceptable RAM, quality and latency? Current Fal SM120 hardware success, if obtained, will not prove SM89/24 GB support.
4. What moderation staffing/trust mode sustains the intended channel? Preserve manual review for ordinary donors and explicit scoped trusted bypass, with preflight still required.

Other settled requirements remain in [product decisions](product-decisions.md) and the [acceptance specification](../.omx/plans/sloptogether-test-spec.md): approximately 15-second 16:9 clips, browser/OBS playback, separate moderation and Extension, manual Comfy requests, one paid attempt, generation/upscale role choice and continuous streams with no four-clip cap.

## Follow-up status — worker error classification deployed

`workers/runtime/src/sloptogether_worker/client.py` now classifies a 401/403 from the final storage host as `asset_storage_unauthorized` / `asset_storage_forbidden`, not an API `ApiError`. The supervisor only calls credentials invalid on 401, and maps the known authorization-specific 403 codes separately. The storage log fields above are bounded and omit URLs/query strings. Targeted lifecycle tests and all 96 worker tests passed. The generation image was deployed as revision `ddc9a696-8db5-42ec-b934-5bff5090c4f2`; minimum concurrency 0, keep-alive 0, and zero active runners were verified after rollout.

This corrects the false worker-key diagnosis; it does **not** resolve why R2 returns the HTML 403. The previous production jobs each used all three attempts and are terminal. The live moderation page currently asks to connect Twitch, so a new approved/selected job cannot be queued until the broadcaster session is restored. The two Postgres integration tests are still skipped.


## Follow-up — October 26, 2026

A successful download fix replaces Fal's direct R2 S3 GET with a short-lived signed read ticket. Vercel only issues it after validating the worker key, live lease/fence, channel, asset status and clear input screening. Cloudflare deployment `4687460cef884d2c85d304fe7a665954` uses its existing R2 binding and secret bindings to stream that exact private object, checking byte size and content type. It adds no R2 keys to Fal. Vercel commit `2ba27d2` is Ready. Gateway unit tests (6) cover allowed channel prefix, signature/expiry tampering and size changes.

The unfunded production job `45e2da30-ad02-4f72-9b96-740c87bafeb1` then reached H3 inference setup but failed while reading the pinned ComfyUI core revision. The node's Git check ran as an unprivileged user against a root-owned checkout and reported “ComfyUI core source status could not be read.” A scoped `safe.directory=/opt/ComfyUI` exception is now in ComfyStream's model cache and unit tested against both that pinned path and a normal local path. Fal revision `ac932f17-b3bc-40e8-bb8e-9a6c450c323a` carries it; a live job after this fix remains necessary. The most recent job used all three attempts without funding.

The app has no committed production video yet. The user has authenticated as `stale2000`; the Mac re-locked while preparing another approved proposal. Both Fal apps are scaled to min 0, keep-alive 0 and have no active, pending, setup or running workers. Lint, typecheck and production build passed; 258 unit/contract tests passed and the 2 opt-in Postgres integration tests remain skipped.
