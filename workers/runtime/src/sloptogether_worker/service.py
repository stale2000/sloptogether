from __future__ import annotations

import hashlib
import logging
import os
import random
import shutil
import tempfile
import threading
from pathlib import Path
from typing import Callable

from .client import Lease, WorkerApi
from .comfy import ComfyClient
from .config import WorkerConfig
from .errors import ApiError, WorkerError
from .models import WorkerJob
from .runner import ComfyRecipeRunner, LeaseHeartbeat
from .story_producer import StoryProducer

log = logging.getLogger("sloptogether.worker")


class WorkerService:
    def __init__(
        self,
        config: WorkerConfig,
        *,
        api: WorkerApi | None = None,
        comfy: ComfyClient | None = None,
        report: Callable[[str], None] = print,
    ) -> None:
        self.config = config
        self.api = api or WorkerApi(config)
        self.comfy = comfy or ComfyClient(config)
        self.runner = ComfyRecipeRunner(config, self.comfy)
        self.report = report
        self.stop = threading.Event()

    def check(self) -> list[str]:
        if self.config.role == "story-producer":
            if not self.config.worker_key:
                raise WorkerError("story_producer_key_required", "Owner story production requires a scoped server-issued key.")
            return []
        role = "upscale" if self.config.role == "upscale" else "generation"
        return self.runner.check_compatible_nodes(role)

    def run(self, *, once: bool = False) -> int:
        if not self.api.token:
            raise WorkerError("worker_pairing_required", "Connect this worker to Twitch before claiming GPU work.")
        capabilities = self.check()
        self.report("Worker ready. Compatible pinned profiles: " + ", ".join(capabilities))
        if self.config.role == "story-producer":
            producer = StoryProducer(self.api, self.config)
            failures = 0
            while not self.stop.is_set():
                try:
                    accepted = producer.run_once()
                    failures = 0
                    if once:
                        return 0
                    if not accepted:
                        self.stop.wait(self.config.poll_interval_seconds + random.random())
                except ApiError as error:
                    if error.status in {401, 403}:
                        raise WorkerError("story_producer_scope_required", "This Twitch-linked key lacks permission to author future story scenes.") from None
                    if once:
                        raise
                    failures += 1
                    self.stop.wait(min(60, 2 ** min(failures, 6)) + random.random())
                except WorkerError:
                    failures += 1
                    if once:
                        raise
                    self.stop.wait(min(60, 2 ** min(failures, 6)) + random.random())
            return 0

        failures = 0
        while not self.stop.is_set():
            try:
                lease = self.api.claim(capabilities)
                if lease is None:
                    if once:
                        return 0
                    self.stop.wait(self.config.poll_interval_seconds + random.random())
                    continue
                self._process(lease)
                failures = 0
                if once:
                    return 0
            except ApiError as error:
                if error.status == 401:
                    raise WorkerError("worker_key_invalid", "The Twitch-linked worker key is invalid, expired or revoked.") from None
                if error.status == 403 and error.code in {"worker_key_scope_denied", "worker_attempt_owner_required", "worker_authority_revoked"}:
                    raise WorkerError("worker_key_unauthorized", "The Twitch-linked worker key is not authorized for this work.") from None
                failures += 1
                if once:
                    raise
                self.stop.wait(min(60, 2 ** min(failures, 6)) + random.random())
            except WorkerError:
                failures += 1
                if once:
                    raise
                self.stop.wait(min(60, 2 ** min(failures, 6)) + random.random())
        return 0

    def _process(self, lease: Lease) -> None:
        try:
            job = WorkerJob.from_payload(lease.job_payload)
        except (TypeError, ValueError) as error:
            raise WorkerError("lease_job_invalid", str(error)[:160]) from None
        if job.lease_id != lease.lease_id or job.fence != lease.fence:
            raise WorkerError("lease_job_mismatch", "Worker lease does not match the immutable job payload.")
        heartbeat = LeaseHeartbeat(self.api, lease, self.config.heartbeat_interval_seconds)
        heartbeat.start()
        workspace = Path(tempfile.mkdtemp(prefix=f"attempt-{job.attempt_id[:8]}-", dir=self._state_dir()))
        try:
            self.report(f"Claimed {job.stage} on channel {job.channel_id}; fence={job.fence}.")
            output, media_facts = self.runner.execute(job, lease, heartbeat, self.api, workspace, cancelled=self.stop.is_set)
            if heartbeat.cancelled.is_set() or self.stop.is_set():
                raise WorkerError("attempt_revoked", "The server revoked this attempt before upload.")
            output_size = output.stat().st_size
            output_digest = _sha256_file(output, self.config.max_output_bytes)
            # Upload grants expire no later than the current lease. Refresh it
            # immediately before requesting a grant instead of relying on the
            # next periodic heartbeat to leave enough time for the upload.
            heartbeat.update("uploading", 0.86)
            heartbeat.refresh_now()
            if self.stop.is_set():
                raise WorkerError("attempt_revoked", "The worker stopped before upload.")
            upload = self.api.issue_upload(
                lease, content_type="video/mp4", file_name="worker-output.mp4",
                byte_size=output_size, sha256=output_digest,
            )
            upload_id = _required_text(upload, "uploadId")
            upload_limit = _bounded_integer(upload, "maxBytes", 1, self.config.max_output_bytes)
            if output_size > upload_limit:
                raise WorkerError("upload_limit_exceeded", "The upload grant is smaller than the generated result.")
            self.api.upload_file(upload, str(output), max_bytes=upload_limit)
            if heartbeat.cancelled.is_set() or self.stop.is_set():
                raise WorkerError("attempt_revoked", "The server revoked this attempt during upload.")
            result = self.api.complete_upload(upload_id, lease, output_digest)
            if result.get("accepted") is not True:
                raise WorkerError("output_not_accepted", "The server did not accept the uploaded result.")
            expected = result.get("sha256")
            if isinstance(expected, str) and expected != output_digest:
                raise WorkerError("server_digest_mismatch", "Server and worker output digests do not match.")
            self.report(f"Uploaded a valid {media_facts['width']}x{media_facts['height']} clip ({media_facts['durationSeconds']:.2f}s).")
        except WorkerError as error:
            try:
                self.api.fail_attempt(lease, error.code)
            except WorkerError:
                pass
            raise
        finally:
            heartbeat.close()
            shutil.rmtree(workspace, ignore_errors=True)

    def _state_dir(self) -> Path:
        configured = self.config.state_dir.expanduser().absolute()
        if configured.is_symlink():
            raise WorkerError("worker_state_dir_invalid", "Worker state path cannot be a symbolic link.")
        configured.mkdir(mode=0o700, parents=True, exist_ok=True)
        path = configured.resolve()
        if not path.is_dir():
            raise WorkerError("worker_state_dir_invalid", "Worker state path is not a safe directory.")
        if os.name != "nt":
            path.chmod(0o700)
        return path


def _required_text(data: dict[str, object], field: str) -> str:
    value = data.get(field)
    if not isinstance(value, str) or not value:
        raise WorkerError("server_response_invalid", "The server returned incomplete worker data.")
    return value


def _bounded_integer(data: dict[str, object], field: str, min_value: int, max_value: int) -> int:
    value = data.get(field)
    if type(value) is not int or not min_value <= value <= max_value:
        raise WorkerError("server_response_invalid", "The server returned invalid worker limits.")
    return value


def _sha256_file(path: Path, max_bytes: int) -> str:
    digest = hashlib.sha256()
    total = 0
    with path.open("rb") as source:
        while chunk := source.read(1024 * 1024):
            total += len(chunk)
            if total > max_bytes:
                raise WorkerError("worker_output_too_large", "Worker output exceeds the allowed upload size.")
            digest.update(chunk)
    if total == 0:
        raise WorkerError("worker_output_empty", "The local worker returned an empty result.")
    return digest.hexdigest()
