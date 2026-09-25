"""Receipt/discovery compatibility using disposable records and bounded fake HTTP."""
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
WORKSPACE = "11111111-1111-4111-8111-111111111111"

def load(name, filename):
    spec = importlib.util.spec_from_file_location(name, ROOT / filename)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module

plugin = load("receipt_plugin", "hermes-plugin/__init__.py")
control = load("receipt_control", "scripts/workspace_control.py")

class Response:
    def __init__(self, body): self.body = json.dumps(body).encode()
    def __enter__(self): return self
    def __exit__(self, *_args): pass
    def read(self, size): return self.body[:size]

class Context:
    def __init__(self, root): self.root = root
    def get_config(self, name, default=None):
        return {"workspace_id": WORKSPACE, "runtime_dir": str(self.root), "allow_mutations": True}.get(name, default)

class CommandAdapters(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="orbit-command-adapters-")
        self.root = Path(self.temp.name)
        for name, capability in (("workspaces", "stale-legacy-capability"), ("workspace-access", "current-fixture-capability")):
            (self.root / name).mkdir()
            (self.root / name / (WORKSPACE + ".json")).write_text(json.dumps({"api": "http://127.0.0.1:4318", "capability": capability}))
        self.context = Context(self.root)
    def tearDown(self): self.temp.cleanup()
    def cli(self, *args):
        output = io.StringIO()
        with mock.patch.object(control, "RUNTIME", self.root), mock.patch.object(sys, "argv", ["workspace_control.py", "--workspace", WORKSPACE, *args]), mock.patch("sys.stdout", output):
            control.main()
        return json.loads(output.getvalue())
    def test_projection_is_preferred_by_both_adapters(self):
        with mock.patch.object(plugin.urllib.request, "build_opener") as opener:
            opener.return_value.open.return_value = Response({"revision": 5})
            self.assertTrue(plugin.invoke(self.context, {"action": "read"})["ok"])
            self.assertEqual(opener.return_value.open.call_args.args[0].get_header("Authorization"), "Bearer current-fixture-capability")
        with mock.patch.object(control, "open_workspace", return_value=Response({"revision": 5})) as opened:
            self.cli("read")
            self.assertEqual(opened.call_args.args[0].get_header("Authorization"), "Bearer current-fixture-capability")
    def test_missing_projection_after_migration_fails_closed_not_legacy_fallback(self):
        (self.root / "workspace-access" / (WORKSPACE + ".json")).unlink()
        (self.root / "workspace.sqlite").touch()
        with self.assertRaises(ValueError): plugin.invoke(self.context, {"action": "read"})
        with self.assertRaises(ValueError): self.cli("read")
    def test_hermes_advertises_only_real_control_actions_and_reuses_explicit_checkpoint_key(self):
        self.assertEqual(set(plugin.ACTIONS), {"read", "preview", "apply", "history", "checkpoint", "restore"})
        payload = {"action": "checkpoint", "base_revision": 5, "label": "Known", "operation_id": "stable-key", "intent": "Reviewed checkpoint"}
        with mock.patch.object(plugin.urllib.request, "build_opener") as opener:
            opener.return_value.open.return_value = Response({"checkpoint": "fixture"})
            plugin.invoke(self.context, payload); plugin.invoke(self.context, payload)
            requests = [json.loads(call.args[0].data) for call in opener.return_value.open.call_args_list]
            self.assertEqual(requests[0], requests[1])
            self.assertEqual(requests[0]["operation_id"], "stable-key")
            self.assertEqual(len(requests), 2, "Explicit base must not be replaced by a pre-read")
    def test_unknown_hermes_outcome_exposes_key_not_capability_and_does_not_retry(self):
        payload = {"action": "apply", "base_revision": 5, "operations": [{"action": "sidebar", "hidden": True}], "operation_id": "uncertain-key", "intent": "Reviewed edit"}
        with mock.patch.object(plugin.urllib.request, "build_opener") as opener:
            opener.return_value.open.side_effect = urllib.error.URLError("private transport detail")
            result = plugin.invoke(self.context, payload)
            self.assertEqual(result["outcome"], "unknown"); self.assertEqual(result["operation_id"], "uncertain-key")
            self.assertNotIn("capability", json.dumps(result)); self.assertNotIn("private transport detail", json.dumps(result))
            opener.return_value.open.assert_called_once()
    def test_cli_retains_receipt_while_polling_and_uses_exact_provided_metadata(self):
        calls = []
        def send(request, timeout=20):
            payload = json.loads(request.data); calls.append(payload)
            return Response({"revision": 6, "observed_revision": 6, **({"command_receipt": {"operation_id": "cli-key", "legacy": False}} if payload["action"] == "apply" else {})})
        with mock.patch.object(control, "open_workspace", side_effect=send):
            result = self.cli("apply", '[{"action":"sidebar","hidden":true}]', "--base-revision", "5", "--operation-id", "cli-key", "--intent", "Reviewed edit")
        self.assertEqual(result["command_receipt"]["operation_id"], "cli-key")
        self.assertEqual([call["action"] for call in calls], ["read", "apply", "read"])
        self.assertEqual(calls[1]["base_revision"], 5)
    def test_cli_transport_rejects_remote_or_credential_destinations(self):
        for url in ("https://example.com", "http://localhost", "http://u:p@127.0.0.1", "http://127.0.0.1/path", "file:///tmp/test"):
            with self.subTest(url=url), self.assertRaises(ValueError): control.endpoint(url)

    def test_generic_publisher_cannot_overwrite_content_addressed_slug(self):
        with mock.patch.object(control, "open_workspace", return_value=Response({"revision": 5})), self.assertRaises(SystemExit):
            self.cli("publish", str(self.root / "unused-source"), "widget-" + "a" * 24, "--no-open")
        self.assertFalse((self.root / "apps").exists())

if __name__ == "__main__": unittest.main()
