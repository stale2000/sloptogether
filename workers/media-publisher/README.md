# Media validation worker

This standalone Node worker consumes media validation/publication, staging cleanup, and paid-receipt reconciliation events. The H3 Max Turbo code is retained but hard-disabled; the worker does not submit Turbo jobs to Fal. Validation rereads only the immutable R2 object referenced by the database, verifies SHA-256, uses `ffprobe` to count decoded frames, checks H.264/AAC against the channel's dimensions and frame rate, enforces a 13–17 second story duration window or a 9.5–10.5 second subscriber-alert window, then fully decodes audio/video with `ffmpeg`.

Valid outputs remain private in `validated` for human review unless an exact channel upload-bypass grant applies or an explicitly granted `artifact:system_approve` key returns through its own current, unrevoked execution binding at the current policy revision. Either approval is recorded against the exact digest and input-screen evidence. Approved base clips are transcoded to browser-compatible H.264/AAC MPEG-TS segments, uploaded under content-addressed R2 keys, then appended transactionally to `program_items`, `program_media_segments`, and `program_manifests`. Invalid media/packaging is rejected, its funding remains consumed, and the same prompt selection is not automatically regenerated. A stale fence, changed hash, banned uploader, or already-committed scene cannot overwrite the program. Transient database, R2, or runtime errors release the outbox lease with exponential backoff.

The worker publishes approved base clips into the HLS timeline. For continuation clips, it extracts the final JPEG frame and screens the exact prompt/frame before creating the endpoint boundary. Clear frames resolve automatically under the clip's approval path; held or unavailable moderation creates a streamer-review item and leaves the next placeholder open for a new start-frame proposal. The worker schedules eligible pre-air upscale dependencies through the database function; it does not run the GPU upscaler or provision a server.

## Requirements

- Node.js 20.9 or newer, installed from the repository root lockfile.
- A dedicated SlopTogether `DATABASE_URL` with access to the `sloptogether` schema.
- Either R2 credentials limited to the SlopTogether media bucket (`R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET_NAME`) or gateway mode with `R2_BUCKET_NAME`, `SLOPTOGETHER_MEDIA_GATEWAY_URL=https://uploads.clips.gg/worker-media`, and the scoped `SLOPTOGETHER_PUBLISHER_UPLOAD_TICKET_KEY` (the legacy `SLOPTOGETHER_UPLOAD_TICKET_KEY` is accepted as a fallback). Gateway tickets are short-lived, channel-prefix scoped and restricted to media validation, publication and staging cleanup; paid Turbo dispatch stays disabled in this mode. Gateway mode does not give this process R2 credentials.
- When the shared Clips.gg Postgres project is used, set `SLOPTOGETHER_USE_CLIPSGG_DATABASE=true` and provide the verified Supabase CA as `SLOPTOGETHER_DATABASE_SSL_CA`; the worker rejects unverified TLS.
- `ffprobe` and `ffmpeg` available on `PATH`, or executable paths in `FFPROBE_PATH` and `FFMPEG_PATH`.
- `SLOPTOGETHER_OPENAI_MODERATION_KEY` for free automated final-frame screening. When the key is missing or the API is unavailable, the clip can still publish but its endpoint waits for streamer review. This key is used only for moderation; keep paid story-generation `OPENAI_API_KEY` in the owner story worker.
- The repository schema migrations applied with the publisher role grants. The current production deployment uses migrations through `025`.
- For paid Turbo processing, `FAL_KEY`, `PUBLIC_APP_URL`, all four `SLOPTOGETHER_BITS_*` release gates, `SLOPTOGETHER_BITS_RECONCILE_URL` and the shared `SLOPTOGETHER_BITS_RECONCILE_SECRET`. The reconciliation URL must match the app origin and `/sloptogether/api/v1/internal/bits/reconcile` path. Keep all gates false until Twitch has approved the product and live Fal private-file behavior, billing, cancellation and R2 ingestion have passed acceptance.

Keep the four Bits gates synchronized with the web application. Store `FAL_KEY` only in this worker's secret environment; the web application and browser do not need the provider credential. The reconciliation URL targets the web app's internal `/api/v1/internal/bits/reconcile` endpoint; use HTTPS in production. The shared reconciliation secret belongs only in the web server and this supervised worker, never in the Extension.

Optional environment:

| Name | Default | Meaning |
|---|---:|---|
| `MEDIA_VALIDATOR_POLL_MS` | `1500` | Idle polling delay, bounded to 100–60000 ms. |
| `MEDIA_VALIDATOR_MAX_BYTES` | `134217728` | Maximum artifact size; cannot exceed the upload protocol's 128 MiB cap. |
| `MEDIA_VALIDATOR_MIN_SECONDS` | `13` | Minimum accepted clip duration. |
| `MEDIA_VALIDATOR_MAX_SECONDS` | `17` | Maximum accepted clip duration. |

Run from the repository root:

```sh
npm run media-worker
```

For a local checkout with `workers/media-publisher/.env.local`, start it with `npm run media-worker:local`. That file is ignored by Git and should remain restricted to the worker; the local launcher loads its values into the worker process. Production should continue to inject secrets through the hosting platform and use `npm run media-worker`.

On a logged-in macOS host, `workers/media-publisher/scripts/publisher-launchd.sh install` installs a per-user LaunchAgent that starts the publisher at login and restarts it after a failure. It uses the current checkout's ignored `.env.production.local` by default and requires that file to be owned by the user and inaccessible to group/other users. `status` checks the LaunchAgent; `uninstall` removes the agent but keeps the env file and logs. The service embeds the current checkout path, so uninstall or reinstall it before moving or removing that checkout. This supervises the local process; it does not make the Mac an off-site, always-available host.

## Linux service and monitoring

For a persistent Linux CPU host with systemd, install Node 20.9+, Python 3,
FFmpeg, and the repository's locked Node dependencies. Use a dedicated ordinary
user and a private environment file owned by that user (mode `0600`), preferably
outside the checkout. Set the same database, gateway and moderation values as
the current publisher; do not put secrets in the unit file or Git.

```sh
export SLOPTOGETHER_PUBLISHER_ENV_FILE="$HOME/.config/sloptogether/publisher.env"
workers/media-publisher/scripts/publisher-systemd.sh install
workers/media-publisher/scripts/publisher-systemd.sh status
workers/media-publisher/scripts/publisher-systemd.sh health
```

The installer installs a per-user service under the user systemd configuration,
starts it and enables automatic restarts. To keep the user manager running after
logout and start it on reboot, the host administrator must enable lingering for
that dedicated user (`loginctl enable-linger <user>`). Use
`journalctl --user -u sloptogether-media-publisher.service` for service logs;
configure journald retention and an external alert receiver appropriate to the
host. The service's Node process loads the private file directly, so systemd's
unit environment does not contain the file's secrets. It verifies the file is a
regular file owned by the service user with no group/other access at every start.
It is tied to the current checkout and absolute Node path: reinstall after moving
or upgrading either. `uninstall` stops and removes the unit but leaves credentials
and logs in place. It does not change the existing macOS LaunchAgent.

Run `health` periodically from an external monitor as the same service user.
It first requires the systemd unit to be active, then checks FFmpeg/ffprobe and
performs a read-only, timeout-bounded query of only the event kinds the
configured publisher consumes. Its JSON reports due and leased counts, the age
of the oldest due item, and items at or above the retry threshold. Future
scheduled work does not count as a due backlog; items with repeated failures
still alert while waiting for backoff. Default thresholds are 900 seconds and
5 attempts, configurable with `MEDIA_PUBLISHER_MAX_QUEUE_AGE_SECONDS` (1–86400)
and `MEDIA_PUBLISHER_MAX_ATTEMPTS` (1–1000). A healthy check exits 0, backlog
exits 1 and a configuration, media-tool or database failure exits 2. An inactive
unit also exits nonzero. Connect these exit statuses to a monitor or alert; the
service does not send notifications by itself. A running unit/healthy queue is
not proof of end-to-end playback, and an active long-running job can temporarily
exceed the age threshold.

The worker logs only outbox IDs, state, and error codes. It handles `SIGINT` and `SIGTERM`, holds outbox leases while validating, and retries infrastructure failures. Gateway mode claims only media validation/publication and cleanup events; it leaves paid Bits and Turbo events untouched. Run one or more supervised instances; database row locking and artifact/fence checks make duplicate delivery safe.

Run the metadata checks with:

```sh
node --test workers/media-publisher/tests/*.test.mjs
```

To exercise the health query against PostgreSQL, first start the dedicated local
demo cluster and then run:

```sh
workers/media-publisher/scripts/test-health-local.sh
```

The script checks the loopback server identity, creates a randomly named
scratch database with a per-run marker, runs the test, and removes that database
on exit after checking the identity and marker again. It does not connect to the
production database. If the local server becomes unavailable or its identity or
marker changes, cleanup fails closed and reports the scratch database was left
untouched for inspection.
