# Native Kitchen VC policies (ABI 2)

Experimental, builder-ready source. Parent reported the initial ABI-1 G1 snapshot
compiled on CUDA 13 / Python 3.12 / Torch 2.12.1. **This ABI-2 G4/NVFP4 revision
has not been CUDA-compiled or GPU-validated here.** CPU tests do not establish
compilation, resource fit, MMA execution, quality, or speed.
Parent subsequently reported snapshot-1 tiny diagnostics succeeded on RTX PRO
6000, including VC cold output against Kitchen and warm cached statistics.
Those reported results apply only to the frozen ABI-1 source/artifact.

W4 supplies the native chunk producer/route seam; W5 implements the G1 INT8
control, native G4 clustering/INT8, and an experimental Kitchen-QK/NVFP4-PV policy.
See [G4.md](G4.md) for the controlled arithmetic, schedules and limitations. The parent owns
dispatcher/install integration. The sibling anemoi_native package owns the
Anemoi/combined implementations; the root front door delegates to it.

## Build and artifacts

Use Linux on the builder, nvcc from the CUDA 13.0+ toolchain for SM120, and its C++ toolchain:

    python deploy/custom_nodes/fasth3_deploy/native_attention/build.py --arch 120

The install hook can load build.py by file spec without importing Comfy and call
build(architectures=("120",)). It returns the build-report path. Default artifacts
are libfasth3_native_attention.so, build-report.json and kernels.sass
(when cuobjdump is available). Package the directory with the Python/CUDA source.
FASTH3_NATIVE_ATTENTION_DIR can override the artifact directory.
Logical architecture 120 emits compute_120a/sm_120a for microscaled NVFP4;
the exact compiler command and compiler_architectures are recorded.

The managed worker only loads the prebuilt ctypes library. No runtime compilation,
PyTorch C++ extension, nanobind, or new Python dependency. Compile errors preserve
build-failure.json and raise with the last 16,000 compiler-output characters.

The report records Kitchen revision, every local CUDA/header SHA256, binary
SHA256, architecture list, nvcc version/full ptxas output (registers/spills/shared
memory), optional cuobjdump resources/SASS and explicit unvalidated status.
The loader validates hashes and ABI. resource_report() reads verified evidence
without GPU launch. require_backend("vc", device=None) additionally checks device
support and cubin resource attributes before any launch. Actual static shared
memory/thread limits are checked for producer/route/fine; registers/local bytes
are reported, not construed as performance validation. Inspect all compiler
reports/instructions before rollout. Installed Kitchen is never overwritten.

Validated libraries/provenance and dependency checks are cached per process and
configured artifact path; resource queries are cached per device. Cache hits do
not read/hash files. No tensors are cached. Artifact paths are immutable identities:
use a new versioned directory for a new binary. invalidate_caches() explicitly
resets metadata/dependency validation after source edits; replacing a loaded
binary at the same path requires process restart because dlopen can retain it.

## Interfaces

Parent entry:

    run_chunked("vc", chunks, n, heads, freqs, qk_weights,
                kmean=km, vscale=vs, topk_ratio=0.2,
                sink_blocks=[0,prefix_blocks], sink_q=[0,prefix_blocks],
                block_len=valid, coarse_gate=gate, token_aug=0, tail=False)
    # (BF16 out[1,T,H,128], FP32 next_kmean[H,128], FP32 next_vscale[H,128])

sol_attn_chunked retains Kitchen's original positional ABI and tail=True default.
Both take an optional caller-owned diagnostics dictionary recording executed
policy/counters/workspace bytes, artifact identity and resources. Prefix query
policy is separately reported as original-stock; prefix keys use original carriers.

Split API for other fine kernels:

1. prepare_chunked(Kitchen arguments, chunk_hook=..., calibration_hook=...) returns
   request-owned Prepared. Its option defaults to "vc"; this labels preparation,
   and does not execute fine attention.
2. route(prepared) finishes original statistics once and returns device uint16 IDs
   [1,H,N,N], int32 counts [1,H,N]. Unused ID capacity is undefined.
3. anemoi_routes(prepared) converts IDs to int32 on GPU, masks unused slots to -1,
   and returns IDs/counts/valid counts [1,N]. No routing/ordering changes or host
   route copies. IDs are absolute physical cube IDs.
4. fine(prepared) executes VC. fine(prepared,prefix_only=True) executes stock
   arithmetic only for sink_q blocks; **all other output rows are undefined**.
   This avoids executing two full attention passes for another fine backend.
5. Insert stock prefix into replacement fine output, cast to BF16 [1,T,H,128],
   then call merge_coarse(prepared,out) exactly once. Return prepared.kmean_next
   and (prepared.vamax_next/127*1.1).clamp_min(1e-8). Finally call prepared.close().

Prepared exposes t, h, plan["NTB"/"Tp"/"NPAD"], sinks, sink_queries (half-open
block intervals), lengths (int32), stream, original_vscale and original next
statistics. Repeated route() is rejected because it would divide scratch twice.
All phases use the same current CUDA stream/device. No model/global operand
cache: allocations belong to the request, with PyTorch allocator reuse. Retained
views/callback tensors keep their own storage alive and must be released on
cancellation. CUDA graph capture is not supported.

## Chunk hooks and original statistics

The native producer consumes BF16 fused projection [M,3*H*128] chunks and
applies original RMSNorm/RoPE in the tile. Optional native hook outputs are
contiguous BF16 q,k,v[1,H,M,128]: post-norm/RoPE Q/K and original V, before
Kitchen quantization/centering, never dequantized Kitchen INT8.

chunk_hook(t0,q,k,v,valid_counts) runs on the producer stream during the final
traversal only. t0 is a physical slot offset in Kitchen cube order; valid_counts
is full int32 [1,N]. Slice t0//64 through ceil((t0+M)/64). Final M may be partial;
downstream packers may pad this bounded chunk to 64. Consume immediately, never
retain all chunks or materialize full-sequence floating-point QKV. Validate
64-aligned starts/nonfinal sizes and exact coverage before native launches.

Bootstrap requires a replayable factory; it traverses twice like Kitchen, without
silently collecting all projection chunks into a list. Cached calls traverse once.
calibration_hook(vamax,vscale,measured) runs before final production: fresh
original absmax is supplied from the existing bootstrap traversal, or stale
vscale*127/1.1 on cached calls. Minimum-scale clamping cannot be inverted at zero.
Anemoi can use vamax/2.25 with its zero-channel policy for global bootstrap scaling
without extra projections. Fresh global calibration on cached calls is not
claimed. Residual statistics never replace original coarse sums/rolling K/V stats.

## Layout and arithmetic

B=1, D=128, cube capacity=64. Q: INT8 [1,T,H,128], perm_d channels, FP32
per-token/head scales. K: INT8 [H,Tp,128], perm_key rows and perm_d channels,
adjacent FP32 scale/bias pairs [H,Tp,2]. Original V and residual V are separate
INT8 [H,128,Tp] buffers with perm_d on the key axis within each cube, staged into
Kitchen's XOR-swizzled shared tile. Original V scale: FP32 [H,128].

residual_metadata() exposes canonical BF16 means and FP32 scales
[1,H,N,1,128], G=1. Mean = BF16(FP32 live sum/live count); subtract that same
represented mean in FP32. Scale = max(absmax(residual)/127,1e-8); quantization
is nearest-even/clamp ±127. Invalid residual rows are zero. Metadata stays per
cube/channel. Protected keys ignore residual metadata and use original V/global
scale. Protected queries use original arithmetic/global-scale epilogue throughout.

The exact loop preserves Kitchen QK/masks/routes/order/full-range U8 P and the
represented-P denominator, including its block-max/running-max rescale policy.
For each unprotected cube the real-unit numerator receives
INT32_MMA(P8,R8)*block_scale + sum(P8)*BF16_mean. The same alpha rescales both
prior numerator and denominator. Both carry U8 mass: no extra 255 factor.
Per-cube scales are applied before the next cube, not in the final epilogue.

With pooled tail enabled, the original BF16 handover numerator converts from
global-scale units to real V units; protected queries retain original handover.
Primary VSA uses tail=False. The learned coarse output remains separate:
original pooled Q/K/V, BF16 fine cast, then original Kitchen coarse/addcmul order.

## Tests and unsupported parts

    python -m unittest discover -s tests -p test_native_vc.py -v

Pure-stdlib oracle/ABI tests cover represented means, 1/63/64 valid rows,
zero/constants/outliers, unequal block means/scales, maximum changes, nonidentity
routes, poisoned unused capacity, stock prefix arithmetic and artifact failures.
The oracle models real arithmetic, not exact CUDA exp2/FMA rounding or MMA layout.

diagnostics.tiny_check(device="cuda") is an **explicit GPU action** for a separately
authorized worker. It compares constant-value VC, stock prefix and next stats
against Kitchen on 1/63/64 live rows. It has not been run here. Mixed-value native
oracles, captured source-pair/coarse/tail checks, resource/instruction review,
performance, repeated-request memory, real H3 quality and promotion remain open.

Unsupported: token_aug>0, empty cubes, B>1, D!=128, non-BF16 projections,
nonreplayable bootstrap iterables, FP8 PV, ExpCast, and mixed precision transitions
inside the VC-only loop. G4/NVFP4 source exists but requires a new builder/tiny
diagnostic cycle. INT8 centering alone claims no speedup; lower-bit instruction
use likewise does not prove an end-to-end gain.

## License/provenance

Kitchen v0.2.34, revision e5e0d020e2add85f50466bb79171bc04ef7492b6.
Only producer, preprocess/finish, route, exact, layout and MMA files for this
chunked path are vendored. VENDORED.json records original hashes/modifications.
Apache-2.0 LICENSE and full upstream NOTICE are retained. Modified sources mark
their changes. Custom bridge/build/runtime code is Apache-2.0.
