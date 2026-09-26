"""Chromium acceptance fixture for the owner-only Comet Project Workbench."""

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
import urllib.error
import urllib.request
import uuid

from playwright.sync_api import expect, sync_playwright


ROOT = Path(__file__).resolve().parents[1]
WORKSPACE_ID = "a345639c-42bb-41d0-94da-f9d9abb8fd41"
MONITOR_ID = "65ef9240-3c10-4f68-a909-4a65ef7211be"
PANE_ID = "74977184-cbe1-4622-9fae-7ed32e531347"
BROWSER_PANE = "c58be1c8-94f3-44df-98cb-e7c8ea7aef49"
INITIAL = "def sum_items(items):\n    total = sum(items)\n    return total\n"
DEFECT = "return total + 1"


def run(*argv, cwd, env=None):
    return subprocess.run(argv, cwd=cwd, env=env, check=True, text=True, capture_output=True)


def api(origin, token, body):
    request = urllib.request.Request(
        origin + "/api/workbench",
        data=json.dumps({"workspace_id": WORKSPACE_ID, **body}).encode(),
        headers={"Origin": origin, "Authorization": "Bearer " + token, "Content-Type": "application/json"},
    )
    try:
        with urllib.request.urlopen(request, timeout=15) as response:
            return response.status, json.load(response)
    except urllib.error.HTTPError as error:
        return error.code, json.load(error)


def connected(page, token):
    page.get_by_role("button", name="Connect local host", exact=True).click()
    page.get_by_role("textbox", name="Host session token").fill(token)
    def acknowledged(response):
        if response.url.split("?")[0] != page.url.split("?")[0].rstrip("/") + "/api/workspace" or response.status != 200:
            return False
        body = response.request.post_data_json or {}
        return (body.get("workspace_id") == WORKSPACE_ID and body.get("action") == "read"
                and body.get("observed_revision", 0) > 0)

    # The status label can legitimately change to "Saved locally" after a UI
    # save. Require this document's authenticated acknowledgement instead of
    # depending on how long a transient success label remains on screen.
    with page.expect_response(acknowledged, timeout=15000) as pending:
        page.get_by_role("button", name="Unlock local host", exact=True).click()
    response = pending.value
    state = response.json()
    observed = response.request.post_data_json["observed_revision"]
    assert state["workspace_id"] == WORKSPACE_ID, state
    assert state["revision"] >= observed > 0, state
    assert state["observed_revision"] >= observed and state.get("browser_seen"), state


def open_workbench(page):
    page.get_by_role("button", name="Open orbit menu").click()
    page.get_by_role("button", name="Project Workbench", exact=True).click()
    dialog = page.locator("dialog.project-workbench-dialog[aria-label='Comet Project Workbench']")
    expect(dialog).to_be_visible()
    expect(dialog.locator(".workbench-status")).to_have_attribute("role", "status")
    return dialog


def result_for(responses, action):
    matches = [entry for entry in responses if entry[0] == action]
    assert matches, f"No /api/workbench response for {action}; observed: {responses}"
    entry = matches[-1]
    _, status, body = entry
    if not isinstance(body, dict):
        body = entry[2] = body.json()
    assert status == 200 and body.get("ok") is True, (action, status, body)
    return body


def main(renderer, linked=False):
    with tempfile.TemporaryDirectory(prefix="orbit-project-workbench-", dir="/tmp/opencode") as temporary:
        root = Path(temporary)
        for name in ("server", "src", "contracts", "docs", "public", "scripts"):
            if (ROOT / name).is_dir():
                shutil.copytree(ROOT / name, root / name)
        for name in ("index.html", "package.json", "tsconfig.json", "vite.config.js"):
            if (ROOT / name).is_file():
                shutil.copy2(ROOT / name, root / name)
        (root / "node_modules").symlink_to(ROOT / "node_modules", target_is_directory=True)
        for name in ("runtime", "home", "cwd", "tmux", "fixture"):
            (root / name).mkdir()
        shutil.copy2(ROOT / 'tests/fixtures/runtime-continuity.html',root / 'fixture/index.html')
        published=json.loads(run(shutil.which('python3'),str(ROOT / 'scripts/plugin_publish.py'),str(root / 'fixture'),
                                 '--id','workbench-continuity','--version','1.0.0','--title','Synthetic continuity','--runtime',str(root / 'runtime'),
                                 cwd=root,env={'PATH':os.environ['PATH'],'HOME':str(root / 'home')}).stdout)
        build_env = {"HOME": str(root / "home"), "PATH": os.environ["PATH"], "npm_config_cache": str(root / ".npm")}
        build = run(shutil.which("node"), str(ROOT / "scripts/isolated_build.mjs"), "--source", str(root), "--dest", str(root / "dist"), "--allow-source-dist", cwd=root, env=build_env)
        assert (root / "dist" / "index.html").is_file(), f"Build produced no dist/index.html:\n{build.stdout}\n{build.stderr}"

        project = root / "project"
        project.mkdir()
        git_env = {"PATH": os.environ["PATH"], "HOME": str(root / "home"), "GIT_CONFIG_NOSYSTEM": "1", "GIT_CONFIG_GLOBAL": "/dev/null"}
        run("git", "init", cwd=project, env=git_env)
        app = project / "app.py"
        app.write_text(INITIAL)
        run("git", "add", "app.py", cwd=project, env=git_env)
        run("git", "-c", "user.email=fixture@example.invalid", "-c", "user.name=Fixture", "commit", "-am", "initial", cwd=project, env=git_env)
        mapping = None
        if linked:
            original = project
            project = root / 'linked worktree 日本語'
            run('git', 'worktree', 'add', '-b', 'workbench-linked', str(project), cwd=original, env=git_env)
            mapping = {'git_directory': (project / '.git').read_text().strip().removeprefix('gitdir: '), 'common_directory': str(original / '.git')}
            app = project / 'app.py'
        defect_text = INITIAL.replace("return total", DEFECT)
        app.write_text(defect_text)
        assert DEFECT in run("git", "diff", "HEAD", cwd=project, env=git_env).stdout
        (project / ".env").write_text("SECRET=do-not-read\n")
        (project / "secret.pem").write_text("FAKE KEY FOR FIXTURE ONLY\n")
        (project / "linkdir").symlink_to("/tmp", target_is_directory=True)

        with socket.socket() as probe:
            probe.bind(("127.0.0.1", 0))
            port = probe.getsockname()[1]
        origin = f"http://127.0.0.1:{port}"
        token = secrets.token_urlsafe(36)
        server_env = {"PORT": str(port), "ORBIT_TOKEN": token, "ORBIT_RUNTIME_DIR": str(root / "runtime"),
                      "ORBIT_TMUX_SOCKET":"workbench-"+str(uuid.uuid4()),"ORBIT_TMUX_CONFIG":"/dev/null","TMUX_TMPDIR":str(root / 'tmux'),
                      "ORBIT_CWD": str(root / "cwd"), "HOME": str(root / "home"), "PATH": os.environ["PATH"]}
        state = {"version": 1, "selected": MONITOR_ID, "arc": 14, "view": "windows", "monitors": [{
            "id": MONITOR_ID, "name": "Fixture terminal", "diagonal": 32, "aspect": "16:9", "height": 0,
            "distance": 0, "pitch": 0, "yaw": 0, "offset": 0, "fontSize": 19,
            "frame": {"x": 0, "y": 0, "width": 780, "height": 950, "z": 0},
            "layout": {"type": "pane", "pane": {"id": PANE_ID, "kind": "terminal", "url": ""}},
        }]}
        state['monitors'].append({**state['monitors'][0], 'id':str(uuid.uuid4()),'name':'Unrelated form',
                                  'frame':{'x':800,'y':0,'width':700,'height':900,'z':1},
                                  'layout':{'type':'pane','pane':{'id':BROWSER_PANE,'kind':'browser','url':published['entry']}}})
        with (root / "server.log").open("w+") as log:
            server = subprocess.Popen([shutil.which("node"), "--experimental-strip-types", "server/index.mjs"],
                                      cwd=root, env=server_env, stdout=log, stderr=log)
            try:
                for _ in range(200):
                    if server.poll() is not None:
                        log.seek(0)
                        raise RuntimeError("Server exited:\n" + log.read().replace(token,'[REDACTED]'))
                    try:
                        with urllib.request.urlopen(origin + "/api/health", timeout=1):
                            break
                    except OSError:
                        time.sleep(.05)
                else:
                    log.seek(0)
                    raise RuntimeError("Server readiness timeout:\n" + log.read().replace(token,'[REDACTED]'))

                with sync_playwright() as playwright:
                    browser = playwright.chromium.launch(headless=True, args=["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"])
                    context = browser.new_context(viewport={"width": 1800, "height": 1200})
                    context.add_init_script("if(window===window.top && !localStorage.getItem('orbit.workspace.id')) {"
                                            "localStorage.setItem('orbit.workspace.id'," + json.dumps(WORKSPACE_ID) + ");"
                                            "localStorage.setItem('orbit.workspace.v1',JSON.stringify(" + json.dumps(state) + "));}")
                    page = context.new_page()
                    errors, responses, agent_requests, websockets = [], [], [], []
                    page.on("pageerror", lambda error: errors.append(str(error)))
                    page.on("request", lambda request: agent_requests.append(request.url) if request.url.split("?")[0] == origin + "/api/agent" else None)
                    page.on("websocket", lambda websocket: websockets.append(websocket.url))

                    def record_response(response):
                        if response.url.split("?")[0] == origin + "/api/workbench":
                            request_body = response.request.post_data_json
                            # Record headers synchronously; body reads inside the
                            # event callback can yield to UI assertions first.
                            responses.append([request_body.get("action"), response.status, response])

                    page.on("response", record_response)
                    try:
                        page.goto(origin + ("?renderer=docking" if renderer == "docking" else ""), wait_until="domcontentloaded")
                        expect(page.locator('dialog.orbit-onboarding')).to_be_visible()
                        page.keyboard.press("Escape")
                        expect(page.locator('dialog.orbit-onboarding')).not_to_be_visible()
                        connected(page, token)
                        frame=page.frame_locator(f'.pane[data-pane-id="{BROWSER_PANE}"] iframe')
                        frame.locator('#draft').fill('Keep this unrelated draft')
                        nonce=frame.locator('#document-nonce').inner_text()
                        page.evaluate("id => {window.__workbenchFrame=document.querySelector(`.pane[data-pane-id=\"${id}\"] iframe`);}",BROWSER_PANE)
                        assert page.evaluate("performance.getEntriesByType('navigation').length") == 1
                        assert page.evaluate("JSON.parse(localStorage.getItem('orbit.workspace.v1')).monitors[0].layout.pane.id") == PANE_ID
                        dialog = open_workbench(page)
                        size=dialog.get_by_label('Workbench text size')
                        size.fill('22');size.dispatch_event('input')
                        assert dialog.evaluate('node => getComputedStyle(node).fontSize')=='22px'
                        size.fill('16');size.dispatch_event('input')
                        expect(dialog.locator(".workbench-status")).to_contain_text("projects", timeout=15000)
                        assert any(surface["pane_id"] == PANE_ID and surface["kind"] == "terminal" for surface in result_for(responses, "list")["surfaces"])

                        dialog.get_by_label("Project root directory").fill(str(project))
                        if mapping:
                            dialog.get_by_label('Linked worktree Git directory', exact=True).fill(mapping['git_directory'])
                            dialog.get_by_label('Linked worktree common directory', exact=True).fill(mapping['common_directory'])
                        dialog.get_by_label("Project name").fill("synthetic-project")
                        dialog.get_by_role("button", name="Preview project registration").click()
                        expect(dialog.locator(".workbench-approval")).to_contain_text("Authority:")
                        approval = dialog.locator(".workbench-approval").inner_text()
                        assert re.search(r"Digest: [a-f0-9]{64}\b", approval), approval
                        assert "Expires at:" in approval and ".env" in approval and "symlink" in approval, approval
                        preview = result_for(responses, "register_preview")
                        assert preview["digest"] in approval and preview["authority"] in approval
                        dialog.get_by_role("button", name="Confirm project registration").click()
                        expect(dialog.get_by_role("button", name="Open project synthetic-project")).to_be_visible()
                        commit = result_for(responses, "register_commit")
                        project_id = commit["project"]["id"]
                        assert str(project) in dialog.locator(".workbench-projects").inner_text()
                        dialog.get_by_role("button", name="Open project synthetic-project").click()
                        expect(dialog.locator(".workbench-status")).to_contain_text("Inspected synthetic-project", timeout=15000)
                        inspection = result_for(responses, "inspect")
                        expect(dialog.locator('.workbench-project-meta')).to_contain_text(inspection['snapshot']['id'])
                        expect(dialog.locator('.workbench-project-meta')).to_contain_text(inspection['snapshot']['hash'])
                        assert inspection["project"]["id"] == project_id
                        repository = dialog.locator(".workbench-repository")
                        expect(repository).to_contain_text("State: available")
                        head = inspection["repository"]["head"]
                        assert re.fullmatch(r"[a-f0-9]{40,64}", head), head
                        expect(repository).to_contain_text("Head: " + head)
                        expect(repository).to_contain_text(inspection['repository']['snapshot_hash'])
                        diff = dialog.locator("pre.workbench-diff").inner_text()
                        assert DEFECT in diff and "-    return total" in diff and "+    " + DEFECT in diff and "@@" in diff, diff
                        assert dialog.locator(".workbench-status-row").count() >= 1, "Git status must expose the modified file"
                        assert inspection["repository"]["state"] == "available"
                        exclusions = inspection["snapshot"]["exclusions"]
                        assert {".env", "secret.pem", "linkdir"}.issubset({entry["path"] for entry in exclusions}), exclusions
                        assert "excluded" in inspection["repository"]["exclusions"].lower()
                        paths = [item["path"] for item in inspection["resources"] if item["kind"] == "file"]
                        assert paths == ["app.py"], paths
                        file_buttons = dialog.locator(".workbench-files button")
                        assert file_buttons.count() == 1
                        assert not any(name in dialog.locator(".workbench-files").inner_text() for name in (".env", "secret.pem", "linkdir"))
                        resource_id = next(item["id"] for item in inspection["resources"] if item.get("path") == "app.py")
                        dialog.get_by_role("button", name="Refresh project inspection").click()
                        expect(dialog.locator(".workbench-status")).to_contain_text("Inspected synthetic-project")
                        refreshed_inspection = result_for(responses, "inspect")
                        assert next(item["id"] for item in refreshed_inspection["resources"] if item.get("path") == "app.py") == resource_id

                        dialog.get_by_role("button", name="Open file app.py").click()
                        text = dialog.get_by_role("textbox", name="Project file text")
                        expect(text).to_have_value(defect_text)
                        assert text.get_attribute("readonly") is not None
                        file_result = result_for(responses, "file")
                        assert file_result["resource"]["id"] == resource_id
                        expect(dialog.locator(".workbench-file-path")).to_have_text("app.py")
                        expect(dialog.locator(".workbench-file-meta")).to_contain_text(file_result["snapshot"]["hash"])
                        changed_text = defect_text + "# refreshed on explicit request\n"
                        app.write_text(changed_text)
                        expect(text).to_have_value(defect_text)
                        assert not dialog.locator(".workbench-stale").is_visible()
                        dialog.get_by_role("button", name="Refresh file preview").click()
                        expect(text).to_have_value(changed_text)
                        expect(dialog.locator(".workbench-stale")).to_be_visible()
                        refreshed = result_for(responses, "file")
                        assert refreshed["snapshot"]["stale"] is True
                        expect(dialog.locator(".workbench-file-meta")).to_contain_text(refreshed["snapshot"]["hash"])

                        dialog.get_by_label("Selection start line").fill("2")
                        dialog.get_by_label("Selection end line").fill("3")
                        dialog.get_by_role("button", name="Highlight selected lines").click()
                        selected = text.evaluate("node => ({start: node.selectionStart, end: node.selectionEnd, value: node.value})")
                        assert selected["value"][selected["start"]:selected["end"]] == "    total = sum(items)\n    " + DEFECT, selected
                        expect(dialog.locator(".workbench-selection")).to_have_text("Selected lines 2–3.")

                        pane = dialog.get_by_label("Link pane")
                        expect(pane.locator(f'option[value="{PANE_ID}"]')).to_have_count(1)
                        pane.select_option(PANE_ID)
                        dialog.get_by_role("button", name="Link selected pane metadata only").click()
                        expect(dialog.locator(".workbench-status")).to_contain_text("Pane metadata linked")
                        link = result_for(responses, "link_pane")
                        assert link["resource"]["pane_id"] == PANE_ID and link["resource"]["state"] == "linked_metadata_only"
                        assert any(binding["role"] == "active_terminal" and binding["pane_id"] == PANE_ID for binding in link["bindings"])
                        expect(dialog.locator(".workbench-bindings")).to_contain_text("active_terminal")
                        expect(dialog.locator(".workbench-bindings")).to_contain_text(PANE_ID)
                        assert not any("/api/terminal" in url for url in websockets), websockets
                        with page.expect_response(lambda response: response.url.split("?")[0] == origin + "/api/workbench" and response.request.post_data_json.get("action") == "bind"):
                            dialog.get_by_role("button", name="Bind open file to pane").click()
                        expect(dialog.locator(".workbench-status")).to_contain_text("File binding saved")
                        binding = result_for(responses, "bind")
                        assert any(item["role"] == "project_files" and item["resource_id"] == resource_id and item["pane_id"] == PANE_ID for item in binding["bindings"]), binding
                        expect(dialog.locator(".workbench-bindings")).to_contain_text("project_files")
                        assert "metadata only" in dialog.locator(".workbench-note").first.inner_text()
                        execution = dialog.locator(".workbench-execution")
                        expect(execution).to_contain_text("Definitions and limits")
                        expect(execution).to_contain_text("Jobs and evidence")
                        assert inspection["execution"]["tasks"] == inspection["execution"]["jobs"] == inspection["execution"]["artifacts"] == []
                        assert inspection['execution']['state']=='available'
                        expect(dialog.get_by_role("button", name="Ask agent about this", exact=True)).to_be_enabled()
                        dialog.get_by_role("button", name="Open doctor").click()
                        expect(dialog.locator(".workbench-doctor")).to_contain_text("schema_version: 8")
                        assert result_for(responses, "doctor")["schema_version"] == 8
                        assert token not in dialog.inner_text() and "do-not-read" not in dialog.inner_text()

                        status, denied = api(origin, token, {"action": "register_preview", "root": str(project / "linkdir"), "name": "denied"})
                        assert (status, denied.get("code")) == (403, "permission_denied"), (status, denied)
                        status, denied = api(origin, token, {"action": "file", "project_id": project_id, "resource_id": str(uuid.uuid4())})
                        assert (status, denied.get("code")) == (403, "permission_denied"), (status, denied)

                        assert page.evaluate("performance.getEntriesByType('navigation').length") == 1
                        dialog.get_by_role("button", name="Close project workbench").click()
                        expect(dialog).to_have_count(0)
                        assert frame.locator('#draft').input_value()=='Keep this unrelated draft'
                        assert frame.locator('#document-nonce').inner_text()==nonce
                        assert page.evaluate("id => window.__workbenchFrame===document.querySelector(`.pane[data-pane-id=\"${id}\"] iframe`)",BROWSER_PANE)
                        assert page.evaluate("performance.getEntriesByType('navigation').length") == 1
                        assert page.evaluate("JSON.parse(localStorage.getItem('orbit.workspace.v1')).monitors[0].layout.pane.id") == PANE_ID
                        assert not any("/api/terminal" in url for url in websockets), websockets
                        # Workspace event streams/polling can remain connected;
                        # connected() below waits for actual application readiness.
                        for entry in responses:
                            if not isinstance(entry[2], dict):
                                entry[2] = entry[2].json()
                        # CI rendered the replacement document while Playwright's
                        # reload lifecycle wait remained pending. Require the
                        # committed navigation, new fixture document and actual
                        # workspace acknowledgement instead of that lifecycle event.
                        page.reload(wait_until="commit")
                        expect(frame.locator('#document-nonce')).not_to_have_text(nonce)
                        connected(page, token)
                        dialog = open_workbench(page)
                        expect(dialog.get_by_role("button", name="Open project synthetic-project")).to_be_visible()
                        assert any(item["id"] == project_id for item in result_for(responses, "list")["projects"])
                        assert any(surface["pane_id"] == PANE_ID and surface["kind"] == "terminal" for surface in result_for(responses, "list")["surfaces"])
                        dialog.get_by_role("button", name="Open project synthetic-project").click()
                        expect(dialog.locator(".workbench-status")).to_contain_text("Inspected synthetic-project")
                        reinspection = result_for(responses, "inspect")
                        assert reinspection["project"]["id"] == project_id
                        assert next(item["id"] for item in reinspection["resources"] if item.get("path") == "app.py") == resource_id
                        assert page.evaluate("performance.getEntriesByType('navigation').length") == 1
                        assert page.evaluate("JSON.parse(localStorage.getItem('orbit.workspace.v1')).monitors[0].layout.pane.id") == PANE_ID
                        assert not errors, errors
                        assert not agent_requests, agent_requests
                        assert not any("/api/terminal" in url for url in websockets), websockets
                        for entry in responses:
                            if not isinstance(entry[2], dict):
                                entry[2] = entry[2].json()
                        assert all(status == 200 and body.get("ok") is True for _, status, body in responses), responses
                        page.screenshot(path=f"/tmp/opencode/orbit-project-workbench-{renderer}.png", full_page=True)
                        page.once('dialog',lambda confirmation:confirmation.accept())
                        dialog.get_by_role('button',name='Revoke project access',exact=True).click()
                        expect(dialog.locator('.workbench-status')).to_contain_text('Future project reads are blocked')
                        assert api(origin,token,{'action':'inspect','project_id':project_id})[0]==403
                        _,pending_preview=api(origin,token,{'action':'register_preview','root':str(project),'name':'Fresh approval needed'})
                        server.terminate();server.wait(timeout=10)
                        server=subprocess.Popen([shutil.which('node'),'--experimental-strip-types','server/index.mjs'],cwd=root,env=server_env,stdout=log,stderr=log)
                        for _ in range(200):
                            try:
                                with urllib.request.urlopen(origin+'/api/health',timeout=1):break
                            except OSError:time.sleep(.05)
                        else:raise AssertionError('Disposable restarted server unavailable')
                        assert api(origin,token,{'action':'register_commit','approval_id':pending_preview['approval_id']})[0]==403
                        assert api(origin,token,{'action':'inspect','project_id':project_id})[0]==403
                        assert any(item['id']==project_id and item['active'] is False for item in api(origin,token,{'action':'list'})[1]['projects'])
                        dialog.locator('.workbench-registration > summary').click()
                        dialog.get_by_label('Project root directory').fill(str(project))
                        dialog.get_by_label('Project name').fill('synthetic-project')
                        dialog.get_by_role('button',name='Preview project registration').click()
                        expect(dialog.get_by_role('button',name='Confirm project registration')).to_be_enabled()
                        dialog.get_by_role('button',name='Confirm project registration').click()
                        expect(dialog.locator('.workbench-status')).to_contain_text('Inspected synthetic-project')
                        assert result_for(responses,'register_commit')['project']['id']==project_id
                        assert not errors,errors
                        assert not agent_requests,agent_requests
                        print(f"PASS: renderer={renderer} Chromium={browser.version} workbench_responses={len(responses)} agent_requests={len(agent_requests)} terminal_websockets={sum('/api/terminal' in url for url in websockets)} page_errors: {len(errors)} project_id={project_id} resource_id={resource_id}")
                    except Exception:
                        page.screenshot(path=f'/tmp/opencode/orbit-project-workbench-{renderer}.png',full_page=True,
                                        mask=[page.get_by_role('textbox',name='Host session token')])
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
    parser.add_argument('--linked', action='store_true')
    args = parser.parse_args()
    main(args.renderer, args.linked)
