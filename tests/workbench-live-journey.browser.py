"""Disposable cross-mode real-server journey using a deterministic local Hermes model.

Real Node server + real SQLite + real linked git worktree + the pinned real Hermes
source/plugin (d0288be5) driven by a deterministic local OpenAI/SSE fixture. The
synthetic gateway only holds the owner's shared-chat binding for agent history and
is never posted to. Nothing here reads owner credentials or the owner runtime.

Run both renderers:
  PLAYWRIGHT_BROWSERS_PATH=/tmp/opencode/orbit-evolution-browsers \\
    /tmp/opencode/orbit-evolution-browser-venv/bin/python tests/workbench-live-journey.browser.py --renderer both
"""

import argparse
import ast
import json
import os
from pathlib import Path
import re
import secrets
import shutil
import socket
import sqlite3
import subprocess
import sys
import tempfile
import threading
import time
import traceback
import urllib.request
import uuid

from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from playwright.sync_api import expect, sync_playwright

# Import the shared synthetic gateway/helper without running its main().
sys.dont_write_bytecode = True
import importlib.util

spec = importlib.util.spec_from_file_location(
    "wb_context_browser", Path(__file__).with_name("workbench-context.browser.py"))
helper = importlib.util.module_from_spec(spec)
spec.loader.exec_module(helper)

ROOT = Path(__file__).resolve().parents[1]
# The meaningful regression lives in the arithmetic helper call: both variants
# import a locally packed dependency, so the module graph is real. Without the
# prepared offline environment the check would fail with a module error; with it
# the wrong-branch math produces a genuine assertion failure.
WRONG = "import { add } from 'fixture-add';\nexport const sum = (a,b) => add(a, -b);\n"
RIGHT = "import { add } from 'fixture-add';\nexport const sum = (a,b) => add(a, b);\n"
MATH_TEST = (
    "import test from 'node:test';\n"
    "import assert from 'node:assert/strict';\n"
    "import { sum } from './math.js';\n"
    "\n"
    "test('sum adds two numbers', () => {\n"
    "  assert.equal(sum(2, 3), 5);\n"
    "  assert.equal(sum(-1, 1), 0);\n"
    "  assert.equal(sum(0, 0), 0);\n"
    "});\n"
)
PACKAGE = '{"type":"module","name":"native-fixture","version":"1.0.0","dependencies":{"fixture-add":"file:helper.tgz"}}\n'
HELPER_PACKAGE = '{"name":"fixture-add","version":"1.0.0","type":"module","main":"index.js","exports":"./index.js"}\n'
HELPER_INDEX = "export function add(a, b) { return a + b; }\n"
QUESTION = "Why did the recorded sum check fail, and confirm the corrected candidate passes?"
GATEWAY_KEY = "fixture-synthetic-not-real"
HERMES_SOURCE = Path(os.environ.get("ORBIT_LIVE_JOURNEY_HERMES_SOURCE", "/tmp/opencode/orbit-hermes-native"))
HERMES_PIN = "d0288be5b3330d2442e3907185b8e9d0958297bb"
NATIVE_ROUTE = "/api/workbench/native"
WORKFLOW_ROUTE = "/api/workbench/workflow"
ENV_ROUTE = "/api/workbench/environments"
EXEC_ROUTE = "/api/workbench/execution"
CONTEXT_ROUTE = "/api/workbench/context"
WORKBENCH_ROUTE = "/api/workbench"
RECORD_ROUTES = (WORKBENCH_ROUTE, CONTEXT_ROUTE, EXEC_ROUTE, NATIVE_ROUTE, WORKFLOW_ROUTE, ENV_ROUTE)


class ModelHandler(BaseHTTPRequestHandler):
    """Deterministic sequential OpenAI chat-completions fixture (SSE + JSON)."""

    server_version = "DeterministicLocalModelFixture/1"

    def log_message(self, *args):
        pass

    def _send(self, body, status=200, content_type="application/json"):
        raw = body if isinstance(body, bytes) else json.dumps(body).encode()
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)

    def do_GET(self):
        self.server.gets.append(self.path)
        self._send({"object": "list", "data": []})

    def do_POST(self):
        raw = self.rfile.read(int(self.headers.get("Content-Length", 0)))
        try:
            body = json.loads(raw)
        except Exception:
            return self._send({}, 400)
        self.server.requests.append(body)
        if self.server.block_first and len(self.server.requests) == 1:
            self.server.request_entered.set()
            if not self.server.release_model.wait(180):
                self.server.errors.append("native model response gate timed out")
                return self._send({"error": "fixture gate timed out"}, 504)
        if not isinstance(body.get("messages"), list):
            return self._send({}, 404)
        results = []
        for message in body["messages"]:
            if message.get("role") == "tool":
                try:
                    results.append(json.loads(message["content"]))
                except Exception:
                    results.append({})
        self.server.result_snapshots.append(results)
        try:
            args = self.server.next_args(results)
        except Exception as error:  # never fabricate success
            self.server.errors.append("%s: %s" % (type(error).__name__, error))
            args = {"action": "inspect"}
        step = len(results)
        if step >= self.server.finish_step:
            message = {"role": "assistant", "content": "MODEL_ONLY_EXPLANATION: Fixture complete; recorder evidence is authoritative."}
        else:
            message = {"role": "assistant", "content": None, "tool_calls": [{
                "id": "call_%d" % step, "type": "function",
                "function": {"name": "orbit_workbench", "arguments": json.dumps(args)}}]}
        completion = {"id": "fixture", "object": "chat.completion", "created": 1,
                      "model": "orbit-local-fixture",
                      "choices": [{"index": 0, "message": message,
                                   "finish_reason": "tool_calls" if "tool_calls" in message else "stop"}],
                      "usage": {"prompt_tokens": 10, "completion_tokens": 10, "total_tokens": 20}}
        if body.get("stream"):
            delta = json.loads(json.dumps(message))
            if delta.get("tool_calls"):
                delta["tool_calls"][0]["index"] = 0
            chunks = [
                {"id": "fixture", "object": "chat.completion.chunk", "created": 1, "model": "orbit-local-fixture",
                 "choices": [{"index": 0, "delta": delta, "finish_reason": None}]},
                {"id": "fixture", "object": "chat.completion.chunk", "created": 1, "model": "orbit-local-fixture",
                 "choices": [{"index": 0, "delta": {}, "finish_reason": completion["choices"][0]["finish_reason"]}]},
            ]
            payload = "".join("data: " + json.dumps(chunk) + "\n\n" for chunk in chunks) + "data: [DONE]\n\n"
            return self._send(payload.encode(), content_type="text/event-stream")
        self._send(completion)


class ModelFixture(ThreadingHTTPServer):
    daemon_threads = True

    def __init__(self):
        super().__init__(("127.0.0.1", 0), ModelHandler)
        self.requests = []
        self.gets = []
        self.result_snapshots = []
        self.errors = []
        self.finish_step = 6
        self.request_entered = threading.Event()
        self.release_model = threading.Event()
        self.block_first = True

    def next_args(self, results):
        step = len(results)
        if step == 0:
            return {"action": "inspect"}
        if step == 1:
            return {"action": "read_context", "context_id": results[0]["result"]["contexts"][0]["id"]}
        if step == 2:
            return {"action": "candidate_read", "path": "math.js"}
        if step == 3:
            return {"action": "candidate_patch",
                    "expected_candidate_hash": results[0]["result"]["candidate"]["hash"],
                    "changes": [{"op": "change", "path": "math.js",
                                 "expected_hash": results[2]["result"]["file"]["hash"],
                                 "content": RIGHT}]}
        if step == 4:
            return {"action": "job_start"}
        if step == 5:
            return {"action": "evidence", "job_id": results[4]["result"]["job"]["id"]}
        return {"action": "inspect"}


class NormalGatewayHandler(BaseHTTPRequestHandler):
    server_version = "DeterministicNormalSSEFixture/1"
    def log_message(self, *args): pass
    def reply(self, body, status=200, content_type="application/json"):
        raw = body if isinstance(body, bytes) else json.dumps(body).encode()
        self.send_response(status); self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(raw))); self.end_headers(); self.wfile.write(raw)
    def do_GET(self):
        self.server.gets.append(self.path)
        if self.path == "/v1/capabilities":
            return self.reply({"version":"1","features":{"session_continuation":False,"idempotent_submit":False,"run_events_sse":True}})
        if self.path.startswith("/api/sessions/") and self.path.endswith("/messages"):
            return self.reply({"data":[]})
        if self.path == "/v1/runs/run_normal_live_fixture_0001":
            return self.reply({"run_id":"run_normal_live_fixture_0001","session_id":self.server.session_id,"status":"completed","output":"synthetic normal completion"})
        if self.path == "/v1/runs/run_normal_live_fixture_0001/events":
            events = [
                {"event":"tool.started","tool":"normal_fixture_read","tool_call_id":"normal-call-1","timestamp":1700000000,"arguments":"SECRET_ARGUMENT"},
                {"event":"tool.completed","tool":"normal_fixture_read","tool_call_id":"normal-call-2","timestamp":1700000001,"output":"SECRET_OUTPUT"},
            ]
            payload = "".join("event: %s" % event["event"] + chr(10) + "data: " + json.dumps(event) + chr(10) * 2 for event in events)
            return self.reply(payload.encode(), content_type="text/event-stream")
        return self.reply({"error":"unknown deterministic gateway route"},404)
    def do_POST(self):
        try: body=json.loads(self.rfile.read(int(self.headers.get("Content-Length",0))))
        except Exception: return self.reply({},400)
        if self.path == "/v1/runs":
            self.server.posts.append(body);self.server.session_id=body.get("session_id")
            return self.reply({"run_id":"run_normal_live_fixture_0001","status":"running"},202)
        return self.reply({"error":"unknown deterministic gateway route"},404)


class NormalGateway(ThreadingHTTPServer):
    daemon_threads=True
    def __init__(self):
        super().__init__(("127.0.0.1",0),NormalGatewayHandler);self.posts=[];self.gets=[];self.session_id=""


def main(renderer):
    helper.WORKSPACE = str(uuid.uuid4())
    helper.PANE = str(uuid.uuid4())
    log_path = Path(tempfile.gettempdir()) / ("orbit-live-journey-%s-%s.log" % (renderer, secrets.token_hex(8)))
    log_file = log_path.open("w")
    lines = []

    def log(message):
        lines.append(str(message))
        log_file.write(str(message) + "\n")
        log_file.flush()

    # No Playwright route interception/module overlays: a real server only.
    tree = ast.parse(Path(__file__).read_text(), feature_version=(3, 11))
    assert not any(isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute)
                   and node.func.attr in ("route", "route_from_har") for node in ast.walk(tree))
    assert HERMES_SOURCE.is_dir(), "Pinned Hermes source missing"
    # The fixture is bounded to the pinned /tmp source; never the owner's home.
    assert str(HERMES_SOURCE).startswith("/tmp/opencode/"), HERMES_SOURCE
    assert not str(HERMES_SOURCE).startswith("/home/"), HERMES_SOURCE
    head = subprocess.check_output(["git", "-C", str(HERMES_SOURCE), "rev-parse", "HEAD"], text=True).strip()
    assert head == HERMES_PIN, head
    node_version = subprocess.check_output([shutil.which("node"), "--version"], text=True).strip()
    assert node_version.startswith("v22"), node_version
    token = secrets.token_urlsafe(36)

    def safe(value):
        return str(value).replace(token, "[REDACTED]").replace(GATEWAY_KEY, "[SYNTHETIC_KEY]")

    with tempfile.TemporaryDirectory(prefix="orbit-native-browser-", dir="/tmp/opencode") as temp:
        root = Path(temp)
        # NEVER build or modify the checkout: only this disposable copy.
        assert root != ROOT and not str(root).startswith(str(ROOT) + os.sep)
        for name in ("server", "src", "contracts", "docs", "public", "hermes-plugin", "scripts"):
            shutil.copytree(ROOT / name, root / name)
        for name in ("index.html", "package.json", "tsconfig.json", "vite.config.js"):
            shutil.copy2(ROOT / name, root / name)
        (root / "node_modules").symlink_to(ROOT / "node_modules", target_is_directory=True)
        for name in ("runtime", "home", "cwd", "tmux"):
            (root / name).mkdir()
        env = {"HOME": str(root / "home"), "PATH": os.environ["PATH"], "npm_config_cache": str(root / ".npm")}
        log("build: disposable copy at %s (checkout %s untouched)" % (root, ROOT))
        helper.run(shutil.which("node"), str(ROOT / "scripts/isolated_build.mjs"), "--source", str(root), "--dest", str(root / "dist"), "--allow-source-dist", cwd=root, env=env)
        assert (root / "dist/index.html").is_file()

        # Real linked Git worktree: main repository owns common objects, the
        # registered root is the worktree with its per-worktree .git pointer.
        # A local packed dependency, built with a sanitized private HOME and no
        # owner npm config, then copied into the project as helper.tgz. The lock is
        # generated offline with `--package-lock-only` (no installed node_modules
        # in the source or candidate).
        def npm_private(home):
            return {"HOME": str(home), "PATH": os.environ["PATH"],
                    "npm_config_cache": str(home / ".npm-cache"),
                    "npm_config_userconfig": str(home / ".npmrc"),
                    "npm_config_globalconfig": str(home / "global.npmrc"),
                    "npm_config_fund": "false", "npm_config_audit": "false",
                    "npm_config_offline": "true", "npm_config_ignore_scripts": "true",
                    "npm_config_registry": "http://127.0.0.1:9/"}

        staging = root / "fixture-build"
        helper_pkg = staging / "fixture-add"
        helper_pkg.mkdir(parents=True)
        (helper_pkg / "package.json").write_text(HELPER_PACKAGE)
        (helper_pkg / "index.js").write_text(HELPER_INDEX)
        pack_home = helper_pkg / ".home"
        pack_home.mkdir()
        helper.run(shutil.which("npm"), "pack", "--ignore-scripts", "--offline",
                   "--pack-destination", str(staging), cwd=helper_pkg, env=npm_private(pack_home))
        packed_tgz = staging / "fixture-add-1.0.0.tgz"
        assert packed_tgz.is_file(), sorted(name.name for name in staging.iterdir())
        packed = packed_tgz.read_bytes()
        lockgen = staging / "lockgen"
        lockgen.mkdir()
        (lockgen / "package.json").write_text(PACKAGE)
        (lockgen / "helper.tgz").write_bytes(packed)
        lock_home = lockgen / ".home"
        lock_home.mkdir()
        helper.run(shutil.which("npm"), "install", "--package-lock-only", "--ignore-scripts", "--offline",
                   "--no-audit", "--no-fund", cwd=lockgen, env=npm_private(lock_home))
        lock_text = (lockgen / "package-lock.json").read_text()
        lock = json.loads(lock_text)
        assert lock["lockfileVersion"] == 3, lock
        assert lock["packages"]["node_modules/fixture-add"]["resolved"] == "file:helper.tgz", lock
        assert lock["packages"]["node_modules/fixture-add"]["integrity"].startswith("sha512-"), lock
        assert not (lockgen / "node_modules").exists(), "package-lock-only must not install node_modules"

        git_env = {**env, "GIT_CONFIG_NOSYSTEM": "1", "GIT_CONFIG_GLOBAL": "/dev/null"}
        main_repo = root / "main-repo"
        project = root / "project"
        main_repo.mkdir()
        helper.run("git", "init", cwd=main_repo, env=git_env)
        (main_repo / "math.js").write_text(WRONG)
        (main_repo / "math.test.js").write_text(MATH_TEST)
        (main_repo / "package.json").write_text(PACKAGE)
        (main_repo / "helper.tgz").write_bytes(packed)
        (main_repo / "package-lock.json").write_text(lock_text)
        helper.run("git", "add", "math.js", "math.test.js", "package.json", "helper.tgz", "package-lock.json",
                   cwd=main_repo, env=git_env)
        helper.run("git", "-c", "user.email=fixture@example.invalid", "-c", "user.name=Fixture",
                   "commit", "-m", "initial", cwd=main_repo, env=git_env)
        helper.run("git", "worktree", "add", "-b", "native-fixture", str(project), cwd=main_repo, env=git_env)
        git_directory = subprocess.check_output(
            ["git", "-C", str(project), "rev-parse", "--absolute-git-dir"], text=True).strip()
        common_directory = subprocess.check_output(
            ["git", "-C", str(project), "rev-parse", "--git-common-dir"], text=True).strip()
        if not os.path.isabs(common_directory):
            common_directory = os.path.abspath(os.path.join(project, common_directory))
        assert os.path.dirname(git_directory) == os.path.join(common_directory, "worktrees"), git_directory
        assert (project / ".git").is_file()

        model = ModelFixture()
        model_thread = threading.Thread(target=model.serve_forever, daemon=True)
        model_thread.start()
        model_url = "http://127.0.0.1:%d/v1" % model.server_port
        gateway = NormalGateway()
        gateway_thread = threading.Thread(target=gateway.serve_forever, daemon=True)
        gateway_thread.start()

        with socket.socket() as probe:
            probe.bind(("127.0.0.1", 0))
            port = probe.getsockname()[1]
        origin = "http://127.0.0.1:%d" % port
        session = "orbit-" + str(uuid.uuid4())
        server = None
        try:
            server_env = {**env, "PORT": str(port), "ORBIT_TOKEN": token,
                          "ORBIT_RUNTIME_DIR": str(root / "runtime"), "ORBIT_CWD": str(root / "cwd"),
                          "ORBIT_TMUX_SOCKET": "native-" + str(uuid.uuid4()), "ORBIT_TMUX_CONFIG": "/dev/null",
                          "TMUX_TMPDIR": str(root / "tmux"),
                          "HERMES_API_URL": "http://127.0.0.1:%d" % gateway.server_port, "HERMES_API_KEY": GATEWAY_KEY,
                          "ORBIT_NATIVE_HERMES_SOURCE": str(HERMES_SOURCE),
                          "ORBIT_NATIVE_HERMES_PYTHON": str(HERMES_SOURCE / ".venv/bin/python"),
                          "ORBIT_NATIVE_HERMES_MODEL_URL": model_url,
                          "ORBIT_NATIVE_HERMES_PROFILE": "default",
                          "ORBIT_NATIVE_HERMES_MODEL": "orbit-local-fixture"}
            monitor = str(uuid.uuid4())
            state = {"version": 1, "selected": monitor, "arc": 14, "view": "windows", "monitors": [{
                "id": monitor, "name": "Native fixture agent", "diagonal": 32, "aspect": "16:9",
                "height": 0, "distance": 0, "pitch": 0, "yaw": 0, "offset": 0, "fontSize": 19,
                "frame": {"x": 0, "y": 0, "width": 900, "height": 900, "z": 0},
                "layout": {"type": "pane", "pane": {"id": helper.PANE, "kind": "agent", "url": ""}}}]}
            with (root / "server.log").open("w+") as server_log:
                server = subprocess.Popen([shutil.which("node"), "--experimental-strip-types", "server/index.mjs"],
                                          cwd=root, env=server_env, stdout=server_log, stderr=server_log)
                for _ in range(400):
                    if server.poll() is not None:
                        server_log.seek(0)
                        raise RuntimeError(safe(server_log.read()))
                    try:
                        with urllib.request.urlopen(origin + "/api/health", timeout=1):
                            break
                    except OSError:
                        time.sleep(.05)
                else:
                    raise RuntimeError("Disposable server readiness timeout")

                with sync_playwright() as playwright:
                    browser = playwright.chromium.launch(headless=True)
                    context = browser.new_context(viewport={"width": 1800, "height": 1200})
                    chat = {"session": session, "profile_id": "default", "messages": []}
                    context.add_init_script(
                        "if(window===window.top){localStorage.setItem('orbit.workspace.id'," + json.dumps(helper.WORKSPACE) +
                        ");localStorage.setItem('orbit.workspace.v1',JSON.stringify(" + json.dumps(state) + "));" +
                        "sessionStorage.setItem('orbit-hermes-chat:" + helper.PANE + "',JSON.stringify(" + json.dumps(chat) + "));}")
                    page = context.new_page()
                    page_errors, terminals, responses, external = [], [], [], []
                    step = "connect"
                    page.on("pageerror", lambda error: page_errors.append(str(error)))

                    def request_seen(request):
                        if "/api/terminal" in request.url:
                            terminals.append(request.url)
                        url = request.url.split("?")[0]
                        if url.startswith(("http://", "https://")) and not url.startswith(origin + "/") \
                                and not url.startswith(("http://127.0.0.1:", origin)):
                            external.append(request.url)

                    page.on("request", request_seen)
                    page.on("websocket", lambda ws: terminals.append(ws.url) if "/api/terminal" in ws.url else None)

                    def post_json(request):
                        try:
                            return request.post_data_json or {}
                        except Exception:
                            return {}

                    def record(response):
                        path = response.url.split("?")[0]
                        if path in [origin + route for route in RECORD_ROUTES]:
                            # Store the Response reference only: no deserialization inside
                            # the event callback (nested Playwright sync reentrance).
                            responses.append((response.request, response.status, response))

                    page.on("response", record)
                    live_requests = []
                    def observe_live_request(request):
                        if request.url.split("?")[0] == origin + "/api/workbench/live":
                            try: live_requests.append(request.post_data_json or {})
                            except Exception: pass
                    page.on("request", observe_live_request)
                    live_requests = []
                    def observe_live_request(request):
                        if request.url.split("?")[0] == origin + "/api/workbench/live":
                            try: live_requests.append(request.post_data_json or {})
                            except Exception: pass
                    page.on("request", observe_live_request)

                    def result(action, route=EXEC_ROUTE):
                        matches = [(request, status, response) for request, status, response in responses
                                   if request.url.split("?")[0] == origin + route and post_json(request).get("action") == action]
                        assert matches, ("Missing %s response on %s" % (action, route))
                        _, status, response = matches[-1]
                        try:
                            body = response.json()
                        except Exception:
                            body = {}
                        assert status == 200 and body.get("ok") is True, (action, status, body)
                        return body

                    def last(action, route=EXEC_ROUTE):
                        matches = [response for request, status, response in responses
                                   if request.url.split("?")[0] == origin + route and post_json(request).get("action") == action]
                        if not matches:
                            return None
                        try:
                            return matches[-1].json()
                        except Exception:
                            return None

                    def click_text(scope, label, action, route=EXEC_ROUTE, timeout=30000):
                        with page.expect_response(lambda response: response.url.split("?")[0] == origin + route
                                                  and post_json(response.request).get("action") == action, timeout=timeout):
                            scope.locator("button").filter(has_text=re.compile("^" + re.escape(label) + "$")).first.click(timeout=timeout)
                        return result(action, route)

                    def click_accessible(scope, name, action, route=EXEC_ROUTE, timeout=30000):
                        with page.expect_response(lambda response: response.url.split("?")[0] == origin + route
                                                  and post_json(response.request).get("action") == action, timeout=timeout):
                            scope.get_by_role("button", name=name, exact=True).first.click(timeout=timeout)
                        return result(action, route)

                    def api(route, action, **fields):
                        status, body = helper.api(origin, token, route, {"action": action, **fields})
                        return status, body

                    def refresh_execution(pane):
                        # Execution-only refresh; review/evidence projection.
                        target = pane.locator("button").filter(has_text=re.compile("^Refresh execution workbench$"))
                        with page.expect_response(lambda response: response.url.split("?")[0] == origin + EXEC_ROUTE
                                                  and post_json(response.request).get("action") == "execution_state",
                                                  timeout=30000):
                            target.first.click()

                    def refresh_workbench(dialog, pane):
                        # "Refresh project inspection" re-runs inspect() and then
                        # execution/authority/workflow refresh(); used when the
                        # workflow's approved-review list must be rebuilt. Wait for the
                        # actual UI option, not an API response ordering (the final
                        # refresh uses Promise.all and is concurrent).
                        target = dialog.locator("button").filter(has_text=re.compile("^Refresh project inspection$"))
                        target.first.click()
                        expect(pane.get_by_label("Approved candidate and review").locator("option")).not_to_have_count(0, timeout=45000)

                    def click_plain(scope, label):
                        # helper buttons carry a descriptive aria-label/title while
                        # their visible text stays short, so click by visible text.
                        scope.locator("button").filter(has_text=re.compile("^" + re.escape(label) + "$")).first.click()

                    def refresh_authority(scope):
                        # The authority act() is busy-guarded: while "Loading task authority"
                        # runs it populates the selects before finishing, so a later act()
                        # would silently return early. Wait for completion before selecting.
                        click_plain(scope, "Refresh task authority")
                        expect(scope).to_contain_text("Loading task authority: complete.", timeout=30000)

                    def click_pair(scope, label, first_action, second_action, route, timeout=30000):
                        captured = {}

                        def predicate(response):
                            if response.url.split("?")[0] != origin + route:
                                return False
                            action = post_json(response.request).get("action")
                            if action == first_action:
                                captured["first"] = response
                                return False
                            return action == second_action and "first" in captured

                        with page.expect_response(predicate, timeout=timeout) as second:
                            scope.locator("button").filter(has_text=re.compile("^" + re.escape(label) + "$")).first.click(timeout=timeout)
                        return captured["first"], second.value

                    try:
                        page.goto(origin + ("?renderer=docking" if renderer == "docking" else ""),
                                  wait_until="domcontentloaded")
                        expect(page.locator("dialog.orbit-onboarding")).to_be_visible()
                        page.keyboard.press("Escape")
                        expect(page.locator("dialog.orbit-onboarding")).not_to_be_visible()
                        page.get_by_role("button", name="Connect local host", exact=True).click()
                        page.get_by_role("textbox", name="Host session token").fill(token)
                        with page.expect_response(lambda response: response.url == origin + "/api/agent"
                                                  and post_json(response.request).get("action") == "shared_chat") as binding:
                            page.get_by_role("button", name="Unlock local host", exact=True).click()
                        expect(page.locator(".saved")).to_contain_text("Workspace connected", timeout=15000)
                        bound = binding.value.json()
                        assert binding.value.status == 200 and bound["state"]["session"] == session, bound

                        step = "normal Hermes SSE feeds Normal-only safe timeline metadata"
                        normal_pane = page.locator('[data-pane-id="%s"]' % helper.PANE)
                        normal_timeline = normal_pane.locator(".agent-chat-normal .agent-live-timeline")
                        expect(normal_timeline).to_be_visible(timeout=15000)
                        normal_input = normal_pane.get_by_label("Message to Hermes", exact=True)
                        normal_input.fill("deterministic normal SSE fixture request")
                        with page.expect_response(lambda response: response.url == origin + "/api/agent"
                                                  and post_json(response.request).get("action") == "start") as normal_start:
                            normal_pane.get_by_role("button", name="Send message to Hermes", exact=True).click()
                        assert normal_start.value.status == 202, normal_start.value.status
                        expect(normal_timeline).to_contain_text("normal_fixture_read", timeout=30000)
                        assert "SECRET_ARGUMENT" not in normal_timeline.inner_text() and "SECRET_OUTPUT" not in normal_timeline.inner_text()
                        expect(normal_pane.locator(".agent-status")).to_contain_text("COMPLETED", timeout=15000)
                        normal_summary = normal_timeline.inner_text()
                        assert "OBSERVED" in normal_summary and "running" in normal_summary and "completed" in normal_summary, normal_summary
                        assert len(gateway.posts) == 1, gateway.posts
                        assert any("/v1/runs/run_normal_live_fixture_0001/events" in path for path in gateway.gets), gateway.gets

                        step = "register linked worktree"
                        page.get_by_role("button", name="Open orbit menu").click()
                        page.get_by_role("button", name="Project Workbench", exact=True).click()
                        workbench = page.locator("dialog.project-workbench-dialog")
                        workbench.get_by_label("Project root directory").fill(str(project))
                        workbench.get_by_label("Project name").fill("native-fixture")
                        workbench.get_by_label("Linked worktree Git directory").fill(git_directory)
                        workbench.get_by_label("Linked worktree common directory").fill(common_directory)
                        workbench.get_by_role("button", name="Preview project registration").click()
                        expect(workbench.get_by_role("button", name="Confirm project registration")).to_be_enabled()
                        preview = result("register_preview", WORKBENCH_ROUTE)
                        assert preview["git_mapping"]["git_directory"] == git_directory, preview["git_mapping"]
                        assert preview["git_mapping"]["common_directory"] == common_directory, preview["git_mapping"]
                        workbench.get_by_role("button", name="Confirm project registration").click()
                        expect(workbench.get_by_role("button", name="Open project native-fixture")).to_be_visible()
                        project_id = result("register_commit", WORKBENCH_ROUTE)["project"]["id"]
                        workbench.get_by_role("button", name="Open project native-fixture").click()
                        pane = workbench.locator(".workbench-execution")
                        expect(pane.get_by_role("heading", name="Execution workbench")).to_be_visible(timeout=15000)
                        expect(pane.locator(".workbench-execution-status")).to_contain_text("Execution:")

                        step = "link actual agent primary role"
                        panes = workbench.get_by_label("Link pane")
                        expect(panes.locator("option")).not_to_have_count(0)
                        panes.select_option(value=helper.PANE)
                        click_text(workbench, "Link selected pane metadata only", "link_pane", WORKBENCH_ROUTE)
                        expect(workbench.locator(".workbench-bindings")).to_contain_text("primary_agent")

                        step = "owner task/candidate with dependency-bearing project"
                        pane.get_by_role("textbox", name="Task title").fill("Repair sum with recorded evidence")
                        pane.get_by_role("textbox", name="Acceptance statement").fill("sum(2,3)===5")
                        pane.get_by_role("combobox", name="Task check definition").select_option("node-test")
                        pane.get_by_role("textbox", name="Recipient profile ID").fill("default")
                        pane.get_by_role("textbox", name="Recipient session ID").fill(session)
                        task = click_text(pane, "Create task", "task_create")["task"]
                        preview = click_text(pane, "Preview candidate", "candidate_preview")
                        base_files = [file["path"] for file in preview["preview"]["base"]["files"]]
                        assert "math.js" in base_files and "math.test.js" in base_files, base_files
                        assert "helper.tgz" in base_files and "package-lock.json" in base_files, base_files
                        candidate = click_text(pane, "Create candidate", "candidate_create")["candidate"]
                        click_accessible(pane, "Read candidate file math.js", "candidate_read")
                        edit = pane.get_by_role("textbox", name="Candidate file edit")
                        expect(edit).to_have_value(WRONG)

                        step = "prepare offline Node environment via UI"
                        refresh_authority(pane)
                        expect(pane.get_by_label("Authority candidate").locator("option")).not_to_have_count(0)
                        pane.get_by_label("Authority candidate").select_option(value=candidate["id"])
                        environment_preview = click_text(pane, "Preview offline Node environment", "profile_preview", ENV_ROUTE)
                        required_inputs = sorted(environment_preview["required_inputs"])
                        assert required_inputs == ["helper.tgz", "package-lock.json", "package.json"], required_inputs
                        assert environment_preview["network_policy"] == "offline_only", environment_preview
                        assert environment_preview["lifecycle_policy"] == "ignore_scripts", environment_preview
                        environment = click_text(pane, "Approve offline Node environment", "profile_approve", ENV_ROUTE)
                        environment_profile = environment["id"]
                        prepared = click_text(pane, "Prepare locked dependencies", "environment_prepare", ENV_ROUTE)
                        assert prepared["status"] == "ready", prepared
                        dependency_hash = prepared["prepared"]["dependency_hash"]
                        assert prepared["prepared"]["network_policy"] == "offline_only", prepared["prepared"]
                        assert not (project / "node_modules").exists(), "source project must stay dependency-free"

                        step = "pin required checks to the frozen environment profile via UI"
                        acceptance_preview = click_text(pane, "Preview required checks", "task_acceptance_preview")
                        acceptance = acceptance_preview["preview"]["acceptance"]
                        assert [check["definition_id"] for check in acceptance["required_checks"]] == ["node-test"], acceptance
                        assert acceptance["required_checks"][0]["execution_profile_id"] == environment_profile, acceptance
                        click_text(pane, "Approve required checks", "task_acceptance_approve")

                        step = "failing node-test against prepared deps is a real assertion, not a missing module"
                        pane.get_by_role("combobox", name="Check definition", exact=True).select_option("node-test")
                        check_preview = click_text(pane, "Preview check", "check_preview")["preview"]
                        assert check_preview["execution_profile_id"] == environment_profile, check_preview
                        assert check_preview["required_check"]["execution_profile"]["dependency_hash"] == dependency_hash, check_preview
                        failed_run = click_text(pane, "Run check", "check_run")
                        failed = failed_run["evidence"]
                        assert failed["verdict"] == "fail" and failed["exit_code"] != 0, failed
                        assert failed["definition_id"] == "node-test", failed
                        assert failed["execution_profile_id"] == environment_profile, failed
                        assert failed["environment"]["dependency_hash"] == dependency_hash, failed["environment"]
                        assert failed["environment"]["execution_view_identity"] and failed["environment"]["execution_view_id"], failed["environment"]
                        observation = failed["execution_observation"]
                        assert observation["dependency_before"] == observation["dependency_after"] == dependency_hash, observation
                        assert observation["verified_view"] is True, observation
                        assert observation["source_before"] == observation["source_after"] == candidate["hash"], observation
                        assert observation["view_source_before"] == observation["view_source_after"] == candidate["hash"], observation
                        assert failed["test_results"]["valid"] is True, failed
                        assert failed["test_results"]["tests"] >= 1 and failed["test_results"]["failed"] >= 1, failed
                        assert failed["test_results"]["success"] is False, failed
                        assert "-1 !== 5" in failed["stderr_preview"], failed["stderr_preview"]
                        assert "Cannot find package" not in failed["stderr_preview"], failed["stderr_preview"]
                        assert "ERR_MODULE_NOT_FOUND" not in failed["stderr_preview"], failed["stderr_preview"]
                        expect(pane.locator(".workbench-execution-jobs")).to_contain_text(failed["id"])

                        step = "task authority bound attempt via UI"
                        refresh_authority(pane)
                        expect(pane.get_by_label("Authority candidate").locator("option")).not_to_have_count(0)
                        pane.get_by_label("Authority candidate").select_option(value=candidate["id"])
                        expect(pane.get_by_label("Native agent recipient").locator("option")).not_to_have_count(0)
                        pane.get_by_label("Native agent recipient").select_option(index=0)
                        attempt = click_text(pane, "Create bound attempt", "attempt_create")["attempt"]
                        assert attempt["recipient"]["session_id"] == session, attempt

                        step = "capture failed job + file packet (no share)"
                        job_view = pane.locator(".workbench-execution-job").filter(has_text=failed["job_id"]).first
                        job_view.locator("button").filter(has_text=re.compile("^Ask agent about this job$")).first.click()
                        dialog = page.locator("dialog.workbench-context-dialog")
                        expect(dialog).to_be_visible()
                        expect(dialog.get_by_label("Agent recipient", exact=True).locator("option")).not_to_have_count(0)
                        dialog.get_by_label("Agent recipient", exact=True).select_option(index=0)
                        dialog.get_by_label("Task/attempt link").select_option(value=attempt["id"])
                        click_text(dialog, "Capture context", "capture", CONTEXT_ROUTE)
                        expect(dialog.locator(".workbench-context-status")).to_contain_text("metadata captured")
                        click_text(dialog, "Choose more sources", "inspect", WORKBENCH_ROUTE)
                        sources = dialog.get_by_label("Additional context source")
                        expect(sources.locator("option")).not_to_have_count(0)
                        sources.select_option(label="math.js")
                        dialog.get_by_label("Additional source from line").fill("1")
                        dialog.get_by_label("Additional source through line").fill("2")
                        click_text(dialog, "Add snapshot", "capture", CONTEXT_ROUTE)
                        dialog.get_by_label("Task or question").fill(QUESTION)
                        packet_response, preview_response = click_pair(
                            dialog, "Preview for selected recipient", "packet", "preview", CONTEXT_ROUTE)
                        assert packet_response.status == 200 and packet_response.json()["ok"] is True, packet_response.json()
                        assert preview_response.status == 200 and preview_response.json()["ok"] is True, preview_response.json()
                        modal_packet_id = packet_response.json()["context"]["id"]
                        preview = preview_response.json()
                        text = dialog.get_by_role("textbox", name="Exact context preview text (read-only)")
                        expect(text).to_have_value(preview["text"])
                        reviewed = text.input_value()
                        assert text.get_attribute("readonly") is not None
                        assert QUESTION in reviewed, reviewed
                        assert "add(a, -b)" in reviewed, reviewed
                        assert "import { add } from 'fixture-add'" in reviewed, reviewed
                        assert "verdict=fail" in reviewed, reviewed
                        assert '"kind":"job"' in reviewed and '"kind":"file"' in reviewed, reviewed
                        assert preview["context_id"] == modal_packet_id, (preview["context_id"], modal_packet_id)
                        assert preview["recipient"]["session_id"] == session
                        dialog.get_by_text("Close", exact=True).click()
                        expect(dialog).not_to_be_visible()
                        # No context was approved/shared: native read_context uses the
                        # server-retained packet, not a one-shot disclosure.
                        assert last("approve", CONTEXT_ROUTE) is None and last("share", CONTEXT_ROUTE) is None

                        step = "capture a selected Normal conversation excerpt into a bound pane packet"
                        if workbench.is_visible():
                            workbench.get_by_role("button", name="Close project workbench", exact=True).click()
                            expect(workbench).not_to_be_visible()
                        agent_pane = page.locator('[data-pane-id="%s"]' % helper.PANE)
                        normal_mode = agent_pane.get_by_role("button", name="Normal Hermes mode", exact=True)
                        workbench_mode = agent_pane.get_by_role("button", name="Workbench Hermes mode", exact=True)
                        normal_draft = agent_pane.get_by_label("Message to Hermes", exact=True)
                        workbench_mode.click()
                        expect(workbench_mode).to_have_attribute("aria-pressed", "true")
                        wb_project = agent_pane.get_by_label("Workbench project", exact=True)
                        expect(wb_project.locator('option[value="%s"]' % project_id)).to_have_count(1, timeout=30000)
                        wb_project.select_option(value=project_id)
                        wb_task = agent_pane.get_by_label("Workbench task", exact=True)
                        expect(wb_task.locator('option[value="%s"]' % task["id"])).to_have_count(1, timeout=30000)
                        wb_task.select_option(value=task["id"])
                        wb_candidate = agent_pane.get_by_label("Workbench candidate", exact=True)
                        expect(wb_candidate.locator('option[value="%s"]' % candidate["id"])).to_have_count(1, timeout=30000)
                        wb_candidate.select_option(value=candidate["id"])
                        wb_attempt = agent_pane.get_by_label("Workbench attempt", exact=True)
                        expect(wb_attempt.locator('option[value="%s"]' % attempt["id"])).to_have_count(1, timeout=30000)
                        wb_attempt.select_option(value=attempt["id"])
                        setup_details = agent_pane.locator(".pane-workbench-setup")
                        if not setup_details.get_attribute("open"):
                            setup_details.locator(":scope > summary").click()
                        handoff = agent_pane.locator(".pane-workbench-handoff")
                        if not handoff.get_attribute("open"):
                            handoff.locator(":scope > summary").click()
                        excerpt_check = handoff.get_by_label("Include user excerpt", exact=True).first
                        expect(excerpt_check).to_be_visible(timeout=15000)
                        excerpt_check.check()
                        handoff.get_by_label("Task or question excerpt", exact=True).fill(QUESTION)
                        handoff.locator("button").filter(has_text=re.compile("^Preview context packet$")).click()
                        excerpt_preview = handoff.locator(".pane-workbench-excerpt-preview")
                        expect(excerpt_preview).to_contain_text('"attempt_id"')
                        expect(excerpt_preview).to_contain_text(attempt["id"])
                        expect(excerpt_preview).to_contain_text("deterministic normal SSE fixture request")
                        capture_packet_button = handoff.locator("button").filter(
                            has_text=re.compile("^Capture selected context packet$"))
                        expect(capture_packet_button).to_be_enabled()
                        capture_response, packet_response = click_pair(
                            handoff, "Capture selected context packet", "capture", "packet", CONTEXT_ROUTE)
                        assert capture_response.status == 200 and capture_response.json().get("ok") is True, capture_response.json()
                        assert packet_response.status == 200 and packet_response.json().get("ok") is True, packet_response.json()
                        assert post_json(capture_response.request).get("attempt_id") == attempt["id"], post_json(capture_response.request)
                        assert post_json(packet_response.request).get("attempt_id") == attempt["id"], post_json(packet_response.request)
                        conversation_context = capture_response.json()["context"]
                        packet_context = packet_response.json()["context"]
                        packet_id = packet_context["id"]
                        assert conversation_context["attempt_id"] == attempt["id"], conversation_context
                        assert packet_context["attempt_id"] == attempt["id"], packet_context
                        assert packet_context["source"]["kind"] == "packet", packet_context
                        packet_snapshot_hash = packet_context["snapshot"]["hash"]
                        expect(agent_pane.locator(".pane-workbench-status")).to_contain_text(
                            "bound to attempt %s" % attempt["id"], timeout=30000)

                        step = "preview and approve native consent through pane authority using that packet"
                        pane_authority = agent_pane.locator(".pane-workbench-authority")
                        if not pane_authority.get_attribute("open"):
                            pane_authority.locator(":scope > summary").click()
                        refresh_authority(pane_authority)
                        pane_authority.get_by_label("Authority candidate", exact=True).select_option(value=candidate["id"])
                        pane_authority.get_by_label("Native task attempt", exact=True).select_option(value=attempt["id"])
                        pane_recipient = pane_authority.get_by_label("Native agent recipient", exact=True)
                        recipient_options = pane_recipient.locator("option").evaluate_all(
                            "options => options.map(option => ({value: option.value, label: option.textContent}))")
                        recipient_value = next((option["value"] for option in recipient_options
                                                if option["value"] and
                                                json.loads(option["value"]).get("session_id") == session), None)
                        assert recipient_value, (session, recipient_options)
                        pane_recipient.select_option(value=recipient_value)
                        approved_packet = pane_authority.get_by_label("Native approved context packet", exact=True)
                        expect(approved_packet.locator('option[value="%s"]' % packet_id)).to_have_count(1, timeout=30000)
                        approved_packet.select_option(value=packet_id)
                        readiness_code, readiness = helper.api(origin, token, EXEC_ROUTE, {
                            "action": "candidate_get", "workspace_id": helper.WORKSPACE,
                            "project_id": project_id, "candidate_id": candidate["id"]})
                        assert readiness_code == 200 and readiness.get("ok") is True, readiness
                        actual_readiness = readiness.get("readiness", {})
                        assert actual_readiness.get("ready") is True, {
                            "candidate_id": candidate["id"], "candidate_generation": candidate.get("generation"),
                            "readiness": actual_readiness,
                            "task_acceptance": readiness.get("task", {}).get("acceptance"),
                            "profile_id": environment_profile,
                        }
                        consent = click_text(pane_authority, "Preview native task consent", "preview", NATIVE_ROUTE)
                        native_preview_response = next(response for request, _, response in reversed(responses)
                            if request.url.split("?")[0] == origin + NATIVE_ROUTE
                            and post_json(request).get("action") == "preview")
                        assert native_preview_response.status == 200, native_preview_response.json()
                        assert consent["preview"]["attempt_id"] == attempt["id"], consent
                        assert [item["id"] for item in consent["preview"]["contexts"]] == [packet_id], consent
                        native_preview_request = next(post_json(request) for request, _, _ in reversed(responses)
                            if request.url.split("?")[0] == origin + NATIVE_ROUTE and post_json(request).get("action") == "preview")
                        assert native_preview_request.get("attempt_id") == attempt["id"]
                        assert native_preview_request.get("context_ids") == [packet_id], native_preview_request
                        assert consent["preview"]["budget"] == {"calls": 20, "checks": 3, "duration_ms": 180000}
                        approve = click_text(pane_authority, "Approve native task consent", "approve", NATIVE_ROUTE)
                        native_approve_response = next(response for request, _, response in reversed(responses)
                            if request.url.split("?")[0] == origin + NATIVE_ROUTE
                            and post_json(request).get("action") == "approve")
                        assert native_approve_response.status == 200, native_approve_response.json()
                        grant_id = approve["grant"]["id"]
                        assert approve["grant"]["status"] == "approved", approve

                        step = "start the approved native Hermes attempt through pane authority"
                        with page.expect_response(lambda response: response.url.split("?")[0] == origin + NATIVE_ROUTE
                                                  and post_json(response.request).get("action") == "start"):
                            pane_authority.locator("button").filter(has_text=re.compile("^Start native Hermes attempt$")).first.click()
                        started = result("start", NATIVE_ROUTE)
                        assert started["grant"]["status"] == "running", started
                        assert model.request_entered.wait(20), "native Hermes did not reach the deterministic model fixture"
                        step = "cross-mode live projection while native worker is still running"
                        expect(workbench_mode).to_have_attribute("aria-pressed", "true")
                        normal_mode.click()
                        expect(normal_mode).to_have_attribute("aria-pressed", "true")
                        normal_draft.fill("LIVE-JOURNEY-DRAFT-MUST-SURVIVE")
                        model_requests_before_toggle = len(model.requests)
                        workbench_mode.click()
                        expect(workbench_mode).to_have_attribute("aria-pressed", "true")
                        wb_timeline = agent_pane.locator(".pane-workbench-live-slot .agent-live-timeline")
                        expect(wb_timeline).to_be_visible(timeout=30000)
                        expect(wb_timeline).to_contain_text("grant", timeout=30000)
                        expect(wb_timeline).to_contain_text("running", timeout=30000)
                        grant_line = agent_pane.locator(".pane-workbench-grant-line")
                        expect(grant_line).to_contain_text("orbit-local-fixture", timeout=30000)
                        grant_budget = started["grant"]["budget"]
                        repairs_budget = consent.get("repair_iteration_limit", grant_budget.get("repair_iterations", 3))
                        expect(grant_line).to_contain_text(re.compile(
                            r"calls \d+/%s · checks \d+/%s · repairs \d+/%s · elapsed \d{2}:\d{2}" % (
                                re.escape(str(grant_budget["calls"])), re.escape(str(grant_budget["checks"])),
                                re.escape(str(repairs_budget)))), timeout=30000)
                        assert any(badge in wb_timeline.inner_text() for badge in ("AGENT", "YOU")), wb_timeline.inner_text()
                        assert "normal_fixture_read" not in wb_timeline.inner_text(), "Workbench history contains Normal SSE event"
                        assert "MODEL_ONLY_EXPLANATION" not in wb_timeline.inner_text()
                        assert "SECRET_ARGUMENT" not in wb_timeline.inner_text() and "SECRET_OUTPUT" not in wb_timeline.inner_text()
                        normal_mode.click()
                        expect(normal_mode).to_have_attribute("aria-pressed", "true")
                        expect(normal_draft).to_have_value("LIVE-JOURNEY-DRAFT-MUST-SURVIVE")
                        if not normal_timeline.count():
                            raise AssertionError("Normal timeline instance is absent while Normal mode is selected")
                        else:
                            normal_after_toggle = normal_timeline.text_content() or ""
                            assert "normal_fixture_read" in normal_after_toggle, "Normal history was lost across mode toggle"
                            assert "Native grant" not in normal_after_toggle, "Normal history contains Workbench metadata"
                        assert len(model.requests) == model_requests_before_toggle, "mode toggles must not execute the worker/model"
                        model.release_model.set()
                        status = started
                        for _ in range(180):
                            status_code, status = helper.api(origin, token, NATIVE_ROUTE, {
                                "action": "status", "project_id": project_id, "grant_id": grant_id})
                            assert status_code == 200 and status.get("ok") is True, status
                            if status["grant"]["status"] != "running":
                                break
                            time.sleep(0.25)
                        final_status = status
                        assert final_status["grant"]["status"] == "completed", final_status
                        assert final_status["grant"]["termination_confirmed"] is True, final_status
                        assert final_status["health"]["healthy"] is True, final_status["health"]
                        assert len(final_status["toolcalls"]) == 6, final_status["toolcalls"]
                        assert all(call["status"] == "completed" for call in final_status["toolcalls"])
                        workbench_mode.click()
                        expect(workbench_mode).to_have_attribute("aria-pressed", "true")
                        expect(wb_timeline).to_be_visible(timeout=30000)
                        expect(wb_timeline).to_contain_text("toolcall", timeout=30000)
                        expect(wb_timeline).to_contain_text("evidence", timeout=30000)
                        assert "normal_fixture_read" not in wb_timeline.inner_text(), "Workbench history contains hidden Normal updates"
                        assert not any(secret in wb_timeline.inner_text() for secret in ("SECRET_ARGUMENT", "SECRET_OUTPUT", WRONG, RIGHT))
                        job_row = wb_timeline.locator(".alt-row").filter(has_text="Check node-test").last
                        expect(job_row).to_be_visible(timeout=30000)
                        job_row.locator("summary").click()
                        job_row.get_by_role("button", name="Open details").click()
                        job_detail = page.locator("dialog.pane-workbench-detail")
                        expect(job_detail).to_be_visible()
                        tail_button = job_detail.get_by_role("button", name="Read a bounded unverified tail of the retained job log", exact=True)
                        expect(tail_button).to_be_visible()
                        tail_button.click()
                        expect(job_detail).to_contain_text("LIVE OUTPUT · UNVERIFIED · bounded", timeout=30000)
                        job_detail.get_by_role("button", name="Close focused detail").click()
                        wb_timeline.get_by_role("button", name="Detailed", exact=True).click()
                        expect(wb_timeline).to_contain_text(re.compile(r"\d+/\d+ tests passed"), timeout=30000)
                        candidate_row = wb_timeline.locator(".alt-row").filter(has_text="Candidate generation 2").last
                        expect(candidate_row).to_be_visible(timeout=30000)
                        candidate_row.locator("summary").click()
                        candidate_row.get_by_role("button", name="Open details").click()
                        candidate_detail_dialog = page.locator("dialog.pane-workbench-detail")
                        expect(candidate_detail_dialog).to_be_visible()
                        expect(candidate_detail_dialog).to_contain_text("Exact retained candidate generations 1→2", timeout=30000)
                        expect(candidate_detail_dialog).to_contain_text("old · private read-only", timeout=30000)
                        expect(candidate_detail_dialog).to_contain_text("new · private read-only", timeout=30000)
                        expect(candidate_detail_dialog).to_contain_text("add(a, -b)", timeout=30000)
                        expect(candidate_detail_dialog).to_contain_text("add(a, b)", timeout=30000)
                        candidate_detail_dialog.get_by_role("button", name="Close focused detail").click()

                        page_status, live_page = helper.api(origin, token, "/api/workbench/live", {
                            "action": "page", "project_id": project_id, "attempt_id": attempt["id"],
                            "after_sequence": 0, "limit": 200})
                        assert page_status == 200 and live_page.get("ok") is True, live_page
                        live_events = live_page["events"]
                        tool_events = [event for event in live_events if event["kind"] == "toolcall"]
                        assert len(tool_events) == 12, tool_events
                        tool_revisions = {}
                        for event in tool_events:
                            call_id = event.get("reference", {}).get("id")
                            status = next((field["value"] for field in event.get("fields", []) if field.get("label") == "status"), None)
                            tool_revisions.setdefault(call_id, []).append(status)
                        assert len(tool_revisions) == 6 and all(sorted(statuses) == ["completed", "started"] for statuses in tool_revisions.values()), tool_revisions
                        assert any(event["kind"] == "job" and event["authority"] == "observed" for event in live_events), live_events
                        assert any(event["kind"] == "evidence" and event["authority"] == "recorder" for event in live_events), live_events
                        assert not any(secret in json.dumps(live_events) for secret in ("SECRET_ARGUMENT", "SECRET_OUTPUT", "MODEL_ONLY_EXPLANATION", WRONG, RIGHT)), live_events
                        candidate_event = next(event for event in live_events if event["kind"] == "candidate" and event.get("reference", {}).get("generation") == 2)
                        candidate_detail_status, candidate_detail = helper.api(origin, token, "/api/workbench/live", {
                            "action":"detail","project_id":project_id,"attempt_id":attempt["id"],"reference":candidate_event["reference"]})
                        assert candidate_detail_status == 200 and candidate_detail.get("ok") is True, candidate_detail
                        assert candidate_detail["mode"] == "candidate_generation_diff" and candidate_detail["available"] is True, candidate_detail
                        file_detail = next(file for file in candidate_detail["files"] if file["path"] == "math.js")
                        assert file_detail["text_available"] is True and "add(a, -b)" in file_detail["old_text"] and "add(a, b)" in file_detail["new_text"], file_detail
                        assert any(request.get("action") == "stream" and request.get("project_id") == project_id for request in live_requests), live_requests

                        page.get_by_role("button", name="Open orbit menu").click()
                        page.get_by_role("button", name="Project Workbench", exact=True).click()
                        workbench = page.locator("dialog.project-workbench-dialog")
                        workbench.get_by_role("button", name="Open project native-fixture").click()
                        pane = workbench.locator(".workbench-execution")
                        expect(pane.get_by_role("heading", name="Execution workbench")).to_be_visible(timeout=15000)

                        step = "assert actual tool results (not fabricated)"
                        snapshots = model.result_snapshots
                        final = snapshots[-1] if snapshots else []
                        assert len(final) == 6, [len(entry) for entry in snapshots]
                        assert all(entry.get("ok") is True for entry in final), final
                        assert final[0]["result"]["contexts"][0]["id"] == packet_id, final[0]["result"]["contexts"]
                        assert final[0]["result"]["candidate"]["id"] == candidate["id"], "foreign candidate in scope"
                        assert final[0]["result"]["task"]["title"] == task["title"], "foreign task in scope"
                        assert final[1]["result"]["snapshot"]["hash"] == packet_snapshot_hash, "read_context must consume the captured attempt-bound pane packet"
                        assert final[2]["result"]["file"]["text"] == WRONG
                        assert final[3]["result"]["candidate"]["hash"] != candidate["hash"]
                        passing_evidence = final[5]["result"]["evidence"]
                        assert isinstance(passing_evidence, list) and passing_evidence, passing_evidence
                        passing_evidence_id = passing_evidence[0]["id"]
                        assert passing_evidence[0]["verdict"] == "pass", passing_evidence
                        assert passing_evidence[0]["test_results"]["success"] is True, passing_evidence
                        assert passing_evidence[0]["test_results"]["tests"] >= 1 and passing_evidence[0]["test_results"]["passed"] >= 1, passing_evidence
                        assert final[5]["result"]["job"]["candidate_id"] == candidate["id"], "foreign job in scope"
                        assert len(model.requests) >= 7, len(model.requests)
                        for body in model.requests:
                            if "tools" in body:
                                assert {tool["function"]["name"] for tool in body["tools"]} == {"orbit_workbench"}, body["tools"]
                            assert token not in json.dumps(body)
                        assert not model.errors, model.errors

                        refresh_execution(pane)
                        state = result("execution_state")
                        assert [entry["verdict"] for entry in state["evidence"]] == ["fail", "pass"], state["evidence"]
                        assert any(entry["superseded"] for entry in state["evidence"]), "owner fail must be superseded by the model patch"
                        patched_hash = final[3]["result"]["candidate"]["hash"]
                        passing = next(entry for entry in state["evidence"] if entry["verdict"] == "pass")
                        assert passing["execution_profile_id"] == environment_profile, passing
                        assert passing["environment"]["dependency_hash"] == dependency_hash, passing["environment"]
                        assert passing["environment"]["execution_view_identity"] and passing["environment"]["execution_view_id"], passing["environment"]
                        pass_observation = passing["execution_observation"]
                        assert pass_observation["dependency_before"] == pass_observation["dependency_after"] == dependency_hash, pass_observation
                        assert pass_observation["verified_view"] is True, pass_observation
                        assert passing["candidate_hash_before"] == passing["candidate_hash_after"] == patched_hash, passing
                        assert pass_observation["source_before"] == pass_observation["source_after"] == patched_hash, pass_observation
                        assert pass_observation["view_source_before"] == pass_observation["view_source_after"] == patched_hash, pass_observation
                        assert api(EXEC_ROUTE, "candidate_read", project_id=project_id,
                                   candidate_id=candidate["id"], path="math.js")[1]["file"]["text"] == RIGHT
                        assert (project / "math.js").read_text() == WRONG
                        assert (project / "math.test.js").read_text() == MATH_TEST

                        step = "owner review of recorded pass then workflow integration"
                        checkbox = pane.locator("label", has_text="Passing evidence " + passing_evidence_id).locator("input[type=checkbox]")
                        expect(checkbox).to_be_visible(timeout=15000)
                        checkbox.check()
                        review = click_text(pane.locator(".workbench-execution-review"), "Approve", "review_decide")["review"]
                        assert review["decision"] == "approved" and passing_evidence_id in review["evidence_ids"], review

                        refresh_workbench(workbench, pane)
                        select = pane.get_by_label("Approved candidate and review")
                        expect(select.locator("option")).not_to_have_count(0)
                        select.select_option(value="%s:%s:%s" % (candidate["id"], review["id"], task["id"]))
                        step = "verified artifact record projects as recorder-owned live metadata"
                        patch_preview = click_text(pane, "Preview reviewed patch", "patch_preview", WORKFLOW_ROUTE)
                        assert patch_preview["roundtrip"]["verified"] is True, patch_preview
                        exported = click_text(pane, "Create private verified patch", "patch_export", WORKFLOW_ROUTE, timeout=90000)["patch"]
                        assert exported["status"] == "available" and exported["roundtrip"]["verified"] is True, exported
                        patch_page_status, patch_page = helper.api(origin, token, "/api/workbench/live", {
                            "action":"page","project_id":project_id,"attempt_id":attempt["id"],"after_sequence":0,"limit":200})
                        assert patch_page_status == 200 and patch_page.get("ok") is True, patch_page
                        patch_events = patch_page["events"]
                        assert any(event["kind"] == "patch" and event["authority"] == "recorder" and event["status"] == "completed" for event in patch_events), patch_events
                        assert not any(secret in json.dumps(patch_events) for secret in (WRONG, RIGHT, "MODEL_ONLY_EXPLANATION", "SECRET_ARGUMENT", "SECRET_OUTPUT")), patch_events
                        if workbench.is_visible():
                            workbench.get_by_role("button", name="Close project workbench", exact=True).click()
                            expect(workbench).not_to_be_visible()
                        normal_mode.click()
                        expect(normal_mode).to_have_attribute("aria-pressed", "true")
                        if not normal_timeline.count():
                            raise AssertionError("Normal timeline instance is absent after Workbench updates")
                        else:
                            expect(normal_timeline).to_be_visible()
                            normal_after_export = normal_timeline.text_content() or ""
                            assert "normal_fixture_read" in normal_after_export, "Normal history missing after Workbench export"
                            assert "Private patch" not in normal_after_export, "Normal history contains Workbench export metadata"
                        assert len(gateway.posts) == 1, "mode switches must not submit another Normal run"
                        workbench_mode.click()
                        expect(workbench_mode).to_have_attribute("aria-pressed", "true")
                        expect(wb_timeline).to_be_visible()
                        expect(wb_timeline).to_contain_text("Private patch", timeout=30000)
                        result_row = wb_timeline.locator(".alt-row").filter(has_text="Task result")
                        expect(result_row.first).to_be_visible(timeout=30000)
                        result_row.first.locator("summary").click()
                        result_row.first.get_by_role("button", name="Open details").click()
                        result_detail = page.locator("dialog.pane-workbench-detail")
                        expect(result_detail).to_be_visible()
                        expect(result_detail).to_contain_text("result_receipt", timeout=30000)
                        assert "MODEL_ONLY_EXPLANATION" not in result_detail.inner_text()
                        result_detail.get_by_role("button", name="Close focused detail").click()
                        step = "reload replays durable activity without execution"
                        model_requests_before_reload = len(model.requests)
                        native_starts_before_reload = sum(1 for request, status, response in responses
                            if request.url.split("?")[0] == origin + NATIVE_ROUTE and post_json(request).get("action") == "start")
                        live_requests_before_reload = len(live_requests)
                        page.reload(wait_until="domcontentloaded")
                        page.get_by_role("button", name="Connect local host", exact=True).click()
                        page.get_by_role("textbox", name="Host session token").fill(token)
                        page.get_by_role("button", name="Unlock local host", exact=True).click()
                        expect(page.locator(".saved")).to_contain_text("Workspace connected", timeout=15000)
                        reloaded_agent = page.locator('[data-pane-id="%s"]' % helper.PANE)
                        expect(reloaded_agent.get_by_role("button", name="Workbench Hermes mode", exact=True)).to_have_attribute("aria-pressed", "true")
                        reloaded_project = reloaded_agent.get_by_label("Workbench project", exact=True)
                        expect(reloaded_project.locator('option[value="%s"]' % project_id)).to_have_count(1, timeout=30000)
                        reloaded_project.select_option(value=project_id)
                        reloaded_attempt = reloaded_agent.get_by_label("Workbench attempt", exact=True)
                        expect(reloaded_attempt.locator('option[value="%s"]' % attempt["id"])).to_have_count(1, timeout=30000)
                        reloaded_attempt.select_option(value=attempt["id"])
                        reloaded_timeline = reloaded_agent.locator(".pane-workbench-live-slot .agent-live-timeline")
                        expect(reloaded_timeline).to_be_visible(timeout=30000)
                        expect(reloaded_timeline).to_contain_text("Private patch", timeout=30000)
                        replay_ids = reloaded_timeline.locator('button[aria-label^="Copy safe ID"]').evaluate_all("nodes => nodes.map(n => n.getAttribute('aria-label'))")
                        assert len(replay_ids) == len(set(replay_ids)), "replay duplicates a visible safe event ID"
                        assert len(model.requests) == model_requests_before_reload, "reload must not replay model work"
                        native_starts_after_reload = sum(1 for request, status, response in responses
                            if request.url.split("?")[0] == origin + NATIVE_ROUTE and post_json(request).get("action") == "start")
                        assert native_starts_after_reload == native_starts_before_reload == 1, "reload must not duplicate native grant start"
                        replay_streams = live_requests[live_requests_before_reload:]
                        assert any(request.get("action") == "stream" and request.get("attempt_id") == attempt["id"]
                                   and request.get("after_sequence", 0) == 0 for request in replay_streams), replay_streams
                        reloaded_normal = reloaded_agent.locator(".agent-chat-normal .agent-live-timeline")
                        if not reloaded_normal.count():
                            raise AssertionError("Normal history instance is missing after reload")
                        else:
                            reloaded_text = reloaded_normal.text_content() or ""
                            assert "Private patch" not in reloaded_text, "Reload mixed Workbench events into Normal history"
                            assert "Native grant" not in reloaded_text, "Reload mixed Workbench grant metadata into Normal history"
                        persisted = api(EXEC_ROUTE, "execution_state", project_id=project_id)
                        assert [entry["verdict"] for entry in persisted[1]["evidence"]] == ["fail", "pass"], persisted[1]["evidence"]
                        assert any(item["decision"] == "approved" for item in persisted[1]["reviews"]), persisted[1]["reviews"]
                        assert (project / "math.js").read_text() == WRONG

                        step = "boundary assertions"
                        assert not page_errors, page_errors
                        assert not terminals, terminals
                        assert not external, external
                        assert len(gateway.posts) == 1, gateway.posts
                        databases = list((root / "runtime").rglob("workspace.sqlite"))
                        assert len(databases) == 1, databases
                        with sqlite3.connect("file:%s?mode=ro" % databases[0], uri=True) as db:
                            grants = [json.loads(row[0]) for row in db.execute(
                                "SELECT record_json FROM wb_grants").fetchall()]
                            calls = [json.loads(row[0]) for row in db.execute(
                                "SELECT record_json FROM wb_toolcalls").fetchall()]
                            profiles = [json.loads(row[0]) for row in db.execute(
                                "SELECT record_json FROM wb_profiles").fetchall()]
                        assert any(grant["status"] == "completed" and grant["id"] == grant_id for grant in grants), grants
                        assert len(calls) == 6 and all(call["status"] == "completed" for call in calls), calls
                        assert all(call["action"] != "terminal" for call in calls)
                        assert any(profile["id"] == environment_profile and profile["status"] == "ready"
                                   and profile["prepared"]["dependency_hash"] == dependency_hash for profile in profiles), profiles
                        assert root != ROOT and not str(root).startswith(str(ROOT) + os.sep)
                        event_kinds = sorted({event["kind"] for event in patch_events})
                        print("LIVE_EVENTS renderer=%s kinds=%s toolcalls=%d evidence=%d reviews=%d patches=%d normal_sse_runs=%d model_requests=%d" % (
                            renderer, json.dumps(event_kinds), len(calls), len(state["evidence"]), len(persisted[1]["reviews"]),
                            sum(event["kind"] == "patch" for event in patch_events), len(gateway.posts), len(model.requests)), flush=True)
                        log("PASS: renderer=%s chromium=%s model_requests=%d toolcalls=%d normal_sse_runs=%d verdicts=[fail,pass] "
                            "environment=%s dependency_hash=%s source=WRONG candidate=RIGHT "
                            "page_errors=0 external=0 owner_read=false secrets_redacted=true"
                            % (renderer, browser.version, len(model.requests), len(calls), len(gateway.posts), environment_profile[:8],
                                dependency_hash[:12]))
                        print(lines[-1], flush=True)
                        log_file.close()
                        return True
                    except Exception:
                        model.release_model.set()
                        failure = safe("FAIL: renderer=%s step=%s" % (renderer, step))
                        log(failure)
                        print(failure, flush=True)
                        log(safe(traceback.format_exc()))
                        print(safe(traceback.format_exc()), flush=True)
                        last_responses = []
                        for request, status, response in responses[-16:]:
                            try:
                                body = response.json()
                            except Exception:
                                body = {}
                            last_responses.append({"action": (post_json(request).get("action")), "url": request.url.split("?")[0],
                                                   "status": status, "ok": body.get("ok"), "code": body.get("code")})
                        log(safe("Last responses: " + json.dumps(last_responses)))
                        log(safe("Model snapshots=%s errors=%s" % ([len(item) for item in model.result_snapshots], model.errors)))
                        log(safe("gateway posts=%d gets=%s" % (len(gateway.posts), gateway.gets)))
                        log(safe("page_errors=%s terminals=%s external=%s" % (page_errors, terminals, external)))
                        try:
                            page.screenshot(path=str(log_path.with_suffix(".png")), full_page=True,
                                            mask=[page.get_by_role("textbox", name="Host session token")])
                        except Exception:
                            pass
                        log_file.close()
                        return False
                    finally:
                        context.close()
                        browser.close()
        except Exception:
            log(safe(traceback.format_exc()))
            log_file.close()
            return False
        finally:
            model.release_model.set()
            if server is not None:
                server.terminate()
                try:
                    server.wait(timeout=10)
                except subprocess.TimeoutExpired:
                    server.kill()
                    server.wait()
            gateway.shutdown()
            gateway.server_close()
            gateway_thread.join(timeout=5)
            model.shutdown()
            model.server_close()
            model_thread.join(timeout=5)
    return True


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--renderer", choices=("default", "docking", "both"), default="both")
    renderer = parser.parse_args().renderer
    selected = ("default", "docking") if renderer == "both" else (renderer,)
    results = [main(name) for name in selected]
    sys.exit(0 if all(results) else 1)
