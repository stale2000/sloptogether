from __future__ import annotations

import importlib.util
import unittest
from pathlib import Path

_SCRIPT = Path(__file__).parents[1] / "fal" / "set_worker_secrets.py"
_SPEC = importlib.util.spec_from_file_location("set_fal_worker_secrets", _SCRIPT)
assert _SPEC and _SPEC.loader
_MODULE = importlib.util.module_from_spec(_SPEC)
_SPEC.loader.exec_module(_MODULE)


class FalWorkerSecretTests(unittest.TestCase):
    def test_secrets_are_scoped_by_role_and_not_exposed_to_other_apps(self):
        calls = []

        class Store:
            def set(self, name, value, environment_name=None, default_exposed=None):
                calls.append((name, value, environment_name, default_exposed))

        values = {
            "SLOPTOGETHER_WORKER_KEY_GENERATION": "g" * 40,
            "SLOPTOGETHER_WORKER_KEY_UPSCALE": "u" * 40,
            "SLOPTOGETHER_API_BASE_URL": "https://www.clips.gg/sloptogether/api/v1",
            "SLOPTOGETHER_ALLOWED_UPLOAD_HOSTS": "acct.r2.cloudflarestorage.com,uploads.clips.gg",
        }
        _MODULE.set_worker_secrets(Store(), values)
        self.assertEqual(calls, [
            ("SLOPTOGETHER_WORKER_KEY_GENERATION", "g" * 40, None, False),
            ("SLOPTOGETHER_WORKER_KEY_UPSCALE", "u" * 40, None, False),
            ("SLOPTOGETHER_API_BASE_URL", "https://www.clips.gg/sloptogether/api/v1", None, False),
            ("SLOPTOGETHER_ALLOWED_UPLOAD_HOSTS", "acct.r2.cloudflarestorage.com,uploads.clips.gg", None, False),
        ])

    def test_validates_both_keys_before_sending_any_secret(self):
        calls = []

        class Store:
            def set(self, *args, **kwargs):
                calls.append((args, kwargs))

        with self.assertRaisesRegex(ValueError, "SLOPTOGETHER_WORKER_KEY_UPSCALE"):
            _MODULE.set_worker_secrets(Store(), {
                "SLOPTOGETHER_WORKER_KEY_GENERATION": "g" * 40,
                "SLOPTOGETHER_WORKER_KEY_UPSCALE": "short",
                "SLOPTOGETHER_API_BASE_URL": "https://www.clips.gg/sloptogether/api/v1",
                "SLOPTOGETHER_ALLOWED_UPLOAD_HOSTS": "uploads.clips.gg",
            })
        self.assertEqual(calls, [])

    def test_rejects_loopback_or_unscoped_worker_endpoints_before_setting_secrets(self):
        calls=[]
        class Store:
            def set(self,*args,**kwargs):calls.append((args,kwargs))
        values={"SLOPTOGETHER_WORKER_KEY_GENERATION":"g"*40,"SLOPTOGETHER_WORKER_KEY_UPSCALE":"u"*40,
            "SLOPTOGETHER_API_BASE_URL":"http://localhost:3000/sloptogether/api/v1","SLOPTOGETHER_ALLOWED_UPLOAD_HOSTS":"localhost"}
        with self.assertRaisesRegex(ValueError,"fal_worker_api_url_invalid"):_MODULE.set_worker_secrets(Store(),values)
        self.assertEqual(calls,[])


if __name__ == "__main__":
    unittest.main()
