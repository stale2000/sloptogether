# SlopTogether completion plan

Updated October 24, 2026, America/Los_Angeles. This is the full execution/acceptance plan following [the implementation audit](../../docs/implementation-audit-2026-10-24.md). For the short prioritized snapshot of what's still outstanding, see [the remaining-work plan](sloptogether-remaining-work.md). The original product specification remains useful for feature contracts; this document supersedes its outdated deployment assumptions and readiness claims.

## Objective and current baseline

Deliver the public multi-channel Twitch application at `clips.gg/sloptogether`, with a browser program suitable for OBS capture, genuine background generation/upscale workers, moderation and user participation. Preserve all existing Clips.gg data/features. The four-clip local program is also exposed through a gated smoke route for live playback verification.

Current production baseline (checked October 24): `https://www.clips.gg/sloptogether` and its API are live; production health reports database, R2, OpenAI preflight, and Twitch OAuth configured. Playback, moderation, and Extension panel/config routes return 200. The production-only `NEXT_PUBLIC_LOCAL_DEMO_ENABLED` flag is on; `/channels/localdemo/output` now plays four HLS clips totaling about one minute. Live browser verification passed for playback, clip jumps, seeking, and center-click pause/resume. Twitch OAuth start redirects to Twitch with the registered `SlopTogether Web` client and exact production callback; an actual user consent/session has not been completed. The Twitch Extension is registered as version `0.0.1` in Local Test and its testing asset base points to `https://www.clips.gg/sloptogether/extension/`; its signing secret is stored in Vercel production, while Bits support remains off. The database-backed public channel list is empty and Comfy generation is off. No SlopTogether Fal app or GPU runner exists; generation/upscale build contexts were staged locally under `/tmp/sloptogether-fal-apps-20261024`, the Fal secret store is empty, and no GPU was started. The four-clip stream is still a fixture. R2 credentials and the moderation key were added to Vercel and redeployed, but a real channel upload/render path has not been exercised. The scoped database credential replacement remains stored in Vercel secrets; do not copy it into source control.

## Continuous stream contract

The product has **no fixed clip-count or stream-duration limit**. Three or four clips are only a small smoke test. A channel must keep accepting future proposals/anchors, selecting or locking slots, generating, reviewing and publishing while its existing program plays. Owner story production is optional; viewer selection and other authorized producers can supply future scenes through the same interfaces.

- Maintain a configurable generation horizon in **seconds ahead of the live marker**: low-water, target and maximum lookahead. Refill eligible work as the browser advances; do not stop after a predetermined number of jobs.
- Keep one fenced producer lease per channel and independent generation/upscale leases. Work can be completed by different trusted or volunteer workers; optional upscaling must not block base-quality playback.
- Preserve canonical boundary identities and immutable locked slots when filling the future. New clips append without reloading the player, resetting time, or changing already committed media mappings.
- Make queue depth, expected time to readiness, moderation holds, unavailable workers and budget exhaustion visible in controls. Refill must respect locks, authorizations and single-use paid attempts.
- When work is late, hold the last approved frame and resume when usable media arrives. A starvation condition is not evidence of a healthy continuous stream.
- Bound browser memory, HLS buffers and live-manifest response size for long sessions. Preserve older clips through indexed history/seek APIs and stable source mappings rather than loading the entire stream into every browser poll indefinitely.
- Stream state survives browser, producer and worker restarts. Reconnecting workers resume eligible jobs using leases/fences, without duplicate paid submissions or losing the playhead.
- The eight-hour GPU shutdown instruction applies to the authorized **test compute session**. It is not an eight-hour product stream limit. Production supervision must allow streams to continue across worker replacement and routine credential/session renewal.

Acceptance therefore has two levels: four clips prove the initial smoke path; sustained refill, append, recovery and bounded-resource checks prove the continuous-stream implementation.

## 1. Establish one reliable configuration and evidence baseline

1. Rotate the scoped database credential that was included in migration/tool history. Provision its replacement out of band and keep it in a secret manager. Do not rewrite/delete the existing Clips.gg database or historical migrations during cleanup.
2. Make web database validation, OAuth readiness and media-worker validation agree on the approved shared project and `sloptogether_app` privileges. Handle the selected direct or Supabase pooler URL consistently and require SSL for remote connections.
3. Verify the scoped connection using actual SQL from the intended runtime environment. Confirm it can operate on app tables and cannot read/write existing Clips.gg public tables or create roles/schemas.
4. Preserve the current demo and source. Establish a reviewed source-control baseline after scanning tracked candidates for secrets and excluding runtime screenshots, caches, build contexts and local state. Keep the Clips.gg proxy diff separate from unrelated host changes.
5. Consolidate the local demo uploader onto the guarded implementation. Label fixture jobs/receipts accurately; remove recipe-authority expansion and hardcoded provider receipts from any normal execution path.

**Exit checks:** one shared-project configuration works in web/OAuth readiness/media-worker tests and runtime; replacement credential works while the old one fails; baseline is reviewable and contains no live secrets; latest production build, lint, typecheck and relevant tests pass.

## 2. Finish the browser workflow using the existing four clips

1. Use the ready HLS program on the channel page even before a controller marker exists. Keep preview playback separate from the authenticated authoritative marker.
2. Remove contradictory waiting text when a usable program exists. Keep the OBS output free of participation/moderation notices over the video.
3. Implement scene selection and seek controls in the channel/control UI, with stable mapping to program item/offset. Preserve clip boundaries and marker authority when seeking backward or taking over the source.
4. Add explicit retry/reclaim or focus-based reauthorization after Twitch sign-in without restarting playback. Show clear preview/controller/takeover states.
5. Make the review queue update during generation; distinguish failed loads from empty queues. Expose stale/reconnecting state for timeline/manifest polling while retaining cached playable content.
6. Confirm queue-tail behavior: hold the last approved frame while waiting, then continue when a new committed clip arrives. Replay/rewind remains an intentional control action.

**Exit checks:** play all four clips from zero through three transitions; select each scene; seek back beyond the 16-second back buffer; retry after temporary disconnect; append another approved clip while waiting and resume without a reload. Verify Chromium and Safari/native HLS. Record decoded frame progression and audio, not just `paused=false`.

## 3. Bring up durable API, private storage and CPU publication

1. Deploy the child app with the schema-scoped database connection, independent secrets and the correct `/sloptogether` base path. Choose the canonical origin consistently with the host's current `clips.gg` → `www.clips.gg` redirect and exact Twitch callback registration.
2. Establish real private R2 connectivity. Deploy the bounded upload gateway and configure exact upload/read origins, CORS, byte/expiry limits and object lifecycle cleanup.
3. Run the media publisher as a supervised persistent CPU service using the same scoped app connection and dedicated storage credentials. Verify health via a small real object round trip, upload admission and an HLS range read.
4. Apply only the isolated proxy/middleware changes to the host when the child is healthy. Verify root host routes, cookie/header filtering and rollback before enabling public traffic.
5. Add operational status for queue age, media validation/publication failure, moderation availability, database/storage connectivity and worker activity. Readiness must probe the dependency it claims to represent.

**Exit checks:** public `/sloptogether` page and health route work; signed uploads and playback succeed through real R2; the app role remains isolated; proxy rollback preserves Clips.gg. Never expose the loopback emulator as a remote-worker shortcut.

## 4. Run the actual shared Fal generation and upscale workers

Start GPU use only after steps 1 and 3 supply working endpoints and credentials.

1. Complete generated Fal app configuration: reachable API URL, channel ID, role, immutable recipe IDs, exact upload/download host allowlists and separate generation/upscale keys. Inject credentials only into their matching private apps.
2. Regenerate durable build contexts from the committed source and validate their manifests. Deploy private generation/upscale applications with zero minimum concurrency and at most one runner each.
3. Establish the absolute session shutdown deadline before waking a GPU, respecting the user's existing eight-hour limit. Start the supervisor before or atomically with the wake requests; idle scale-down is a fallback. Do not extend the deadline silently.
4. Wake generation first. Wait for image/model startup, node/profile compatibility and successful authenticated API polling before reporting ready. Submit one ordinary FastH3 job through the app and observe lease → pinned Comfy graph → output conformance → signed upload → validation → trusted approval → HLS commit.
5. Wake upscale only when that base clip is ready. Queue one ordinary SoL job; verify preserved audio, parent lineage, dimensions, review/trust policy and separate approved derivative.
6. Expose last claim, last completion and last failure. Fix API/upload/model/node failures from runner logs; do not mark workers ready solely from `/system_stats`.
7. Run a short automatic-shutdown test and verify `fal runners list` returns zero afterward. Only then run the longer demonstration session with the same hard deadline.

**Exit checks:** Fal inventory shows the two actual SlopTogether app aliases; both roles complete real jobs using the shared executable and pinned nodes, without SQL fixtures/manual MP4 upload. Runner identities, input/output digests, timings and shutdown evidence are recorded. Stop idle GPUs once the required work ends.

## 5. Demonstrate sustained continuous generation and playback

1. Run the owner story producer with its scoped key and cheap bounded planner/template. It must reuse the previous clip's approved canonical endpoint revision.
2. Initially buffer **four new consecutive clips** using the actual Fal generation worker as a smoke test. Preserve meaningful provider/runtime provenance and use the normal conformance code; do not manually scale or inject records. Continue refilling future work after those four clips.
3. Verify each clip's prompt/start/end moderation evidence and canonical boundary relationship. Held/rejected work reopens the correct slot and fences stale jobs.
4. Keep browser output running while new clips arrive and the buffer changes. Confirm progression past the initial four clips through repeated refill cycles. Measure generation/validation throughput against playback consumption; sustained generation must keep up or the configured lookahead eventually drains.
5. After the short smoke, run a budgeted continuous acceptance session of at least 20 minutes with real replenishment, a worker restart, a temporary network failure and a queue-starvation/recovery case. Verify old scenes remain seekable and live-manifest/browser memory stay bounded. Set the duration/spend/deadline before starting; record an unperformed soak as unverified.

**Exit checks:** an unattended run keeps authoring/selecting, rendering, approving/publishing and playing beyond its initial four-clip buffer without a count cap or manual refill. At least one upscale completes; no direct fixture SQL, manual downloads or local smoke uploader is involved. The stream recovers when the queue runs dry and across worker replacement without a page reload. The bounded-resource and sustained-run checks are recorded separately from the short smoke.

## 6. Qualify Twitch participation and moderation

1. Configure the real Twitch OAuth app and token encryption. Exercise broadcaster, moderator, whitelisted reviewer, ordinary viewer and banned-user sessions across two channels.
2. Verify proposal/frame upload → live preflight → election/manual selection → job → review/approval/denial. Confirm the review queue updates while workers run.
3. Use site, Twitch chat and the Extension to change ballots in the same election. Verify the lock winner and stale vote rejection through server state.
4. Verify authenticated browser marker updates, takeover and login recovery while output continues.
5. Enable subscriber interruptions for a controlled test: verify EventSub signatures/replay protection, cheap prompt/dialogue generation, owner budget/cooldown, interrupt playback at a safe boundary and story resume.

**Exit checks:** recorded cross-role/channel authorization checks; one real chat/Extension election; one verified subscription interruption/resume path; rejected outputs stay off the program. Keep actual Twitch broadcasting disabled unless separately requested.

## 7. Complete paid Turbo and volunteer distribution

**Paid Turbo:** confirm the exact Twitch-approved Bits product/action and revenue/pricing policy. Then qualify transaction verification, reservation, one provider submission, private output ingestion, conformance and review. Denial/failure cannot reuse the same payment for a new render; delayed receipts and ambiguous submissions require reconciliation. Enable gates only after this works with the approved integration.

**Windows/4090:** build the Windows executable and working inference installation flow. Measure generation and upscale separately on an actual 4090/24 GB Windows/WSL2 machine, including VRAM/RAM peaks, cold/warm latency, repeated tasks, cancellation, audio and cleanup. Address the current 128 GiB host-RAM requirement or state a narrower supported profile. Sign/package releases only after qualification. Verify Twitch pairing, role selection, bans, revocation and human approval for ordinary volunteer output. Client signatures/digests are not proof that an untrusted worker honestly executed inference.

**Public release:** complete operator runbooks, secret rotation, backups/recovery, budget ceilings, failure alerts, license/model-term review and current hackathon submission requirements. Resolve the archived rules/schedule conflict with the organizer if it affects submission. Do not claim live-Twitch demonstration evidence from the local capture alone.

## Remaining external decisions/access

These are deployment/product dependencies to resolve when reached, not reasons to stop local fixes:

- Real Twitch application/Extension ownership, credentials, approved domains/callbacks and eventual approved Bits SKU/action/pricing.
- Working production R2/gateway credentials and CPU-service hosting configuration; distinguish invalid configuration from local DNS/TLS limitations.
- A measured operating spend ceiling and the absolute allowed GPU deadline; use on-demand GPUs and zero idle minimum by default.
- Access to actual Windows/4090 hardware and release signing credentials.
- Repository destination/access for a durable private baseline, plus any unresolved upstream redistribution terms.

The existing product decisions on shared database, 15-second 16:9 browser output, Windows contribution roles, trusted owner workers, moderation, voting and single-use paid attempts are settled and should not be asked again.

## Completion evidence

Maintain a small ledger per milestone: source revision, environment, command/request identity, observed state, result and remaining limitation. Label each item as source/unit evidence, local fixture evidence, live provider evidence or real product-flow evidence. Completion requires the corresponding product-flow exit checks; a passing source/helper suite does not qualify a deployed worker or a public release.
