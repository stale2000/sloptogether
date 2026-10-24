# Primary-source research for the SlopTogether plan

Collected October 23, 2026 (America/Los_Angeles). `sources.json` records URLs, UTC retrieval timestamps, download results and SHA-256 values for HTML snapshots. They are saved page source, not a complete offline mirror of linked websites/assets.

Primary references include Twitch Extension policies/helper/monetization, OAuth/token validation, EventSub webhooks, chat, polls and broadcasting; Comfy API v2; fal machine types/deployment; H3 Max Turbo model/API; and Cloudflare R2/Stream uploads. See the source manifest for exact URLs.

Additional structured snapshots:

- `fal-h3-max-turbo-schema.json`: connected fal model schema for `minimax/h3-max-turbo/image-to-video`, including first/end images, resolution, duration bounds and safety/prompt-expansion controls. No generation was requested.
- `fal-h3-max-turbo-pricing.json`: connected fal pricing response for H3 Max Turbo image/text/extend endpoints. Its generic per-second rate does not expose every resolution modifier. The saved model HTML supplies configuration-specific prices and the promotion-expiry statement; the plan's economics explicitly accounts for that difference.

Current facts can change. Recheck price/eligibility/API/policy details at implementation and release. Local source audits are in `docs/worker-import.md` and `docs/clips-hosting-audit.md`. The planning assumptions and unsettled decisions are in `docs/open-questions.md`.
