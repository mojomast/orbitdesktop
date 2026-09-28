"""Chromium acceptance fixture for trusted Project Workbench tools.

Journey (real Node server, isolated runtime, private tmux, no paid providers):
  - register two private fixture projects
  - create a notebook tool through the owner tool manager (preview + commit)
  - the server stages the pane; the host renders it with no embedded frame
  - edit/save, and a stale-revision save conflict retains the local draft
  - explicit "reload saved note" replaces the draft only on click
  - compatible repin both ways preserves later notes (release != data)
  - disable/enable and configure-while-disabled
  - recovery hold clears private DOM; release never re-enables
  - a layout checkpoint undo preserves notebook text
  - project revoke clears the private DOM and it never repopulates
  - an evidence_checks card renders only sanitized recorded facts
  - unrelated terminal/conversation pane ids remain unchanged

Requires the lead-owned `/api/workbench/tools` backend and the panes.ts /
project-workbench.ts integration. This test does not edit either.
"""

import argparse
import fcntl
import json
import os
import re
import secrets
import shutil
import socket
import sqlite3
import subprocess
import tempfile
import time
import urllib.error
import urllib.request
import uuid
from pathlib import Path

from playwright.sync_api import expect, sync_playwright

ROOT = Path(__file__).resolve().parents[1]
WORKSPACE_ID = "a345639c-42bb-41d0-94da-f9d9abb8fd41"
MONITOR_TERMINAL = "65ef9240-3c10-4f68-a909-4a65ef7211be"
TERMINAL_PANE = "74977184-cbe1-4622-9fae-7ed32e531347"
MONITOR_AGENT = "1b1f0e6a-2c3d-4e5f-8a90-abcdef012345"
AGENT_PANE = "2c2e1f7b-3d4e-5f60-9b01-fedcba987654"


def run(*argv, cwd, env=None):
    return subprocess.run(argv, cwd=cwd, env=env, check=True, text=True, capture_output=True)


def post(origin, path, token, body):
    request = urllib.request.Request(
        origin + path,
        data=json.dumps(body).encode(),
        headers={"Origin": origin, "Authorization": "Bearer " + token, "Content-Type": "application/json"},
    )
    try:
        with urllib.request.urlopen(request, timeout=20) as response:
            return response.status, json.load(response)
    except urllib.error.HTTPError as error:
        try:
            return error.code, json.load(error)
        except Exception:
            return error.code, {}


def workbench_api(origin, token, body):
    return post(origin, "/api/workbench", token, {"workspace_id": WORKSPACE_ID, **body})


def tools_api(origin, token, body):
    return post(origin, "/api/workbench/tools", token, {"workspace_id": WORKSPACE_ID, **body})


def workspace_api(origin, token, body):
    return post(origin, "/api/workspace", token, {"workspace_id": WORKSPACE_ID, **body})


def recovery_api(origin, token, body):
    return post(origin, "/api/workspace/recovery", token, {"workspace_id": WORKSPACE_ID, **body})


def mutation(body, intent):
    return {**body, "operation_id": str(uuid.uuid4()), "intent": intent}


def read_snapshot(origin, token):
    status, snap = workspace_api(origin, token, {"action": "read"})
    assert status == 200 and snap.get("state"), snap
    return snap


def pane_ids(snapshot):
    found = []

    def visit(node):
        if node.get("type") == "pane":
            found.append((node["pane"]["id"], node["pane"].get("url", "")))
        else:
            visit(node["first"])
            visit(node["second"])

    for monitor in snapshot["state"]["monitors"]:
        visit(monitor["layout"])
    return found


def pane_for_instance(origin, token, instance_id):
    url = f"orbit://project-tool/{instance_id}"
    for pane_id, pane_url in pane_ids(read_snapshot(origin, token)):
        if pane_url == url:
            return pane_id
    return None


def window_for_pane(snapshot, pane_id):
    def visit(node):
        if node.get("type") == "pane":
            return node["pane"]["id"] == pane_id
        return visit(node["first"]) or visit(node["second"])

    for monitor in snapshot["state"]["monitors"]:
        if visit(monitor["layout"]):
            return monitor["id"]
    return None


def instance_by_title(origin, token, title):
    status, meta = tools_api(origin, token, {"action": "metadata_list"})
    assert status == 200 and meta.get("ok"), meta
    match = next((item for item in meta["instances"] if item.get("title") == title), None)
    assert match, f"instance {title!r} not found in {meta['instances']}"
    return match


def connected(page, token):
    page.get_by_role("button", name="Connect local host", exact=True).click()
    page.get_by_role("textbox", name="Host session token").fill(token)

    def acknowledged(response):
        if response.url.split("?")[0] != page.url.split("?")[0].rstrip("/") + "/api/workspace" or response.status != 200:
            return False
        body = response.request.post_data_json or {}
        return body.get("workspace_id") == WORKSPACE_ID and body.get("action") == "read" and body.get("observed_revision", 0) > 0

    with page.expect_response(acknowledged, timeout=15000) as pending:
        page.get_by_role("button", name="Unlock local host", exact=True).click()
    state = pending.value.json()
    assert state.get("revision", 0) > 0 and state.get("workspace_id") == WORKSPACE_ID, state


def close_workbench(page):
    dialog = page.locator("dialog.project-workbench-dialog[aria-label='Comet Project Workbench']")
    if dialog.count() and dialog.is_visible():
        dialog.get_by_role("button", name="Close project workbench").click()
        dialog.wait_for(state="detached", timeout=15000)


def close_orbit_menu(page):
    close = page.get_by_role("button", name="Close orbit menu", exact=True)
    if close.count() and close.first.is_visible():
        close.first.click()
        page.wait_for_timeout(150)


def hide_sidebar(page):
    """Collapse the display-configuration side panel via the existing UI control so
    the fixture can prove the tool surface fits the narrow viewport unobstructed."""
    for _ in range(3):
        expanded = page.evaluate(
            "() => { const b=[...document.querySelectorAll('button')].find(x=>x.getAttribute('aria-label')==='Toggle side panel'); return b ? b.getAttribute('aria-expanded') : null; }"
        )
        if expanded == "false":
            return
        page.evaluate(
            "() => { const b=[...document.querySelectorAll('button')].find(x=>x.getAttribute('aria-label')==='Toggle side panel'); if(b) b.click(); }"
        )
        page.wait_for_timeout(250)


def open_workbench(page):
    close_workbench(page)
    menu_entry = page.locator("button:visible", has_text="Project Workbench")
    for _ in range(4):
        if menu_entry.count():
            break
        page.get_by_role("button", name="Open orbit menu", exact=True).click()
        page.wait_for_timeout(200)
    assert menu_entry.count(), "Project Workbench entry never became available"
    with page.expect_response(lambda response: response.url.split("?")[0].endswith("/api/workbench")
                              and (response.request.post_data_json or {}).get("action") == "list") as pending:
        menu_entry.first.click()
    assert pending.value.status == 200 and pending.value.json().get("ok") is True
    dialog = page.locator("dialog.project-workbench-dialog[aria-label='Comet Project Workbench']")
    expect(dialog).to_be_visible()
    return dialog


def open_project(page, dialog, name):
    with page.expect_response(lambda response: response.url.split("?")[0].endswith("/api/workbench")
                              and (response.request.post_data_json or {}).get("action") == "inspect") as pending:
        dialog.get_by_role("button", name=f"Open project {name}").click()
    assert pending.value.status == 200, pending.value
    expect(dialog.locator(".project-tool-manager")).to_be_visible(timeout=20000)


def create_tool_through_manager(page, dialog, kind, title):
    details = dialog.locator(".project-tool-create")
    if not details.evaluate("node => node.open"):
        details.locator("summary").click()
    dialog.get_by_label("New project tool kind").select_option(kind)
    dialog.get_by_label("New project tool title").fill(title)
    dialog.locator(".project-tool-preview-button").click()
    preview = dialog.locator(".project-tool-preview")
    expect(preview).to_contain_text("Not rendered and not tested")
    expect(preview).to_contain_text("Add window")
    expect(preview).to_contain_text("renderer release")
    dialog.locator(".project-tool-commit-button").click()
    # onOpen closes the dialog once the browser has acknowledged the new layout.
    expect(dialog).to_have_count(0, timeout=30000)


def wait_for_tool_pane(page, pane_id):
    pane = page.locator(f'.pane[data-pane-id="{pane_id}"]')
    expect(pane.locator(".project-tool-host")).to_be_visible(timeout=30000)
    return pane


def select_release(row, marker):
    choice = row.locator(".project-tool-release-choice")
    value = choice.evaluate(
        "(sel, marker) => { const option = [...sel.options].find(o => o.textContent.includes(marker)); return option ? option.value : null; }",
        marker,
    )
    assert value, f"release {marker} not offered"
    choice.select_option(value)


def shot(locator, path):
    """Best-effort element screenshot; the page screenshot always remains."""
    try:
        locator.screenshot(path=path, timeout=15000)
        return True
    except Exception as error:  # CSS3D transforms can make an element uncapturable.
        print(f"NOTE: element screenshot unavailable {path}: {error}")
        return False


def seed_workbench_record(runtime_dir, kind, workspace_id, project_id, record):
    """Explicit synthetic fixture: insert one authoritative-looking private record."""
    value = {"version": 1, "revision": 1, "workspace_id": workspace_id, "project_id": project_id,
             "created_at": int(time.time() * 1000), **record}
    value.setdefault("id", str(uuid.uuid4()))
    connection = sqlite3.connect(os.path.join(runtime_dir, "workspace.sqlite"), timeout=10)
    try:
        connection.execute("PRAGMA busy_timeout=10000")
        connection.execute(
            f"INSERT INTO wb_{kind}(id,workspace_id,project_id,revision,record_json) VALUES (?,?,?,?,?)",
            (value["id"], workspace_id, project_id, 1, json.dumps(value)),
        )
        connection.commit()
    finally:
        connection.close()
    return value


def add_supersede_annotation(runtime_dir, workspace_id, project_id, evidence_id):
    return seed_workbench_record(runtime_dir, "annotations", workspace_id, project_id,
                                 {"kind": "evidence_superseded", "evidence_id": evidence_id,
                                  "note": "synthetic fixture supersession"})


def assert_within_viewport(page, locator, label):
    viewport = page.viewport_size
    box = locator.bounding_box()
    assert box, f"{label} has no layout box"
    assert box["x"] >= -1 and box["y"] >= -1, (label, box, viewport)
    assert box["x"] + box["width"] <= viewport["width"] + 1, (label, box, viewport)
    assert box["y"] + box["height"] <= viewport["height"] + 1, (label, box, viewport)
    return box


def main(renderer):
    with open("/tmp/opencode/comet-next-heavy-check.lock", "w") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        with tempfile.TemporaryDirectory(prefix="comet-project-tools-", dir="/tmp/opencode") as temporary:
            root = Path(temporary)
            for name in ("server", "src", "contracts", "docs", "public", "scripts"):
                if (ROOT / name).is_dir():
                    shutil.copytree(ROOT / name, root / name)
            for name in ("index.html", "package.json", "tsconfig.json", "vite.config.js"):
                if (ROOT / name).is_file():
                    shutil.copy2(ROOT / name, root / name)
            (root / "node_modules").symlink_to(ROOT / "node_modules", target_is_directory=True)
            for name in ("runtime", "home", "cwd", "tmux"):
                (root / name).mkdir()
            build_env = {"HOME": str(root / "home"), "PATH": os.environ["PATH"], "npm_config_cache": str(root / ".npm")}
            build = run(shutil.which("node"), str(ROOT / "scripts/isolated_build.mjs"), "--source", str(root),
                        "--dest", str(root / "dist"), "--allow-source-dist", cwd=root, env=build_env)
            assert (root / "dist" / "index.html").is_file(), f"Build produced no dist/index.html:\n{build.stdout}\n{build.stderr}"

            git_env = {"PATH": os.environ["PATH"], "HOME": str(root / "home"), "GIT_CONFIG_NOSYSTEM": "1", "GIT_CONFIG_GLOBAL": "/dev/null"}
            projects = {}
            for name, filename in (("Project A", "a.py"), ("Project B", "b.py")):
                project = root / name.replace(" ", "-").lower()
                project.mkdir()
                (project / filename).write_text("def value():\n    return 1\n")
                run("git", "init", cwd=project, env=git_env)
                run("git", "add", filename, cwd=project, env=git_env)
                run("git", "-c", "user.email=fixture@example.invalid", "-c", "user.name=Fixture", "commit", "-am", "initial", cwd=project, env=git_env)
                projects[name] = project

            with socket.socket() as probe:
                probe.bind(("127.0.0.1", 0))
                port = probe.getsockname()[1]
            origin = f"http://127.0.0.1:{port}"
            token = secrets.token_urlsafe(36)
            server_env = {"PORT": str(port), "ORBIT_TOKEN": token, "ORBIT_RUNTIME_DIR": str(root / "runtime"),
                          "ORBIT_TMUX_SOCKET": "project-tools-" + str(uuid.uuid4()), "ORBIT_TMUX_CONFIG": "/dev/null", "TMUX_TMPDIR": str(root / "tmux"),
                          "ORBIT_CWD": str(root / "cwd"), "HOME": str(root / "home"), "PATH": os.environ["PATH"]}
            state = {"version": 1, "selected": MONITOR_TERMINAL, "arc": 14, "view": "windows", "monitors": [
                {"id": MONITOR_TERMINAL, "name": "Fixture terminal", "diagonal": 32, "aspect": "16:9", "height": 0, "distance": 0,
                 "pitch": 0, "yaw": 0, "offset": 0, "fontSize": 19,
                 "frame": {"x": 0, "y": 0, "width": 780, "height": 950, "z": 0},
                 "layout": {"type": "pane", "pane": {"id": TERMINAL_PANE, "kind": "terminal", "url": ""}}},
                {"id": MONITOR_AGENT, "name": "Fixture conversation", "diagonal": 32, "aspect": "16:9", "height": 0, "distance": 0,
                 "pitch": 0, "yaw": 0, "offset": 0, "fontSize": 19,
                 "frame": {"x": 800, "y": 0, "width": 780, "height": 950, "z": 1},
                 "layout": {"type": "pane", "pane": {"id": AGENT_PANE, "kind": "agent", "url": ""}}},
            ]}
            with (root / "server.log").open("w+") as log:
                server = subprocess.Popen([shutil.which("node"), "--experimental-strip-types", "server/index.mjs"],
                                          cwd=root, env=server_env, stdout=log, stderr=log)
                try:
                    for _ in range(300):
                        if server.poll() is not None:
                            log.seek(0)
                            raise RuntimeError("Server exited:\n" + log.read().replace(token, "[REDACTED]"))
                        try:
                            with urllib.request.urlopen(origin + "/api/health", timeout=1):
                                break
                        except OSError:
                            time.sleep(.05)
                    else:
                        raise RuntimeError("Server readiness timeout")

                    project_ids = {}
                    with sync_playwright() as playwright:
                        browser = playwright.chromium.launch(headless=True, args=["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"])
                        context = browser.new_context(viewport={"width": 1800, "height": 1200})
                        context.add_init_script("if(window===window.top && !localStorage.getItem('orbit.workspace.id')) {"
                                                "localStorage.setItem('orbit.workspace.id'," + json.dumps(WORKSPACE_ID) + ");"
                                                "localStorage.setItem('orbit.workspace.v1',JSON.stringify(" + json.dumps(state) + "));}")
                        page = context.new_page()
                        errors, agent_requests, websockets = [], [], []
                        # Hold/delay tool writes to exercise the client gate and CAS:
                        #  - read: hold one host data_read across a project revoke
                        #  - save 'hold': keep a save in flight while the owner types again
                        #  - save 'abort': force an unknown save outcome for explicit retry
                        held_routes = []
                        held_saves = []
                        holds = {"read": False, "save": None}

                        def tools_router(route):
                            body = route.request.post_data_json or {}
                            action = body.get("action")
                            if holds["read"] and action == "data_read":
                                holds["read"] = False
                                held_routes.append(route)
                                return
                            if holds["save"] and action == "data_save":
                                mode = holds["save"]
                                holds["save"] = None
                                if mode == "hold":
                                    held_saves.append(route)
                                else:
                                    route.abort()
                                return
                            route.continue_()

                        page.route("**/api/workbench/tools", tools_router)
                        page.on("pageerror", lambda error: errors.append(str(error)))
                        page.on("request", lambda request: agent_requests.append((request.method, request.url, request.post_data)) if request.url.split("?")[0] == origin + "/api/agent" else None)
                        page.on("websocket", lambda websocket: websockets.append(websocket.url))
                        try:
                            page.goto(origin + ("?renderer=docking" if renderer == "docking" else ""), wait_until="domcontentloaded")
                            expect(page.locator("dialog.orbit-onboarding")).to_be_visible()
                            page.keyboard.press("Escape")
                            expect(page.locator("dialog.orbit-onboarding")).not_to_be_visible()
                            connected(page, token)

                            for name, project in projects.items():
                                status, preview = workbench_api(origin, token, {"action": "register_preview", "root": str(project), "name": name})
                                assert status == 200 and preview.get("ok"), preview
                                status, commit = workbench_api(origin, token, {"action": "register_commit", "approval_id": preview["approval_id"]})
                                assert status == 200 and commit.get("ok"), commit
                                project_ids[name] = commit["project"]["id"]

                            # --- create a notebook through the owner tool manager ---
                            dialog = open_workbench(page)
                            open_project(page, dialog, "Project A")
                            create_tool_through_manager(page, dialog, "notebook", "Lab notebook")
                            notebook = instance_by_title(origin, token, "Lab notebook")
                            assert notebook["kind"] == "notebook" and notebook["release_id"]
                            notebook_id = notebook["id"]
                            notebook_pane = pane_for_instance(origin, token, notebook_id)
                            assert notebook_pane, "server did not stage a project-tool pane"
                            pane = wait_for_tool_pane(page, notebook_pane)
                            expect(pane.locator(".project-tool-editor")).to_be_visible(timeout=20000)
                            # Host-rendered: never an embedded frame.
                            assert pane.locator("iframe").count() == 0, "notebook must not be an iframe"
                            assert pane.locator(".browser-nav").count() == 0

                            editor = pane.locator(".project-tool-editor")
                            editor.fill("first note")
                            pane.locator(".project-tool-save").click()
                            expect(pane.locator(".project-tool-status")).to_contain_text("Saved at data revision", timeout=15000)

                            # --- saved data survives a full page reload (drafts are memory only) ---
                            page.reload(wait_until="domcontentloaded")
                            connected(page, token)
                            pane = wait_for_tool_pane(page, notebook_pane)
                            expect(pane.locator(".project-tool-editor")).to_have_value("first note", timeout=20000)

                            # --- stale-revision save conflict retains the draft ---
                            status, loaded = tools_api(origin, token, {"action": "data_read", "project_id": project_ids["Project A"], "instance_id": notebook_id, "pane_id": notebook_pane})
                            assert status == 200 and loaded["ok"], loaded
                            status, external = tools_api(origin, token, {"action": "data_save", "project_id": project_ids["Project A"], "instance_id": notebook_id,
                                                                         "pane_id": notebook_pane, "expected_revision": loaded["revision"], "data": {"text": "external note"},
                                                                         "op_id": str(uuid.uuid4()), "intent": "External fixture save"})
                            assert status == 200 and external["ok"], external
                            editor.fill("local draft kept")
                            pane.locator(".project-tool-save").click()
                            expect(pane.locator(".project-tool-conflict")).to_be_visible(timeout=15000)
                            expect(editor).to_have_value("local draft kept")
                            assert editor.input_value() == "local draft kept"
                            page.once("dialog", lambda confirmation: confirmation.accept())
                            pane.locator(".project-tool-reload").click()
                            expect(editor).to_have_value("external note", timeout=15000)
                            expect(pane.locator(".project-tool-conflict")).not_to_be_visible()

                            # --- an edit made while a save is in flight stays unsaved ---
                            editor.fill("submitted text")
                            holds["save"] = "hold"
                            pane.locator(".project-tool-save").click()
                            expect(pane.locator(".project-tool-pending")).to_contain_text("Saving", timeout=15000)
                            editor.fill("newer edit while saving")
                            deadline = time.time() + 15
                            while not held_saves and time.time() < deadline:
                                page.wait_for_timeout(50)
                            assert held_saves, "the in-flight save was not held"
                            held_saves.pop(0).continue_()
                            expect(pane.locator(".project-tool-status")).to_contain_text("newer local edits are retained", timeout=15000)
                            expect(editor).to_have_value("newer edit while saving")
                            expect(pane.locator(".project-tool-save")).to_be_enabled()
                            status, in_flight = tools_api(origin, token, {"action": "data_read", "project_id": project_ids["Project A"], "instance_id": notebook_id, "pane_id": notebook_pane})
                            assert status == 200 and in_flight["data"]["text"] == "submitted text", in_flight

                            # --- unknown outcome needs an explicit exact-payload retry ---
                            editor.fill("unknown text")
                            holds["save"] = "abort"
                            pane.locator(".project-tool-save").click()
                            expect(pane.locator(".project-tool-pending")).to_contain_text("outcome unknown", timeout=15000)
                            expect(pane.locator(".project-tool-retry")).to_be_visible()
                            expect(pane.locator(".project-tool-save")).to_be_disabled()
                            editor.fill("newer while unknown")
                            pane.locator(".project-tool-retry").click()
                            expect(pane.locator(".project-tool-status")).to_contain_text("newer local edits are retained", timeout=15000)
                            expect(editor).to_have_value("newer while unknown")
                            status, unknown_saved = tools_api(origin, token, {"action": "data_read", "project_id": project_ids["Project A"], "instance_id": notebook_id, "pane_id": notebook_pane})
                            assert status == 200 and unknown_saved["data"]["text"] == "unknown text", unknown_saved

                            # The notes we will prove survive repin / checkpoint / revoke.
                            editor.fill("later notes preserved")
                            pane.locator(".project-tool-save").click()
                            expect(pane.locator(".project-tool-status")).to_contain_text("Saved at data revision", timeout=15000)

                            # Enable the v2 count companion so the release pin can be checked:
                            # v1 must hide it (descriptor gate), v2 must show it.
                            _, meta = tools_api(origin, token, {"action": "metadata_list", "project_id": project_ids["Project A"]})
                            current = next(item for item in meta["instances"] if item["id"] == notebook_id)
                            status, configured = tools_api(origin, token, {"action": "configure", "project_id": project_ids["Project A"], "instance_id": notebook_id,
                                                                           "expected_revision": current["revision"], "config": {"font_size": 16, "show_counts": True},
                                                                           "op_id": str(uuid.uuid4()), "intent": "Fixture count config"})
                            assert status == 200 and configured["ok"], configured

                            # --- repin both ways preserves later notes (release != data) ---
                            dialog = open_workbench(page)
                            open_project(page, dialog, "Project A")
                            row = dialog.locator(f'.project-tool-row[data-instance-id="{notebook_id}"]')
                            expect(row).to_be_visible()
                            row.locator(".project-tool-release-toggle").click()
                            select_release(row, "v2")
                            row.locator(".project-tool-release-apply").click()
                            expect(pane.locator(".project-tool-editor")).to_have_value("later notes preserved", timeout=15000)
                            expect(pane.locator(".project-tool-count")).to_be_visible()
                            expect(pane.locator(".project-tool-count")).to_contain_text("21 characters")
                            status, after_v2 = tools_api(origin, token, {"action": "data_read", "project_id": project_ids["Project A"], "instance_id": notebook_id, "pane_id": notebook_pane})
                            assert status == 200 and after_v2["ok"] and after_v2["data"]["text"] == "later notes preserved", after_v2
                            row.locator(".project-tool-release-toggle").click()
                            select_release(row, "v1")
                            row.locator(".project-tool-release-apply").click()
                            expect(pane.locator(".project-tool-editor")).to_have_value("later notes preserved", timeout=15000)
                            expect(pane.locator(".project-tool-count")).to_be_hidden()
                            status, after_v1 = tools_api(origin, token, {"action": "data_read", "project_id": project_ids["Project A"], "instance_id": notebook_id, "pane_id": notebook_pane})
                            assert status == 200 and after_v1["ok"] and after_v1["data"]["text"] == "later notes preserved", after_v1

                            # --- disposable visual evidence (outside git): desktop + narrow ---
                            shot(dialog.locator(".project-tool-manager"), f"/tmp/opencode/project-tools-{renderer}-manager-desktop.png")
                            page.screenshot(path=f"/tmp/opencode/project-tools-{renderer}-desktop-manager.png", full_page=True)
                            close_workbench(page)
                            close_orbit_menu(page)
                            hide_sidebar(page)
                            pane.scroll_into_view_if_needed()
                            assert_within_viewport(page, pane.locator(".project-tool-editor"), "desktop notebook editor")
                            assert_within_viewport(page, pane.locator(".project-tool-save"), "desktop notebook save")
                            shot(pane.locator(".project-tool-host"), f"/tmp/opencode/project-tools-{renderer}-notebook-desktop.png")
                            page.screenshot(path=f"/tmp/opencode/project-tools-{renderer}-desktop-notebook.png", full_page=True)
                            page.set_viewport_size({"width": 430, "height": 932})
                            page.wait_for_timeout(400)
                            dialog = open_workbench(page)
                            open_project(page, dialog, "Project A")
                            shot(dialog.locator(".project-tool-manager"), f"/tmp/opencode/project-tools-{renderer}-manager-narrow.png")
                            page.screenshot(path=f"/tmp/opencode/project-tools-{renderer}-narrow-manager.png", full_page=True)
                            close_workbench(page)
                            close_orbit_menu(page)
                            hide_sidebar(page)
                            pane.scroll_into_view_if_needed()
                            # Fit the window into the narrow viewport through the existing UI Focus
                            # control. Default (windowed) needs it; docking already fits its pane.
                            focused_window = False
                            if renderer == "default":
                                window_id = window_for_pane(read_snapshot(origin, token), notebook_pane)
                                page.evaluate("(id)=>{const el=document.querySelector('[data-monitor-id=\"'+id+'\"]'); if(el) el.dispatchEvent(new PointerEvent('pointerdown',{bubbles:true}));}", window_id)
                                page.wait_for_timeout(150)
                                page.evaluate("() => { const b=[...document.querySelectorAll('button')].find(x=>x.getAttribute('aria-label')==='Focus selected display'); if(b) b.click(); }")
                                page.wait_for_timeout(400)
                                focused_window = True
                            editor_box = assert_within_viewport(page, pane.locator(".project-tool-editor"), "narrow notebook editor")
                            assert editor_box["width"] <= 431, editor_box
                            assert_within_viewport(page, pane.locator(".project-tool-save"), "narrow notebook save")
                            assert_within_viewport(page, pane.locator(".project-tool-reload"), "narrow notebook reload")
                            shot(pane.locator(".project-tool-host"), f"/tmp/opencode/project-tools-{renderer}-notebook-narrow.png")
                            page.screenshot(path=f"/tmp/opencode/project-tools-{renderer}-narrow-notebook.png", full_page=True)
                            if focused_window:
                                page.evaluate("() => { const b=[...document.querySelectorAll('button')].find(x=>x.getAttribute('aria-label')==='Focus selected display'); if(b) b.click(); }")
                                page.wait_for_timeout(300)
                            page.set_viewport_size({"width": 1800, "height": 1200})
                            page.wait_for_timeout(300)
                            dialog = open_workbench(page)
                            open_project(page, dialog, "Project A")
                            row = dialog.locator(f'.project-tool-row[data-instance-id="{notebook_id}"]')

                            # --- configure-while-disabled, then enable ---
                            row.locator(".project-tool-toggle").click()
                            expect(pane.locator(".project-tool-gate.is-disabled")).to_be_visible(timeout=15000)
                            assert pane.locator(".project-tool-editor").count() == 0
                            row.locator(".project-tool-configure").click()
                            row.get_by_label("Tool font size").fill("20")
                            row.locator(".project-tool-configure-apply").click()
                            deadline = time.time() + 15
                            while time.time() < deadline:
                                _, meta = tools_api(origin, token, {"action": "metadata_list", "project_id": project_ids["Project A"]})
                                current = next(item for item in meta["instances"] if item["id"] == notebook_id)
                                if current["config"].get("font_size") == 20:
                                    break
                                page.wait_for_timeout(200)
                            else:
                                raise AssertionError(f"configure-while-disabled did not apply: {current['config']}")
                            row.locator(".project-tool-toggle").click()
                            expect(pane.locator(".project-tool-editor")).to_have_value("later notes preserved", timeout=15000)
                            assert pane.locator(".project-tool-notebook").evaluate("node => getComputedStyle(node).fontSize") == "20px"
                            expect(pane.locator(".project-tool-count")).to_be_hidden()

                            # --- recovery hold clears private DOM; release never re-enables ---
                            snap = read_snapshot(origin, token)
                            status, held = recovery_api(origin, token, mutation({"action": "recovery_policy", "base_revision": snap["revision"], "held": True, "confirm": True}, "Enter hold"))
                            assert status == 200 and held.get("recovery_policy", {}).get("held") is True, held
                            expect(pane.locator(".project-tool-gate.is-disabled")).to_be_visible(timeout=15000)
                            assert pane.locator(".project-tool-editor").count() == 0
                            snap = read_snapshot(origin, token)
                            status, released = recovery_api(origin, token, mutation({"action": "recovery_policy", "base_revision": snap["revision"], "held": False, "confirm": True}, "Release hold"))
                            assert status == 200 and released.get("recovery_policy", {}).get("held") is False, released
                            expect(pane.locator(".project-tool-gate.is-disabled")).to_be_visible(timeout=15000)
                            assert pane.locator(".project-tool-editor").count() == 0
                            # release must not auto-enable the instance
                            status, held_meta = tools_api(origin, token, {"action": "metadata_list", "project_id": project_ids["Project A"]})
                            released_state = next(item for item in held_meta["instances"] if item["id"] == notebook_id)
                            assert released_state["enabled"] is False, released_state
                            # explicit owner enable after release (refresh metadata first:
                            # the hold transaction bumped the instance revision)
                            if not dialog.is_visible():
                                dialog = open_workbench(page)
                            open_project(page, dialog, "Project A")
                            row = dialog.locator(f'.project-tool-row[data-instance-id="{notebook_id}"]')
                            row.locator(".project-tool-toggle").click()
                            expect(pane.locator(".project-tool-editor")).to_have_value("later notes preserved", timeout=15000)
                            close_workbench(page)

                            # --- layout checkpoint undo preserves notes ---
                            snap = read_snapshot(origin, token)
                            status, checkpoint = workspace_api(origin, token, mutation({"action": "checkpoint", "base_revision": snap["revision"], "label": "Before tool layout change"}, "Fixture checkpoint"))
                            assert status == 200 and checkpoint.get("checkpoint"), checkpoint
                            checkpoint_id = checkpoint["checkpoint"]["id"] if isinstance(checkpoint["checkpoint"], dict) else checkpoint["checkpoint"]
                            snap = read_snapshot(origin, token)
                            tool_window = window_for_pane(snap, notebook_pane)
                            assert tool_window
                            next_state = json.loads(json.dumps(snap["state"]))
                            next_state["monitors"] = [monitor for monitor in next_state["monitors"] if monitor["id"] != tool_window]
                            if next_state["selected"] == tool_window:
                                next_state["selected"] = next_state["monitors"][0]["id"]
                            status, synced = workspace_api(origin, token, mutation({"action": "sync", "base_revision": snap["revision"], "state": next_state}, "Fixture close tool window"))
                            assert status == 200 and synced.get("revision"), synced
                            expect(page.locator(f'.pane[data-pane-id="{notebook_pane}"]')).to_have_count(0, timeout=20000)
                            snap = read_snapshot(origin, token)
                            status, restored = workspace_api(origin, token, mutation({"action": "restore", "checkpoint_id": checkpoint_id, "base_revision": snap["revision"], "confirm": True}, "Fixture restore"))
                            assert status == 200 and restored.get("state"), restored
                            pane = wait_for_tool_pane(page, notebook_pane)
                            expect(pane.locator(".project-tool-editor")).to_have_value("later notes preserved", timeout=20000)
                            status, reread = tools_api(origin, token, {"action": "data_read", "project_id": project_ids["Project A"], "instance_id": notebook_id, "pane_id": notebook_pane})
                            assert status == 200 and reread["ok"] and reread["data"]["text"] == "later notes preserved", reread

                            # --- delayed stale data must not render after project revoke ---
                            status, stale = tools_api(origin, token, {"action": "data_read", "project_id": project_ids["Project A"], "instance_id": notebook_id, "pane_id": notebook_pane})
                            assert status == 200 and stale["ok"] and stale["data"]["text"] == "later notes preserved", stale
                            # Hold the next host data_read (triggered by a repin rebuild), revoke,
                            # then release the stale success late. The client gate must discard it.
                            holds["read"] = True
                            status, meta = tools_api(origin, token, {"action": "metadata_list", "project_id": project_ids["Project A"]})
                            preinst = next(item for item in meta["instances"] if item["id"] == notebook_id)
                            v2 = next(release for release in meta["releases"] if release["definition_id"] == preinst["definition_id"] and release["release"] == "2")
                            status, repinned = tools_api(origin, token, {"action": "repin", "project_id": project_ids["Project A"], "instance_id": notebook_id,
                                                                         "expected_revision": preinst["revision"], "release_id": v2["id"],
                                                                         "op_id": str(uuid.uuid4()), "intent": "Fixture fence repin"})
                            assert status == 200 and repinned["ok"], repinned
                            deadline = time.time() + 15
                            while not held_routes and time.time() < deadline:
                                page.wait_for_timeout(100)
                            assert held_routes, "the host never issued a holdable data_read"
                            status, listed = workbench_api(origin, token, {"action": "list"})
                            project = next(item for item in listed["projects"] if item["id"] == project_ids["Project A"])
                            status, revoked = workbench_api(origin, token, {"action": "revoke_project", "project_id": project_ids["Project A"], "base_generation": project["generation"]})
                            assert status == 200 and revoked.get("ok") and revoked["project"]["active"] is False, revoked
                            expect(pane.locator(".project-tool-gate.is-revoked")).to_be_visible(timeout=20000)
                            assert pane.locator(".project-tool-editor").count() == 0
                            held_routes.pop(0).fulfill(json=stale)
                            page.wait_for_timeout(1500)
                            assert pane.locator(".project-tool-editor").count() == 0, "delayed stale data rendered after revoke"
                            assert pane.locator(".project-tool-gate.is-revoked").is_visible()

                            # --- evidence_checks card over a second project ---
                            dialog = open_workbench(page)
                            open_project(page, dialog, "Project B")
                            create_tool_through_manager(page, dialog, "evidence_checks", "Checks card")
                            checks = instance_by_title(origin, token, "Checks card")
                            assert checks["kind"] == "evidence_checks"
                            checks_pane = pane_for_instance(origin, token, checks["id"])
                            assert checks_pane
                            checks_view = wait_for_tool_pane(page, checks_pane)
                            expect(checks_view.locator(".project-tool-checks")).to_be_visible(timeout=20000)
                            expect(checks_view.locator(".project-tool-check-summary")).to_contain_text("never a pass", timeout=15000)
                            assert checks_view.locator("iframe").count() == 0
                            assert checks_view.locator(".project-tool-editor").count() == 0

                            # --- explicit synthetic retained evidence + exact review, then live updates ---
                            runtime_dir = root / "runtime"
                            candidate = str(uuid.uuid4())
                            candidate_hash = "b" * 64
                            acceptance_digest = "a" * 64
                            evidence_one = seed_workbench_record(runtime_dir, "evidence", WORKSPACE_ID, project_ids["Project B"], {
                                "job_id": str(uuid.uuid4()), "task_id": str(uuid.uuid4()), "candidate_id": candidate,
                                "definition_id": "node-test", "definition_digest": "c" * 64, "verdict": "pass", "exit_code": 0,
                                "timed_out": False, "process_survival_unknown": False,
                                "candidate_hash_before": candidate_hash, "candidate_hash_after": candidate_hash,
                                "acceptance_digest": acceptance_digest, "project_generation": 1,
                                "superseded": False, "revoked": False,
                                "stdout_preview": "SYNTHETIC SECRET BODY", "log_path": "/private/synthetic.log",
                            })
                            seed_workbench_record(runtime_dir, "reviews", WORKSPACE_ID, project_ids["Project B"], {
                                "evidence_ids": [evidence_one["id"]], "decision": "approved",
                                "review_identity": "review-synthetic-exact", "candidate_id": candidate,
                                "candidate_hash": candidate_hash, "acceptance_version": 1,
                                "acceptance_digest": acceptance_digest,
                            })
                            # The card must pick these up on its authorization poll, with no manual refresh.
                            expect(checks_view.locator(".project-tool-check-summary")).to_contain_text("1 recorded evidence record", timeout=20000)
                            expect(checks_view.locator(".project-tool-verdict").first).to_have_text("PASS")
                            expect(checks_view.locator(".project-tool-check").first).to_contain_text("node-test")
                            expect(checks_view.locator(".project-tool-check").first).to_contain_text("review: approved")
                            checks_view.locator(".project-tool-check-details summary").first.click()
                            expect(checks_view.locator(".project-tool-check-details").first).to_contain_text("review-synthetic-exact")
                            expect(checks_view.locator(".project-tool-check-details").first).to_contain_text(evidence_one["id"])
                            assert "SYNTHETIC SECRET BODY" not in checks_view.locator(".project-tool-checks").inner_text()
                            assert "/private/synthetic.log" not in checks_view.locator(".project-tool-checks").inner_text()

                            evidence_two = seed_workbench_record(runtime_dir, "evidence", WORKSPACE_ID, project_ids["Project B"], {
                                "job_id": str(uuid.uuid4()), "task_id": str(uuid.uuid4()), "candidate_id": candidate,
                                "definition_id": "host-regression", "definition_digest": "d" * 64, "verdict": "fail", "exit_code": 1,
                                "timed_out": False, "process_survival_unknown": False,
                                "candidate_hash_before": candidate_hash, "candidate_hash_after": candidate_hash,
                                "acceptance_digest": acceptance_digest, "project_generation": 1,
                                "superseded": False, "revoked": False, "created_at": int(time.time() * 1000) + 1000,
                            })
                            expect(checks_view.locator(".project-tool-check-summary")).to_contain_text("2 recorded evidence record", timeout=20000)
                            expect(checks_view.locator(".project-tool-verdict").filter(has_text="FAIL")).to_have_count(1)

                            add_supersede_annotation(runtime_dir, WORKSPACE_ID, project_ids["Project B"], evidence_one["id"])
                            expect(checks_view.locator(".project-tool-check-summary")).to_contain_text("1 recorded evidence record", timeout=20000)
                            expect(checks_view.locator(".project-tool-check").filter(has_text="node-test")).to_have_count(0)
                            expect(checks_view.locator(".project-tool-check").filter(has_text="host-regression")).to_have_count(1)

                            # --- two-project isolation ---
                            status, meta_a = tools_api(origin, token, {"action": "metadata_list", "project_id": project_ids["Project A"]})
                            status, meta_b = tools_api(origin, token, {"action": "metadata_list", "project_id": project_ids["Project B"]})
                            assert all(item["kind"] == "notebook" for item in meta_a["instances"]), meta_a["instances"]
                            assert all(item["kind"] == "evidence_checks" for item in meta_b["instances"]), meta_b["instances"]

                            # --- unrelated terminal/conversation identities unchanged ---
                            final_ids = dict(pane_ids(read_snapshot(origin, token)))
                            assert TERMINAL_PANE in final_ids and final_ids[TERMINAL_PANE] == "", final_ids
                            assert AGENT_PANE in final_ids and final_ids[AGENT_PANE] == "", final_ids
                            assert not any("/api/terminal" in url for url in websockets), websockets
                            for method, url, body in agent_requests:
                                parsed = json.loads(body) if body else {}
                                assert parsed.get("action") not in ("run", "submit", "start", "create"), (method, url, body)
                            assert not errors, errors

                            page.screenshot(path=f"/tmp/opencode/orbit-project-tools-{renderer}.png", full_page=True)
                            print(f"PASS: renderer={renderer} Chromium={browser.version} notebook_pane={notebook_pane} checks_pane={checks_pane} "
                                  f"page_errors={len(errors)} agent_requests={len(agent_requests)} terminal_websockets={sum('/api/terminal' in url for url in websockets)}")
                        except Exception:
                            page.screenshot(path=f"/tmp/opencode/orbit-project-tools-{renderer}.png", full_page=True,
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


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--renderer", choices=("default", "docking"), required=True)
    args = parser.parse_args()
    main(args.renderer)
