# Twitch identity to GPU lease to Cloudflare upload

Proposed application protocol. Public API prefix: `https://clips.gg/sloptogether/api/v1`. Twitch authenticates the person; SlopTogether issues the narrowly scoped device/job credentials. Cloudflare does not accept a Twitch OAuth token as permission to write to our bucket.

## Credentials and lifecycle

| Credential | Purpose | Suggested lifetime / storage |
|---|---|---|
| Twitch OAuth grant | Verify identity and selected channel capabilities on our backend | Server-encrypted refresh token; validate at start/hourly and on API failures |
| Website session | User dashboard and pairing approval | Secure HttpOnly unique path cookie; server revocable |
| Pairing challenge | Bind a local worker installation to the logged-in Twitch user | 10 minutes, one use; unguessable poll secret, short displayed code with rate limits |
| Device refresh credential | Obtain worker access tokens after explicit pairing | OS credential store; rotating, revocable; proposed 30-day idle expiry |
| Owner-issued worker key | Headless Linux/fal use of the same worker program, with selected stage/trusted/future-authoring grants | Server records secure verifier and issuing Twitch/channel identity; secret in deployment/OS credential storage; rotate/revoke |
| Streamer-control key/session | Full authoritative editing/override for that broadcaster's channel | Verified streamer OAuth or explicitly scoped application key; separate from Twitch ingest/OBS keys; every mutation is audited |
| Worker access token | Claim/heartbeat only permitted job types/channels | Proposed 10 minutes; device/user/channel restrictions rechecked at sensitive actions |
| Job lease/fence | Authorization for one attempt on current immutable inputs | Renewable 90-second expiry with 30-second heartbeats, capped by server-owned absolute attempt deadline; expires/revokes independently of device auth |
| Upload ticket/URL | Write one attempt's temporary object | At most 5 minutes, capped by remaining authorized lease/upload-phase time and absolute attempt deadline; refresh cannot extend either |
| Input download URL | Read the specific allowed source/frame | Mint on demand; no bucket listing or arbitrary object access |

OAuth revocation, account/device ban, channel allowlist removal and lease cancellation prevent new URLs and result admission immediately at our backend. An already issued bare storage URL remains usable until expiry; this is why uploads remain private and validation snapshots are server-owned.

The shared Windows/Linux worker authenticates by ordinary Twitch-paired device credentials or an explicitly issued channel worker/streamer key. Headless fal instances do not perform interactive Twitch login at each boot; their key is linked to its issuing Twitch/channel authority. Apply the authenticated grant at claim/upload/admission and recheck revocation. Ordinary workers follow contribution rules; explicit trusted keys can write permitted future content/use system approval, while full streamer-control grants can authoritatively supersede channel choices. None of these modes changes object/lease/snapshot validation. Clients cannot request trust by setting upload metadata or naming a fal URL. See [unified worker and streamer control](unified-worker-and-streamer-control.md).

Worker lifetime/claim bounds follow the main plan's §8: each enabled recipe defines maximum total attempt time including transfer; upload grace is at most 120 seconds inside that total; no public claim is admitted without a qualified bound. At most two active attempts per Twitch account across all devices/two per account-channel, one per worker slot. An independent server expiry task fences a nonproductive attempt even if heartbeats continue, releases its claim slot and permits an eligible replacement. Old tickets cannot admit results after that fence, including when their underlying R2 URL has not expired. Repeated nonproductive attempts trigger cooldown/trust review. These donor replacement rules do not authorize duplicate managed-provider submits when provider acceptance is uncertain.

## API sequence

```mermaid
sequenceDiagram
  participant W as Local executable
  participant U as Browser with Twitch sign-in
  participant A as SlopTogether API
  participant R as Cloudflare private upload origin
  participant V as Trusted validator
  W->>A: POST /worker-pairings (device public key)
  A-->>W: pairing URL, short code, secret poll token
  U->>A: approve named device and channel/stage permissions
  W->>A: exchange approved pairing secret
  A-->>W: revocable device credential
  W->>A: POST /worker-leases (capabilities or eligible job ID)
  A-->>W: immutable job inputs, attempt ID, fence
  W->>A: heartbeat lease during generation
  W->>A: POST /worker-leases/{id}/uploads (output metadata)
  A-->>W: attempt-specific ticket, upload URL, required headers, expiry
  W->>R: upload generated MP4
  W->>A: POST /uploads/{id}/complete (lease fence, receipt)
  A->>R: observe exact bytes/object; snapshot privately
  A->>V: validate immutable snapshot, recompute digest
  V->>A: validated artifact and evidence
  Note over A,V: Human or trusted policy approval and publication are later steps
```

Representative upload reservation response (all URLs opaque and temporary):

```json
{
  "upload_id": "uuid",
  "attempt_id": "uuid",
  "lease_fence": 7,
  "method": "PUT",
  "upload_url": "https://<private-upload-origin>/<attempt-specific-object>?<signature>",
  "required_headers": {"Content-Type": "video/mp4"},
  "max_bytes": 134217728,
  "expires_at": "server-time",
  "complete_path": "/sloptogether/api/v1/uploads/<uuid>/complete"
}
```

The response's `max_bytes` is policy, not proof a bare R2 URL enforces it. Enforce as described below. User-supplied digest/file metadata are declarations; server-generated validation evidence is the authority.

## Storage choice

**Recommended:** R2 for canonical frames, base clips, upscale intermediates, validated media and versioned HLS artifacts. A restricted Cloudflare Worker can provide the public donor upload URL; internal allowlisted workers can initially use short-lived R2 S3 `PUT` presigns. No client receives our R2 API key or bucket credentials.

- R2 presigns authorize an operation on a specific object until expiry; they are bearer capabilities, not inherently one-use URLs. Sign the expected content type, use unique untrusted `incoming/<channel>/<job>/<attempt>/<random>` objects, and never presign an accepted/published key. R2 S3 presigns use the Cloudflare S3 endpoint, not an assumed custom CDN domain. [R2 documentation](https://developers.cloudflare.com/r2/api/s3/presigned-urls/).
- For **public volunteers**, use a Cloudflare Worker upload gateway with server-verified capability and atomic ticket state (for example a Durable Object), strict streamed byte/time caps, allowed type, active-lease check and one-use finalization. This enforces limits before retaining an arbitrary-size upload; post-upload cleanup alone does not prevent storage abuse. Keep the gateway isolated from the main website's request bodies/compute.
- If gateway buffering/request limits are unsuitable for a qualified output size, use server-controlled multipart/resumable upload sessions with narrowly authorized parts, aggregate quota/expiry checks and abandoned-upload cleanup. Do not grant a general S3 session merely to simplify upload code.
- **Optional Cloudflare Stream** can issue genuinely one-time direct creator upload URLs, with `maxDurationSeconds`, and tus for resumability. It is useful for independently hosted playback assets; it does not replace our original source-byte preservation, GPU-input hash checks or timeline scheduler. Decide its added transcode/serving costs before adoption. [Stream direct uploads](https://developers.cloudflare.com/stream/uploading-videos/direct-creator-uploads/).

## Completion and overwrite protection

`/uploads/{id}/complete` requires the correct authenticated user/device, channel, current job revision, active attempt/fence and server time before its absolute deadline. Reject stale leases, wrong objects, reused upload IDs, forbidden roles and banned contributors. A client cannot nominate a different URL/key for the server to fetch or use a valid device token to extend an expired attempt.

Check actual stored length/type and require a successful isolated decode. Before media review, copy/read the observed bytes into a server-only immutable staging object/file with a server-computed SHA-256. Use an exact object/ETag conditional read where supported and verify the received snapshot; do not validate a mutable key and later publish whatever happens to be at that key. An R2 ETag is not our semantic SHA-256, especially for multipart uploads.

Only the trusted snapshot's digest may complete a job, enter moderation or feed the upscaler. A continued overwrite through an unexpired upload URL cannot replace that snapshot. Finalization and job result acceptance are idempotent; only one current result can win. Stale/abandoned objects are deleted by lifecycle tasks and never become public through a predictable URL.

Apply rate and aggregate quotas to user/device/channel, outstanding reservations, attempts and total bytes. Avoid logging upload signatures and input download URLs. CORS is browser behavior, not identity or protection against a custom malicious native client. Validate every claimed artifact independently of claimed executable signatures.

## Initial defaults to qualify

Video output cap 128MiB and image cap 16MiB are conservative starting proposals; narrow by recipe once measurements exist. Claim upload authority only after finishing the render; keep lease heartbeats while uploading. Use exponential retry for transient transfers, retain resumable state if supported, and refresh expired links only while the same attempt is valid. Network loss should not force an expensive rerender while a verified local output can still be uploaded for the active attempt.
