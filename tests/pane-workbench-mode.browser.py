"""Normal/Workbench per-pane journey on a disposable real server.

Verifies, for BOTH the default and opt-in docking renderers:
  * the pane view selector is visible in both modes;
  * toggling the view neither rebuilds the Normal DOM nor starts work;
  * the chat session, draft and queue survive a mode change and a reload;
  * a stale restored durable ID is cleared explicitly and never substituted;
  * the explicit conversation-excerpt preview is bounded and read-only.

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
                    expect(pane_locator.get_by_label("Workbench project", exact=True)).to_have_value("")
                    # Live stays dominant; advanced setup is collapsed.
                    tabs = pane_locator.locator(".pane-workbench-tab")
                    expect(tabs).to_have_count(4)
                    for tab in ("Live", "Changes", "Checks", "Result"):
                        expect(tabs.filter(has_text=tab)).to_be_visible()
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
                    expect(pane_locator.locator(".agent-chat-normal .agent-live-timeline")).to_be_visible()
                    input_box.fill("DRAFT-KEEP-ME")
                    nodes = page.evaluate(
                        """(pane) => {
                          const root = document.querySelector(`.pane[data-pane-id="${pane}"]`);
                          const normalTimeline = root.querySelector('.agent-chat-normal .agent-live-timeline');
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
                            && n.normalTimeline === root.querySelector('.agent-chat-normal .agent-live-timeline')
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
                    expect(pane_locator.locator(".agent-chat-normal .agent-live-timeline")).to_be_visible()

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
                          const normalTimeline = root.querySelector('.agent-chat-normal .agent-live-timeline');
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

                    # Real backend: register a project, create a real task, then capture
                    # the exact selected excerpts into a selectable packet.
                    project_dir = root / "handoff-project"
                    project_dir.mkdir(exist_ok=True)
                    (project_dir / "app.js").write_text("export const sum = (a, b) => a + b;\n")
                    registration = owner_post("/api/workbench", {"action": "register_preview", "root": str(project_dir), "name": "Handoff project"})
                    project_id = owner_post("/api/workbench", {"action": "register_commit", "approval_id": registration["approval_id"]})["project"]["id"]
                    pane_locator.get_by_role("button", name="Re-read projects, tasks and state without executing anything", exact=True).click()
                    project_select = pane_locator.get_by_label("Workbench project", exact=True)
                    expect(project_select.locator(f'option[value="{project_id}"]')).to_have_count(1, timeout=15000)
                    project_select.select_option(project_id)
                    definition_select = pane_locator.get_by_label("Task check definition (handoff)", exact=True)
                    expect(definition_select).not_to_have_value("", timeout=20000)
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
                    # Scope selector binds the newly created task.
                    expect(pane_locator.get_by_label("Workbench task", exact=True)).to_have_value(new_task["id"], timeout=15000)

                    # Capture the exact selected conversation excerpts into a packet.
                    pane_locator.locator(".pane-workbench-excerpt input[type=checkbox]").first.check()
                    pane_locator.get_by_label("Task or question excerpt", exact=True).fill("REAL-HANDOFF-QUESTION")
                    pane_locator.locator(".pane-workbench-handoff button", has_text="Preview context packet").click()
                    excerpt_preview = pane_locator.locator(".pane-workbench-excerpt-preview")
                    expect(excerpt_preview).to_contain_text("FIRST-USER-EXCERPT")
                    expect(excerpt_preview).to_contain_text('"kind": "conversation"')
                    expect(excerpt_preview).to_contain_text("sha256")
                    assert '"id"' not in excerpt_preview.inner_text(), "capture preview leaks a client excerpt id"
                    pane_locator.locator(".pane-workbench-handoff button", has_text="Capture selected context packet").click()
                    expect(pane_locator.locator(".pane-workbench-status")).to_contain_text("context packet", timeout=20000)
                    listed = owner_post("/api/workbench/context", {"action": "list", "project_id": project_id})["contexts"]
                    conversation = next((entry for entry in listed if entry.get("source", {}).get("kind") == "conversation"), None)
                    packet = next((entry for entry in listed if entry.get("source", {}).get("kind") == "packet"), None)
                    assert conversation and packet, listed
                    excerpts = conversation["source"]["excerpts"]
                    for excerpt in excerpts:
                        assert set(excerpt.keys()) == {"role", "sha256", "bytes"}, excerpt
                    # Only the explicitly selected message + composed statement are stored.
                    assert len(excerpts) == 2, excerpts
                    assert hashlib.sha256(b"SECOND-ASSISTANT-EXCERPT").hexdigest() not in {e["sha256"] for e in excerpts}
                    # The packet freezes exactly the captured context.
                    assert packet["snapshot"]["provenance"]["context_ids"] == [conversation["id"]], packet["snapshot"]["provenance"]
                    # The packet is selectable in the mounted authority control.
                    pane_locator.locator(".pane-workbench-authority > summary").click()
                    expect(pane_locator.get_by_label("Native approved context packet", exact=True)).to_have_value(packet["id"], timeout=15000)
                    # No model call occurred anywhere in this journey.
                    assert "start" not in agent_requests, agent_requests
                    assert fixture_requests == [], fixture_requests

                    # Hidden-Normal reload while the shared lane is busy: the global
                    # execution_lane signal (carried by the existing shared_chat read,
                    # no extra polling) must disable Send and show a literal state.
                    def inject_lane(route):
                        request_body = route.request.post_data_json or {}
                        response = route.fetch()
                        if request_body.get("action") == "shared_chat" and response.ok:
                            data = response.json()
                            data["execution_lane"] = {"agent_busy": True, "job_busy": False, "unknown": False}
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

                    assert not errors, errors
                    page.screenshot(path=f"/tmp/opencode/orbit-pane-workbench-{renderer}.png")
                    print(
                        f"PASS[{renderer}]: paired Normal/Workbench buttons with visible statuses; Normal DOM/session/draft/queue preserved; "
                        "two independent timeline instances; no execution on toggle; stale durable ID fail-closed; Normal draft -> handoff preview "
                        "(draft unchanged); real task_create selects the new task; exact selected excerpts captured into a selectable packet with "
                        f"no client id and no model call; 320px geometry; hidden busy-lane reconnect disables Send; page_errors={len(errors)}"
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
