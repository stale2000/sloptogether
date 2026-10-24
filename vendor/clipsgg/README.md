# ClipsGG integration reference snapshot

Copied from `/Users/stale2000/workspace/clips.gg` at HEAD
`1533aebc3472e31a20223ff3f60a1a5ce3455cc4`, with existing uncommitted changes.
`import-manifest.json` records the exact current bytes; HEAD alone is not
the snapshot identity. The source repository was not modified.

The 11 files (12,321 bytes) include host Next configuration/middleware,
its immediate Supabase cookie/session and API-host helpers, package metadata,
Vercel configuration, and R2 client/config/upload helpers. Source-relative
paths are preserved under `reference/`.

This is integration reference code, not a standalone application or an
installed dependency. Do not run its package scripts here. The middleware
depends on the original Next/Supabase environment; the config module also
re-exports uncopied host application configuration. Those unrelated host
features were deliberately excluded.

Adapt the R2 client pattern into SlopTogether-owned configuration. The copied
`uploadClipVariant` helper returns a public URL and must not be used unchanged
for private donor uploads. The copied root cookie/OAuth defaults also do not
implement SlopTogether's path/session isolation. Follow the reviewed upload
protocol and hosting audit instead of assuming these files already contain
the new behavior.

No environment files, credentials, dependencies, host database, generated
media, Reddit/Modal runtime, old Twitch browser sessions or Git metadata were
copied. The upstream `LICENSE` file is empty; it is preserved exactly and
does not establish a license grant. Resolve source rights before public
redistribution.

Verification performed: all 11 SHA-256 values match copied bytes; eight
TypeScript modules parsed with the source workspace's existing TypeScript
6.0.2 compiler without syntax diagnostics. No installation, build, deployment
or runtime execution was performed. Type checking requires the original
host workspace; no standalone type-check claim is made.

See [import plan](../../docs/clipsgg-import-plan.md),
[hosting audit](../../docs/clips-hosting-audit.md) and
[worker upload protocol](../../docs/worker-upload-protocol.md).
