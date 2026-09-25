"""Python workspace contract and transport limits (no live workspace required)."""
import importlib.util
import io
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest import mock
import urllib.error


ROOT = Path(__file__).resolve().parents[1]
CONTRACT = json.loads((ROOT / "contracts/workspace-v1.json").read_text())
WORKSPACE = "11111111-1111-1111-1111-111111111111"
CAPABILITY = "fixture-only-workspace-capability"


def load_module(name, path):
    spec = importlib.util.spec_from_file_location(name, ROOT / path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


plugin = load_module("orbit_contract_plugin", "hermes-plugin/__init__.py")
control = load_module("orbit_contract_control", "scripts/workspace_control.py")


class Context:
    def __init__(self, runtime):
        self.settings = {"workspace_id": WORKSPACE, "runtime_dir": runtime, "allow_mutations": True}
        self.tools = {}

    def get_config(self, key, default=None):
        return self.settings.get(key, default)

    def register_tool(self, **kwargs):
        self.tools[kwargs["name"]] = kwargs


class Response:
    def __init__(self, data):
        self.data = data
        self.read_sizes = []

    def __enter__(self):
        return self

    def __exit__(self, *args):
        return False

    def read(self, size=-1):
        self.read_sizes.append(size)
        return self.data[:size]


class WorkspaceContractTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        record = Path(self.temp.name) / "workspaces" / (WORKSPACE + ".json")
        record.parent.mkdir()
        record.write_text(json.dumps({"api": "http://127.0.0.1:4318", "capability": CAPABILITY}))
        self.context = Context(self.temp.name)
        plugin.register(self.context)
        self.handler = self.context.tools["orbit_workspace"]["handler"]

    def tearDown(self):
        self.temp.cleanup()

    def run_cli(self, *args):
        output = io.StringIO()
        with mock.patch.object(control, "RUNTIME", Path(self.temp.name)), \
             mock.patch.object(sys, "argv", ["workspace_control.py", "--workspace", WORKSPACE, *args]), \
             mock.patch("sys.stdout", output):
            control.main()
        return json.loads(output.getvalue())

    def test_generated_limits_match_contract_and_plugin_schema(self):
        limits = CONTRACT["limits"]
        for name, value in limits.items():
            with self.subTest(limit=name):
                self.assertEqual(getattr(plugin, name), value)
                self.assertEqual(getattr(control, name), value)
        properties = plugin.SCHEMA["parameters"]["properties"]
        self.assertEqual(properties["operations"]["maxItems"], limits["maxOperations"])
        self.assertEqual(properties["label"]["maxLength"], limits["maxLabelCharacters"])
        for action in ("apply", "preview"):
            self.assertEqual(CONTRACT["commands"][action]["input"]["properties"]["operations"]["maxItems"], limits["maxOperations"])
        self.assertEqual(CONTRACT["commands"]["checkpoint"]["input"]["properties"]["label"]["maxLength"], limits["maxLabelCharacters"])

    def test_adapter_rejects_oversized_utf8_json_before_transport(self):
        # A single operation stays within maxItems, but exceeds the encoded byte budget.
        payload = {"action": "preview", "base_revision": 1, "operations": [{"action": "set_view", "view": "windows", "note": "é" * plugin.maxRequestBytes}]}
        self.assertGreater(len(json.dumps({**payload, "workspace_id": WORKSPACE}).encode("utf-8")), plugin.maxRequestBytes)
        with mock.patch.object(plugin.urllib.request, "build_opener") as opener:
            result = json.loads(self.handler(payload))
        self.assertFalse(result["ok"])
        self.assertIn("too large", result["error"])
        opener.assert_not_called()

    def test_cli_rejects_oversized_utf8_json_before_mutation_transport(self):
        operations = [{"action": "set_view", "view": "windows", "note": "é" * control.maxRequestBytes}]
        actions = []

        def urlopen(request, timeout=20):
            body = json.loads(request.data)
            actions.append(body["action"])
            return Response(json.dumps({"revision": 1, "observed_revision": 1}).encode())

        with mock.patch.object(control, "open_workspace", side_effect=urlopen):
            with self.assertRaisesRegex(ValueError, "request is too large"):
                self.run_cli("apply", json.dumps(operations))
        self.assertEqual(actions, ["read"])

    def test_adapter_bounds_response_read_and_rejects_oversize(self):
        response = Response(b"x" * (plugin.maxResponseBytes + 1))
        with mock.patch.object(plugin.urllib.request, "build_opener") as opener:
            opener.return_value.open.return_value = response
            result = json.loads(self.handler({"action": "read"}))
        self.assertFalse(result["ok"])
        self.assertIn("response exceeds", result["error"])
        self.assertEqual(response.read_sizes, [plugin.maxResponseBytes + 1])

    def test_cli_bounds_response_read_and_rejects_oversize(self):
        response = Response(b"x" * (control.maxResponseBytes + 1))
        with mock.patch.object(control, "open_workspace", return_value=response):
            with self.assertRaisesRegex(ValueError, "response exceeds"):
                self.run_cli("read")
        self.assertEqual(response.read_sizes, [control.maxResponseBytes + 1])

    def test_adapter_redacts_capability_in_response_and_http_error(self):
        with mock.patch.object(plugin.urllib.request, "build_opener") as opener:
            opener.return_value.open.return_value = Response(json.dumps({"echo": CAPABILITY}).encode())
            result = self.handler({"action": "read"})
            self.assertNotIn(CAPABILITY, result)
            self.assertFalse(json.loads(result)["ok"])

            opener.return_value.open.side_effect = urllib.error.HTTPError(
                "http://127.0.0.1:4318/api/workspace/control", 400, CAPABILITY, {}, io.BytesIO(CAPABILITY.encode()))
            result = self.handler({"action": "read"})
            self.assertNotIn(CAPABILITY, result)
            self.assertFalse(json.loads(result)["ok"])

    def test_cli_does_not_echo_capability_from_success_response(self):
        response = Response(json.dumps({"echo": CAPABILITY}).encode())
        with mock.patch.object(control, "open_workspace", return_value=response):
            output = io.StringIO()
            with mock.patch.object(control, "RUNTIME", Path(self.temp.name)), \
                 mock.patch.object(sys, "argv", ["workspace_control.py", "--workspace", WORKSPACE, "read"]), \
                 mock.patch("sys.stdout", output):
                try:
                    control.main()
                except ValueError:
                    pass
        self.assertNotIn(CAPABILITY, output.getvalue())

if __name__ == "__main__":
    unittest.main()
