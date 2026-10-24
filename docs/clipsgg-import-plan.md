# ClipsGG reference-code import plan

The ComfyStreamer generation/upscale runtime has already been imported under `vendor/comfystream`. This bounded follow-up brings in the other relevant repository: `/Users/stale2000/workspace/clips.gg`.

1. Copy exact current source for the host's Next configuration, middleware and its immediate auth/hostname helpers; include package version metadata and Vercel route/cron context.
2. Copy its small R2 client/config/upload helper modules as reference for future adaptation. Do not adopt their current root cookie paths or immediate public upload semantics in SlopTogether.
3. Store these files under `vendor/clipsgg/reference` with source HEAD, current dirty-state information and per-file SHA-256 provenance. Preserve the upstream license file, including an explicit caveat if it contains no license text.
4. Exclude secrets, environment files, databases, host application pages, old Twitch browser sessions, Reddit/Modal jobs, dependencies, generated media and Git metadata.
5. Verify copied bytes and parse source syntax using the existing source-repo TypeScript compiler. This is a reference snapshot, not a standalone build/deployment. Do not install packages, execute copied scripts or change either upstream repository.

No behavior is refactored by this import; later integration should make only the reviewed `/sloptogether` mount and credential-boundary changes in a separate host patch.
