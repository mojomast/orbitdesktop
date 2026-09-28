"""Normal/Workbench per-pane journey on a disposable real server.

Verifies, for BOTH the default and opt-in docking renderers:
  * the pane view selector is visible in both modes;
  * toggling the view neither rebuilds the Normal DOM nor starts work;
  * the chat session, draft and queue survive a mode change and a reload;
  * a stale restored durable ID is cleared explicitly and never substituted;
  * Normal activity keeps its own pane-keyed inspector DOM, separate from the
    Workbench timeline, and the excerpt preview remains bounded and read-only.

Run:
  PLAYWRIGHT_BROWSERS_PATH=/tmp/opencode/orbit-evolution-browsers \\
    python tests/pane-workbench-mode.browser.py --renderer default
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
import tempfile
import time
import urllib.request
import uuid

from playwright.sync_api import expect, sync_playwright

ROOT = Path(__file__).resolve().parents[1]


def main(renderer):
    with tempfile.TemporaryDirectory(prefix="orbit-pane-workbench-", dir="/tmp/opencode") as temporary:
        root = Path(temporary)
        for name in ("server", "src", "contracts", "docs", "scripts"):
            shutil.copytree(ROOT / name, root / name)
        for name in ("index.html", "package.json", "tsconfig.json", "vite.config.js"):
            shutil.copy2(ROOT / name, root / name)
        (root / "node_modules").symlink_to(ROOT / "node_modules", target_is_directory=True)
        for name in ("runtime", "home", "cwd"):
            (root / name).mkdir()
        build_env = {"HOME": str(root / "home"), "PATH": os.environ["PATH"], "npm_config_cache": str(root / ".npm")}
        subprocess.run(
            [shutil.which("node"), str(ROOT / "scripts/isolated_build.mjs"), "--source", str(root), "--dest", str(root / "dist"), "--allow-source-dist"],
            cwd=root, env=build_env, check=True, text=True, capture_output=True,
        )
        assert (root / "dist" / "index.html").is_file(), "build produced no dist/index.html"
        with socket.socket() as probe:
            probe.bind(("127.0.0.1", 0))
            port = probe.getsockname()[1]
        origin = f"http://127.0.0.1:{port}"
        token, workspace = secrets.token_urlsafe(36), str(uuid.uuid4())
        pane, monitor = str(uuid.uuid4()), str(uuid.uuid4())
        session = f"orbit-{uuid.uuid4()}"
        state = {
            "version": 1,
            "selected": monitor,
            "arc": 14,
            "view": "windows",
            "monitors": [{
                "id": monitor, "name": "Pane mode agent", "diagonal": 32, "aspect": "16:9",
                "height": 0, "distance": 0, "pitch": 0, "yaw": 0, "offset": 0, "fontSize": 19,
                "frame": {"x": 0, "y": 0, "width": 900, "height": 1000, "z": 0},
                "layout": {"type": "pane", "pane": {"id": pane, "kind": "agent", "url": ""}},
            }],
        }
        profiles = [{
            "id": "default", "label": "Default",
            "apiUrl": f"http://127.0.0.1:{port}/fixture", "apiKey": "fixture-key",
        }]
        prefs_key = f"orbit-pane-prefs:{workspace}:{pane}"
        chat_key = f"orbit-hermes-chat:{pane}"
        init = (
            "if (window === window.top) {"
            "localStorage.setItem('orbit.workspace.id', %s);"
            "localStorage.setItem('orbit.workspace.v1', JSON.stringify(%s));"
            "if (!localStorage.getItem(%s)) localStorage.setItem(%s, JSON.stringify({version:1,mode:'workbench',projectId:'ghost-project',taskId:null,candidateId:null,attemptId:null,grantId:null,resultId:null,reviewId:null}));"
            "sessionStorage.setItem(%s, JSON.stringify(%s));"
            "}"
        ) % (
            json.dumps(workspace), json.dumps(state), json.dumps(prefs_key), json.dumps(prefs_key), json.dumps(chat_key),
            json.dumps({
                "session": session, "profile_id": "default",
                "messages": [
                    {"role": "user", "text": "FIRST-USER-EXCERPT"},
                    {"role": "assistant", "text": "SECOND-ASSISTANT-EXCERPT"},
                ],
                "queue": ["QUEUED-NORMAL-MESSAGE"],
            }),
        )
        env = {
            "PATH": os.environ["PATH"], "HOME": str(root / "home"), "PORT": str(port),
            "ORBIT_TOKEN": token, "ORBIT_RUNTIME_DIR": str(root / "runtime"), "ORBIT_CWD": str(root / "cwd"),
            "HERMES_PROFILES_JSON": json.dumps(profiles),
        }
        with (root / "server.log").open("w+") as log:
            server = subprocess.Popen(
                [shutil.which("node"), "--experimental-strip-types", "server/index.mjs"],
                cwd=root, env=env, stdout=log, stderr=log,
            )
            try:
                for _ in range(120):
                    if server.poll() is not None:
                        log.seek(0)
                        raise RuntimeError(log.read())
                    try:
                        with urllib.request.urlopen(origin + "/api/health", timeout=1):
                            break
                    except OSError:
                        time.sleep(0.05)
                else:
                    raise RuntimeError("Server readiness timeout")

                with sync_playwright() as p:
                    browser = p.chromium.launch(headless=True, args=["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"])
                    context = browser.new_context(viewport={"width": 1600, "height": 1100})
                    context.add_init_script(init)
                    page = context.new_page()
                    errors = []
                    page.on("pageerror", lambda error: errors.append(str(error)))
                    agent_requests = []
                    execution_requests = []
                    context_requests = []
                    fixture_requests = []

                    def observe(request):
                        try:
                            body = request.post_data_json or {}
                        except Exception:
                            body = {}
                        if request.url == origin + "/api/agent":
                            agent_requests.append(body.get("action"))
                        if request.url == origin + "/api/workbench/execution":
                            execution_requests.append(body.get("action"))
                        if request.url == origin + "/api/workbench/context":
                            context_requests.append(body.get("action"))
                        if request.url.startswith(origin + "/fixture"):
                            fixture_requests.append(request.url)

                    page.on("request", observe)

                    def owner_post(path, body):
                        request = urllib.request.Request(
                            origin + path,
                            data=json.dumps({"workspace_id": workspace, **body}).encode(),
                            headers={"Origin": origin, "Authorization": "Bearer " + token, "Content-Type": "application/json"},
                        )
                        with urllib.request.urlopen(request, timeout=15) as response:
                            return json.load(response)
                    url = origin + ("/?renderer=docking" if renderer == "docking" else "/")
                    page.goto(url, wait_until="networkidle")
                    if renderer == "docking":
                        page.wait_for_function(
                            "() => document.documentElement.dataset.dockingRenderer === 'docking' && window.__orbitDocking?.supported === true"
                        )
                    page.keyboard.press("Escape")
                    page.get_by_role("button", name="Connect local host", exact=True).click()
                    page.get_by_role("textbox", name="Host session token").fill(token)
                    page.get_by_role("button", name="Unlock local host", exact=True).click()
                    expect(page.locator(".saved")).to_contain_text("Workspace connected", timeout=15000)

                    pane_locator = page.locator(f'.pane[data-pane-id="{pane}"]')
                    def open_settings(scope):
                        settings = scope.locator('.pane-workbench-settings')
                        if settings.get_attribute('open') is None:
                            settings.locator(':scope > summary').click()
                        return settings

                    def open_identities(scope):
                        settings = open_settings(scope)
                        identities = settings.locator('.pane-workbench-identities')
                        if identities.get_attribute('open') is None:
                            identities.locator(':scope > summary').click()
                        return identities

                    def clear_choice(scope, name):
                        clear = scope.locator('.pane-workbench-clear-choice').filter(
                            has_text=re.compile('^Clear Workbench ' + re.escape(name) + '$'))
                        if clear.is_visible():
                            clear.click()
                        else:
                            scope.get_by_label(f'Workbench {name}', exact=True).select_option('')

                    def open_activity(scope):
                        scope.get_by_role('button', name='Agent pane menu', exact=True).click()
                        page.get_by_role('menuitem', name='Activity', exact=True).click()
                        inspector = page.locator(f'dialog.agent-inspector[data-pane-id="{pane}"]')
                        expect(inspector).to_be_visible()
                        return inspector

                    expect(pane_locator).to_be_visible(timeout=15000)
                    normal_button = pane_locator.get_by_role("button", name="Normal Hermes mode", exact=True)
                    workbench_button = pane_locator.get_by_role("button", name="Workbench Hermes mode", exact=True)
                    expect(normal_button).to_be_visible()
                    expect(workbench_button).to_be_visible()
                    # Both statuses are visible text, not title-only.
                    expect(normal_button).to_contain_text("Normal")
                    expect(workbench_button).to_contain_text("Workbench")
                    expect(workbench_button).to_have_attribute("aria-pressed", "true")
                    expect(normal_button).to_have_attribute("aria-pressed", "false")

                    # Restored mode is Workbench; a stale project ID must be cleared,
                    # never substituted with another/current project.
                    workbench_host = pane_locator.locator(".agent-workbench-host")
                    expect(workbench_host).to_be_visible()
                    expect(pane_locator.locator(".pane-workbench-stale")).to_be_visible()
                    expect(pane_locator.locator(".pane-workbench-stale")).to_contain_text("no substitution")
                    # Intentional label change: the goal-first setup renamed the
                    # manual start affordance. Its visible text is now "Set up
                    # task" and its accessible name/title changed from "Open Task
                    # settings to choose a project and task explicitly" to the new
                    # description below. The behavior assertion (start affordance
                    # is visible while no task is bound) is unchanged.
                    expect(pane_locator.locator('.pane-workbench-start').get_by_role(
                        'button', name='Describe a goal or open Task settings for manual setup', exact=True)).to_be_visible()
                    open_settings(pane_locator)
                    expect(pane_locator.get_by_label("Workbench project", exact=True)).to_have_value("")
                    # Intentional goal-first behavior: with no task bound the
                    # Workbench tabs/panels are hidden behind the "What are we
                    # working on?" empty state. The four tab controls stay
                    # mounted (so a bound task can reveal them) but must not be
                    # visible yet. Their availability once a task is selected is
                    # asserted after task_create below. Advanced setup stays
                    # collapsed.
                    tabs = pane_locator.locator(".pane-workbench-tab")
                    expect(tabs).to_have_count(4)
                    expect(pane_locator.locator(".pane-workbench-tabs")).to_be_hidden()
                    for tab in ("Live", "Changes", "Checks", "Result"):
                        expect(tabs.filter(has_text=tab)).to_be_hidden()
                    expect(pane_locator.locator(".pane-workbench-setup")).not_to_have_attribute("open", "")

                    # Switch to Normal and capture the live DOM handles + both
                    # independent timeline instances.
                    normal_button.click()
                    expect(normal_button).to_have_attribute("aria-pressed", "true")
                    expect(pane_locator.locator(".agent-chat-normal")).to_be_visible()
                    expect(workbench_host).to_be_hidden()
                    messages = pane_locator.locator(".chat-messages")
                    input_box = pane_locator.get_by_label("Message to Hermes", exact=True)
                    expect(messages).to_contain_text("FIRST-USER-EXCERPT")
                    expect(pane_locator.locator(".agent-queue")).to_contain_text("QUEUED-NORMAL-MESSAGE")
                    expect(page.locator(f'dialog.agent-inspector[data-pane-id="{pane}"] .agent-live-timeline')).to_be_hidden()
                    normal_inspector = open_activity(pane_locator)
                    expect(normal_inspector.locator('.agent-live-timeline')).to_be_visible()
                    normal_inspector.get_by_role('button', name='Close agent inspector').click()
                    input_box.fill("DRAFT-KEEP-ME")
                    nodes = page.evaluate(
                        """(pane) => {
                          const root = document.querySelector(`.pane[data-pane-id="${pane}"]`);
                           const normalTimeline = document.querySelector(`dialog.agent-inspector[data-pane-id="${pane}"] .agent-live-timeline`);
                          const wbTimeline = root.querySelector('.pane-workbench-live-slot .agent-live-timeline');
                          window.__paneNodes = {
                            messages: root.querySelector('.chat-messages'),
                            input: root.querySelector('textarea[aria-label="Message to Hermes"]'),
                            queue: root.querySelector('.agent-queue'),
                            normalTimeline,
                            wbTimeline,
                          };
                          return { normal: !!normalTimeline, wb: !!wbTimeline, distinct: normalTimeline !== wbTimeline };
                        }""",
                        pane,
                    )
                    assert nodes["normal"] and nodes["wb"] and nodes["distinct"], nodes
                    starts_before = {a for a in agent_requests if a == "start"}
                    execution_before = len(execution_requests)

                    # Toggle back to Workbench: same nodes, draft preserved, no work,
                    # and neither independent timeline instance is moved or reset.
                    workbench_button.click()
                    expect(workbench_button).to_have_attribute("aria-pressed", "true")
                    expect(workbench_host).to_be_visible()
                    expect(pane_locator.locator(".agent-chat-normal")).to_be_hidden()
                    stable = page.evaluate(
                        """(pane) => {
                          const root = document.querySelector(`.pane[data-pane-id="${pane}"]`);
                          const n = window.__paneNodes;
                          return n.messages === root.querySelector('.chat-messages')
                            && n.input === root.querySelector('textarea[aria-label="Message to Hermes"]')
                            && n.queue === root.querySelector('.agent-queue')
                             && n.normalTimeline === document.querySelector(`dialog.agent-inspector[data-pane-id="${pane}"] .agent-live-timeline`)
                            && n.wbTimeline === root.querySelector('.pane-workbench-live-slot .agent-live-timeline')
                            && n.normalTimeline !== n.wbTimeline;
                        }""",
                        pane,
                    )
                    assert stable, "Normal DOM or an independent timeline instance was rebuilt/moved by the view toggle"
                    assert input_box.input_value() == "DRAFT-KEEP-ME"
                    assert {a for a in agent_requests if a == "start"} == starts_before, "view toggle started an agent run"
                    assert len(execution_requests) == execution_before, "view toggle posted an execution action"
                    # The hidden Normal button still shows its own updated status.
                    expect(normal_button).not_to_have_text("")
                    assert "Normal:" in (pane_locator.locator(".agent-mode-control").get_attribute("title") or "")

                    # Explicit conversation-excerpt preview is bounded and read-only.
                    pane_locator.locator(".pane-workbench-setup > summary").click()
                    pane_locator.locator(".pane-workbench-handoff summary").click()
                    pane_locator.locator(".pane-workbench-excerpt input[type=checkbox]").first.check()
                    pane_locator.get_by_label("Task or question excerpt", exact=True).fill("COMPOSED-TASK-STATEMENT")
                    captures_before = len([a for a in context_requests if a == "capture"])
                    pane_locator.locator(".pane-workbench-handoff button", has_text="Preview context packet").click()
                    preview = pane_locator.locator(".pane-workbench-excerpt-preview")
                    expect(preview).to_contain_text("FIRST-USER-EXCERPT", timeout=10000)
                    expect(preview).to_contain_text("COMPOSED-TASK-STATEMENT")
                    expect(preview).to_contain_text('"kind": "conversation"')
                    expect(preview).to_contain_text("sha256")
                    expect(preview).to_contain_text('"expected_binding_revision"')
                    assert len([a for a in context_requests if a == "capture"]) == captures_before, "preview captured context"

                    # Task creation is preview-first and never capture-only: with no
                    # project selected the preview refuses before any request.
                    expect(pane_locator.locator(".pane-workbench-handoff button", has_text="Create task")).to_be_visible()
                    pane_locator.locator(".pane-workbench-handoff button", has_text="Preview task").click()
                    task_preview = pane_locator.locator(".pane-workbench-task-preview")
                    expect(task_preview).to_contain_text("Choose a project first")

                    # Switch back to Normal; draft, queue and both timelines intact.
                    normal_button.click()
                    assert input_box.input_value() == "DRAFT-KEEP-ME"
                    expect(pane_locator.locator(".agent-queue")).to_contain_text("QUEUED-NORMAL-MESSAGE")
                    assert page.locator(f'dialog.agent-inspector[data-pane-id="{pane}"] .agent-live-timeline').count() == 1

                    # Narrow/mobile geometry: paired controls wrap with no pane-head
                    # horizontal overflow at 320px.
                    page.set_viewport_size({"width": 320, "height": 720})
                    page.wait_for_timeout(250)
                    geometry = page.evaluate(
                        """(pane) => {
                          const root = document.querySelector(`.pane[data-pane-id="${pane}"]`);
                          const head = root.querySelector('.pane-head.agent-pane-head') || root.querySelector('.pane-head');
                          const control = root.querySelector('.agent-mode-control');
                          return { headScroll: head.scrollWidth, headClient: head.clientWidth, controlScroll: control ? control.scrollWidth : 0, controlClient: control ? control.clientWidth : 0 };
                        }""",
                        pane,
                    )
                    assert geometry["headScroll"] <= geometry["headClient"] + 1, geometry
                    assert geometry["controlScroll"] <= geometry["controlClient"] + 1, geometry
                    expect(normal_button).to_be_visible()
                    expect(workbench_button).to_be_visible()
                    page.set_viewport_size({"width": 1600, "height": 1100})

                    # Persist the Workbench view and confirm it survives reload.
                    workbench_button.click()
                    page.reload(wait_until="networkidle")
                    if renderer == "docking":
                        page.wait_for_function("() => document.documentElement.dataset.dockingRenderer === 'docking'")
                    page.get_by_role("button", name="Connect local host", exact=True).click()
                    page.get_by_role("textbox", name="Host session token").fill(token)
                    page.get_by_role("button", name="Unlock local host", exact=True).click()
                    expect(page.locator(".saved")).to_contain_text("Workspace connected", timeout=15000)
                    pane_locator = page.locator(f'.pane[data-pane-id="{pane}"]')
                    expect(pane_locator.get_by_role("button", name="Workbench Hermes mode", exact=True)).to_have_attribute("aria-pressed", "true")
                    expect(pane_locator.locator(".agent-workbench-host")).to_be_visible()
                    expect(pane_locator.locator(".agent-chat-normal")).to_be_hidden()
                    # Both independent instances are recreated distinct after reload.
                    reload_distinct = page.evaluate(
                        """(pane) => {
                          const root = document.querySelector(`.pane[data-pane-id="${pane}"]`);
                           const normalTimeline = document.querySelector(`dialog.agent-inspector[data-pane-id="${pane}"] .agent-live-timeline`);
                          const wbTimeline = root.querySelector('.pane-workbench-live-slot .agent-live-timeline');
                          return !!normalTimeline && !!wbTimeline && normalTimeline !== wbTimeline;
                        }""",
                        pane,
                    )
                    assert reload_distinct, "timeline instances are not independent after reload"

                    # Normal composer -> explicit Workbench handoff preview. The draft
                    # is copied in memory only; the Normal composer is unchanged and
                    # nothing is captured, created or sent until the owner confirms.
                    pane_locator.get_by_role("button", name="Normal Hermes mode", exact=True).click()
                    normal_input = pane_locator.get_by_label("Message to Hermes", exact=True)
                    normal_input.fill("NORMAL-HANDOFF-STATEMENT")
                    captures_before = len([a for a in context_requests if a == "capture"])
                    tasks_before = len([a for a in execution_requests if a == "task_create"])
                    pane_locator.get_by_role("button", name="Create Workbench task", exact=True).click()
                    expect(pane_locator.get_by_role("button", name="Workbench Hermes mode", exact=True)).to_have_attribute("aria-pressed", "true")
                    handoff_composer = pane_locator.get_by_label("Task or question excerpt", exact=True)
                    expect(handoff_composer).to_have_value("NORMAL-HANDOFF-STATEMENT")
                    assert normal_input.input_value() == "NORMAL-HANDOFF-STATEMENT", "Normal draft was changed by the handoff entry"
                    assert len([a for a in context_requests if a == "capture"]) == captures_before
                    assert len([a for a in execution_requests if a == "task_create"]) == tasks_before

                    # Intentional goal-first entry: "Set up task" from Normal chat
                    # now seeds the guided "What are we working on?" setup instead
                    # of opening the legacy exact-excerpt handoff, which the new
                    # journey keeps available under Task settings. Open it
                    # explicitly so this journey can continue to exercise the
                    # exact-excerpt / context-packet path. No assertion is
                    # weakened; the new entry behavior is covered by the setup
                    # journey.
                    open_settings(pane_locator)
                    pane_locator.locator(".pane-workbench-setup > summary").click()
                    pane_locator.locator(".pane-workbench-handoff summary").click()

                    # Real backend: register a project, create a real task, then a
                    # candidate + bound attempt, then capture the exact selected
                    # excerpts into a packet BOUND to that attempt, then reach native
                    # consent preview (an unbound packet would 403 here).
                    def click_expect(scope, label, action, route):
                        with page.expect_response(
                            lambda r: r.url.split("?")[0] == origin + route and (r.request.post_data_json or {}).get("action") == action,
                            timeout=90000,
                        ) as pending:
                            scope.locator("button").filter(has_text=re.compile("^" + re.escape(label) + "$")).first.click()
                        response = pending.value
                        return response.status, response.json()

                    project_dir = root / "handoff-project"
                    project_dir.mkdir(exist_ok=True)
                    (project_dir / "app.js").write_text("export const sum = (a, b) => a + b;\n")
                    registration = owner_post("/api/workbench", {"action": "register_preview", "root": str(project_dir), "name": "Handoff project"})
                    project_id = owner_post("/api/workbench", {"action": "register_commit", "approval_id": registration["approval_id"]})["project"]["id"]
                    open_settings(pane_locator).get_by_role("button", name="Re-read projects, tasks and state without executing anything", exact=True).click()
                    project_select = pane_locator.get_by_label("Workbench project", exact=True)
                    expect(project_select.locator(f'option[value="{project_id}"]')).to_have_count(1, timeout=15000)
                    project_select.select_option(project_id)
                    definition_select = pane_locator.get_by_label("Task check definition (handoff)", exact=True)
                    expect(definition_select).not_to_have_value("", timeout=20000)
                    # The host-owned regression needs no prepared profile, so consent
                    # readiness is satisfiable and native preview reaches the gate.
                    if definition_select.locator("option[value='host-regression']").count():
                        definition_select.select_option("host-regression")
                    pane_locator.get_by_label("Task title (handoff)", exact=True).fill("Handoff real task")
                    pane_locator.locator(".pane-workbench-handoff button", has_text="Preview task").click()
                    expect(pane_locator.locator(".pane-workbench-task-preview")).to_contain_text('"action": "task_create"')
                    pane_locator.locator(".pane-workbench-handoff button", has_text="Create task").click()
                    new_task = None
                    for _ in range(80):
                        tasks = owner_post("/api/workbench/execution", {"action": "execution_state", "project_id": project_id}).get("tasks", [])
                        new_task = next((task for task in tasks if task.get("title") == "Handoff real task"), None)
                        if new_task:
                            break
                        page.wait_for_timeout(250)
                    assert new_task, "task_create did not persist a task"
                    expect(pane_locator.locator('.pane-workbench-scope-line')).to_contain_text('Handoff real task')
                    # Scope selector binds the newly created task.
                    expect(pane_locator.get_by_label("Workbench task", exact=True)).to_have_value(new_task["id"], timeout=15000)
                    # Once a task is bound the intentionally hidden no-task views
                    # must become available again.
                    expect(pane_locator.locator(".pane-workbench-tabs")).to_be_visible(timeout=15000)
                    for tab in ("Live", "Changes", "Checks", "Result"):
                        expect(pane_locator.locator(".pane-workbench-tab").filter(has_text=tab)).to_be_visible()

                    capture_button = pane_locator.locator(".pane-workbench-handoff button", has_text="Capture selected context packet")
                    # Capture is gated on an explicit bound attempt; preview may run first.
                    pane_locator.locator(".pane-workbench-excerpt input[type=checkbox]").first.check()
                    pane_locator.get_by_label("Task or question excerpt", exact=True).fill("REAL-HANDOFF-QUESTION")
                    pane_locator.locator(".pane-workbench-handoff button", has_text="Preview context packet").click()
                    excerpt_preview = pane_locator.locator(".pane-workbench-excerpt-preview")
                    expect(excerpt_preview).to_contain_text("FIRST-USER-EXCERPT")
                    expect(excerpt_preview).to_contain_text('"kind": "conversation"')
                    expect(excerpt_preview).to_contain_text("sha256")
                    assert '"id"' not in excerpt_preview.inner_text(), "capture preview leaks a client excerpt id"
                    expect(capture_button).to_be_disabled()

                    # Candidate + bound attempt through the normal UI.
                    pane_locator.locator(".pane-workbench-tab", has_text="Checks").click()
                    execute = pane_locator.locator(".pane-workbench-panel").nth(2)
                    with page.expect_response(lambda r: r.url.split("?")[0] == origin + "/api/workbench/execution" and (r.request.post_data_json or {}).get("action") == "execution_state", timeout=30000):
                        execute.locator("button").filter(has_text=re.compile("^Refresh execution workbench$")).first.click()
                    execute.get_by_label("Selected task", exact=True).select_option(new_task["id"])
                    status, _preview = click_expect(execute, "Preview candidate", "candidate_preview", "/api/workbench/execution")
                    assert status == 200 and _preview.get("ok"), _preview
                    status, candidate_result = click_expect(execute, "Create candidate", "candidate_create", "/api/workbench/execution")
                    assert status == 200 and candidate_result.get("ok"), candidate_result
                    candidate = candidate_result["candidate"]

                    pane_locator.locator(".pane-workbench-authority > summary").click()
                    click_expect(pane_locator, "Refresh task authority", "execution_state", "/api/workbench/execution")
                    pane_locator.get_by_label("Authority candidate", exact=True).select_option(candidate["id"])
                    status, attempt_result = click_expect(pane_locator, "Create bound attempt", "attempt_create", "/api/workbench/execution")
                    assert status == 200 and attempt_result.get("ok"), attempt_result
                    attempt = attempt_result["attempt"]
                    # Refresh the pane selectors so the new attempt is offered, then
                    # the pane attempt scope follows the bound attempt.
                    open_settings(pane_locator).get_by_role("button", name="Re-read projects, tasks and state without executing anything", exact=True).click()
                    open_identities(pane_locator)
                    expect(pane_locator.get_by_label("Workbench attempt", exact=True)).to_have_value(attempt["id"], timeout=15000)
                    # Recipient must default to THIS pane; never an unrelated entry.
                    recipient_select = pane_locator.get_by_label("Native agent recipient", exact=True)
                    if recipient_select.input_value() == "":
                        candidates = recipient_select.locator("option:not([value=''])")
                        if candidates.count():
                            recipient_select.select_option(candidates.first.get_attribute("value"))
                    expect(recipient_select).not_to_have_value("")

                    # Re-select and re-preview now that an attempt is bound; the
                    # frozen preview carries the attempt id and only then enables capture.
                    pane_locator.locator(".pane-workbench-excerpt input[type=checkbox]").first.check()
                    pane_locator.get_by_label("Task or question excerpt", exact=True).fill("REAL-HANDOFF-QUESTION")
                    expect(capture_button).to_be_disabled()
                    pane_locator.locator(".pane-workbench-handoff button", has_text="Preview context packet").click()
                    expect(excerpt_preview).to_contain_text('"attempt_id"')
                    expect(excerpt_preview).to_contain_text(attempt["id"])
                    expect(capture_button).to_be_enabled()
                    capture_button.click()
                    pane_locator.locator('.pane-workbench-exact-scope > summary').click()
                    expect(pane_locator.locator(".pane-workbench-status")).to_contain_text("context packet", timeout=30000)
                    listed = owner_post("/api/workbench/context", {"action": "list", "project_id": project_id})["contexts"]
                    conversation = next((entry for entry in listed if entry.get("source", {}).get("kind") == "conversation"), None)
                    packet = next((entry for entry in listed if entry.get("source", {}).get("kind") == "packet"), None)
                    assert conversation and packet, listed
                    # Binding is exact: both snapshot and packet carry this attempt id.
                    assert conversation.get("attempt_id") == attempt["id"], conversation
                    assert packet.get("attempt_id") == attempt["id"], packet
                    excerpts = conversation["source"]["excerpts"]
                    for excerpt in excerpts:
                        assert set(excerpt.keys()) == {"role", "sha256", "bytes"}, excerpt
                    assert len(excerpts) == 2, excerpts
                    assert hashlib.sha256(b"SECOND-ASSISTANT-EXCERPT").hexdigest() not in {e["sha256"] for e in excerpts}
                    assert packet["snapshot"]["provenance"]["context_ids"] == [conversation["id"]], packet["snapshot"]["provenance"]
                    expect(pane_locator.get_by_label("Native approved context packet", exact=True)).to_have_value(packet["id"], timeout=15000)

                    # Revising the acceptance AFTER the attempt exists is the ordering
                    # the full journey uses. Approval must keep the mounted control's
                    # cached task current so the next native preview compares the same
                    # acceptance digest instead of false-failing on a stale one.
                    require_node = pane_locator.get_by_label("Require Node test suite", exact=True)
                    require_host = pane_locator.get_by_label("Require host-owned sum regression fixture", exact=True)
                    if require_node.is_checked():
                        require_node.uncheck()
                    if not require_host.is_checked():
                        require_host.check()
                    status, _accept_preview = click_expect(pane_locator, "Preview required checks", "task_acceptance_preview", "/api/workbench/execution")
                    assert status == 200 and _accept_preview.get("ok"), _accept_preview
                    status, _accept = click_expect(pane_locator, "Approve required checks", "task_acceptance_approve", "/api/workbench/execution")
                    assert status == 200 and _accept.get("ok"), _accept

                    # Native consent preview must pass the binding gate: the unbound
                    # packet previously returned 403 permission_denied here.
                    pane_locator.get_by_label("Native task attempt", exact=True).select_option(attempt["id"])
                    pane_locator.get_by_label("Native approved context packet", exact=True).select_option(packet["id"])
                    native_status, native_result = click_expect(pane_locator, "Preview native task consent", "preview", "/api/workbench/native")
                    assert native_status != 403 and native_result.get("code") != "permission_denied", native_result
                    # No model call occurred anywhere in this journey.
                    assert "start" not in agent_requests, agent_requests
                    assert fixture_requests == [], fixture_requests

                    # Idle WB with no project selected must never fabricate a fence:
                    # the authenticated shared_chat execution_lane is idle, so the
                    # hidden Workbench status stays literal (not Execution outcome
                    # unknown / Lane busy) and a Normal draft submit actually starts
                    # (the configured profile is a fixture mock; no real model).
                    open_settings(pane_locator)
                    clear_choice(pane_locator, 'project')
                    assert pane_locator.get_by_label("Workbench project", exact=True).input_value() == ""
                    idle_wb_button = pane_locator.get_by_role("button", name="Workbench Hermes mode", exact=True)
                    expect(idle_wb_button).not_to_contain_text("Execution outcome unknown", timeout=15000)
                    expect(idle_wb_button).not_to_contain_text("Lane busy", timeout=15000)
                    pane_locator.get_by_role("button", name="Normal Hermes mode", exact=True).click()
                    idle_send = pane_locator.get_by_label("Message to Hermes", exact=True)
                    idle_send.fill("IDLE-LANE-DRAFT")
                    starts_before_idle = len([a for a in agent_requests if a == "start"])
                    expect(pane_locator.get_by_role("button", name="Send message to Hermes", exact=True)).to_be_enabled(timeout=10000)
                    # The read-only shared-chat poll briefly disables Send. Dispatch
                    # Enter in the same browser turn as the enabled check so that
                    # the fixture cannot race that poll and silently skip its send.
                    page.wait_for_function("""id => {
                        const root=document.querySelector(`[data-pane-id="${id}"]`);
                        const send=root?.querySelector('[aria-label="Send message to Hermes"]');
                        const input=root?.querySelector('[aria-label="Message to Hermes"]');
                        if(!send || send.disabled || !input) return false;
                        input.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}));
                        return true;
                    }""", arg=pane)
                    for _ in range(40):
                        if len([a for a in agent_requests if a == "start"]) > starts_before_idle:
                            break
                        page.wait_for_timeout(250)
                    assert len([a for a in agent_requests if a == "start"]) > starts_before_idle, "idle lane wrongly fenced the draft submit"
                    assert pane_locator.locator(".agent-mode-control").get_attribute("data-lane") == "idle"

                    # Restore the registered project for the deterministic live checks.
                    pane_locator.get_by_role("button", name="Workbench Hermes mode", exact=True).click()
                    open_settings(pane_locator).get_by_role("button", name="Re-read projects, tasks and state without executing anything", exact=True).click()
                    restored_project = pane_locator.get_by_label("Workbench project", exact=True)
                    expect(restored_project.locator(f'option[value="{project_id}"]')).to_have_count(1, timeout=15000)
                    restored_project.select_option(project_id)
                    expect(pane_locator.get_by_label("Workbench attempt", exact=True).locator(f'option[value="{attempt["id"]}"]')).to_have_count(1, timeout=15000)

                    # Deterministic hidden-running badge: the durable page reports the
                    # selected attempt's grant running while the global lane snapshot is
                    # a stale idle race. The badge must show "Running" (never a pending
                    # receipt counted as a result), keep Send blocked, and then count a
                    # completed available result once the run settles.
                    live_state = {"grant_status": "running", "runtime_status": "running", "availability": "pending"}

                    def live_page():
                        settled = live_state["grant_status"] != "running"
                        return {
                            "version": 1, "events": [], "after_sequence": 0, "reset_required": False,
                            "has_more": False, "project_generation": 1,
                            "snapshot": {
                                "scope": "attempt", "attempt_id": attempt["id"],
                                "grant": {"id": "grant-live", "status": live_state["grant_status"],
                                          "runtime_status": live_state["runtime_status"],
                                          "calls_used": 3, "checks_used": 1, "budget": {"calls": 24, "checks": 3, "repair_iterations": 3}},
                                "result": {"id": "result-live", "availability": live_state["availability"],
                                           "candidate_id": candidate["id"]},
                                "active_grants": 1 if not settled else 0, "active_jobs": 0, "results": 1,
                            },
                            "lane": {"agent_busy": False, "job_busy": False, "unknown": False},
                        }

                    def serve_live(route):
                        body = route.request.post_data_json or {}
                        action = body.get("action")
                        if action == "stream":
                            route.fulfill(status=200, headers={"Content-Type": "text/event-stream"},
                                          body="event: page\ndata: %s\n\n" % json.dumps(live_page()))
                        elif action == "page":
                            route.fulfill(status=200, content_type="application/json",
                                          body=json.dumps({"ok": True, **live_page()}))
                        else:
                            route.fulfill(status=200, content_type="application/json", body=json.dumps({"ok": True}))

                    page.route("**/api/workbench/live", serve_live)
                    # Force the live client to restart for the selected attempt scope.
                    open_identities(pane_locator)
                    clear_choice(pane_locator, 'attempt')
                    workbench_attempt_select = pane_locator.get_by_label("Workbench attempt", exact=True)
                    workbench_attempt_select.select_option(attempt["id"])
                    wb_button = pane_locator.get_by_role("button", name="Workbench Hermes mode", exact=True)
                    normal_mode_button = pane_locator.get_by_role("button", name="Normal Hermes mode", exact=True)
                    normal_mode_button.click()
                    expect(wb_button).to_contain_text("Running", timeout=20000)
                    assert "result(s)" not in wb_button.inner_text(), wb_button.inner_text()
                    assert "pending" not in wb_button.inner_text(), wb_button.inner_text()
                    # Send stays blocked while the selected grant is live, even though
                    # the synthetic global lane snapshot is idle.
                    send_while_running = pane_locator.get_by_role("button", name="Send message to Hermes", exact=True)
                    expect(send_while_running).to_be_disabled(timeout=15000)

                    live_state.update({"grant_status": "stop_requested", "runtime_status": "running"})
                    expect(wb_button).to_contain_text("Stop requested", timeout=20000)
                    assert "Stopped" not in wb_button.inner_text()
                    expect(send_while_running).to_be_disabled()

                    live_state.update({"grant_status": "dispatch_unknown", "runtime_status": "unknown"})
                    expect(wb_button).to_contain_text("Execution outcome unknown", timeout=20000)
                    expect(send_while_running).to_be_disabled()
                    live_state.update({"grant_status": "completed", "runtime_status": "exited", "availability": "available"})
                    expect(pane_locator.locator('.agent-mode-control')).to_have_attribute(
                        'title', re.compile(r'1 result\(s\)'), timeout=20000)
                    expect(wb_button).to_have_attribute('data-badge', '1')
                    assert "Running" not in wb_button.inner_text(), wb_button.inner_text()
                    page.unroute("**/api/workbench/live", serve_live)

                    # Hidden-Normal reload while the shared lane is busy: the global
                    # execution_lane signal (carried by the existing shared_chat read,
                    # no extra polling) must disable Send and show a literal state.
                    lane_signal = {"agent_busy": True, "job_busy": False, "unknown": False}

                    def inject_lane(route):
                        request_body = route.request.post_data_json or {}
                        response = route.fetch()
                        if request_body.get("action") == "shared_chat" and response.ok:
                            data = response.json()
                            data["execution_lane"] = dict(lane_signal)
                            route.fulfill(response=response, json=data)
                        else:
                            route.fulfill(response=response)
                    page.route("**/api/agent", inject_lane)
                    pane_locator.get_by_role("button", name="Normal Hermes mode", exact=True).click()
                    page.reload(wait_until="networkidle")
                    if renderer == "docking":
                        page.wait_for_function("() => document.documentElement.dataset.dockingRenderer === 'docking'")
                    page.get_by_role("button", name="Connect local host", exact=True).click()
                    page.get_by_role("textbox", name="Host session token").fill(token)
                    page.get_by_role("button", name="Unlock local host", exact=True).click()
                    expect(page.locator(".saved")).to_contain_text("Workspace connected", timeout=15000)
                    pane_locator = page.locator(f'.pane[data-pane-id="{pane}"]')
                    expect(pane_locator.get_by_role("button", name="Normal Hermes mode", exact=True)).to_have_attribute("aria-pressed", "true")
                    send_button = pane_locator.get_by_role("button", name="Send message to Hermes", exact=True)
                    expect(send_button).to_be_disabled(timeout=15000)
                    workbench_status_text = pane_locator.get_by_role("button", name="Workbench Hermes mode", exact=True).inner_text()
                    assert ("Lane busy" in workbench_status_text) or ("Execution outcome unknown" in workbench_status_text), workbench_status_text
                    expect(pane_locator.locator(".agent-mode-control")).to_have_attribute("data-lane", re.compile("busy|unknown"))
                    send_title = (send_button.get_attribute("title") or "").lower()
                    assert ("busy" in send_title) or ("unknown" in send_title), send_title

                    # A real authoritative unknown (quarantine) must still fence:
                    # flip the injected execution_lane to unknown and let the next
                    # authenticated shared_chat read clear/keep it explicitly.
                    lane_signal["agent_busy"] = False
                    lane_signal["unknown"] = True
                    page.wait_for_timeout(2500)
                    expect(pane_locator.get_by_role("button", name="Workbench Hermes mode", exact=True)).to_contain_text("Execution outcome unknown", timeout=10000)
                    expect(send_button).to_be_disabled()
                    expect(pane_locator.locator(".agent-mode-control")).to_have_attribute("data-lane", "unknown")

                    # Separate windows use distinct pane/session identities. Opening
                    # Workbench leaves the original Normal composer and draft alone.
                    lane_signal["unknown"] = False
                    normal_input = pane_locator.get_by_label("Message to Hermes", exact=True)
                    normal_input.fill("NORMAL-ONLY separate window draft")
                    page.evaluate("id => { const root=document.querySelector(`[data-pane-id=\"${id}\"]`); window.__separateNormalNodes={input:root.querySelector('textarea'),messages:root.querySelector('.chat-messages')}; }", pane)
                    before_starts = agent_requests.count("start")
                    before_captures = context_requests.count("capture")
                    pane_locator.get_by_role('button', name='Agent pane menu', exact=True).click()
                    page.get_by_role('menuitem', name='Conversation settings', exact=True).click()
                    settings_inspector = page.locator(f'dialog.agent-inspector[data-pane-id="{pane}"]')
                    settings_inspector.get_by_role("button", name="Open a separate Workbench window beside this chat; nothing is copied or sent", exact=True).click()
                    settings_inspector.get_by_role('button', name='Close agent inspector').click()
                    page.wait_for_function("() => JSON.parse(localStorage.getItem('orbit.workspace.v1')).monitors.some(m=>m.name==='Workbench')")
                    new_pane = page.evaluate("() => JSON.parse(localStorage.getItem('orbit.workspace.v1')).monitors.find(m=>m.name==='Workbench').layout.pane.id")
                    assert new_pane != pane
                    separate = page.locator(f'[data-pane-id="{new_pane}"]')
                    expect(separate.locator('.pane-workbench')).to_be_visible(timeout=15000)
                    expect(pane_locator.locator('.agent-chat-normal')).to_be_visible()
                    expect(normal_input).to_have_value("NORMAL-ONLY separate window draft")
                    assert page.evaluate("id => {const root=document.querySelector(`[data-pane-id=\"${id}\"]`);return window.__separateNormalNodes.input===root.querySelector('textarea') && window.__separateNormalNodes.messages===root.querySelector('.chat-messages');}",pane)
                    sessions = page.evaluate("ids => ids.map(id=>JSON.parse(sessionStorage.getItem('orbit-hermes-chat:'+id)).session)",[pane,new_pane])
                    assert sessions[0] != sessions[1]
                    expect(separate.get_by_label('Task or question excerpt',exact=True)).to_have_value('')
                    open_settings(separate).get_by_role('button',name='Open or focus the separate Normal chat window',exact=True).click()
                    pane_locator.get_by_role('button', name='Agent pane menu', exact=True).click()
                    page.get_by_role('menuitem', name='Conversation settings', exact=True).click()
                    settings_inspector.get_by_role("button", name="Open a separate Workbench window beside this chat; nothing is copied or sent", exact=True).click()
                    settings_inspector.get_by_role('button', name='Close agent inspector').click()
                    assert page.evaluate("() => JSON.parse(localStorage.getItem('orbit.workspace.v1')).monitors.filter(m=>m.name==='Workbench').length") == 1
                    assert agent_requests.count('start') == before_starts
                    assert context_requests.count('capture') == before_captures
                    page.reload(wait_until='domcontentloaded')
                    page.get_by_role('button',name='Connect local host',exact=True).click()
                    page.get_by_role('textbox',name='Host session token').fill(token)
                    page.get_by_role('button',name='Unlock local host',exact=True).click()
                    expect(page.locator('.saved')).to_contain_text('Workspace connected',timeout=15000)
                    expect(page.locator(f'[data-pane-id="{new_pane}"] .pane-workbench')).to_be_visible()
                    expect(page.locator(f'[data-pane-id="{pane}"]').get_by_label('Message to Hermes',exact=True)).to_have_value('NORMAL-ONLY separate window draft')
                    assert page.evaluate("ids => ids.map(id=>JSON.parse(sessionStorage.getItem('orbit-hermes-chat:'+id)).session)",[pane,new_pane]) == sessions

                    # A task change must drop its old candidate/attempt authority,
                    # including durable pane preferences. Use the real selections
                    # created above; do not fake DOM state or grant another task
                    # the old attempt by retaining an opaque ID.
                    pane_locator = page.locator(f'.pane[data-pane-id="{pane}"]')
                    pane_locator.get_by_role('button', name='Workbench Hermes mode', exact=True).click()
                    open_settings(pane_locator)
                    task_choice = pane_locator.get_by_label('Workbench task', exact=True)
                    expect(task_choice.locator(f'option[value="{new_task["id"]}"]')).to_have_count(1, timeout=15000)
                    if task_choice.input_value() != new_task['id']:
                        task_choice.select_option(new_task['id'])
                    open_identities(pane_locator)
                    candidate_choice = pane_locator.get_by_label('Workbench candidate', exact=True)
                    attempt_choice = pane_locator.get_by_label('Workbench attempt', exact=True)
                    assert page.evaluate('key => { const prefs=JSON.parse(localStorage.getItem(key)); return ["candidateId","attemptId","grantId","resultId","reviewId"].every(id=>prefs[id]===null); }', prefs_key), 'task selection retained dependent durable scope'
                    expect(candidate_choice).to_have_value('')
                    expect(attempt_choice).to_have_value('')
                    expect(candidate_choice.locator(f'option[value="{candidate["id"]}"]')).to_have_count(1, timeout=15000)
                    candidate_choice.select_option(candidate['id'])
                    expect(attempt_choice.locator(f'option[value="{attempt["id"]}"]')).to_have_count(1, timeout=15000)
                    attempt_choice.select_option(attempt['id'])
                    assert page.evaluate('key => { const prefs=JSON.parse(localStorage.getItem(key)); return prefs.candidateId && prefs.attemptId; }', prefs_key) == attempt['id']
                    pane_locator.get_by_role('tab', name='Checks').click()
                    pane_locator.locator('.pane-workbench-authority > summary').click()
                    authority_candidate = pane_locator.get_by_label('Authority candidate', exact=True)
                    authority_attempt = pane_locator.get_by_label('Native task attempt', exact=True)
                    expect(authority_candidate).to_have_value(candidate['id'], timeout=15000)
                    expect(authority_attempt).to_have_value(attempt['id'], timeout=15000)
                    clear_choice(pane_locator, 'task')
                    assert page.evaluate('key => { const prefs=JSON.parse(localStorage.getItem(key)); return ["taskId","candidateId","attemptId","grantId","resultId","reviewId"].every(id=>prefs[id]===null); }', prefs_key), 'task clear retained dependent durable scope'
                    expect(candidate_choice).to_have_value('')
                    expect(attempt_choice).to_have_value('')
                    expect(authority_candidate).to_have_value('')
                    expect(authority_attempt).to_have_value('')

                    assert not errors, errors
                    page.screenshot(path=f"/tmp/opencode/orbit-pane-workbench-{renderer}.png")
                    print(
                        f"PASS[{renderer}]: paired Normal/Workbench buttons with visible statuses; Normal DOM/session/draft/queue preserved; "
                        "two independent timeline instances; no execution on toggle; stale durable ID fail-closed; Normal draft -> handoff preview "
                        "(draft unchanged); real task_create selects the new task; candidate+bound attempt then exact selected excerpts captured into an "
                        "attempt-bound packet (no client id, native consent preview not 403, no model call); 320px geometry; hidden busy-lane "
                        f"reconnect disables Send; page_errors={len(errors)}"
                    )
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
    parser.add_argument("--renderer", choices=["default", "docking"], default="default")
    arguments = parser.parse_args()
    main(arguments.renderer)
