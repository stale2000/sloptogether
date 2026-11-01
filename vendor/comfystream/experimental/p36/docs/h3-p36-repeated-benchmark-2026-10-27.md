# H3 P36 repeated decoder benchmark

On October 27, 2026, a dedicated NVIDIA RTX PRO 6000 Blackwell worker compared
the legacy INT8 C0 video decoder with the full 36-layer FastVideo NVFP4 P36
decoder. P36 was consistently faster at the measured decoder boundary and all
six fixtures met the predeclared numerical image-similarity screen. The user
subsequently requested P36 as the default Trim 5-step video decoder. That
repository change is implemented; it does not establish a production deploy
or an end-to-end speedup.

Both arms used identical captured H3 sampler latents and produced 362 frames at
512×320. The clock covers CPU latent input through owned host RGB24 output,
including the input transfer. C0 used the legacy INT8 checkpoint and
`fused_ff_qk_rope`; P36 used a different 36-layer checkpoint and the pinned
FastVideo runtime. This is a decoder-system comparison, not an isolated test of
FP4 arithmetic. The arms ran serially in separate processes on the same GPU;
the rounds were not paired or interleaved.

The screen used three captured fixtures, two C0 warmups and five measured calls
per decoder per fixture. The independent holdout used three new captures, one
C0 warmup and ten measured calls per decoder per fixture. All C0 outputs were
bit-exact to the captured references; each P36 fixture's measured RGB hashes
matched across repeats. P36 timing excludes process/model startup and the
first-use FlashInfer Blackwell kernel compilation, which took roughly two to
three minutes in this run. Neither streaming NVENC, audio muxing, segment
handoff, nor full generation latency is included.

| Set | Fixture | C0 median (s) | P36 median (s) | C0/P36 | Mean PSNR (dB) | Mean SSIM | Worst PSNR (dB) | Worst SSIM |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Screen | Dialogue | 2.821 | 1.926 | 1.465× | 42.68 | 0.99185 | 40.18 | 0.98775 |
| Screen | Motion | 2.850 | 1.928 | 1.478× | 37.53 | 0.98018 | 34.95 | 0.97114 |
| Screen | Detail | 2.771 | 1.927 | 1.438× | 36.99 | 0.96540 | 30.48 | 0.90503 |
| Holdout | Dialogue | 2.780 | 1.931 | 1.440× | 40.97 | 0.98995 | 39.74 | 0.98718 |
| Holdout | Motion | 2.771 | 1.931 | 1.435× | 35.14 | 0.97583 | 33.64 | 0.96753 |
| Holdout | Detail | 2.762 | 1.929 | 1.432× | 39.10 | 0.98144 | 36.11 | 0.97154 |

Quality is computed over all frames against the C0 reference. The approximate
decoder screen required mean PSNR ≥30 dB, mean SSIM ≥0.95, worst-frame PSNR
≥25 dB and worst-frame SSIM ≥0.90 per fixture. All six pass numerically; the
screen detail fixture's worst SSIM is only 0.005 above the threshold. A review
of sampled stills and that worst frame found differences in fine texture and
lettering strokes without a major geometric change. Full-motion flicker,
continuity and audio equivalence have not been reviewed. LPIPS was not measured.

The result data, quality records, reference videos, and review media are retained
locally under `benchmark-results/h3-decoder-comparison/` in the disposable
app's `comfystream-h3-decoder-bench-e66aa6d192e3` directory. That directory is
ignored and may not exist in other checkouts. The [detail side-by-side video](../../benchmark-results/h3-decoder-comparison/comfystream-h3-decoder-bench-e66aa6d192e3/detail-c0-p36-review.mp4)
is silent and has not been assessed for temporal artifacts.

The watchdog receipt records two consecutive empty owned app/runner inventory
snapshots after teardown. Fal also reported no matching app or runner after
shutdown. Provider-side deployment cancellation was not independently verified;
the local watchdog still cannot act while its host is shut down or offline.

The default implementation now keeps P36 resident in a separate FastVideo
process and returns complete CPU frames to the output encoder. It keeps the
INT8 VAE for conditioning and uses serial audio, but does not provide the
legacy temporal GPU-tile/encode overlap. The decoder and full-model source
revisions and hashes are checked at startup; the separate FastVideo environment
still has unpinned transitive dependencies and requires CUDA capability major
12 on the tested worker.

A subsequent two-segment GPU test of a hot-patched worker preserved the
final-frame handoff and produced both H.264/AAC outputs. The first P36 decode
took 246 seconds including model startup and kernel compilation. In a single
unpaired warm comparison, sampling through finalized MP4 took 14.51 seconds
with P36 and 12.25 seconds with the legacy decoder. This is an observed
regression, not a stable production estimate. The initial full-frame fallback
encoded audio at 32 kHz rather than the legacy 44.1 kHz; the working-tree fix
uses the legacy target rate (44.1 kHz by default, or a validated report target)
through the existing stream encoder. The clean-image GPU retest stalled during
a Fal dependency download and did not run.

The unpaired decoder-only results do not establish the planned paired
confidence interval or a complete-output speed improvement. Validate actual
deployed image identity, executed kernels, continuity and live performance
before relying on this default in production.
