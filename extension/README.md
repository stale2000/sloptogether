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

Bits prompt queueing is a separate fixed-SKU action from H3 Max Turbo. A viewer can submit one prompt as a queue entry; the server screens it before opening Twitch's Bits confirmation, and a verified transaction makes it eligible in the normal community vote. The queue entry does not guarantee selection or generation. The extension displays the exact Bits amount returned by Twitch and never labels the action a donation.

Enable the product only after Bits monetization, the fixed SKU, transaction EventSub, and the prompt queue server gates are configured. The current Twitch Developer Console version is Local Test; Twitch test transactions do not spend real Bits or create production queue entries.
