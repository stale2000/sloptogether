from __future__ import annotations

import importlib.util
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace

_SCRIPT = Path(__file__).parents[3] / "scripts" / "upload-local-fal-smoke.py"
_SPEC = importlib.util.spec_from_file_location("upload_local_fal_smoke", _SCRIPT)
_MODULE = importlib.util.module_from_spec(_SPEC)
assert _SPEC and _SPEC.loader
_SPEC.loader.exec_module(_MODULE)


class FakeApi:
    def __init__(self):
        self.calls = []
        self.lease = SimpleNamespace(lease_id="lease", job_payload={"channelId": "900000001", "stage": "generation", "jobId": "job"})

    def claim(self):
        self.calls.append("claim")
        return self.lease

    def issue_upload(self, lease, **kwargs):
        self.calls.append(("issue_upload", kwargs))
        return {"uploadId": "upload", "maxBytes": kwargs["byte_size"], "method": "PUT", "expiresAt": "later", "requiredHeaders": {"Content-Type": "video/mp4"}, "uploadUrl": "http://127.0.0.1:9000/upload"}

    def upload_file(self, grant, path, *, max_bytes):
        self.calls.append(("upload_file", path, max_bytes))

    def complete_upload(self, upload_id, lease, digest):
        self.calls.append(("complete_upload", upload_id, digest))
        return {"accepted": True, "artifactId": "artifact"}


class LocalDemoUploaderTests(unittest.TestCase):
    def config(self):
        return SimpleNamespace(role="generation", channel_id="900000001", api_base_url="http://localhost:3000/sloptogether/api/v1",
                               local_s3_endpoint="http://127.0.0.1:9000", max_output_bytes=128 * 1024 * 1024)

    def test_only_loopback_local_generation_targets_are_allowed(self):
        _MODULE.validate_local_target(self.config())
        config = self.config()
        config.api_base_url = "https://clips.gg/sloptogether/api/v1"
        with self.assertRaises(_MODULE.WorkerError) as raised:
            _MODULE.validate_local_target(config)
        self.assertEqual(raised.exception.code, "local_preview_endpoint_not_loopback")
        config = self.config()
        config.local_s3_endpoint = "http://127.0.0.1:9999"
        with self.assertRaises(_MODULE.WorkerError) as raised:
            _MODULE.validate_local_target(config)
        self.assertEqual(raised.exception.code, "local_preview_endpoint_not_loopback")

    def test_existing_mp4_uses_the_normal_claim_upload_and_completion_protocol(self):
        with tempfile.TemporaryDirectory() as directory:
            clip = Path(directory) / "smoke.mp4"
            clip.write_bytes(b"\x00\x00\x00\x18ftypisom" + b"clip-data")
            api = FakeApi()
            result = _MODULE.upload_existing_clip(clip, self.config(), api)
        self.assertTrue(result["accepted"])
        self.assertEqual([call if isinstance(call, str) else call[0] for call in api.calls], ["claim", "issue_upload", "upload_file", "complete_upload"])

    def test_rejects_another_channel_before_claiming_work(self):
        with tempfile.TemporaryDirectory() as directory:
            clip = Path(directory) / "smoke.mp4"
            clip.write_bytes(b"\x00\x00\x00\x18ftypisom" + b"clip-data")
            config = self.config()
            config.channel_id = "123"
            api = FakeApi()
            with self.assertRaises(_MODULE.WorkerError) as raised:
                _MODULE.upload_existing_clip(clip, config, api)
            self.assertEqual(raised.exception.code, "local_preview_worker_scope_invalid")
            self.assertEqual(api.calls, [])


if __name__ == "__main__":
    unittest.main()
