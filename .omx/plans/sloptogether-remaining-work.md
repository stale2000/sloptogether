# SlopTogether remaining work

Reviewed October 24, 2026 against the current `main` checkout and live Clips.gg deployment. This is the prioritized execution view; the [completion plan](sloptogether-completion-plan.md) retains the full acceptance contract.

## Current evidence

- **Live playback smoke works:** `https://clips.gg/sloptogether/channels/localdemo/output` redirects to `www.clips.gg`. The live page serves four HLS spans (60.333 seconds total); browser checks passed for starting playback, jumping to clips 2–4, seeking, and center-click pause/resume. See the static fallback in [channel-data.ts](../../apps/web/src/components/channel-data.ts#L43-L55) and the playback controls in [output-source.tsx](../../apps/web/src/components/output-source.tsx#L101-L120).
- **Production health:** database, Cloudflare R2 configuration, moderation key, and Twitch OAuth credentials are reported configured. Comfy prompt/frame generation is off. The health endpoint checks configuration presence; it is not evidence of a real upload, moderation request, or authenticated Twitch session. See [env.ts](../../apps/web/src/lib/server/env.ts#L21-L53).
- **No real channel:** `GET /api/v1/channels` returns zero channels; `/api/v1/channels/localdemo/program` returns 404. The public demo comes from static JSON/HLS files, not a database channel or worker output.
- **Twitch is configured but unaccepted by a user:** the OAuth app and Extension are registered, and OAuth start reaches Twitch with the production callback. The user explicitly skipped the Twitch consent test. No actual account session, channel creation, moderator role, Extension JWT, chat ballot, or EventSub delivery has been verified. Channel creation and worker-key issuance require an authenticated broadcaster session: [channel-service.ts](../../apps/web/src/lib/server/channel-service.ts#L62-L78) and [channel-service.ts](../../apps/web/src/lib/server/channel-service.ts#L375-L396).
- **Storage is configured but unqualified:** health reports `cloudflare_r2`, and the private bucket/upload gateway are present. No real signed object upload → validation → HLS publication → range read has been exercised; the media publisher is a separate process with its own runtime requirements: [workers/media-publisher/README.md](../../workers/media-publisher/README.md#L9-L18).
- **Fal workers are not deployed:** current Fal inventory has no SlopTogether apps and the Fal secret store is empty. Generation/upscale contexts exist only under `/tmp/sloptogether-fal-apps-20261024`; no SlopTogether GPU was started. The app definitions use `GPU-RTXPRO6000`, `min_concurrency=0`, `max_concurrency=1`, and role-specific keys: [prepare_fal_apps.py](../../workers/runtime/fal/prepare_fal_apps.py#L22-L38), [set_worker_secrets.py](../../workers/runtime/fal/set_worker_secrets.py#L14-L42). The controller caps a session at eight hours: [fal_session.py](../../workers/runtime/src/sloptogether_worker/fal_session.py#L19-L20) and [fal_session.py](../../workers/runtime/src/sloptogether_worker/fal_session.py#L140-L157).
- **Hardware/release evidence is missing:** no actual Windows/WSL2 RTX 4090 generation or upscale run, signed installer, custom Fal inference, or sustained stream run exists. The WSL profile currently has a 128 GiB system-RAM gate and is not hardware qualified: [workers/runtime/README.md](../../workers/runtime/README.md#L12-L35).

## Priority order

### P0 — Keep the live smoke reliable

1. Keep `NEXT_PUBLIC_LOCAL_DEMO_ENABLED=true` for the public smoke demo until a real database-backed channel is ready to show. Preserve the demo as playback-only; it must not create fake channel, moderation, vote, or worker state.
2. Keep the live smoke check in deployment verification: output route 200, four clip jumps, approximately 60 seconds of HLS, playback start, seek and pause/resume. Do not report this as a real channel or generation test.
3. Review the outstanding working-tree ComfyStream edits separately before release. Do not stage or revert them as part of SlopTogether work.

**Acceptance:** the live smoke route passes after each deployment, the database-backed channel list remains truthful, and the demo moderator route clearly says it has no review queue.

### P1 — Bootstrap a real Twitch channel (deferred)

1. The next required action is a Twitch account consent/login using `openid user:read:moderated_channels`; the user explicitly declined this test for now. Do not initiate it until the user opts in.
2. After consent, verify state-cookie/callback/session handling, create the broadcaster's channel through the API, and set an initial contribution mode, review policy, owner budget and trusted-worker grants.
3. Issue separate generation, upscale, and owner story-producer keys through the authenticated channel control flow. Never mint a production key by direct database edits or reuse the Twitch OAuth/Extension signing secrets.

**Acceptance:** one real channel appears in the public list; its broadcaster session can read settings, create scoped keys, and revoke them. No Twitch broadcast is needed for these checks.

### P1 — Qualify the production data path

1. After a real test channel is authorized, run an R2 round trip against a unique test prefix in `sloptogether-media`: issue an upload ticket, PUT an MP4, let the media publisher validate and publish it, read the HLS manifest and byte range, then remove only that test object. Confirm bucket privacy, CORS, expiry, byte caps, and host allowlists.
2. Deploy `workers/media-publisher` as a supervised CPU service with the schema-scoped `sloptogether_app` role, R2 credentials, moderation key, and `ffmpeg`/`ffprobe`. Verify its health and that it processes one genuine outbox event; do not substitute the local S3 emulator.
3. Re-run the least-privilege database check after deployment: app tables work through the production pooler/CA, public Clips.gg tables remain inaccessible to the app role, and anonymous Supabase roles cannot use the private schema.

**Acceptance:** a database-backed approved clip reaches the private bucket, passes moderation/media validation, becomes an HLS item, and plays on the channel route without direct SQL or manual file injection.

### P1 — Deploy and qualify the two Fal workers

1. Only after the R2/media path and channel-scoped keys work, regenerate build contexts into a durable, reviewed location from the committed source; `/tmp` contexts are disposable.
2. Store the generation and upscale keys only in the matching private Fal apps, with exact API URL and upload-host allowlist. Keep zero minimum concurrency and one runner maximum.
3. Start the eight-hour session controller before waking GPUs. Run one FastH3 job end-to-end, then one SoL upscale on that accepted base clip. Verify leases, recipe, input/output hashes, audio, dimensions, moderation, approval, R2/HLS output, status, and that active Fal runners return to zero after shutdown.
4. Resolve the target-GPU mismatch before calling the requested 4090 supported: the prepared generation app pins `GPU-RTXPRO6000`/SM120. Measure a 4090-compatible profile on actual 24 GB hardware, including the current 128 GiB host-RAM gate, VRAM peaks, latency and quality. Do not claim hardware support based on a different GPU.

**Acceptance:** both private apps complete one authentic job through the normal APIs; no marketplace clip, manual normalization, fixture SQL, or direct upload stands in for the custom workers.

### P1 — Prove continuous stream behavior

1. Use the owner story producer and trusted generation worker to create four new consecutive clips through normal prompt/frame checks, funding, job leases, validation and approval.
2. Keep the browser playing while the producer appends beyond those four clips. Run at least a 20-minute test with a worker restart, temporary network failure, queue starvation, recovery, backward seek and one upscale.
3. Measure generation/validation throughput against playback consumption; test the low/target/high lookahead and define the owner spend cap before the run. Confirm history and manifest size remain bounded as the stream grows.

**Acceptance:** generation keeps pace or the configured queue-hold state is visible; playback resumes without reload after new items arrive; stale workers cannot overwrite locked or already committed slots.

### P2 — Qualify Twitch Extension, chat, moderation and subscriptions

1. The Extension currently remains in Local Test; Bits are off. After Twitch account consent, test panel authorization, linked identity, proposal submission, shared election/ballot across site/chat/Extension, moderator review, bans and revocation.
2. Configure EventSub secrets/subscriptions and verify HMAC signature, replay deduplication, subscription/resub/gift handling and safe-boundary subscriber interruption/resume.
3. Keep Bits disabled until Twitch approves a fixed SKU/action and pricing, transaction verification is live, and the single-attempt/reconciliation path is tested. Do not implement a paid custom-prompt lock or guaranteed vote override; keep the user-requested policy boundary in [channel-playback-and-extension-flow.md](channel-playback-and-extension-flow.md#L24-L31).

**Acceptance:** recorded role/channel test matrix, a real Extension ballot and moderator decision, verified EventSub delivery, and no actual Twitch broadcast unless separately requested.

### P2/P3 — Windows support and public release

1. Build and sign the Windows executable; test generation and upscale roles on the actual supported Windows/WSL2 hardware, including installation, resource checks, cancellation, audio, cleanup, pairing, bans and revocation.
2. Set spend/budget ceilings, backups and restore checks, runtime error alerts, retention/deletion policy, model/license review, current hackathon-rule review and an operator runbook.

**Acceptance:** signed installer and hardware evidence for every advertised GPU profile; release gates stay off until payment, worker and security checks pass.

## Open decisions and constraints

- **Explicitly deferred:** the user chose “Skip sign-in test.” OAuth app credentials are configured, but no user consent/session or first real channel exists. Do not retest without renewed user authorization.
- **Bits:** Twitch-approved SKU/action, final prices/payout, and whether Bits fund an already-selected candidate or reserve a slot remain open. The custom paid prompt/guaranteed override is not an allowed design.
- **Operating limits:** set the owner's generation/subscriber budget, target horizon and shared-compute spend cap before continuous/Fal runs. The eight-hour shutdown applies to each authorized test GPU session, not stream lifetime.
- **Other policy choices:** Twitch-ban sync, vote/tie rules, Channel Points, vote weighting, GPU-contributor recognition, per-channel BYOK, auto-start, replay/quarantine retention and normal-story audio remain open; see [open-questions.md](../../docs/open-questions.md#business-or-channel-behavior-still-to-choose). Settled decisions are in [product-decisions.md](../../docs/product-decisions.md).
- **No destructive cleanup:** use only the existing Clips.gg project and isolated `sloptogether` schema; do not delete or rewrite unrelated tables, migrations, host routes, or the uncommitted ComfyStream import work.

## Verified checks and gaps

- **Passed:** live output playback/seek/pause/resume on `www.clips.gg`; current Vercel deployment is `READY`; health reports database/R2/OpenAI/Twitch OAuth configured; `npm test` 100 passed / 2 skipped, lint/typecheck/build pass; Fal worker unit set 20 passed.
- **Not proven:** real channel OAuth consent; database-backed production channel; R2 upload/publication round trip; supervised CPU media publisher; custom Fal generation/upscale; continuous refill; real Twitch Extension/EventSub/Bits; Windows/4090; sustained-session limits.
