# Worker extraction plan

Scope: import the existing ComfyStreamer worker runtime into SlopTogether before planning the wider application. Source: `/Users/stale2000/comfy/comfystream`; the independent `comfystreamerh3` repository is background reference. The canonical source has current TrimH3 work absent from the standalone snapshot.

1. Read the existing worker-artifact manifests/assembler, generation and SoL upscale node entrypoints, Fal images, profiles and tests. Reuse the upstream dependency closure rather than copy the desktop application.
2. Preserve runtime behavior during import. Retain benchmark-named support modules when runtime imports depend on them; do not mistake a filename for unused code. Do not prune exported inference routes without proving a smaller dependency closure.
3. Copy only worker runtime source, runtime/build manifests, required deployment/bootstrap tools, the relevant workflow/reference builder, applicable licenses, and meaningful existing worker tests where they can run independently. Exclude OBS, coordinator, upstream website, installers, media outputs, model weights, experiments, trainers not in the runtime closure, caches, secrets, environment files and Git metadata.
4. Record source revision and dirty-state caveat. Create a per-file SHA-256 provenance manifest of imported source bytes; never silently represent local changes as a clean upstream release.
5. Verify imported bytes, AST/import closure and build-path references with read-only/temporary checks. Run applicable existing CPU tests if their required environment is available. Record the GPU execution gap explicitly; do not deploy, install GPU dependencies, download models or claim GPU qualification.
6. Keep the imported runtime isolated under `vendor/comfystream`. Future SlopTogether APIs, auth, scheduling and local worker clients remain outside the inference snapshot. The current NVFP4/MXFP8 defaults are not a validated RTX4090 profile; the plan must define an Ada-compatible, measured 24GB path.

The import itself is reversible. No source repository or clips.gg host files are modified. Any behavioral pruning/optimization becomes a separate later implementation task with focused regression evidence.
