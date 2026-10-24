# Independent plan review

This initial review was followed by [four revision requests](plan-review-followup.md), now addressed and rechecked in [the current fix review](plan-fix-review.md). The assessment below is retained as history.

Reviewed October 23, 2026. Verdict: **ready as an implementation plan**, with unresolved product choices explicitly retained in `open-questions.md`.

The reviewer read the main implementation/test plans, open questions, paid Turbo design, authenticated upload protocol, worker import notes and clips.gg hosting audit. The revised sections were then checked independently. This review did not implement the app, execute tests, run inference, build installers or deploy services.

## Corrections incorporated

| Finding | Resolution and evidence |
|---|---|
| A Twitch Bits transaction does not contain our arbitrary action-intent ID; same-SKU/concurrent/late events could fund the wrong segment. | `paid-turbo-segments.md`, “Correlating a transaction with a requested action,” now serializes purchase intents, records immutable windows, retains expired records, and leaves ambiguous transactions unallocated. Test cases I15/I16 cover concurrency and delayed dialogs/receipts. |
| A remote provider request ID may be unknown until the submit acknowledgment arrives. | Main plan §8 rule6 persists local attempt/idempotency identity first and remote ID when known; unknown-ID attempts without a supported lookup remain held with their spend reservation. T11 covers this recovery limit. |
| A path rewrite can forward the host application's root cookies to the child deployment. | Hosting audit requires upstream cookie/header filtering, child response-cookie constraints and a scoped proxy fallback if ordinary rewrite infrastructure cannot enforce them. Main plan §15 and host regression checks require on-wire evidence that `clipsgg-sb-auth` does not reach the child origin. |
| Always-on egress does not itself provide indefinitely fresh, human-approved content. | Main plan §13 and Q1 now distinguish unattended transport from moderation availability; exhausted approved buffers loop safe material or hold. |

## Assessed strengths and boundaries

The plan correctly distinguishes canonical boundary identity from actual generated endpoint fidelity, native 362/24-second Trim clips from exact15-second slots, and marketplace H3 Max Turbo from private custom fal workers. It treats 4090/Ada memory compatibility as a measured release gate, not an inherited capability of the current Blackwell profiles.

The proposed Bits economics use the developer's actual ordinary share, account for configuration-specific provider rates and promotion expiry, and retain paid-product policy review and failed-fulfillment decisions. The upload protocol distinguishes Twitch identity, device authority, leases and temporary Cloudflare capabilities; reused upload URLs cannot replace the server-owned accepted snapshot.

Separate deployment/data/credentials plus a narrow `/sloptogether` mount provide operational isolation. The documents preserve the remaining shared-browser-origin risk and require preview regression/rollback evidence before host integration.

The reported CPU/source-import evidence remains attributed to the import work. This review does not independently establish GPU execution, 4090/Windows support, real-time throughput, production security, Twitch monetization approval or deployment readiness. Those remain explicit implementation and qualification gates.
