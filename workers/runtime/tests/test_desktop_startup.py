from __future__ import annotations

import tempfile
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from sloptogether_worker.desktop import _comfy_health_url, ensure_comfy_ready, parse_channel_target, wait_for_comfy


class DesktopStartupTest(unittest.TestCase):
    def test_channel_and_stream_links_resolve_to_channel_login_and_stream_slug(self) -> None:
        self.assertEqual(parse_channel_target(
            "https://www.clips.gg/sloptogether/channels/stale2000/streams/cartoon-demo/output", "main"
        ), ("stale2000", "cartoon-demo"))
        self.assertEqual(parse_channel_target("https://clips.gg/sloptogether/channels/stale2000/output", "test-stream"),
                         ("stale2000", "test-stream"))

    def test_channel_link_parser_rejects_other_origins_and_invalid_streams(self) -> None:
        for value in ("https://evil.example/sloptogether/channels/stale2000", "http://www.clips.gg/sloptogether/channels/stale2000"):
            with self.subTest(value=value), self.assertRaises(ValueError):
                parse_channel_target(value)
        with self.assertRaisesRegex(ValueError, "invalid stream"):
            parse_channel_target("https://www.clips.gg/sloptogether/channels/stale2000/streams/bad%2Fslug/output")

    def test_health_url_uses_configured_local_comfy_endpoint(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            config = Path(directory) / "worker.generation.toml"
            config.write_text("[worker]\ncomfy_url='http://127.0.0.1:8189'\n", encoding="utf-8")
            self.assertEqual(_comfy_health_url(config), "http://127.0.0.1:8189/system_stats")

    def test_health_url_rejects_non_loopback_config(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            config = Path(directory) / "worker.generation.toml"
            config.write_text("[worker]\ncomfy_url='http://example.com:8188'\n", encoding="utf-8")
            with self.assertRaisesRegex(ValueError, "loopback"):
                _comfy_health_url(config)

    def test_waits_until_api_is_ready(self) -> None:
        responses = iter([False, False, True])
        now = [0.0]

        def sleep(seconds: float) -> None:
            now[0] += seconds

        self.assertTrue(wait_for_comfy("http://127.0.0.1:8188/system_stats", timeout=10,
                                       probe=lambda _url: next(responses), sleep=sleep,
                                       monotonic=lambda: now[0]))

    def test_worker_readiness_requires_comfy_start_then_api_success(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            config = root / "worker.generation.toml"
            config.write_text("[worker]\ncomfy_url='http://127.0.0.1:8188'\n", encoding="utf-8")
            actions: list[str] = []

            def start(_root: Path, _role: str) -> int:
                actions.append("start")
                return 0

            def wait(endpoint: str) -> bool:
                actions.append(endpoint)
                return True

            ready, message = ensure_comfy_ready(root, "generation", config, start, wait=wait,
                                                on_wait=lambda: actions.append("wait"))
            self.assertTrue(ready)
            self.assertEqual(message, "ComfyUI is ready. Starting worker…")
            self.assertEqual(actions, ["start", "wait", "http://127.0.0.1:8188/system_stats"])

    def test_worker_is_not_started_when_comfy_launch_fails_or_api_times_out(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            config = root / "worker.generation.toml"
            config.write_text("[worker]\ncomfy_url='http://127.0.0.1:8188'\n", encoding="utf-8")
            waits: list[str] = []
            ready, _message = ensure_comfy_ready(root, "generation", config, lambda _root, _role: 1,
                                                 wait=lambda _url: waits.append("called") or True)
            self.assertFalse(ready)
            self.assertEqual(waits, [])

            ready, message = ensure_comfy_ready(root, "generation", config, lambda _root, _role: 0,
                                                wait=lambda _url: False)
            self.assertFalse(ready)
            self.assertIn("worker was not started", message)


if __name__ == "__main__":
    unittest.main()
