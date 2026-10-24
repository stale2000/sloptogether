# SlopTogether upload gateway

This Cloudflare Worker terminates bounded browser and contributor uploads. It
accepts only app-signed object tickets, rechecks the active reservation with
the SlopTogether API, streams at most the reservation's byte limit into the
private R2 bucket, and uses an atomic create-only write so a ticket cannot
replace an already-uploaded object.

Bind the dedicated `sloptogether-media` bucket. Configure `UPLOAD_GATEWAY_SECRET`
and `UPLOAD_TICKET_KEY` as Worker secrets; they must match the app's
`SLOPTOGETHER_UPLOAD_GATEWAY_SECRET` and `SLOPTOGETHER_UPLOAD_TICKET_KEY`.
Set the app's `SLOPTOGETHER_UPLOAD_WORKER_ORIGIN` to this Worker URL.

Deploying this Worker, configuring R2 and setting those production secrets are
separate operator actions. Do not bind ClipsGG's existing media bucket.
