# clips.gg hosting audit for SlopTogether

Inspected 2026-10-23. Required public URL: **https://clips.gg/sloptogether**.

## Repository and current state

Canonical repository: `/Users/stale2000/workspace/clips.gg`, branch `main`.

The checkout already has substantial uncommitted changes: Prisma schema and a new migration, task creation and admin modules, `init.sql`, Modal processing modules and tests, and editorial selection routes. These changes belong to other work. This integration adds only `frontend/middleware.ts`, the new `frontend/src/app/sloptogether/[[...path]]/route.ts` proxy, its focused helper/test, and `SLOPTOGETHER_ORIGIN` in `.env.example`; it does not edit those unrelated dirty files, install packages, change `vercel.json`, or deploy the site.

The repository is a monorepo: Next.js frontend/API, Reddit Devvit app, shared contracts, Modal GPU worker, Supabase functions, and R2 media storage. The actual frontend dependency is Next **16.2.2** and React **19.2.5**, despite README/system-map references to Next 15. Existing website auth is Supabase SSR, not Better Auth. Existing Twitch modules handle administrative browser sessions/native clip operations; they are not appropriate viewer OAuth credentials for SlopTogether.

## Recommended isolation

Keep SlopTogether in its own repository and deployment, mounted under `/sloptogether` by two narrow host rewrites. This keeps its dependencies, frontend layout, migrations, provider credentials, GPU processes, storage, and release cadence separate from existing ClipsGG tasks, billing, Reddit APIs, and Modal pipeline.

Build the child Next.js app with `basePath: "/sloptogether"`. Preserve that prefix when forwarding to its isolated origin. Do not set a global basePath on the existing ClipsGG app. Child page/API links, static assets, fetch calls, metadata links, callback URLs, downloads, and redirect destinations must all honor the prefix. Next image public-source URLs require explicit prefix handling where applicable.

Use a dedicated SlopTogether database project, or a separate schema and tightly scoped role if sharing infrastructure; use independent migrations either way. Use a separate R2 bucket and scoped credentials for quarantine/approved media. Browser/volunteer uploads receive object-specific expiring capabilities rather than bucket credentials. Keep existing `R2_*`, Modal, Stripe, Prisma, Supabase, and Twitch credential meanings unchanged.

## Implemented host integration (not deployed)

`frontend/src/app/sloptogether/[[...path]]/route.ts` provides a conditional reverse proxy to `SLOPTOGETHER_ORIGIN`, preserving the `/sloptogether` prefix and query string. It is a new route, not a `next.config.ts` rewrite, so the existing frontend routes, API-host allowlist, cron jobs and public media endpoints remain untouched. The environment target must be a separate HTTPS origin in production; same-origin targets are rejected to prevent proxy loops.

Set the host deployment's `SLOPTOGETHER_ORIGIN` to the isolated child origin (root origin only, no path); the child itself remains built with `basePath: "/sloptogether"`. Locally the example uses port 3001 so the child can run beside Clips.gg on port 3000.

The new route forwards standard API/navigation/range headers, only `x-extension-jwt` from child `x-*` credentials, and Twitch EventSub headers; it drops client-supplied IP/forwarding, Vercel and middleware headers. When `SLOPTOGETHER_PROXY_CLIENT_IP_SECRET` is configured identically in the host and child deployments, the host signs Vercel's `x-vercel-forwarded-for` address for the pairing limiter. The child verifies its HMAC and two-minute timestamp; unsigned/direct requests share a conservative fallback limit. Set this secret in both environments before relying on per-IP pairing limits. It forwards only `slop_sid` generally and `slop_oauth_state` to the Twitch callback; response cookies are restricted to those names and the child paths, with `Domain` removed. The middleware bypass is placed after the Devvit/API-host restriction and before landing-only mode/session refresh. Focused tests cover spoofed IP-header stripping, signed proxy metadata, root-cookie stripping, cookie path constraints, redirect rewriting and transport headers. This code has not been deployed or tested through the live Vercel/CDN mount.

## Authentication and origin boundaries

Use SlopTogether's own Twitch OAuth application/redirect registration, exact callback `https://clips.gg/sloptogether/api/v1/auth/twitch/callback`, and validated local return paths. A separate Supabase OAuth flow would need its own provider project settings and allowlisted callback chain. The child uses `slop_sid` with `Path=/sloptogether` and `slop_oauth_state` with `Path=/sloptogether/api/v1/auth/twitch`, both HttpOnly, Secure in production and SameSite=Lax. Do not read the existing `clipsgg-sb-auth` cookie as proof of Twitch identity, moderator privileges, or worker trust.

**A URL prefix is deployment isolation, not browser-origin security isolation.** Scripts served from `/sloptogether` share the `https://clips.gg` origin with the existing website; cookie paths are not an authorization or XSS security boundary. Browsers attach root-path ClipsGG cookies to the incoming request; the mount middleware/proxy must remove them before external forwarding. Regression evidence must show `clipsgg-sb-auth` never reaches the child origin. The child must also ignore unexpected credentials, use independent session secrets and perform its own authorization/CSRF checks. Emit only child `Set-Cookie` names at `Path=/sloptogether`, no broad Domain and no host cookie changes; verify response headers end to end. If infrastructure cannot enforce the required filtering, use a narrowly scoped proxy gateway instead of plain config rewrites. Preserve host security headers and restrict scripts/uploads with CSP and safe rendering. Shared-origin script exposure still remains; hard browser-origin isolation would require a different origin or a separately assessed cross-origin sandbox.

The Twitch Extension iframe should authenticate using verified Extension JWTs against its external backend, not rely on browser cookies in a third-party iframe. Its configured backend/asset allowlists and CSP must reference exact approved endpoints. Do not forward provider credentials, Twitch bearer tokens, or broad storage credentials to the extension/browser/volunteer workers.

## Realtime, media, and workers

Use a dedicated realtime service or an authenticated client connection to Supabase Realtime for timeline state. Do not design an indefinitely running WebSocket/GPU process as a Next route handler. Keep GPU generation/upscale deployments outside Vercel's web request lifecycle. The HTTP path mount can expose bounded API, callback, EventSub, and job control requests; webhook verification must use the original request body bytes.

Serve approved video through the dedicated CDN/R2 media origin with correct content types, range support, CORS, and cache policy. Quarantine assets should remain private. Public media should use immutable revision/object identifiers rather than mutable worker-supplied paths.

## Rollout and rollback

1. Deploy the isolated child app first with `/sloptogether` basePath and preview-specific credentials/storage/database.
2. Verify prefixed navigation, static assets, OAuth callback, logout, CSRF, uploads, playback/range requests, EventSub callback verification, and direct realtime authentication on a preview host mount. Confirm the reverse proxy strips root Cookies and forwards only the child cookies.
3. Review the isolated host additions and rebase them carefully around existing dirty work; never bundle unrelated changes.
4. Run existing ClipsGG frontend checks for this host diff and smoke-check `/`, sign-in, clips, API-host allowlists, and existing cron routes. Root `vercel.json` cron definitions remain unchanged.
5. Enable the fixed upstream origin and mount. Monitor child-origin health and prefixed 404/auth/media failures.
6. Roll back by disabling the mount and bypass together or reverting that small host commit. Independently roll the child deployment back to its prior release. Do not drop or reverse existing ClipsGG database schema as part of rollback. A SlopTogether-only maintenance response can keep the path understandable while the child is disabled.

## Exact source references

All paths below are in `/Users/stale2000/workspace/clips.gg`:

| File and line | Evidence |
| --- | --- |
| `AGENTS.md:3` | Monorepo areas and repository-specific guidance. |
| `README.md:3` | Existing frontend, Devvit, shared, and Modal boundaries. |
| `frontend/package.json:42` | Actual Next.js 16.2.2 dependency. |
| `frontend/package.json:48` | Actual React 19.2.5 dependency. |
| `frontend/next.config.ts:8` | Existing NextConfig, no rewrites or basePath. |
| `frontend/middleware.ts:39` | Main middleware entry. |
| `frontend/middleware.ts:42` | API-host allowlist must run before child bypass. |
| `frontend/middleware.ts:50` | Landing-only mode handling; child bypass belongs before this. |
| `frontend/middleware.ts:89` | Middleware matcher covers all paths. |
| `frontend/src/lib/auth-server.ts:66` | Supabase session validation for existing web APIs. |
| `frontend/src/lib/supabase-cookie-options.ts:1` | Existing `clipsgg-sb-auth` cookie at path `/`. |
| `frontend/src/app/auth/callback/route.ts:1` | Existing root Supabase callback belongs to ClipsGG. |
| `frontend/src/app/layout.tsx:31` | Existing root layout and client-cache provider would wrap an in-app route. |
| `frontend/src/platform/config/index.ts:51` | Existing ClipsGG-wide R2 configuration. |
| `frontend/src/platform/providers/r2.ts:1` | Existing S3-compatible R2 client. |
| `vercel.json:1` | Vercel config and two existing cron jobs. |
| `.github/workflows/ci.yml:1` | Existing frontend and Modal CI verification. |
| `docs/architecture/system-map.md:1` | Request-flow and ownership-boundary documentation. |
| `docs/architecture/reddit-app-edge-function-compatibility.md:1` | Existing Reddit API compatibility contract. |

No CodeGraph index was present in this repository, so this audit used read-only source/configuration reads. No runtime behavior or deployment was exercised; the proposed integration requires implementation-time preview verification.
