# Cartoon stream end-to-end test

The isolated `stale2000/cartoon-demo` stream was tested on October 27, 2026. Its first three approximately 15-second clips were produced by the five-step FastH3 Fal worker, uploaded, automatically approved by the generation worker's trusted binding, published and played in the browser. Clip 3 originated as a Twitch Hosted Test prompt and vote. Clip 4 is approved but awaits the next candidate's start frame.

The first 512×288 base clip took 72 seconds for the initial Comfy execution, excluding worker startup and upload. The separate SoL upscale produced 1184×666 in 256 seconds including model loading and was manually approved. A subsequent test of clip 3 used the replacement trusted upscale key and produced a 1184×666, 15.08-second derivative in 252 seconds; the trusted execution policy approved it without a reviewer, and browser playback was verified. Two earlier test attempts were interrupted before producing output. Approved derivatives are accessible separately; published HLS history retains the base clip. Pre-air upscale for planned-anchor clips remains unsupported.

Twitch CLI mock challenge, signed subscription, duplicate delivery, and invalid signature tests passed against an isolated database. This is not a real Twitch delivery or a rendered subscriber alert. A separate viewer test and public Extension release also remain outstanding.

The short demo recordings are in `~/Documents/ChatGPT/SlopTogether/demo-videos/`. They are silent screen captures; the mock subscription video is a labeled result card, not a production notification.
