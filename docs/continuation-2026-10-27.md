# Continuation — local main

Implementation lanes: supervised Linux publisher, Windows contributor setup, subscriber event flow, Fal shutdown safety, and continuous story production. Changes stay on local `main` until the final release push.

Story producer cleanup plan: lock the CLI's role routing and shutdown behavior with regression coverage; remove its duplicate polling loop; reuse the existing worker service's bounded retry and authorization handling; report safe error codes without logging keys or prompts. Verify no GPU or paid call is needed.

Production gates remain the hardware, continuous-output, real subscriber, separate viewer and durable-host checks in the completion plan. Status and verification will be added as work completes.

## Implemented on local main

- Added a Windows console launcher with independent generation/upscale credentials, explicit WSL/Comfy setup and model-login/download actions. Existing shared credential settings are left intact and blocked from accidental overwrite; both menu and direct CLI pairing reject overrides that would hide the newly paired key. Corrected WSL UNC destinations and made the Trim-only downloader fetch and hash-check its manifest-pinned checkpoint without requiring the unrelated alternate model revision. Model weights are downloaded only on explicit user action.
- Unified the story-producer CLI with the supervised worker service, added safe retry diagnostics, and close the lease heartbeat/fail the attempt if a private workspace cannot be created.
- Recheck EventSub registration while holding the channel lock, preventing a notification from being stored or funded after concurrent revocation. Fence overlapping Extension refreshes so an older election cannot replace newer state.
- Added a Linux user-systemd publisher service and read-only backlog/retry health check, with a guarded local PostgreSQL test runner. This is deployment material; no remote CPU host has been provisioned.
- Hardened the Fal session controller against clock rollback/suspend and startup/stop races. It starts teardown before the requested maximum (10% reserve, capped at five minutes). Actual physical shutdown still depends on the provider and operator host; use an independent guardian and verify both selected app runner lists.

## Verification

- 193 worker tests ran: 192 passed and one PowerShell-only case was skipped; fake-curl tests verified Trim download selection, hashes, authentication-file cleanup and no final-verifier error without fetching models.
- 180 web tests passed, 23 database-only cases skipped in the normal run; 20 script/Extension tests passed. The guarded local EventSub run passed 16 web/database cases and 20 publisher cases; the separate Bits run passed five database cases and three guard cases.
- 60 publisher unit cases passed; 21 database-only cases skipped there. The dedicated guarded queue-health PostgreSQL test passed separately. Linux service scripts and model downloader passed ShellCheck and Bash syntax checks.
- Lint, typecheck, production build, offline weight-free WSL runtime packaging and Fal context assembly passed. Both SlopTogether Fal apps had zero runners during this work.

## Remaining qualification

These changes are local and have not been pushed or deployed. Run the Windows executable, PowerShell setup, both WSL GPU roles and the constrained-RAM Ada loader on actual Windows/4090 hardware. Install and exercise the publisher on a durable Linux host and configure external alerts. Prove fresh base and upscale production, sustained refill/recovery, and a real subscriber notification through ten-second playback. Test a separate viewer in the Twitch-hosted Extension and complete its release and paid-action review. GitHub's Windows runner remains blocked by account billing. The 128 GiB SoL admission guard remains until lower RAM use is measured.
