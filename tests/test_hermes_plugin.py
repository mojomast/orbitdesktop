"""Real HTTP transport tests for the Hermes plugin (stdlib only)."""
import importlib.util
import json
from pathlib import Path
import tempfile
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

spec = importlib.util.spec_from_file_location("orbit_plugin", Path(__file__).resolve().parents[1] / "hermes-plugin/__init__.py")
plugin = importlib.util.module_from_spec(spec)
spec.loader.exec_module(plugin)
WORKSPACE = "11111111-1111-1111-1111-111111111111"


class Context:
    def __init__(self, settings):
        self.settings = settings
        self.tools = {}

    def get_config(self, key, default=None):
        return self.settings.get(key, default)

    def register_tool(self, **kwargs):
        self.tools[kwargs["name"]] = kwargs


class TransportTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.calls = []
        self.status = 200
        self.reply = {"revision": 7, "observed_revision": 6}
        outer = self

        class Handler(BaseHTTPRequestHandler):
            def do_POST(self):
                outer.calls.append((self.path, self.headers["Authorization"], json.loads(self.rfile.read(int(self.headers["Content-Length"])))))
                self.send_response(outer.status)
                if outer.status == 302:
                    self.send_header("Location", "/redirected")
                self.end_headers()
                self.wfile.write(json.dumps(outer.reply).encode())

            def log_message(self, *args):
                pass

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.thread = threading.Thread(target=self.server.serve_forever)
        self.thread.start()
        self.record = Path(self.temp.name) / "workspaces" / (WORKSPACE + ".json")
        self.record.parent.mkdir()
        self.record.write_text(json.dumps({"api": f"http://127.0.0.1:{self.server.server_port}", "capability": "test-only-capability"}))
        self.ctx = Context({"workspace_id": WORKSPACE, "runtime_dir": self.temp.name})
        plugin.register(self.ctx)

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join()
        self.temp.cleanup()

    def call(self, **params):
        return json.loads(self.ctx.tools["orbit_workspace"]["handler"](params))

    def test_read_real_http(self):
        result = self.call(action="read")
        self.assertTrue(result["ok"])
        self.assertEqual(result["result"], self.reply)
        self.assertEqual(self.calls[0], ("/api/workspace/control", "Bearer test-only-capability", {"action": "read", "workspace_id": WORKSPACE}))
        self.assertNotIn("test-only-capability", json.dumps(result))

    def test_default_deny_mutations(self):
        for action in ("apply", "checkpoint", "restore"):
            self.assertFalse(self.call(action=action)["ok"])
        self.assertFalse(self.calls)

    def test_preview_and_apply_revision(self):
        ops = [{"action": "sidebar", "hidden": True}]
        self.assertTrue(self.call(action="preview", operations=ops, base_revision=7)["ok"])
        self.ctx.settings["allow_mutations"] = True
        self.assertFalse(self.call(action="apply", operations=ops)["ok"])
        self.assertFalse(self.call(action="apply", operations=ops, base_revision=True)["ok"])
        self.assertTrue(self.call(action="apply", operations=ops, base_revision=7)["ok"])
        self.assertEqual(self.calls[-1][2]["base_revision"], 7)

    def test_restore_confirmation_and_history(self):
        self.ctx.settings["allow_mutations"] = True
        self.assertFalse(self.call(action="restore", checkpoint_id="test", base_revision=7)["ok"])
        self.assertTrue(self.call(action="restore", checkpoint_id="test", base_revision=7, confirm=True)["ok"])
        self.assertTrue(self.call(action="checkpoint", label="Before edit")["ok"])
        self.assertTrue(self.call(action="history")["ok"])

    def test_conflict_no_retry_and_error_redaction(self):
        self.status = 409
        self.reply = {"error": "test-only-capability"}
        result = self.call(action="read")
        self.assertEqual(result["status"], 409)
        self.assertNotIn("test-only-capability", json.dumps(result))
        self.assertEqual(len(self.calls), 1)

    def test_redirect_refused(self):
        self.status = 302
        self.assertFalse(self.call(action="read")["ok"])
        self.assertEqual(len(self.calls), 1)

    def test_remote_and_credential_urls_refused(self):
        for url in ("http://example.com", "http://localhost", "http://127.0.0.1.evil.com", "http://user:secret@127.0.0.1", "file:///tmp/x", "http://127.0.0.1/path", "http://127.0.0.1?x=1"):
            with self.assertRaises(ValueError):
                plugin.endpoint(url)

    def test_capability_response_refused(self):
        self.reply = {"leak": "test-only-capability"}
        self.assertFalse(self.call(action="read")["ok"])

    def test_profile_scope_A_B_A(self):
        self.assertTrue(self.call(action="read")["ok"])
        self.ctx.settings["workspace_id"] = "22222222-2222-2222-2222-222222222222"
        self.assertFalse(self.call(action="read")["ok"])
        self.ctx.settings["workspace_id"] = WORKSPACE
        self.assertTrue(self.call(action="read")["ok"])
        self.assertEqual(len(self.calls), 2)

    def test_arguments_cannot_override_scope(self):
        self.assertFalse(self.call(action="read", workspace_id=WORKSPACE)["ok"])
        self.ctx.settings["workspace_id"] = "../../other"
        self.assertFalse(self.call(action="read")["ok"])
        self.assertFalse(self.calls)


if __name__ == "__main__":
    unittest.main()
