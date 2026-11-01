# Optional H3 Max Turbo lane and Bits prompt queue

The Bits queue product is a fixed Extension SKU for one viewer-authored prompt entry. The prompt is screened before purchase; a verified transaction makes the proposal eligible for the ordinary community vote. Bits buys queue entry only. It does not guarantee that the prompt wins or gets generated. The extension displays the catalog's exact Bits amount and never calls the action a donation.

This model follows the app-defined queue experience demonstrated by Twitch's official Bits examples: Queue+ lets viewers join and move in a queue using Bits and includes customizable fields; BitPoll lets viewers create a poll with Bits; View Message Alert accepts viewer messages. Those examples show that user text can be part of a fixed Bits-enabled interaction. They do not constitute blanket approval for every prompt or AI-generation product. The implementation therefore keeps the purchasable action fixed (one queue entry), validates and screens user text, binds the transaction to one immutable proposal, and leaves selection to the normal vote. Sources: [Twitch Extension policy](https://dev.twitch.tv/docs/extensions/guidelines-and-policies/), [Twitch's Bits-enabled Extensions](https://dev.twitch.tv/extensions/bits-extensions-to-try/).

Twitch policy §6.2.8 still restricts Bits exchanges for experiences defined by a user rather than by the Extension; the queue, product, amount, and resulting vote are defined by SlopTogether, while the prompt is screened user content. Keep the ordinary Twitch review step for this exact UX. Do not describe Bits as a donation, support payment, or dollar amount. The product is denominated in the fixed Bits count from Twitch's catalog; viewer retail pricing varies by Twitch's purchase flow.

The paid queue path is implemented in the workspace but remains disabled until the fixed SKU, Bits monetization, verified transaction EventSub, and operator gates are configured. As checked October 31, 2026, Extension 0.0.1 is still Local Test on the stale2000 account; Local/Hosted Test Bits transactions do not spend real viewer Bits. H3 Max Turbo remains a separate provider-paid action and stays disabled outside automated tests.

## Model and adapter

The requested model matches fal's **H3 Max Turbo**, with exact endpoint `minimax/h3-max-turbo/image-to-video`. The live schema supports `image_url`, `end_image_url`, `prompt`, seed, resolution and requested duration up to 15 seconds. It notes that delivered video may exceed requested duration by about 0.7 seconds. Save actual media timestamps and apply the timeline's chosen conformance policy. Schema and pricing responses are archived in `research/sloptogether-architecture/fal-h3-max-turbo-{schema,pricing}.json`.

Use a separate `fal_marketplace_h3_turbo` adapter, alongside private custom fal workers and volunteer nodes. This is provider-billed per request; it does not use donor GPU leases or require loading the local SoL model. Expose supported resolution profiles as application-defined choices; the cheap default is explicitly **480P**, because the API default is 768P. Set prompt expansion to `disabled` for exact reviewed prompt identity initially, keep `enable_safety_checker=true`, `sync_mode=false`, and supply only approved assets. If expansion is enabled later, record/review the expanded prompt and returned result. Check schema changes before release.

The selected segment must have its exact prompt and boundary revisions pass the current automated text/image screening policy before payment is offered and again before a billable dispatch if the inputs or policy changed. A flagged, unchecked or unavailable check holds the action without starting generation. Persist the screened input hashes, policy/model identity and immutable provider/recipe/quality/input snapshot. The request can include both anchors; verify real endpoint adherence after rendering. Normalize provider-native aspect, frame rate, duration and audio into the required 16:9 publication format without changing a neighbor's canonical boundary. Clips are approximately 15 seconds; do not force 15.083333 seconds into an endpoint capped at 15 requested seconds. A 480P/768P direct output can bypass AI upscale; extra AI upscale is a separate action/budget reservation, not another use of the generation payment.

Primary references: [model and configuration pricing](https://fal.ai/models/minimax/h3-max-turbo/image-to-video), [API schema](https://fal.ai/models/minimax/h3-max-turbo/image-to-video/api).

## Revenue model

Twitch's standard Bits-in-Extensions distribution gives the broadcaster **80% of US$0.01 per Bit** and the Extension developer **20% of US$0.01 per Bit**. The app owner therefore ordinarily receives **US$0.002 per Bit**, before paying fal and operating costs. The application cannot choose an arbitrary revenue split inside Twitch. Viewer retail Bits prices are different from this settlement basis. Source: [Twitch's revenue explanation](https://help.twitch.tv/s/article/earning-revenue-from-bits-in-extensions?language=da).

Normal chat Cheers do not create this Extension developer share. Use the registered, monetized Extension product/transaction flow for that business model. If the developer is also the broadcaster on a particular channel, separate the two roles in accounting; do not assume other channels' broadcaster revenue funds our compute.

Recommended commercial goal: use the existing 20% developer share to cover compute and operations, targeting roughly **25% contribution margin on developer receipts**, not a 25% extra share of the broadcaster payout. This target is a proposal for the owner, not a Twitch guarantee or a measured operating margin.

## Current provider rates and conservative catalog examples

The model page advertises a 35% promotion ending **October 31**. Price stable Bits products against its stated regular rates instead of assuming that discount will continue through the November 2 hackathon deadline. Current generic pricing API returns $0.01625/second, but does not convey the higher-resolution configuration multipliers; the model's configuration pricing is needed too.

| Resolution | Promotional rate / requested second | Stated regular rate / second | 15-second promotional compute | 15-second regular compute |
|---|---:|---:|---:|---:|
| 480P | $0.01625 | $0.025 | $0.24375 | $0.375 |
| 768P | $0.026 | $0.040 | $0.39000 | $0.600 |
| 1080P | $0.052 | $0.080 | $0.78000 | $1.200 |

These are arithmetic estimates for one requested 15-second generation, not final quotes. Recheck billing semantics/minimums/configuration rates and actual invoices before exposing live products. The current schema has no measured latency evidence sufficient to promise a completion time.

Let `C` be the configured cost of one provider generation, `q` an operating-risk provision, `O` the measured per-action operating provision, and `m` the desired contribution margin on developer receipts:

```text
developer_receipt(B) = B * $0.002
broadcaster_receipt(B) = B * $0.008
provisioned_cost = C * (1 + q) + O
minimum_bits = ceil(provisioned_cost / ($0.002 * (1 - m)))
```

Example assumptions: regular rates, `q=20%`, `O=$0.10`, `m=25%`. These provisions are placeholders for measured validation/storage/serving/operating risks. They are not a customer regeneration allowance and do not authorize a second billable generation under the same payment.

| Illustrative optional H3 Max Turbo product | Bits | Developer receipt | Broadcaster receipt | Provisioned cost | Developer remainder before tax/fixed costs |
|---|---:|---:|---:|---:|---:|
| Optional H3 Max Turbo 480P render, up to 15 requested seconds | 400 | $0.80 | $3.20 | $0.55 | $0.25 |
| Turbo render action, 768P, up to 15 requested seconds | 600 | $1.20 | $4.80 | $0.82 | $0.38 |
| Turbo render action, 1080P, up to 15 requested seconds | 1100 | $2.20 | $8.80 | $1.54 | $0.66 |

**One payment authorizes at most one billable generation attempt.** No included regeneration follows a rejected, failed or unwanted generated clip. Rejection consumes the attempted action and reopens the slot for a new contribution or vote; another paid render requires a new verified transaction. Recovering the same provider request/result, retrying a transfer or revalidating identical bytes does not authorize a new render. A genuinely never-dispatched purchase remains unfulfilled for explicit reconciliation/remedy, rather than being treated as a rejected completed attempt. No automatic Twitch refund capability is assumed.

The Bits queue SKU pays for a queue entry, not the later render. The optional H3 Max Turbo SKU must be priced separately: 100 Bits yields only $0.20 to the developer, below its regular $0.375 480P generation cost before overhead. If reserves do not cover a Turbo render, disable that SKU or use an explicitly budgeted subsidy; never auto-switch routes. Maintain working capital because fal costs can be due before Twitch payouts settle.

## Product semantics and Twitch review gate

The initial target is a roughly US$1 fixed Bits queue-entry product, fulfilled by the shared FastH3 worker path after the proposal enters the ordinary community vote. H3 Max Turbo remains a separate, higher-priced provider route. The implementation treats the Bits action as the app-defined queue entry and its custom prompt as screened user content. The queue purchase does not bypass moderation, win the vote, or guarantee a render. Streamer/moderator review continues to control publication.

Twitch's official examples provide relevant precedent: Queue+ allows Bits queue entry and priority while exposing customizable fields; BitPoll allows Bits-created polls; View Message Alert supports viewer messages. This supports custom input fields within a fixed app-defined Bits interaction. It does not guarantee that Twitch will approve every AI-generation feature, so keep the ordinary Extension review step and policy gate. Never describe the action as a donation, support payment, or fixed USD amount. Sources: [Twitch policy](https://dev.twitch.tv/docs/extensions/guidelines-and-policies/), [Twitch Bits-enabled Extension examples](https://dev.twitch.tv/extensions/bits-extensions-to-try/).

The initial catalog target is 100 Bits, roughly US$1 on Twitch's settlement basis, not an exact viewer retail price. Twitch catalog products use a fixed Bits count; display that exact count in the Extension. Under Twitch's standard split, the Extension developer receives 20% of US$0.01 per Bit (US$0.002/Bit) and the eligible broadcaster ordinarily receives the remaining 80%; confirm the share displayed for this Extension at release. The owner cannot tune this split. At 100 Bits, the developer share is about US$0.20. The queue SKU pays for queue entry, not a provider render. Any provider-paid H3 Max Turbo SKU remains separately priced: 100 Bits is below the estimated regular 480P compute cost before overhead. Keep H3 Max Turbo disabled unless its own SKU covers the route's cost. [Twitch Bits payout explanation](https://help.twitch.tv/s/article/earning-revenue-from-bits-in-extensions?language=da).

Prove the registered Extension's actual developer share, applicable payout eligibility, product display and queue-entry fulfillment before rollout. Queue entry is fulfilled when the verified proposal becomes eligible in the ordinary vote; it is not a render entitlement. Any later render follows the channel's normal worker and owner-budget rules. Regular viewer Cheers do not generate the Extension developer's share; this product must use the Extension's confirmed Bits SKU and receipt path.
## Turbo verified fulfillment protocol

1. Backend checks channel Bits eligibility, product allowlist/rate freshness, available compute budget and eligible future target. Exact prompt/images need current effective clearance: an automated pass or an explicitly authorized streamer review/hold resolution with the automated evidence retained separately. Create a short-lived `action_intent` with target/election revision, cleared input digest, fixed product, duration/resolution, expected Bits, one permitted billable attempt and rate snapshot.
2. Extension calls Twitch's product flow. UI receipt is evidence to validate, not authority to schedule jobs.
3. Backend verifies receipt and authoritative transaction evidence; deduplicates on Extension+transaction ID; verifies broadcaster, purchaser, SKU, amount and production versus development environment. Subscribe to the currently documented `extension.bits_transaction.create` EventSub event and reconcile `Get Extension Transactions` for outages. Loopback/test transactions never award production entitlements or trigger billable rendering.
4. In one DB transaction record the paid entitlement, reserve configured spend, attach it to the still-current eligible target and enqueue the render outbox record as `PAID_RESERVED`. Twitch processing and our DB are not globally atomic. If eligibility disappears before the sole dispatch authorization—for example, the target is stale or moderation is no longer passing—mark the never-dispatched action `PAID_UNFULFILLED` for explicit reconciliation/remedy. Do not silently choose another target or expose a reusable generation balance.
5. The coordinator atomically obtains the transaction's sole dispatch authorization before sending. A unique funding/attempt constraint binds that payment to one immutable generation attempt across all jobs, slot revisions and devices; outbox retries cannot allocate another authorization. Persist the local attempt/idempotency identity first and the fal request ID when known. The authorization is consumed at dispatch; lost acknowledgment becomes `CONSUMED_UNCERTAIN` and stays held until provider reconciliation. Never create a replacement billable request because a result is missing. Only a provider-documented replay of the same idempotent request, status/result retrieval, transfer retry or same-byte validation may recover the existing attempt without another generation.
6. An accepted billable attempt remains consumed whether it succeeds, fails or its resulting clip is rejected. Record `CONSUMED_SUCCEEDED`, `CONSUMED_FAILED` or `CONSUMED_REJECTED` as appropriate; none grants a fresh render. Successful outputs follow channel trust policy: server-verified fal/owner-worker execution may be approved automatically after passing input screening and structural/continuity validation; ordinary public donor uploads require a reviewer unless an explicit uploader approval exemption applies. Approval is a server policy result tied to exact bytes and trusted execution identity, never a client assertion.
7. Record actual fal cost, royalty/developer accrual estimate, provision usage and outcome in an append-only ledger. Reconcile provider invoices and actual Twitch payouts; estimates are not cash receipts.

### Rejection and reopening a slot

When a paid clip is rejected, preserve its immutable artifact/review/payment history and atomically retire its selection/publication eligibility. Reopen the same logical future slot with a fresh selection/election revision for another proposal, a new vote or a newly funded render. Preserve all shared-boundary/fork constraints and published history. Fence late completions and fulfillment callbacks tied to the rejected revision; they cannot fill the reopened slot or restore the spent payment. Another user may contribute, and the original user may participate under normal channel rules, but neither can regenerate using that consumed transaction.

A trusted automatic worker may later fill the reopened slot under a **new channel/owner budget reservation**. That is a separate generation with separate cost authority; rejection does not transfer the user's consumed payment into an automatic retry budget. Likewise, user-requested changes of prompt, anchors, seed, quality or model require a new render authorization when they would generate new video.

If evidence conclusively shows the authorized request was never dispatched/accepted for billable execution, reconcile it as never fulfilled and apply the disclosed remedy. If dispatch/billing is uncertain, retain the consumed/uncertain record instead of resetting it. Provider failure after billable acceptance does not make the payment reusable. Administrative accounting corrections must preserve history and cannot be triggered through a client “regenerate” action.

### Correlating a transaction with a requested action

Twitch's transaction record contains purchaser/channel/SKU/transaction identity; it does **not** carry our arbitrary `action_intent_id`. Do not infer a target by taking the newest pending intent. Serialize one outstanding purchase intent per `(extension, broadcaster, purchaser, SKU)`, with a recorded purchase window and immutable target. Block a second tab/intent while that purchase is unresolved, and retain expired intent tombstones. A verified transaction can attach automatically only when its authoritative timestamp/product/user/channel and the serialized purchase state identify one unambiguous window. A frontend response may explicitly request a binding, but it cannot replace verification or reuse a previously consumed transaction.

Delayed dialogs/receipts, reused SKUs or missing history can still make correlation ambiguous. In those cases create a transaction-keyed unallocated/unfulfilled entitlement and reconcile with the authenticated purchaser/operator; do not attach to a later segment or automatically reuse the tuple after an unresolved expiry. An explicit post-purchase allocation flow for the app-defined action is preferable if Twitch-approved UX cannot make purchase windows reliable. Test concurrent tabs, duplicate receipts, out-of-order events and receipts arriving after a new target becomes available.

Freeze/pause product availability if pricing changes, API balance is insufficient, webhook reconciliation is unhealthy, the review queue cannot meet its disclosed service window, or the subsidy/cost ceiling is exhausted. Keep old transaction terms immutable rather than charging more after confirmation.

Official transaction references: [EventSub subscription types](https://dev.twitch.tv/docs/eventsub/eventsub-subscription-types#extension-bits-transaction-create), [Get Extension Transactions](https://dev.twitch.tv/docs/api/reference#get-extension-transactions).
