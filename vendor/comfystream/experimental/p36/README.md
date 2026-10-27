# Experimental FastH3 P36 decoder

This is an isolated, byte-preserved snapshot of ComfyStream's P36 NVFP4 video
decoder, provisioning code, benchmark patch and tests. The exact source paths
and SHA-256 hashes are in `source-manifest.json`. This directory is **not** part
of the SlopTogether worker artifact or any production recipe; existing Fal and
Windows/4090 workers continue using the current decoder.

P36 requires an NVIDIA SM12x GPU, a separately installed FastVideo runtime at
its pinned revision, and explicitly provisioned and hash-verified P36 and H3
VAE assets. The bootstrap performs model downloads when explicitly invoked;
it is never invoked by this repository's worker startup. The upstream node
and worker use `/opt` and `/data` paths from the Fal image and are not a
Windows/4090 implementation. A P36 decode error must fail that attempt; do
not silently rerender through a different decoder or reuse a paid attempt.

To run the CPU contract tests without altering the worker artifact:

```sh
PYTHONDONTWRITEBYTECODE=1 /Users/stale2000/comfy/comfystream/.venv/bin/python -B \
  vendor/comfystream/experimental/p36/run_tests.py
```

This stages the P36 source against a temporary copy of the vendored node tree.
It excludes the upstream production-image provisioning test because this
project deliberately does not install P36 in that image. It does not install
dependencies, download weights, run inference, or prove GPU compatibility.

For an actual opt-in, first build a separate isolated image with the upstream
FastVideo environment and patch, add the P36 node and explicit workflow to a
new separately versioned SM12x recipe, provision the pinned assets, and update
worker identity and admission together. Test the clean image, audio, boundary
continuity, memory and full-stream performance before deployment. Do not alter
the existing recipe identity or enable P36 by default on the current workers.

The upstream `docs/` benchmark reports faster decoder-only results but a
slower unpaired warm end-to-end run and a long first-use startup. A clean final
image and full streaming-quality qualification were not completed; see that
benchmark for exact limitations. Its referenced benchmark media lives in the
source repository and is not included in this snapshot.
