from __future__ import annotations

import importlib.util
import os
import plistlib
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location("story_producer_service", ROOT / "scripts/story-producer-service.py")
assert SPEC and SPEC.loader
service = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(service)


@unittest.skipIf(os.name == "nt", "service scripts target macOS/Linux")
class StoryProducerServiceTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.key = self.root / "worker.key"
        self.key.write_text("slw_private_test_secret")
        self.key.chmod(0o600)
        self.config = self.root / "main.toml"
        self.config.write_text(f'[worker]\nchannel_id="stale2000"\nstream_slug="main"\ncredential_file="{self.key}"\n')

    def test_config_requires_private_regular_owner_key_and_scoped_channel(self):
        self.assertEqual(service.validate_config(self.config), ("stale2000", "main"))
        self.key.chmod(0o644)
        with self.assertRaisesRegex(ValueError, "worker key"):
            service.validate_config(self.config)
        self.key.unlink()
        self.key.symlink_to(self.config)
        with self.assertRaisesRegex(ValueError, "worker key"):
            service.validate_config(self.config)
        self.config.write_text(f'[worker]\nchannel_id=""\ncredential_file="{self.key}"\n')
        with self.assertRaisesRegex(ValueError, "channel"):
            service.validate_config(self.config)

    def test_service_files_never_include_secrets_and_have_isolated_labels(self):
        for platform in ("linux", "darwin"):
            content = service.render(self.config, Path("/usr/bin/python3"), platform, self.root)
            self.assertNotIn(b"slw_private_test_secret", content)
            self.assertIn(b"story-producer-service.py", content)
        payload = plistlib.loads(service.render(self.config, Path("/usr/bin/python3"), "darwin", self.root))
        self.assertEqual(payload["ProgramArguments"][-2:], ["--config", str(self.config)])
        self.assertTrue(payload["KeepAlive"])
        self.assertNotEqual(service.instance_name(self.config), service.instance_name(self.root / "other.toml"))

    def test_service_exec_scrubs_provider_keys_and_uses_template_planning(self):
        with patch.dict(os.environ, {"HOME": str(self.root), "PATH": "/usr/bin", "OPENAI_API_KEY": "private-provider-key", "SLOPTOGETHER_WORKER_KEY": "broad-worker-key", "FAL_KEY": "fal-key"}, clear=True), \
             patch.object(service.os, "chdir"), patch.object(service.os, "execve") as execute:
            service.run(self.config)
        _python, args, env = execute.call_args.args
        self.assertEqual(env["OPENAI_API_KEY"], "")
        self.assertNotIn("FAL_KEY", env)
        self.assertNotIn("SLOPTOGETHER_WORKER_KEY", env)
        self.assertIn("story-producer", args)
        self.assertNotIn("slw_private_test_secret", args)
        self.assertEqual(args[args.index("--config") + 1], str(self.config))

    def test_install_does_not_overwrite_an_existing_unit(self):
        label, path = service.paths(self.config, "linux", self.root)
        path.parent.mkdir(parents=True)
        path.write_text("existing service")
        with patch.object(service.sys, "version_info", (3, 12, 0)), patch.object(service.subprocess, "run") as run:
            with self.assertRaisesRegex(ValueError, "already exists"):
                service.control("install", self.config, "linux", self.root)
        self.assertEqual(path.read_text(), "existing service")
        run.assert_not_called()

    def test_systemd_quotes_special_path_characters(self):
        config = self.root / 'story $data %n.toml'
        result = service.render(config, Path('/usr/bin/python3'), 'linux', self.root).decode()
        self.assertIn('story $$data %%n.toml', result)
        self.assertIn('Restart=always', result)


if __name__ == "__main__":
    unittest.main()
