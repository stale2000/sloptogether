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
- Use only fixed Extension product SKUs priced in Bits. Do not label Bits as a donation or set a USD amount in the Extension UI.
- Twitch policy bars exchanging Bits for end-user specified free-form experiences. A Bits action cannot lock a viewer's custom prompt or guarantee it overrides the community-selected scene.
- Existing compliant direction: a fixed Bits action on a selected, screened scene for one Turbo render attempt. A separate fixed Bits vote on an already-approved poll choice may be considered; it can add support, not guarantee the winner.
- Viewer-authored prompts remain free to submit, screened, and approved before voting. Keep any paid action bound to its fixed product, verified transaction, immutable scene revision, and single-use lifecycle.

## Work and acceptance
1. Route the channel page to playback; trim the directory to channel names and actions.
2. Keep review decisions only in the moderator route and keep voting/prompt entry in the Extension.
3. Preserve the shared API source of truth and minimal OBS output.
4. Verify route destinations, playback/seek, moderator separation, Extension API endpoints, packaging, and copy length at desktop and phone/panel sizes.

Open product decision: keep the current fixed Turbo Bits action, or add a fixed Bits vote-support product. The requested custom-prompt lock/guaranteed override is not compatible with Twitch Extension Bits policy.
