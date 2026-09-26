"""Disposable real-server Chromium journey for the pinned native Hermes Workbench.

Real Node server + real SQLite + real linked git worktree + the pinned real Hermes
source/plugin (d0288be5) driven by a deterministic local OpenAI/SSE fixture. The
synthetic gateway only holds the owner's shared-chat binding for agent history and
is never posted to. Nothing here reads owner credentials or the owner runtime.

Run:
  /tmp/opencode/orbit-managed-ui-venv/bin/python tests/workbench-native.browser.py --renderer default
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
HERMES_SOURCE = Path("/tmp/opencode/orbit-hermes-native")
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
            message = {"role": "assistant", "content": "Fixture complete; recorder evidence is authoritative."}
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


def main(renderer):
    log_path = Path("/tmp/opencode/comet-native-browser-%s.log" % renderer)
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
        for name in ("server", "src", "contracts", "docs", "public", "hermes-plugin"):
            shutil.copytree(ROOT / name, root / name)
        for name in ("index.html", "package.json", "tsconfig.json", "vite.config.js"):
            shutil.copy2(ROOT / name, root / name)
        (root / "node_modules").symlink_to(ROOT / "node_modules", target_is_directory=True)
        for name in ("runtime", "home", "cwd", "tmux"):
            (root / name).mkdir()
        env = {"HOME": str(root / "home"), "PATH": os.environ["PATH"], "npm_config_cache": str(root / ".npm")}
        log("build: disposable copy at %s (checkout %s untouched)" % (root, ROOT))
        helper.run(shutil.which("npm"), "run", "build", cwd=root, env=env)
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
        gateway = helper.SyntheticGateway()
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
                            try:
                                body = response.json()
                            except Exception:
                                body = {}
                            responses.append((response.request, response.status, body))

                    page.on("response", record)

                    def result(action, route=EXEC_ROUTE):
                        matches = [(request, status, body) for request, status, body in responses
                                   if request.url.split("?")[0] == origin + route and post_json(request).get("action") == action]
                        assert matches, ("Missing %s response on %s" % (action, route))
                        _, status, body = matches[-1]
                        assert status == 200 and body.get("ok") is True, (action, status, body)
                        return body

                    def last(action, route=EXEC_ROUTE):
                        matches = [body for request, status, body in responses
                                   if request.url.split("?")[0] == origin + route and post_json(request).get("action") == action]
                        return matches[-1] if matches else None

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

                    def refresh_workbench(dialog):
                        # "Refresh project inspection" re-runs inspect() and then
                        # execution/authority/workflow refresh(); used when the
                        # workflow's approved-review list must be rebuilt.
                        target = dialog.locator("button").filter(has_text=re.compile("^Refresh project inspection$"))
                        # A single waiter: resolve on the workflow refresh's own
                        # execution_state read, which necessarily follows its
                        # integration_list read. Avoids concurrent response waiters.
                        seen = {"integration_list": False}

                        def predicate(response):
                            url = response.url.split("?")[0]
                            action = post_json(response.request).get("action")
                            if url == origin + WORKFLOW_ROUTE and action == "integration_list":
                                seen["integration_list"] = True
                                return False
                            return seen["integration_list"] and url == origin + EXEC_ROUTE and action == "execution_state"

                        with page.expect_response(predicate, timeout=45000):
                            target.first.click()

                    def click_plain(scope, label):
                        # helper buttons carry a descriptive aria-label/title while
                        # their visible text stays short, so click by visible text.
                        scope.locator("button").filter(has_text=re.compile("^" + re.escape(label) + "$")).first.click()

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
                        click_plain(pane, "Refresh task authority")
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
                        click_plain(pane, "Refresh task authority")
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
                        packet_id = packet_response.json()["context"]["id"]
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
                        assert preview["context_id"] == packet_id, (preview["context_id"], packet_id)
                        assert preview["recipient"]["session_id"] == session
                        dialog.get_by_text("Close", exact=True).click()
                        expect(dialog).not_to_be_visible()
                        # No context was approved/shared: native read_context uses the
                        # server-retained packet, not a one-shot disclosure.
                        assert last("approve", CONTEXT_ROUTE) is None and last("share", CONTEXT_ROUTE) is None

                        step = "native consent via UI and real pinned Hermes run"
                        click_plain(pane, "Refresh task authority")
                        expect(pane.get_by_label("Native task attempt").locator("option")).not_to_have_count(0)
                        pane.get_by_label("Native task attempt").select_option(value=attempt["id"])
                        expect(pane.get_by_label("Native approved context packet").locator("option")).not_to_have_count(0)
                        pane.get_by_label("Native approved context packet").select_option(value=packet_id)
                        consent = click_text(pane, "Preview native task consent", "preview", NATIVE_ROUTE)
                        assert consent["preview"]["attempt_id"] == attempt["id"], consent
                        assert [item["id"] for item in consent["preview"]["contexts"]] == [packet_id], consent
                        assert consent["preview"]["budget"] == {"calls": 20, "checks": 3, "duration_ms": 180000}
                        approve = click_text(pane, "Approve native task consent", "approve", NATIVE_ROUTE)
                        grant_id = approve["grant"]["id"]
                        assert approve["grant"]["status"] == "approved", approve

                        with page.expect_response(lambda response: response.url.split("?")[0] == origin + NATIVE_ROUTE
                                                  and post_json(response.request).get("action") == "start"):
                            pane.locator("button").filter(has_text=re.compile("^Start native Hermes attempt$")).first.click()
                        started = result("start", NATIVE_ROUTE)
                        assert started["grant"]["status"] == "running", started
                        status = started
                        for _ in range(180):
                            status = click_text(pane, "Read native attempt status", "status", NATIVE_ROUTE)
                            if status["grant"]["status"] != "running":
                                break
                            time.sleep(0.25)
                        final_status = status
                        assert final_status["grant"]["status"] == "completed", final_status
                        assert final_status["grant"]["termination_confirmed"] is True, final_status
                        assert final_status["health"]["healthy"] is True, final_status["health"]
                        assert len(final_status["toolcalls"]) == 6, final_status["toolcalls"]
                        assert all(call["status"] == "completed" for call in final_status["toolcalls"])

                        step = "assert actual tool results (not fabricated)"
                        snapshots = model.result_snapshots
                        final = snapshots[-1] if snapshots else []
                        assert len(final) == 6, [len(entry) for entry in snapshots]
                        assert all(entry.get("ok") is True for entry in final), final
                        assert final[0]["result"]["contexts"][0]["id"] == packet_id, final[0]["result"]["contexts"]
                        assert final[0]["result"]["candidate"]["id"] == candidate["id"], "foreign candidate in scope"
                        assert final[0]["result"]["task"]["title"] == task["title"], "foreign task in scope"
                        assert final[1]["result"]["snapshot"]["hash"] == preview["hash"], "read_context mismatch"
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

                        refresh_workbench(workbench)
                        select = pane.get_by_label("Approved candidate and review")
                        expect(select.locator("option")).not_to_have_count(0)
                        select.select_option(value="%s:%s" % (candidate["id"], review["id"]))
                        integration_preview = click_text(pane, "Preview private integration", "integration_preview", WORKFLOW_ROUTE)
                        assert integration_preview["candidate_hash"] == review["candidate_hash"], integration_preview
                        assert integration_preview["source_hash"] == candidate["source_manifest_hash"], integration_preview
                        integration = click_text(pane, "Create private integration branch", "integrate_confirm", WORKFLOW_ROUTE)["integration"]
                        assert integration["status"] == "integrated", integration
                        artifact = Path(integration["artifact_path"])
                        assert artifact.is_dir(), artifact
                        log_text = subprocess.check_output(
                            ["git", "-C", str(artifact), "log", "--format=%H", "--reverse"], text=True).strip().splitlines()
                        assert len(log_text) == 2, log_text
                        assert subprocess.check_output(
                            ["git", "-C", str(artifact), "show", "HEAD:math.js"], text=True) == RIGHT
                        assert subprocess.check_output(
                            ["git", "-C", str(artifact), "show", log_text[0] + ":math.js"], text=True) == WRONG
                        assert (project / "math.js").read_text() == WRONG

                        step = "recipe CAS apply and return preserve workspace identity"
                        ws_before = api("/api/workspace", "read")[1]
                        state_before = ws_before["state"]
                        monitor_ids_before = [monitor["id"] for monitor in state_before["monitors"]]
                        revision_before = ws_before["revision"]
                        investigate = click_text(pane, "Preview Investigate", "recipe_preview", WORKFLOW_ROUTE)
                        assert investigate["preview_id"] and investigate["base_revision"] == revision_before, investigate
                        for recipe in ("Preview Implement", "Preview Review"):
                            previewed = click_text(pane, recipe, "recipe_preview", WORKFLOW_ROUTE)
                            assert previewed["preview_id"], previewed
                        # Re-preview Investigate so Apply commits exactly that arrangement.
                        investigate = click_text(pane, "Preview Investigate", "recipe_preview", WORKFLOW_ROUTE)
                        applied = click_text(pane, "Apply previewed arrangement", "recipe_apply", WORKFLOW_ROUTE)
                        applied_revision = applied["workspace"]["revision"]
                        assert applied_revision == revision_before + 1, applied
                        ws_mid = api("/api/workspace", "read")[1]
                        assert ws_mid["state"] == state_before, "recipe reorder must keep the same pane identities"
                        return_preview = click_text(pane, "Preview return", "recipe_preview", WORKFLOW_ROUTE)
                        assert return_preview["preview_id"] and return_preview["base_revision"] == applied_revision, return_preview
                        returned = click_text(pane, "Apply previewed arrangement", "recipe_apply", WORKFLOW_ROUTE)
                        assert returned["workspace"]["revision"] == applied_revision + 1, returned
                        ws_after = api("/api/workspace", "read")[1]
                        assert ws_after["state"] == state_before, "return must restore the same arrangement"
                        assert [monitor["id"] for monitor in ws_after["state"]["monitors"]] == monitor_ids_before
                        chat = json.loads(page.evaluate("sessionStorage.getItem('orbit-hermes-chat:%s')" % helper.PANE))
                        assert chat["session"] == session and chat["profile_id"] == "default", chat

                        step = "reload preserves durable native/review/integration state"
                        page.reload(wait_until="domcontentloaded")
                        page.get_by_role("button", name="Connect local host", exact=True).click()
                        page.get_by_role("textbox", name="Host session token").fill(token)
                        page.get_by_role("button", name="Unlock local host", exact=True).click()
                        expect(page.locator(".saved")).to_contain_text("Workspace connected", timeout=15000)
                        page.get_by_role("button", name="Open orbit menu").click()
                        page.get_by_role("button", name="Project Workbench", exact=True).click()
                        workbench2 = page.locator("dialog.project-workbench-dialog")
                        workbench2.get_by_role("button", name="Open project native-fixture").click()
                        pane2 = workbench2.locator(".workbench-execution")
                        expect(pane2.locator(".workbench-execution-status")).to_contain_text("Execution:", timeout=20000)
                        persisted = api(EXEC_ROUTE, "execution_state", project_id=project_id)
                        assert [entry["verdict"] for entry in persisted[1]["evidence"]] == ["fail", "pass"], persisted[1]["evidence"]
                        assert any(item["decision"] == "approved" for item in persisted[1]["reviews"]), persisted[1]["reviews"]
                        integrations = api(WORKFLOW_ROUTE, "integration_list", project_id=project_id)[1]["integrations"]
                        assert any(item["id"] == integration["id"] for item in integrations), integrations
                        assert (project / "math.js").read_text() == WRONG
                        assert subprocess.check_output(["git", "-C", str(artifact), "show", "HEAD:math.js"], text=True) == RIGHT

                        step = "boundary assertions"
                        assert not page_errors, page_errors
                        assert not terminals, terminals
                        assert not external, external
                        assert not gateway.posts, gateway.posts
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
                        log("PASS: renderer=%s chromium=%s model_requests=%d toolcalls=%d verdicts=[fail,pass] "
                            "environment=%s dependency_hash=%s recipe_revision=%d->%d source=WRONG artifact=RIGHT "
                            "page_errors=0 external=0 gateway_posts=0 owner_read=false secrets_redacted=true"
                            % (renderer, browser.version, len(model.requests), len(calls), environment_profile[:8],
                               dependency_hash[:12], revision_before, returned["workspace"]["revision"]))
                        log_file.close()
                        return True
                    except Exception:
                        log(safe("FAIL: renderer=%s step=%s" % (renderer, step)))
                        log(safe(traceback.format_exc()))
                        log(safe("Last responses: " + json.dumps([
                            {"action": (post_json(request).get("action")), "url": request.url.split("?")[0],
                             "status": status, "ok": body.get("ok"), "code": body.get("code")}
                            for request, status, body in responses[-16:]])))
                        log(safe("Model snapshots=%s errors=%s" % ([len(item) for item in model.result_snapshots], model.errors)))
                        log(safe("gateway posts=%d gets=%s" % (len(gateway.posts), gateway.gets)))
                        log(safe("page_errors=%s terminals=%s external=%s" % (page_errors, terminals, external)))
                        try:
                            page.screenshot(path="/tmp/opencode/comet-native-browser-%s.png" % renderer, full_page=True,
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
    parser.add_argument("--renderer", choices=("default", "docking"), required=True)
    sys.exit(0 if main(parser.parse_args().renderer) else 1)
