"""Chromium + real Node/SQLite; SYNTHETIC local gateway, never real Hermes."""

import argparse
import ast
import hashlib
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from pathlib import Path
import secrets
import shutil
import socket
import sqlite3
import subprocess
import tempfile
import threading
import time
import urllib.error
import urllib.request
import uuid

from playwright.sync_api import expect, sync_playwright

ROOT = Path(__file__).resolve().parents[1]
WORKSPACE = "a345639c-42bb-41d0-94da-f9d9abb8fd41"
PANE = "74977184-cbe1-4622-9fae-7ed32e531347"
INITIAL = "def sum_items(items):\n    total = sum(items)\n    return total\n"
SELECTED = "    total = sum(items)\n    return total + 1"


def run(*args, cwd, env):
    return subprocess.run(args, cwd=cwd, env=env, check=True, text=True, capture_output=True)


class SyntheticGateway(ThreadingHTTPServer):
    """Only the upstream gateway is synthetic; Orbit routes are never intercepted."""

    def __init__(self):
        super().__init__(("127.0.0.1", 0), SyntheticHandler)
        self.posts, self.gets, self.stops = [], [], []
        self.fail_status = False


class SyntheticHandler(BaseHTTPRequestHandler):
    server_version = "SyntheticFixtureNotRealHermes/1"

    def log_message(self, *args):
        pass

    def reply(self, body, status=200):
        raw = json.dumps(body).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)

    def do_GET(self):
        self.server.gets.append(self.path)
        if self.path == "/v1/capabilities":
            return self.reply({"version": "1", "features": {
                "session_continuation": False, "idempotent_submit": False}})
        if self.path.startswith("/api/sessions/") and self.path.endswith("/messages"):
            return self.reply({"data": []})
        if self.path.startswith("/v1/runs/"):
            if self.server.fail_status:
                return self.reply({"error": "synthetic status unavailable"}, 503)
            payload = json.loads(self.server.posts[0][0])
            return self.reply({"run_id": self.path.rsplit("/", 1)[1],
                               "session_id": payload["session_id"], "status": "completed",
                               "output": "synthetic agent reply\n"})
        self.reply({"error": "Unknown synthetic fixture endpoint"}, 404)

    def do_POST(self):
        raw = self.rfile.read(int(self.headers.get("Content-Length", 0)))
        if self.path == "/v1/runs":
            self.server.posts.append((raw, dict(self.headers)))
            return self.reply({"run_id": "run_synthetic_fixture_0001", "status": "running"})
        if self.path.startswith("/v1/runs/") and self.path.endswith("/stop"):
            self.server.stops.append(self.path)
            return self.reply({"status": "stopping"})
        self.reply({"error": "Unknown synthetic fixture endpoint"}, 404)


def api(origin, token, route, body):
    request = urllib.request.Request(origin + route,
        data=json.dumps({"workspace_id": WORKSPACE, **body}).encode(),
        headers={"Origin": origin, "Authorization": "Bearer " + token,
                 "Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(request, timeout=20) as response:
            return response.status, json.load(response)
    except urllib.error.HTTPError as error:
        return error.code, json.load(error)


def main(renderer):
    # No Playwright route handlers or copied source/route overlays are used.
    assert not any(isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute)
                   and node.func.attr in ("route", "route_from_har")
                   for node in ast.walk(ast.parse(Path(__file__).read_text())))
    with tempfile.TemporaryDirectory(prefix="orbit-context-browser-", dir="/tmp/opencode") as temp:
        root = Path(temp)
        for name in ("server", "src", "contracts", "docs", "public"):
            shutil.copytree(ROOT / name, root / name)
        for name in ("index.html", "package.json", "tsconfig.json", "vite.config.js"):
            shutil.copy2(ROOT / name, root / name)
        (root / "node_modules").symlink_to(ROOT / "node_modules", target_is_directory=True)
        for name in ("runtime", "home", "cwd", "tmux", "project"):
            (root / name).mkdir()
        env = {"HOME": str(root / "home"), "PATH": os.environ["PATH"], "npm_config_cache": str(root / ".npm")}
        run(shutil.which("node"), str(ROOT / "scripts/isolated_build.mjs"), "--source", str(root), "--dest", str(root / "dist"), cwd=root, env=env)
        assert (root / "dist/index.html").is_file()
        project = root / "project"
        git_env = {**env, "GIT_CONFIG_NOSYSTEM": "1", "GIT_CONFIG_GLOBAL": "/dev/null"}
        run("git", "init", cwd=project, env=git_env)
        (project / "app.py").write_text(INITIAL)
        run("git", "add", "app.py", cwd=project, env=git_env)
        run("git", "-c", "user.email=fixture@example.invalid", "-c", "user.name=Synthetic Fixture",
            "commit", "-m", "initial", cwd=project, env=git_env)
        (project / "app.py").write_text(INITIAL.replace("return total", "return total + 1"))
        with socket.socket() as probe:
            probe.bind(("127.0.0.1", 0))
            port = probe.getsockname()[1]
        origin = f"http://127.0.0.1:{port}"
        token = secrets.token_urlsafe(36)
        session = "orbit-" + str(uuid.uuid4())
        gateway = SyntheticGateway()
        thread = threading.Thread(target=gateway.serve_forever, name="SYNTHETIC-not-real-Hermes", daemon=True)
        thread.start()
        server_env = {**env, "PORT": str(port), "ORBIT_TOKEN": token,
            "ORBIT_RUNTIME_DIR": str(root / "runtime"), "ORBIT_CWD": str(root / "cwd"),
            "ORBIT_TMUX_SOCKET": "context-" + str(uuid.uuid4()), "ORBIT_TMUX_CONFIG": "/dev/null",
            "TMUX_TMPDIR": str(root / "tmux"),
            "HERMES_API_URL": f"http://127.0.0.1:{gateway.server_port}",
            "HERMES_API_KEY": "fixture-synthetic-not-real"}
        state = {"version": 1, "selected": str(uuid.uuid4()), "arc": 14, "view": "windows", "monitors": []}
        state["monitors"].append({"id": state["selected"], "name": "Synthetic fixture agent", "diagonal": 32,
            "aspect": "16:9", "height": 0, "distance": 0, "pitch": 0, "yaw": 0, "offset": 0,
            "fontSize": 19, "frame": {"x": 0, "y": 0, "width": 900, "height": 900, "z": 0},
            "layout": {"type": "pane", "pane": {"id": PANE, "kind": "agent", "url": ""}}})
        with (root / "server.log").open("w+") as log:
            server = subprocess.Popen([shutil.which("node"), "--experimental-strip-types", "server/index.mjs"],
                                      cwd=root, env=server_env, stdout=log, stderr=log)
            try:
                for _ in range(200):
                    if server.poll() is not None:
                        log.seek(0)
                        raise RuntimeError(log.read().replace(token, "[REDACTED]"))
                    try:
                        with urllib.request.urlopen(origin + "/api/health", timeout=1):
                            break
                    except OSError:
                        time.sleep(.05)
                else:
                    raise RuntimeError("Disposable server readiness timeout")
                with sync_playwright() as playwright:
                    browser = playwright.chromium.launch(headless=True)
                    context = browser.new_context(viewport={"width": 1600, "height": 1100},
                                                  permissions=["clipboard-read", "clipboard-write"])
                    chat = {"session": session, "profile_id": "default", "messages": []}
                    context.add_init_script("if(window===window.top){localStorage.setItem('orbit.workspace.id'," +
                        json.dumps(WORKSPACE) + ");localStorage.setItem('orbit.workspace.v1',JSON.stringify(" + json.dumps(state) + "));" +
                        "sessionStorage.setItem('orbit-hermes-chat:" + PANE + "',JSON.stringify(" + json.dumps(chat) + "));}")
                    page = context.new_page()
                    errors, responses, terminals = [], [], []
                    page.on("pageerror", lambda error: errors.append(str(error)))
                    page.on("request", lambda request: terminals.append(request.url) if "/api/terminal" in request.url else None)
                    page.on("websocket", lambda ws: terminals.append(ws.url) if "/api/terminal" in ws.url else None)

                    def record(response):
                        if response.url in (origin + "/api/workbench", origin + "/api/workbench/context"):
                            responses.append((response.request.post_data_json, response.status, response.json()))

                    page.on("response", record)

                    def result(action):
                        matches = [(status, body) for request, status, body in responses if request.get("action") == action]
                        assert matches, (action, responses)
                        status, body = matches[-1]
                        assert status == 200 and body.get("ok") is True, (action, status, body)
                        return body

                    try:
                        page.goto(origin + ("?renderer=docking" if renderer == "docking" else ""), wait_until="domcontentloaded")
                        expect(page.locator('dialog.orbit-onboarding')).to_be_visible()
                        page.keyboard.press("Escape")
                        expect(page.locator('dialog.orbit-onboarding')).not_to_be_visible()
                        page.get_by_role("button", name="Connect local host", exact=True).click()
                        page.get_by_role("textbox", name="Host session token").fill(token)
                        with page.expect_response(lambda response: response.url == origin + '/api/agent' and response.request.post_data_json.get('action') == 'shared_chat') as binding:
                            page.get_by_role("button", name="Unlock local host", exact=True).click()
                        expect(page.locator(".saved")).to_contain_text("Workspace connected", timeout=15000)
                        bound = binding.value.json()
                        assert binding.value.status == 200 and bound['state']['session'] == session, bound
                        page.get_by_role("button", name="Open orbit menu").click()
                        page.get_by_role("button", name="Project Workbench", exact=True).click()
                        workbench = page.locator("dialog.project-workbench-dialog")
                        expect(workbench.locator(".workbench-status")).to_contain_text("projects")
                        workbench.get_by_label("Project root directory").fill(str(project))
                        workbench.get_by_label("Project name").fill("synthetic-context-project")
                        workbench.get_by_role("button", name="Preview project registration").click()
                        expect(workbench.get_by_role("button", name="Confirm project registration")).to_be_enabled()
                        workbench.get_by_role("button", name="Confirm project registration").click()
                        expect(workbench.get_by_role("button", name="Open project synthetic-context-project")).to_be_visible()
                        project_id = result("register_commit")["project"]["id"]
                        workbench.get_by_role("button", name="Open project synthetic-context-project").click()
                        expect(workbench.locator(".workbench-status")).to_contain_text("Inspected synthetic-context-project")
                        workbench.get_by_role("button", name="Open file app.py").click()
                        expect(workbench.get_by_role("textbox", name="Project file text")).to_have_value(INITIAL.replace("return total", "return total + 1"))
                        workbench.get_by_label("Selection start line").fill("2")
                        workbench.get_by_label("Selection end line").fill("3")
                        workbench.get_by_role("button", name="Highlight selected lines").click()
                        workbench.get_by_role("button", name="Ask agent about this", exact=True).click()
                        dialog = page.locator("dialog.workbench-context-dialog")
                        expect(dialog.get_by_label("Agent recipient", exact=True).locator("option")).to_have_count(1)
                        dialog.get_by_label("Agent recipient", exact=True).select_option(index=0)
                        dialog.get_by_text("Capture context", exact=True).click()
                        expect(dialog.locator(".workbench-context-status")).to_contain_text("metadata captured")
                        capture = result("capture")
                        assert "text" not in capture["context"]["snapshot"]
                        dialog.get_by_text("Preview for selected recipient", exact=True).click()
                        preview_text = dialog.get_by_role("textbox", name="Exact context preview text (read-only)")
                        expect(preview_text).to_have_value(SELECTED)
                        assert preview_text.get_attribute("readonly") is not None
                        preview = result("preview")
                        assert preview["text"] == SELECTED and preview["recipient"]["session_id"] == session
                        dialog.get_by_text("Approve", exact=True).click()
                        expect(dialog.locator(".workbench-context-approval")).to_contain_text("Single-use, expiring")
                        approval = result("approve")
                        with page.expect_response(lambda response: response.url == origin + "/api/workbench/context"
                                                  and response.request.post_data_json.get("action") == "share"):
                            dialog.get_by_text("Share once", exact=True).click()
                        share = result("share")
                        expect(dialog.locator(".workbench-context-outcome")).to_contain_text("run_synthetic_fixture_0001")
                        expect(dialog.get_by_text("Share once", exact=True)).to_be_disabled()
                        assert len(gateway.posts) == 1
                        raw, headers = gateway.posts[0]
                        payload = json.loads(raw)
                        assert payload["input"].count(preview["text"]) == 1
                        assert payload["conversation_history"] == []
                        assert headers["Authorization"] == "Bearer fixture-synthetic-not-real"
                        # Read the live real SQLite read-only, including its WAL.
                        databases = list((root / "runtime").rglob("workspace.sqlite"))
                        assert len(databases) == 1, databases
                        with sqlite3.connect(f"file:{databases[0]}?mode=ro", uri=True) as db:
                            stored = json.loads(db.execute("SELECT record_json FROM wb_submissions WHERE id=?", (share["submission"]["id"],)).fetchone()[0])
                            snapshot = json.loads(db.execute("SELECT record_json FROM wb_contexts WHERE id=?", (capture["context"]["id"],)).fetchone()[0])
                            durable_payload = db.execute("SELECT json_extract(record_json, '$.payload') FROM wb_submissions WHERE id=?", (stored["id"],)).fetchone()[0]
                        assert durable_payload.encode() == raw
                        assert stored["payload"] == payload and stored["input"] == payload["input"]
                        assert stored["payload_hash"] == hashlib.sha256(raw).hexdigest()
                        assert snapshot["snapshot"]["text"] == preview["text"]

                        def context_api(action, **fields):
                            return api(origin, token, "/api/workbench/context", {"action": action, "project_id": project_id, **fields})

                        # Consumed approval: real second API request cannot issue another POST.
                        status, denied = context_api("share", preview_id=preview["preview_id"], approval_id=approval["approval_id"])
                        assert status >= 400 and denied["code"] in ("expired", "permission_denied"), (status, denied)
                        assert len(gateway.posts) == 1
                        # Unknown live status then reconciliation: a status outage, not an
                        # ambiguous initial submission. Neither operation may resend bytes.
                        gateway.fail_status = True
                        dialog.get_by_text("Check status", exact=True).click()
                        expect(dialog.locator(".workbench-context-outcome")).to_contain_text("No context was re-sent")
                        unavailable = result("status")
                        assert unavailable["output_released"] is False
                        assert unavailable["submission"]["state"] == "dispatched"
                        status, reconciled = context_api("reconcile")
                        assert status == 200 and reconciled["ok"] is True, (status, reconciled)
                        assert len(gateway.posts) == 1
                        gateway.fail_status = False
                        dialog.get_by_text("Check status", exact=True).click()
                        response_text = dialog.get_by_role("textbox", name="Agent response (read-only)")
                        expect(response_text).to_have_value("synthetic agent reply\n")
                        assert response_text.get_attribute("readonly") is not None
                        dialog.get_by_text("Copy response", exact=True).click()
                        assert page.evaluate("navigator.clipboard.readText()") == "synthetic agent reply\n"
                        dialog.get_by_text("Close", exact=True).click()
                        page.once("dialog", lambda confirmation: confirmation.accept())
                        workbench.get_by_role("button", name="Revoke project access", exact=True).click()
                        expect(workbench.locator(".workbench-status")).to_contain_text("Future project reads are blocked")
                        workbench.get_by_role("button", name="Activity and disclosures", exact=True).click()
                        activity = page.locator("dialog.workbench-activity-dialog")
                        expect(activity.get_by_label("Disclosure", exact=True).locator("option")).to_have_count(1)
                        activity.get_by_text("Check status", exact=True).click()
                        expect(activity.locator(".workbench-context-details")).to_contain_text(share["disclosure"]["id"])
                        expect(activity.locator(".workbench-context-withheld")).to_be_visible()
                        expect(activity.get_by_text("Stop agent run (jobs are not cancelled)", exact=True)).to_be_enabled()
                        # Activity metadata and stop remain usable after revocation.
                        status, history = context_api("list")
                        assert status == 200 and history["disclosures"][0]["id"] == share["disclosure"]["id"]
                        assert "text" not in history["contexts"][0]["snapshot"]
                        activity.get_by_text("Stop agent run (jobs are not cancelled)", exact=True).click()
                        expect(activity.locator(".workbench-context-status")).to_contain_text("Stop requested")
                        assert result("stop")["stop_requested"] is True
                        assert len(gateway.stops) == 1
                        status, withheld = context_api("status", disclosure_id=share["disclosure"]["id"])
                        assert status == 200 and withheld["output_released"] is False and not withheld["output"]
                        expect(activity.locator(".workbench-context-response")).to_have_value("")
                        source = next(request["source"] for request, _, _ in responses if request.get("action") == "capture")
                        status, denied = context_api("capture", source=source)
                        assert status == 403 and denied["code"] == "permission_denied", (status, denied)
                        status, denied = context_api("share", preview_id=preview["preview_id"], approval_id=approval["approval_id"])
                        assert status == 403 and denied["code"] == "permission_denied", (status, denied)
                        assert len(gateway.posts) == 1
                        assert not errors, errors
                        assert not terminals, terminals
                        print(f"PASS: renderer={renderer} Chromium={browser.version} synthetic_gateway_posts={len(gateway.posts)} "
                              f"browser_api_responses={len(responses)} stop_requests={len(gateway.stops)} "
                              f"terminal_connections={len(terminals)} page_errors={len(errors)} "
                              "real_Node_API=true real_SQLite=true gateway=SYNTHETIC_NOT_REAL_HERMES")
                    except Exception:
                        print(f"Synthetic gateway: run_posts={len(gateway.posts)} gets={gateway.gets} stops={len(gateway.stops)}")
                        print("Last browser API responses:", json.dumps([
                            {"action": request.get("action"), "status": status,
                             "ok": body.get("ok"), "code": body.get("code")}
                            for request, status, body in responses[-5:]]).replace(token, "[REDACTED]"))
                        page.screenshot(path=f"/tmp/opencode/orbit-workbench-context-{renderer}.png", full_page=True,
                                        mask=[page.get_by_role("textbox", name="Host session token")])
                        raise
                    finally:
                        context.close()
                        browser.close()
            finally:
                server.terminate()
                try:
                    server.wait(timeout=10)
                except subprocess.TimeoutExpired:
                    server.kill()
                    server.wait()
                gateway.shutdown()
                gateway.server_close()
                thread.join(timeout=5)


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--renderer", choices=("default", "docking"), required=True)
    main(parser.parse_args().renderer)
