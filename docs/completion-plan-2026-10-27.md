# SlopTogether completion plan — October 27, 2026

This is the current execution plan. It supersedes older status and execution-order sections in `.omx/plans/sloptogether-remaining-work.md` and the October 24–25 audits. The [full acceptance specification](../.omx/plans/sloptogether-test-spec.md) remains the product contract. Work below is planned unless explicitly described as observed.

## Verified baseline

| Area | Evidence | Remaining qualification |
|---|---|---|
| Public web/API and playback | Independent Vercel app mounted at `https://www.clips.gg/sloptogether`; October 27 recheck: nine program spans, source ready, HLS HTTP 200 with 72 media packets, media range HTTP 206 | Continuous fresh supply, tail/recovery exercise and independent viewers |
| FastH3 | Real Twitch Hosted Test proposal → normal worker lease → five-step 512×288/24fps/15.093s base → approval → timed upscale fallback → published scene 9 → browser playback | Sustained refill and two fresh four-clip style comparisons |
| SoL upscale | Earlier normal app jobs produced approved 1184×666 derivatives and HLS scenes 7–8; not every worker approval was automatic | Fresh unattended upscale path, actual CPU/GPU memory and latency measurements |
| Twitch Extension | Version 0.0.1 active in Hosted Test; real prompt submission and ballot recorded in production; isolated DB test leases the selected FastH3 job | Separate viewer identity/role testing and Twitch public release; paid Prompt Lock remains gated |
| EventSub | Broadcaster subscription scope granted; three real callback challenges returned HTTP 200. Temporary listen-only registration was removed afterward | Real notification → ten-second subscriber render → safe interrupt/resume. Generation/listening off; owner budget/hourly cap $0 |
| Manual Comfy Cloud image | Native Z-Image Turbo nodes, no partner nodes; live 448×256 PNG generated, screened and shown for review | Keep all shared-key image/prompt spending explicit to streamer/mod actions |
| Windows/4090 | Deterministic weight-free WSL runtime packaging, pinned setup and pairing code tested locally | Windows CI blocked before runner steps by GitHub account billing; no Windows executable, actual 4090 run or consumer-memory qualification |
| Operations | Dedicated least-privilege publisher DB login, verified CA TLS and signed Cloudflare gateway; local macOS LaunchAgent restarted after SIGTERM | Off-site supervised publisher/producer, queue alerts, restore/recovery exercise |

Production uses the existing Clips.gg database's separate `sloptogether` schema. Additive migrations 020–025 are applied; no other Clips.gg data was deleted. `anon`/`authenticated` lack schema usage/table grants. Preserve the grants and publisher role when changing policies.

The October 27 review found a human-review bug for subscriber jobs without a story reference and unnecessary checkpoint prefetch. Local fixes and current verification are recorded in [the review report](review-fixes-2026-10-27.md). A load-time FP8 path now avoids deliberately building the full BF16 transformer before conversion; it has CPU regression coverage, **not a measured lower hardware requirement**. The legacy 128 GiB Ada admission guard remains pending a constrained-memory hardware run. It is not the RAM requirement of FastH3 generation.

The most recent Fal shutdown check before this review reported zero runners/GPUs. This review starts no GPUs. Every future session must have an external hard deadline no longer than 7,200 seconds and stop earlier once testing finishes.

## Requirements retained

- Normal story clips are approximately 15 seconds, 16:9, with browser playback captured through standard OBS window capture. Subscriber meme alerts are approximately **10 seconds**.
- Main/output pages are large, clean playback surfaces with seek/history and click-to-pause. Moderation is separate; the independently packaged Twitch Extension handles prompt participation and voting.
- One Twitch channel can own multiple independent streams. History and controller authority remain scoped to the chosen stream.
- The same worker program supports generation and upscale roles on Fal/Linux and Windows/WSL2. Ordinary contributors pair with Twitch and retain human review; scoped trusted owner workers can receive policy approval after screening and validation.
- Comfy Cloud prompt/image requests require an explicit streamer/moderator action. Automated stories and subscription alerts reuse approved images; they never automatically spend the shared Comfy key.
- Use the imported FastH3 Trim five-step and SoL paths; no Wan workflow. Use the existing 512×288 story base profile and 1184×666 upscale candidate. Normalize low-cost keyframes explicitly to the recipe geometry without stretching.
- A consumed payment buys one render attempt. Rejection does not refund render authority; uncertain provider submission is reconciled before another submission.

## Execution sequence

| Phase | Outcome | Depends on | Main ownership |
|---|---|---|---|
| A | One reproducible production baseline with current stream routes | Existing deployment | Web/API, migrations, deployment |
| B | Reliable continuous generation, optional upscale and publishing | A | Worker runtime, CPU publisher, owner producer |
| C | EventSub-driven ten-second subscriber meme clips | A; generation/publication from B | Twitch/backend, story planner, player |
| D | A Windows user installs, pairs and contributes either stage | Pinned recipes from B | Windows packaging/runtime, API pairing |
| E | Real viewer participation, role isolation and Extension release | A; stream controls from B | Extension, Twitch auth/chat, moderation |
| F | Approved paid integration and public operations | E; pricing measurements from B | Payments/provider adapter, deployment |

After the baseline is stable, C and Windows packaging in D can progress independently. Runtime qualification must use the same pinned recipes that B accepts. Do not wait for monetization to finish the free demo or Windows contribution flow.

## A. Reconcile and release the current baseline

1. Record exact source/build identities for web, upload gateway, publisher, Fal generation, and Fal upscale. Review the dirty working tree and preserve others' changes; exclude keys, caches, screenshots, model weights and generated media from release commits.
2. Migrations 020–025 are applied. Preserve existing `main` branches, jobs and program mappings; use additive reviewed migrations for future changes and a compatibility rollback rather than deleting tables/data.
3. Nested stream routes and legacy redirects are deployed. Keep legacy output/moderation/participation URLs mapped to `main` while testing multiple independent streams.
4. Reconcile the latest pending validation/publication work using current lease, retry and outbox errors. A prior stalled scene is a diagnostic lead; do not assume its old state is still current or re-render billable work blindly.
5. Verify the child directly and through the Clips.gg mount: OAuth callback/cookies, upload hosts, media GET/range, seek, center-click playback, and unrelated Clips.gg pages.

**Done when:** two streams on one channel have independent history, jobs, elections, producer leases and playheads; old URLs still work; the original eight clips and the fresh ninth clip remain playable; root Clips.gg routes remain unchanged; all deployed artifact identities are recorded.

## B. Make the normal worker flow continuous

Primary code: [runtime](../workers/runtime/src/sloptogether_worker/), [worker API](../apps/web/src/lib/server/worker-service.ts), [publisher](../workers/media-publisher/src/index.mjs), [publication](../workers/media-publisher/src/publish.mjs), [player](../apps/web/src/components/program-player.tsx).

1. Run the CPU publisher and optional owner story producer as supervised services with secure configuration, readiness checks, restart recovery and queue-age alerts. The demo's local publisher is not durable hosting.
2. Complete the previously authorized trusted Fal upscale binding. Keep it restricted to that channel/stage and approval scope; check bans, current policy, input screening and media validation. Ordinary donor pairing must not inherit this authority. Use [the scoped pairing design](trusted-fal-pairing-plan.md).
3. Keep one fenced story producer per stream. Generate within a bounded lookahead, respecting voted selections, manual holds, paid locks and owner spend caps. Reuse the accepted previous endpoint and preserve its immutable digest.
4. Keep generation and upscale workers independent. Optional upscale must not indefinitely prevent base playback; define an explicit pre-air deadline/fallback and preserve committed history. Measure both profiles rather than importing upstream benchmark claims.
5. Prove lease → actual Trim inference → scoped upload → validation/screening → policy approval or review → HLS commit → browser playback on fresh work, then the separate upscale dependency path. No direct Comfy requests or fixture insertion for this acceptance run.
6. Exercise tail wait/resume, appends during playback, rewind, controller takeover, temporary network loss, worker/publisher restart and late fenced output. Bound browser buffers, manifest windows, history queries and local output cleanup.
7. Use a maximum two-hour external Fal deadline established before wake-up; cancel outstanding wake calls and verify min 0, keep-alive 0, no runners and GPU total 0 on every exit. Do not automatically restart a stopped test session.

For the requested style demonstration, publish two separate approximately one-minute comparisons through normal app jobs: four connected fifteen-second clips from the saved anime-cel keyframe and four from the flat-cartoon keyframe, using independent streams. Include selected SoL upscales, actual stage/queue/cold/warm timings, cost evidence and ordinary playable stream links. The three direct ComfyUI comparison files do not complete this demonstration. Schedule it only after admission/publication is stable and within the declared session budget/deadline.

**Done when:** a four-new-clip smoke plus one accepted upscale passes through the app; then a 20-minute recovery run and the acceptance specification's separate 60-minute fresh-output gate pass with real refill. Record cold/warm stage latency, buffer depth, failures, costs and actual approval mode. If measured supply cannot keep up with 1× playback, report buffered mode and optimize or add explicitly budgeted capacity before claiming continuous real-time supply.

## C. Add EventSub subscriber meme videos

Implement and qualify the [detailed EventSub plan](eventsub-subscriber-memes-plan.md), reusing [the existing subscriber integration](subscriber-interrupts.md).

- Listen to new subscriptions, optional shared resub messages and the configured gift mode through verified webhooks. Persist/deduplicate before acknowledging; generation runs asynchronously.
- Choose from a versioned library of animated gags. Produce a short H3 visual-action plan plus a matching spoken line using the verified subscriber identity, for example a cartoon astronaut whose rocket bursts into confetti.
- Thread a roughly ten-second duration through planning, recipe selection, leases, rendering, conformance, validation and playback; do not merely change the UI label.
- Use approved reusable keyframes, template planning by default, bounded optional cheap text variation, owner funding, cooldowns, event expiry and a queue cap.
- Insert the ready alert at a safe playback boundary in one selected stream, then resume the story once. Never replace a paid scene or replay old alerts during rewind.

**Done when:** a real Twitch event produces one correct, approximately ten-second named cartoon gag through the app and plays/resumes in the browser. Signed local webhook tests prove retry/security/failure cases, not live delivery. Twitch CLI mock notification remains an optional next local check after installing the official CLI; it also does not prove real delivery. Visually check the actual gag; listen to the spoken name/line. Disabled mode spends nothing; a repeated event produces no duplicate job or alert.

## D. Ship the Windows contributor experience

Primary code: [Windows build](../workers/runtime/build-windows.ps1), [worker configuration](../workers/runtime/src/sloptogether_worker/config.py), [CLI](../workers/runtime/src/sloptogether_worker/cli.py), [release API](../apps/web/src/lib/server/worker-service.ts), [downloads UI](../apps/web/src/components/worker-downloads.tsx).

1. Build on Windows using the existing PyInstaller toolchain. Smoke-test the actual executable, archive contents and startup/error behavior; a ZIP built on macOS is insufficient.
2. Continue the WSL2 bootstrap into a supported installer for the selected Linux distribution, compatible host NVIDIA driver checks, pinned ComfyUI/nodes/recipes, Python/CUDA dependencies and explicit licensed model downloads. The initial PowerShell setup script checks WSL2/GPU/RAM and writes the role config, but Windows execution, elevation/reboot recovery, pinned runtime installation and resumable integrity-checked model downloads remain unverified. Do not advertise native Windows inference while the nodes require Linux.
3. Provide a small launcher flow: install/check runtime → connect Twitch → choose channel/stream and generation/upscale → start/pause/stop → show job/result/error. Discover same-distro paths automatically instead of requiring users to hand-edit UNC paths. Keep credentials in protected local storage and allow revocation.
4. Qualify both stages on an actual Windows RTX 4090/24 GB. Use the Ada-compatible attention/precision route, bounded decoding and sequential offload; never admit the Blackwell-only NVFP4/SM120 route. Resolve the existing upscale candidate's 128 GiB host-RAM requirement or clearly label a narrower experimental profile while continuing the required 4090 work.
5. Measure cold/warm latency, output/audio quality, VRAM/RAM, cancellation, cleanup and repeated jobs. Preserve display/OS VRAM headroom and avoid simultaneous heavy models on one GPU. Run the hardware matrix in the test specification.
6. Exercise Twitch pairing → compatible claim → render or upscale → signed upload → review → approved playback; test bans/revocation mid-job and contributor role choice independently. A signed executable does not establish trustworthy inference.
7. Produce versioned, Authenticode-signed releases with timestamps, hashes, runtime/recipe manifests, update/rollback and uninstall. Publish the catalog only after its declared hardware/roles pass qualification. Keep an unqualified developer build distinct from the supported release.

**Done when:** a clean Windows PC can install, pair and complete each role with the qualified hardware profile, without a developer installing ComfyUI by hand. Public donor media waits for required review; the published download is verified, signed and recoverable.

## E. Finish Twitch participation and moderation

- Test identity linking with a separate eligible viewer, not only the broadcaster. Verify Extension/site/chat ballots affect the same stream election and reject stale votes.
- Qualify broadcaster, mod, whitelist, ordinary contributor and banned-user policies across channels/streams. Test role changes and overrides while a worker is rendering/uploading.
- Keep moderation on its own page with clip previews, prompts, input frames, contributor identity, approve/deny and ban actions. Keep explanatory implementation copy out of the player.
- Finish hosted-asset packaging, configuration, CSP/fetch domains, allowed identity access, screenshots and Twitch review requirements. Hosted Test activation is not public Extension release.

**Done when:** separate users submit/vote through the real Twitch-hosted panel and chat; authorized selection appears in the app; moderation and stream isolation hold during concurrent activity; the approved Extension release matches deployed API behavior.

## F. Deliver the Bits prompt lock and finish public operations

The Prompt Lock API and Extension action are now implemented behind separate activation flags. A guarded local PostgreSQL integration test verifies a synthetic confirmed transaction locks the viewer's screened proposal, creates one FastH3 pull-worker job, and leases it without calling Twitch or Fal. Production activation and real Bits transactions remain off. Twitch's current Extensions Guidelines §6.2.8 restrict exchanging Bits for an experience specified by an end user and specifically cite a blank free-form field; §6.5 also forbids describing Bits as a donation. Keep the production action disabled pending Twitch review of this exact interaction. Free prompt submission and voting remain available separately. Twitch explicitly permits Bits for voting activities under §6.1.4; a fixed SKU that adds weight to an existing poll is a distinct reviewed alternative, but it must not guarantee a selected prompt or lock a scene. The separate paid H3 Max Turbo lane remains disabled and hidden. Source: [Twitch Extensions Guidelines and Policies](https://dev.twitch.tv/docs/extensions/guidelines-and-policies/).

Do not rely on examples from other Extensions to override the published restriction. Obtain written review of the exact interaction before enabling Bits. If a fixed vote-boost product is pursued, use the approved catalog count, show the actual Bits amount, weight an existing ballot only, and avoid guarantees. Any provider-priced Turbo product requires its own higher cost-based SKU, economics and approval; do not silently route between Turbo and FastH3. See the [economics and fulfillment plan](paid-turbo-segments.md).
- Reconcile credentials/scopes and earlier rotation obligations; verify database isolation, hostile media, signed-upload bounds, outbox replay and backup/restore in an isolated test environment.
- Add durable CPU deployment, budgets, alerts, retention, incident/rollback runbooks, license/model-term checks and a final Clips.gg regression pass. Record a separate acceptance result for web, gateway, publisher, each Fal role, Extension and Windows artifacts.

**Done when:** release gates in the test specification pass with reproducible evidence; there is a durable operator handoff and no test GPU remains running.

## Dependencies that need real access or a decision

| Item | Needed for | Work that can proceed first |
|---|---|---|
| Windows RTX 4090 test machine | Actual memory/inference qualification | Installer/build automation, pairing, CPU smoke tests and reproducible setup |
| Windows signing credential/service | Supported signed public release | Build a clearly marked developer artifact and verify its hash |
| Durable CPU host | Always-on publisher/producer/reconciliation | Qualify locally with supervised restart and document deploy requirements |
| A real subscription notification (OAuth scope already granted) | Live EventSub render/playback qualification | Signed webhook tests, templates, ten-second recipe and interrupt playback |
| Exact approved paid action | Monetization release | Complete all free participation, rendering and moderation paths |

Already-authorized trusted Fal upscale and the two-hour shutdown cap are settled. Existing product requirements do not need another broad requirements interview. Implementation should proceed phase by phase, with these external dependencies raised only when they actually block a completion gate.
