from __future__ import annotations

import unittest
import sys
from types import SimpleNamespace
from unittest.mock import patch
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from sloptogether_worker.client import WorkerApi
from sloptogether_worker.errors import WorkerError


class WorkerApiStatusTest(unittest.TestCase):
    def setUp(self) -> None:
        self.api = WorkerApi(SimpleNamespace(
            api_base_url="https://www.clips.gg/sloptogether/api/v1",
            worker_key="test-worker-key",
            allowed_upload_hosts=(),
            request_timeout_seconds=30,
        ))

    def test_worker_identity_exchange_is_role_scoped(self) -> None:
        with patch.object(self.api, "_request", return_value=({"channelId": "31825889"}, {})) as request:
            self.assertEqual(self.api.exchange_session("upscale"), {"channelId": "31825889"})
        request.assert_called_once_with("POST", "/workers/sessions/exchange", query={"role": "upscale"})

    def test_public_channel_lookup_rejects_untrusted_locator(self) -> None:
        with patch.object(self.api, "_request") as request:
            with self.assertRaises(WorkerError) as raised:
                self.api.public_channel("https://evil.example")
            self.assertEqual(raised.exception.code, "channel_locator_invalid")
            request.assert_not_called()

    def test_worker_stats_request_is_bound_to_role_and_stream(self) -> None:
        response = {"availableJobs": 2, "completedJobs": 5}
        with patch.object(self.api, "_request", return_value=(response, {})) as request:
            self.assertEqual(self.api.worker_stats("generation", "cartoon-demo"), response)
        request.assert_called_once_with("GET", "/workers/stats", query={"role": "generation", "streamSlug": "cartoon-demo"})


if __name__ == "__main__":
    unittest.main()
