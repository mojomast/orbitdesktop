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
import json
import os
from pathlib import Path
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
            "localStorage.setItem(%s, JSON.stringify({version:1,mode:'workbench',projectId:'ghost-project',taskId:null,candidateId:null,attemptId:null,grantId:null,resultId:null,reviewId:null}));"
            "sessionStorage.setItem(%s, JSON.stringify(%s));"
            "}"
        ) % (
            json.dumps(workspace), json.dumps(state), json.dumps(prefs_key), json.dumps(chat_key),
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

                    page.on("request", observe)
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
                    selector = pane_locator.get_by_label("Pane view", exact=True)
                    expect(selector).to_be_visible()
                    expect(selector).to_have_value("workbench")

                    # Restored mode is Workbench; a stale project ID must be cleared,
                    # never substituted with another/current project.
                    workbench_host = pane_locator.locator(".agent-workbench-host")
                    expect(workbench_host).to_be_visible()
                    expect(pane_locator.locator(".pane-workbench-stale")).to_be_visible()
                    expect(pane_locator.locator(".pane-workbench-stale")).to_contain_text("no substitution")
                    expect(pane_locator.get_by_label("Workbench project", exact=True)).to_have_value("")
                    tabs = pane_locator.locator(".pane-workbench-tab")
                    expect(tabs).to_have_count(4)
                    for tab in ("Live", "Changes", "Checks", "Result"):
                        expect(tabs.filter(has_text=tab)).to_be_visible()

                    # Switch to Normal and capture the live DOM handles + draft.
                    selector.select_option("normal")
                    expect(pane_locator.locator(".agent-chat-normal")).to_be_visible()
                    expect(workbench_host).to_be_hidden()
                    messages = pane_locator.locator(".chat-messages")
                    input_box = pane_locator.get_by_label("Message to Hermes", exact=True)
                    expect(messages).to_contain_text("FIRST-USER-EXCERPT")
                    expect(pane_locator.locator(".agent-queue")).to_contain_text("QUEUED-NORMAL-MESSAGE")
                    input_box.fill("DRAFT-KEEP-ME")
                    page.evaluate(
                        """(pane) => {
                          const root = document.querySelector(`.pane[data-pane-id="${pane}"]`);
                          window.__paneNodes = {
                            messages: root.querySelector('.chat-messages'),
                            input: root.querySelector('textarea[aria-label="Message to Hermes"]'),
                            queue: root.querySelector('.agent-queue'),
                          };
                        }""",
                        pane,
                    )
                    starts_before = {a for a in agent_requests if a == "start"}
                    execution_before = len(execution_requests)

                    # Toggle back to Workbench: same nodes, draft preserved, no work.
                    selector.select_option("workbench")
                    expect(workbench_host).to_be_visible()
                    expect(pane_locator.locator(".agent-chat-normal")).to_be_hidden()
                    expect(selector).to_be_visible()
                    same = page.evaluate(
                        """(pane) => {
                          const root = document.querySelector(`.pane[data-pane-id="${pane}"]`);
                          return window.__paneNodes.messages === root.querySelector('.chat-messages')
                            && window.__paneNodes.input === root.querySelector('textarea[aria-label="Message to Hermes"]')
                            && window.__paneNodes.queue === root.querySelector('.agent-queue');
                        }""",
                        pane,
                    )
                    assert same, "Normal DOM nodes were rebuilt by the view toggle"
                    assert input_box.input_value() == "DRAFT-KEEP-ME"
                    assert {a for a in agent_requests if a == "start"} == starts_before, "view toggle started an agent run"
                    assert len(execution_requests) == execution_before, "view toggle posted an execution action"
                    assert selector.get_attribute("title").startswith("Normal: ")

                    # Explicit conversation-excerpt preview is bounded and read-only.
                    pane_locator.locator(".pane-workbench-handoff summary").click()
                    pane_locator.locator(".pane-workbench-excerpt input[type=checkbox]").first.check()
                    pane_locator.get_by_label("Task or question excerpt", exact=True).fill("COMPOSED-TASK-STATEMENT")
                    captures_before = len([a for a in context_requests if a == "capture"])
                    pane_locator.locator("button", has_text="Preview exact bytes").click()
                    preview = pane_locator.locator(".pane-workbench-excerpt-preview")
                    expect(preview).to_contain_text("FIRST-USER-EXCERPT", timeout=10000)
                    expect(preview).to_contain_text("COMPOSED-TASK-STATEMENT")
                    expect(preview).to_contain_text('"kind": "conversation"')
                    expect(preview).to_contain_text("sha256")
                    expect(preview).to_contain_text('"expected_binding_revision"')
                    assert len([a for a in context_requests if a == "capture"]) == captures_before, "preview captured context"

                    # Switch back to Normal; draft and queue intact.
                    selector.select_option("normal")
                    assert input_box.input_value() == "DRAFT-KEEP-ME"
                    expect(pane_locator.locator(".agent-queue")).to_contain_text("QUEUED-NORMAL-MESSAGE")

                    # Persist the Workbench view and confirm it survives reload.
                    selector.select_option("workbench")
                    page.reload(wait_until="networkidle")
                    if renderer == "docking":
                        page.wait_for_function("() => document.documentElement.dataset.dockingRenderer === 'docking'")
                    page.get_by_role("button", name="Connect local host", exact=True).click()
                    page.get_by_role("textbox", name="Host session token").fill(token)
                    page.get_by_role("button", name="Unlock local host", exact=True).click()
                    expect(page.locator(".saved")).to_contain_text("Workspace connected", timeout=15000)
                    pane_locator = page.locator(f'.pane[data-pane-id="{pane}"]')
                    expect(pane_locator.get_by_label("Pane view", exact=True)).to_have_value("workbench")
                    expect(pane_locator.locator(".agent-workbench-host")).to_be_visible()
                    expect(pane_locator.locator(".agent-chat-normal")).to_be_hidden()

                    assert not errors, errors
                    page.screenshot(path=f"/tmp/opencode/orbit-pane-workbench-{renderer}.png")
                    print(
                        f"PASS[{renderer}]: view selector visible in both modes; Normal DOM/session/draft/queue preserved; "
                        "no execution on toggle; stale durable ID cleared without substitution; bounded excerpt preview only; "
                        f"mode persisted across reload; page_errors={len(errors)}"
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
