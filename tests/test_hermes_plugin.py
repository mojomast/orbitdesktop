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

    def test_conflict_categories_and_retained_identity(self):
        self.ctx.settings['allow_mutations'] = True
        self.status = 409
        for category in ('RECOVERY_HOLD', 'IDEMPOTENCY_CONFLICT', 'RECOVERY_POLICY_CHANGED', 'RESOURCE_BUSY', 'REVISION_CONFLICT'):
            self.reply = {'category': category, 'error': 'private server text must not escape'}
            result = self.call(action='checkpoint', label='Recovery test', base_revision=7)
            self.assertEqual(result['category'], category)
            self.assertEqual(result['operation_id'], self.calls[-1][2]['operation_id'])
            self.assertNotIn('private server text', json.dumps(result))
            self.assertEqual(result['outcome'], 'refused')
        records = list((Path(self.temp.name) / 'workspace-adapter-requests' / WORKSPACE).glob('*.json'))
        self.assertEqual(len(records), 5)
        for record in records:
            self.assertNotIn('capability', record.read_text())
            self.assertEqual(record.stat().st_mode & 0o777, 0o600)

    def test_default_deny_mutations(self):
        for action in ("apply", "checkpoint", "restore"):
            self.assertFalse(self.call(action=action)["ok"])
        self.assertFalse(self.calls)

    def test_describe_catalog_without_mutation_authority(self):
        self.assertTrue(self.call(action="describe", catalog=True, project_id=WORKSPACE)["ok"])
        self.assertEqual(self.calls[-1][2], {"action": "describe", "catalog": True, "project_id": WORKSPACE, "workspace_id": WORKSPACE})
        for fields in ({"catalog": "true"}, {"project_id": "invalid"}, {"actor": "owner"}, {"operations": []}):
            self.assertFalse(self.call(action="describe", **fields)["ok"])
        self.assertEqual(len(self.calls), 1)

    def test_workbench_setup_is_proposal_only_without_mutation_permission(self):
        self.assertIn("workbench_setup", plugin.SCHEMA["parameters"]["properties"]["action"]["enum"])
        self.assertIn("proposes a draft Workbench setup", plugin.SCHEMA["description"])
        self.assertFalse(self.ctx.settings.get("allow_mutations", False))
        proposal = {
            "op_id": "22222222-2222-2222-2222-222222222222",
            "goal": "Make the dashboard work on mobile",
            "title": "Mobile dashboard",
            "acceptance_statement": "Dashboard is usable at 380px",
            "project_id": "33333333-3333-3333-3333-333333333333",
            "check_definition_id": "node-test",
        }
        result = self.call(action="workbench_setup", request=proposal)
        self.assertTrue(result["ok"])
        self.assertEqual(self.calls[-1], ("/api/workspace/control", "Bearer test-only-capability",
                                          {"action": "workbench_setup", "workspace_id": WORKSPACE, "request": proposal}))
        self.assertNotIn("base_revision", self.calls[-1][2])

    def test_workbench_setup_rejects_owner_execution_and_scope_spoofing(self):
        base = {"op_id": "22222222-2222-2222-2222-222222222222", "goal": "bounded goal"}
        for forbidden in ({"action": "task_create"}, {"pane_id": WORKSPACE}, {"profile_id": "owner-profile"},
                          {"session_id": "owner-session"}, {"actor": "owner"}, {"operations": []},
                          {"credentials": "secret"}, {"root": "/etc"}, {"path": "/private"}, {"command": "rm -rf /"},
                          {"workspace_id": WORKSPACE}, {"preview_id": WORKSPACE}, {"surprise": True}):
            with self.subTest(forbidden=forbidden):
                self.assertFalse(self.call(action="workbench_setup", request={**base, **forbidden})["ok"])
        self.assertFalse(self.calls)

    def test_workbench_setup_rejects_malformed_and_oversized_proposals(self):
        op = "22222222-2222-2222-2222-222222222222"
        for bad in (None, "goal", {}, {"goal": "no op id"}, {"op_id": "not-a-uuid", "goal": "g"},
                    {"op_id": op, "goal": ""}, {"op_id": op, "goal": "   "},
                    {"op_id": op, "goal": "x" * (plugin.SETUP_GOAL_MAX + 1)},
                    {"op_id": op, "goal": "g", "check_definition_id": "arbitrary-shell"},
                    {"op_id": op, "goal": "g", "project_id": "not-a-uuid"},
                    {"op_id": op, "goal": "g", "title": ""},
                    {"op_id": op, "goal": "g", "acceptance_statement": "   "}):
            with self.subTest(bad=bad):
                self.assertFalse(self.call(action="workbench_setup", request=bad)["ok"])
        self.assertFalse(self.calls)

    def test_workbench_setup_rejects_top_level_scope_and_execution_fields(self):
        request = {"op_id": "22222222-2222-2222-2222-222222222222", "goal": "g"}
        for extra in ({"operations": []}, {"base_revision": 1}, {"pane_id": WORKSPACE}, {"actor": "owner"},
                      {"confirm": True}, {"checkpoint_id": WORKSPACE}):
            with self.subTest(extra=extra):
                self.assertFalse(self.call(action="workbench_setup", request=request, **extra)["ok"])
        self.assertFalse(self.calls)

    def test_arrangement_scope_and_mutation_gate(self):
        self.assertTrue(self.call(action="arrangement", request={"action": "recipe_list", "project_id": WORKSPACE})["ok"])
        self.assertFalse(self.call(action="arrangement", request={"action": "recipe_apply", "project_id": WORKSPACE})["ok"])
        self.ctx.settings["allow_mutations"] = True
        for forbidden in ("actor", "workspace_id"):
            self.assertFalse(self.call(action="arrangement", request={"action": "recipe_list", forbidden: WORKSPACE})["ok"])
        self.assertEqual(len(self.calls), 1)

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
