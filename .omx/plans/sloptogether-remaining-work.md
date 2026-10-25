# SlopTogether remaining work

Updated October 25, 2026 against the current `main` checkout and live Clips.gg deployment. This is the prioritized execution view; the [completion plan](sloptogether-completion-plan.md) retains the full acceptance contract.

## Current evidence

- **Live playback smoke works:** `https://clips.gg/sloptogether/channels/localdemo/output` redirects to `www.clips.gg`. The live page serves four HLS spans (60.333 seconds total); browser checks passed for starting playback, jumping to clips 2–4, seeking, and center-click pause/resume. See the static fallback in [channel-data.ts](../../apps/web/src/components/channel-data.ts#L43-L55) and the playback controls in [output-source.tsx](../../apps/web/src/components/output-source.tsx#L101-L120).
- **Production health:** database, Cloudflare R2 configuration, moderation key, and Twitch OAuth credentials are reported configured. Comfy prompt/frame generation is off. The health endpoint checks configuration presence; it is not evidence of a real upload, moderation request, or authenticated Twitch session. See [env.ts](../../apps/web/src/lib/server/env.ts#L21-L53).
- **Production channel exists:** the broadcaster completed Twitch OAuth and created channel `stale2000`. Its live output is `https://www.clips.gg/sloptogether/channels/stale2000/output` and currently waits for the first approved scene. The static `localdemo` remains a separate playback-only fixture.
- **First-scene submission is reachable:** `/sloptogether/channels/stale2000/participate` now exposes the existing prompt and frame workflow without adding controls to the clean output page. The live frame upload and proposal submission are not yet complete; a local start frame still needs to be selected in the browser.
- **Twitch features remain unqualified:** OAuth/channel creation were verified, but no moderator-role matrix, Extension JWT/vote, chat ballot or EventSub delivery has been tested. Channel creation and worker-key issuance require an authenticated broadcaster session: [channel-service.ts](../../apps/web/src/lib/server/channel-service.ts#L62-L78) and [channel-service.ts](../../apps/web/src/lib/server/channel-service.ts#L375-L396).
- **Storage is configured but unqualified:** health reports `cloudflare_r2`, and the private bucket/upload gateway are present. No real signed object upload → validation → HLS publication → range read has been exercised; the media publisher is a separate process with its own runtime requirements: [workers/media-publisher/README.md](../../workers/media-publisher/README.md#L9-L18).
- **Fal apps are deployed; inference is not qualified:** private `sloptogether-h3-generation` and `sloptogether-h3-upscale` apps are deployed with `GPU-RTXPRO6000`, `min_concurrency=0`, `max_concurrency=1`, `keep_alive=60`, and role-scoped keys in Fal Secrets. Deployment validation briefly started a generation runner and left an upscaler runner pending; both were stopped, and no generation/upscale job ran. The deployment definitions are in [prepare_fal_apps.py](../../workers/runtime/fal/prepare_fal_apps.py#L22-L38). The supervisor has an eight-hour hard ceiling, but the live test should wake only the role needed for an already queued job and stop it after completion; do not keep both GPUs warm for the full session.
- **Credential rotation is a prerequisite for live inference:** the previous diagnostic output exposed local provider credentials and a generation worker key. The user has been asked to rotate them and replace the matching Fal secret before allowing workers to claim production jobs. Do not print credential-bearing process environments or expose one-time keys in accessibility output.
- **Hardware/release evidence is missing:** no actual Windows/WSL2 RTX 4090 generation or upscale run, signed installer, custom Fal inference, or sustained stream run exists. The WSL profile currently has a 128 GiB system-RAM gate and is not hardware qualified: [workers/runtime/README.md](../../workers/runtime/README.md#L12-L35).

## Priority order

### P0 — Keep the live smoke reliable

1. Keep `NEXT_PUBLIC_LOCAL_DEMO_ENABLED=true` for the public smoke demo until a real database-backed channel is ready to show. Preserve the demo as playback-only; it must not create fake channel, moderation, vote, or worker state.
2. Keep the live smoke check in deployment verification: output route 200, four clip jumps, approximately 60 seconds of HLS, playback start, seek and pause/resume. Do not report this as a real channel or generation test.
3. Review the outstanding working-tree ComfyStream edits separately before release. Do not stage or revert them as part of SlopTogether work.

**Acceptance:** the live smoke route passes after each deployment, the database-backed channel list remains truthful, and the demo moderator route clearly says it has no review queue.

### Complete — Bootstrap a real Twitch channel

1. Twitch consent completed; the broadcaster channel was created through the production control room.
2. Separate generation and upscale worker keys were issued through the channel control flow and stored in the corresponding Fal secret entries. Rotate the exposed generation key and replace its Fal secret before worker authentication is used.

**Acceptance achieved:** the live channel output and control room resolve for `stale2000`; no Twitch broadcast was started.

### P1 — Qualify the production data path

1. After a real test channel is authorized, run an R2 round trip against a unique test prefix in `sloptogether-media`: issue an upload ticket, PUT an MP4, let the media publisher validate and publish it, read the HLS manifest and byte range, then remove only that test object. Confirm bucket privacy, CORS, expiry, byte caps, and host allowlists.
2. Deploy `workers/media-publisher` as a supervised CPU service with the schema-scoped `sloptogether_app` role, R2 credentials, moderation key, and `ffmpeg`/`ffprobe`. Verify its health and that it processes one genuine outbox event; do not substitute the local S3 emulator.
3. Re-run the least-privilege database check after deployment: app tables work through the production pooler/CA, public Clips.gg tables remain inaccessible to the app role, and anonymous Supabase roles cannot use the private schema.

**Acceptance:** a database-backed approved clip reaches the private bucket, passes moderation/media validation, becomes an HLS item, and plays on the channel route without direct SQL or manual file injection.

### P1 — Deploy and qualify the two Fal workers

1. The private generation and upscale apps are deployed from contexts staged under `/tmp/sloptogether-fal-apps-20261025`. Regenerate them from committed source for a durable release; `/tmp` contexts are disposable.
2. Rotate the exposed generation worker key and update only `SLOPTOGETHER_WORKER_KEY_GENERATION` in Fal Secrets. The separate upscale key is stored as `SLOPTOGETHER_WORKER_KEY_UPSCALE`.
3. After the first-scene proposal resolves to a ready job, wake only the generation app, run the job, then let it scale down. Wake the upscale app only if an accepted base clip has an upscale job. Keep `min_concurrency=0`, `max_concurrency=1`, and verify both apps return to zero active runners.
4. Verify leases, recipe, input/output hashes, audio, dimensions, moderation, approval, R2/HLS output, and playback. Stop each runner promptly after its job; the eight-hour supervisor limit is a hard ceiling, not a target uptime.
5. Resolve the target-GPU mismatch before calling the requested 4090 supported: the prepared generation app pins `GPU-RTXPRO6000`/SM120. Measure a 4090-compatible profile on actual 24 GB hardware, including the current 128 GiB host-RAM gate, VRAM peaks, latency and quality. Do not claim hardware support based on a different GPU.

**Acceptance:** both private apps complete one authentic job through the normal APIs; no marketplace clip, manual normalization, fixture SQL, or direct upload stands in for the custom workers.

### P1 — Prove continuous stream behavior

1. Use the owner story producer and trusted generation worker to create four new consecutive clips through normal prompt/frame checks, funding, job leases, validation and approval.
2. Keep the browser playing while the producer appends beyond those four clips. Run at least a 20-minute test with a worker restart, temporary network failure, queue starvation, recovery, backward seek and one upscale.
3. Measure generation/validation throughput against playback consumption; test the low/target/high lookahead and define the owner spend cap before the run. Confirm history and manifest size remain bounded as the stream grows.

**Acceptance:** generation keeps pace or the configured queue-hold state is visible; playback resumes without reload after new items arrive; stale workers cannot overwrite locked or already committed slots.

### P2 — Qualify Twitch Extension, chat, moderation and subscriptions

1. The Extension currently remains in Local Test; Bits are off. Test panel authorization, linked identity, proposal submission, shared election/ballot across site/chat/Extension, moderator review, bans and revocation.
2. Configure EventSub secrets/subscriptions and verify HMAC signature, replay deduplication, subscription/resub/gift handling and safe-boundary subscriber interruption/resume.
3. Keep Bits disabled until Twitch approves a fixed SKU/action and pricing, transaction verification is live, and the single-attempt/reconciliation path is tested. Do not implement a paid custom-prompt lock or guaranteed vote override; keep the user-requested policy boundary in [channel-playback-and-extension-flow.md](channel-playback-and-extension-flow.md#L24-L31).

**Acceptance:** recorded role/channel test matrix, a real Extension ballot and moderator decision, verified EventSub delivery, and no actual Twitch broadcast unless separately requested.

### P2/P3 — Windows support and public release

1. Build and sign the Windows executable; test generation and upscale roles on the actual supported Windows/WSL2 hardware, including installation, resource checks, cancellation, audio, cleanup, pairing, bans and revocation.
2. Set spend/budget ceilings, backups and restore checks, runtime error alerts, retention/deletion policy, model/license review, current hackathon-rule review and an operator runbook.

**Acceptance:** signed installer and hardware evidence for every advertised GPU profile; release gates stay off until payment, worker and security checks pass.

## Open decisions and constraints

- **Twitch consent and channel creation completed:** the owner connected Twitch and created `stale2000`. No Extension, chat, moderator-role or EventSub behavior has been exercised yet.
- **Bits:** Twitch-approved SKU/action, final prices/payout, and whether Bits fund an already-selected candidate or reserve a slot remain open. The custom paid prompt/guaranteed override is not an allowed design.
- **Operating limits:** set the owner's generation/subscriber budget, target horizon and shared-compute spend cap before continuous runs. Wake one Fal role only when its queue has work; do not use the two-app heartbeat controller to hold both GPUs warm. The eight-hour limit is a hard shutdown ceiling for an authorized test session, not target uptime.
- **Other policy choices:** Twitch-ban sync, vote/tie rules, Channel Points, vote weighting, GPU-contributor recognition, per-channel BYOK, auto-start, replay/quarantine retention and normal-story audio remain open; see [open-questions.md](../../docs/open-questions.md#business-or-channel-behavior-still-to-choose). Settled decisions are in [product-decisions.md](../../docs/product-decisions.md).
- **No destructive cleanup:** use only the existing Clips.gg project and isolated `sloptogether` schema; do not delete or rewrite unrelated tables, migrations, host routes, or the uncommitted ComfyStream import work.

## Verified checks and gaps

- **Passed:** live `stale2000` participation route and clean output route resolve; Vercel deployment for commit `1ba9169` is `READY`; web tests 101 passed / 2 skipped, lint/typecheck/build passed; Fal generation and upscale apps are deployed private with zero minimum concurrency. Deployment validation runners were stopped and no inference job was run.
- **Not proven:** production first-frame upload/proposal, R2 upload/publication round trip, supervised CPU media publisher, custom Fal generation/upscale, continuous refill, live Twitch Extension/chat/EventSub/Bits, Windows/4090, or sustained-session limits. Rotate the exposed generation key and provider credentials before worker inference.
