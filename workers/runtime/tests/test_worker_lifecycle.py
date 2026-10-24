from datetime import datetime, timedelta, timezone
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock, patch
import json
import signal
import tempfile
import threading
import unittest
import urllib.error
from io import BytesIO

from sloptogether_worker import cli
from sloptogether_worker.client import PairingInstructions
from sloptogether_worker.client import WorkerApi
from sloptogether_worker.comfy import ComfyClient
from sloptogether_worker.errors import ApiError, WorkerError


class WorkerLifecycleTest(unittest.TestCase):
    def test_cli_exposes_the_wsl_platform_option(self) -> None:
        args=cli.parser().parse_args(["--platform","wsl","check"])
        self.assertEqual(args.platform,"wsl")

    def test_worker_api_uses_the_proxy_scoped_authorization_scheme(self) -> None:
        class Response:
            headers = {}
            def __enter__(self): return self
            def __exit__(self,*_args): return None
            def read(self,_limit): return b"{}"
        config=SimpleNamespace(api_base_url="https://clips.gg/sloptogether/api/v1",request_timeout_seconds=3,worker_key=None,allowed_upload_hosts=(),local_s3_endpoint=None)
        api=WorkerApi(config);api.token="slw_123e4567-e89b-42d3-a456-426614174000."+"a"*32
        api.opener=SimpleNamespace(open=Mock(return_value=Response()))
        api._request("GET","/worker/claim")
        request=api.opener.open.call_args.args[0]
        self.assertEqual(request.get_header("Authorization"),f"SlopWorker {api.token}")

    def test_worker_api_preserves_server_error_code_field(self) -> None:
        config=SimpleNamespace(api_base_url="https://clips.gg/sloptogether/api/v1",request_timeout_seconds=3,worker_key=None,allowed_upload_hosts=(),local_s3_endpoint=None)
        api=WorkerApi(config);api.token="slw_123e4567-e89b-42d3-a456-426614174000."+"a"*32
        response=urllib.error.HTTPError(
            "https://clips.gg/sloptogether/api/v1/channels/localdemo/story-proposals",
            409,"Conflict",{},BytesIO(b'{"error":"owner_generation_budget_unavailable","message":"No budget."}'),
        )
        api.opener=SimpleNamespace(open=Mock(side_effect=response))
        with self.assertRaises(ApiError) as raised:
            api._request("POST","/channels/localdemo/story-proposals",body={})
        self.assertEqual((raised.exception.status,raised.exception.code),(409,"owner_generation_budget_unavailable"))

    def test_pairing_body_matches_the_server_contract(self) -> None:
        with tempfile.TemporaryDirectory() as folder:
            instructions = PairingInstructions("pair", "poll-secret", "ABCD-EFGH", "https://clips.gg/pair", (datetime.now(timezone.utc) + timedelta(minutes=5)).isoformat())
            for platform,display_name in (("windows","Windows GPU worker"),("wsl","Windows WSL2 GPU worker")):
                with self.subTest(platform=platform):
                    config = SimpleNamespace(state_dir=Path(folder), platform=platform, role="generation")
                    api = SimpleNamespace(create_pairing=Mock(return_value=instructions), poll_pairing=Mock(return_value="worker-key"), token=None)
                    with patch("sloptogether_worker.cli.save_secret"):
                        cli._pair(config, api, open_browser=False)
                    body=api.create_pairing.call_args.args[0]
                    self.assertEqual(set(body), {"installationId", "displayName", "platform", "roles", "clientVersion"})
                    self.assertEqual((body["platform"],body["displayName"]),(platform,display_name))
                    self.assertEqual(api.token, "worker-key")

    def test_run_checks_local_recipe_before_opening_twitch_pairing(self) -> None:
        config=SimpleNamespace(role="upscale",platform="windows")
        api=SimpleNamespace(token=None)
        service=SimpleNamespace(check=Mock(side_effect=WorkerError("windows_inference_runtime_unavailable","Linux-only node")))
        args=SimpleNamespace(command="run",config=None,role=None,headless=False,once=False)
        with patch("sloptogether_worker.cli.parser",return_value=SimpleNamespace(parse_args=lambda:args)), \
             patch("sloptogether_worker.cli.WorkerConfig.from_sources",return_value=config), \
             patch("sloptogether_worker.cli.WorkerApi",return_value=api), \
             patch("sloptogether_worker.cli.WorkerService",return_value=service), \
             patch("sloptogether_worker.cli._pair") as pair:
            self.assertEqual(cli.main(),2)
        service.check.assert_called_once()
        pair.assert_not_called()

    def test_sigterm_sets_the_running_service_stop_event(self) -> None:
        handlers = {}
        config = SimpleNamespace(role="generation")
        service = SimpleNamespace(stop=threading.Event())
        def run(**_kwargs):
            handlers[signal.SIGTERM](signal.SIGTERM, None)
            self.assertTrue(service.stop.is_set())
            return 0
        service.run = run
        args = SimpleNamespace(command="run", config=None, role=None, headless=True, once=True)
        with patch("sloptogether_worker.cli.parser", return_value=SimpleNamespace(parse_args=lambda: args)), \
             patch("sloptogether_worker.cli.WorkerConfig.from_sources", return_value=config), \
             patch("sloptogether_worker.cli.WorkerApi", return_value=SimpleNamespace(token="worker-key")), \
             patch("sloptogether_worker.cli.WorkerService", return_value=service), \
             patch("sloptogether_worker.cli.signal.signal", side_effect=lambda number, handler: handlers.__setitem__(number, handler)):
            self.assertEqual(cli.main(), 0)

    def test_history_polling_honors_monotonic_expiry_and_cancellation(self) -> None:
        client = object.__new__(ComfyClient)
        client._request = Mock(return_value=json.dumps({"id":"prompt","status":"in_progress","outputs":{}}).encode())
        with patch("sloptogether_worker.comfy.time.monotonic", return_value=100):
            with self.assertRaisesRegex(WorkerError, "deadline"):
                client.await_output("prompt", 0)
        client._request.assert_not_called()
        with patch("sloptogether_worker.comfy.time.monotonic", return_value=100), patch("sloptogether_worker.comfy.time.sleep"):
            with self.assertRaisesRegex(WorkerError, "stopped or revoked"):
                client.await_output("prompt", 100, cancelled=Mock(side_effect=[False, True]))
        client._request.assert_called_once()

    def test_comfy_worker_reads_outputs_from_the_pinned_jobs_api(self) -> None:
        prompt="00000000-0000-4000-8000-000000000051"
        client=object.__new__(ComfyClient)
        client.config=SimpleNamespace(request_timeout_seconds=10)
        client._job_api_mode=None
        client._request=Mock(return_value=json.dumps({"id":prompt,"status":"completed","outputs":{"12":{"videos":[
            {"filename":"clip.mp4","subfolder":f"sloptogether/{prompt}/00000000-0000-4000-8000-000000000052","type":"output"},
        ]}}}).encode())

        result=client.await_output(prompt,10)
        self.assertEqual(result,[{"node_id":"12","filename":"clip.mp4","subfolder":f"sloptogether/{prompt}/00000000-0000-4000-8000-000000000052","type":"output","content_type":""}])
        self.assertEqual(client._request.call_args.args[1],f"/api/jobs/{prompt}")

    def test_comfy_worker_falls_back_to_legacy_history_only_when_job_route_is_missing(self) -> None:
        prompt="00000000-0000-4000-8000-000000000053"
        file={"filename":"clip.mp4","subfolder":"sloptogether/job/attempt","type":"output"}
        client=object.__new__(ComfyClient)
        client.config=SimpleNamespace(request_timeout_seconds=10)
        client._job_api_mode=None
        client._request=Mock(side_effect=[WorkerError("comfy_http_404","missing route"),json.dumps({prompt:{"status":{"status_str":"success"},"outputs":{"12":{"videos":[file]}}}}).encode()])

        self.assertEqual(client.await_output(prompt,10)[0]["filename"],"clip.mp4")
        self.assertEqual([call.args[1] for call in client._request.call_args_list],[f"/api/jobs/{prompt}",f"/history/{prompt}"])

    def test_comfy_job_api_failure_is_terminal(self) -> None:
        client=object.__new__(ComfyClient)
        client.config=SimpleNamespace(request_timeout_seconds=10)
        client._job_api_mode="jobs"
        client._request=Mock(return_value=json.dumps({"status":"failed","outputs":{}}).encode())
        with self.assertRaisesRegex(WorkerError,"execution failure"):
            client.await_output("00000000-0000-4000-8000-000000000054",10)

    def test_comfy_job_api_does_not_hide_server_errors_with_legacy_fallback(self) -> None:
        client=object.__new__(ComfyClient)
        client.config=SimpleNamespace(request_timeout_seconds=10)
        client._job_api_mode=None
        client._request=Mock(side_effect=WorkerError("comfy_http_500","server error"))
        with self.assertRaisesRegex(WorkerError,"server error"):
            client.await_output("00000000-0000-4000-8000-000000000055",10)
        self.assertEqual(client._request.call_count,1)

    def test_prompt_cancellation_never_uses_global_interrupt(self) -> None:
        client = object.__new__(ComfyClient)
        client._request = Mock(return_value=b"{}")
        prompt_id = "123e4567-e89b-42d3-a456-426614174000"
        client.cancel_prompt(prompt_id)
        calls = client._request.call_args_list
        self.assertEqual(calls[0].args[1], "/queue")
        self.assertEqual(json.loads(calls[0].kwargs["body"]), {"delete": [prompt_id]})
        self.assertEqual(calls[1].args[1], "/interrupt")
        self.assertEqual(json.loads(calls[1].kwargs["body"]), {"prompt_id": prompt_id})


if __name__ == "__main__":
    unittest.main()
