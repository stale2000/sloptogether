# Media validation worker

This standalone Node worker consumes media validation/publication, staging cleanup, and (when `FAL_KEY` is configured) paid Turbo dispatch, polling, and cancellation events. Paid requests use one fenced Fal queue submission, private expiring CDN output and the same quarantine validator and human-review path; ambiguous submissions remain consumed and are never automatically resubmitted. Validation rereads only the immutable R2 object referenced by the database, verifies SHA-256, uses `ffprobe` to count decoded frames, checks H.264/AAC against the channel's dimensions and frame rate, enforces a 13–17 second duration window, then fully decodes audio/video with `ffmpeg`.

Valid outputs remain private in `validated` for human review unless an exact channel upload-bypass grant applies or an explicitly granted `artifact:system_approve` key returns through its own current, unrevoked execution binding at the current policy revision. Either approval is recorded against the exact digest and input-screen evidence. Approved base clips are transcoded to browser-compatible H.264/AAC MPEG-TS segments, uploaded under content-addressed R2 keys, then appended transactionally to `program_items`, `program_media_segments`, and `program_manifests`. Invalid media/packaging is rejected, its funding remains consumed, and the same prompt selection is not automatically regenerated. A stale fence, changed hash, banned uploader, or already-committed scene cannot overwrite the program. Transient database, R2, or runtime errors release the outbox lease with exponential backoff.

The worker publishes approved base clips into the HLS timeline. For continuation clips, it extracts the final JPEG frame and screens the exact prompt/frame before creating the endpoint boundary. Clear frames resolve automatically under the clip's approval path; held or unavailable moderation creates a streamer-review item and leaves the next placeholder open for a new start-frame proposal. The worker dispatches upscale jobs already created by the app; it does not create them or provision itself on a server. Live Twitch/DB/R2 runtime still needs deployment verification.

## Requirements

- Node.js 20.9 or newer, installed from the repository root lockfile.
- A dedicated SlopTogether `DATABASE_URL` with access to the `sloptogether` schema.
- Either R2 credentials limited to the SlopTogether media bucket (`R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET_NAME`) or gateway mode with `R2_BUCKET_NAME`, `SLOPTOGETHER_MEDIA_GATEWAY_URL=https://uploads.clips.gg/worker-media`, and the shared `SLOPTOGETHER_UPLOAD_TICKET_KEY`. Gateway tickets are short-lived, channel-prefix scoped and restricted to media validation, publication and staging cleanup; paid Turbo dispatch stays disabled in this mode. Gateway mode does not give this process R2 credentials.
- When the shared Clips.gg Postgres project is used, set `SLOPTOGETHER_USE_CLIPSGG_DATABASE=true` and provide the verified Supabase CA as `SLOPTOGETHER_DATABASE_SSL_CA`; the worker rejects unverified TLS.
- `ffprobe` and `ffmpeg` available on `PATH`, or executable paths in `FFPROBE_PATH` and `FFMPEG_PATH`.
- `SLOPTOGETHER_OPENAI_MODERATION_KEY` for free automated final-frame screening. When the key is missing or the API is unavailable, the clip can still publish but its endpoint waits for streamer review. This key is used only for moderation; keep paid story-generation `OPENAI_API_KEY` in the owner story worker.
- Database migrations `001` through `017` already applied.
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

The worker logs only outbox IDs, state, and error codes. It handles `SIGINT` and `SIGTERM`, holds outbox leases while validating, and retries infrastructure failures. Gateway mode claims only media validation/publication and cleanup events; it leaves paid Bits and Turbo events untouched. Run one or more supervised instances; database row locking and artifact/fence checks make duplicate delivery safe.

Run the metadata checks with:

```sh
node --test workers/media-publisher/tests/*.test.mjs
```
