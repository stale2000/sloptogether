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
`SLOPTOGETHER_UPLOAD_TICKET_KEY`. Optional `PUBLISHER_UPLOAD_TICKET_KEY` is
dedicated to the media publisher; when configured, publisher tickets no longer
accept the web/worker ticket key. Keep `APP_ORIGIN` pointed at the stable
`https://sloptogether.vercel.app` project domain for internal authorization
calls: the Clips.gg mount proxy intentionally strips unknown `x-*` headers, so
using `https://www.clips.gg` drops `x-upload-gateway-secret`. The production
app's `SLOPTOGETHER_UPLOAD_WORKER_ORIGIN` points at this gateway. Do not bind
ClipsGG's existing media bucket.
