# Canonical worker artifacts

Production worker source lives in `deploy/custom_nodes/fasth3_deploy` and
`deploy/custom_nodes/comfystream_sol_refiner_h3`. Provider directories contain
build configuration, not maintained copies of these packages.

The initial drift audit found 32 identical files in the H3 Fal node copy and
its canonical package; the Fal conditioning script and environment manifest
were also identical. FastH3 Fal contexts were absent (generated, ignored).
The redundant H3 copies were removed after assembly tests locked the source
closure and deployment paths.

## Dependency closure

FastH3's production `__init__.py` imports `benchmark.py`, which imports
`benchmark_sampler.py`, `benchmark_output.py`, and the video/audio stages.
The shipped workflows use `FastH3BenchmarkSampler` and `FastH3BenchmarkOutput`.
Their names do not make them disposable benchmark tools. Assembly includes the
complete package source, native CUDA headers/kernels, vendored implementations,
requirements, licenses, runtime configuration and existing Fal locks. It excludes
examples, hidden environments/caches, compiled outputs, arbitrary JSON files,
credentials, and model weights. The FastH3 profile also includes the maintained
`comfystream_drama3` production nodes consumed by the B1 deployment. The H3
profile includes its isolated worker, SoL pipeline, installer, conditioning
support, worker requirements input/lock, and published requirements. Host locks
and the ComfyUI requirements snapshots are included in each matching artifact
digest. No dependency is added or changed by assembly.

## Build and verify locally

From the repository root, stage the exact profile consumed by each Dockerfile:

```sh
python scripts/prepare_worker_fal_context.py --profile fasth3
python scripts/prepare_worker_fal_context.py --profile fasth3 --check
python scripts/prepare_worker_fal_context.py --profile h3-upscaler
python scripts/prepare_worker_fal_context.py --profile h3-upscaler --check
```

The established `python scripts/prepare_fasth3_fal_context.py` command delegates
to the same FastH3 assembler for B1. Experimental Drama3 contexts keep their
existing independent preparation path. The two targeted Dockerfiles require
`context/comfystream`, validate its manifest before installing dependencies,
and install custom nodes from that staged source. A fresh checkout cannot
build successfully without assembly. Run `--check` immediately before a build;
it detects source drift, altered/missing/extra staged files, permissions, and
symlinks. The container also verifies the staged files against the staged
manifest; detecting edits made outside its context requires the local check.

For an existing Vast/ComfyUI host, bootstrap assembles and verifies profile
`vast` locally before copying nodes into ComfyUI. Standalone ComfyUI staging:

```sh
python scripts/assemble_worker_artifact.py --profile vast \
  --destination .comfystream/worker-artifact
python scripts/assemble_worker_artifact.py --profile vast \
  --destination .comfystream/worker-artifact --check
```

These assembly commands use the standard library and local files only. They
do not deploy, start workers, install packages, access the network, download
weights, or capture environment variables. GPU image builds and normal runtime
installers retain their existing network/dependency behavior.

## Identity and compatibility

`worker-manifest.json` records sorted file SHA256 values and executable bits,
runtime pins, model revisions/hashes, separate `code_digest` and `asset_digest`,
and an `artifact_digest` over the complete identity. No timestamp, absolute
path, Git working-tree state, or credential enters these digests. File timestamps
and modes are normalized. Code identity includes the build recipes and existing
locks. Changing only environment model hashes changes asset identity without
changing code identity. Model pins embedded in executable source affect both.

The artifact includes `comfystream_worker_identity`, a ComfyUI extension using
`PromptServer.instance.routes.get`. Its existing server exposes
`GET /comfystream/worker_identity`, returning the loaded build identity,
compatibility node IDs, and a per-process `runtime_instance_id`. It returns
`asset_binding: declared-build-inputs`: declared assets are not proof that every
weight has been loaded or rehashed on the current model volume. Existing
model validation remains required. The static node metadata at
`GET /object_info/ComfyStreamWorkerCompatibility` describes the same loaded
build. An unstaged source-only load advertises `status: unassembled`; it must
not be accepted as a verified artifact. No coordinator local v1 envelope changes.

Compatibility metadata identifies the ComfyUI prompt/history protocol and the
shipped generator/output/upscaler node IDs. This is a capability declaration,
not GPU qualification or a promise that every workflow is compatible. Pin the
endpoint, artifact and process identity when admitting new work. A replacement
worker may receive new work only after admission checks. Accepted or uncertain
jobs keep their original prompt/worker binding and must be reconciled against
that original worker; a replacement is never a reason to resubmit them.
Drain the old worker's accepted queue before retiring it. Assembly never
changes queue state or routes an in-flight request.

The current compatibility gaps are weight-load attestation and live GPU/image
qualification. Neither is claimed by the offline manifest tests. Existing
experimental build profiles remain outside this artifact migration.
