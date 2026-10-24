# FastH3 Trim five-step default on Fal

This deployment provides the FastH3 B1 runtime on one `GPU-RTXPRO6000` runner,
keeps the app private, and serves the Trim five-step candidate by default. The
five-step sampler is exploratory because Trim was distilled for eight steps.
The app remains private and scales to zero between requests. Supported base B1
VSA nodes now default to adaptive GPU key-budget redistribution with telemetry
off; select `fixed` for the reference route. Benchmark workflows should keep
selecting their comparison arms explicitly.

The source snapshot is staged from the current workspace with:

```sh
python scripts/prepare_worker_fal_context.py --profile fasth3
python scripts/prepare_worker_fal_context.py --profile fasth3 --check
python scripts/prepare_fasth3_fal_context.py
python scripts/prepare_fasth3_fal_context.py --check
```

The generated source manifest records the Git revision, staged-content digest,
Dockerfile and environment-lock digests, base image reference, and model
identities. `--check` is read-only and fails when the staged context no longer
matches its source or manifest. The Python package closure and base image digest
are pinned. Apt package snapshots, native CUDA compiler identity, and target GPU
qualification remain separate pending evidence; see
[`GPU-ENVIRONMENTS.md`](../../GPU-ENVIRONMENTS.md).

The worker artifact is assembled from `deploy/custom_nodes/fasth3_deploy` and
the maintained `deploy/custom_nodes/comfystream_drama3` package. Its manifest
also binds the host requirements locks, ComfyUI requirements snapshot, shared
model-stat receipt, worker identity extension, and the runtime/model manifest.
The Docker build checks the assembled artifact before installing its hash-locked
host dependencies.

The image pins the ComfyUI, PyTorch, Kitchen, Aimdo, Triton, and ClipProj
revisions from the environment manifest. It stores model files and compiler
caches on Fal's `/data` volume. At runner start, it downloads the FastH3 V2
model set and the pinned FastH3 Trim checkpoint, verifying their hashes before
ComfyUI starts. On the persistent Fal model volume, an existing file is reused
without a full reread only when its size matches the trusted receipt containing
its previously verified SHA-256; new files and size mismatches are downloaded
and checked against the pinned hash.

Deploy from this directory with `fal deploy fasth3-b1 --reset-scale`. After
benchmarking, keep `min_concurrency=0`, `max_concurrency=1`,
`max_multiplexing=1`, and `keep_alive=60` so the GPU runner scales down while
the private app configuration remains available for a later adaptive test.
