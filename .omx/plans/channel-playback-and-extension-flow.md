# Channel playback, moderation, and Extension flow

## Product surfaces
- `/channels/{channel}` is the channel's main page: open directly to the basic 16:9 player and playback controls.
- `/channels/{channel}/output` stays the clean player/OBS capture route.
- `/channels/{channel}/moderate` owns the review queue and approve/reject actions. Keep those controls off playback pages.
- The Twitch Extension is a separate compact panel for linked-viewer prompt submissions, shared poll voting, and approved Bits actions. Keep explanatory copy to short labels and actionable state.

## Shared state and authority
- The Extension sends its signed Twitch JWT to the SlopTogether API for state, proposals, ballots, and Bits actions.
- The API verifies channel, identity, contribution policy, moderation state, election eligibility, and Bits receipts before writing to the shared `sloptogether` database.
- The channel page reads the same timeline/program state from the API. The Extension and page do not connect to each other's browser session; the API/database is the source of truth.
- After a valid submission or ballot, API state refreshes become visible to the channel page and Extension; playback continues from the committed program.

## Extension source boundary
- Keep all Extension HTML, CSS, JavaScript, font assets, tests, and ZIP packaging under root `extension/`, separate from the Next app.
- Follow Twitch's `public/`, `src/`, and `dist/` organization and viewer/config views. Use Twitch's official boilerplate for structure and Helper lifecycle patterns, without importing its unrelated React/giveaway implementation.
- Keep only the Extension API/EBS implementation in the Next app. The browser player and moderator UI do not import Extension components.
- Build copies `extension/public` and `extension/src` outputs into Next's generated public path for local hosting and clips.gg; ZIP packaging reads from `extension/` and writes viewer/config files at archive root.
- Each view loads Twitch's Helper before its own script, uses `onAuthorized` for the signed EBS token, `onContext` for theme, and shares state through the API. Test the panel and config view in Developer Rig/Local Test before submission.

## Bits boundary
- Use fixed Extension product SKUs priced in Bits. The fixed SKU represents one defined SlopTogether action: submit one custom prompt for one screened render attempt, with fixed duration/profile and normal moderation. User text supplies content for that action.
- Bind the prompt to the initiating Extension user, channel, stream, product SKU, transaction ID, policy revision and one-time funding record. Do not dispatch or lock a scene until Twitch confirms the transaction. Replays, late receipts and uncertain submissions must not duplicate spend or unlock another render.
- Keep prompts and output screened. Follow the broadcaster's review policy; a paid request does not bypass moderation. On rejection, reopen the slot according to the current rules without restoring the consumed attempt.
- Do not promise a specific output, model latency or quality. Enforce the action's fixed bounds and show pending/rejected/ready state.
- Twitch policy §6.2.8 is broad, while Twitch publicly showcases Streambombs with a fixed selection plus a personal message and Sound Alerts with Bits-priced viewer-typed TTS. Treat those as precedents for fixed Bits interactions carrying user text, not as blanket approval of arbitrary AI video prompts. Submit the exact SlopTogether interaction through normal Twitch review before enabling the Bits product broadly.
- Never label Bits as a financial donation in Extension UI. Use accurate Extension terminology and the catalog's fixed Bits amount. Viewer-authored free prompts, chat and website participation remain available without payment.
- A confirmed Bits prompt lock takes precedence over the vote for its selected slot. Streamer/moderator approval still controls whether its uploaded clip is accepted. Rejection releases the slot for another eligible submission or vote; the consumed payment cannot fund another render.


## Work and acceptance
1. Route the channel page to playback; trim the directory to channel names and actions.
2. Keep review decisions only in the moderator route and keep voting/prompt entry in the Extension.
3. Preserve the shared API source of truth and minimal OBS output.
4. Verify route destinations, playback/seek, moderator separation, Extension API endpoints, packaging, and copy length at desktop and phone/panel sizes.

Acceptance: ship the fixed Bits prompt-submission SKU with one attempt, safe content checks, and moderator policy. Submit the complete viewer flow through Twitch review before broad enablement; record the review result in the release configuration.
