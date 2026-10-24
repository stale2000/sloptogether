from __future__ import annotations

import argparse
import hashlib
import ipaddress
import json
import os
from pathlib import Path
import sys
from urllib.parse import urlsplit

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "workers" / "runtime" / "src"))

from sloptogether_worker.client import WorkerApi
from sloptogether_worker.config import WorkerConfig
from sloptogether_worker.errors import WorkerError


LOCAL_CHANNEL_ID = "900000001"
DEFAULT_VIDEO = "/tmp/sloptogether-fal-test/sloptogether-fal-smoke.mp4"


def _loopback_http(value: str | None) -> bool:
    if not value:
        return False
    parsed = urlsplit(value)
    try:
        loopback = parsed.hostname == "localhost" or bool(parsed.hostname and ipaddress.ip_address(parsed.hostname).is_loopback)
    except ValueError:
        return False
    return parsed.scheme == "http" and loopback and not parsed.username and not parsed.password and not parsed.query and not parsed.fragment


def validate_local_target(config: WorkerConfig) -> None:
    if config.role != "generation" or config.channel_id != LOCAL_CHANNEL_ID:
        raise WorkerError("local_preview_worker_scope_invalid", "The local smoke uploader requires its seeded generation channel.")
    api = urlsplit(config.api_base_url)
    storage = urlsplit(config.local_s3_endpoint or "")
    if (not _loopback_http(config.api_base_url) or api.port != 3000 or api.path != "/sloptogether/api/v1"
        or not _loopback_http(config.local_s3_endpoint) or storage.hostname != "127.0.0.1" or storage.port != 9000 or storage.path not in {"", "/"}):
        raise WorkerError("local_preview_endpoint_not_loopback", "The local smoke uploader only accepts loopback app and storage endpoints.")


def sha256_file(path: Path, maximum: int) -> tuple[str, int]:
    digest = hashlib.sha256()
    size = 0
    with path.open("rb") as source:
        while chunk := source.read(1024 * 1024):
            size += len(chunk)
            if size > maximum:
                raise WorkerError("local_preview_video_too_large", "The existing H3 clip exceeds the worker upload limit.")
            digest.update(chunk)
    if size < 12:
        raise WorkerError("local_preview_video_invalid", "The existing H3 clip is empty or truncated.")
    return digest.hexdigest(), size


def upload_existing_clip(path: Path, config: WorkerConfig, api: WorkerApi) -> dict[str, object]:
    validate_local_target(config)
    if not path.is_file():
        raise WorkerError("local_preview_video_missing", "Set FAL_SMOKE_VIDEO to an existing H3 MP4 clip.")
    digest, size = sha256_file(path, config.max_output_bytes)
    with path.open("rb") as source:
        if source.read(8)[4:8] != b"ftyp":
            raise WorkerError("local_preview_video_invalid", "The existing H3 clip is not an MP4 file.")

    lease = api.claim()
    if lease is None:
        raise WorkerError("local_preview_job_empty", "Seed the local Fal demo job before uploading a clip.")
    job = lease.job_payload
    if job.get("channelId") != LOCAL_CHANNEL_ID or job.get("stage") != "generation":
        raise WorkerError("local_preview_job_scope_invalid", "The claimed job is outside the local generation fixture.")

    grant = api.issue_upload(lease, content_type="video/mp4", file_name=path.name[:240], byte_size=size, sha256=digest)
    upload_id = grant.get("uploadId")
    limit = grant.get("maxBytes")
    if not isinstance(upload_id, str) or type(limit) is not int or size > limit:
        raise WorkerError("local_preview_upload_grant_invalid", "The server returned an invalid local clip upload grant.")
    api.upload_file(grant, str(path), max_bytes=limit)
    result = api.complete_upload(upload_id, lease, digest)
    if result.get("accepted") is not True:
        raise WorkerError("local_preview_upload_not_accepted", "The app did not accept the uploaded clip.")
    return {"channel": LOCAL_CHANNEL_ID, "jobId": job.get("jobId"), "artifactId": result.get("artifactId"), "bytes": size, "accepted": True}


def main() -> int:
    parser = argparse.ArgumentParser(description="Upload an existing H3 MP4 through the local SlopTogether worker API without running inference.")
    parser.add_argument("video", nargs="?", default=os.environ.get("FAL_SMOKE_VIDEO", DEFAULT_VIDEO))
    args = parser.parse_args()
    try:
        config = WorkerConfig.from_sources(config_path=None, role_override=None)
        result = upload_existing_clip(Path(args.video).expanduser(), config, WorkerApi(config))
    except (OSError, ValueError, WorkerError) as error:
        code = error.code if isinstance(error, WorkerError) else type(error).__name__
        print(json.dumps({"accepted": False, "error": code}))
        return 1
    print(json.dumps(result))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
