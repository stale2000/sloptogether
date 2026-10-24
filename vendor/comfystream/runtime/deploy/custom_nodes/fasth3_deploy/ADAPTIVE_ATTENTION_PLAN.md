# Adaptive attention: experiment summary

## Objective

Test whether reallocating the same attention budget across query regions improves generated-video quality at equal measured latency. The comparison is against the existing FastH3 B1 sparse path, configured for uniform 20% video-key retention. Attention recall or synthetic kernel speed alone is not a user-visible result.

The primary experiment changes the allocation of attention work while holding the total budget fixed. A pretrained Bev decision model is an optional policy chooser only if its inputs represent regions meaningfully and its full preparation, inference, transfer, and scheduling costs fit the generator's budget. A newly trained controller is a later option, not the starting assumption.

## Current evidence

- The default policy for supported base B1 VSA nodes is `adaptive`: it redistributes the existing per-head video-key interaction budget across query cubes using live QK routing scores. It requires no training and collects no route telemetry during normal runs. `fixed` remains available as the reference path.
- The GPU allocator stays on-device. On Fal RTX PRO 6000, two matched warm fox seeds (512×320, 15.083 seconds) measured a 14.609-second adaptive median versus 14.631 seconds fixed; the adaptive route stage added a median 21.2 ms. A prior CPU allocator run took 28.267 seconds warm on the same workload and GPU.
- This is speed evidence only. The two-seed test did not score output quality, so it does not establish that redistribution improves video quality. See the [research notes](ADAPTIVE_ATTENTION_RESEARCH.md) for limits of external results.

## Experiment sequence

1. **Qualify the baseline.** Record the resolved model/runtime/kernel identity, real backend execution, complete-node and attention-stage latency, memory, and a paired quality protocol.
2. **Check feasibility.** Audit available GPU-resident features and the variable-count kernel contract. Emulate the existing uniform 20% policy on the candidate backend and establish numerical/semantic equivalence before changing its allocation.
3. **Test fixed-budget redistribution.** Compare uniform and region-varying policies with the same aggregate attention work. Measure executed token interactions and padded work, not only requested percentages. Replay through the transformer and evaluate complete clips because local attention errors can compound.
4. **Evaluate a chooser only if warranted.** Compare a simple calibrated rule and, if useful, a pretrained Bev model on the same quality/latency frontier. Charge input construction, tokenization, transfers, model execution, and device contention. Train custom weights only if a measured gap justifies them.
5. **Reassess after quality testing.** The default change is user-directed and remains unqualified for output quality. Retain `fixed` as an explicit fallback; document negative or inconclusive results without implying a quality gain.

## Proposed qualification criteria

Freeze the exact request set, implementation identity, quality rubric, and numerical tolerances before candidate evaluation. The candidate must preserve prefix conditioning, the H3 coarse contribution, padding, coordinate restoration, and output coverage. Unsupported shapes or missing policy assets must fall back at a request boundary with a recorded reason.

Promotion targets from the reviewed experiment design are:

- At least 5% lower complete-node median latency, with the paired 95% confidence interval for candidate/B1 median ratio below 1.0; report stage timings and p95 as well.
- No p95 latency regression, no new output/indexing/nonfinite failures, and no more than 2% peak-VRAM increase.
- Blinded paired quality scoring with a one-sided 95% lower confidence bound no worse than −0.10 points versus B1 for visual fidelity and temporal/motion quality. Audio alignment and prompt adherence remain separately reviewed.
- Measured reduction in actual executed work and latency after charging feature extraction, routing, selection, packing, launches, and controller costs.

These are proposed gates, not achieved results. A speed or quality claim requires the paired report and resolved run manifest.

## Initial feasibility bounds

The reviewed pilot design caps the first screen at eight B1 requests, eight signature-matched fixed-map pilot clips, eight suffix replays, and 2 GiB of retained feasibility data. Preflight converts those caps into a time allowance; stop at the first request, replay, time, or storage limit. An inconclusive pilot does not authorize extra runs or rented compute. Any broader rule-policy study or final held-out evaluation needs its own frozen allowance.

## Implementation anchors

Source paths are relative to the FastH3 node directory:

- `sol_attn_minimax_v5.py`: producer and spatial mapping.
- `vsa_sm120/reference.py`: reference ranking and sparse attention semantics.
- `vsa_sm120/producer.py`: chunked projection and measurement/emission traversals.
- `vsa_sm120/layout.py` and `vsa_sm120/dispatch.py`: current scalar keep-count contract and production call.
- `runtime.py` and `kitchen_baseline.py`: profile identity and baseline settings.

The Python reference is not evidence of production GPU performance or installed Kitchen ABI support. Keep backend equivalence, policy benefit, and comparison to B1 as separate results.
