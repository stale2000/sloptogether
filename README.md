# SlopTogether

Collaborative Twitch video generation: viewers vote through a Twitch Extension or chat, the shared worker runtime renders/upscales on Linux/Fal, and the streamer captures a 16:9 browser window in ordinary OBS. A Windows client can use the Linux nodes through WSL2; that inference path remains experimental pending RTX 4090 qualification. Configurable channel keys enable trusted workers and full streamer overrides; no OBS plugin or site-to-Twitch broadcaster is required.

Public URL: **https://www.clips.gg/sloptogether** (the apex domain redirects to `www`).

## Planning documents

- [Detailed implementation plan](.omx/plans/sloptogether-plan.md)
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

Current status and remaining work: [implementation audit](docs/implementation-audit-2026-10-24.md) and [completion plan](.omx/plans/sloptogether-completion-plan.md). The product supports continuous streams as its target; the four-clip local fixture is only a smoke test, with no intended clip-count limit.

The isolated Next app, Twitch OAuth routes and Extension voting/Bits frontend, channel settings/moderation, upload tickets and Cloudflare R2 gateway, paired worker clients, Linux/Fal inference path, subscriber EventSub intake, browser OBS output, playback controls, and scoped worker/streamer keys are implemented in this repository. Native Windows inference remains unavailable; the WSL2 backend path requires separately installed Linux nodes/models and is not yet hardware-qualified or packaged as a signed installer. `apps/web/next.config.ts` mounts the app at `/sloptogether`.

The child app and host proxy are deployed at `https://www.clips.gg/sloptogether`. A gated `localdemo` fallback plays the four generated HLS clips on the output route for smoke testing; it does not seed a channel or replace the database-backed stream. The production channel list is empty. Real channel playback is not production-ready until Twitch settings, a private R2 bucket/gateway, and supervised media/story workers are configured. Migrations `001`–`019` use the existing Clips.gg project through a private `sloptogether` schema and scoped runtime role. The Vercel child connects to the Supabase IPv4 transaction pooler using verified CA TLS. `workers/media-publisher` validates uploads, applies configured trust/review policy, appends approved base clips to HLS, and screens continuation endpoints so the owner story producer can advance the chain. Twitch/OAuth/EventSub playback, remote media publication, and marker updates are not yet qualified. The Bits-to-Fal Turbo queue remains gated off pending Twitch approval and live Fal/R2/DB acceptance. A signed Windows release is not available. Do not advertise the worker as qualified for RTX 4090 until measured generation and upscale profiles are available.

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
env -u FAL_KEY npm run dev
```

For an empty local database, create it and apply migrations `001` through `019` in order:

```sh
/opt/homebrew/opt/postgresql@17/bin/createdb -h 127.0.0.1 -p 56432 -U postgres sloptogether
for migration in db/migrations/*.sql; do
  psql -v ON_ERROR_STOP=1 -h 127.0.0.1 -p 56432 -U postgres -d sloptogether -f "$migration"
done
```

The demo seed creates the local channel, main branch, first slot and playback row if absent, then writes a scoped local worker key to `/tmp/sloptogether-worker.env`:

```sh
set -a
. apps/web/.env.local
set +a
node scripts/seed-local-fal-demo.mjs
```

Upload the already generated clip through the same worker API, without starting inference, then run the media publisher in another terminal:

```sh
set -a
. apps/web/.env.local
. workers/media-publisher/.env.local
. /tmp/sloptogether-worker.env
set +a
python3.12 scripts/upload-local-fal-smoke.py
```

```sh
set -a
. apps/web/.env.local
. workers/media-publisher/.env.local
set +a
npm run media-worker
```

The seed expects an existing H3 MP4 and two PNG anchors under `/tmp/sloptogether-fal-test`; set `FAL_SMOKE_VIDEO`, `FAL_SMOKE_START_FRAME`, or `FAL_SMOKE_END_FRAME` when any fixture lives elsewhere. It reuses those files and never submits another generation job. Before writing, it checks the database name, Postgres backend address/port and data directory, plus the local S3 emulator marker. It rejects production mode, localhost tunnels to remote databases and non-project storage endpoints.

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
