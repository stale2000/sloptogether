from datetime import datetime, timedelta, timezone
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock, patch
import json
import os
import signal
import tempfile
import threading
import unittest
import urllib.error
from contextlib import redirect_stdout
from email.message import Message
from io import BytesIO, StringIO

from sloptogether_worker import cli
from sloptogether_worker.client import Lease, PairingInstructions
from sloptogether_worker.client import WorkerApi
from sloptogether_worker.comfy import ComfyClient
from sloptogether_worker.errors import ApiError, WorkerError
from sloptogether_worker.runner import LeaseHeartbeat
from sloptogether_worker.service import WorkerService


class WorkerLifecycleTest(unittest.TestCase):
    def test_pairing_rejects_credentials_that_would_mask_the_new_key(self) -> None:
        with tempfile.TemporaryDirectory() as folder:
            root=Path(folder)
            config=SimpleNamespace(role="generation",platform="linux",state_dir=root)
            api=Mock()
            path=root/"worker.toml"
            path.write_text('[worker]\ncredential_file="other.key"\n')
            with patch.dict(os.environ,{},clear=True):
                with self.assertRaisesRegex(WorkerError,"credential"):
                    cli._pair(config,api,open_browser=False,config_path=path)
            path.write_text('[worker]\nrole="generation"\n')
            for variable in ("SLOPTOGETHER_WORKER_KEY", "SLOPTOGETHER_WORKER_KEY_GENERATION"):
                with self.subTest(variable=variable), patch.dict(os.environ,{variable:"private-test-key"},clear=True):
                    with self.assertRaisesRegex(WorkerError,"credential"):
                        cli._pair(config,api,open_browser=False,config_path=path)
            api.create_pairing.assert_not_called()

    def test_claim_advertises_only_the_checked_recipe_list(self) -> None:
        config = SimpleNamespace(role="upscale", channel_id="123", api_base_url="https://www.clips.gg/sloptogether/api/v1", worker_key="key", allowed_upload_hosts=())
        api = WorkerApi(config)
        api._request = Mock(return_value=({"status": "empty"}, {}))
        self.assertIsNone(api.claim(["sol-h3-upscale-pruna-fast-1184-v1"]))
        api._request.assert_called_once_with("POST", "/workers/leases", body={"supportedRecipes": ["sol-h3-upscale-pruna-fast-1184-v1"]}, query={"role": "upscale", "channelId": "123"})

    def test_legacy_claim_omits_capabilities(self) -> None:
        config = SimpleNamespace(role="upscale", channel_id=None, api_base_url="https://www.clips.gg/sloptogether/api/v1", worker_key="key", allowed_upload_hosts=())
        api = WorkerApi(config)
        api._request = Mock(return_value=({"status": "empty"}, {}))
        self.assertIsNone(api.claim())
        api._request.assert_called_once_with("POST", "/workers/leases", body={}, query={"role": "upscale"})

    def test_service_passes_compatible_profiles_to_every_claim(self) -> None:
        api = Mock(token="key")
        api.claim.return_value = None
        config = SimpleNamespace(role="upscale", poll_interval_seconds=1)
        service = WorkerService(config, api=api, comfy=Mock(), report=lambda _message: None)
        service.check = Mock(return_value=["sol-h3-upscale-pruna-fast", "sol-h3-upscale-pruna-fast-1184-v1"])
        self.assertEqual(service.run(once=True), 0)
        api.claim.assert_called_once_with(["sol-h3-upscale-pruna-fast", "sol-h3-upscale-pruna-fast-1184-v1"])

    def test_slow_configured_heartbeat_refreshes_before_the_lease_expires(self) -> None:
        api = Mock()
        api.heartbeat.return_value = {"state": "running"}
        heartbeat = LeaseHeartbeat(api, Lease("lease-1", 1, {}), interval_seconds=60)
        heartbeat.stop = Mock()
        heartbeat.stop.wait.side_effect = [False, True]
        heartbeat._loop()

        self.assertLess(heartbeat.stop.wait.call_args_list[0].args[0], 60)
        api.heartbeat.assert_called_once()

    def test_worker_refreshes_lease_before_requesting_upload_grant(self) -> None:
        with tempfile.TemporaryDirectory() as folder:
            config = SimpleNamespace(state_dir=Path(folder), heartbeat_interval_seconds=60, max_output_bytes=1024)
            api = Mock()
            api.heartbeat.return_value = {"state": "running"}
            api.issue_upload.return_value = {"uploadId": "upload-1", "maxBytes": 1024}
            api.complete_upload.return_value = {"accepted": True}
            service = WorkerService(config, api=api, comfy=Mock(), report=lambda _message: None)
            job = SimpleNamespace(lease_id="lease-1", fence=1, attempt_id="attempt-1", stage="upscale", channel_id="channel")
            lease = Lease("lease-1", 1, {})

            def execute(_job, _lease, _heartbeat, _api, workspace, **_kwargs):
                output = workspace / "clip.mp4"
                output.write_bytes(b"video")
                return output, {"width": 1920, "height": 1080, "durationSeconds": 15.0}

            service.runner.execute = execute
            with patch("sloptogether_worker.service.WorkerJob.from_payload", return_value=job):
                service._process(lease)

            names = [call[0] for call in api.method_calls]
            self.assertEqual(names, ["heartbeat", "issue_upload", "upload_file", "complete_upload"])
            api.heartbeat.assert_called_once_with(lease, phase="uploading", progress=0.86)

    def test_failed_upload_reports_storage_reason_without_the_signed_url(self) -> None:
        config = SimpleNamespace(api_base_url="https://www.clips.gg/sloptogether/api/v1", request_timeout_seconds=3,
                                 worker_key=None, allowed_upload_hosts=("storage.example",), local_s3_endpoint=None)
        api = WorkerApi(config)
        headers = Message()
        headers["x-amz-request-id"] = "request-123"
        error = urllib.error.HTTPError("https://storage.example/object?signature=secret", 403, "Forbidden", headers,
                                       BytesIO(b"<Error><Code>ExpiredToken</Code></Error>"))
        api.opener = SimpleNamespace(open=Mock(side_effect=error))
        grant = {"uploadUrl": "https://storage.example/object?signature=secret", "method": "PUT",
                 "expiresAt": "2030-01-01T00:00:00Z", "requiredHeaders": {"Content-Type": "video/mp4"}}
        with tempfile.TemporaryDirectory() as folder:
            output_file = Path(folder) / "clip.mp4"
            output_file.write_bytes(b"video")
            output = StringIO()
            with redirect_stdout(output), self.assertRaises(ApiError) as raised:
                api.upload_file(grant, str(output_file), max_bytes=1024)
        self.assertEqual((raised.exception.status, raised.exception.code), (403, "cloud_upload_failed"))
        self.assertIn("provider_code=ExpiredToken", output.getvalue())
        self.assertNotIn("signature=secret", output.getvalue())

    def test_failed_gateway_upload_reports_only_known_json_error(self) -> None:
        config = SimpleNamespace(api_base_url="https://www.clips.gg/sloptogether/api/v1", request_timeout_seconds=3,
                                 worker_key=None, allowed_upload_hosts=("uploads.clips.gg",), local_s3_endpoint=None)
        api = WorkerApi(config)
        headers = Message()
        headers["Content-Type"] = "application/json; charset=utf-8"
        error = urllib.error.HTTPError("https://uploads.clips.gg/uploads/id?ticket=secret", 403, "Forbidden", headers,
                                       BytesIO(b'{"error":"upload_ticket_invalid","detail":"secret_body"}'))
        api.opener = SimpleNamespace(open=Mock(side_effect=error))
        grant = {"uploadUrl": "https://uploads.clips.gg/uploads/id?ticket=secret", "method": "PUT",
                 "expiresAt": "2030-01-01T00:00:00Z", "requiredHeaders": {"Content-Type": "video/mp4"}}
        with tempfile.TemporaryDirectory() as folder:
            output_file = Path(folder) / "clip.mp4"
            output_file.write_bytes(b"video")
            output = StringIO()
            with redirect_stdout(output), self.assertRaises(ApiError):
                api.upload_file(grant, str(output_file), max_bytes=1024)
        self.assertIn("host=uploads.clips.gg response_type=application/json gateway_error=upload_ticket_invalid", output.getvalue())
        self.assertNotIn("secret", output.getvalue())
        request = api.opener.open.call_args.args[0]
        self.assertEqual(request.get_header("User-agent"), api.user_agent)
        self.assertEqual(request.get_header("Content-type"), "video/mp4")

    def test_worker_does_not_request_upload_after_lease_revocation(self) -> None:
        with tempfile.TemporaryDirectory() as folder:
            config = SimpleNamespace(state_dir=Path(folder), heartbeat_interval_seconds=60, max_output_bytes=1024)
            api = Mock()
            api.heartbeat.return_value = {"state": "revoked"}
            service = WorkerService(config, api=api, comfy=Mock(), report=lambda _message: None)
            job = SimpleNamespace(lease_id="lease-1", fence=1, attempt_id="attempt-1", stage="upscale", channel_id="channel")
            lease = Lease("lease-1", 1, {})

            def execute(_job, _lease, _heartbeat, _api, workspace, **_kwargs):
                output = workspace / "clip.mp4"
                output.write_bytes(b"video")
                return output, {"width": 1920, "height": 1080, "durationSeconds": 15.0}

            service.runner.execute = execute
            with patch("sloptogether_worker.service.WorkerJob.from_payload", return_value=job):
                with self.assertRaises(WorkerError) as error:
                    service._process(lease)
            self.assertEqual(error.exception.code, "attempt_revoked")
            api.issue_upload.assert_not_called()

    def test_worker_closes_heartbeat_and_fails_attempt_if_workspace_creation_fails(self) -> None:
        config = SimpleNamespace(heartbeat_interval_seconds=30)
        api = Mock()
        service = WorkerService(config, api=api, comfy=Mock(), report=lambda _message: None)
        service._state_dir = Mock(return_value=Path("/temporary/state"))
        lease = Lease("lease-1", 1, {})
        job = SimpleNamespace(lease_id="lease-1", fence=1, attempt_id="attempt-1")
        heartbeat = Mock()
        with patch("sloptogether_worker.service.WorkerJob.from_payload", return_value=job), \
             patch("sloptogether_worker.service.LeaseHeartbeat", return_value=heartbeat), \
             patch("sloptogether_worker.service.tempfile.mkdtemp", side_effect=OSError("private path detail")):
            with self.assertRaises(WorkerError) as error:
                service._process(lease)
        self.assertEqual(error.exception.code, "worker_workspace_unavailable")
        self.assertNotIn("private path detail", str(error.exception))
        heartbeat.start.assert_called_once_with()
        heartbeat.close.assert_called_once_with()
        api.fail_attempt.assert_called_once_with(lease, "worker_workspace_unavailable")

    def test_cli_exposes_the_wsl_platform_option(self) -> None:
        args=cli.parser().parse_args(["--platform","wsl","check"])
        self.assertEqual(args.platform,"wsl")

    def test_worker_api_uses_the_proxy_scoped_authorization_scheme(self) -> None:
        class Response:
            headers = {}
            def __enter__(self): return self
            def __exit__(self,*_args): return None
            def read(self,_limit): return b"{}"
        config=SimpleNamespace(api_base_url="https://www.clips.gg/sloptogether/api/v1",request_timeout_seconds=3,worker_key=None,allowed_upload_hosts=(),local_s3_endpoint=None)
        api=WorkerApi(config);api.token="slw_123e4567-e89b-42d3-a456-426614174000."+"a"*32
        api.opener=SimpleNamespace(open=Mock(return_value=Response()))
        api._request("GET","/worker/claim")
        request=api.opener.open.call_args.args[0]
        self.assertEqual(request.get_header("Authorization"),f"SlopWorker {api.token}")

    def test_worker_api_preserves_server_error_code_field(self) -> None:
        config=SimpleNamespace(api_base_url="https://www.clips.gg/sloptogether/api/v1",request_timeout_seconds=3,worker_key=None,allowed_upload_hosts=(),local_s3_endpoint=None)
        api=WorkerApi(config);api.token="slw_123e4567-e89b-42d3-a456-426614174000."+"a"*32
        response=urllib.error.HTTPError(
            "https://www.clips.gg/sloptogether/api/v1/channels/localdemo/story-proposals",
            409,"Conflict",{},BytesIO(b'{"error":"owner_generation_budget_unavailable","message":"No budget."}'),
        )
        api.opener=SimpleNamespace(open=Mock(side_effect=response))
        with self.assertRaises(ApiError) as raised:
            api._request("POST","/channels/localdemo/story-proposals",body={})
        self.assertEqual((raised.exception.status,raised.exception.code),(409,"owner_generation_budget_unavailable"))

    def test_worker_asset_storage_403_is_not_misreported_as_worker_auth(self) -> None:
        config=SimpleNamespace(api_base_url="https://www.clips.gg/sloptogether/api/v1",request_timeout_seconds=3,worker_key=None,allowed_upload_hosts=("sloptogether-media.example.r2.cloudflarestorage.com",))
        api=WorkerApi(config);api.token="slw_123e4567-e89b-42d3-a456-426614174000."+"a"*32
        headers=Message();headers["Content-Type"]="text/html";headers["Server"]="cloudflare";headers["cf-ray"]="ray-123"
        response=urllib.error.HTTPError("https://uploads.clips.gg/worker-media",403,"Forbidden",headers,BytesIO(b"<html>Access denied</html>"))
        api._request=Mock(return_value=({"url":"https://uploads.clips.gg/worker-media","ticket":"signed.ticket"},{}))
        api.media_opener=SimpleNamespace(open=Mock(side_effect=response))
        lease=SimpleNamespace(lease_id="lease",fence=1)
        output=StringIO()
        with self.assertRaises(WorkerError) as raised:
            with redirect_stdout(output):
                api.download_asset(lease,"asset","/tmp/not-created",1024)
        self.assertEqual(raised.exception.code,"asset_storage_forbidden")
        self.assertNotIsInstance(raised.exception,ApiError)
        self.assertIn("cf_ray=ray-123",output.getvalue())
        self.assertNotIn("signed.ticket",output.getvalue())

    def test_worker_media_download_rejects_untrusted_gateway_urls(self) -> None:
        config=SimpleNamespace(api_base_url="https://www.clips.gg/sloptogether/api/v1",request_timeout_seconds=3,worker_key=None,allowed_upload_hosts=("uploads.clips.gg",))
        api=WorkerApi(config);api.token="slw_123e4567-e89b-42d3-a456-426614174000."+"a"*32
        api._request=Mock(return_value=({"url":"https://attacker.example/collect","ticket":"signed.ticket"},{}))
        api.media_opener=SimpleNamespace(open=Mock())
        with self.assertRaises(WorkerError) as raised:
            api.download_asset(SimpleNamespace(lease_id="lease",fence=1),"asset","/tmp/not-created",1024)
        self.assertEqual(raised.exception.code,"asset_download_url_invalid")
        api.media_opener.open.assert_not_called()

    def test_worker_media_download_streams_only_the_scoped_ticket(self) -> None:
        payload=b"approved image"
        class Response:
            headers={"Content-Length":str(len(payload))}
            def __enter__(self): return self
            def __exit__(self,*_args): return None
            def read(self,size):
                nonlocal payload
                chunk,payload=payload[:size],payload[size:]
                return chunk
        config=SimpleNamespace(api_base_url="https://www.clips.gg/sloptogether/api/v1",request_timeout_seconds=3,worker_key=None,allowed_upload_hosts=("uploads.clips.gg",))
        api=WorkerApi(config);api.token="slw_123e4567-e89b-42d3-a456-426614174000."+"a"*32
        api._request=Mock(return_value=({"url":"https://uploads.clips.gg/worker-media","ticket":"signed.ticket"},{}))
        api.media_opener=SimpleNamespace(open=Mock(return_value=Response()))
        lease=SimpleNamespace(lease_id="lease",fence=7)
        with tempfile.TemporaryDirectory() as folder:
            destination=str(Path(folder)/"frame.png")
            api.download_asset(lease,"asset",destination,1024)
            self.assertEqual(Path(destination).read_bytes(),b"approved image")
        request=api.media_opener.open.call_args.args[0]
        self.assertEqual(request.full_url,"https://uploads.clips.gg/worker-media")
        self.assertEqual(request.get_header("X-worker-artifact-ticket"),"signed.ticket")
        self.assertIsNone(request.get_header("Authorization"))
        api._request.assert_called_once()

    def test_claim_403_for_asset_download_does_not_report_invalid_worker_key(self) -> None:
        config=SimpleNamespace(role="generation",poll_interval_seconds=0,worker_key=None)
        api=SimpleNamespace(token="worker-key",claim=Mock(side_effect=ApiError(403,"asset_download_failed")))
        service=WorkerService(config,api=api,comfy=Mock(),report=lambda _message:None)
        service.check=Mock(return_value=[])
        with self.assertRaises(ApiError) as raised:
            service.run(once=True)
        self.assertEqual(raised.exception.code,"asset_download_failed")

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

    def test_cli_routes_story_producer_through_the_supervised_worker_service(self) -> None:
        config = SimpleNamespace(role="story-producer")
        service = SimpleNamespace(stop=threading.Event(), run=Mock(return_value=0))
        args = SimpleNamespace(command="run", config=None, role=None, headless=True, once=True)
        with patch("sloptogether_worker.cli.parser", return_value=SimpleNamespace(parse_args=lambda: args)), \
             patch("sloptogether_worker.cli.WorkerConfig.from_sources", return_value=config), \
             patch("sloptogether_worker.cli.WorkerApi", return_value=SimpleNamespace(token="owner-key")), \
             patch("sloptogether_worker.cli.WorkerService", return_value=service), \
             patch("sloptogether_worker.cli.signal.signal"):
            self.assertEqual(cli.main(), 0)
        service.run.assert_called_once_with(once=True)

    def test_story_producer_retries_a_transient_service_failure(self) -> None:
        config=SimpleNamespace(role="story-producer",worker_key="owner-key",poll_interval_seconds=0)
        api=SimpleNamespace(token="owner-key")
        service=WorkerService(config,api=api,comfy=Mock(),report=lambda _message:None)
        producer=Mock()
        producer.run_once.side_effect=[WorkerError("service_unreachable","temporary failure"),False]
        wait_calls=0
        def wait_then_stop(_delay):
            nonlocal wait_calls
            wait_calls+=1
            if wait_calls>1:service.stop.set()
        service.stop.wait=Mock(side_effect=wait_then_stop)

        with patch("sloptogether_worker.service.StoryProducer",return_value=producer), \
             self.assertLogs("sloptogether.worker", level="WARNING") as logs:
            self.assertEqual(service.run(),0)

        self.assertEqual(producer.run_once.call_count,2)
        self.assertIn("service_unreachable", logs.output[0])
        self.assertNotIn("temporary failure", logs.output[0])

    def test_story_producer_stops_on_revoked_owner_permission(self) -> None:
        config=SimpleNamespace(role="story-producer",worker_key="owner-key",poll_interval_seconds=0)
        service=WorkerService(config,api=SimpleNamespace(token="owner-key"),comfy=Mock(),report=lambda _message:None)
        producer=Mock()
        producer.run_once.side_effect=ApiError(403,"story_producer_binding_revoked")
        with patch("sloptogether_worker.service.StoryProducer",return_value=producer):
            with self.assertRaises(WorkerError) as error:
                service.run()
        self.assertEqual(error.exception.code,"story_producer_scope_required")
        producer.run_once.assert_called_once_with()

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
