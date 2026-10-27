# Trusted Fal upscale pairing plan

## Current state

The existing Fal upscale key is scoped to `worker:upscale`, so its validated
outputs still require a reviewer. The broadcaster approved granting Fal
automatic approval after the normal input and media checks. No replacement key
has been issued or stored, and the existing key has not been revoked.

The existing contributor pairing flow delivers a key to a local worker through
a short-lived polling secret. It does not grant `artifact:system_approve`, and
its existing behavior must remain compatible. A partially implemented trusted
pairing change was removed before deployment; the design below still requires
implementation and independent security review.

## Cleanup in this change

1. Restore only the unfinished trusted-pairing edits in the pairing service,
   route dispatch, and pairing page. Preserve the other worker, trust, and
   playback changes already in those files.
2. Run the existing worker-service tests and web typecheck to check that the
   ordinary pairing path remains intact.

## Proposed flow

1. A local helper starts a short-lived pairing for exactly one Linux/Fal
   upscale role. It keeps the polling secret in memory and displays only the
   verification URL and one-time code. It must reject arbitrary API origins
   and redirects that could disclose the polling secret or issued key.
2. The signed-in broadcaster reviews a page that explicitly names the channel,
   Fal upscale role, and automatic approval after input and media checks. An
   explicit confirmation is required. Moderators and other channel users cannot
   grant this trust; `streamer:control` and other roles are never included.
3. The server binds approval to the broadcaster, channel, exact requested
   scopes, current policy revision, and expiry. It checks bans, channel state,
   session authority, and revocation again before issuing the credential, and
   records the approval in the audit log.
4. The local helper receives the scoped key through the authenticated polling
   protocol and writes it directly to the existing Fal secret named
   `SLOPTOGETHER_WORKER_KEY_UPSCALE`, without displaying it, putting it in
   command arguments, or writing it into the repository. It first verifies the
   target Fal account and app and checks the new key against the app API.
5. Delivery must be one-time after a successful storage acknowledgement. A
   bounded retry before acknowledgement should recover an interrupted response
   without producing another key. If storage or acknowledgement fails, fail
   closed and provide a way to revoke or expire any issued but unused key.
6. Restart the upscale app only after coordinating with active work. Verify it
   claims a real job with the new binding and that approval is automatic only
   after validation and screening. Revoke the prior Fal upscale key only after
   the replacement is verified. Keep the required two-hour GPU shutdown
   safeguards in force.

## Required verification before release

- Ordinary contributor pairing remains unchanged; only the exact trusted Fal
  request can receive the additional scope.
- Missing confirmation, non-broadcaster sessions, wrong codes or polling
  secrets, expired requests, replay after acknowledgement, changed policy,
  disabled channels, bans, revoked keys, and cross-channel requests fail closed.
- Concurrent polling and acknowledgement cannot create multiple credentials or
  execution bindings, and interrupted delivery has an explicit recovery path.
- The helper tests use fake credentials and a fake Fal secret client; they
  reject nonapproved origins, redirects, malformed responses, and unintended
  scopes. No production secret or GPU is required for these tests.
- Review the trust boundary, lock ordering, token lifetime, audit evidence,
  user-facing confirmation, and any credential-entry handoff required by the
  browser tool. Deploy only after the tests and independent review pass.
