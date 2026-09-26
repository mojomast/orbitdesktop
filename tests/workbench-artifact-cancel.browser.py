"""Normal-UI artifact verification cancel (the original busy-export boundary).

Real disposable Node server + real SQLite + real managed artifact verification. No
model is used. The frozen fixture test reads an ABSOLUTE sentinel OUTSIDE the project:
while the sentinel is absent the candidate check passes (owner review can approve);
once the sentinel is created, the artifact-verification check blocks, so the owner can
exercise the normal UI: export stays pending/busy, patch_list discovers a 'verifying'
receipt, and 'Request patch-check cancellation' cancels the real owned process without
producing an available artifact. Fixture-only injection; no production hooks.

Run (both renderers):
  PLAYWRIGHT_BROWSERS_PATH=/tmp/opencode/orbit-evolution-browsers \\
    /tmp/opencode/orbit-managed-ui-venv/bin/python tests/workbench-artifact-cancel.browser.py --renderer default
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
DELAY_TEST = (
    "import test from 'node:test';\n"
    "import assert from 'node:assert/strict';\n"
    "import fs from 'node:fs';\n"
    "test('passes unless the artifact sentinel exists', async () => {\n"
    "  const sentinel = '__SENTINEL__';\n"
    "  if (fs.existsSync(sentinel)) { for (let i = 0; i < 8000 && fs.existsSync(sentinel); i++) await new Promise(r => setTimeout(r, 50)); }\n"
    "  assert.equal(1, 1);\n"
    "});\n"
)
MATH = "export const sum = (a, b) => a + b;\n"


def main(renderer):
    log_path = Path("/tmp/opencode/comet-artifact-cancel-%s.log" % renderer)
    log_file = log_path.open("w")
    lines = []
    step = "setup"

    def log(message):
        lines.append(str(message)); log_file.write(str(message) + "\n"); log_file.flush()

    token = secrets.token_urlsafe(36)

    def safe(value):
        return str(value).replace(token, "[REDACTED]")

    with tempfile.TemporaryDirectory(prefix="orbit-artifact-cancel-", dir="/tmp/opencode") as temp:
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
        sentinel_path = root / "ARTIFACT_SENTINEL"
        project = root / "project"; project.mkdir()
        (project / "math.js").write_text(MATH)
        (project / "math.test.js").write_text(DELAY_TEST.replace("__SENTINEL__", str(sentinel_path)))
        with socket.socket() as probe:
            probe.bind(("127.0.0.1", 0)); port = probe.getsockname()[1]
        origin = "http://127.0.0.1:%d" % port
        monitor = str(uuid.uuid4())
        state = {"version": 1, "selected": monitor, "arc": 14, "view": "windows", "monitors": [{
            "id": monitor, "name": "Artifact cancel agent", "diagonal": 32, "aspect": "16:9", "height": 0, "distance": 0,
            "pitch": 0, "yaw": 0, "offset": 0, "fontSize": 19, "frame": {"x": 0, "y": 0, "width": 900, "height": 900, "z": 0},
            "layout": {"type": "pane", "pane": {"id": helper.PANE, "kind": "agent", "url": ""}}}]}
        server_env = {**env, "PORT": str(port), "ORBIT_TOKEN": token, "ORBIT_RUNTIME_DIR": str(root / "runtime"),
                      "ORBIT_CWD": str(root / "cwd"), "ORBIT_TMUX_SOCKET": "artifact-" + str(uuid.uuid4()),
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
                    page_errors, requests = [], []
                    page.on("pageerror", lambda error: page_errors.append(str(error)))
                    page.on("request", lambda request: requests.append(request.post_data_json) if request.url.split("?")[0] == origin + "/api/workbench/workflow" else None)
                    page.on("dialog", lambda dialog: dialog.accept())
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

                        step = "owner setup: passing candidate check and approved review (no model)"
                        workbench = None
                        page.get_by_role("button", name="Open orbit menu").click()
                        page.get_by_role("button", name="Project Workbench", exact=True).click()
                        workbench = page.locator("dialog.project-workbench-dialog")
                        workbench.get_by_label("Project root directory").fill(str(project))
                        workbench.get_by_label("Project name").fill("artifact-cancel-fixture")
                        workbench.get_by_role("button", name="Preview project registration").click()
                        expect(workbench.get_by_role("button", name="Confirm project registration")).to_be_enabled()
                        workbench.get_by_role("button", name="Confirm project registration").click()
                        expect(workbench.get_by_role("button", name="Open project artifact-cancel-fixture")).to_be_visible(timeout=15000)
                        project_id = next(item["id"] for item in api("/api/workbench", {"action": "list"})["projects"] if item["name"] == "artifact-cancel-fixture")
                        workbench.get_by_role("button", name="Open project artifact-cancel-fixture").click()
                        pane = workbench.locator(".workbench-execution")
                        expect(pane.get_by_role("heading", name="Execution workbench")).to_be_visible(timeout=15000)
                        task = api("/api/workbench/execution", {"action": "task_create", "project_id": project_id, "title": "Artifact cancel",
                            "acceptance_statement": "the artifact test passes while the sentinel is absent", "check_definition_id": "node-test",
                            "required_checks": [{"definition_id": "node-test"}],
                            "profile_id": "default", "session_id": "fixture"})["task"]
                        preview = api("/api/workbench/execution", {"action": "candidate_preview", "project_id": project_id, "task_id": task["id"]})
                        candidate = api("/api/workbench/execution", {"action": "candidate_create", "project_id": project_id, "task_id": task["id"],
                            "preview_id": preview["preview_id"], "preview_digest": preview["preview"]["digest"]})["candidate"]
                        candidate_file = api("/api/workbench/execution", {"action": "candidate_read", "project_id": project_id, "candidate_id": candidate["id"], "path": "math.js"})["file"]
                        api("/api/workbench/execution", {"action": "candidate_edit", "project_id": project_id, "candidate_id": candidate["id"],
                            "path": "math.js", "expected_hash": candidate_file["hash"], "content": MATH + "// artifact-cancel candidate edit\n"})
                        check = api("/api/workbench/execution", {"action": "check_preview", "project_id": project_id, "candidate_id": candidate["id"], "definition_id": "node-test"})
                        run = api("/api/workbench/execution", {"action": "check_run", "project_id": project_id, "candidate_id": candidate["id"],
                            "preview_id": check["preview_id"], "preview_digest": check["preview"]["spec_digest"], "op_id": str(uuid.uuid4())})
                        assert run["evidence"]["verdict"] == "pass", run["evidence"]
                        current = api("/api/workbench/execution", {"action": "candidate_get", "project_id": project_id, "candidate_id": candidate["id"]})
                        review = api("/api/workbench/execution", {"action": "review_decide", "project_id": project_id, "candidate_id": candidate["id"],
                            "evidence_ids": [run["evidence"]["id"]], "decision": "approved", "expected_identity": current["review_identity"]})["review"]

                        step = "patch preview succeeds with the sentinel absent (capture exact response)"
                        workbench.get_by_role("button", name="Refresh project inspection").click()
                        time.sleep(0.5)
                        select = pane.get_by_label("Approved candidate and review")
                        expect(select.locator("option")).not_to_have_count(0, timeout=30000)
                        select.select_option(value="%s:%s:%s" % (candidate["id"], review["id"], task["id"]))
                        with page.expect_response(lambda r: r.url.split("?")[0] == origin + "/api/workbench/workflow" and (r.request.post_data_json or {}).get("action") == "patch_preview", timeout=60000) as preview_wait:
                            pane.locator("button").filter(has_text=re.compile("^Preview reviewed patch$")).first.click()
                        preview_response = preview_wait.value
                        preview_body = preview_response.json()
                        assert preview_response.status == 200 and preview_body.get("ok") is True, (preview_response.status, preview_body)
                        assert preview_body["roundtrip"]["verified"] is True, preview_body.get("roundtrip")

                        step = "export stays pending: cancel the real artifact verification through the UI"
                        sentinel_path.write_text("block\n")
                        export_request = {}
                        def capture(request):
                            if request.url.split("?")[0] == origin + "/api/workbench/workflow" and (request.post_data_json or {}).get("action") == "patch_export":
                                export_request.update(request.post_data_json)
                        page.on("request", capture)
                        pane.locator("button").filter(has_text=re.compile("^Create private verified patch$")).first.click()
                        deadline = time.time() + 30
                        verifying = False
                        artifact_id = None
                        while time.time() < deadline:
                            listed = api("/api/workbench/workflow", {"action": "patch_list", "project_id": project_id})
                            for item in listed["patches"]:
                                if item.get("status") in ("verifying", "verification_pending"):
                                    verifying = True; artifact_id = item.get("artifact_id") or item.get("id")
                            if verifying:
                                break
                            time.sleep(0.25)
                        assert verifying, ("export did not reach a verifying receipt", export_request, listed)
                        pane.locator("button").filter(has_text=re.compile("^Refresh patch receipts$")).first.click()
                        time.sleep(0.5)
                        after_cancel_deadline = time.time() + 30
                        cancelled = False
                        while time.time() < after_cancel_deadline:
                            listed = api("/api/workbench/workflow", {"action": "patch_list", "project_id": project_id})
                            item = next((entry for entry in listed["patches"] if (entry.get("artifact_id") or entry.get("id")) == artifact_id), None)
                            if item and item.get("status") not in ("available",):
                                cancel_button = pane.locator("button").filter(has_text=re.compile("^Request patch-check cancellation$")).first
                                if cancel_button.count() and not cancel_button.is_disabled():
                                    cancel_button.click()
                                    cancelled = True
                                break
                            time.sleep(0.25)
                        time.sleep(1.0)
                        final_list = api("/api/workbench/workflow", {"action": "patch_list", "project_id": project_id})
                        final_item = next((entry for entry in final_list["patches"] if (entry.get("artifact_id") or entry.get("id")) == artifact_id), None)
                        assert final_item and final_item.get("status") != "available", ("artifact became available despite cancel", final_item)
                        forbidden = helper.api(origin, token, "/api/workbench/workflow", {"action": "private_patch_get", "artifact_id": artifact_id, "project_id": project_id})
                        assert forbidden[0] != 200 or forbidden[1].get("ok") is not True, forbidden
                        assert not page_errors, page_errors
                        log(json.dumps({"renderer": renderer, "artifact_preview_verified": True,
                                        "artifact_verifying_observed": True, "artifact_cancel_requested": cancelled,
                                        "artifact_not_available_after_cancel": True, "private_get_forbidden": True,
                                        "page_errors": len(page_errors), "admitted_live_model_trials": 0}))
                        sentinel_path.unlink(missing_ok=True)
                    finally:
                        try: sentinel_path.unlink(missing_ok=True)
                        except Exception: pass
                        if page_errors:
                            page.screenshot(path="/tmp/opencode/comet-artifact-cancel-%s-error.png" % renderer, full_page=True,
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
