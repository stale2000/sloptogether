# Unified worker and streamer control

Confirmed direction, October 23, 2026: the owner's Linux/fal workers and public Windows contributors run the **same SlopTogether worker program and job protocol**. Platform-specific packages contain the appropriate runtime/kernel dependencies; a Windows executable is not itself a Linux binary. This document replaces the earlier assumption that a separate owner process must orchestrate calls to two special fal inference endpoints.

## One program, configurable roles

- `generation`: claim eligible base-video jobs, run the pinned TrimH3 nodes locally on the assigned GPU, upload the result and complete the attempt.
- `upscale`: claim jobs referencing an accepted base-artifact digest, run the pinned upscale nodes locally, upload and complete independently.
- `auto`: select among explicitly enabled compatible stages, unloading models between roles on one GPU; one active inference job per GPU slot.
- Optional `story-producer`: adapt the owner's existing test story generator to create future scene proposals through the same API. This can be a mode/module of the program without loading video models in that producer process.

Initial fal topology is two deployments running this program: one generation worker and one upscale worker. Windows users select the same roles in their UI/CLI. Both use the site's leases, immutable inputs, recipe IDs, uploads and result-admission contract. The paid marketplace H3 Max Turbo adapter remains a distinct provider API integration; it does not become a second dispatcher for these pull-worker jobs.

The backend marks jobs with one execution mode, such as `pull_worker` or `provider_queue`. A pull-worker attempt cannot also be submitted by the hosted provider dispatcher. A stage is advanced only after its exact dependency artifact/resolution is accepted.

## Authentication and key grants

Ordinary contributors connect Twitch through browser pairing; the resulting device identity is bound to their Twitch account and channel permissions. Trusted headless Linux/fal workers can instead load an issued worker key tied to the issuing Twitch broadcaster/operator and channel. They do not need an interactive Twitch login on every container boot.

| Grant | Typical credential | Allowed authority |
|---|---|---|
| `worker` | Paired contributor device | Claim permitted roles and upload for its own current attempts under channel contribution/review rules. |
| `trusted_worker` | Explicitly issued channel worker key | Selected worker roles, optional `timeline:write_future`, and system-approval eligibility for that authenticated producer. Ordinary voter/contributor restrictions do not silently become full editorial control. |
| `streamer_control` | Verified broadcaster OAuth session or explicitly issued streamer key | Full editorial control for the issuing channel, including the override actions below. The owner may deliberately grant this key to their worker process. |

These are server-validated grants, not a client-selected `trusted=true` or `override=true` flag. Permissions may be narrowed by stage, recipe, channel and operation. A streamer key is a SlopTogether application credential, distinct from a Twitch ingest/OBS stream key.

Key metadata includes `key_id`, display name, issuing Twitch ID, `channel_id`, grant/scopes, allowed worker roles/recipes, key-policy revision, creation/expiry/revocation timestamps and last-used time. Store only a secure verifier/hash of a high-entropy random secret, plus a lookup identifier; show the raw secret once when issued. Every privileged request checks the active key/grant and current issuer/channel authority. Browser logout need not stop an explicitly provisioned headless worker; explicit key or integration revocation does.

Configure secrets through fal secret/environment configuration, an access-controlled key file or an OS credential store. A nonsecret program setting can select the credential source. Keep raw keys out of command-line arguments, URLs, public configuration, workflow files, model metadata and logs. Rotation/revocation invalidates new sessions/mutations, including short-lived tokens derived from the revoked key; record which running workers used it.

## Implemented API boundary

All routes are under `/sloptogether/api/v1`. The table below names the current route entry points; Twitch live behavior, production database/storage integration and provider qualification remain separate release gates.

| Operation | Contract and checks |
|---|---|
| `POST /channels/{channel}/worker-keys`, `GET /channels/{channel}/worker-keys`, `POST /channels/{channel}/worker-keys/{key_id}/revoke` | Broadcaster/controller issues and lists scoped keys; the secret is returned once. Rotation is issue-new-then-revoke-old. Ordinary workers cannot mint stronger grants. |
| `POST /workers/pairings`, `POST /workers/pairings/{id}/approve`, `POST /workers/pairings/{id}/poll`, `POST /workers/sessions/exchange` | Create and approve a Twitch-linked device pairing, then exchange the pairing credential or configured worker key for the worker session used by the current API. |
| `POST /workers/leases` and `POST /workers/leases/{id}/heartbeat` | Claim compatible work and renew its authorized attempt, with server-owned attempt/fence/deadline and current channel policy checks. |
| `POST /workers/leases/{id}/uploads`, `POST /workers/uploads/{upload_id}/complete`, `GET /workers/leases/{id}/asset/{asset_id}` | Issue scoped upload/read authority and admit exact server-snapshotted bytes for the current attempt; trust changes only the human-approval path. |
| `POST /channels/{channel}/story-producer/leases`, `POST /channels/{channel}/story-proposals` | Claim the channel's owner story-producer lease and submit a future proposal through the current worker API. |
| `POST /channels/{channel}/timeline/overrides` | Require streamer-control scope and an audited reason; the service applies the authoritative override and fences affected work. The current UI/API does not yet implement every broader override operation described below. |
| `POST /workers/leases/{id}/provider-request`, `POST /workers/leases/{id}/fail` | Record the provider request identity or report a failed current lease for reconciliation. |

## Streamer override semantics

Streamer OAuth or a full-control key can set/replace future prompts and frames, choose a candidate, close or override a vote, lock/unlock a future slot, cancel pending work, replace future selected content, approve/hold/reject a candidate, change channel trust settings, unban/revoke channel grants, and control the elected browser's playback/seek. These actions take precedence over ordinary contributions and automatic future-story production.

Apply an override in one durable command:

1. Authenticate the controller's channel authority and compare the expected timeline revision. Persist its command identity, target, reason and intended effects.
2. Create new immutable requested-input/selection revisions where needed. Fence affected job attempts, endpoint resolutions and producer leases; preserve unrelated work and previous observations.
3. Reconcile/cancel already-submitted provider work using its exact identity. Late results cannot overwrite the controller's choice, even if remote cancellation fails or cost has already occurred.
4. Regenerate valid incoming/outgoing joins when replacing future anchors, or explicitly mark an intentional cut/seek with a playback event and manifest discontinuity. Already broadcast history remains an immutable observation.
5. Revalidate/fund any new render, obtain the appropriate artifact approval, and commit the new eligible publication mapping. Record actor/key ID, before/after revisions, scope used and affected attempts.

A manual override holds its affected range against normal automatic producer writes. The producer must reread current state and resume only in an allowed interval or after the controller releases that hold; its old lease cannot immediately restore the overwritten scene. An intentional subsequent force action requires controller scope and another explicit audited command.

Normal prompt/image preflight and structural/media checks remain part of the workflow. If channel policy permits the controller to release a false-positive input hold, require an explicit scoped exception against the exact input digest with reason and policy revision. Preserve the classifier's original result and the separate human exception; do not silently relabel flagged inputs as a clean automated pass. Worker trust alone never creates this exception. Platform-required restrictions and valid media/auth boundaries remain server-enforced.

Full editorial control is channel authority: a key cannot acquire another broadcaster's channel, erase transaction/audit history or retroactively change what viewers already received. Each new billable render has fresh owner/channel funding; overriding or rejecting a paid candidate cannot reset its viewer transaction's consumed allowance. Never-dispatched paid work uses the existing explicit reconciliation/remedy path.

## Continuous owner story flow

The optional story adapter first acquires the channel's producer lease, then submits future scenes with expected revisions and an idempotency key derived from producer identity/sequence. Both fal workers may be running, but they do not independently append duplicate stories. Configure one instance as the producer, or run a lightweight producer mode of the same program; inference workers simply drain their authorized stage queues.

Flow: story proposal -> exact prompt/image preflight -> accepted future revision -> generation worker claim/render/upload -> trusted base admission and endpoint resolution -> upscale worker claim/render/upload -> trusted final admission/conformance -> 16:9 browser output. Public donor uploads follow their own approval policy through the same contract. Streamer override can take control at every editorial step using the transition rules above.

A lost producer/worker lease fences stale writes/results. Restart restores the current server cursor/sequence and outstanding attempt identities before creating more work. Provider uncertainty is reconciled rather than duplicated. Public-site operation remains independent of whether this owner test process is running.

## fal process lifecycle and budget

Qualify the Linux container as a supervised pull-worker host using the same application entrypoint and pinned inference recipe. Starting an owner session must explicitly establish the provider lifetime/warm-capacity configuration needed for the loop, health reporting, role/GPU assignment and spend cap. A background polling loop by itself does not prove that a serverless runner remains available or unbilled.

Distinguish stop claiming, finish-and-stop, terminate worker process and provider scale-down. Confirm provider state after shutdown; neither an idle queue nor a stopped child process proves the GPU is no longer billed. Keep fal management credentials with the owning deployment/operator, separate from the SlopTogether key used to update channel content. Record actual runtime/billing evidence during Linux/fal qualification.

Windows and Linux builds share protocol/source but have separate runtime, kernel, installer/container and hardware qualification. The existing Windows4090 memory target and both stage choices remain required; a Linux cloud success does not establish them.

## Planned acceptance cases

1. Windows Twitch-paired and Linux key-authenticated instances run the same job contract and can independently perform generation/upscale; pull/provider dispatch cannot execute the same attempt twice.
2. Ordinary worker cannot self-upgrade, create keys or override a vote. A scoped trusted key can update permitted future content; a full streamer key or verified broadcaster session can execute the complete channel override set.
3. Wrong-channel, expired, rotated or revoked key/derived session fails; key rotation supports deliberate worker migration and attribution without putting secrets into public logs or image layers.
4. Two story-producer instances race: one current producer fence wins, repeated sequence submissions are idempotent, and a stale process cannot append after takeover or override.
5. Controller changes a voted/locked future slot while generation/upload is in flight: affected work is fenced, old result cannot reoccupy the slot, joins are valid or explicitly discontinuous, and normal automatic writes respect the manual hold.
6. Trusted clean results receive system approval; public uploads retain their configured review requirement. Explicit held-input exception preserves original classifier evidence; a worker trust flag cannot manufacture it.
7. Override/cancellation/rejection never makes an already consumed viewer payment reusable; genuinely new owner work obtains a separate reservation and uncertain provider acceptance remains reconciled.
8. Stopping/restarting the owner process preserves site/history and bounded recovery; Linux/fal qualification proves warm lifetime, budget enforcement and provider shutdown separately from process health. OBS continues to capture the browser with no plugin or website broadcaster.
