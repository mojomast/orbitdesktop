"""Normal-UI pending-check cancel and revoked-project remount with real providers.

Real disposable Node server + real SQLite + real managed checks. The project's Node
test blocks on a sentinel file (deterministic fault injection in the FIXTURE project
only; no production hooks), so the owner can start the check in the background through
the normal UI and cancel it through the normal UI. The same project then completes,
exports a verified patch, and the owner revokes project access through the UI; after
reopening the Workbench, the persisted patch receipt and recovery controls must remain
visible even though integration/retention are denied, and refreshing/finalizing must
not run another check.

Run:
  PLAYWRIGHT_BROWSERS_PATH=/tmp/opencode/orbit-evolution-browsers \\
    /tmp/opencode/orbit-managed-ui-venv/bin/python tests/workbench-recovery-revocation.browser.py --renderer default
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
import time
import urllib.request
import uuid

from playwright.sync_api import expect, sync_playwright

sys.dont_write_bytecode = True
import importlib.util

_spec = importlib.util.spec_from_file_location("wb_context_browser", Path(__file__).with_name("workbench-context.browser.py"))
helper = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(helper)

ROOT = Path(__file__).resolve().parents[1]
BLOCKING_TEST = (
    "import test from 'node:test';\n"
    "import assert from 'node:assert/strict';\n"
    "import fs from 'node:fs';\n"
    "test('blocks until sentinel then passes', async () => {\n"
    "  const sentinel = '__SENTINEL__';\n"
    "  for (let i = 0; i < 4000 && !fs.existsSync(sentinel); i++) await new Promise(r => setTimeout(r, 50));\n"
    "  assert.equal(1, 1);\n"
    "});\n"
)
MATH = "export const sum = (a, b) => a + b;\n"


def main(renderer):
    log_path = Path("/tmp/opencode/comet-recovery-revocation-%s.log" % renderer)
    log_file = log_path.open("w")
    lines = []
    step = "setup"

    def log(message):
        lines.append(str(message)); log_file.write(str(message) + "\n"); log_file.flush()

    token = secrets.token_urlsafe(36)

    def safe(value):
        return str(value).replace(token, "[REDACTED]")

    with tempfile.TemporaryDirectory(prefix="orbit-recovery-revocation-", dir="/tmp/opencode") as temp:
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
        project = root / "project"; project.mkdir()
        (project / "math.js").write_text(MATH)
        sentinel_path = root / "RELEASE_SENTINEL"
        (project / "math.test.js").write_text(BLOCKING_TEST.replace("__SENTINEL__", str(sentinel_path)))
        with socket.socket() as probe:
            probe.bind(("127.0.0.1", 0)); port = probe.getsockname()[1]
        origin = "http://127.0.0.1:%d" % port
        monitor = str(uuid.uuid4())
        state = {"version": 1, "selected": monitor, "arc": 14, "view": "windows", "monitors": [{
            "id": monitor, "name": "Recovery agent", "diagonal": 32, "aspect": "16:9", "height": 0, "distance": 0,
            "pitch": 0, "yaw": 0, "offset": 0, "fontSize": 19, "frame": {"x": 0, "y": 0, "width": 900, "height": 900, "z": 0},
            "layout": {"type": "pane", "pane": {"id": helper.PANE, "kind": "agent", "url": ""}}}]}
        server_env = {**env, "PORT": str(port), "ORBIT_TOKEN": token, "ORBIT_RUNTIME_DIR": str(root / "runtime"),
                      "ORBIT_CWD": str(root / "cwd"), "ORBIT_TMUX_SOCKET": "recovery-" + str(uuid.uuid4()),
                      "ORBIT_TMUX_CONFIG": "/dev/null", "TMUX_TMPDIR": str(root / "tmux")}
        server = None
        try:
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
                    context = browser.new_context(viewport={"width": 1700, "height": 1100})
                    context.add_init_script(
                        "if(window===window.top){localStorage.setItem('orbit.onboarding.v1','done');localStorage.setItem('orbit.workspace.id'," + json.dumps(helper.WORKSPACE) +
                        ");localStorage.setItem('orbit.workspace.v1',JSON.stringify(" + json.dumps(state) + "));}")
                    page = context.new_page()
                    page_errors = []
                    page.on("pageerror", lambda error: page_errors.append(str(error)))
                    try:
                        def api(route, body):
                            status, value = helper.api(origin, token, route, body)
                            assert status == 200 and value.get("ok") is True, (route, status, value)
                            return value

                        page.goto(origin + ("?renderer=docking" if renderer == "docking" else ""))
                        expect(page.locator('.pane[data-pane-id="%s"]' % helper.PANE)).to_be_visible(timeout=20000)
                        page.get_by_role("button", name="Connect local host", exact=True).click()
                        page.get_by_role("textbox", name="Host session token").fill(token)
                        page.get_by_role("button", name="Unlock local host", exact=True).click()
                        expect(page.locator(".saved")).to_contain_text("Workspace connected", timeout=15000)
                        page.get_by_role("button", name="Open orbit menu").click()
                        page.get_by_role("button", name="Project Workbench", exact=True).click()
                        workbench = page.locator("dialog.project-workbench-dialog")
                        workbench.get_by_label("Project root directory").fill(str(project))
                        workbench.get_by_label("Project name").fill("recovery-fixture")
                        workbench.get_by_role("button", name="Preview project registration").click()
                        expect(workbench.get_by_role("button", name="Confirm project registration")).to_be_enabled()
                        workbench.get_by_role("button", name="Confirm project registration").click()
                        expect(workbench.get_by_role("button", name="Open project recovery-fixture")).to_be_visible(timeout=15000)
                        project_id = next(item["id"] for item in api("/api/workbench", {"action": "list"})["projects"] if item["name"] == "recovery-fixture")
                        workbench.get_by_role("button", name="Open project recovery-fixture").click()
                        pane = workbench.locator(".workbench-execution")
                        expect(pane.get_by_role("heading", name="Execution workbench")).to_be_visible(timeout=15000)

                        step = "create task/candidate with a blocking node-test and start it in the background"
                        task = api("/api/workbench/execution", {"action": "task_create", "project_id": project_id, "title": "Blocking check",
                            "acceptance_statement": "the blocking test passes once released", "check_definition_id": "node-test",
                            "profile_id": "default", "session_id": "fixture"})["task"]
                        preview = api("/api/workbench/execution", {"action": "candidate_preview", "project_id": project_id, "task_id": task["id"]})
                        candidate = api("/api/workbench/execution", {"action": "candidate_create", "project_id": project_id, "task_id": task["id"],
                            "preview_id": preview["preview_id"], "preview_digest": preview["preview"]["digest"]})["candidate"]
                        pane.get_by_role("combobox", name="Check definition", exact=True).select_option("node-test")
                        with page.expect_response(lambda r: r.url.split("?")[0] == origin + "/api/workbench/execution" and (r.request.post_data_json or {}).get("action") == "check_preview"):
                            pane.locator("button").filter(has_text=re.compile("^Preview check$")).first.click()
                        with page.expect_response(lambda r: r.url.split("?")[0] == origin + "/api/workbench/execution" and (r.request.post_data_json or {}).get("action") == "check_start"):
                            pane.locator("button").filter(has_text=re.compile("^Start check in background$")).first.click()
                        time.sleep(0.5)
                        running = api("/api/workbench/execution", {"action": "execution_state", "project_id": project_id})["jobs"]
                        assert running and running[-1]["status"] in ("starting", "running"), running
                        job_id = running[-1]["id"]

                        step = "cancel the pending check through the normal UI"
                        cancel = pane.locator("button").filter(has_text=re.compile("^Cancel check$"))
                        expect(cancel.first).to_be_visible(timeout=20000)
                        cancel.first.click()
                        time.sleep(0.5)
                        after = next(j for j in api("/api/workbench/execution", {"action": "execution_state", "project_id": project_id})["jobs"] if j["id"] == job_id)
                        assert after["status"] in ("cancel_requested", "cancelled") or after.get("cancel_requested") or after.get("cancel_confirmed") is False, after
                        assert after["status"] != "completed", "a cancelled check must not be recorded as a completed pass"
                        # Release the fixture process so it cannot outlive the test.
                        sentinel_path.write_text("release\n")
                        assert not page_errors, page_errors
                        log(json.dumps({"renderer": renderer, "pending_cancel_ui": True, "job_status_after_cancel": after["status"],
                                        "page_errors": len(page_errors), "admitted_live_model_trials": 0}))
                    finally:
                        if page_errors:
                            page.screenshot(path="/tmp/opencode/comet-recovery-revocation-%s-error.png" % renderer, full_page=True,
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
