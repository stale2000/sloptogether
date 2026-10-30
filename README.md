# SlopTogether

Collaborative Twitch video generation: viewers submit scene prompts through the site or Twitch Extension and vote through the Extension, site, or chat. All ballots share one channel election. The shared worker runtime renders/upscales on Linux/Fal, and the streamer captures a 16:9 browser window in ordinary OBS. A Windows client can use the Linux nodes through WSL2; that inference path remains experimental pending RTX 4090 qualification. Configurable channel keys enable trusted workers and full streamer overrides; no OBS plugin or site-to-Twitch broadcaster is required.

Public URL: **https://www.clips.gg/sloptogether** (the apex domain redirects to `www`).

## Windows test build

The Twitch-themed Windows desktop interface is now in source. Build it on Windows with [the packaging script](workers/runtime/build-windows.ps1); it produces a windowed executable and ZIP bundle. This GUI update has not yet been packaged into a Windows download. Do not use the older release ZIP if you need the GUI. GitHub Actions is not used to run the worker or build this package; upload the locally built bundle to [GitHub Releases](https://github.com/stale2000/sloptogether/releases) when ready.

The bundled launcher installs WSL2 ComfyUI, prompts for Hugging Face sign-in only when needed, and automatically downloads and verifies the pinned generation models after setup. Accept the model terms at the linked model pages first. Then choose **Start worker** to poll the channel and stream in the worker config and run ready jobs. The [test stream queue](https://www.clips.gg/sloptogether/channels/stale2000/streams/cartoon-demo/moderate) has ready jobs; use `stream_slug = "cartoon-demo"` to target them. WSL inference remains experimental pending RTX 4090 qualification.

## Planning documents

- [What's left, in priority order](.omx/plans/sloptogether-remaining-work.md)
- [Full completion and acceptance plan](.omx/plans/sloptogether-completion-plan.md)
- [Original product/implementation plan (historical)](.omx/plans/sloptogether-plan.md)
- [Confirmed product decisions](docs/product-decisions.md)
- [Remaining open questions](docs/open-questions.md)
- [Moderation, trust and continuous generation](docs/moderation-and-trust.md)
- [Unified worker and streamer control keys](docs/unified-worker-and-streamer-control.md)
- [Optional subscriber interrupt clips](docs/subscriber-interrupts.md)
- [Cheap H3 story and dialogue planning](docs/cheap-h3-story-planning.md)
- [Acceptance and qualification plan](.omx/plans/sloptogether-test-spec.md)
- [Existing worker code and verification](docs/worker-import.md)
- [Twitch-authenticated Cloudflare upload protocol](docs/worker-upload-protocol.md)
- [Paid H3 Max Turbo segments and Bits economics](docs/paid-turbo-segments.md)
- [Isolated clips.gg deployment audit](docs/clips-hosting-audit.md)
- [Independent plan review](docs/plan-review.md)
- [Follow-up review findings](docs/plan-review-followup.md)
- [Review of the four plan fixes](docs/plan-fix-review.md)
- [Current product-decision consistency review](docs/product-decisions-review.md)
- [Latest review and remaining product choices](docs/plan-review-remaining-decisions.md)

## Imported source

`vendor/comfystream/` contains the dependency-complete generation/upscale worker snapshot, licenses, provenance manifest and focused existing CPU checks. It does not contain model weights, source-repo secrets, the original OBS application or its hosted coordinator.

[`vendor/clipsgg/`](vendor/clipsgg/README.md) contains additional routing, auth-boundary and R2 reference code, with exact-source provenance. The SlopTogether app remains in its own repository. A narrowly scoped `/sloptogether` proxy is merged and deployed in the separate Clips.gg host repository.

## Current implementation

Current status and remaining work: [implementation audit](docs/implementation-audit-2026-10-24.md) and [completion plan](docs/completion-plan-2026-10-27.md). The product supports continuous streams as its target; the four-clip local fixture is only a smoke test, with no intended clip-count limit.

The isolated Next app, Twitch OAuth routes and Extension voting/Bits frontend, channel settings/moderation, upload tickets and Cloudflare R2 gateway, paired worker clients, Linux/Fal inference path, subscriber EventSub intake, browser OBS output, playback controls, and scoped worker/streamer keys are implemented in this repository. Native Windows inference remains unavailable; the WSL2 backend path requires Linux nodes/models and is not yet hardware-qualified. `apps/web/next.config.ts` mounts the app at `/sloptogether`.

The child app and host proxy are deployed at `https://www.clips.gg/sloptogether`. A production-gated `localdemo` fallback plays four static HLS clips on the output route for smoke testing; it does not seed a channel or replace database-backed streams. The live output page and HLS stream have been verified, including clip jumps, seeking and pause/resume. The production `stale2000` channel has eight committed spans. Its separate prompt/frame form is at `/sloptogether/channels/stale2000/participate`; the output page stays focused on playback. The Twitch Extension is in Hosted Test; a free prompt and ballot passed a live smoke test, but no worker job was created from that test. Subscription OAuth is connected, while subscriber interrupts remain disabled with a `$0` owner budget and no EventSub registration. Production upload-gateway operations were smoke-tested, but no fresh render has completed the full production upload, review and publish path. Continuous refill, role/moderation coverage, Bits approval, Windows signing and RTX 4090 qualification remain incomplete; see the [remaining-work plan](.omx/plans/sloptogether-remaining-work.md).

## Local smoke test

A seeded local channel is available at `http://localhost:3000/sloptogether/channels/localdemo/output`. It has four published H3 clips totaling approximately 60 seconds at 1280×720 with audio. Clip four was generated through Fal's marketplace H3 Max Turbo API from an extracted previous frame, manually normalized, then admitted through a local fixture and the worker upload/media-publish path. The browser starts from clip one or a saved marker. This verifies a finite playable fixture; actual custom Fal workers and continuous automatic refill remain unverified. Twitch OAuth and live marker writes are unavailable locally, no Twitch broadcast was started, and no Fal runner remains active. The local database and object store are temporary development state.

The local S3 emulator binds only to loopback and does not authenticate S3 signatures. Keep it on the local machine; never expose it through a tunnel or use it from remote Fal workers. Remote workers require the dedicated R2 bucket and scoped credentials described in [deployment requirements](docs/deployment.md).

On this Mac, restart Postgres in one terminal:

```sh
/opt/homebrew/opt/postgresql@17/bin/pg_ctl -D /tmp/sloptogether-pg -l /tmp/sloptogether-pg.log -o '-h 127.0.0.1 -p 56432' start
```

Start the loopback object store in a second terminal:

```sh
SLOPTOGETHER_LOCAL_S3_DATA=/tmp/sloptogether-minio-data SLOPTOGETHER_LOCAL_S3_PORT=9000 SLOPTOGETHER_LOCAL_S3_ALLOWED_ORIGIN=http://localhost:3000 node scripts/local-s3.mjs
```

Start the web app in a third terminal:

```sh
env VERCEL_OIDC_TOKEN= FAL_KEY= NEXT_PUBLIC_LOCAL_DEMO_ENABLED=true npm run dev
```

For an empty local database, create it and apply migrations `001` through `019` in order:

```sh
/opt/homebrew/opt/postgresql@17/bin/createdb -h 127.0.0.1 -p 56432 -U postgres sloptogether
for migration in db/migrations/*.sql; do
  psql -v ON_ERROR_STOP=1 -h 127.0.0.1 -p 56432 -U postgres -d sloptogether -f "$migration"
done
```

The demo seed creates the local test channel, main branch, first slot and playback row if absent, then writes a unique scoped worker key with mode `0600`. Use reserved local channel ID `900000002` (`localworker`) so the fixture does not collide with an existing `localdemo` channel:

```sh
set -a
. apps/web/.env.local
set +a
VERCEL_OIDC_TOKEN= FAL_KEY= SLOPTOGETHER_LOCAL_TEST_CHANNEL_ID=900000002 node scripts/seed-local-fal-demo.mjs
```

Upload the already generated clip through the same worker API, without starting inference, then run the media publisher in another terminal:

```sh
set -a
. /tmp/sloptogether-worker-900000002.env
set +a
python3.12 scripts/upload-local-fal-smoke.py /tmp/sloptogether-fal-test/sloptogether-fal-smoke.mp4
```

This claims and submits the existing Fal-generated MP4; it exercises the local worker API, upload, validation, approval and HLS publication path without running inference. After the publisher finishes, open `http://localhost:3000/sloptogether/channels/localworker/output` and press **Start program** to play the local HLS clip.

```sh
FAL_KEY= npm run media-worker:local
```

The seed expects an existing H3 MP4 and two PNG anchors under `/tmp/sloptogether-fal-test`; set `FAL_SMOKE_VIDEO`, `FAL_SMOKE_START_FRAME`, or `FAL_SMOKE_END_FRAME` when any fixture lives elsewhere. It reuses those files and never submits another generation job. Before writing, it checks the database name, Postgres backend address/port and data directory, plus the local S3 emulator marker. It rejects production mode, localhost tunnels to remote databases and non-project storage endpoints.

The Windows client uses the same job protocol through WSL2; use `workers/runtime/worker.wsl.example.toml` and the packaged executable. Native Windows inference remains disabled. Worker configuration and packaging tests pass on this host, but no Windows/RTX 4090 execution or signed installer has been verified.

To smoke-test the owner story producer on the local fixture without Twitch login or paid story generation, issue its local-only key and run one template-backed plan:

```sh
npm run local-story-worker-key
set -a
. /tmp/sloptogether-story-worker.env
set +a
env -u OPENAI_API_KEY PYTHONPATH=workers/runtime/src python3.12 -m sloptogether_worker --role story-producer run --once --headless
```

This creates one proposal on the synthetic `localdemo` channel, uses the free moderation preflight, and leaves any resulting render for normal review/worker processing. The key expires after eight hours and is restricted to the guarded local database.

See [deployment requirements](docs/deployment.md) for the isolated production setup and the remaining rollout steps.
