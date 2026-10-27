# SlopTogether completion plan — October 27, 2026

This is the current execution plan. It supersedes older status and execution-order sections in `.omx/plans/sloptogether-remaining-work.md` and the October 24–25 audits. The [full acceptance specification](../.omx/plans/sloptogether-test-spec.md) remains the product contract. Work below is planned unless explicitly described as observed.

## Verified baseline

- The public web/API deployment is mounted at `https://www.clips.gg/sloptogether` independently of the Clips.gg repository.
- The latest public program check returned eight committed spans, 120.666664 seconds, `continuousSourceState=ready`, a valid HLS playlist, and a successful HTTP 206 media range GET. This does not establish sustained fresh generation.
- The [Fal runbook](fal-upscale-runbook.md) records real FastH3 base renders, signed uploads, screening/approval, and 1184×666 pre-air upscales committed to the browser program. Some approvals were manual. The newer anime/cartoon comparison jobs bypassed the app pipeline and remain separate inference evidence.
- Twitch Extension 0.0.1 is active in Hosted Test on `stale2000`. The October 27 upload used asset MD5 `2ae3bc8c93247a434185625bc97d7712`; the hosted asset renders. The installed panel could not be qualified in live channel context because the channel was offline. The isolated PostgreSQL integration submits a test-signed Extension prompt, records Extension and signed chat ballots on one election, then leases the selected FastH3 job.
- Live Hosted Test submission check (October 27): the panel's test prompt request reached production but returned HTTP 409; no proposal or job was created. The selected `main` stream has no unlocked future slot because its latest scene is still rendering and earlier scenes are played; the owner story producer is not active and the owner budget is `$0`. Do not resolve this during a low-cost smoke test by creating/funding a production generation slot. A Twitch EventSub live subscription is separately gated: subscriber feature off, owner budget `$0`, and `channel:read:subscriptions` not granted. Twitch's official CLI supports signed mock webhook triggers ([docs](https://dev.twitch.tv/docs/eventsub/handling-webhook-events/)); the CLI is not installed here. The guarded local Postgres suite exercises the signed handler and queue flow without external services or GPU spend.
- The Extension preserves prompt rejections across polls, scopes ballots to the selected stream, and ignores stale in-flight responses after identity or stream changes. Its live Hosted Test prompt POST returned 409 because `main` has no unlocked future slot; no production proposal or job was created. Turbo remains hidden in the Extension, and the paid-Bits server path is hard-gated to `NODE_ENV=test`.
- Latest verification (October 27): `npm test` passed (164 web tests; 19 skipped; 17 additional tests), `npm run lint`, `npm run typecheck`, and `npm run build` passed. `scripts/test-eventsub-local.sh` passed 12 guarded web/PostgreSQL cases and 20 media publisher/PostgreSQL cases, including signed EventSub deduplication, a queued/leased 10-second subscriber render, Extension prompt/vote → worker lease, and playback skip/rewind behavior. `npm run worker-test` passed 147 tests; Fal app lifecycle messages were mocked. `npm run media-test` passed 51 unit tests, with 20 DB-only cases skipped outside the guarded database wrapper. `pwsh` is not installed on this Mac. `fal runners gpus --json` remains `{"gpus":{},"total":0}`.
- The authenticated Developer Console accepted the Hosted Test upload, but no real subscription was triggered. The Twitch channel is offline; its OAuth grant lacks `channel:read:subscriptions`, subscriber interrupts remain disabled and owner budget is `$0`. No 2FA code was guessed. Live EventSub delivery therefore remains unqualified; the signed handler and subscriber-to-worker path are verified in isolated PostgreSQL only.
- The subscriber duration contract is already implemented locally: admission records 10 seconds/243 frames, generation leases use the dedicated 10-second FastH3 recipe, and publisher integration verifies a 10.125-second HLS item. The new `022_harden_stream_trigger_search_path.sql` passed that guarded database suite and is applied to production. Its two stream trigger functions now have an empty `search_path`; the Supabase security advisor no longer reports those functions.
- Supabase's table inventory emits an RLS-disabled advisory for the 46 `sloptogether` tables. Direct privilege checks showed the `anon` and `authenticated` roles have no `USAGE` on the `sloptogether` schema and no table read/write grants, so those tables are not currently reachable through the Supabase Data API. Preserve those grants; do not enable RLS without policies because the app's server-side database role needs explicit access.
- Media validation now checks the immutable attempt deadline before downloading output and again under the commit lock. Expired validation rejects the attempt and reopens the uncommitted segment rather than approving a late result. The guarded isolated-Postgres suite now proves this path and passed all 20 publisher DB integration cases (alongside 10 web DB cases); `npm run media-test` passed 51 unit tests, with 20 DB-only cases skipped when run without the guarded database.
- Production migrations 020–023 are applied, with required `stream_id` columns, the default stream, and the dedicated publisher role. PR #1 is deployed: `/channels/stale2000/streams` and `/streams/main/program` return 200, the HLS playlist returns 200, and a packet range returns 206. The browser output plays HLS clip 1 without its clip-preview fallback. Controller and publisher writes were updated to satisfy the deployed schema.
- The Windows release API returned `available:false`, `worker_release_not_published`. The WSL2 setup bundle now includes a deterministic, weight-free archive of the pinned 3.6 MB ComfyStreamer runtime. With `-InstallComfyUI`, setup installs WSL OS prerequisites (with sudo), clones the ComfyUI manifest commit, creates a Python 3.12 venv, installs the locked runtime, installs role-specific node sources and pinned ClipProj for generation, and prepares the isolated SoL runtime for upscale. The separate `-DownloadModels -FastVideoRevision <40-character-commit>` option retrieves only the Trim-required generator models, reusing the Hugging Face token stored inside WSL and verifying every file hash; it does not download the alternate 8-step checkpoint. Existing ComfyUI can instead use `-InstallNodes`/`-InstallDependencies` after its checkout and Python are verified. The runtime packager preserves Git execute bits across Windows builds, and its manifests were regenerated to match the current cleaned node source. Package tests and the vendored CPU artifact/Trim suite pass. A Windows GitHub Actions workflow was added, but its first two runs failed before any runner steps because GitHub reports failed recent account payments or a spending-limit restriction. No Windows bundle artifact has been produced; no Windows executable has been run or hardware-qualified.
- Release PR [#1](https://github.com/stale2000/sloptogether/pull/1) merged as `23efb53560e1878f5e980c0b6e77447cee801af9`; Vercel Production deployment completed and the stream API/HLS path was verified live. The Windows worker workflow continues to fail before runner steps because of GitHub account billing limits; no artifact was produced, and the installer has not been run on Windows.
- The deterministic WSL runtime packager tests verify FastH3, SoL and worker-identity sources plus locked dependency manifests are present and no model weights are bundled. All four package tests pass; the Windows build workflow YAML parses; Fal remains at zero GPUs.
- Both Fal apps were stopped after the last GPU test. Every future Fal session has a hard maximum of **7,200 seconds**, enforced outside the containers as well as inside them. Stop earlier once testing finishes.
- Manual Comfy Cloud start-frame path: the native-node Z-Image Turbo workflow uses `partner_nodes=[]`. PR #2 deployed the explicit UUID/text outbox casts. A new live 448×256 request then committed as Comfy generation `970cb149-0c69-4154-b6dc-e263066af34a`, succeeded, and its screened PNG loaded into the proposal form for review. The proposal remains unsubmitted; no Fal GPUs were started.
- The serving Vercel Production deployment includes provisional reservation estimates of `$0.55` for story generation and `$0.55` for subscriber renders. These are accounting reserves, not measured provider cost ceilings. The only production channel still has owner budget `$0`, subscriber interrupts disabled, and no broadcaster subscription scope, so these values do not enable spending or EventSub delivery.
- The media publisher is running locally against production through the `sloptogether_publisher` login and Cloudflare gateway, without direct R2 credentials or a Fal key. It rejected expired attempt `79a55afa-5e24-41ba-81a6-8632c1f6382c`, delivered its validation event, deleted the staging object, and passed a signed gateway put/get/delete smoke test. No fresh video was published. Durable hosting is still required for unattended production publication.

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
2. Apply migration 021 through an additive, reviewed deployment to the existing `sloptogether` schema. Check existing `main` branches, jobs and program mappings survive backfill. Take a backup first; use a compatibility rollback rather than deleting tables/data.
3. Deploy the current channel directory and nested stream routes. Preserve legacy output/moderation/participation URLs by redirecting to `main`.
4. Reconcile the latest pending validation/publication work using current lease, retry and outbox errors. A prior stalled scene is a diagnostic lead; do not assume its old state is still current or re-render billable work blindly.
5. Verify the child directly and through the Clips.gg mount: OAuth callback/cookies, upload hosts, media GET/range, seek, center-click playback, and unrelated Clips.gg pages.

**Done when:** two streams on one channel have independent history, jobs, elections, producer leases and playheads; old URLs still work; existing eight clips remain playable; root Clips.gg routes remain unchanged; all deployed artifact identities are recorded.

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

The originally requested Bits Prompt Lock is not yet implemented. Twitch's current Extensions Guidelines §6.2.8 prohibit exchanging Bits for an experience specified by an end user and specifically cite a blank free-form field; §6.5 also forbids describing Bits as a donation. Therefore do not expose or enable the paid custom-prompt flow without explicit written Twitch clearance. Keep free custom prompt submission and voting separate. Twitch explicitly permits Bits for voting activities under §6.1.4; a fixed SKU that adds weight to an existing poll is a possible reviewed alternative, but it must not guarantee a selected prompt or lock a scene. The separate paid H3 Max Turbo lane remains disabled and hidden. Source: [Twitch Extensions Guidelines and Policies](https://dev.twitch.tv/docs/extensions/guidelines-and-policies/).

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
| Broadcaster subscription OAuth grant and available live event | Live EventSub qualification | Webhook/CLI tests, templates, ten-second recipe and interrupt playback |
| Exact approved paid action | Monetization release | Complete all free participation, rendering and moderation paths |

Already-authorized trusted Fal upscale and the two-hour shutdown cap are settled. Existing product requirements do not need another broad requirements interview. Implementation should proceed phase by phase, with these external dependencies raised only when they actually block a completion gate.
