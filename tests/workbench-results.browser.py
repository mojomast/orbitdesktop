"""Gate 1: actual pinned Hermes result delivery and host-card handoff in the browser.

Real disposable Node server + real SQLite + the pinned Hermes source/plugin
(d0288be5) driven by a deterministic local OpenAI/SSE model. The owner flow is
driven through the authenticated HTTP API; the user-visible explanation/provenance
and the host-authored chat card are asserted in the DOM. The host card is
read-only UI: delivering a result must not add a chat turn or call the model.

The isolated build is produced with scripts/isolated_build.mjs into the disposable
copy only; the checkout and any served release are never written.

Run (both renderers):
  PLAYWRIGHT_BROWSERS_PATH=/tmp/opencode/orbit-evolution-browsers \\
    /tmp/opencode/orbit-managed-ui-venv/bin/python tests/workbench-results.browser.py --renderer default

Correction: an earlier revision never appended ?renderer=docking and did not assert
the installed renderer, so its reported default+docking passes were both the default
renderer. This revision applies the query, asserts the actual installed renderer via
window.__orbitDocking (supported), and re-asserts it after reload.
"""

import argparse
import ast
import importlib.util
import json
import os
from pathlib import Path
import secrets
import shutil
import socket
import subprocess
import sys
import tempfile
import threading
import time
import urllib.error
import urllib.request
import uuid

from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from playwright.sync_api import expect, sync_playwright

sys.dont_write_bytecode = True
_spec = importlib.util.spec_from_file_location(
    "wb_context_browser", Path(__file__).with_name("workbench-context.browser.py"))
helper = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(helper)

ROOT = Path(__file__).resolve().parents[1]
HERMES_SOURCE = Path("/tmp/opencode/orbit-hermes-native")
HERMES_PIN = "d0288be5b3330d2442e3907185b8e9d0958297bb"
GATEWAY_KEY = "fixture-synthetic-not-real"
NATIVE_ROUTE = "/api/workbench/native"
EXEC_ROUTE = "/api/workbench/execution"
WORKBENCH_ROUTE = "/api/workbench"
WRONG = "export const sum = (a,b) => a - b;\n"
RIGHT = "export const sum = (a,b) => a + b;\n"
ANSWER_TOKEN = "FLASH-HOSTCARD-EXPLANATION"
CARD_SUMMARY = "Comet task result · supervised worker"


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
        step = len(results)
        if step >= self.server.finish_step:
            message = {"role": "assistant", "content": self.server.final_answer(results)}
        else:
            try:
                args = self.server.next_args(results)
            except Exception as error:
                self.server.errors.append("%s: %s" % (type(error).__name__, error))
                args = {"action": "inspect"}
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
            return self._send(("".join("data: " + json.dumps(chunk) + "\n\n" for chunk in chunks) + "data: [DONE]\n\n").encode(),
                              content_type="text/event-stream")
        self._send(completion)


class ModelFixture(ThreadingHTTPServer):
    daemon_threads = True
    finish_step = 5

    def __init__(self):
        super().__init__(("127.0.0.1", 0), ModelHandler)
        self.requests, self.result_snapshots, self.errors = [], [], []

    def next_args(self, results):
        step = len(results)
        if step == 0:
            return {"action": "inspect"}
        if step == 1:
            return {"action": "candidate_read", "path": "math.js"}
        if step == 2:
            return {"action": "candidate_patch",
                    "expected_candidate_hash": results[0]["result"]["candidate"]["hash"],
                    "changes": [{"op": "change", "path": "math.js",
                                 "expected_hash": results[1]["result"]["file"]["hash"], "content": RIGHT}]}
        if step == 3:
            return {"action": "job_start"}
        if step == 4:
            return {"action": "evidence", "job_id": results[3]["result"]["job"]["id"]}
        return {"action": "inspect"}

    def final_answer(self, results):
        evidence = (results[4].get("result", {}) or {}).get("evidence") or []
        reference = " see evidence:%s" % evidence[0]["id"] if evidence else ""
        return "%s: repaired the failing sum and re-ran the approved check.%s" % (ANSWER_TOKEN, reference)


def call(origin, token, route, body):
    status, payload = helper.api(origin, token, route, body)
    assert status == 200 and payload.get("ok") is True, (route, status, payload)
    return payload


def wait_renderer(page, renderer, timeout_s=20):
    """Assert the ACTUAL installed renderer, not the fixture label."""
    deadline = time.time() + timeout_s
    info = None
    while time.time() < deadline:
        info = page.evaluate("() => window.__orbitDocking ? {renderer: window.__orbitDocking.renderer, supported: window.__orbitDocking.supported, reason: window.__orbitDocking.reason ?? null} : null")
        if renderer == "docking":
            if info and info.get("renderer") == "docking":
                assert info.get("supported") is True, info
                return info
        elif info is None:
            return None
        time.sleep(.1)
    raise AssertionError("renderer %s not active (observed %r)" % (renderer, info))


def wait_workspace(origin, token, timeout_s=20):
    deadline = time.time() + timeout_s
    while time.time() < deadline:
        status, payload = helper.api(origin, token, WORKBENCH_ROUTE, {"action": "list"})
        if status == 200 and payload.get("ok") is True:
            return
        time.sleep(.1)
    raise RuntimeError("workspace did not sync after unlock")


def wait_card(page, pane_id, timeout_ms=20000):
    card = page.locator('.pane[data-pane-id="%s"] section.agent-task-results details[data-result-id]' % pane_id)
    expect(card.first).to_be_visible(timeout=timeout_ms)
    return card


def main(renderer):
    log_path = Path("/tmp/opencode/comet-results-browser-%s.log" % renderer)
    log_file = log_path.open("w")
    lines = []

    def log(message):
        lines.append(str(message))
        log_file.write(str(message) + "\n")
        log_file.flush()

    tree = ast.parse(Path(__file__).read_text(), feature_version=(3, 11))
    assert not any(isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute)
                   and node.func.attr in ("route", "route_from_har") for node in ast.walk(tree))
    assert HERMES_SOURCE.is_dir(), "Pinned Hermes source missing"
    assert str(HERMES_SOURCE).startswith("/tmp/opencode/") and not str(HERMES_SOURCE).startswith("/home/")
    head = subprocess.check_output(["git", "-C", str(HERMES_SOURCE), "rev-parse", "HEAD"], text=True).strip()
    assert head == HERMES_PIN, head
    assert subprocess.check_output([shutil.which("node"), "--version"], text=True).strip().startswith("v22")
    token = secrets.token_urlsafe(36)

    def safe(value):
        return str(value).replace(token, "[REDACTED]").replace(GATEWAY_KEY, "[SYNTHETIC_KEY]")

    with tempfile.TemporaryDirectory(prefix="orbit-results-browser-", dir="/tmp/opencode") as temp:
        root = Path(temp)
        assert root != ROOT and not str(root).startswith(str(ROOT) + os.sep)
        for name in ("server", "src", "contracts", "docs", "public", "hermes-plugin"):
            shutil.copytree(ROOT / name, root / name)
        for name in ("index.html", "package.json", "tsconfig.json", "vite.config.js"):
            shutil.copy2(ROOT / name, root / name)
        (root / "node_modules").symlink_to(ROOT / "node_modules", target_is_directory=True)
        for name in ("runtime", "home", "cwd", "tmux"):
            (root / name).mkdir()
        env = {"HOME": str(root / "home"), "PATH": os.environ["PATH"], "npm_config_cache": str(root / ".npm")}
        built = helper.run(shutil.which("node"), str(ROOT / "scripts/isolated_build.mjs"),
                           "--source", str(root), "--dest", str(root / "dist"), "--allow-source-dist", cwd=root, env=env)
        log("isolated build: %s" % built.stdout.strip())
        assert (root / "dist/index.html").is_file()

        project = root / "project"
        project.mkdir()
        (project / "math.js").write_text(WRONG)

        model = ModelFixture()
        threading.Thread(target=model.serve_forever, daemon=True).start()
        model_url = "http://127.0.0.1:%d/v1" % model.server_port
        gateway = helper.SyntheticGateway()
        threading.Thread(target=gateway.serve_forever, daemon=True).start()

        with socket.socket() as probe:
            probe.bind(("127.0.0.1", 0))
            port = probe.getsockname()[1]
        origin = "http://127.0.0.1:%d" % port
        session = "orbit-" + str(uuid.uuid4())
        server = None
        try:
            monitor = str(uuid.uuid4())
            state = {"version": 1, "selected": monitor, "arc": 14, "view": "windows", "monitors": [{
                "id": monitor, "name": "Result fixture agent", "diagonal": 32, "aspect": "16:9",
                "height": 0, "distance": 0, "pitch": 0, "yaw": 0, "offset": 0, "fontSize": 19,
                "frame": {"x": 0, "y": 0, "width": 900, "height": 900, "z": 0},
                "layout": {"type": "pane", "pane": {"id": helper.PANE, "kind": "agent", "url": ""}}}]}
            server_env = {**env, "PORT": str(port), "ORBIT_TOKEN": token,
                          "ORBIT_RUNTIME_DIR": str(root / "runtime"), "ORBIT_CWD": str(root / "cwd"),
                          "ORBIT_TMUX_SOCKET": "results-" + str(uuid.uuid4()), "ORBIT_TMUX_CONFIG": "/dev/null",
                          "TMUX_TMPDIR": str(root / "tmux"),
                          "HERMES_API_URL": "http://127.0.0.1:%d" % gateway.server_port, "HERMES_API_KEY": GATEWAY_KEY,
                          "ORBIT_NATIVE_HERMES_SOURCE": str(HERMES_SOURCE),
                          "ORBIT_NATIVE_HERMES_PYTHON": str(HERMES_SOURCE / ".venv/bin/python"),
                          "ORBIT_NATIVE_HERMES_MODEL_URL": model_url,
                          "ORBIT_NATIVE_HERMES_PROFILE": "default",
                          "ORBIT_NATIVE_HERMES_MODEL": "orbit-local-fixture"}
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
                        "if(window===window.top){localStorage.setItem('orbit.onboarding.v1','done');localStorage.setItem('orbit.workspace.id'," + json.dumps(helper.WORKSPACE) +
                        ");localStorage.setItem('orbit.workspace.v1',JSON.stringify(" + json.dumps(state) + "));" +
                        "sessionStorage.setItem('orbit-hermes-chat:" + helper.PANE + "',JSON.stringify(" + json.dumps(chat) + "));}")
                    page = context.new_page()
                    page_errors, responses = [], []
                    page.on("pageerror", lambda error: page_errors.append(str(error)))
                    page.on("response", lambda response: responses.append((response.url, response.status)))
                    try:
                        page.goto(origin + ("?renderer=docking" if renderer == "docking" else ""))
                        expect(page.locator('.pane[data-pane-id="%s"]' % helper.PANE)).to_be_visible(timeout=20000)
                        page.get_by_role("button", name="Connect local host", exact=True).click()
                        page.get_by_role("textbox", name="Host session token").fill(token)
                        page.get_by_role("button", name="Unlock local host", exact=True).click()
                        wait_workspace(origin, token)
                        assert ("?renderer=docking" in page.url) == (renderer == "docking"), page.url
                        renderer_info = wait_renderer(page, renderer)
                        log("renderer=%s actual=%s" % (renderer, renderer_info))

                        log("register project and create a bound native attempt through the owner API")
                        preview = call(origin, token, WORKBENCH_ROUTE, {"action": "register_preview", "root": str(project), "name": "result-fixture"})
                        project_id = call(origin, token, WORKBENCH_ROUTE, {"action": "register_commit", "approval_id": preview["approval_id"]})["project"]["id"]
                        task = call(origin, token, EXEC_ROUTE, {"action": "task_create", "project_id": project_id, "title": "Repair sum",
                                                               "acceptance_statement": "sum must add", "check_definition_id": "host-regression",
                                                               "profile_id": "default", "session_id": session, "pane_id": helper.PANE})["task"]
                        candidate_preview = call(origin, token, EXEC_ROUTE, {"action": "candidate_preview", "project_id": project_id, "task_id": task["id"]})
                        candidate = call(origin, token, EXEC_ROUTE, {"action": "candidate_create", "project_id": project_id, "task_id": task["id"],
                                                                     "preview_id": candidate_preview["preview_id"], "preview_digest": candidate_preview["preview"]["digest"]})["candidate"]
                        attempt = call(origin, token, EXEC_ROUTE, {"action": "attempt_create", "project_id": project_id, "task_id": task["id"],
                                                                   "candidate_id": candidate["id"], "profile_id": "default", "session_id": session, "pane_id": helper.PANE})["attempt"]
                        native_preview = call(origin, token, NATIVE_ROUTE, {"action": "preview", "project_id": project_id, "attempt_id": attempt["id"],
                                                                            "context_ids": [], "budget": {"calls": 8, "checks": 2, "duration_ms": 90000}})
                        grant = call(origin, token, NATIVE_ROUTE, {"action": "approve", "project_id": project_id,
                                                                   "preview_id": native_preview["preview_id"], "preview_digest": native_preview["preview_digest"]})["grant"]
                        call(origin, token, NATIVE_ROUTE, {"action": "start", "project_id": project_id, "grant_id": grant["id"]})
                        status = None
                        for _ in range(300):
                            status = call(origin, token, NATIVE_ROUTE, {"action": "status", "project_id": project_id, "grant_id": grant["id"]})
                            if status["grant"]["status"] != "running":
                                break
                            time.sleep(.1)
                        assert status and status["grant"]["status"] == "completed", safe(json.dumps(status))
                        assert not model.errors, safe(model.errors)

                        log("assert the typed result receipt and service-derived provenance")
                        receipt = status.get("result")
                        assert receipt and receipt.get("availability") == "available", safe(json.dumps(receipt))
                        assert receipt["text"].find(ANSWER_TOKEN) >= 0, safe(receipt["text"])
                        assert receipt["hermes_completed"] is True
                        assert receipt["recipient"]["pane_id"] == helper.PANE
                        assert receipt["recipient"]["profile_id"] == "default"
                        assert receipt["recipient"]["session_id"] == session
                        execution = call(origin, token, EXEC_ROUTE, {"action": "execution_state", "project_id": project_id})
                        job_provenance = [job.get("provenance", {}).get("initiated_by", {}).get("kind") for job in execution["jobs"]]
                        assert job_provenance and all(kind == "native_agent" for kind in job_provenance), job_provenance
                        assert all(entry["verdict"] == "pass" for entry in execution["evidence"]), execution["evidence"]

                        before_messages = page.locator('.pane[data-pane-id="%s"] .chat-messages .chat-message' % helper.PANE).count()
                        before_requests = len(model.requests)
                        log("deliver the result to its originating conversation; no model call is allowed")
                        card_receipt = call(origin, token, NATIVE_ROUTE, {"action": "result_deliver", "project_id": project_id, "result_id": receipt["id"],
                                                                          "pane_id": receipt["recipient"]["pane_id"], "profile_id": receipt["recipient"]["profile_id"],
                                                                          "session_id": receipt["recipient"]["session_id"], "op_id": str(uuid.uuid4())})
                        assert card_receipt.get("card") or card_receipt.get("id"), safe(json.dumps(card_receipt))
                        cards = wait_card(page, helper.PANE)
                        card = cards.filter(has=page.locator('pre.workbench-result-text')).first
                        expect(card.locator("summary")).to_have_text(CARD_SUMMARY, timeout=20000)
                        expect(card.locator("pre.workbench-result-text")).to_contain_text(ANSWER_TOKEN, timeout=20000)
                        assert len(model.requests) == before_requests, "delivering a host card must not call the model"
                        after_messages = page.locator('.pane[data-pane-id="%s"] .chat-messages .chat-message' % helper.PANE).count()
                        assert after_messages == before_messages, "a host card must not insert a chat turn"
                        assert not page_errors, page_errors

                        log("reload: the host card persists and no model call is repeated")
                        page.reload()
                        expect(page.locator('.pane[data-pane-id="%s"]' % helper.PANE)).to_be_visible(timeout=20000)
                        page.get_by_role("button", name="Connect local host", exact=True).click()
                        page.get_by_role("textbox", name="Host session token").fill(token)
                        page.get_by_role("button", name="Unlock local host", exact=True).click()
                        assert ("?renderer=docking" in page.url) == (renderer == "docking"), page.url
                        wait_renderer(page, renderer)
                        reloaded = wait_card(page, helper.PANE)
                        expect(reloaded.locator("pre.workbench-result-text").first).to_contain_text(ANSWER_TOKEN, timeout=20000)
                        assert len(model.requests) == before_requests, "reload must not re-run the model"
                        reloaded_messages = page.locator('.pane[data-pane-id="%s"] .chat-messages .chat-message' % helper.PANE).count()
                        assert reloaded_messages == before_messages, "reload must not add a chat turn"
                        assert (project / "math.js").read_text() == WRONG, "the original project is never edited"
                        assert not page_errors, page_errors
                    finally:
                        if page_errors:
                            page.screenshot(path="/tmp/opencode/comet-results-%s-error.png" % renderer, full_page=True)
                    log(json.dumps({"renderer": renderer, "renderer_actual": (renderer_info or {}).get("renderer", "default"), "result_delivered": True, "card_persisted": True,
                                    "model_requests": len(model.requests), "chat_messages": before_messages,
                                    "provenance": job_provenance, "page_errors": len(page_errors)}))
                    Path(log_path).with_suffix(".json").write_text(json.dumps({"renderer": renderer, "renderer_actual": (renderer_info or {}).get("renderer", "default"), "ok": True}, indent=2))
        finally:
            if server and server.poll() is None:
                server.terminate()
                try:
                    server.wait(timeout=10)
                except subprocess.TimeoutExpired:
                    server.kill()
    print("\n".join(lines))


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--renderer", choices=("default", "docking"), required=True)
    main(parser.parse_args().renderer)
