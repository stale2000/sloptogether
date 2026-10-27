# Code review and remaining work — October 27, 2026

## Review scope and change plan

Preserve the verified production story flow and existing pending memory diagnostics. Review the web/Extension trust boundaries and the worker loader separately. Reproduce concrete bugs with focused regression cases before edits. Keep fixes small, use existing dependencies and leave GPUs paused. Run worker/web tests, guarded database suites, lint, typecheck, build and offline packaging as appropriate.

Memory work must distinguish process RSS, container page cache and GPU VRAM. The current 128 GiB admission value is a conservative candidate guard, not a measured requirement of FastH3 or a qualified 4090 profile. Do not lower it without fixing/qualifying the SoL load path. Check unnecessary checkpoint prefetch, omitted components and load-time FP8 quantization before proposing a new hardware minimum.

## Completion gates

1. Qualify a fresh base plus SoL upscale through normal app jobs and browser playback. Existing base/fallback evidence and earlier upscale successes are useful, but do not establish continuous fresh production.
2. Remove the excessive host-memory transient and measure the Ada/4090 profile. Run the Windows installer and both contribution stages on real Windows/WSL2 hardware; publish a signed/reproducible release artifact after CI billing is repaired.
3. Move the CPU publisher off the operator Mac and supervise the optional story producer. Measure refill throughput, recovery, costs and playback tail behavior before claiming sustained live supply.
4. Qualify a real subscription notification through the ten-second clip and safe playback interrupt. The live webhook challenge passed; generation/listening remain off with a zero owner budget.
5. Finish independent viewer/moderator testing and Twitch Extension release. Paid Prompt Lock remains gated pending platform approval; Turbo remains hidden.

## Evidence and fixes

### Local fixes

- `apps/web/src/lib/server/channel-service.ts`: human review now accepts a subscriber job without a story segment, while keeping interrupt policy/state/expiry and screening checks. Six regression cases cover approval, rejection, expired/cancelled/disabled alerts and an orphaned story job. Current subscriber admission normally attaches the latest story anchor; this fixes the schema-supported interrupt-only case, not a demonstrated failure of every live subscriber clip. The moderator queue already uses a left join and can display these jobs.
- `vendor/comfystream/runtime/deploy/custom_nodes/comfystream_sol_refiner_h3/model_runtime.py`, new `fp8_loading.py`: load Ada transformer weights through the pinned Diffusers/TorchAO meta/shard FP8 loader, preserving existing large-Linear selection and BF16 elsewhere. Inject the result once, reuse it on subsequent requests, verify actual quantized weights and fail without a full-BF16 retry.
- Prefetch no longer primes omitted decoder/conditioning components or an already cached transformer. Ada CPU-offload skips eager priming entirely. This removes avoidable IO/page-cache use; it does not establish an actual RAM peak.
- `worker.py` and `model_runtime.py`: preserve the earlier pending 250 ms memory diagnostics in successful reports and failed-request stderr. Report RSS, system availability and cgroup usage/limits separately; unavailable metrics remain null.
- Packaging provenance includes the new helper and current patch hashes. No dependencies were added. The runtime still has the conservative 128 GiB Ada guard pending a constrained-memory GPU run; it is not the generation-stage requirement.
- Consolidated the completion plan's duplicate/outdated status claims and marked the older Fal deployment snapshot historical.

### Verification

- Worker suite: **164 passed**, including 10 load-time-FP8 helper/integration cases and prefetch regressions.
- Web: **179 passed, 22 database-only skipped** in the ordinary run; script/Extension suite **19 passed**.
- Guarded EventSub/PostgreSQL suites: **15 web + 20 publisher passed**; guarded Bits suite **5 cases + 3 lifecycle guards passed**. Fixtures use an isolated scratch DB and no cloud spend.
- Media unit suite: **54 passed**; its 20 DB cases passed in the guarded run above.
- Lint, typecheck and production build passed. Changed worker modules parse; independent diff review found no blocking issue.
- Fresh weight-free WSL ZIP and private Fal build contexts passed offline packaging. ZIP SHA-256 `e34d71d3f4ab1595c291e60750cda70554ce9e80878dde05cb0ec7aa495c3a3c`; assembled artifact digest `2ef7f381f3dc216bbfb80896debdd872c8e59db1eecb87e50d0a2ec1d254f1df`. No model weights bundled or downloaded.
- Live read-only check: health HTTP 200; nine program spans with source ready; HLS HTTP 200/72 media packets; media range HTTP 206/1,024 bytes. This checks the existing deployment, not the unshipped patch or fresh GPU inference.

### Deployment and limits

The reviewed worker changes have not been deployed to Fal and this review started no GPU. Fresh `fal apps runners` checks returned empty arrays for both SlopTogether apps. The shared Fal account has a separate ComfyStream decoder benchmark runner owned by the active ComfyStream task; it was left untouched. Actual lower-RAM behavior, output quality, latency, Windows installation, fresh unattended upscale and sustained production still need qualification. Keep these separate from passing CPU mocks and the existing playable demo.
