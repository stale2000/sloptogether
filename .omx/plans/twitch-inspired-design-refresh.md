# Twitch-inspired design refresh

## Direction
- Make the channel workspace feel like a live community room: compact rows, visible stream state, chat-like cues, and a recognizable purple action color.
- Keep SlopTogether's own identity; do not copy Twitch logos or present the product as Twitch.
- Remove the homepage's signal-lime grid treatment and reduce decorative gradients, glow, and oversized rounded surfaces.
- Keep AI work legible and human-led: show prompt/frame generation as optional tools, keep editable results, and make screening/review status visible beside the action.
- Use Twitch's geometric, friendly typography pattern. Roobert needs a webfont license, so use self-hosted OFL-licensed Figtree and ease the overly tight heading tracking.
- Make the packaged panel fit Twitch's 318 × 496 px panel target, respond to Twitch light/dark context, and disclose prompt submission progressively.
- Preserve the clean 16:9 OBS output and all playback, voting, review, and contribution behavior.

## Verification
- Inspect homepage, channel workspace, moderation and packaged Extension at desktop and narrow panel widths.
- Run app tests, lint, typecheck, and production build; check browser console and key navigation/actions.
- Compare the rendered result against Twitch's official Extension sizing, theme and focus guidance.
