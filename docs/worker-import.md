# Worker source import

## Source and scope

The actual ComfyStreamer repository is
`/Users/stale2000/comfy/comfystream` (README names it ComfyStreamer).
`/Users/stale2000/comfy/comfystreamerh3` is a separate node repository; the
current Trim five-step integration and independent SoL upscale path were
read in the main repository and copied from its canonical worker packages.

Imported source Git HEAD:
`090e4557fab9cf5ca045e3318e7287b4257bd119`. The source working tree was
already dirty. The import includes the current reviewed working-tree bytes
and preserves per-file source/current SHA256 records in
`vendor/comfystream/import-manifest.json`.

The existing stdlib assembler's combined `vast` profile is the smallest
existing maintained profile containing both generation and upscaling. Its
name describes the upstream profile, not a SlopTogether hosting decision.
The curated worker artifact is in `vendor/comfystream/runtime/`. Its provenance
manifest records 282 packaged files, including imported source, generated
workflow references, and local runtime additions. The local patch manifest
records the Ada FP8 profile and SoL attempt-scope changes. Seven imported SoL
files carry both their original source hashes and patched hashes; the
output-scope patch chain is recorded separately. See
`vendor/comfystream/local-patches.json` for the patch boundary and qualification
status. No dependencies were installed or added to the SlopTogether app.

Included worker packages, under `runtime/deploy/custom_nodes/`:

| Package | Reason retained |
|---|---|
| `fasth3_deploy` | Current optimized Trim/FastH3 sampler, conditioning, VAE decode, streamed NVENC output and its kernel/runtime dependency closure. |
| `comfystream_sol_refiner_h3` | Independently callable video upscaler, isolated persistent worker, pinned SoL pipeline and runtime installer. |
| `comfystream_worker_identity` | Artifact/process identity endpoint and compatibility metadata. |
| `comfystream_drama3` | Declared dependency of the upstream generation build profile; retained to preserve the existing artifact/build closure. Not required as a user-facing SlopTogether feature. |

The two existing Fal **Dockerfiles**, staging-script references, GPU
environment notes and generated workflow snapshots are under `reference/`.
The upstream app configuration files are separately preserved at
`runtime/deploy/fal/fasth3-b1/pyproject.toml` and
`runtime/deploy/fal/h3-sol-upscaler/pyproject.toml`, with their matching locks
and requirements snapshots. There are no app `pyproject.toml` files under
`reference/`. These separate trees are integration inputs, not a ready-to-run
Fal deployment directory: the Dockerfiles retain upstream context paths and
the staging-script references retain their upstream root assumptions. New
SlopTogether app names, staging layout and authenticated job integration must
be prepared before deployment.
The root MIT license and third-party notices are retained. Specifically,
`licenses/` includes `LICENSE.apache-2.0`, which the upstream assembler's
suffix allowlist otherwise omits.

The original OBS integration, desktop UI, coordinator, old playback service,
frontend, project assets, generated videos, benchmark results, models,
environments, credentials, and cached deployment contexts were excluded.
The trainer node, learned-router code and unreferenced helper modules were
removed from the release package. Generation and upscaling dependencies and
node mappings used by the worker recipes remain.

## Existing generation contract

- Preset: `fp4-mlp-fused-fasth3-trim-5step-vsa20-b1-candidate`.
- Model: `fastvideo_fasth3_trim_8step_int8_convrot.safetensors`.
- Five sampler steps, `res_multistep`, VSA retention 0.20. This is explicitly
  an exploratory subsampled schedule from a checkpoint distilled for eight
  steps; import does not qualify its quality.
- Existing optimized workflow uses `FastH3OptimizedLoader`,
  `ComfyStreamerH3ImageToVideo`, `FastH3BenchmarkSampler`,
  `FastH3BenchmarkVAEDecode`, `FastH3BenchmarkVAEDecodeAudio`, and
  `FastH3BenchmarkOutput`, with `ClipProjApply` from a separately pinned
  upstream ComfyUI-ClipProj installation.
- The conditioning node accepts `first_frame` and `last_frame`, optional
  image references and audio references. These are model conditioning,
  not a promise that encoded endpoint pixels exactly equal supplied frames.
- The provided reference graph uses 448 x 256, 362 frames, and 24 fps.
  That is **15.083333 seconds**, not exactly 15 seconds. The native frame
  grid is `17*n + 5`; scheduling must use actual encoded duration or add
  an explicit conformance stage with endpoint handling.
- `retain_final_frame_only=true` streams the complete decoded clip to the
  encoder while retaining only the actual final decoded image for continuity.
  It must not accidentally turn a video into a one-frame result.
- The new timeline should use the actual accepted prior endpoint as the
  next clip's start reference. Hard boundary equality and separately
  upscaled boundaries require new conformance/continuity validation.

Evidence: `runtime/deploy/custom_nodes/fasth3_deploy/runtime.py`,
`conditioning.py`, `benchmark_video.py`,
`reference/workflows/trim-five-step-first-last-frame.api.json` and the
upstream pure workflow-builder identity in
`reference/workflows/provenance.json`.

## Existing upscaler contract

- Node: `ComfyStreamMiniMaxH3SoLUpscaler`; an independent MP4-in, MP4-out
  stage. It performs one refiner step.
- Model: `Efficient-Large-Model/SoL-Refiner-LTX-2.5-for-MiniMax-H3`, revision
  `4655337474c1c77fb52e9ac55111552e625e779c`.
- Current live path: `pruna_fast` decoder, `nvenc`,
  `cache_conditioning=true`, fixed preservation prompt, NVFP4 transformer.
  The cached conditioning omits text encoder/tokenizer/connectors during
  loading; changing the prompt requires a matching conditioning identity.
- Target dimensions must be positive and even, no smaller than input,
  and preserve its exact aspect ratio. The node's UI schema bounds width
  to 64–3840 and height to 64–2160. The reference graph uses **1162 x 664**
  for a 448 x 256 source (both 7:4). The node's 1184 x 666 default is 16:9
  and cannot be used directly for that 7:4 source.
- SlopTogether's public base clips are 1280 x 720. The worker profile
  overrides the reference dimensions to **1920 x 1080**, preserving 16:9 and
  ensuring it cannot silently downscale a published clip. That 1080p SoL
  result still requires hardware qualification; it is offered only to the
  Blackwell/96 GB class profile below.
- The current model runtime keeps the pipeline on CUDA and explicitly
  disables CPU offload. CPU text encoding and a cached fixed prompt can
  reduce memory but are not transformer offload.
- The SlopTogether worker supplies a server-generated job/attempt scope. The
  node keeps its refined MP4, request, report and chunk intermediates under
  that scoped ComfyUI output directory; after downloading the published
  attempt result, the worker removes the whole attempt directory, including
  the node's internal SoL work folder and sidecar reports. The worker refuses
  upscale capability unless the Comfy node exposes this scope input.
- The alternate diffusion decoder uses spatial/temporal tiling (768/512
  spatial minimum/stride, 128/80 temporal minimum/stride) and requires
  native NATTEN. Its documented Flex fallback can allocate a 91 GiB mask.
- Separate generation and upscale workers communicate through saved
  media. Neither the old same-host shared-VAE experiment nor direct
  GPU-to-GPU tensor transport is a distributed volunteer-worker protocol.

Evidence: `runtime/deploy/custom_nodes/comfystream_sol_refiner_h3/node.py`,
`model_runtime.py`, `fp8_optimizations.py`, `runtime.json` and
`reference/workflows/sol-upscale-standard.api.json`.

## RTX 4090 and downloadable-worker qualification

The imported deployment is a Linux/Python 3.12/CUDA 13 environment targeting
the existing RTX PRO 6000 cloud path. It is **not qualified for a 24 GB
RTX 4090**. A Windows client can now connect to a Linux ComfyUI backend in
WSL2, but that path is also unqualified. The imported kernels include Ada
(`sm89`) paths, but kernel presence is not proof that the full workflow fits
or runs.

The upstream upscaler's NVFP4 and MXFP8 implementations require Blackwell
(SM 10.0+). A local SlopTogether patch now adds TorchAO per-row FP8 dynamic
quantization for SM 8.9+ and Diffusers sequential CPU offload, selected through
the `auto` workflow profile. Low-VRAM upscale workers require 24 GB VRAM, 22
GiB free VRAM and 128 GiB system RAM before they can claim the recipe. Large
Blackwell cards retain the existing resident NVFP4 path when 94 GiB total and
90 GiB free are available. The exact local patch and source hashes are in
`vendor/comfystream/local-patches.json`.

This is an implementation candidate, not a qualification: no WSL2 RTX 4090
run, install, peak-memory trace, output quality comparison or latency
measurement has been performed. The imported Fal/Linux build still targets
its prior RTX PRO 6000 environment, and the Windows one-file launcher does not
install WSL2, ComfyUI, the Comfy node/runtime or model files.

The local executable needs its own hardware-qualified capability profiles:

1. Qualify the new per-row FP8 and sequential-offload path on a WSL2-backed
   RTX 4090; keep Blackwell-only kernels behind capability checks.
2. Start generation at 448 x 256, batch size one and one active job per GPU.
   Stage model components by phase; retain streamed decode/final-frame output.
3. Measure model-load, conditioning, sampling, VAE decode and encode peaks,
   including reserved CUDA memory, temporary conversion buffers and CPU RAM.
4. Measure the 128 GiB host RAM gate against actual checkpoint-loading peak.
   If model loading exceeds it, add verified disk-backed staging or a smaller
   supported profile; do not weaken the admission checks.
5. Reserve configurable headroom for Windows/display/OBS and stop claiming
   work when measured free memory is below the profile budget. OOM recovery
   should release the lease and offer a smaller approved profile, never
   silently alter an accepted job's recipe.
6. Download signed, versioned runtime/model packages with hashes and license
   notices. Reuse cached model files; do not bundle model weights or source
   repository virtual environments inside the executable.

A two-GPU trusted cloud setup can pin generation to one runner and upscale
to another. A user's one-GPU executable should run those stages serially
and unload the previous stage when switching; it must not load two full
pipelines simultaneously. Windows packaging, model redistribution rights,
24 GB memory performance and driver compatibility remain release gates.

## Verification performed

Offline checks used the existing Python 3.12 source environment; they did
not install dependencies, load CUDA, download weights or start providers.

- Existing assembler's `vast --check`: passed against the vendored runtime.
- 20 focused upstream CPU tests passed, one full-repository deployment test
  deselected because it requires uncopied Vast/host files. These cover
  deterministic assembly, artifact drift/content/permission/symlink checks,
  source dependency closure, model/code identities, compatibility metadata,
  identity route registration and the five-step sigma contract.
- All 282 manifest file hashes matched.
- 173 runtime Python modules parsed under Python 3.12; 341 relative imports
  resolved within the copied source closure.
- Both generated workflow reference graphs have valid node links: 13 nodes
  for initial generation and 3 for upscale.

These are the exact assembler and test commands run, from
`/Users/stale2000/Documents/ChatGPT/SlopTogether`:

```sh
PYTHONDONTWRITEBYTECODE=1 /Users/stale2000/comfy/comfystream/.venv/bin/python -B \
  vendor/comfystream/runtime/scripts/assemble_worker_artifact.py \
  --profile vast --destination vendor/comfystream/runtime --check

PYTHONDONTWRITEBYTECODE=1 \
  PYTHONPATH=vendor/comfystream/runtime:vendor/comfystream/reference/tests \
  /Users/stale2000/comfy/comfystream/.venv/bin/python -B -m pytest -q \
  -p no:cacheprovider \
  vendor/comfystream/reference/tests/test_worker_artifact.py \
  vendor/comfystream/reference/tests/test_fasth3_trim_5step_contract.py \
  -k 'not targeted_docker_and_vast_profiles_consume_canonical_stage'
```

The assembler exited 0 without output. Pytest reported:

```text
....................                                                     [100%]
20 passed, 1 deselected in 2.80s
```

The manifest, Python syntax/relative-import closure and graph-link check used
this standalone Python command in the same directory:

```sh
PYTHONDONTWRITEBYTECODE=1 /Users/stale2000/comfy/comfystream/.venv/bin/python -B - <<'PY'
import ast, hashlib, json
from pathlib import Path
base = Path('vendor/comfystream')
manifest = json.loads((base / 'import-manifest.json').read_text())
for entry in manifest['files']:
    path = base / entry['path']
    assert hashlib.sha256(path.read_bytes()).hexdigest() == entry['sha256'], path
runtime = base / 'runtime'
parsed = 0
imports = 0
for path in runtime.rglob('*.py'):
    tree = ast.parse(path.read_text(), filename=str(path))
    parsed += 1
    for node in ast.walk(tree):
        if not isinstance(node, ast.ImportFrom) or not node.level:
            continue
        parent = path.parent
        for _ in range(node.level - 1):
            parent = parent.parent
        if node.module:
            ref = parent.joinpath(*node.module.split('.'))
            candidates = [ref.with_suffix('.py'), ref / '__init__.py']
            assert any(candidate.exists() for candidate in candidates), (
                path, node.lineno, node.module, candidates
            )
        else:
            for alias in node.names:
                ref = parent / alias.name
                assert ref.with_suffix('.py').exists() or (ref / '__init__.py').exists(), (
                    path, node.lineno, alias.name
                )
        imports += 1
for path in (base / 'reference/workflows').glob('*.api.json'):
    graph = json.loads(path.read_text())
    for key, node in graph.items():
        for name, value in node['inputs'].items():
            if (isinstance(value, list) and len(value) == 2
                    and isinstance(value[0], str) and isinstance(value[1], int)):
                assert value[0] in graph, (path, key, name)
    print('Workflow links valid:', path.name, len(graph), 'nodes')
print('Manifest SHA256 valid:', len(manifest['files']), 'files')
print('Python AST valid:', parsed, 'modules; relative imports resolved:', imports)
PY
```

Its recorded output was:

```text
Workflow links valid: trim-five-step-first-last-frame.api.json 13 nodes
Workflow links valid: sol-upscale-standard.api.json 3 nodes
Manifest SHA256 valid: 282 files
Python AST valid: 173 modules; relative imports resolved: 341
```

For a portable equivalent, substitute an existing Python 3.12 interpreter
for the absolute source-environment interpreter path; the pytest command
also requires pytest in that environment. The assembler and standalone
integrity command use the standard library only. This documents the actual
offline evidence; it does not establish CUDA/runtime import compatibility.

The copied five-step test changes only its repository-root lookup to point
to `runtime/`. Generation kernels, remaining node mappings, dependency pins and
sampler settings remain; the removed trainer and unused modules are recorded
in the curated import manifest. The SoL Ada profile change is recorded
separately in the local-patch manifest. GPU inference, Fal image builds, live
endpoint identity, decoder quality, boundary fidelity, executable installation,
4090 memory and throughput were not tested and are not claimed.
