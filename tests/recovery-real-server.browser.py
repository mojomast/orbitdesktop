"""Disposable real Node server + deliberately broken renderer/app, never owner runtime.

Run with a pinned Playwright Python environment and isolated browser installation.
Does not test live terminal continuity, persistent safe mode or broker revocation.
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
import urllib.error
import urllib.request
import uuid
from playwright.sync_api import sync_playwright, expect

ROOT = Path(__file__).resolve().parents[1]


def monitor(index, kind):
    return {"id": str(uuid.uuid4()), "name": f"Fixture {index}", "diagonal": 32,
            "aspect": "16:9", "height": 0, "distance": 0, "pitch": 0, "yaw": 0,
            "offset": 0, "fontSize": 19, "layout": {"type": "pane", "pane": {
                "id": str(uuid.uuid4()), "kind": kind, "url": "orbit://welcome"}}}


with tempfile.TemporaryDirectory(prefix="orbit-recovery-real-") as temporary:
    root = Path(temporary)
    # Source copies ensure broken dist fixtures never replace the owner's build.
    for name in ("server", "src", "contracts"):
        shutil.copytree(ROOT / name, root / name)
    (root / "node_modules").symlink_to(ROOT / "node_modules", target_is_directory=True)
    shutil.copy2(ROOT / "package.json", root / "package.json")
    for directory in ("public", "dist", "runtime/apps/bad-app", "home", "cwd"):
        (root / directory).mkdir(parents=True, exist_ok=True)
    for name in ("recovery.html", "recovery.js", "recovery.css"):
        shutil.copy2(ROOT / "public" / name, root / "public" / name)
    (root / "dist/index.html").write_text('<!doctype html><script src="/broken.js"></script>')
    (root / "dist/broken.js").write_text('throw new Error("fixture normal renderer failure");')
    bad_bundle = root / "runtime/apps/bad-app/index.html"
    bad_bundle.write_text('<!doctype html><script>throw new Error("fixture bad plugin failure");</script>')
    with socket.socket() as probe:
        probe.bind(("127.0.0.1", 0))
        port = probe.getsockname()[1]
    origin = f"http://127.0.0.1:{port}"
    token, workspace = secrets.token_urlsafe(36), str(uuid.uuid4())
    env = {"PATH": os.environ["PATH"], "HOME": str(root / "home"), "PORT": str(port),
           "ORBIT_TOKEN": token, "ORBIT_RUNTIME_DIR": str(root / "runtime"), "ORBIT_CWD": str(root / "cwd")}
    server = subprocess.Popen([shutil.which("node"), "--experimental-strip-types", "server/index.mjs"],
                              cwd=root, env=env, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)

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
                with urllib.request.urlopen(origin + "/api/health", timeout=1):
                    break
            except OSError:
                time.sleep(.05)
        else:
            raise RuntimeError("Isolated server readiness timed out")
        monitors = [monitor(1, "terminal"), monitor(2, "browser"), monitor(3, "agent")]
        original = {"version": 1, "monitors": monitors, "selected": monitors[0]["id"], "arc": 14}
        api("sync", state=original)
        checkpoint = api("checkpoint", label="Known-good fixture")["checkpoint"]
        api("plugins_apply", base_revision=1, operations=[
            {"action": "plugin_install", "manifest": {"apiVersion": 1, "id": "bad-app", "version": "1.0.0", "title": "Bad fixture", "entry": "/apps/bad-app/index.html"}},
            {"action": "plugin_enable", "plugin_id": "bad-app"}])
        with sync_playwright() as p:
            browser = p.chromium.launch(headless=True)
            context = browser.new_context(viewport={"width": 1100, "height": 900}, reduced_motion="reduce")
            page = context.new_page()
            errors = []
            page.on("pageerror", lambda error: errors.append(str(error)))
            page.goto(origin + "/")
            page.wait_for_function("document.readyState === 'complete'")
            assert any("normal renderer failure" in error for error in errors), errors
            page.goto(origin + "/apps/bad-app/index.html")
            page.wait_for_function("document.readyState === 'complete'")
            assert any("bad plugin failure" in error for error in errors), errors
            errors.clear()
            requests = []
            page.on("request", lambda request: requests.append(request.url))
            response = page.goto(origin + "/recovery")
            assert "frame-src 'none'" in response.headers["content-security-policy"]
            expect(page.get_by_role("heading", name="Recovery console")).to_be_visible()
            page.get_by_label("Owner token", exact=True).fill(token)
            page.get_by_label("Workspace ID", exact=True).fill(workspace)
            page.get_by_label("Workspace ID", exact=True).press("Tab")
            expect(page.get_by_role("button", name="Connect", exact=True)).to_be_focused()
            page.keyboard.press("Enter")
            expect(page.get_by_role("status")).to_contain_text("Connected at revision 2")
            page.get_by_label("I understand this is layout-only and does not stop backends").check()
            page.get_by_role("button", name="Disable all apps", exact=True).click()
            expect(page.get_by_role("status")).to_contain_text("accepted at revision 3")
            disabled = api("read")
            assert disabled["state"]["monitors"] == original["monitors"]
            assert disabled["state"]["plugins"][0]["enabled"] is False
            page.get_by_role("button", name="Read again", exact=True).click()
            expect(page.get_by_role("status")).to_contain_text("Connected at revision 3")
            page.locator(f'input[name="checkpoint"][value="{checkpoint}"]').check()
            page.get_by_label("I understand this restores saved workspace layout state").check()
            page.get_by_role("button", name="Restore checkpoint", exact=True).click()
            expect(page.get_by_role("status")).to_contain_text("accepted at revision 4")
            assert api("read")["state"] == original
            assert bad_bundle.exists(), "Layout recovery must not delete bundles/external effects"
            assert not errors, errors
            assert not any("/apps/" in url or "/assets/" in url or "/api/terminal" in url or "/api/agent" in url for url in requests), requests
            assert page.locator("iframe").count() == 0
            assert page.evaluate("localStorage.length + sessionStorage.length") == 0
            page.set_viewport_size({"width": 390, "height": 844})
            page.emulate_media(forced_colors="active", reduced_motion="reduce")
            assert page.evaluate("document.documentElement.scrollWidth <= innerWidth"), "Narrow recovery UI overflows"
            print(f"PASS real Node recovery: broken renderer + executed bad app; disable/restore revision 4; keyboard/narrow/forced-colors; Chromium {browser.version}")
            context.close()
            browser.close()
    finally:
        server.terminate()
        try:
            server.wait(timeout=5)
        except subprocess.TimeoutExpired:
            server.kill()
            server.wait(timeout=5)
        server.stderr.close()
