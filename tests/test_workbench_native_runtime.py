"""Real pinned Hermes + real plugin + deterministic local model protocol.

Download/setup (no paid model):
  git clone https://github.com/NousResearch/hermes-agent /tmp/opencode/orbit-hermes-native
  git -C /tmp/opencode/orbit-hermes-native checkout d0288be5b3330d2442e3907185b8e9d0958297bb
  (cd /tmp/opencode/orbit-hermes-native && uv sync --frozen --python 3.14 --no-default-groups)
  HERMES_NATIVE_SOURCE=/tmp/opencode/orbit-hermes-native python3 tests/test_workbench_native_runtime.py
After downloads, uv sync --offline --frozen --python 3.14 --no-default-groups
reuses the pinned source uv.lock and cached Python/dependencies.
"""
import hashlib
import hmac
import http.server
import json
import os
from pathlib import Path
import shutil
import socketserver
import subprocess
import tempfile
import threading
import unittest

PIN = "d0288be5b3330d2442e3907185b8e9d0958297bb"
SOURCE = Path(os.environ.get("HERMES_NATIVE_SOURCE", "/tmp/opencode/orbit-hermes-native"))
PLUGIN = Path(__file__).resolve().parents[1] / "hermes-plugin"


class RealRuntimeTest(unittest.TestCase):
    def test_two_attempts_real_plugin_protocol_and_no_host_tool_fallback(self):
        self.assertEqual(subprocess.check_output(["git", "-C", str(SOURCE), "rev-parse", "HEAD"], text=True).strip(), PIN)
        observations = []
        for attempt in ("attempt-one", "attempt-two"):
            with tempfile.TemporaryDirectory(prefix="hn-", dir="/tmp/opencode") as temp:
                root = Path(temp)
                home = root / "home"
                hermes = home / ".hermes"
                (hermes / "plugins").mkdir(parents=True)
                shutil.copytree(PLUGIN, hermes / "plugins" / "orbit-desktop", ignore=shutil.ignore_patterns("__pycache__"))
                (root / "empty").mkdir()
                channel = {"socket": str(root / "bridge.sock"), "secret": hashlib.sha256(attempt.encode()).hexdigest(), "grant_id": attempt}
                channel_file = root / "channel.json"
                channel_file.write_text(json.dumps(channel))
                channel_file.chmod(0o600)
                private_calls = []
                model_requests = []
                owner = self

                class Bridge(http.server.BaseHTTPRequestHandler):
                    def log_message(self, *args):
                        pass

                    def do_POST(self):
                        raw = self.rfile.read(int(self.headers["Content-Length"]))
                        seq = self.headers["X-Orbit-Sequence"]
                        mac = hmac.new(channel["secret"].encode(), seq.encode() + b"\n" + raw, hashlib.sha256).hexdigest()
                        owner.assertEqual(self.headers["X-Orbit-Mac"], mac)
                        owner.assertEqual(self.headers["X-Orbit-Grant"], attempt)
                        owner.assertEqual(seq, str(len(private_calls) + 1))
                        private_calls.append(json.loads(raw))
                        response = json.dumps({"ok": True, "result": {"scope_marker": attempt, "candidate": {"files": [{"path": "math.js"}]}}}).encode()
                        self.send_response(200)
                        self.send_header("Content-Length", str(len(response)))
                        self.end_headers()
                        self.wfile.write(response)

                class Model(http.server.BaseHTTPRequestHandler):
                    def log_message(self, *args):
                        pass

                    def do_POST(self):
                        body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
                        model_requests.append(body)
                        index = 1 + sum(1 for message in body.get("messages", []) if message.get("role") == "tool")
                        name = "orbit_workbench" if index == 1 else "terminal"
                        args = {"action": "inspect"} if index == 1 else {"command": "touch " + str(root / "HOST_TOOL_BYPASS")}
                        message = {"role": "assistant", "content": None, "tool_calls": [{"id": "call_" + str(index), "type": "function", "function": {"name": name, "arguments": json.dumps(args)}}]} if index < 3 else {"role": "assistant", "content": "Fixture complete"}
                        result = {"id": "fixture", "object": "chat.completion", "created": 1, "model": "orbit-local-fixture", "choices": [{"index": 0, "message": message, "finish_reason": "tool_calls" if index < 3 else "stop"}], "usage": {"prompt_tokens": 10, "completion_tokens": 10, "total_tokens": 20}}
                        if body.get("stream"):
                            delta = dict(message)
                            if "tool_calls" in delta:
                                delta["tool_calls"][0]["index"] = 0
                            chunk = {**result, "object": "chat.completion.chunk", "choices": [{"index": 0, "delta": delta, "finish_reason": None}]}
                            end = {**result, "object": "chat.completion.chunk", "choices": [{"index": 0, "delta": {}, "finish_reason": "tool_calls" if index < 3 else "stop"}]}
                            raw = ("data: " + json.dumps(chunk) + "\n\ndata: " + json.dumps(end) + "\n\ndata: [DONE]\n\n").encode()
                        else:
                            raw = json.dumps(result).encode()
                        self.send_response(200)
                        self.send_header("Content-Type", "text/event-stream" if body.get("stream") else "application/json")
                        self.send_header("Content-Length", str(len(raw)))
                        self.end_headers()
                        self.wfile.write(raw)

                bridge = socketserver.UnixStreamServer(channel["socket"], Bridge)
                model = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Model)
                for server in (bridge, model):
                    threading.Thread(target=server.serve_forever, daemon=True).start()
                endpoint = "http://127.0.0.1:%d/v1" % model.server_port
                (hermes / "config.yaml").write_text(json.dumps({"plugins": {"enabled": ["orbit-desktop"], "entries": {"orbit-desktop": {"enabled": True, "settings": {"native_channel_file": str(channel_file)}}}}, "tools": {"tool_search": {"enabled": "off"}}, "toolsets": ["orbit_workbench"], "compression": {"enabled": False}, "memory": {"enabled": False}}))
                config_file = root / "runner.json"
                config_file.write_text(json.dumps({"endpoint": endpoint, "api_key": "local-fixture", "model": "orbit-local-fixture", "max_iterations": 5, "session_id": attempt, "input": "Use the approved Workbench tool."}))
                # The shell only redirects this isolated fixture file to FD3;
                # no owner runtime/profile or ambient credential is executed.
                env = {"PATH": "/usr/bin:/bin", "HOME": str(home), "HERMES_HOME": str(hermes), "PYTHONPATH": str(SOURCE), "PYTHONNOUSERSITE": "1", "HERMES_BUNDLED_PLUGINS": str(root / "empty"), "HERMES_ENABLE_PROJECT_PLUGINS": "0", "HERMES_DISABLE_TELEMETRY": "1"}
                try:
                    result = subprocess.run(["/bin/bash", "-c", 'exec "$1" "$2" --runtime 3<"$3"', "fixture", str(SOURCE / ".venv/bin/python"), str(PLUGIN / "workbench.py"), str(config_file)], cwd=root, env=env, capture_output=True, text=True, timeout=90)
                    self.assertEqual(result.returncode, 0, result.stderr[-12000:] + result.stdout[-4000:])
                    self.assertEqual(private_calls, [{"action": "inspect"}], result.stderr[-6000:] + result.stdout[-6000:] + json.dumps(model_requests[-1].get("messages", []))[-6000:])
                    self.assertFalse((root / "HOST_TOOL_BYPASS").exists())
                    self.assertGreaterEqual(len(model_requests), 3)
                    for body in model_requests:
                        if "tools" in body:
                            self.assertEqual({t["function"]["name"] for t in body["tools"]}, {"orbit_workbench"})
                        self.assertNotIn(channel["secret"], json.dumps(body))
                    transcript = json.dumps(model_requests[-1]["messages"])
                    self.assertIn(attempt, transcript)
                    self.assertNotIn("attempt-two" if attempt == "attempt-one" else "attempt-one", transcript)
                    observations.append({"attempt": attempt, "model_requests": len(model_requests), "private_calls": len(private_calls), "host_tool_rejected": True})
                finally:
                    for server in (bridge, model):
                        server.shutdown()
                        server.server_close()
        print(json.dumps({"hermes_commit": PIN, "python": "3.14.3", "model": "deterministic loopback OpenAI protocol fixture", "observations": observations}, sort_keys=True))


if __name__ == "__main__":
    unittest.main()
