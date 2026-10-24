# SlopTogether upload gateway

This Cloudflare Worker terminates bounded browser and contributor uploads. It
accepts only app-signed object tickets, rechecks the active reservation with
the SlopTogether API, streams at most the reservation's byte limit into the
private R2 bucket, and uses an atomic create-only write so a ticket cannot
replace an already-uploaded object.

The `sloptogether-upload-gateway` Worker is deployed and bound only to the
private `sloptogether-media` bucket. Its custom domain is
`https://uploads.clips.gg`; Cloudflare manages the DNS record and TLS
certificate. The `workers.dev` address is disabled.

The Worker secrets `UPLOAD_GATEWAY_SECRET` and `UPLOAD_TICKET_KEY` match the
production app's `SLOPTOGETHER_UPLOAD_GATEWAY_SECRET` and
`SLOPTOGETHER_UPLOAD_TICKET_KEY`. The production app's
`SLOPTOGETHER_UPLOAD_WORKER_ORIGIN` now points to this domain; a Vercel
production deployment is required for that environment change to take effect.
Do not bind ClipsGG's existing media bucket.
