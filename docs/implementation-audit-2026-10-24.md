# SlopTogether implementation audit

Reviewed October 24, 2026, America/Los_Angeles. This document records the current implementation and observed runtime, including the limitations of the four-clip local demonstration. It supersedes older deployment/readiness statements. The next steps are in [the completion plan](../.omx/plans/sloptogether-completion-plan.md).

## Current result

The local site and a four-clip browser program exist. The API returns four committed HLS spans totaling **60.333332 seconds**, at manifest revision 4. All four parent video assets are published at 1280×720 with audio. Browser playback advanced from the beginning with `paused=false`, `readyState=4`, and decoded 1280×720 video in the preceding verification. The latest read found playback at the queue tail, approximately 60.4 seconds, with `readyState=2`; new content is not being generated automatically.

Output page: `http://localhost:3000/sloptogether/channels/localdemo/output`.

**The requested two custom SlopTogether Fal workers are not running.** Fresh CLI reads returned no SlopTogether applications, no Fal secrets, and no active runners. Completed marketplace H3 Max Turbo requests prove Fal video generation works, but do not prove the imported TrimH3 generation worker or SoL upscale worker works on Fal.

The four-clip number is only the user's test size. The application requirement is a continuous stream with no fixed clip-count/duration cap: future work must refill and append while playback runs, with restart/recovery and bounded resource use. The finite fixture has not established that behavior. The requested eight-hour GPU shutdown applies to test compute, not the lifetime of a product stream.

## Evidence and capability inventory

| Area | What exists | Evidence limit / remaining work |
|---|---|---|
| Local application | Next app at `/sloptogether`; API, directory, channel, controls, moderation, output, pairing and download routes | Running in development mode; user flows requiring Twitch login are unavailable locally |
| Browser program | Four published HLS clips, approximately one minute, audio, 16:9 | The public `localdemo` smoke fixture is a static Vercel HLS asset; it verifies playback UI but does not prove DB/R2 publication or continuous generation |
| Local services | Next, media publisher, loopback S3 emulator and temporary Postgres | No running story producer, custom generation loop, upscale loop, or Fal session controller |
| Actual Fal generation | Marketplace H3 Max Turbo image-to-video requests completed; one new output became clip four | Generated through an operator/tool call, then manually downloaded and normalized; no custom Fal worker execution |
| Shared production database | 44 `sloptogether` tables added to the existing Clips.gg project; 25 pre-existing public tables retained | Vercel connects through the IPv4 pooler with the scoped role and verified Supabase CA; production has no channel rows |
| Database access | Scoped `sloptogether_app` login; zero public-table DML grants; no superuser/RLS bypass; `anon` and `authenticated` have no schema usage | All 44 app tables have RLS disabled; preserve private backend-only access until an explicit RLS/API policy design is implemented |
| Media handling | Worker upload tickets, immutable snapshots, digest checks, quarantine, validation, trusted/human approval and HLS publication | Production R2 and upload gateway are not provisioned. The public demo fixture does not qualify worker uploads or publication |
| Worker source/import | Bounded ComfyStreamer source, provenance manifests, pinned recipes, same shared Python runtime, prepared generation/upscale Fal contexts | Prepared contexts are source artifacts; no deployed SlopTogether apps and no GPU qualification for these images |
| Twitch | OAuth/session, chat ballots, Extension assets, EventSub subscription handling, subscriber interrupt source | Health reports `twitchOAuth:false`; no live signed-in browser, real chat/Extension ballot, subscriber render/resume or channel-token rotation acceptance |
| Paid Turbo | Gated Bits intent, receipt/reconciliation, single-attempt accounting, provider queue and ingestion source | Disabled. No real approved SKU/payment/settlement end-to-end run; marketplace smoke did not use Bits |
| Windows/4090 | Packaging code, role selection, Twitch pairing, WSL2 configuration and candidate memory profiles | No signed runnable public installer; no actual Windows/4090 generation/upscale qualification |
| Public hosting | Child Vercel project deployed at `https://sloptogether.vercel.app`; narrow proxy merged into the separate Clips.gg repository and deployed to the existing host project | `https://www.clips.gg/sloptogether` and `/api/v1/health` return HTTP 200. Production `GET /api/v1/channels` returns an empty list; no production channel or clips are seeded |
| Hackathon research | Announcement, API documentation, schedule and rules notes archived under `research/` | Rules notes retain an organizer schedule conflict; submission/access/license requirements still need final review |

## What the fourth-clip test actually did

1. Extracted a frame from the third published clip.
2. Uploaded a compressed copy to Fal and requested a 15-second H3 Max Turbo continuation. The accepted request was `01a16f66-7535-77b2-8e1d-d3b2f333bc43`.
3. Downloaded the generated MP4: 1344×768, 15.104 seconds, with audio.
4. A first upload was correctly rejected as `media_dimensions_invalid`.
5. Manually used FFmpeg to produce 1280×720/24fps H.264 with AAC.
6. A local-only fixture script inserted the next selected revision/job and expanded the local worker key's recipe allowlist. A client helper claimed the job and uploaded the MP4 through the real worker API.
7. The running media publisher validated, approved under its trusted execution policy, packaged HLS and committed program item four.

This proves the local admission/publication/player path can accept real generated media. It does not prove autonomous generation, actual execution of the imported worker recipes, proper provider orchestration, or a normal streamer/user selection flow. An earlier Fal request from a different test frame also completed but was not used in the program.

## Concrete issues

Priority P1 blocks the requested operational milestone or safe production use. P2 is a functional/integrity gap that must be addressed before calling the product complete. P3 is release hygiene.

### Resolved — Shared database connection

- Web pool and media publisher accept only the direct Clips.gg database with the `sloptogether_app` login or the matching Supavisor pooler host with the project-qualified `sloptogether_app` login. Both require `SLOPTOGETHER_USE_CLIPSGG_DATABASE=true`.
- Vercel cannot resolve the direct IPv6-only database host. The Vercel runtime now uses Supavisor's IPv4 transaction pooler and the Supabase CA certificate with verification enabled. A verified `psql` query succeeded and the live `/api/v1/channels` endpoint returns `{"channels":[]}`.
- The scoped runtime role has no superuser, createdb, createrole, or RLS-bypass privileges. Direct SQL confirms `anon` and `authenticated` lack `USAGE` on the private `sloptogether` schema and have no channel-table read/write privileges; the generic Supabase table advisor overstates exposure for this private schema.

**Remaining:** seed an actual Twitch channel and configure Twitch OAuth before enabling channel-specific moderation or voting.

### Resolved — Historical database credential

The scoped login was created using a password-setting statement submitted through `apply_migration`. Supabase migration history still stores that old password statement, and it passed through the tool transcript. **That password has been rotated**; the replacement is in a user-only mode-0600 local file and was not added to migration history. Migration `019` enables the restricted role's login. Vercel now connects through the verified Supavisor transaction pooler using the replacement credential.

The old credential remains in migration history but was rotated and is no longer valid. Keep replacement credentials only in deployment secrets. Do not delete unrelated migration history/tables.

### P1 — Custom Fal worker deployment is incomplete

Fresh Fal inventory is empty for SlopTogether. Generated app definitions and the secret setup helper now include the role key, API base and upload-host allowlist, and the worker reads the allowlist from its environment. No Fal secrets/apps were provisioned. The public API route is live, but GPU workers and remote upload storage are not configured.

The loopback storage emulator cannot be used from remote workers and must remain unexposed. A real R2 HeadBucket attempt failed with a TLS handshake error; working production storage credentials/connectivity have not been established.

**Required result:** reachable HTTPS API, real private R2/gateway, exact media/upload host allowlists, channel/role/recipe configuration, independent role keys, successful custom GPU execution and an exercised shutdown controller.

### Resolved in code — Channel page preview before marker claim

ChannelWorkspace now uses the continuous program manifest for preview and readiness, even when `currentProgramItem` is null. A browser check showed the four-clip 1280×720 program on the channel page.

The live marker still requires an authenticated controller.

### P1 — Continuous refill and long-session operation are not demonstrated

There is no active story producer or custom generation/upscale worker loop. The four-clip program currently reaches its queue tail and waits. The code has producer/job/lease structures, but a sustained system must replenish a configurable future horizon while playback consumes it, recover from worker and browser restarts, and respect locks, moderation and funding.

The current program service builds an event playlist and all program spans from the committed epoch (`program-service.ts:25,105`). A production stream also needs a bounded live window, indexed older history and stable seek/marker mappings; merely growing that response forever is not a long-session resource strategy.

**Required result:** no clip-count cap; actual workers refill beyond the initial smoke buffer; new clips arrive without reload; optional upscale does not block playback; queue starvation is visible/recoverable; throughput, memory and manifest size remain acceptable in sustained tests.

### P2 — Output seeking and controller recovery remain incomplete

- The ready-HLS empty-state overlay is removed. The channel page now previews the ready manifest before a live marker exists.
- Anonymous Start checks Twitch session first and retries session/claim while playback continues, so a later sign-in can take control.
- Scene rows remain display-only. The clean output player has no visible scene seek control; backward seek and replay after the finite fixture ends need acceptance.
- Playback and native HLS were tested in Chromium only. Safari/native HLS, authenticated marker writes/takeover and subscriber safe-boundary resume remain unverified.

**Required result:** seek among committed items, authenticated marker updates/recovery, and successful playback tests across supported browsers.

### P2 — The demonstration metadata cannot establish worker provenance or canonical continuity

`scripts/append-local-fal-continuation.mjs` is a guarded local fixture, not a production orchestration path:

- It records marketplace H3 as `pull_worker` and extends a trusted key to permit it. The real shared renderer only accepts its FastH3/SoL recipe IDs and would reject this model ID.
- The provider request ID is hardcoded and is not bound to the downloaded bytes. `job_attempts.provider_request_id` is null; the ID is only fixture planning metadata.
- The recipe hash hashes a model name rather than an immutable workflow/model configuration.
- `moderate()` returns the nested classifier result and discards the response envelope ID, so the stored combined moderation ID becomes `","`.
- It records `planned_anchors`, although the final image was extracted after generation rather than supplied as a preselected end anchor.
- It creates a fresh start-boundary ID from an extracted previous frame rather than reusing the prior canonical endpoint resolution. Visual continuity alone does not establish shared boundary identity.
- It uploads image objects before committing the database transaction, without the normal reservation/cleanup path.

**Required result:** use ordinary server APIs and producer/worker jobs; bind provider receipt, input/output digests, configuration, moderation evidence and the canonical endpoint IDs. Keep fixture evidence labeled as such.

### Partly resolved — Live moderation and stale-state handling

The review queue now refreshes every five seconds and preserves its previous items on fetch failures. Timeline/program hooks expose refresh errors while retaining cached content. The web preflight sends one moderation request per image because the API accepts one image per request. Unit tests cover that behavior; authenticated proposal submission with two frames, outage recovery and reviewer polling under real generation load remain unverified.

**Required result:** distinguish stale, failed and empty states in the interface and verify the full prompt/start/end-frame flow through the server API.

### P2 — Worker readiness, upscaling and Windows claims need real evidence

The Fal session controller now waits for both authenticated Comfy wake pings before reporting both apps awake. This still does not prove worker API authentication, job polling or completed work. No SlopTogether Fal apps or role secrets are provisioned. The web API is deployed, but the private R2 bucket and upload gateway are not.

There is no custom Fal upscale result in this demonstration. Normal worker and paid-Turbo conformance code already exists, but it was bypassed by the manual normalization in this smoke run; exercise it rather than adding a third geometry path. The 4090 SoL candidate requires 128 GiB system RAM and remains unmeasured on Windows/WSL2. Public Windows packaging, signing and hardware qualification are unfinished.

**Required result:** readiness includes successful first wakes and API polling, status exposes last claim/completion/error, both roles complete actual jobs, and Windows support is advertised only for measured profiles.

### P2 — Twitch and paid features have source coverage but no live acceptance

Twitch OAuth is locally unconfigured. Chat/Extension voting, role moderation, bans/device pairing, subscriber-event-to-clip interrupt/resume and single-use Bits transactions have not been exercised together against live Twitch. Bits gates remain disabled; no end-user payment was collected by the smoke. Approved products, pricing and the owner revenue policy are still release dependencies.

**Required result:** real broadcaster/moderator/viewer sessions, the same election through site/chat/Extension, verified EventSub deduplication and subscriber interrupt/resume, then approved monetization with one render per verified payment. No Twitch broadcast is authorized by this audit.

### P3 — Source control, scripts and status documentation need consolidation

The SlopTogether repository has a committed `main` baseline and GitHub remote. This working copy still has uncommitted ComfyStream import edits and a local browser screenshot; these are separate from the live web deployment and should be reviewed before committing. The host proxy was merged in Clips.gg PR #233 and is deployed. The redundant `local-worker-upload-smoke.py` helper was removed because it could use a non-loopback worker target and read the entire MP4 into memory; `upload-local-fal-smoke.py` is the supported local-only uploader, with loopback, fixture-channel, job-stage, file-size and MP4 checks.

The README now describes the four-clip fixture and deployed public path. Using the existing Clips.gg database through a restricted `sloptogether` schema is a settled decision documented in `docs/open-questions.md`; older planning notes are historical. Durable source should not depend on `/tmp` build contexts or local secret files. Imported license/model terms and the archived hackathon rules need final submission/release review.

## Verification performed for this audit

| Check | Current result |
|---|---|
| `npm test` | 102 web tests passed; 2 opt-in PostgreSQL tests skipped; 6 script tests passed |
| `npm run typecheck` and `npm run lint` | Passed |
| `npm run media-test` | 39 passed |
| `npm run worker-test` | 92 passed; mocked session log messages are not real GPU evidence |
| Local health/program APIs | Online; local emulator; OAuth false; four program spans/revision 4 |
| Production database read | 44 app tables, 25 public tables, no runtime-role public DML grants, no anonymous schema usage |
| Live Clips.gg mount | `https://www.clips.gg/sloptogether` and health endpoint return HTTP 200 through the deployed host proxy |
| Live channel listing | HTTP 200 with `{"channels":[]}`; no production channel is configured |
| Live output page | Four HLS clips play at 1280×720; center click toggles play/pause and clip 2 seek worked. This is the gated static smoke fixture, not a DB/R2 channel stream |
| Production storage | Unconfigured; local R2 settings point at the loopback emulator, not Cloudflare R2 |
| Fal inventory | No SlopTogether apps, no secrets, zero active runners |
| Latest browser read | Four-clip source loaded; decoded 1280×720; waiting at the finite queue tail with no media error |

The last production build passed before the latest playback/auth/preflight edits. It must be repeated on the next implementation snapshot. Unit/helper passes do not substitute for real GPU, authenticated Twitch, private R2 or multi-browser playback acceptance.

## Confirmed decisions to preserve

- Existing Clips.gg database, additive app schema only; no deletions or changes to other applications' tables.
- Requested URL `/sloptogether`, separate app/runtime, ordinary OBS browser-window capture, no OBS plugin and no site-to-Twitch broadcaster.
- Approximately 15-second 16:9 clips; canonical adjacent boundaries and an authoritative authenticated browser marker.
- Independent generation/upscale contributor roles; Windows target; trusted owner/Fal keys; Twitch-linked ordinary workers; configurable admission/review/ban rules.
- Chat and Extension voting, optional subscriber interruptions, cheap story planning, and new funding for each new paid generation attempt.
- GPU use only for required work, with a hard shutdown deadline no later than the user's authorized eight-hour session limit.
