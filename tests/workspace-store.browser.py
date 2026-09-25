"""Real built UI -> SQLite sync/receipt/checkpoint, browser-only fixture surfaces.

No terminal pane, model integration, owner profile, fixed port or live runtime.
"""
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
from playwright.sync_api import sync_playwright, expect

ROOT = Path(__file__).resolve().parents[1]
with tempfile.TemporaryDirectory(prefix="orbit-store-browser-") as temporary:
    root = Path(temporary)
    for name in ("server", "src", "contracts", "dist"):
        shutil.copytree(ROOT / name, root / name)
    (root / "node_modules").symlink_to(ROOT / "node_modules", target_is_directory=True)
    shutil.copy2(ROOT / "package.json", root / "package.json")
    for name in ("runtime", "home", "cwd"):
        (root / name).mkdir()
    with socket.socket() as probe:
        probe.bind(("127.0.0.1", 0))
        port = probe.getsockname()[1]
    origin = f"http://127.0.0.1:{port}"
    token, workspace, window, pane = secrets.token_urlsafe(36), str(uuid.uuid4()), str(uuid.uuid4()), str(uuid.uuid4())
    state = {"version": 1, "selected": window, "arc": 14, "view": "windows", "monitors": [{
        "id": window, "name": "Isolated browser fixture", "diagonal": 32, "aspect": "16:9", "height": 0,
        "distance": 0, "pitch": 0, "yaw": 0, "offset": 0, "fontSize": 19,
        "layout": {"type": "pane", "pane": {"id": pane, "kind": "browser", "url": "orbit://welcome"}}}]}
    env = {"PATH": os.environ["PATH"], "HOME": str(root / "home"), "PORT": str(port), "ORBIT_TOKEN": token,
           "ORBIT_RUNTIME_DIR": str(root / "runtime"), "ORBIT_CWD": str(root / "cwd")}
    server = subprocess.Popen([shutil.which("node"), "--experimental-strip-types", "server/index.mjs"], cwd=root,
                              env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)

    def api(action, **fields):
        request = urllib.request.Request(origin + "/api/workspace", data=json.dumps({"workspace_id": workspace, "action": action, **fields}).encode(),
                                         headers={"Origin": origin, "Authorization": "Bearer " + token, "Content-Type": "application/json"})
        with urllib.request.urlopen(request, timeout=5) as response:
            return json.load(response)

    try:
        for _ in range(100):
            if server.poll() is not None:
                raise RuntimeError("Isolated server exited before readiness")
            try:
                with urllib.request.urlopen(origin + "/api/health", timeout=1): break
            except OSError: time.sleep(.05)
        else: raise RuntimeError("Isolated server startup timed out")
        with sync_playwright() as p:
            browser = p.chromium.launch(headless=True, args=["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"])
            context = browser.new_context(viewport={"width": 1440, "height": 1000})
            context.add_init_script("if(window === window.top) { localStorage.setItem('orbit.workspace.id', " + json.dumps(workspace) + "); localStorage.setItem('orbit.workspace.v1', JSON.stringify(" + json.dumps(state) + ")); }")
            page = context.new_page()
            errors, calls, sockets, event_pages = [], [], [], []
            page.on("pageerror", lambda error: errors.append(str(error)))
            page.on("websocket", lambda socket: sockets.append(socket.url))
            page.on("request", lambda request: calls.append(request.post_data_json) if request.url == origin + "/api/workspace" and request.method == "POST" else None)
            def capture_event_page(request):
                if request.url == origin + "/api/workspace/events":
                    response = request.response()
                    event_pages.append((response.status, response.json()))
            page.on("requestfinished", capture_event_page)
            page.goto(origin + "/", wait_until="networkidle")
            page.keyboard.press("Escape")
            page.get_by_role("button", name="Connect local host", exact=True).click()
            page.get_by_role("textbox", name="Host session token").fill(token)
            page.get_by_role("button", name="Unlock local host", exact=True).click()
            expect(page.locator(".saved")).to_contain_text("Workspace connected", timeout=15000)
            before = api("read")
            assert before["revision"] == 1
            page.get_by_role("button", name="Open orbit menu", exact=True).click()
            page.get_by_role("button", name="Toggle side panel", exact=True).click()
            page.wait_for_function("() => JSON.parse(localStorage.getItem('orbit.workspace.v1')).sidebarHidden === true")
            for _ in range(60):
                after = api("read")
                if after["revision"] == 2: break
                page.wait_for_timeout(100)
            else: raise AssertionError("UI edit was not committed")
            assert after["state"]["sidebarHidden"] is True
            assert after["state"]["monitors"][0]["id"] == window
            assert after["state"]["monitors"][0]["layout"]["pane"]["id"] == pane
            history = api("history")
            assert len(history["checkpoints"]) == 1 and history["checkpoints"][0]["revision"] == 1
            syncs = [call for call in calls if call["action"] == "sync"]
            assert len(syncs) == 2, syncs
            assert all(call.get("operation_id") and call.get("intent") for call in syncs)
            assert [call["base_revision"] for call in syncs] == [0, 1]
            assert all("base_revision" not in call for call in calls if call["action"] == "read")
            for _ in range(50):
                if any(status == 200 and any(event["payload"]["revision"] == 2 for event in body["events"]) for status, body in event_pages): break
                page.wait_for_timeout(100)
            else: raise AssertionError("Built UI did not receive revision 2 through scoped event polling")
            assert all(status == 200 and body["workspace_id"] == workspace for status, body in event_pages)
            assert all("state" not in event["payload"] and "capability" not in event["payload"] for _, body in event_pages for event in body["events"])
            # Publish into this disposable runtime through the real Python/Node
            # index path, then render both pinned versions and restore the first.
            def publish(text, version):
                source = root / ("fixture-" + version)
                source.mkdir()
                (source / "index.html").write_text("<!doctype html><h1>" + text + "</h1>")
                return json.loads(subprocess.check_output([shutil.which("python3"), str(ROOT / "scripts/plugin_publish.py"), str(source), "--id", "browser-fixture", "--version", version, "--title", "Indexed browser fixture", "--runtime", str(root / "runtime")], env={"PATH": os.environ["PATH"]}))
            old = publish("Original indexed bundle", "1.0.0")
            new = publish("Updated indexed bundle", "2.0.0")
            installed = api("plugins_apply", base_revision=after["revision"], operations=[{"action": "plugin_install", "manifest": old}, {"action": "plugin_enable", "plugin_id": old["id"]}])
            expect(page.frame_locator('iframe[src*="' + old["entry"] + '"]').get_by_role("heading", name="Original indexed bundle")).to_be_visible(timeout=15000)
            checkpoint = api("checkpoint", label="Browser fixture original bundle")["checkpoint"]
            updated = api("plugins_apply", base_revision=installed["revision"], operations=[{"action": "plugin_update", "plugin_id": old["id"], "manifest": new}])
            expect(page.frame_locator('iframe[src*="' + new["entry"] + '"]').get_by_role("heading", name="Updated indexed bundle")).to_be_visible(timeout=15000)
            api("restore", base_revision=updated["revision"], checkpoint_id=checkpoint, confirm=True)
            expect(page.frame_locator('iframe[src*="' + old["entry"] + '"]').get_by_role("heading", name="Original indexed bundle")).to_be_visible(timeout=15000)
            assert (root / "runtime/workspace.sqlite").is_file()
            discovery = json.loads((root / "runtime/workspace-access" / (workspace + ".json")).read_text())
            assert "state" not in discovery and discovery["storage"] == "sqlite-v1"
            assert not sockets, "Browser-only fixture must not attach a PTY"
            assert not errors, errors
            print(f"PASS normal UI: keyed sync, SQLite checkpoint, scoped events, indexed bundle publish/update/render and original-version restore; Chromium {browser.version}")
            context.close(); browser.close()
    finally:
        server.terminate()
        try: server.wait(timeout=5)
        except subprocess.TimeoutExpired: server.kill(); server.wait(timeout=5)
