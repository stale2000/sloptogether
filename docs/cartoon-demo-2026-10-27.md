# Cartoon stream end-to-end test

The isolated `stale2000/cartoon-demo` stream was tested on October 27, 2026. Its first three approximately 15-second clips were produced by the five-step FastH3 Fal worker, uploaded, automatically approved by the generation worker's trusted binding, published and played in the browser. Clip 3 originated as a Twitch Hosted Test prompt and vote. Clip 4 is approved but awaits the next candidate's start frame.

The first 512×288 base clip took 72 seconds for the initial Comfy execution, excluding worker startup and upload. The separate SoL upscale produced 1184×666 in 256 seconds including model loading. The upscale required manual approval: the current upscale worker key lacks `artifact:system_approve`. Its approved derivative is accessible separately; published HLS history retains the base clip. Pre-air upscale for planned-anchor clips remains unsupported.

Twitch CLI mock challenge, signed subscription, duplicate delivery, and invalid signature tests passed against an isolated database. This is not a real Twitch delivery or a rendered subscriber alert. A separate viewer test and public Extension release also remain outstanding.

The short demo recordings are in `~/Documents/ChatGPT/SlopTogether/demo-videos/`. They are silent screen captures; the mock subscription video is a labeled result card, not a production notification.
