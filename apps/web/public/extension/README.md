# Twitch voting Extension assets

These static assets are the Twitch voting/Bits panel, not an OBS plugin. The Twitch Extension Helper is the first script in `index.html`, as required by Twitch's Extension submission policy. The optional Bits product stays hidden unless Twitch enables Bits for the channel and the server exposes an approved product for a selected, screened scene.

## EBS contract

The frontend uses the canonical production app origin `https://www.clips.gg/sloptogether/api/v1`:

- `GET /channels/{twitchChannelId}/timeline` with `x-extension-jwt`; read the first OPEN election from its `elections` collection and approved subscriber-interrupt status. The frontend tolerates an `activeElection` or `election` convenience field during API integration.
- `POST /elections/{electionId}/ballots` with `{ choiceId }` and `x-extension-jwt`; response status reports success or an HTTP error.

The backend must verify the Extension JWT signature, expiry, `channel_id`, linked stable viewer identity and role server-side. It uses the JWT channel as authority instead of trusting URL/channel browser claims; it enforces one ballot per verified Twitch user/election across Extension, chat and site. Configure Extension assets and EBS host to the clips.gg deployment, and allow only approved Twitch Extension origins in API CORS. User-contributed media appears only when approved; Extension choices never expose pending/unsafe text or frames.

The HTML uses sibling-relative links (`./extension.css` and `./extension.js`) so the assets resolve both from the `/sloptogether/extension/` route and when packaged together for Twitch's Extension CDN. The timeline, ballot, and guarded Bits Turbo API routes are implemented in the parent app. The assets still need to be packaged, configured with the clips.gg EBS host, installed and approved in the Twitch developer console before viewers can use them. Subscriber status is public/approved-state only. The optional purchase button appears only when Twitch enables Bits and the server returns a product backed by a screened, selected scene.

From the repository root, run `npm run extension:package` to create `dist/sloptogether-twitch-extension.zip`. `npm test` checks that the ZIP contains only the entry page, stylesheet and frontend script with paths that resolve on Twitch's CDN.

The Extension is not yet installed or Twitch-reviewed, and the EBS host/domain, Bits product catalog, Bits payout split, and JWT configuration have not passed live acceptance. Twitch requires all front-end HTML/CSS/JavaScript used by the Extension in the uploaded ZIP; the static assets in this directory are the upload source.
