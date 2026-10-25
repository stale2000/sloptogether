# Moderation, worker trust and continuous generation

These are the user's selected product rules, prepared October 23, 2026. They replace the earlier blanket requirement for human review of every generated clip. The main implementation exists, but live Twitch authorization, custom Fal execution, and channel-level policy acceptance remain unverified; see the [remaining-work plan](../.omx/plans/sloptogether-remaining-work.md).

## Independent channel settings

| Setting | Supported choices | Authority |
|---|---|---|
| Contribution permission | Any Twitch-authenticated user who is not banned; broadcaster/moderator roles only; explicit contributor allowlist; or an explicitly configured combination | Broadcaster configures channel scope. Applies to proposals, GPU claims and uploads as separately enabled capabilities. |
| Reviewer permission | Broadcaster, verified Twitch moderators and explicit reviewer-whitelist Twitch IDs | Allows inspecting private candidates and approving/rejecting exact revisions. Does not automatically grant contribution or upload-approval bypass. |
| Upload approval bypass | Explicit trusted uploader Twitch IDs or selected broadcaster/moderator roles | Skips the human-review step only for that channel and configured capability. Ordinary contributors require human approval. Membership in the contributor/reviewer list alone does not grant bypass. |
| Trusted execution bindings | App-owner-managed fal/provider applications and explicitly registered operator worker credentials | Server-owned configuration ties the actual execution binding, recipe and request/attempt identity to a trusted result path. A caller cannot set this flag. |
| Streamer control | Verified channel broadcaster OAuth or explicitly granted streamer-control key | Authoritatively override channel votes/locks/future content, cancel/supersede jobs, review/hold and source playback. Changes use audited revisions/fences; ordinary trusted-worker grants do not silently include full control. |

The same worker program runs on Windows and Linux/fal. Ordinary contributors pair Twitch; headless owner/streamer deployments may configure a channel-issued key tied to the issuing Twitch identity instead of interactive login. Device/key credentials bind channel grants, capability and current authority. A signed installer, claimed username or client `trusted` flag is not authentication. Broadcaster/moderator authority is checked server-side; changed status affects subsequent privileged actions and role-based bypass.

Channel/platform bans override all contribution allowlists and upload bypasses. Recheck identity, role/policy revision, lease fence and ban state at claim, upload reservation, result admission and publication. Revoking trust prevents new automatic admission; previously public/broadcast bytes cannot be recalled by a policy edit.

## Prompt and image preflight

Use backend-held OpenAI credentials with `POST https://api.openai.com/v1/moderations` and `model: "omni-moderation-latest"` for a quick text/image check. OpenAI currently describes this endpoint as free. It accepts text and images; it does not classify complete video or audio. Rate limits still apply, and a classifier pass does not certify a generated clip safe or Twitch-compliant. Sources: [moderation guide](https://developers.openai.com/api/docs/guides/moderation), [request reference](https://developers.openai.com/api/reference/resources/moderations/methods/create).

Screen the **actual effective prompt and all actual input images** after normalization, including selected start/end frames and permitted references. Generated/rewritten prompts receive the same check before dispatch; do not rely on checking an earlier user sentence while submitting different text. A continuation render's newly resolved endpoint must pass the image gate before becoming a next-job input. A fixed already-cleared anchor can reuse its matching evidence.

Illustrative request shape, with a backend-minted private asset URL or permitted data URL:

```json
{
  "model": "omni-moderation-latest",
  "input": [
    {"type": "text", "text": "The exact final prompt submitted for generation"},
    {"type": "image_url", "image_url": {"url": "https://private-input-origin/short-lived-frame-url"}}
  ]
}
```

Bound input lengths, decoded image sizes, outstanding requests and per-user/channel rates. Use a canonical cache identity containing prompt bytes, normalized image digests, moderation model/effective returned version and application moderation-policy version. Record category results and applied input types; a category unsupported for images is not a proof of image safety. Never expose the API key or persist signed input URLs in public logs.

Outcomes are `CLEAR`, `HELD` or `PENDING`. Flagged inputs and API errors/timeouts/429 hold normal dispatch with bounded backoff. A streamer-control actor can explicitly resolve a permitted input hold through a scoped manual review against the exact digest; preserve the original automated result and separate reviewer/exception evidence instead of relabeling it a clean automated pass. Ordinary trusted workers cannot create that exception. Effective input clearance is required before new billable generation. Clean inputs need no human prompt approval to keep trusted workers running. Policy/model changes invalidate affected cache evidence for new dispatch; unrelated already-cleared work can continue rather than stopping the whole channel.

## Output admission matrix

All output paths require server-authenticated job identity, current input revision/lease, server-owned immutable bytes/digest, structural/media/continuity validation, valid input-screen evidence and publication-policy checks. The difference below is whether an additional human decision is required.

| Output producer | Human review before initial airing | Approval path |
|---|---|---|
| Ordinary eligible community worker/uploader | Required | `HUMAN_REVIEW` by an authorized broadcaster/moderator/reviewer |
| Explicitly bypass-whitelisted uploader, including selected broadcaster/moderator roles | Not required while that current channel policy applies | `TRUSTED_UPLOADER_POLICY` recorded against the exact artifact |
| App-owner fal/operator worker, authenticated through a configured trusted execution binding | Not required for a clean, valid result | `TRUSTED_EXECUTION_POLICY` recorded against the exact artifact |
| Any producer with unchecked/held inputs, invalid media, revoked authority or a known blocking flag | Cannot publish automatically | Pending/held/rejected until the relevant condition is resolved |

This permits trusted generation and upscale workers to drain eligible queues continuously without a moderator clicking approval for every clip. A clean input gate and valid trusted result can satisfy the channel's approval policy automatically. Automatic approval is a server decision with evidence; it is not a worker-supplied `approved=true` field.

For the initial test stream, two fal instances run the same worker program as Windows contributors, configured with channel-scoped trusted keys and separate generation/upscale roles. An optional test-story adapter/producer feeds future scenes through the common API, elected by one producer lease/epoch. A full streamer-control grant can be deliberately configured on the owner's program for authoritative replacement; the backend records these changes and fences stale work. Pull-worker attempts must not also be submitted through a provider dispatcher. Broader platform-operated automatic storytelling is not required for this test integration.

Trust belongs to the verified execution or uploader authority, not a fal CDN hostname, file metadata, browser role claim, submitted public URL or a donor's assertion that they ran the official executable. Trusted provider results are reconciled against the server-owned request ID, binding, input digest and expected output. A community upload does not become trusted by copying one of those identifiers.

Each new output stage gets its own admission decision. A public untrusted upscaler modifying an approved base clip still needs review unless its uploader is explicitly granted bypass. A trusted upscaler may automatically admit a valid output derived from approved inputs. Neither path inherits a blanket right to replace bytes, change canonical endpoints or publish a different hash under an existing approval.

Optional output classifiers/spot checks can add evidence or hold flagged media, but the selected trusted-worker path does not require comprehensive video moderation or human review on every clean result. Keep emergency hold/skip/remove controls and inspection history available for both automatic and human-approved media. Audio handling requires a separate policy because this preflight model does not analyze audio.

## Minimal versioned policy and evidence

- `channel_policy`: revision; enabled contribution modes/capabilities; contributor IDs; reviewer IDs; role-based review grants; upload-bypass IDs/roles; trust-policy version.
- `trusted_execution_binding`: server-owned binding ID, issuing Twitch/operator identity, authenticated worker/key identity, permitted channel/recipe scope and enabled/revoked state. Verified channel owners can issue channel-scoped worker/controller grants; ordinary moderators/workers cannot manufacture platform-wide or stronger authority.
- `input_screen`: immutable input digest, prompt/image digests, policy/model identity, request/result ID, category evidence, decision and timestamps.
- `artifact_approval`: exact artifact/digest and input-screen IDs, `approval_path`, current channel/trust-policy revision, reviewer ID for human review or trusted binding/uploader authority for automatic approval, decision and timestamps.
- `moderation_event`: actor/system authority, channel, target revision/digest, old/new decision, reason and dependency/publication effects. Preserve history; superseding content requires new evidence.

Example audit: a clean prompt/frame set receives input-screen evidence; owner fal attempt returns valid media; the backend records `TRUSTED_EXECUTION_POLICY` and publishes eligible contiguous media. Example donor audit: a paired nonbanned public worker returns valid media; it remains private until a permitted reviewer approves its exact digest. Adding that donor to a contributor list alone cannot change the second path into the first.

## Rejection and payment

Rejecting a clip reopens its available slot with a new selection/election revision, subject to shared-boundary and protected-buffer rules. The rejected artifact and stale attempts cannot reclaim it. A single paid generation authorization is consumed by its one billable attempt; rejection does not fund another render. Another contribution or vote can fill the reopened slot, and any new paid render needs new funding. Retrying upload/download or reconciling the same provider request does not create another billable render. Trusted continuous workers use separately budgeted channel/operator attempts rather than recycling a user's consumed payment.

## Planned acceptance cases

1. Public mode accepts paired nonbanned contributors; roles-only and contributor-allowlist modes reject unauthorized claims/uploads. Bans beat every allowlist/bypass.
2. Reviewer allowlist permits review without automatically permitting GPU claims or upload bypass. Moderator removal revokes role-based review/bypass on the next authority check.
3. A valid ordinary donor clip stays private until human approval. Explicit bypass for a streamer/moderator or uploader allows policy approval only after all other gates pass.
4. A trusted managed worker continuously generates/adopts clean valid clips without human clicks; spoofed binding/CDN/metadata cannot activate that path.
5. Prompt rewrites, changed frame bytes and newly resolved continuation images require matching screen evidence. Cache entries cannot cross input/model/policy identities.
6. A moderation timeout/429 holds new unchecked work and spends no generation funds; cleared unrelated work continues. Flagged inputs/results never become clear because of worker trust alone.
7. Public upscale of an approved base needs its own approval unless explicitly bypass-whitelisted; trusted upscale must preserve approved boundaries/content.
8. One paid attempt rejected by a reviewer leaves its payment consumed, reopens the slot and fences stale completion. A new render cannot reuse that payment, including on a trusted worker.
