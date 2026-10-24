# Review of remaining product decisions

Reviewed October 23, 2026 against the updated main plan, acceptance specification, confirmed decisions, moderation/trust policy and paid-generation design.

Later clarification resolves the story-feed question below: the owner's test story adapter uses the shared Windows/Linux/fal worker and configurable channel keys. Paid-targeting semantics remain in the current open-question list. This report retains the original review context.

**Verdict: no new major structural blocker found. Two product-policy details still need to be pinned down.** An independent reviewer confirmed the same two gaps. This review does not change the plan's behavior or claim application/GPU/deployment qualification.

1. **Paid selection versus render funding.** Main plan §5 rule6 (`.omx/plans/sloptogether-plan.md:180`) permits selection priority or a specified action, while `docs/paid-turbo-segments.md:58` proposes rendering an already-selected candidate. Define what happens if a payer selects a different prompt while a vote remains open. Default proposal: fund the selected screened candidate, with paid reservation a separately reviewed channel mode. The single-attempt limit remains fixed.
2. **Empty-queue automatic planning.** Main plan §5 rule5 (`.omx/plans/sloptogether-plan.md:179`) permits automatic selection with thematic constraints but does not specify how a new eligible scene is created when no viewer proposal exists. Default proposal: streamer-provided world/theme prompt, latest accepted frame and recent scene context produce a continuation through the normal screening/locking pipeline. Healthy trusted workers should not be mistaken for an eligible scene planner.

These are added as Q33/Q34 in `docs/open-questions.md`. Other owner decisions to prioritize are managed-compute payer/cap, audio, final Bits prices and remedies for genuinely never-dispatched payments. Retention, tie rules, worker startup and contributor recognition can use documented reversible defaults. Windows memory/kernel qualification, moderation latency, storage/proxy implementation and external Twitch approval are engineering/external validation tasks rather than additional product questions for the owner.

No runtime tests, model calls, installation, deployment or application changes were performed. The main plan and prior source imports remain as reviewed; only this report, the open-question list and navigation are updated.
