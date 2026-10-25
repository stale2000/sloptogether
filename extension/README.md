# SlopTogether Twitch Extension

Standalone Twitch Panel frontend. The Next app supplies the shared API; it does not contain the Extension UI.

## Source

- `public/panel.html` and `src/panel.js`: viewer panel
- `public/config.html` and `src/config.js`: broadcaster configuration view
- `src/bits-state.mjs`: Bits receipt state and late-receipt handling
- `public/extension.css` and `public/figtree-latin.woff2`: shared panel styles and font
- `licenses/Figtree-OFL.txt`: font license

The panel sends its Twitch-signed JWT to `https://www.clips.gg/sloptogether/api/v1`. The server verifies the identity and owns elections, prompt screening, Bits receipts, and channel state.

## Run

`npm run extension:sync` copies the standalone assets into the Next public directory for local hosting. `npm run extension:package` builds `dist/sloptogether-twitch-extension.zip` with files at the ZIP root.

In Twitch Developer Console, set the Panel Viewer Path to `panel.html`, Configuration Path to `config.html`, and use the clips.gg extension asset URL. Test both views in Developer Rig or Local Test before submitting for review.

The Extension has not been installed or Twitch-reviewed. Bits uses fixed catalog products; custom-prompt paid overrides are excluded by Twitch's Bits policy.
