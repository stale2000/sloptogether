# Follow-up plan review

Date: October 23, 2026. **Original verdict: revise four details before treating the timeline and worker contracts as settled.** All four requests have since been addressed and independently rechecked; see [the current fix review](plan-fix-review.md). The original findings below are retained as review history.

At the time of this review, two separate reviewers assessed timeline/runtime delivery and security/payment/upload/hosting behavior, and the main agent recorded recommendations without editing the proposed contracts. The subsequent plan-fix report records the corrections now made to those documents; the application itself remains unimplemented.

## Findings

### [P2] Separate requested and resolved endpoints in continuation mode

Source: `.omx/plans/sloptogether-plan.md:118`, `:133`, `:136`.

The segment model expects two boundary revisions, continuation mode discovers its end frame from a render, and changed boundaries invalidate that render's input revision. Filling the discovered endpoint back into the immutable generation inputs can therefore supersede the very job that produced it.

Define an immutable nullable `requested_end_boundary_id` separately from artifact-derived `resolved_end_boundary_id`. Accepting the output endpoint must not modify its originating job's input digest. Replacing the accepted output must explicitly invalidate/fence downstream jobs that consumed its resolved endpoint. Add a test covering continuation completion, next-job creation and upstream replacement.

### [P2] A fork must preserve or regenerate its incoming junction

Source: `.omx/plans/sloptogether-plan.md:169`; boundary rules at `:130`–`:136`.

The ten-minute-ahead example offers a new fork when a new start image conflicts with a locked predecessor. If the fork simply begins at that edited slot, the predecessor still ends on a different image, so the new branch is discontinuous despite having distinct revision IDs. The same issue occurs when a changed branch rejoins an old suffix.

Define fork entry/rejoin rules: start from an unchanged shared boundary and regenerate the affected incoming/outgoing transition, or mark the operation as an intentional discontinuous seek. Extend the fork acceptance case to check both visible joins, not just stale-job rejection.

### [P2] Make sustained fresh output a pass/fail capacity gate

Source: `.omx/plans/sloptogether-plan.md:387`; `.omx/plans/sloptogether-test-spec.md:60`.

A 60-minute playback run can succeed by consuming a large prebuffer while generation or moderation produces less than one approved second per second played. The test currently requires reporting capacity below1x, but does not make it a failure of the continuous-fresh-output claim.

Choose a measurable throughput/headroom target and minimum approved-buffer floor. Require a nondepleting buffer over the qualification window, including trusted validation and moderation capacity. If that gate fails, label the qualified mode buffered playback with fallback, and calculate required worker counts/quality reductions rather than claiming sustained fresh generation.

### [P2] Bound volunteer lease renewal and account claims

Source: `.omx/plans/sloptogether-plan.md:263`.

Heartbeats can extend a lease, but no hard maximum attempt lifetime or per-account active-claim cap is specified. A malicious or broken donor can hold imminent work indefinitely while continuing to send heartbeats. Fencing prevents stale completion after reassignment, but does not force reassignment while renewal continues.

Set a server-enforced absolute attempt deadline that heartbeats cannot extend, stage/hardware-appropriate upload grace, per-Twitch-account/channel concurrent-claim limits, and a cooldown or trust reduction for repeated nonproductive claims. Add a test proving an indefinitely heartbeating worker loses its fenced lease and a healthy worker receives the replacement.

## Areas with no additional actionable finding in this pass

The existing plan explicitly qualifies 4090/Windows support instead of claiming it, distinguishes canonical anchors from generated endpoint fidelity, and keeps human moderation for volunteer media. Earlier fixes for unknown provider IDs, Bits transaction ambiguity, upload overwrite races and host-cookie filtering remain present. This review does not establish production security, paid-product approval, GPU performance or installer compatibility.

## Code imported alongside this review

The dependency-complete ComfyStreamer worker snapshot remains in `vendor/comfystream/` (295 manifest entries). The additional bounded ClipsGG snapshot is in `vendor/clipsgg/`: 11 exact routing/auth-boundary/R2 reference files, source revision and per-file digests. It is not a copied full application or a SlopTogether deployment. Both source repositories remain untouched.

Checks for the new snapshot: all 11 digests verified and eight TypeScript modules parsed with TypeScript6.0.2. Existing worker manifest integrity was checked separately. No application tests, GPU inference, installations or deployments were run for this review/import task.
