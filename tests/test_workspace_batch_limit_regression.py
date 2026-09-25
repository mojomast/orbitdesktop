"""Regression coverage for workspace operation batch limits without live services."""
import importlib.util
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]


def load_module(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


plugin = load_module("orbit_batch_plugin", ROOT / "hermes-plugin/__init__.py")
control = load_module("orbit_batch_control", ROOT / "scripts/workspace_control.py")
WORKSPACE = "11111111-1111-1111-1111-111111111111"


class Context:
    def __init__(self, settings):
        self.settings = settings
        self.tools = {}

    def get_config(self, key, default=None):
        return self.settings.get(key, default)

    def register_tool(self, **kwargs):
        self.tools[kwargs["name"]] = kwargs


class Response:
    def __init__(self, value):
        self.value = json.dumps(value).encode()

    def __enter__(self):
        return self

    def __exit__(self, *args):
        return False

    def read(self, *_args):
        return self.value


class WorkspaceBatchLimitRegression(unittest.TestCase):
    def test_adapter_accepts_32_and_rejects_empty_or_33_before_transport(self):
        with tempfile.TemporaryDirectory() as temp:
            record = Path(temp) / "workspaces" / f"{WORKSPACE}.json"
            record.parent.mkdir()
            record.write_text(json.dumps({"api": "http://127.0.0.1:4318", "capability": "fixture-capability"}))
            ctx = Context({"workspace_id": WORKSPACE, "runtime_dir": temp, "allow_mutations": True})
            plugin.register(ctx)
            handler = ctx.tools["orbit_workspace"]["handler"]
            ops = [{"action": "sidebar", "hidden": True} for _ in range(32)]

            with mock.patch.object(plugin.urllib.request, "build_opener") as build_opener:
                build_opener.return_value.open.return_value = Response({"revision": 8})
                result = json.loads(handler({"action": "apply", "base_revision": 7, "operations": ops}))
                self.assertTrue(result["ok"])
                build_opener.return_value.open.assert_called_once()
                sent = json.loads(build_opener.return_value.open.call_args.args[0].data)
                self.assertEqual(len(sent["operations"]), 32)

                build_opener.return_value.open.reset_mock()
                for invalid in ([], ops + [{"action": "sidebar", "hidden": False}]):
                    with self.subTest(count=len(invalid)):
                        result = json.loads(handler({"action": "apply", "base_revision": 7, "operations": invalid}))
                        self.assertFalse(result["ok"])
                        build_opener.return_value.open.assert_not_called()

    def test_cli_accepts_32_and_rejects_empty_or_33_before_transport(self):
        with tempfile.TemporaryDirectory() as temp:
            record = Path(temp) / "workspaces" / f"{WORKSPACE}.json"
            record.parent.mkdir()
            record.write_text(json.dumps({"api": "http://127.0.0.1:4318", "capability": "fixture-capability"}))
            ops = [{"action": "sidebar", "hidden": True} for _ in range(32)]
            calls = []

            def fake_urlopen(request, timeout=20):
                body = json.loads(request.data)
                calls.append(body)
                if body["action"] == "read":
                    return Response({"revision": 7, "observed_revision": 8})
                return Response({"revision": 8, "observed_revision": 8})

            def run_cli(batch):
                argv = ["workspace_control.py", "--workspace", WORKSPACE, "apply", json.dumps(batch)]
                with mock.patch.object(control, "RUNTIME", Path(temp)), \
                     mock.patch.object(sys, "argv", argv), \
                     mock.patch.object(control.urllib.request, "urlopen", side_effect=fake_urlopen):
                    control.main()

            run_cli(ops)
            self.assertEqual([call["action"] for call in calls], ["read", "apply", "read"])
            self.assertEqual(len(calls[1]["operations"]), 32)

            for invalid in ([], ops + [{"action": "sidebar", "hidden": False}]):
                with self.subTest(count=len(invalid)):
                    calls.clear()
                    with self.assertRaises(SystemExit):
                        run_cli(invalid)
                    self.assertEqual(calls, [])


if __name__ == "__main__":
    unittest.main()
