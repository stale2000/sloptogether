# Cheap H3 story and dialogue planning

Required direction: continuous story adapters and optional subscriber shout-outs produce inexpensive, bounded H3-compatible scene plans. They use the shared worker/API model and channel-owned configuration. No model calls were made during this planning task.

## Reuse the existing prompt contract

Inspected source: `/Users/stale2000/comfy/comfystream/src/comfystream/flow_planner.py`, `MAX_DIALOGUE_WORDS`/`spoken_word_count` near lines17–21 and `attach_dialogue` near line263. The current `comfy_cloud_dialogue_planner.py` already defaults to `gpt-6-luna`; reuse the planner interface and extract/reuse the pure prompt formatter, not the old desktop coordinator or its multi-pass screenplay/review loop.

The existing formatter validates `S1`, `S2`, … speaker IDs, bounds one plain dialogue line to30 spoken words, rejects CR/LF and `<`/`>` in raw dialogue, and emits:

```text
integrated_multimodal_description: [Shot 1] <visual action and camera>
At the beginning of this shot, <fictional speaker> (S1), <voice description>, says:
<d>[English] <validated short dialogue></d>

overall_soundscape: <appropriate ambience and synchronized effects>

non_diegetic_music: N/A
```

This sketch documents the source format, not a request for the LLM to emit unchecked markup. The formatter supplies the tags/sections and speaker wiring. Use plain structured model fields, validate them, compile deterministically and screen the **final effective prompt/dialogue and actual frame assets** before dispatch. Check the actual speech/reference/frame capabilities of each advertised H3/custom/Turbo recipe; H3-compatible text alone does not prove audio or endpoint quality.

## Small structured scene plan

Generate one approximately15-second scene at a time, with a short visual action, simple camera instruction, one fictional speaker, one short line, ambience, and optional plain image prompt. Aim for12–20 spoken words;30 is the inspected source hard maximum. Avoid several shots/characters or long dialogue that cannot fit the clip. Subscriber display names and resub messages are data fields, not instructions; bound/escape names and omit raw resub message text by default.

```json
{
  "kind": "subscriber_interrupt",
  "duration_seconds": 15,
  "visual_action": "A cartoon captain celebrates in a tiny spaceship; the escape pod pops into a harmless burst of confetti.",
  "camera": "One wide shot, then a gentle push toward the surprised captain.",
  "speaker_id": "S1",
  "speaker_character": "Captain Fizzy, a fictional cartoon astronaut",
  "voice_description": "A cheerful theatrical cartoon voice",
  "dialogue": "Nova just subscribed, and the emergency escape pod is full of space spaghetti!",
  "soundscape": "Quiet spaceship hum, comic spring sound and soft confetti pops.",
  "music": "none"
}
```

The event/channel/job/boundary IDs, budgets, lease keys and approval flags are server-supplied, never trusted model output. The example uses the name only as a shout-out label; it does not clone a subscriber's voice or generate their likeness. The ordinary story path uses the same schema/compiler with continuity context instead of an event punchline.

## Cost and latency controls

- Use an approved small text model or a safe local template; no web search, image analysis, tools, long reasoning or multi-agent screenplay pipeline for one short shout-out.
- One bounded planning call per event/scene by default. Validate JSON/word count/content locally; if invalid, unavailable or too slow, use a screened template rather than an unbounded repair/reviewer chain. A separately configured paid repair is counted/capped, not assumed free.
- Cache reusable system instructions, themes, fictional characters/voice styles and safe image references. Keep recent story context short; do not resend the complete channel history.
- Freeze the event's planned scene under a plan ID/version so duplicate notifications, worker restarts or a delayed upload do not regenerate its story unnecessarily.
- Record actual provider/model, input/output/billable reasoning tokens where applicable, latency and cost. Bound tokens, requests, per-event and per-channel planning spend. Do not claim moderation is a free story generator: moderation classification and story-generation billing are separate.

One current candidate is `gpt-6-luna`, matching the existing source default. Its official model page currently lists $0.10 input and $0.50 output per million text tokens. A hypothetical1000 input/300 billed output token plan is **$0.00025** before any cache writes, additional billed reasoning, provider/platform overhead or retries; this is arithmetic, not a quote or measured workload. Recheck account availability, selected service tier and current rates during implementation. Source: [official model page](https://developers.openai.com/api/docs/models/gpt-6-luna).

```text
estimated_story_cost = input_tokens * input_rate / 1_000_000
                     + billed_output_tokens * output_rate / 1_000_000
                     + applicable_other_charges
```

The direct API estimate does not automatically apply to a Comfy Cloud workflow/partner-node credit charge. Keep provider adapters and current rate snapshots explicit. Benchmark a cheap candidate against valid H3 output, safety, useful humor and response time; do not select a model solely by its name.

## Audio and output

Subscriber shout-outs explicitly require spoken dialogue, so their qualified generation recipe must generate the spoken line and preserve/mux its soundtrack through upscale/conformance. Validate audio duration/sample rate/timestamps and actual intelligibility/lip-sync as appropriate; do not advertise speech based only on prompt syntax. The clean browser output includes audio for the streamer's standard OBS capture setup. This resolves audio intent for shout-outs; arbitrary uploaded music/audio and normal-story soundtrack preferences remain separate channel-policy decisions.

If voice generation fails, do not silently call a second billable video model. Apply the configured bounded fallback (for example a named text acknowledgment) or let the streamer choose another freshly funded attempt. Free text/image moderation does not classify audio; retain the permitted voice/line policy and operator controls. An optional extra TTS provider is a distinct integration/cost, not an assumed feature of the current model.

## Planned checks

Validate structured output, max30 words, reserved-markup rejection, speaker identity and deterministic source-compatible compilation. Exercise malicious usernames/messages, missing/anonymous names, duplicate event planning, model timeout/invalid JSON with template fallback, planning budget exhaustion, speech capability, preserved audio after upscale, and actual cost/latency reporting. No expensive generation is submitted before required input clearance and render funding.
