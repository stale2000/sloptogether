# Optional subscriber interrupt clips

Current plan updated October 27, 2026: [EventSub subscriber memes](eventsub-subscriber-memes-plan.md) specifies approximately ten-second animated clips and a reviewed gag library. The code carries a 243-frame FastH3 Trim recipe (10.125 seconds at 24 fps) through admission, worker generation, validation, and publish. Subscriber alerts publish without waiting for the optional upscale stage. The code routes verified EventSub receipts through the owner story producer, screens the H3 prompt/frame, creates one funded worker render, publishes the approved result as a separate program item, and has the streamer-controlled browser source jump to it at a safe clip boundary before resuming the story. A forward seek past an unplayed alert now marks it skipped durably; rewind leaves the already-played/skipped history unchanged. The ordinary OBS window capture remains the broadcast source. Local and deployed standard-stream HLS playback are verified; live Twitch EventSub registration, live Fal generation, and browser interruption/resume switching remain unqualified; the remaining acceptance cases below still apply.

Local verification: `scripts/test-eventsub-local.sh` creates a guarded disposable database on the dedicated local PostgreSQL cluster and verifies signed subscription admission, durable queue/outbox rows, 10-second frame metadata, reservation accounting, and duplicate delivery idempotency. It also submits a test-signed Twitch Extension prompt, records a linked Extension ballot and a signed `!slop vote 1` chat EventSub ballot against the same election, resolves the expired election, and confirms a generation worker leases the resulting FastH3 job. A separate signed subscriber receipt is followed through producer claim, safe H3 plan submission, and lease of the 243-frame interrupt recipe. Playback integration verifies a forward seek across a ready alert marks it skipped and a rewind does not. The publisher integration generates a synthetic 10.125-second audio/video file, validates it, packages HLS segments, commits a subscriber program item, and marks the event ready without scheduling an upscale. Preflight decisions and source media use local fixtures; no Fal GPU or paid provider is called.

Manual local browser verification on `http://localhost:3000/sloptogether/channels/localdemo/output` confirmed the default stream playlist and MPEG-TS segments return HTTP 200, an active 1280×720 video reaches ready state, clip 2 seeking works, and clicking the video pauses/resumes playback. This does not verify subscriber clip insertion, discontinuity handling, or story resume in the browser.

Manual deployed verification on [stale2000's output page](https://www.clips.gg/sloptogether/channels/stale2000/output) confirmed the program/timeline APIs and HLS playlist return HTTP 200, signed R2 segments load, and the 1280×720 video reaches `readyState=4` and plays. The clip 2 jump and video click pause/resume also work on the deployed page. This does not verify subscriber clip insertion, discontinuity handling, or story resume in the browser.

Live Twitch smoke test (October 27, 2026): the Hosted Test Extension accepted a free prompt, opened an election, and recorded an Extension ballot in the production app. The test election was then unlocked with a streamer override; no render job was created and no GPU/provider work was started. The Extension was restored to Hosted Test afterward. The broadcaster completed the `channel:read:subscriptions` OAuth flow without a two-factor prompt, and the control page reports subscription access ready. Production subscriber interrupts remain disabled, the owner generation budget and hourly cap are both `$0`, and there is no EventSub registration for this channel. Do not enable paid interrupts or raise either cap as part of a smoke test; the local signed-EventSub integration test below is the verified job-creation path until a separately budgeted live event test is arranged.

The implemented unavailable/over-budget behavior is `skip`. Text-only acknowledgments are not active because no separate moderation/display consumer exists; legacy settings that selected that fallback are normalized to `skip`.

## Event source and identity

Use Twitch **EventSub**, with the channel broadcaster's `channel:read:subscriptions` authorization and channel-bound conditions. The verified webhook handler persists the event and acknowledges promptly; planning/rendering runs asynchronously. Verify raw-body HMAC, reject stale/replayed requests and deduplicate delivery IDs before creating work. Sources: [subscription types](https://dev.twitch.tv/docs/eventsub/eventsub-subscription-types/), [event fields](https://dev.twitch.tv/docs/eventsub/eventsub-reference/).

| Event | Meaning and handling |
|---|---|
| `channel.subscribe` | New subscription; excludes resubs. Non-gift events can create one announcement. Inspect `is_gift` before deciding how to handle gift recipients. |
| `channel.subscription.message` | A shared resubscription chat message. Optional resub announcements use this event; do not claim every renewal necessarily emits one. |
| `channel.subscription.gift` | A gift action with a total count and possibly anonymous gifter. Optional batch announcements thank the gifter once for the batch. |

Gift modes are mutually exclusive: `off`, `gifter_batch`, or `recipient_each`. In batch mode, ignore gift-recipient `channel.subscribe` events for announcement creation; in recipient mode, do not also announce the aggregate gift event. Do not infer that unrelated events are duplicates merely because timestamps/names are close. Generic chat subscription notifications are not another announcement source alongside these canonical events.

Store a durable `subscription_event` and derived `interrupt_request` identity, scoped to broadcaster and original event. Retries of the same delivery/work request do not produce another interrupt or spend another render budget. Anonymous gifts use an anonymous/generic label and never reconstruct a hidden identity. Subscriptions ending do not create shout-outs.

Subscriber display names and any optional resub message are untrusted content. Bound/escape names as data, never HTML or planner instructions; omit raw resub text by default. A name identifies the celebratory shout-out, not a request to impersonate that person's real appearance or voice. If a name cannot pass the configured input policy, use an approved generic label rather than bypassing screening.

## Channel configuration

These are proposed initial defaults, not further user decisions already made:

- `subscriber_interrupts.enabled=false` until the broadcaster enables it.
- Enabling now requires a configured `SLOPTOGETHER_SUBSCRIBER_ATTEMPT_RESERVATION_USD`; both the channel owner budget and hourly subscriber cap must cover at least one reservation. The API rejects the enable request before registering Twitch EventSub when these checks fail.
- Once enabled, `new_subscriptions=true`; shared resubs and gift mode are separately selectable.
- Configurable scene theme, funny scenario list, approximate duration, allowed audio-capable render profile, approval policy and owner/channel funding source. The generated shout-out includes the requested spoken line; text-only acknowledgment is a separately identified fallback, not completion of that generated speech feature.
- Configurable queue cap, per-channel minimum gap, event expiry and maximum alert rendering spend per hour/day. Burst overflow and unavailable owner budget currently skip the render; they do not create a text acknowledgment.
- `one_render_attempt_per_interrupt` initially; a genuinely new render after failure requires a fresh explicit owner reservation. Provider-status/upload recovery of the same attempt remains allowed.
- Streamer controls can force the next eligible interrupt, hold/cancel a pending one, skip it, disable the feature or change its policy. Controller actions take precedence over background event work.

Disabling the feature may retain event receipts/audit records, but creates no new story or GPU job. An old queued request must recheck the current setting/authority before dispatch and publication.

## Cheap story planning and H3 output

Use a small configurable text planner or the owner's existing story-generator adapter. The common schema/compiler must serve ordinary scenes and these interrupts. Main model/price selection is specified separately; neither EventSub nor a subscription provides a free text/video render.

Keep each request small: fixed system instructions plus bounded channel theme, sanitized event data and one short current-story summary. No tools/web search or full transcript is needed. Default to one short structured-output call, validate it, then use a screened template on failure; at most one text-only repair may be explicitly enabled and separately budgeted. Record actual billed tokens/cost; cap planning and rendering separately. Stable event/plan/template identity prevents retries from regenerating arbitrary variants.

Conceptual planner contract (the H3 adapter compiles it into the verified node/provider prompt format; these fields are not a new public H3 API):

```json
{
  "kind": "subscriber_interrupt",
  "duration_seconds": 10,
  "subscriber_label": "LunaByte",
  "visual_action": "A confetti engine misfires inside a tiny spaceship; a fictional astronaut tumbles gently into an inflatable moon cushion, then waves.",
  "camera": "One continuous playful wide shot, no scene cuts.",
  "speaker_id": "S1",
  "speaker_character": "A fictional cartoon announcer",
  "voice_description": "A cheerful theatrical cartoon voice",
  "dialogue": "LunaByte just subscribed! Their spaceship has been upgraded to confetti power!",
  "soundscape": "Quiet spaceship hum and one soft confetti pop.",
  "music": "none"
}
```

The ten-second contract is represented by 243 frames at 24 fps (10.125 seconds) to satisfy FastH3 Trim's native sequence constraint. Use a short visual action and spoken line that fit this runtime; aim for roughly 12–20 spoken words and enforce the inspected compiler's **30-word maximum**. Preserve dialogue as plain data, without raw `<`/`>` tags or CR/LF, until the versioned H3 compiler validates it. The existing source helper `src/comfystream/flow_planner.py:263` (`attach_dialogue`) supplies its shot/speaker structure, integrated multimodal description, `<d>[English] ...</d>` speech markup, soundscape and no-music field; the language model must not author that markup itself. Pin compiler/model/recipe identity and store the final effective prompt. Image generation/reference selection remains optional and uses an allowed aspect/size transformation. See [cheap H3 story planning](cheap-h3-story-planning.md) for the shared compiler and planner cost controls.

Run exact compiled prompt, dialogue and actual reference/start/end images through normal input clearance (including an explicitly permitted streamer review resolution) before video dispatch. A cheap classifier is not full video/audio analysis. The Trim H3 workflow includes audio decoding, and worker leases now require an audio stream for both generation and upscale. The SoL worker copies the source soundtrack through its upscale/export path, while the media publisher requires one AAC stream. This verifies track presence/format, not that dialogue is audible, intelligible or matches the requested line; prove those with a real speech-capable generation and playback check before enabling subscriber interrupts in production. Fal Turbo's silent-AAC conformance fallback does not satisfy spoken shout-outs. If speech is unavailable, the current behavior is to skip the generated clip; a text acknowledgment is not yet implemented. Program insert/resume authority is server-supplied, never an LLM output field. Trusted execution may use policy approval after clearance/media validation; public untrusted output still follows review rules.

## Render and funding flow

`VERIFIED_EVENT -> ELIGIBLE -> STORY_READY -> INPUT_CLEARED -> RENDERING -> VALIDATING -> APPROVED_READY -> SCHEDULED -> PLAYED`.

Keep `HELD`, `EXPIRED`, `FAILED`, `CANCELLED` and `SKIPPED` explicit. Each request snapshots channel policy, subscriber/event identity, owner funding reservation, input digest, stage attempts, artifact approval and expiry. The shared Windows/Linux/fal worker program renders generation and optional upscale using its existing leases/keys; this is a prioritized job kind rather than a special unauthenticated render endpoint.

Priority must be bounded: reserve available capacity or prioritize the next eligible worker claim without repeatedly cancelling already accepted paid jobs. Cheap text planning does not make GPU rendering free. Use the app owner's/broadcaster's configured budget; a subscription event is not a Bits product transaction or a viewer-paid Turbo authorization. Do not assume the app receives part of Twitch subscription revenue. Alert work cannot reuse a consumed viewer payment or silently seize a paid story slot.

At every stage recheck expiry, feature setting and controller epoch. Do not continue spending for alerts too old to be useful. If render/upscale/approval is not ready within its configured window, keep the story playing and expire/skip or show the configured cheap fallback. Do not promise the generated clip begins immediately when the subscription occurs.

## Safe browser interruption and resume

Treat the alert as a separate program item linked to the story, not a replacement for an ordinary story slot. When an approved clip is ready, choose the next safe clip boundary. Save the selected story branch/publication, next story clip and exact offset if interruption mid-clip is explicitly supported; default boundary insertion avoids throwing away part of a story clip. On completion, resume the saved story position unless a streamer seek/override has since superseded it.

Use one-time `interrupt_id`, `program_epoch`, source observation sequence and playback-instance identity. A history replay or re-fetch must not count as another subscriber alert. Show the live cursor as an interrupt while it plays; actual program time includes its duration, so future story ETAs shift without changing ballot deadlines or consumed payments. Record entry/exit, played intervals and whether the alert was skipped or cancelled.

Maintain continuity deliberately: default a clearly signaled cut to/from the wacky alert with explicit playback/HLS discontinuities; optional generated entry/return bridges require separate time/cost and valid anchors. Do not demand the unrelated alert be byte-continuous with the main story or mutate its shared boundaries to pretend it is.

Prepared HLS/decoder buffers need an explicit tested switching strategy. Do not overwrite segments already published or assume a playlist edit removes media already appended in the browser. Switch/rebuffer at an acknowledged safe boundary to a separately prepared interrupt program/playlist, then resume the saved story source with correct timestamps. If that cannot be done safely before the alert expires, queue it later or use fallback rather than corrupt the active buffer. Audio starts/stops with the program item and does not overlap unpredictably with the resumed story.

Streamer override, manual seek, feature disable or a newer program epoch fences old automatic insert/resume commands. Interrupts queued under an old controller cannot undo a later streamer choice, even when their render arrives late.

## Planned acceptance cases

1. Duplicate/signed replay delivery creates one durable event/request and at most one funded render; invalid HMAC/wrong broadcaster creates none.
2. New non-gift sub, optional shared resub and gift batch follow their selected modes. Batch gift plus recipient events does not double announce; anonymous identity remains anonymous; subscription-end events do not enqueue.
3. Feature disabled or later revoked generates no new work/publication; bursts obey queue/cost/gap/expiry limits without cancelling unrelated paid renders.
4. Names/resub content cannot inject HTML/planner instructions; omitted/held names use permitted fallback. Effective prompt/dialogue/frames receive matching input checks; malformed planner output uses bounded repair/template fallback.
5. Trusted worker produces valid ready alert without human clicks; public untrusted result waits for review. Invalid media/unchecked input never becomes ready because an event is genuine.
6. Insert ready alert at a safe boundary, record entry/exit and resume exact saved story clip/offset. Confirm buffer switching, audio, HLS timestamps, main-story history, native durations and source cursor; no overwritten paid slot or duplicate alert on replay.
7. Streamer seek/override/disable during planning/render/playback prevents old insertion or stale resume from taking control afterward. Late results remain attributable but do not auto-play in a new epoch.
8. Planner/render failure, unavailable GPU, empty owner budget and expired events leave the main story usable and choose only the configured fallback. Measure real event-to-ready/play latency and total text/video cost; no zero-latency or subscription-revenue assumption.
