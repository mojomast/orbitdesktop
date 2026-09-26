"""Disposable real-server Chromium fixture for managed Workbench execution."""

import argparse
import json
import os
from pathlib import Path
import re
import secrets
import shutil
import socket
import subprocess
import tempfile
import time
import urllib.request
import uuid

from playwright.sync_api import expect, sync_playwright


ROOT = Path(__file__).resolve().parents[1]
WORKSPACE_ID = "a345639c-42bb-41d0-94da-f9d9abb8fd41"
MONITOR_ID = "65ef9240-3c10-4f68-a909-4a65ef7211be"
PANE_ID = "74977184-cbe1-4622-9fae-7ed32e531347"
WRONG = "export const sum = (a,b) => a - b;\n"
RIGHT = "export const sum = (a,b) => a + b;\n"


def run(*argv, cwd, env):
    return subprocess.run(argv, cwd=cwd, env=env, check=True, text=True, capture_output=True)


def main(renderer):
    with tempfile.TemporaryDirectory(prefix="orbit-workbench-execution-", dir="/tmp/opencode") as temporary:
        root = Path(temporary)
        for name in ("server", "src", "contracts", "docs", "public", "scripts"):
            if (ROOT / name).is_dir():
                shutil.copytree(ROOT / name, root / name)
        for name in ("index.html", "package.json", "tsconfig.json", "vite.config.js"):
            shutil.copy2(ROOT / name, root / name)
        (root / "node_modules").symlink_to(ROOT / "node_modules", target_is_directory=True)
        for name in ("runtime", "home", "cwd", "tmux"):
            (root / name).mkdir()
        build_env = {"HOME": str(root / "home"), "PATH": os.environ["PATH"], "npm_config_cache": str(root / ".npm")}
        build = run(shutil.which("node"), str(ROOT / "scripts/isolated_build.mjs"), "--source", str(root), "--dest", str(root / "dist"), "--allow-source-dist", cwd=root, env=build_env)
        assert (root / "dist/index.html").is_file(), (build.stdout, build.stderr)

        project = root / "project"
        project.mkdir()
        (project / "math.js").write_text(WRONG)
        git_env = {"PATH": os.environ["PATH"], "HOME": str(root / "home"),
                   "GIT_CONFIG_NOSYSTEM": "1", "GIT_CONFIG_GLOBAL": "/dev/null"}
        run("git", "init", cwd=project, env=git_env)
        run("git", "add", "math.js", cwd=project, env=git_env)
        run("git", "-c", "user.email=fixture@example.invalid", "-c", "user.name=Fixture",
            "commit", "-am", "initial", cwd=project, env=git_env)

        with socket.socket() as probe:
            probe.bind(("127.0.0.1", 0))
            port = probe.getsockname()[1]
        origin = f"http://127.0.0.1:{port}"
        token = secrets.token_urlsafe(36)
        server_env = {"PORT": str(port), "ORBIT_TOKEN": token, "ORBIT_RUNTIME_DIR": str(root / "runtime"),
                      "ORBIT_TMUX_SOCKET": "execution-" + str(uuid.uuid4()), "ORBIT_TMUX_CONFIG": "/dev/null",
                      "TMUX_TMPDIR": str(root / "tmux"), "ORBIT_CWD": str(root / "cwd"),
                      "HOME": str(root / "home"), "PATH": os.environ["PATH"]}
        state = {"version": 1, "selected": MONITOR_ID, "arc": 14, "view": "windows", "monitors": [{
            "id": MONITOR_ID, "name": "Fixture terminal", "diagonal": 32, "aspect": "16:9", "height": 0,
            "distance": 0, "pitch": 0, "yaw": 0, "offset": 0, "fontSize": 19,
            "frame": {"x": 0, "y": 0, "width": 780, "height": 950, "z": 0},
            "layout": {"type": "pane", "pane": {"id": PANE_ID, "kind": "terminal", "url": ""}},
        }]}
        with (root / "server.log").open("w+") as log:
            server = subprocess.Popen([shutil.which("node"), "--experimental-strip-types", "server/index.mjs"],
                                      cwd=root, env=server_env, stdout=log, stderr=log)
            try:
                for _ in range(200):
                    if server.poll() is not None:
                        log.seek(0)
                        raise RuntimeError("Server exited:\n" + log.read().replace(token, "[REDACTED]"))
                    try:
                        with urllib.request.urlopen(origin + "/api/health", timeout=1):
                            break
                    except OSError:
                        time.sleep(.05)
                else:
                    log.seek(0)
                    raise RuntimeError("Server readiness timeout:\n" + log.read().replace(token, "[REDACTED]"))

                with sync_playwright() as playwright:
                    browser = playwright.chromium.launch(headless=True, args=["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"])
                    context = browser.new_context(viewport={"width": 1800, "height": 1200})
                    context.add_init_script("if(window===window.top && !localStorage.getItem('orbit.workspace.id')) {"
                                            "localStorage.setItem('orbit.workspace.id'," + json.dumps(WORKSPACE_ID) + ");"
                                            "localStorage.setItem('orbit.workspace.v1',JSON.stringify(" + json.dumps(state) + "));}")
                    page = context.new_page()
                    errors, agent_requests, responses, workbench_responses, execution_requests = [], [], [], [], []
                    page.on("pageerror", lambda error: errors.append(str(error)))
                    page.on("request", lambda request: agent_requests.append(request.url)
                            if request.url.split("?")[0] == origin + "/api/agent" else None)

                    def record_response(response):
                        url = response.url.split("?")[0]
                        if url in (origin + "/api/workbench", origin + "/api/workbench/execution"):
                            body = response.request.post_data_json
                            entry = (body.get("action"), response.status, response.json())
                            (responses if url.endswith("/execution") else workbench_responses).append(entry)
                            if url.endswith("/execution") and body.get("action") in ("candidate_create", "check_run"):
                                execution_requests.append(body)

                    page.on("response", record_response)

                    def result(action):
                        matches = [(status, body) for observed, status, body in responses if observed == action]
                        assert matches, f"No execution response for {action}; observed actions: {[item[0] for item in responses]}"
                        status, body = matches[-1]
                        assert status == 200 and body.get("ok") is True, (action, status, body)
                        return body

                    def click(pane, label, action):
                        with page.expect_response(lambda response: response.url.split("?")[0] == origin + "/api/workbench/execution"
                                                  and response.request.post_data_json.get("action") == action):
                            # dom.button uses descriptive aria-labels, while the visible text is short.
                            if action == "candidate_read":
                                pane.get_by_role("button", name=label, exact=True).click()
                            else:
                                pane.locator("button").filter(has_text=re.compile("^" + re.escape(label) + "$")).click()
                        return result(action)

                    try:
                        page.goto(origin + ("?renderer=docking" if renderer == "docking" else ""), wait_until="domcontentloaded")
                        expect(page.locator('dialog.orbit-onboarding')).to_be_visible()
                        page.keyboard.press("Escape")
                        expect(page.locator('dialog.orbit-onboarding')).not_to_be_visible()
                        page.get_by_role("button", name="Connect local host", exact=True).click()
                        page.get_by_role("textbox", name="Host session token").fill(token)
                        page.get_by_role("button", name="Unlock local host", exact=True).click()
                        expect(page.locator(".saved")).to_contain_text("Workspace connected", timeout=15000)
                        page.get_by_role("button", name="Open orbit menu").click()
                        page.get_by_role("button", name="Project Workbench", exact=True).click()
                        dialog = page.locator("dialog.project-workbench-dialog[aria-label='Comet Project Workbench']")
                        expect(dialog).to_be_visible()
                        dialog.get_by_label("Project root directory").fill(str(project))
                        dialog.get_by_label("Project name").fill("execution-fixture")
                        dialog.get_by_role("button", name="Preview project registration").click()
                        expect(dialog.get_by_role("button", name="Confirm project registration")).to_be_enabled()
                        dialog.get_by_role("button", name="Confirm project registration").click()
                        expect(dialog.get_by_role("button", name="Open project execution-fixture")).to_be_visible()
                        dialog.get_by_role("button", name="Open project execution-fixture").click()
                        pane = dialog.locator(".workbench-execution")
                        expect(pane.get_by_role("heading", name="Execution workbench")).to_be_visible(timeout=15000)
                        expect(pane.locator(".workbench-execution-status")).to_contain_text("Execution:")
                        assert result("execution_state")["definitions"]

                        pane.get_by_role("textbox", name="Task title").fill("Repair sum")
                        pane.get_by_role("textbox", name="Acceptance statement").fill("sum(2,3)===5")
                        pane.get_by_role("combobox", name="Task check definition").select_option("host-regression")
                        pane.get_by_role("textbox", name="Recipient profile ID").fill("default")
                        pane.get_by_role("textbox", name="Recipient session ID").fill("orbit-execution-fixture")
                        task = click(pane, "Create task", "task_create")["task"]
                        assert task["recipient"]["profile_id"] == "default"
                        assert task["recipient"]["session_id"] == "orbit-execution-fixture"
                        assert "unbound" in task["recipient_authority"], task
                        expect(pane.get_by_role("combobox", name="Selected task")).to_have_value(task["id"])

                        preview = click(pane, "Preview candidate", "candidate_preview")
                        assert any(file["path"] == "math.js" for file in preview["preview"]["base"]["files"])
                        created = click(pane, "Create candidate", "candidate_create")
                        candidate = created["candidate"]
                        expect(pane.get_by_role("combobox", name="Selected candidate")).to_have_value(candidate["id"])
                        click(pane, "Read candidate file math.js", "candidate_read")
                        edit = pane.get_by_role("textbox", name="Candidate file edit")
                        expect(edit).to_have_value(WRONG)
                        assert "a - b" in edit.input_value()

                        pane.get_by_role("combobox", name="Check definition", exact=True).select_option("host-regression")
                        click(pane, "Preview check", "check_preview")
                        failed = click(pane, "Run check", "check_run")["evidence"]
                        assert failed["verdict"] == "fail" and failed["exit_code"] != 0, failed
                        expect(pane.locator(".workbench-execution-jobs")).to_contain_text(f"{failed['id']} · fail · exit {failed['exit_code']}")
                        before = result("execution_state")["candidates"][-1]
                        edit.fill(RIGHT)
                        updated = click(pane, "Save edit", "candidate_edit")
                        candidate = updated["candidate"]
                        assert candidate["generation"] > before["generation"] and candidate["hash"] != before["hash"]
                        assert failed["id"] in updated["superseded_evidence_ids"], updated
                        expect(pane.locator(".workbench-execution-jobs")).to_contain_text("Superseded: true")
                        expect(edit).to_have_value(RIGHT)

                        click(pane, "Preview check", "check_preview")
                        passed = click(pane, "Run check", "check_run")["evidence"]
                        assert passed["verdict"] == "pass" and passed["exit_code"] == 0, passed
                        assert passed["candidate_hash_before"] == passed["candidate_hash_after"] == candidate["hash"]
                        expect(pane.locator(".workbench-execution-jobs")).to_contain_text(f"{passed['id']} · pass · exit 0")
                        pane.get_by_role("checkbox", name=f"Passing evidence {passed['id']}").check()
                        review = click(pane, "Approve", "review_decide")["review"]
                        assert review["decision"] == "approved" and passed["id"] in review["evidence_ids"]
                        expect(pane.locator(".workbench-execution-review")).to_contain_text("approved")
                        expect(pane.locator(".workbench-execution-review")).to_contain_text("not a merge, deployment or overwrite")

                        export = click(pane, "Export read-only artifact", "candidate_export")
                        assert export["integration_supported"] is False
                        assert any(file["path"] == "math.js" and file["candidate_text"] == RIGHT
                                   for file in export["artifact"]["files"]), export
                        expect(pane.locator(".workbench-execution-check-preview")).to_contain_text("Integration supported: false")
                        expect(pane.locator(".workbench-execution-check-preview")).to_contain_text("a + b")
                        assert (project / "math.js").read_text() == WRONG
                        assert [result("check_run")["evidence"]["verdict"]] == ["pass"]
                        runs = [body["evidence"] for action, _, body in responses if action == "check_run"]
                        assert [(item["id"], item["verdict"], item["exit_code"]) for item in runs] == [
                            (failed["id"], "fail", failed["exit_code"]), (passed["id"], "pass", 0)]
                        assert all(status == 200 and body.get("ok") is True for _, status, body in responses), responses
                        assert all(status == 200 and body.get("ok") is True for _, status, body in workbench_responses), workbench_responses
                        assert not errors, errors
                        assert not agent_requests, agent_requests
                        print(f"PASS: renderer={renderer} Chromium={browser.version} execution_responses={len(responses)} "
                              f"check_verdicts={[item['verdict'] for item in runs]} page_errors={len(errors)} "
                              f"agent_requests={len(agent_requests)} recipient_binding=pending")
                    except Exception:
                        page.screenshot(path=f"/tmp/opencode/orbit-workbench-execution-{renderer}.png", full_page=True,
                                        mask=[page.get_by_role("textbox", name="Host session token")])
                        print(f"DIAGNOSTIC: renderer={renderer} execution_responses={[(action, status, body.get('code')) for action, status, body in responses]} "
                              f"preview_id_at_top_level={[(body.get('preview_id'), body.get('preview', {}).get('preview_id')) for action, _, body in responses if action == 'candidate_preview']} "
                              f"create_run_requests={execution_requests} page_errors={errors} agent_requests={len(agent_requests)}", flush=True)
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


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--renderer", choices=("default", "docking"), required=True)
    main(parser.parse_args().renderer)
