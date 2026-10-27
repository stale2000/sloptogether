# SlopTogether remaining work

Updated October 27, 2026, America/Los_Angeles.

The current detailed execution plan is [the October 27 completion plan](../../docs/completion-plan-2026-10-27.md). The [EventSub subscriber meme plan](../../docs/eventsub-subscriber-memes-plan.md) specifies the new approximately ten-second personalized subscription clips. The [acceptance specification](sloptogether-test-spec.md) remains the full release contract.

## Current evidence

- Production has eight committed program spans, about 120.67 seconds, a ready HLS program and a successful HTTP 206 media range GET.
- Real Fal FastH3 generation and pre-air SoL upscales have reached the published browser program; some approvals were manual. See the [Fal runbook](../../docs/fal-upscale-runbook.md) for job/artifact identities.
- The separate anime/cartoon comparison jobs verified private Fal inference and output retrieval; they bypassed the app queue, upload admission and publication.
- Multiple streams per channel and migration 021 are implemented and checked locally, not qualified in production.
- The Twitch Hosted Test panel accepted a linked broadcaster's prompt and vote; separate viewer, chat and actual subscription-event acceptance remain open.
- Paid Turbo is paused and hidden in Hosted Test. Its implementation remains in source; FastH3 workers are unaffected.
- Paid Turbo/Prompt Lock is paused and hidden in Hosted Test; implementation code is retained, and FastH3 generation remains the default worker path.
- Windows packaging and a WSL2 client path exist. The production release API returns available:false; no supported signed installer or actual Windows RTX 4090 qualification is complete.
- Both Fal apps were stopped after testing. All new sessions must have an external hard deadline of at most 7,200 seconds and verified provider shutdown.

## Next execution order

1. Release a reproducible web/API/storage baseline, deploy the independent stream routes with additive schema migration, preserve old URLs and existing Clips.gg.
2. Make publisher/producer supervision and trusted worker approvals reliable; prove continuous refill, recovery, queue fairness and fresh-output throughput through normal app jobs.
3. Finish EventSub subscription lifecycle and about-ten-second named cartoon gag clips, using a reviewed template/image library and once-only browser interruption/resume.
4. Build the Windows runtime installer and actual executable, then qualify generation and upscale on a Windows RTX 4090 before signing/publishing supported downloads. Packaging work can proceed alongside steps 2–3.
5. Qualify separate viewer Extension identity/voting, synchronized chat ballots, moderator/whitelist/ban policies and Twitch release review.
6. Resolve the exact permitted Bits action, verify receipt/provider uncertainty paths, then finish budgets, security, durable hosting and public release operations.

## Completion and external dependencies

A successful finite generated program proves part of the production path. It does not prove continuous fresh generation, Windows contribution or every Twitch feature. Each phase has explicit acceptance evidence and source boundaries in the detailed plan.

Remaining external dependencies are real Windows RTX 4090 access, a release signing service/credential, durable CPU hosting, actual broadcaster subscription authorization/live event delivery, and the exact approved paid product. Already-authorized trusted Fal upscale, manual-only Comfy image calls, existing Clips.gg database use and the two-hour GPU ceiling are settled requirements.
