# Isolated Anemoi arithmetic adapter (ABI 4)

Experimental W6/W7 source implementation. **Advanced source is not GPU validated or promoted.**
The parent reports that the first INT8/G1 snapshot compiled under CUDA 13 /
Python 3.12 / Torch 2.12.1, and that INT8/combined-G1 cold/warm tiny checks
passed on RTX PRO 6000 within 0.12 versus Kitchen. These are parent-reported
control checks, not validation of the later mixed/G4 source or full workloads.
The first snapshot uses ABI 1; this expanded native argument contract uses
ABI 4. Rebuild the extension rather than mixing either snapshot's files.
Native compilation, ptxas resource/spill review, SASS inspection and numerical
execution on SM120 must pass before model deployment. CPU tests cannot establish
any of those properties. No runtime JIT, public Anemoi router, serving stack,
Triton FP32 replacement, or silent fallback is included.

## Provenance and changes

Minimal attention headers/primitives are vendored from
[Anemoi 270ddf8c3f0a43be47cf586873e7758bc76b822d](https://github.com/anemoi-project/anemoi/tree/270ddf8c3f0a43be47cf586873e7758bc76b822d).
The checkout was verified by `git rev-parse HEAD`. The upstream Apache-2.0
license is in `vendor/LICENSE`; source notices credit Anemoi, SpargeAttention
and SageAttention contributors. No upstream NOTICE file was present.

Modified upstream files are explicitly marked:

- `q64_attention.cuh`: optional G1/G4 block-scale/represented-P mean correction
  helper over the original E4M3 Tensor Core PV operation.
- `q64_attention_phase_composer.inl`: calls that helper for all three INT8
  pipeline positions; phase exit applies the probability conversion once.
  NVFP4 tail masking uses negative infinity.
- `primitives/qattn/attn_utils.cuh`: float padding masks use negative infinity;
  a finite score sentinel multiplied by very small QK scales otherwise fails
  to suppress padded keys in early INT8 pipeline positions.

`csrc/prepare.cu` and `nvfp4_prepare.cu` adapt upstream preparation into bounded
post-norm/RoPE chunk writes. No full FP QKV is materialized for INT8 or NVFP4.
The FP16 control naturally retains full FP16 operands and is explicitly a
correctness/control phase, not a low-bit memory-preservation claim.

## Install artifact

Run `python anemoi_native/build.py --arch 120` on the Linux CUDA builder using
the deployment Python and PyTorch versions. Or load `build.py` by importlib
file spec and call `build(output_dir=None, architectures=('120',), nvcc=None)`.
Defaults write the extension and `build-report.json` into this package.
Copy both, along with sources, into the worker package. The CUDA 13.0+ toolchain
and a C++20 compiler are required **on the builder only**. PyTorch 2.14 headers
require C++20. The build does not load the
resulting extension or launch GPU work. It records ptxas output and optional
cuobjdump resources/SASS; failures include the final 16000 compiler-output chars.

The binary has an `$ORIGIN` runtime path, never a builder venv path. Runtime
imports PyTorch first to load its libraries from the actual worker installation.
Before import, cached checks compare manifest ABI/revision, complete native
source hashes, binary hash, Python extension suffix, and PyTorch/CUDA/C++ ABI.
The extension itself also reports the expected ABI and revision.

## API and layouts

`allocate(B,H,blocks,device,phase='int8',centered=False,prefix_blocks=0,
prefix_start=0,groups=1,global_scales=None)` creates request-owned storage.
Q/K block counts are equal in this self-attention workspace. `set_global_vscale`
must be called with original pre-centering `[B,H,128]` V absmax before plain
INT8 preparation. Fresh bootstrap maxima retain the upstream `/2.25` channel
domain. Cached Kitchen calibration is explicitly marked stale and approximate;
it is not presented as fresh upstream calibration. Zero channels use scale 1
and zero carriers to avoid division by zero.

`prepare_chunk(workspace,q,k,v,valid_counts,block_offset)` consumes bounded
post-norm/RoPE FP16/BF16 `[B,H,M,128]` chunks in Kitchen physical cube order.
Only the final partial M is padded within that chunk. Valid lengths are int32
`[B,ceil(M/64)]`, with a shared 1-D broadcast accepted. Invalid rows are excluded
from reductions and written as zero. BF16 inputs narrow through FP16 like the
pinned donor preparation. The prefix KV interval `[prefix_start,prefix_blocks)`
is uncentered and uses original V values. Reusing or overlapping a written block
requires a fresh workspace. All phases enforce the original current CUDA stream.

| Phase | Q/K | V | Scale metadata |
| --- | --- | --- | --- |
| INT8 | signed bytes `[B,H,S,128]` | E4M3 bytes `[B,H,128,S]` | Q/K FP32 `[B,H,blocks]`; original V global FP32 `[B,H,128]` |
| Combined INT8 | same | E4M3 residual bytes, same physical layout | BF16 means and FP32 scales `[B,H,blocks,1,128]` |
| NVFP4 control | packed uint8 nibbles `[B,H,S,64]` | packed uint8 `[B,H,128,S/2]` | Q/K E4M3 `[B,H,S,8]`; V E4M3 `[B,H,blocks,128,4]`; three positive FP32 tensor scales `[1]` |
| FP16 control | FP16 `[B,H,S,128]` | FP16 `[B,H,S,128]` | none |

INT8 V token address is `block*64 + v_physical_row(local_token)`, with
`v_physical_row(t)=floor(t/16)*16+floor((t%16)/8)*2+
(floor((t%16)/2)%4)*4+t%2`. This is **not** Kitchen's packed INT8 V layout.
The native pack helper produces it; do not reinterpret Kitchen carriers.
NVFP4 K uses the upstream involutive K32 token permutation; V packs natural
adjacent tokens, low then high nibble. NVFP4 microscales remain in upstream
physical layout and are not interchangeable with INT8 channel scales.

`fine_attention(workspace,route_ids,phase_counts,valid_k_counts=None,
valid_q_counts=None,original_metadata=None,prefix_query_mask=None,
stock_prefix_output=None,softmax_scale=128**-0.5)` accepts original absolute
int32 route IDs `[B,H,Qblocks,capacity]`, and one phase-count entry such as
`{'int8': counts}` with int32 counts `[B,H,Qblocks]`. Lengths are int32
`[B,blocks]` or shared `[blocks]` and must match preparation. Capacity is padded
to Kblocks for the upstream LUT stride. Active IDs and ordering are unchanged;
unused slots are ignored. Empty count rows produce zero output and -inf LSE.
Active routes into zero-live key blocks are rejected rather than producing NaN.
No quotas, route selection, forced-neighbor changes, or dense warmup are applied.

The result has normalized `output`, `lse`, `original_metadata` returned by
identity, and `execution` diagnostics. Protected query mask `[B,Qblocks]`
suppresses native fine work and restores caller-supplied stock Kitchen output
`[B,H,Q,128]`; its LSE is not supplied by Kitchen and remains -inf. The parent
owns original coarse merge and its BF16 rounding. The public diagnostic path
retains data-dependent checks. The internal trusted Kitchen path performs
shape/device/dtype checks without `.item()`/`bool(tensor)` reductions; native
device assertions validate counts, active IDs and lengths. Function-resource
queries are cached per device/kernel. No trusted flag weakens artifact checks.

## Numerical policy

Primary INT8 retains native INT8 QK and E4M3 P/V Tensor Core MMA with a
stage-local FP16 PV accumulator. Q/K scale is `amax/127+1e-7`, integer rounding
away from zero. Probability is `E4M3(exp2(z-m+8.807))`; phase conversion uses
literal beta `0.0022326917`. Denominator uses pre-quantization probability mass.

Combined G1 subtracts a represented BF16 block mean, quantizes the residual
with a block/channel FP32 scale, and applies that scale to stage PV **before**
adding the next block. It decodes the actual packed P bytes for the mean mass.
Residual PV and mean correction enter the same persistent numerator, so every
running-max rescale applies to both. Phase exit applies beta to numerator and
denominator exactly once. Constant V therefore gives
`V * sum(represented_probability)/sum(prequant_probability)`, not necessarily V.
Prefix KV means are zero. This is a distinct residual policy, never mislabeled
as upstream global V scaling.

## Mixed and grouped numerical policies

`fine_mixed` runs NVFP4 -> INT8 -> optional FP16 inside **one** native attention
launch, with one running maximum, denominator and persistent numerator. The
NVFP4 combined helper decodes the actual E2M1 P nibbles and encoded E4M3 P
microscales to compute each natural K16 group's represented mass. It applies
`gV/2688` to residual PV before combining the represented mean term, keeping
the persistent numerator in real units. NV -> block-scaled INT8 multiplies
numerator/denominator by `1/beta` only; INT8 exit multiplies both by beta.
The original global-scaled INT8 control retains its V-domain conversion with
finite positive scale=1 for zero channels. Denominator remains pre-pack mass.

G4 uses canonical means/scales `[B,H,Kblocks,4,128]`. INT8 G4 masks P into four
K16 MMA stages, applies each residual scale before accumulation, and restores
that group's represented-P mean. This is four PV MMA calls per block, with
cost/resource consequences that must be measured. NVFP4 already has native
per-K16 V microscales. Shared Kitchen `grouping_hook` provides a bounded
newslot->source permutation and represented means; only K/V are gathered,
after original routing/coarse metadata is computed. Prefix K/V stays original.
The optional FP16 rescue phase uses original V, not centered V, and is labeled
`original-fp16` explicitly. It needs full FP16 carriers and is not enabled by
the default mixed benchmark policy.

`PrecisionPolicy` exposes two optional quota policies:

- `kitchen-score-head-hamilton-v1`: Hamilton quotas across all selected pairs
  in each head; rank by original Kitchen raw log2 coarse block scores, with
  deterministic `(query ID,key ID)` ties. Remainder ties favor FP16 then INT8
  then NVFP4. Uses the original native score exporter, not new routing scores.
- `kitchen-route-order-head-hamilton-v1`: explicit control using original
  query/slot order as rank. It does not claim a score-based quality benefit.

Both preserve every selected source-token pair and forced neighbor. Within
each query, IDs are compacted in NV/INT8/FP16 execution order. Protected query
rows are excluded from quotas and use exact stock Kitchen output.

## Kitchen front door and calibration

`run_chunked(option,chunks,*KitchenArgs,diagnostics=None)` and
`require_backend(option)` are the integration entry points for `anemoi` and
`combined`. They use Goodall's native Kitchen bootstrap calibration hook,
post-norm/RoPE chunk hook, original routes, stock prefix-query kernel, original
next-call statistics, and one original coarse merge. Default
`attention_kernel_policy='int8_control'` retains `anemoi-int8-global-v1` or
`combined-int8-g1-v1`. Explicit `attention_kernel_policy='mixed_fp4'` enables
the provisional `mixed-fp4-50-50-v1` configuration: score-ranked 50% INT8 /
50% NVFP4, zero FP16, so no full FP16 QKV allocation. Advanced diagnostic
`precision_policy=PrecisionPolicy(...)` can override ratios/ranking.

`native_state` is caller-owned per request/layer and cleared by the caller on
request exit; the adapter never caches tensors globally. `grouping_policy`
accepts `none`/`g4`, and `grouping_schedule` accepts `all_steps`/`first_step`
(`first_eval` is the shared-native alias). `evaluation_index` is explicit.
G4 first-step mode retains the scoped permutation, then uses uncentered values
with fresh scales on later evaluations; the shared producer owns grouping.

`CalibrationCollector.measure` is attached to the **existing** bootstrap
measurement traversal. It reduces actual post-norm/RoPE Q/K absmax and original
or represented-mean-subtracted V absmax, excluding invalid slots. No extra
projection pass or full-QKV retention is introduced. `scales_from_amax` uses
`g=max/(6*448)` (at most one upward ULP if its rounded range undershoots the
observed maximum) and finite scale 1 for zero maxima. Bootstrap represented means
are reused for final combined preparation so the measured residual matches.
Optional `nvfp4_range_margin=2.0` (or `PrecisionPolicy.range_margin` for an
explicit policy) expands the measured range before division. It is reported as
`mixed-fp4-50-50-margin2-v1`; margin 1 retains the earlier version. The margin
can reduce rolling clipping but changes underflow/quantization precision and
requires its own quality comparison. No margin is added silently. CPU tests
exercise fresh measured maxima that would otherwise round below their boundary.

On later calls, fused NV packing records actual Q/K/(residual)V maxima and
int64 clipping counts on device. State retains those three maxima for the next
call; rolling calibration is explicitly labeled. Switching centering off uses
the previous original V maximum, not the previous residual maximum. Returned
`nvfp4_clipping_counts_q_k_v` and `nvfp4_calibration_range_ok` are device tensors;
the benchmark owner must read them after synchronization and reject clipped
quality/performance comparisons. This is detection, not silent recomputation
or fallback. Missing calibration state with cached Kitchen operands fails
clearly rather than forcing a traversal that would alter Kitchen calibration.
Caller-specified scales are allowed only with the explicit
`diagnostic_calibration_override=True` front-door option.

Optional `diagnostics['record_stage_timings']=True` records CUDA event boundaries
for preparation (including bootstrap), routing/prefix, fine/quota, and final
coarse/output. It does not synchronize inside attention. The benchmark owner
resolves those events outside the measured call. Full-call benchmarks must
include all preparation, routing, packing, correction, and merge costs.

Not complete / not enabled:

- Compilation of this newer mixed/G4 snapshot and SM120 numerical/resource/
  instruction validation (the first snapshot's success is not transferable).
- GPU verification of NV P-fragment group mapping, phase boundaries, G4 and
  the zero-residual case. CPU algebra tests do not prove Tensor Core rounding.
- Token augmentation, GQA, cross attention, and FP16 residual centering (FP16
  is explicitly an original-value rescue phase).
- Benchmark-gated calibration quality, retained workspace reuse, and measured
  performance acceptance. Grouped INT8's four MMA stages may cost more time.

The homogeneous `fine_attention` API still rejects mixed phase counts; use the
explicit `fine_mixed` interface. Unsupported phase/group combinations, missing
artifacts, or incompatible calibration fail rather than falling back.
CPU tests live in `tests/test_anemoi_native.py`. GPU tests require explicit
`ANEMOI_NATIVE_RUN_CUDA_TESTS=1` and a prebuilt matching extension; never enable
that flag during the no-GPU development phase.
