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
import hashlib
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
WORKFLOW_ROUTE = "/api/workbench/workflow"
WRONG = "export const sum = (a,b) => a - b;\n"
RIGHT = "export const sum = (a,b) => a + b;\n"
ANSWER_TOKEN = "FLASH-NORMAL-UI-EXPLANATION"
UNRELATED = "UNRELATED-SENTINEL-KEEP\n"
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

        project = root / "project"; project.mkdir(); (project / "math.js").write_text(WRONG); (project / "unrelated.txt").write_text(UNRELATED)
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
                        chat_messages_before = page.locator('.pane[data-pane-id="%s"] .chat-messages .chat-message' % helper.PANE).count()
                        requests_before_delivery = len(model.requests)
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
                        assert len(model.requests) == requests_before_delivery, "delivery must not call the model"
                        assert page.locator('.pane[data-pane-id="%s"] .chat-messages .chat-message' % helper.PANE).count() == chat_messages_before, "delivery must not add a chat turn"

                        step = "Gate 2: owner review of the recorded pass through the UI"
                        passing_id = next(entry["id"] for entry in state_body["evidence"] if entry["verdict"] == "pass")
                        with page.expect_response(lambda r: r.url.split("?")[0] == origin + EXEC_ROUTE
                                                  and post_json(r.request).get("action") == "execution_state", timeout=30000):
                            pane.locator("button").filter(has_text=re.compile("^Refresh execution workbench$")).first.click()
                        checkbox = pane.locator("label", has_text="Passing evidence " + passing_id).locator("input[type=checkbox]")
                        expect(checkbox).to_be_visible(timeout=20000)
                        checkbox.check()
                        review = click_text(pane.locator(".workbench-execution-review"), "Approve", "review_decide")["review"]
                        assert review["decision"] == "approved" and passing_id in review["evidence_ids"], review

                        step = "Gate 2: reviewed patch preview, export and download through the UI"
                        click_plain(workbench, "Refresh project inspection")
                        select = pane.get_by_label("Approved candidate and review")
                        expect(select.locator("option")).not_to_have_count(0, timeout=30000)
                        select.select_option(value="%s:%s:%s" % (candidate["id"], review["id"], task["id"]))
                        jobs_before_preview = helper.api(origin, token, EXEC_ROUTE, {"action": "execution_state", "project_id": project_id})[1]["jobs"]
                        patch_preview = click_text(pane, "Preview reviewed patch", "patch_preview", WORKFLOW_ROUTE)
                        assert patch_preview["format"] == "git-unified-diff", patch_preview
                        assert patch_preview["roundtrip"]["verified"] is True, patch_preview["roundtrip"]
                        assert any(change["path"] == "math.js" for change in patch_preview["changes"]), patch_preview["changes"]
                        assert len(helper.api(origin, token, EXEC_ROUTE, {"action": "execution_state", "project_id": project_id})[1]["jobs"]) == len(jobs_before_preview), "patch preview must not execute checks"
                        exported = click_text(pane, "Create private verified patch", "patch_export", WORKFLOW_ROUTE)["patch"]
                        assert exported["status"] == "available", exported
                        assert exported["roundtrip"]["verified"] is True, exported["roundtrip"]
                        with page.expect_download(timeout=30000) as download_info:
                            click_plain(pane, "Retrieve private patch")
                        patch_file = Path(download_info.value.path())
                        patch_bytes = patch_file.read_bytes()
                        assert b"--- a/math.js" in patch_bytes and b"+++ b/math.js" in patch_bytes, patch_bytes[:200]

                        step = "Gate 2: apply the downloaded patch to a safe exact base and run an independent check"
                        base = root / ("exact-base-" + secrets.token_hex(4)); base.mkdir()
                        (base / "math.js").write_text(WRONG); (base / "unrelated.txt").write_text(UNRELATED)
                        git_env = {"PATH": os.environ["PATH"], "HOME": str(root / "home"), "GIT_CONFIG_NOSYSTEM": "1", "GIT_CONFIG_GLOBAL": "/dev/null"}
                        subprocess.run(["git", "init", "-q"], cwd=base, env=git_env, check=True)
                        subprocess.run(["git", "add", "math.js", "unrelated.txt"], cwd=base, env=git_env, check=True)
                        subprocess.run(["git", "-c", "user.email=fixture@example.invalid", "-c", "user.name=Fixture", "commit", "-q", "-m", "exact base"], cwd=base, env=git_env, check=True)
                        (base / "change.patch").write_bytes(patch_bytes)
                        subprocess.run(["git", "apply", "--whitespace=nowarn", "change.patch"], cwd=base, env=git_env, check=True)
                        assert (base / "math.js").read_text() == RIGHT, (base / "math.js").read_text()
                        assert (base / "unrelated.txt").read_text() == UNRELATED, "an unrelated file in the exact base is untouched by the patch"
                        (base / "independent-check.mjs").write_text("import { sum } from './math.js';\nif (sum(2, 3) !== 5) { console.error('independent check failed'); process.exit(1); }\n")
                        subprocess.run([shutil.which("node"), "independent-check.mjs"], cwd=base, env={"PATH": os.environ["PATH"], "HOME": str(root / "home")}, check=True)
                        assert (project / "math.js").read_text() == WRONG, "the original project is never modified"
                        assert (project / "unrelated.txt").read_text() == UNRELATED, "an unrelated original file is never modified"

                        step = "Gate 2: reload preserves the result, review and workspace identity"
                        ws_before = helper.api(origin, token, "/api/workspace", {"action": "read"})[1]["state"]
                        pane_ids_before = [monitor["layout"]["pane"]["id"] for monitor in ws_before["monitors"]]
                        requests_before_reload = len(model.requests)
                        page.reload()
                        expect(page.locator('.pane[data-pane-id="%s"]' % helper.PANE)).to_be_visible(timeout=20000)
                        page.get_by_role("button", name="Connect local host", exact=True).click()
                        page.get_by_role("textbox", name="Host session token").fill(token)
                        page.get_by_role("button", name="Unlock local host", exact=True).click()
                        expect(page.locator(".saved")).to_contain_text("Workspace connected", timeout=15000)
                        expect(page.locator('.pane[data-pane-id="%s"] section.agent-task-results details[data-result-id]' % helper.PANE).first).to_be_visible(timeout=20000)
                        persisted = helper.api(origin, token, EXEC_ROUTE, {"action": "execution_state", "project_id": project_id})[1]
                        assert any(item["decision"] == "approved" for item in persisted["reviews"]), persisted["reviews"]
                        ws_after = helper.api(origin, token, "/api/workspace", {"action": "read"})[1]["state"]
                        assert [monitor["layout"]["pane"]["id"] for monitor in ws_after["monitors"]] == pane_ids_before, "workspace pane identity is preserved across reload (single-pane fixture here; multi-pane continuity is covered by runtime-continuity and Luna L4)"
                        renderer_after = page.evaluate("() => window.__orbitDocking ? window.__orbitDocking.renderer : 'default'")
                        assert renderer_after == renderer, ("renderer after reload", renderer, renderer_after)
                        assert len(model.requests) == requests_before_reload, "reload must not call the model"
                        assert page.locator('.pane[data-pane-id="%s"] .chat-messages .chat-message' % helper.PANE).count() == chat_messages_before, "reload must not add a chat turn"
                        assert (project / "math.js").read_text() == WRONG
                        assert (project / "unrelated.txt").read_text() == UNRELATED

                        if os.environ.get("GATE2_FINAL") == "1":
                            step = "Gate 2 FINAL: exact hashes, required definitions, durable re-retrieval, no check spawn"
                            execution = helper.api(origin, token, EXEC_ROUTE, {"action": "execution_state", "project_id": project_id})[1]
                            task_row = next(entry for entry in execution["tasks"] if entry["id"] == task["id"])
                            required_defs = [check["definition_id"] for check in task_row["acceptance"]["required_checks"]]
                            verification = exported.get("verification") or {}
                            assert verification.get("status") == "verified", verification
                            assert verification.get("artifact_hash") == exported.get("artifact_hash"), verification
                            assert hashlib.sha256(patch_bytes).hexdigest() == exported["artifact_hash"], "downloaded bytes must hash to the exported artifact hash"
                            results = verification.get("results") or []
                            assert [result.get("definition_id") for result in results] == required_defs, (required_defs, results)
                            for result in results:
                                assert result.get("verdict") == "pass", result
                                assert isinstance(result.get("artifact_hash"), str) and len(result["artifact_hash"]) == 64, result
                                assert isinstance(result.get("definition_digest"), str) and len(result["definition_digest"]) == 64, result
                            jobs_after_export = helper.api(origin, token, EXEC_ROUTE, {"action": "execution_state", "project_id": project_id})[1]["jobs"]
                            exported_id = exported.get("artifact_id") or exported.get("id")
                            listed_status, listed = helper.api(origin, token, WORKFLOW_ROUTE, {"action": "patch_list", "project_id": project_id})
                            assert listed_status == 200 and listed.get("ok") is True, (listed_status, listed)
                            patches = listed.get("patches") or []
                            match = next((item for item in patches if (item.get("artifact_id") or item.get("id")) == exported_id), None)
                            assert match, ("the exported artifact must appear in patch_list", exported_id, patches)
                            assert match.get("verification_status") == "verified", match
                            assert match.get("artifact_hash") == exported["artifact_hash"], match
                            artifact_id = match.get("artifact_id") or match.get("id")
                            get_status, get_body = helper.api(origin, token, WORKFLOW_ROUTE, {"action": "private_patch_get", "artifact_id": artifact_id, "project_id": project_id})
                            assert get_status == 200 and get_body.get("ok") is True, (get_status, get_body)
                            again = get_body["patch"]
                            assert again == patch_bytes.decode("utf-8"), "re-retrieved artifact bytes must match the downloaded bytes"
                            jobs_final = helper.api(origin, token, EXEC_ROUTE, {"action": "execution_state", "project_id": project_id})[1]["jobs"]
                            assert len(jobs_final) == len(jobs_after_export), "re-retrieval must not spawn a new check"
                            log_extra = {"gate2_final": True, "gate2_verification_status": verification.get("status"), "gate2_required_definitions": required_defs, "gate2_patch_list": True}
                        else:
                            log_extra = {"gate2_final": False}

                        assert not page_errors, page_errors
                        log(json.dumps({"renderer": renderer, "renderer_actual": (renderer_info or {}).get("renderer", "default"),
                                        "ui_handoff": True, "ui_result_panel": True, "gate2_patch_roundtrip": True,
                                        "gate2_independent_apply_check": True, "gate2_reload_persisted": True,
                                        **log_extra,
                                        "model_requests": len(model.requests), "chat_messages": chat_messages_before,
                                        "page_errors": len(page_errors), "admitted_live_model_trials": 0}))
                    finally:
                        if page_errors:
                            page.screenshot(path="/tmp/opencode/comet-results-ui-%s-error.png" % renderer, full_page=True,
                                            mask=[page.get_by_role("textbox", name="Host session token")])
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
