"""Static built-UI import regressions; browser-only panes, no host connection/PTY."""
import functools
import http.server
import json
from pathlib import Path
import threading
import uuid
from playwright.sync_api import sync_playwright, expect

ROOT = Path(__file__).resolve().parents[1]
ids = [str(uuid.uuid4()), str(uuid.uuid4())]
def monitor(index):
    return {"id": ids[index], "name": "Import fixture " + str(index), "diagonal": 32,
            "aspect": "16:9", "height": 0, "distance": 0, "pitch": 0, "yaw": 0,
            "offset": 0, "fontSize": 19, "layout": {"type": "pane", "pane": {
                "id": str(uuid.uuid4()), "kind": "browser", "url": "orbit://welcome"}}}
state = {"version": 1, "selected": ids[0], "arc": 14, "view": "spatial", "monitors": [monitor(0), monitor(1)]}
class Handler(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *_args): pass

server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), functools.partial(Handler, directory=str(ROOT / "dist")))
thread = threading.Thread(target=server.serve_forever, daemon=True)
thread.start()
try:
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True, args=["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"])
        context = browser.new_context(viewport={"width": 1440, "height": 1000})
        context.add_init_script("if(window === window.top) localStorage.setItem('orbit.workspace.v1', JSON.stringify(" + json.dumps(state) + "));")
        page = context.new_page()
        errors, sockets = [], []
        page.on("pageerror", lambda error: errors.append(str(error)))
        page.on("websocket", lambda socket: sockets.append(socket.url))
        page.goto(f"http://127.0.0.1:{server.server_port}/", wait_until="networkidle")
        page.keyboard.press("Escape")
        expect(page.locator("[data-anchor-id]")).to_have_count(2)
        def import_state(next_state):
            page.locator('input[type="file"]').set_input_files({"name": "fixture.json", "mimeType": "application/json", "buffer": json.dumps(next_state).encode()})
            page.get_by_role("button", name="Confirm change", exact=True).click()
            expect(page.locator("article.monitor")).to_have_count(len(next_state["monitors"]))
            for item in next_state["monitors"]:
                window = page.locator(f'article.monitor[data-monitor-id="{item["id"]}"]')
                expect(window).to_be_visible()
                expect(window.locator(".pane")).to_have_count(1)
        import_state(state)
        expect(page.locator(".workspace.windows-mode")).to_have_count(0)
        import_state({**state, "view": "windows"})
        expect(page.locator(".workspace.windows-mode")).to_have_count(1)
        import_state({**state, "view": "windows", "monitors": state["monitors"][:1]})
        expect(page.locator(f'[data-anchor-id="{ids[1]}"]')).to_have_count(0)
        assert not errors, errors
        assert not sockets, "Import fixture must not connect a host terminal"
        print(f"PASS import: same-ID spatial replacement remains visible, Spatial→Windows classes reconcile, removed anchors are pruned in Windows; Chromium {browser.version}")
        context.close(); browser.close()
finally:
    server.shutdown(); server.server_close(); thread.join(timeout=5)
