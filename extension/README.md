# SlopTogether Twitch Extension

Standalone Twitch Extension frontend. The Next app supplies the shared API; it does not contain the Extension UI.

## Source

- `public/panel.html` and `src/panel.js`: shared voting, prompt and optional Bits view
- `public/config.html` and `src/config.js`: broadcaster configuration view
- `build.mjs`: emits the mobile, video-component and transparent video-overlay views from the panel template
- `src/bits-state.mjs`: Bits receipt state and late-receipt handling
- `public/extension.css` and `public/figtree-latin.woff2`: shared panel styles and font
- `licenses/Figtree-OFL.txt`: font license

The panel sends its Twitch-signed JWT to `https://www.clips.gg/sloptogether/api/v1`. The server verifies the identity and owns elections, prompt screening, Bits receipts, and channel state.

## Run

`npm run extension:sync` copies the standalone assets into the Next public directory for local testing. `npm run extension:package` builds `dist/sloptogether-twitch-extension.zip` with all viewer paths and files at the ZIP root.

For the registered version, use `panel.html`, `mobile.html`, `video_component.html`, and `video_overlay.html` for its viewer paths; use `config.html` for configuration and Live Configuration. The current version is Local Test at `https://www.clips.gg/sloptogether/extension/`. Upload the packaged assets in the Twitch Developer Console to enable Hosted Test, then test the real Extension Helper, linked identity, voting and prompt submission in Developer Rig and on the channel before requesting Twitch review.

Bits remains disabled until the fixed catalog products, Twitch policy approval, transaction EventSub and server receipt path have been tested. Bits only buys one fixed Turbo attempt for the currently locked scene; it does not purchase arbitrary prompts.
