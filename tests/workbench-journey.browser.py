"""Joined owner execution/context journey: real Node/SQLite, local synthetic Hermes."""

import argparse
import ast
import hashlib
import importlib.util
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

from playwright.sync_api import expect, sync_playwright

# Import the shared fixture without executing main or writing checkout bytecode.
sys.dont_write_bytecode = True
spec = importlib.util.spec_from_file_location(
    "wb_context_browser", Path(__file__).with_name("workbench-context.browser.py"))
helper = importlib.util.module_from_spec(spec)
spec.loader.exec_module(helper)
ROOT = Path(__file__).resolve().parents[1]
WRONG = "export const sum = (a,b) => a - b;\n"
RIGHT = "export const sum = (a,b) => a + b;\n"
PROPOSAL = "Patch proposal (text only): replace a - b with a + b in math.js.\n" + RIGHT
GATEWAY_KEY = "fixture-synthetic-not-real"


class PatchHandler(helper.SyntheticHandler):
    def do_GET(self):
        if self.path.startswith("/v1/runs/"):
            self.server.gets.append(self.path)
            payload = json.loads(self.server.posts[0][0])
            return self.reply({"run_id": self.path.rsplit("/", 1)[1],
                               "session_id": payload["session_id"],
                               "status": "completed", "output": PROPOSAL})
        return super().do_GET()


def main(renderer):
    tree = ast.parse(Path(__file__).read_text(), feature_version=(3, 11))
    assert not any(isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute)
                   and node.func.attr in ("route", "route_from_har") for node in ast.walk(tree))
    token = secrets.token_urlsafe(36)

    def safe(value):
        return str(value).replace(token, "[REDACTED]").replace(GATEWAY_KEY, "[SYNTHETIC_KEY]")

    with tempfile.TemporaryDirectory(prefix="orbit-workbench-journey-", dir="/tmp/opencode") as temp:
        root = Path(temp)
        for name in ("server", "src", "contracts", "docs", "public"):
            shutil.copytree(ROOT / name, root / name)
        for name in ("index.html", "package.json", "tsconfig.json", "vite.config.js"):
            shutil.copy2(ROOT / name, root / name)
        (root / "node_modules").symlink_to(ROOT / "node_modules", target_is_directory=True)
        for name in ("runtime", "home", "cwd", "tmux", "project", "second-project"):
            (root / name).mkdir()
        env = {"HOME": str(root / "home"), "PATH": os.environ["PATH"],
               "npm_config_cache": str(root / ".npm")}
        helper.run(shutil.which("npm"), "run", "build", cwd=root, env=env)
        assert (root / "dist/index.html").is_file()
        project = root / "project"
        (project / "math.js").write_text(WRONG)
        (project / "package.json").write_text('{"type":"module"}')
        git_env = {**env, "GIT_CONFIG_NOSYSTEM": "1", "GIT_CONFIG_GLOBAL": "/dev/null"}
        helper.run("git", "init", cwd=project, env=git_env)
        helper.run("git", "add", "math.js", "package.json", cwd=project, env=git_env)
        helper.run("git", "-c", "user.email=fixture@example.invalid", "-c", "user.name=Fixture",
                   "commit", "-m", "initial", cwd=project, env=git_env)
        with socket.socket() as probe:
            probe.bind(("127.0.0.1", 0))
            port = probe.getsockname()[1]
        origin = f"http://127.0.0.1:{port}"
        session = "orbit-" + str(uuid.uuid4())
        gateway = helper.SyntheticGateway()
        gateway.RequestHandlerClass = PatchHandler
        thread = threading.Thread(target=gateway.serve_forever, daemon=True)
        thread.start()
        server = None
        try:
            server_env = {**env, "PORT": str(port), "ORBIT_TOKEN": token,
                "ORBIT_RUNTIME_DIR": str(root / "runtime"), "ORBIT_CWD": str(root / "cwd"),
                "ORBIT_TMUX_SOCKET": "journey-" + str(uuid.uuid4()), "ORBIT_TMUX_CONFIG": "/dev/null",
                "TMUX_TMPDIR": str(root / "tmux"),
                "HERMES_API_URL": f"http://127.0.0.1:{gateway.server_port}", "HERMES_API_KEY": GATEWAY_KEY}
            monitor = str(uuid.uuid4())
            state = {"version": 1, "selected": monitor, "arc": 14, "view": "windows", "monitors": [{
                "id": monitor, "name": "Journey agent", "diagonal": 32, "aspect": "16:9",
                "height": 0, "distance": 0, "pitch": 0, "yaw": 0, "offset": 0, "fontSize": 19,
                "frame": {"x": 0, "y": 0, "width": 900, "height": 900, "z": 0},
                "layout": {"type": "pane", "pane": {"id": helper.PANE, "kind": "agent", "url": ""}}}]}
            with (root / "server.log").open("w+") as log:
                server = subprocess.Popen([shutil.which("node"), "--experimental-strip-types", "server/index.mjs"],
                                          cwd=root, env=server_env, stdout=log, stderr=log)
                for _ in range(200):
                    if server.poll() is not None:
                        log.seek(0)
                        raise RuntimeError(safe(log.read()))
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
                    context.add_init_script("if(window===window.top){localStorage.setItem('orbit.workspace.id'," +
                        json.dumps(helper.WORKSPACE) + ");localStorage.setItem('orbit.workspace.v1',JSON.stringify(" +
                        json.dumps(state) + "));sessionStorage.setItem('orbit-hermes-chat:" + helper.PANE +
                        "',JSON.stringify(" + json.dumps(chat) + "));}")
                    page = context.new_page()
                    page_errors, terminals, responses, api_responses, external = [], [], [], [], []
                    step = "connect"
                    page.on("pageerror", lambda error: page_errors.append(str(error)))

                    def request_seen(request):
                        if "/api/terminal" in request.url:
                            terminals.append(request.url)
                        if request.url.startswith(("http://", "https://")) and not request.url.startswith(origin + "/"):
                            external.append(request.url)

                    page.on("request", request_seen)
                    page.on("websocket", lambda ws: terminals.append(ws.url) if "/api/terminal" in ws.url else None)

                    def record(response):
                        if response.url in [origin + path for path in (
                                "/api/workbench", "/api/workbench/execution", "/api/workbench/context")]:
                            responses.append((response.request.post_data_json, response.status, response.json()))

                    page.on("response", record)

                    def result(action):
                        matches = [(status, body) for request, status, body in responses if request.get("action") == action]
                        assert matches, ("Missing response", action)
                        status, body = matches[-1]
                        assert status == 200 and body.get("ok") is True, (action, status, body)
                        return body

                    def click(scope, label, action, route="/api/workbench/execution"):
                        with page.expect_response(lambda response: response.url == origin + route
                                                  and response.request.post_data_json.get("action") == action):
                            scope.locator("button").filter(has_text=re.compile("^" + re.escape(label) + "$" )).click()
                        return result(action)

                    def click_accessible(scope, name, action, route="/api/workbench/execution"):
                        # dom.button sets aria-label to the descriptive title while the
                        # visible text stays short (for example visible "math.js" but
                        # accessible "Read candidate file math.js"), so match the name.
                        with page.expect_response(lambda response: response.url == origin + route
                                                  and response.request.post_data_json.get("action") == action):
                            scope.get_by_role("button", name=name, exact=True).click()
                        return result(action)

                    def api(route, action, **fields):
                        status, body = helper.api(origin, token, route, {"action": action, **fields})
                        api_responses.append({"action": action, "status": status, "code": body.get("code")})
                        return status, body

                    def ok_api(route, action, **fields):
                        status, body = api(route, action, **fields)
                        assert status == 200 and body.get("ok") is True, (action, status, body)
                        return body

                    execution_route = "/api/workbench/execution"
                    context_route = "/api/workbench/context"
                    try:
                        page.goto(origin + ("?renderer=docking" if renderer == "docking" else ""), wait_until="domcontentloaded")
                        expect(page.locator('dialog.orbit-onboarding')).to_be_visible()
                        page.keyboard.press("Escape")
                        expect(page.locator('dialog.orbit-onboarding')).not_to_be_visible()
                        page.get_by_role("button", name="Connect local host", exact=True).click()
                        page.get_by_role("textbox", name="Host session token").fill(token)
                        page.get_by_role("button", name="Unlock local host", exact=True).click()
                        expect(page.locator(".saved")).to_contain_text("Workspace connected", timeout=15000)
                        status, bound = api("/api/agent", "shared_chat", pane_id=helper.PANE,
                                            session_id=session, profile_id="default", initial=chat)
                        assert status == 200, (status, bound)
                        step = "register and create owner task/candidate"
                        page.get_by_role("button", name="Open orbit menu").click()
                        page.get_by_role("button", name="Project Workbench", exact=True).click()
                        workbench = page.locator("dialog.project-workbench-dialog")
                        workbench.get_by_label("Project root directory").fill(str(project))
                        workbench.get_by_label("Project name").fill("journey-fixture")
                        workbench.get_by_role("button", name="Preview project registration").click()
                        expect(workbench.get_by_role("button", name="Confirm project registration")).to_be_enabled()
                        workbench.get_by_role("button", name="Confirm project registration").click()
                        expect(workbench.get_by_role("button", name="Open project journey-fixture")).to_be_visible()
                        project_id = result("register_commit")["project"]["id"]
                        workbench.get_by_role("button", name="Open project journey-fixture").click()
                        pane = workbench.locator(".workbench-execution")
                        expect(pane.get_by_role("heading", name="Execution workbench")).to_be_visible()
                        expect(pane.locator(".workbench-execution-status")).to_contain_text("Execution:")
                        pane.get_by_role("textbox", name="Task title").fill("Repair sum with explicit owner patch")
                        pane.get_by_role("textbox", name="Acceptance statement").fill("sum(2,3)===5")
                        pane.get_by_role("combobox", name="Task check definition").select_option("host-regression")
                        pane.get_by_role("textbox", name="Recipient profile ID").fill("default")
                        pane.get_by_role("textbox", name="Recipient session ID").fill(session)
                        task = click(pane, "Create task", "task_create")["task"]
                        preview = click(pane, "Preview candidate", "candidate_preview")
                        assert any(file["path"] == "math.js" for file in preview["preview"]["base"]["files"])
                        candidate = click(pane, "Create candidate", "candidate_create")["candidate"]
                        click_accessible(pane, "Read candidate file math.js", "candidate_read")
                        edit = pane.get_by_role("textbox", name="Candidate file edit")
                        expect(edit).to_have_value(WRONG)
                        attempt = ok_api(execution_route, "attempt_create", project_id=project_id,
                            task_id=task["id"], candidate_id=candidate["id"], profile_id="default",
                            session_id=session, pane_id=helper.PANE)["attempt"]
                        step = "real failing check"
                        pane.get_by_role("combobox", name="Check definition", exact=True).select_option("host-regression")
                        click(pane, "Preview check", "check_preview")
                        failed_run = click(pane, "Run check", "check_run")
                        failed = failed_run["evidence"]
                        assert failed["verdict"] == "fail" and failed["exit_code"] != 0, failed
                        expect(pane.locator(".workbench-execution-jobs")).to_contain_text(failed["id"])
                        step = "job context capture and preview"
                        pane.locator("button").filter(has_text=re.compile("^Ask agent about this job$")).click()
                        dialog = page.locator("dialog.workbench-context-dialog")
                        expect(dialog).to_be_visible()
                        recipient = dialog.get_by_label("Agent recipient", exact=True)
                        expect(recipient.locator("option").first).to_be_attached()
                        recipient.select_option(index=0)
                        dialog.get_by_label("Task/attempt link").select_option(value=attempt["id"])
                        capture = click(dialog, "Capture context", "capture", context_route)
                        expect(dialog.locator(".workbench-context-status")).to_contain_text("metadata captured")
                        source = capture["context"]["source"]
                        assert source == {"kind": "job", "job_id": failed["job_id"]}, source
                        preview = click(dialog, "Preview for selected recipient", "preview", context_route)
                        text = dialog.get_by_role("textbox", name="Exact context preview text (read-only)")
                        expect(text).to_have_value(preview["text"])
                        reviewed_text = text.input_value()
                        assert text.get_attribute("readonly") is not None
                        assert reviewed_text and len(reviewed_text.encode()) <= 65536
                        assert preview["recipient"]["session_id"] == session
                        assert preview["recipient"]["profile_id"] == "default"
                        # host-regression on wrong arithmetic exits 1 with no console
                        # text; the captured bounded context is the recorder's job/
                        # evidence summary, which must reflect the real measured result.
                        assert "verdict=fail" in reviewed_text, reviewed_text
                        assert failed["job_id"] in reviewed_text, reviewed_text
                        assert failed["candidate_hash_before"] in reviewed_text, reviewed_text
                        for output in (failed["stdout_preview"], failed["stderr_preview"]):
                            if output:
                                assert output in reviewed_text, "Recorded check output missing from preview"
                        step = "approve and share exact context once"
                        click(dialog, "Approve", "approve", context_route)
                        expect(dialog.locator(".workbench-context-approval")).to_contain_text("Single-use, expiring")
                        share = click(dialog, "Share once", "share", context_route)
                        expect(dialog.locator(".workbench-context-outcome")).to_contain_text("run_synthetic_fixture_0001")
                        expect(dialog.get_by_text("Share once", exact=True)).to_be_disabled()
                        assert len(gateway.posts) == 1
                        raw, headers = gateway.posts[0]
                        payload = json.loads(raw)
                        assert payload["input"].count(reviewed_text) == 1
                        assert headers["Authorization"] == "Bearer " + GATEWAY_KEY
                        step = "dispatch reference envelope identities"
                        envelope = re.search(r"Included references[^\n]*?: (\{[^\n]*\})", payload["input"])
                        assert envelope, "Missing Included references envelope"
                        references = json.loads(envelope.group(1))
                        expected_refs = {"project_id": project_id, "task_id": task["id"],
                                         "attempt_id": attempt["id"], "candidate_id": candidate["id"]}
                        assert all(references.get(key) == value for key, value in expected_refs.items()), (references, expected_refs)
                        databases = list((root / "runtime").rglob("workspace.sqlite"))
                        assert len(databases) == 1
                        with sqlite3.connect(f"file:{databases[0]}?mode=ro", uri=True) as db:
                            stored = json.loads(db.execute("SELECT record_json FROM wb_submissions WHERE id=?",
                                (share["submission"]["id"],)).fetchone()[0])
                        assert stored["payload"] == payload
                        assert stored["payload_hash"] == hashlib.sha256(raw).hexdigest()
                        step = "read agent text proposal and explicit owner edit"
                        expect(dialog.get_by_text("Stop agent run (jobs are not cancelled)", exact=True)).to_be_visible()
                        click(dialog, "Check status", "status", context_route)
                        response_text = dialog.get_by_role("textbox", name="Agent response (read-only)")
                        expect(response_text).to_have_value(PROPOSAL)
                        assert response_text.get_attribute("readonly") is not None
                        expect(pane).to_contain_text("tool: agent_tool_blocked")
                        dialog.get_by_text("Close", exact=True).click()
                        before = candidate
                        edit.fill(RIGHT)
                        updated = click(pane, "Save edit", "candidate_edit")
                        candidate = updated["candidate"]
                        assert candidate["generation"] > before["generation"] and candidate["hash"] != before["hash"]
                        assert failed["id"] in updated["superseded_evidence_ids"]
                        step = "passing check and exact owner review identity"
                        click(pane, "Preview check", "check_preview")
                        passed_run = click(pane, "Run check", "check_run")
                        passed = passed_run["evidence"]
                        assert passed["verdict"] == "pass" and passed["exit_code"] == 0, passed
                        assert passed["candidate_hash_before"] == passed["candidate_hash_after"] == candidate["hash"]
                        assert (project / "math.js").read_text() == WRONG
                        pane.get_by_role("checkbox", name=f"Passing evidence {passed['id']}").check()
                        expected_identity = ok_api(execution_route, "execution_state", project_id=project_id)["review_identity"][candidate["id"]]
                        review = click(pane.locator(".workbench-execution-review"), "Approve", "review_decide")["review"]
                        assert review["decision"] == "approved" and passed["id"] in review["evidence_ids"]
                        assert review["review_identity"] == expected_identity
                        expect(pane.locator(".workbench-execution-review")).to_contain_text(review["id"])
                        step = "cross-project job spoof denied"
                        registration = ok_api("/api/workbench", "register_preview", root=str(root / "second-project"), name="second")
                        second = ok_api("/api/workbench", "register_commit", approval_id=registration["approval_id"])["project"]
                        status, denied = api(context_route, "capture", project_id=second["id"], source=source)
                        assert status >= 400 and denied["code"] == "permission_denied", (status, denied)
                        step = "candidate changed after pass makes review stale"
                        edit.fill(RIGHT + "// Owner changed candidate after approval.\n")
                        click(pane, "Save edit", "candidate_edit")
                        status, denied = api(execution_route, "review_decide", project_id=project_id,
                            candidate_id=candidate["id"], evidence_ids=[passed["id"]], decision="approved",
                            expected_identity=expected_identity)
                        assert status >= 400 and denied["code"] == "stale_resource", (status, denied)
                        step = "completed check cancellation is separate from Stop agent"
                        expect(pane.locator("button").filter(has_text=re.compile("^Cancel check$"))).to_have_count(0)
                        job = ok_api(execution_route, "job_get", project_id=project_id, job_id=passed["job_id"])["job"]
                        status, denied = api(execution_route, "check_cancel", project_id=project_id,
                            job_id=job["id"], expected_pid=job["pid"], expected_started_at=job["process_start"])
                        assert status >= 400 and denied["code"] == "stale_resource", (status, denied)
                        assert (project / "math.js").read_text() == WRONG
                        assert (project / "package.json").read_text() == '{"type":"module"}'
                        assert not page_errors, page_errors
                        assert not terminals, terminals
                        assert not external, external
                        assert len(gateway.posts) == 1
                        print(safe(f"PASS: renderer={renderer} Chromium={browser.version} gateway_posts={len(gateway.posts)} "
                            "page_errors=0 terminal_connections=0 check_verdicts=fail,pass reference_ids=project,task,attempt,candidate "
                            "real_Node_SQLite=true gateway=SYNTHETIC_NOT_REAL_HERMES"))
                    except Exception:
                        print(safe(f"FAIL: renderer={renderer} step={step}"), flush=True)
                        print(safe(traceback.format_exc()), flush=True)
                        print(safe("Last browser responses: " + json.dumps([
                            {"action": request.get("action"), "status": status, "code": body.get("code"), "ok": body.get("ok")}
                            for request, status, body in responses[-12:]])), flush=True)
                        print(safe("Owner API responses: " + json.dumps(api_responses)), flush=True)
                        print(safe(f"Gateway posts={len(gateway.posts)} gets={gateway.gets} stops={gateway.stops}"), flush=True)
                        for raw, _ in gateway.posts:
                            payload = json.loads(raw)
                            print(safe("Gateway payload: " + json.dumps(payload)), flush=True)
                        print(safe(f"page_errors={page_errors} terminal_connections={terminals} external_requests={external}"), flush=True)
                        page.screenshot(path=f"/tmp/opencode/orbit-workbench-journey-{renderer}.png", full_page=True,
                                        mask=[page.get_by_role("textbox", name="Host session token")])
                        return False
                    finally:
                        context.close()
                        browser.close()
        except Exception:
            print(safe(traceback.format_exc()), flush=True)
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
            thread.join(timeout=5)
    return True


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--renderer", choices=("default", "docking"), required=True)
    sys.exit(0 if main(parser.parse_args().renderer) else 1)
