"""Normal-UI Gate 1: a human drives the existing authority controls to a delivered,
reviewable task result. RED until Luna's result review panel (L1) is merged.

This fixture uses the normal UI for task/candidate/attempt creation, the exact worker
handoff, native consent approve/start, and Return result. It never calls the API for
approve/start/result_deliver; the API is used only for independent status/evidence
reads and (optionally) initial project registration setup.

Run (both renderers):
  PLAYWRIGHT_BROWSERS_PATH=/tmp/opencode/orbit-evolution-browsers \\
    /tmp/opencode/orbit-managed-ui-venv/bin/python tests/workbench-results-ui.browser.py --renderer default
"""

import argparse
import json
import os
from pathlib import Path
import re
import secrets
import shutil
import socket
import subprocess
import sys
import tempfile
import threading
import time
import urllib.request
import uuid

from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from playwright.sync_api import expect, sync_playwright

sys.dont_write_bytecode = True
import importlib.util

_spec = importlib.util.spec_from_file_location("wb_context_browser", Path(__file__).with_name("workbench-context.browser.py"))
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
ANSWER_TOKEN = "FLASH-NORMAL-UI-EXPLANATION"
HANDOFF_SENTENCE = "Supervised worker handoff"


class ModelHandler(BaseHTTPRequestHandler):
    server_version = "DeterministicLocalModelFixture/1"

    def log_message(self, *args):
        pass

    def _send(self, body, status=200, content_type="application/json"):
        raw = body if isinstance(body, bytes) else json.dumps(body).encode()
        self.send_response(status); self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(raw))); self.end_headers(); self.wfile.write(raw)

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
            evidence = (results[4].get("result", {}) or {}).get("evidence") or []
            ref = " see evidence:%s" % evidence[0]["id"] if evidence else ""
            message = {"role": "assistant", "content": "%s: repaired the failing sum.%s" % (ANSWER_TOKEN, ref)}
        else:
            args = self.server.next_args(results)
            message = {"role": "assistant", "content": None, "tool_calls": [{
                "id": "call_%d" % step, "type": "function",
                "function": {"name": "orbit_workbench", "arguments": json.dumps(args)}}]}
        completion = {"id": "fixture", "object": "chat.completion", "created": 1, "model": "orbit-local-fixture",
                      "choices": [{"index": 0, "message": message, "finish_reason": "tool_calls" if "tool_calls" in message else "stop"}],
                      "usage": {"prompt_tokens": 10, "completion_tokens": 10, "total_tokens": 20}}
        if body.get("stream"):
            delta = json.loads(json.dumps(message))
            if delta.get("tool_calls"):
                delta["tool_calls"][0]["index"] = 0
            chunks = [
                {"id": "fixture", "object": "chat.completion.chunk", "created": 1, "model": "orbit-local-fixture", "choices": [{"index": 0, "delta": delta, "finish_reason": None}]},
                {"id": "fixture", "object": "chat.completion.chunk", "created": 1, "model": "orbit-local-fixture", "choices": [{"index": 0, "delta": {}, "finish_reason": completion["choices"][0]["finish_reason"]}]},
            ]
            return self._send(("".join("data: " + json.dumps(chunk) + "\n\n" for chunk in chunks) + "data: [DONE]\n\n").encode(), content_type="text/event-stream")
        self._send(completion)


class ModelFixture(ThreadingHTTPServer):
    daemon_threads = True
    finish_step = 5

    def __init__(self):
        super().__init__(("127.0.0.1", 0), ModelHandler)
        self.requests, self.errors = [], []

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


def main(renderer):
    log_path = Path("/tmp/opencode/comet-results-ui-%s.log" % renderer)
    log_file = log_path.open("w")
    lines = []
    step = "setup"

    def log(message):
        lines.append(str(message)); log_file.write(str(message) + "\n"); log_file.flush()

    assert HERMES_SOURCE.is_dir(), "Pinned Hermes source missing"
    head = subprocess.check_output(["git", "-C", str(HERMES_SOURCE), "rev-parse", "HEAD"], text=True).strip()
    assert head == HERMES_PIN, head
    token = secrets.token_urlsafe(36)

    def safe(value):
        return str(value).replace(token, "[REDACTED]").replace(GATEWAY_KEY, "[SYNTHETIC_KEY]")

    with tempfile.TemporaryDirectory(prefix="orbit-results-ui-", dir="/tmp/opencode") as temp:
        root = Path(temp)
        for name in ("server", "src", "contracts", "docs", "public", "hermes-plugin", "scripts"):
            shutil.copytree(ROOT / name, root / name)
        for name in ("index.html", "package.json", "tsconfig.json", "vite.config.js"):
            shutil.copy2(ROOT / name, root / name)
        (root / "node_modules").symlink_to(ROOT / "node_modules", target_is_directory=True)
        for name in ("runtime", "home", "cwd", "tmux"):
            (root / name).mkdir()
        env = {"HOME": str(root / "home"), "PATH": os.environ["PATH"], "npm_config_cache": str(root / ".npm")}
        helper.run(shutil.which("node"), str(ROOT / "scripts/isolated_build.mjs"), "--source", str(root),
                   "--dest", str(root / "dist"), "--allow-source-dist", cwd=root, env=env)
        assert (root / "dist/index.html").is_file()

        project = root / "project"; project.mkdir(); (project / "math.js").write_text(WRONG)
        model = ModelFixture(); threading.Thread(target=model.serve_forever, daemon=True).start()
        model_url = "http://127.0.0.1:%d/v1" % model.server_port
        gateway = helper.SyntheticGateway(); threading.Thread(target=gateway.serve_forever, daemon=True).start()
        with socket.socket() as probe:
            probe.bind(("127.0.0.1", 0)); port = probe.getsockname()[1]
        origin = "http://127.0.0.1:%d" % port
        session = "orbit-" + str(uuid.uuid4())
        server = None
        try:
            monitor = str(uuid.uuid4())
            state = {"version": 1, "selected": monitor, "arc": 14, "view": "windows", "monitors": [{
                "id": monitor, "name": "Result UI agent", "diagonal": 32, "aspect": "16:9", "height": 0, "distance": 0,
                "pitch": 0, "yaw": 0, "offset": 0, "fontSize": 19, "frame": {"x": 0, "y": 0, "width": 900, "height": 900, "z": 0},
                "layout": {"type": "pane", "pane": {"id": helper.PANE, "kind": "agent", "url": ""}}}]}
            server_env = {**env, "PORT": str(port), "ORBIT_TOKEN": token, "ORBIT_RUNTIME_DIR": str(root / "runtime"),
                          "ORBIT_CWD": str(root / "cwd"), "ORBIT_TMUX_SOCKET": "results-ui-" + str(uuid.uuid4()),
                          "ORBIT_TMUX_CONFIG": "/dev/null", "TMUX_TMPDIR": str(root / "tmux"),
                          "HERMES_API_URL": "http://127.0.0.1:%d" % gateway.server_port, "HERMES_API_KEY": GATEWAY_KEY,
                          "ORBIT_NATIVE_HERMES_SOURCE": str(HERMES_SOURCE),
                          "ORBIT_NATIVE_HERMES_PYTHON": str(HERMES_SOURCE / ".venv/bin/python"),
                          "ORBIT_NATIVE_HERMES_MODEL_URL": model_url, "ORBIT_NATIVE_HERMES_PROFILE": "default",
                          "ORBIT_NATIVE_HERMES_MODEL": "orbit-local-fixture"}
            with (root / "server.log").open("w+") as server_log:
                server = subprocess.Popen([shutil.which("node"), "--experimental-strip-types", "server/index.mjs"],
                                          cwd=root, env=server_env, stdout=server_log, stderr=server_log)
                for _ in range(400):
                    if server.poll() is not None:
                        server_log.seek(0); raise RuntimeError(safe(server_log.read()))
                    try:
                        with urllib.request.urlopen(origin + "/api/health", timeout=1): break
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
                        ");localStorage.setItem('orbit.workspace.v1',JSON.stringify(" + json.dumps(state) + "));sessionStorage.setItem('orbit-hermes-chat:" + helper.PANE + "',JSON.stringify(" + json.dumps(chat) + "));}")
                    page = context.new_page()
                    page_errors, responses = [], []
                    page.on("pageerror", lambda error: page_errors.append(str(error)))
                    page.on("response", lambda response: responses.append((response.request, response.status, response)))
                    try:
                        def post_json(request):
                            try:
                                return request.post_data_json or {}
                            except Exception:
                                return {}

                        def api_result(action, route):
                            for request, status, response in reversed(responses):
                                if request.url.split("?")[0] == origin + route and post_json(request).get("action") == action:
                                    body = response.json()
                                    assert status == 200 and body.get("ok") is True, (action, status, body)
                                    return body
                            raise AssertionError("Missing %s response on %s" % (action, route))

                        def click_text(scope, label, action, route=EXEC_ROUTE, timeout=30000):
                            with page.expect_response(lambda r: r.url.split("?")[0] == origin + route
                                                      and post_json(r.request).get("action") == action, timeout=timeout):
                                scope.locator("button").filter(has_text=re.compile("^" + re.escape(label) + "$")).first.click(timeout=timeout)
                            return api_result(action, route)

                        def click_plain(scope, label):
                            scope.locator("button").filter(has_text=re.compile("^" + re.escape(label) + "$")).first.click()

                        step = "unlock and connect"
                        page.goto(origin + ("?renderer=docking" if renderer == "docking" else ""))
                        expect(page.locator('.pane[data-pane-id="%s"]' % helper.PANE)).to_be_visible(timeout=20000)
                        page.get_by_role("button", name="Connect local host", exact=True).click()
                        page.get_by_role("textbox", name="Host session token").fill(token)
                        page.get_by_role("button", name="Unlock local host", exact=True).click()
                        expect(page.locator(".saved")).to_contain_text("Workspace connected", timeout=15000)
                        renderer_info = page.evaluate("() => window.__orbitDocking ? {renderer: window.__orbitDocking.renderer, supported: window.__orbitDocking.supported} : null")
                        assert (renderer_info or {}).get("renderer", "default") == renderer, ("renderer", renderer, renderer_info)
                        if renderer == "docking":
                            assert renderer_info.get("supported") is True, renderer_info

                        step = "register project and open workbench"
                        page.get_by_role("button", name="Open orbit menu").click()
                        page.get_by_role("button", name="Project Workbench", exact=True).click()
                        workbench = page.locator("dialog.project-workbench-dialog")
                        workbench.get_by_label("Project root directory").fill(str(project))
                        workbench.get_by_label("Project name").fill("result-ui-fixture")
                        workbench.get_by_role("button", name="Preview project registration").click()
                        expect(workbench.get_by_role("button", name="Confirm project registration")).to_be_enabled()
                        workbench.get_by_role("button", name="Confirm project registration").click()
                        expect(workbench.get_by_role("button", name="Open project result-ui-fixture")).to_be_visible(timeout=15000)
                        project_id = api_result("register_commit", WORKBENCH_ROUTE)["project"]["id"]
                        workbench.get_by_role("button", name="Open project result-ui-fixture").click()
                        pane = workbench.locator(".workbench-execution")
                        expect(pane.get_by_role("heading", name="Execution workbench")).to_be_visible(timeout=15000)

                        step = "owner creates task/candidate and bound attempt through the UI"
                        pane.get_by_role("textbox", name="Task title").fill("Repair sum via normal UI")
                        pane.get_by_role("textbox", name="Acceptance statement").fill("sum(2,3)===5")
                        pane.get_by_role("combobox", name="Task check definition").select_option("host-regression")
                        pane.get_by_role("textbox", name="Recipient profile ID").fill("default")
                        pane.get_by_role("textbox", name="Recipient session ID").fill(session)
                        task = click_text(pane, "Create task", "task_create")["task"]
                        click_text(pane, "Preview candidate", "candidate_preview")
                        candidate = click_text(pane, "Create candidate", "candidate_create")["candidate"]
                        click_plain(pane, "Refresh task authority")
                        pane.get_by_label("Authority candidate").select_option(value=candidate["id"])
                        pane.get_by_label("Native agent recipient").select_option(index=0)
                        attempt = click_text(pane, "Create bound attempt", "attempt_create")["attempt"]

                        step = "supervised worker handoff visible before approval"
                        click_plain(pane, "Refresh task authority")
                        pane.get_by_label("Native task attempt").first.select_option(value=attempt["id"])
                        consent = click_text(pane, "Preview native task consent", "preview", NATIVE_ROUTE)
                        assert consent["preview"]["attempt_id"] == attempt["id"], consent
                        budget = consent["preview"]["budget"]
                        assert budget["calls"] >= 1 and budget["checks"] >= 1 and budget["duration_ms"] >= 1000, budget
                        handoff = pane.locator(".workbench-worker-handoff")
                        expect(handoff).to_be_visible(timeout=15000)
                        expect(handoff).to_contain_text("Supervised worker handoff")
                        expect(handoff).to_contain_text("Start a supervised worker for this task. It receives the approved task packet, not the whole conversation.")
                        expect(handoff).to_contain_text(task["title"])
                        expect(handoff).to_contain_text(candidate["id"])
                        expect(handoff).to_contain_text("Recipient and model policy")
                        expect(handoff).to_contain_text("profile default")
                        expect(handoff).to_contain_text("Budget:")
                        expect(handoff).to_contain_text("Required check definitions: host-regression")

                        step = "native consent approve/start via UI"
                        approve = click_text(pane, "Approve native task consent", "approve", NATIVE_ROUTE)
                        assert approve["grant"]["status"] == "approved", approve
                        grant_id = approve["grant"]["id"]
                        with page.expect_response(lambda r: r.url.split("?")[0] == origin + NATIVE_ROUTE
                                                  and post_json(r.request).get("action") == "start"):
                            pane.locator("button").filter(has_text=re.compile("^Start native Hermes attempt$")).first.click()
                        started = api_result("start", NATIVE_ROUTE)
                        assert started["grant"]["status"] == "running", started
                        status = started
                        for _ in range(180):
                            status = click_text(pane, "Read native attempt status", "status", NATIVE_ROUTE)
                            if status["grant"]["status"] != "running":
                                break
                            time.sleep(0.25)
                        assert status["grant"]["status"] == "completed", status["grant"]

                        step = "independent evidence read (API) for the delivered result"
                        # The UI drives approve/start/Return result; the API is only read
                        # here for an independent verdict assertion.
                        state_status, state_body = helper.api(origin, token, EXEC_ROUTE, {"action": "execution_state", "project_id": project_id})
                        assert state_body.get("ok") is True, state_body
                        assert any(entry["verdict"] == "pass" for entry in state_body["evidence"]), state_body["evidence"]

                        step = "normal-UI result panel: refresh then select the issued grant"
                        panel = pane.locator(".workbench-task-results-panel")
                        expect(panel).to_be_visible(timeout=20000)
                        click_plain(panel, "Refresh task result")
                        grants = panel.get_by_label("Result native attempt")
                        expect(grants.locator('option[value="%s"]' % grant_id)).to_have_count(1, timeout=30000)
                        grants.select_option(value=grant_id)
                        expect(panel.get_by_role("heading", name="Agent explanation")).to_be_visible(timeout=20000)
                        expect(panel.locator(".workbench-result-text").first).to_contain_text(ANSWER_TOKEN, timeout=20000)
                        expect(panel).to_contain_text("Recorded checks")
                        expect(panel).to_contain_text("Human review")
                        expect(panel).to_contain_text("Supervised native worker")
                        expect(panel).to_contain_text("Check initiated by")
                        click_plain(panel, "Return result to originating conversation")
                        expect(panel).to_contain_text("Host-authored result card recorded")
                        card = page.locator('.pane[data-pane-id="%s"] section.agent-task-results details[data-result-id]' % helper.PANE)
                        expect(card.first).to_be_visible(timeout=20000)
                        assert not page_errors, page_errors
                        log(json.dumps({"renderer": renderer, "renderer_actual": (renderer_info or {}).get("renderer", "default"),
                                        "ui_handoff": True, "ui_result_panel": True, "model_requests": len(model.requests),
                                        "page_errors": len(page_errors)}))
                    finally:
                        if page_errors:
                            page.screenshot(path="/tmp/opencode/comet-results-ui-%s-error.png" % renderer, full_page=True)
        finally:
            if server and server.poll() is None:
                server.terminate()
                try:
                    server.wait(timeout=10)
                except subprocess.TimeoutExpired:
                    server.kill()
        print("\n".join(lines))
    log_file.close()


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--renderer", choices=("default", "docking"), required=True)
    main(parser.parse_args().renderer)
