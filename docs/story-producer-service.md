# Story producer service

The streamer requests four candidates at a time. The owner story producer writes their prompts without waiting for video rendering. Reviewers select an approved start frame and approve each candidate independently. A worker job is created only when the current candidate and the next candidate are both approved: the next candidate’s start frame is the current clip’s end frame. The final candidate can be approved while waiting for a following candidate from a later request. The producer becomes idle when there are no requested candidates or approved pairs to schedule. GPU workers are separate and output still follows the channel’s screening and review policy.

Install this service only after deploying the finite-batch server and worker together. Older server/worker versions can generate without a four-clip request.

The service below uses the existing owner-scoped `story:write_future` key. It uses the free built-in story templates and does not pass an OpenAI key, Comfy Cloud key, or Fal key into the process. It does not start or keep GPU workers alive. The channel's budget and generation policy still apply.

1. In the channel control page, issue a key with **story:write_future** only. Keep it private; do not commit it or pass it as a command argument.
2. Copy `workers/runtime/scripts/story-producer.example.toml` outside the repository, set `channel_id` and `stream_slug`, and keep its `state_dir` private. Put the scoped key in `<state_dir>/worker.key` as a regular file owned by the current user with mode `0600`. The directory should be mode `0700`. The TOML file contains no key.
3. From the repository, with Python 3.12 available:

```sh
python3.12 workers/runtime/scripts/story-producer-service.py install --config ~/.config/sloptogether/story-main.toml
python3.12 workers/runtime/scripts/story-producer-service.py status --config ~/.config/sloptogether/story-main.toml
```

To stop and remove the service, run:

```sh
python3.12 workers/runtime/scripts/story-producer-service.py uninstall --config ~/.config/sloptogether/story-main.toml
```

The config and key are kept. A separate service is installed for each config path, so different streams can run independently. macOS uses a user LaunchAgent, and Linux uses a user systemd service. Linux requires user lingering if it must continue after logout. A user service stops when its host is unavailable; use a durable host for unattended streaming. macOS logs are under `~/Library/Logs/SlopTogether/`; Linux logs are available through `journalctl --user -u <service name>`.

The service template and its configuration checks have offline tests. Installation, restart after reboot, live prompt production, and GPU output must still be qualified on the target host. Service installation is never performed by tests.
