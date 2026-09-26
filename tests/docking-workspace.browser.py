"""Real main.ts optional-docking acceptance; disposable server/profile/runtime only.

Build first: npm run build
Run: PLAYWRIGHT_BROWSERS_PATH=/tmp/opencode/orbit-evolution-browsers \
  /tmp/opencode/orbit-evolution-browser-venv/bin/python tests/docking-workspace.browser.py --pty
Omit --pty for browser-only evidence. Missing capabilities/builds fail, never skip.
The frozen interface is /tmp/opencode/orbit-optional-docking-contract.md.
No model is called; iframe drafts and shell continuity are the only runtime claims.
"""

import argparse
import base64
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
PLUGIN = "docking-workspace-fixture"


def fresh_build():
    """Do not silently test a spike, missing build, or pre-integration main bundle."""
    index = ROOT / "dist/index.html"
    adapter = ROOT / "src/docking-renderer.ts"
    if not index.is_file() or not adapter.is_file():
        raise RuntimeError("Integrated docking source/dist missing; finish integration and npm run build")
    assets = list((ROOT / "dist").rglob("*.js"))
    built = "\n".join(p.read_text() for p in assets)
    if not all(marker in built for marker in ("dockingRenderer", "docking-toolbar", "renderer", "docking")):
        raise RuntimeError("dist lacks the optional docking contract/flag; npm run build required")
    inputs = [p for p in (ROOT / "src").rglob("*") if p.is_file()]
    inputs += [ROOT / "package.json", ROOT / "package-lock.json", ROOT / "index.html"]
    inputs += list(ROOT.glob("vite.config.*"))
    newest = max(inputs, key=lambda p: p.stat().st_mtime_ns)
    if newest.stat().st_mtime_ns > index.stat().st_mtime_ns:
        raise RuntimeError(f"dist is stale relative to {newest.relative_to(ROOT)}; npm run build required")


def seed(context, workspace, state):
    context.add_init_script("if(window===window.top){"
        "localStorage.setItem('orbit.onboarding.v1','done');"
        "localStorage.setItem('orbit.menu.pinned','true');"
        "localStorage.setItem('orbit.workspace.id'," + json.dumps(workspace) + ");"
        "localStorage.setItem('orbit.workspace.v1',JSON.stringify(" + json.dumps(state) + "));}")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--screenshot', type=Path, help='Optional screenshot of synthetic initial fixture only')
    parser.add_argument("--pty", action="store_true", help="require a private tmux live-shell probe at every transition")
    args = parser.parse_args()
    if args.pty and (not shutil.which("tmux") or
                    "ORBIT_TMUX_SOCKET" not in (ROOT / "server/local-host.mjs").read_text()):
        parser.error("PTY requires tmux and ORBIT_TMUX_SOCKET override; this is not a passing skip")
    fresh_build()
    with tempfile.TemporaryDirectory(prefix="orbit-docking-workspace-", dir="/tmp/opencode") as temporary:
        root = Path(temporary)
        for name in ("server", "src", "contracts", "dist", "scripts"):
            shutil.copytree(ROOT / name, root / name)
        (root / "node_modules").symlink_to(ROOT / "node_modules", target_is_directory=True)
        shutil.copy2(ROOT / "package.json", root / "package.json")
        for name in ("runtime", "home", "cwd", "tmux", "fixture"):
            (root / name).mkdir(mode=0o700)
        shutil.copy2(ROOT / "tests/fixtures/runtime-continuity.html", root / "fixture/index.html")
        publish_env = {"PATH": os.environ["PATH"], "HOME": str(root / "home")}

        def publish(version):
            return json.loads(subprocess.check_output([
                shutil.which("python3"), str(ROOT / "scripts/plugin_publish.py"), str(root / "fixture"),
                "--id", PLUGIN, "--version", version, "--title", "Docking acceptance fixture",
                "--runtime", str(root / "runtime")], cwd=root, env=publish_env, text=True, timeout=60))

        manifest = publish("1.0.0")
        with socket.socket() as probe:
            probe.bind(("127.0.0.1", 0))
            port = probe.getsockname()[1]
        origin = f"http://127.0.0.1:{port}"
        token, workspace = secrets.token_urlsafe(36), str(uuid.uuid4())
        windows = [str(uuid.uuid4()) for _ in range(2 + int(args.pty))]
        panes = [str(uuid.uuid4()) for _ in windows]
        extra = str(uuid.uuid4())
        monitors = []
        for i, wid in enumerate(windows):
            monitors.append({"id": wid, "name": f"Docking fixture {i}", "diagonal": 32,
                "aspect": "16:9", "height": 0, "distance": 0, "pitch": 0, "yaw": 0,
                "offset": 0, "fontSize": 19,
                "frame": {"x": 30 + 220 * i, "y": 30 + 45 * i, "width": 620, "height": 510, "z": i + 1},
                "layout": {"type": "pane", "pane": {"id": panes[i],
                    "kind": "terminal" if i == 2 else "browser",
                    "url": "orbit://welcome" if i == 2 else manifest["entry"]}}})
        # A stable extra welcome pane makes close_pane valid after checkpoint restore.
        monitors[0]["layout"] = {"type": "split", "axis": "row", "ratio": .5,
            "first": monitors[0]["layout"], "second": {"type": "pane", "pane": {
                "id": extra, "kind": "browser", "url": "orbit://welcome"}}}
        state = {"version": 1, "selected": windows[0], "arc": 14, "view": "windows", "monitors": monitors}
        tmux_name = "orbit-dock-" + secrets.token_hex(8)
        env = {**publish_env, "PORT": str(port), "ORBIT_TOKEN": token,
            "ORBIT_RUNTIME_DIR": str(root / "runtime"), "ORBIT_CWD": str(root / "cwd"),
            "TMUX_TMPDIR": str(root / "tmux"), "ORBIT_TMUX_SOCKET": tmux_name,
            "ORBIT_TMUX_CONFIG": "/dev/null", "TERM": "xterm-256color"}

        def api(action, control=False, recovery=False, reject=None, **fields):
            credential = json.loads((root / "runtime/workspace-access" / (workspace + ".json")).read_text())["capability"] if control else token
            endpoint = "/api/workspace" + ("/control" if control else "/recovery" if recovery else "")
            request = urllib.request.Request(origin + endpoint,
                data=json.dumps({"workspace_id": workspace, "action": action, **fields}).encode(),
                headers={"Origin": origin, "Authorization": "Bearer " + credential, "Content-Type": "application/json"})
            try:
                with urllib.request.urlopen(request, timeout=15) as response:
                    result = json.load(response)
            except urllib.error.HTTPError as error:
                result = json.load(error)
                if reject is not None:
                    assert error.code == reject, (action, error.code, result)
                    return result
                raise AssertionError(f"{action}: HTTP {error.code}: {result}") from error
            assert reject is None, f"{action}: expected HTTP {reject}, got success"
            return result

        server_log = root / "server.err"
        server = subprocess.Popen([shutil.which("node"), "--experimental-strip-types", "server/index.mjs"],
            cwd=root, env=env, stdout=open(server_log, "wb"), stderr=subprocess.STDOUT)
        try:
            for _ in range(160):
                if server.poll() is not None:
                    raise RuntimeError("Disposable server exited before readiness")
                try:
                    with urllib.request.urlopen(origin + "/api/health", timeout=1):
                        break
                except OSError:
                    time.sleep(.05)
            else:
                raise RuntimeError("Disposable server startup timed out")
            run_browser(args, origin, token, workspace, state, windows, panes,
                        manifest, publish, root, env, tmux_name, api)
        finally:
            server.terminate()
            try:
                server.wait(timeout=5)
            except subprocess.TimeoutExpired:
                server.kill()
                server.wait(timeout=5)
            if args.pty:
                subprocess.run([shutil.which("tmux"), "-L", tmux_name, "kill-server"], env=env,
                    stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=5, check=False)
            try:
                log_text = server_log.read_text(errors="replace")
            except OSError:
                log_text = ""
            if log_text.strip():
                print("--- disposable server output (diagnostic) ---")
                print(log_text.replace(token, '[disposable token redacted]')[-4000:])


def run_browser(args, origin, token, workspace, state, windows, panes,
                manifest, publish, root, env, tmux_name, api):
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=True, args=[
            "--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"])
        context = browser.new_context(viewport={"width": 1600, "height": 1000})
        try:
            seed(context, workspace, state)
            page = context.new_page()
            errors, navigations, sockets, ws_data, mutations = [], [], [], [], []
            console_messages = []
            page.on("pageerror", lambda error: errors.append(str(error)))
            page.on("console", lambda message: console_messages.append(f"{message.type}: {message.text}"))
            def watch_navigation(frame):
                if frame == page.main_frame:
                    return
                element = frame.frame_element()
                binding = element.evaluate("n=>({pane:n.closest('.pane')?.dataset.paneId,window:n.closest('.monitor')?.dataset.monitorId})")
                navigations.append((frame.url, binding))

            page.on("framenavigated", watch_navigation)

            def watch_socket(ws):
                if ws.url.endswith("/api/terminal"):
                    sockets.append(ws)
                    ws.on("framereceived", lambda payload: ws_data.append(json.loads(payload)))

            def watch_request(request):
                if request.method == "POST" and request.url.split("?")[0].endswith("/api/workspace"):
                    body = request.post_data_json or {}
                    if body.get("action") not in ("read",):
                        mutations.append(body.get("action"))

            page.on("websocket", watch_socket)
            page.on("request", watch_request)
            page.goto(origin + "/?renderer=docking", wait_until="domcontentloaded")
            if not page.evaluate("typeof Element.prototype.moveBefore === 'function'"):
                raise RuntimeError("UNSUPPORTED BROWSER: Element.moveBefore required; not a passing skip")
            page.wait_for_function("document.documentElement.dataset.dockingRenderer === 'docking' && window.__orbitDocking?.supported === true")
            toolbar = page.get_by_role("toolbar", name="Docking layout", exact=True)
            expect(toolbar).to_be_visible()
            page.keyboard.press("Escape")
            page.get_by_role("button", name="Connect local host", exact=True).click()
            page.get_by_role("textbox", name="Host session token", exact=True).fill(token)
            page.get_by_role("button", name="Unlock local host", exact=True).click()
            expect(page.locator(".saved")).to_contain_text("Workspace connected", timeout=15000)

            def frame(pid):
                return page.frame_locator(f'.pane[data-pane-id="{pid}"] iframe')

            drafts, nonces = {}, {}
            for pid in panes[:2]:
                iframe = page.locator(f'.pane[data-pane-id="{pid}"] iframe')
                expect(iframe).to_have_count(1)
                sandbox = iframe.get_attribute("sandbox")
                assert sandbox is not None and "allow-same-origin" not in sandbox, "fixture must be sandboxed"
                drafts[pid] = f"unsaved-{pid}-{workspace}"
                # Select the actual window so even an initially inactive tab is writable.
                toolbar.get_by_role("combobox", name="Docking window", exact=True).select_option(windows[panes.index(pid)])
                toolbar.get_by_role("button", name="Select window", exact=True).click()
                frame(pid).locator("#draft").fill(drafts[pid])
                nonces[pid] = frame(pid).locator("#document-nonce").inner_text()
            assert len(set(nonces.values())) == 2
            page.evaluate("""ids => {window.__continuityNodes = Object.fromEntries(ids.map(id => {
                const pane=document.querySelector(`.pane[data-pane-id="${id}"]`), iframe=pane.querySelector('iframe');
                return [id,{pane,iframe,frameWindow:iframe?.contentWindow}];}));}""", panes)
            nav_count = len(navigations)
            retained = list(panes[:2])

            def fresh_output(marker, start):
                deadline = time.monotonic() + 12
                while time.monotonic() < deadline:
                    output = "".join(v.get("data", "") for v in ws_data[start:] if v.get("type") == "data")
                    match = re.search(re.escape(marker) + r"_K_(\d+)", output)
                    if match:
                        return match.group(1)
                    page.wait_for_timeout(70)
                raise AssertionError(f"No NEW WebSocket data with complete {marker}, retained variable and PID")

            if args.pty:
                toolbar.get_by_role("combobox", name="Docking window", exact=True).select_option(windows[2])
                toolbar.get_by_role("button", name="Select window", exact=True).click()
                terminal = page.locator(f'.pane[data-pane-id="{panes[2]}"]')
                terminal.get_by_role("button", name="Connect to local host shell", exact=True).click()
                try:
                    expect(terminal.locator(".connection-state")).to_contain_text("LIVE SHELL", timeout=15000)
                except AssertionError:
                    print("PTY DIAG status:", terminal.locator(".connection-state").inner_text())
                    print("PTY DIAG box:", terminal.bounding_box(), "visible:", terminal.is_visible())
                    print("PTY DIAG __orbitDocking:", page.evaluate("window.__orbitDocking"))
                    print("PTY DIAG sockets:", [s.url for s in sockets])
                    print("PTY DIAG ws_data tail:", ws_data[-6:])
                    print("PTY DIAG pageerrors:", errors)
                    print("PTY DIAG console tail:", console_messages[-12:])
                    raise
                terminal.locator(".xterm-helper-textarea").focus()
                marker = "D" + secrets.token_hex(5).upper()
                start = len(ws_data)
                page.keyboard.type("export ORBIT_DOCKING_VAR=K; function d(){ printf '%s_%s_%s\\n' \"$1\" \"$ORBIT_DOCKING_VAR\" \"$$\"; }; d " + marker)
                page.keyboard.press("Enter")
                shell_pid = fresh_output(marker, start)

            def settle():
                page.evaluate("() => new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))")

            def local():
                return page.evaluate("JSON.parse(localStorage.getItem('orbit.workspace.v1'))")

            # Match the structural acknowledgement used by runtime-continuity:
            # choose() legitimately raises frame.z while applying a remote state.
            sync_js = """expected => {const s=JSON.parse(localStorage.getItem('orbit.workspace.v1')||'null');
                const normalize=x=>({view:x.view,selected:x.selected,appearance:x.appearance||{},plugins:x.plugins||[],
                    monitors:x.monitors.map(m=>({...m,frame:m.frame?{x:m.frame.x,y:m.frame.y,width:m.frame.width,height:m.frame.height}:undefined}))});
                const stable=x=>JSON.stringify(x,(k,v)=>k==='frame' && v ? {x:v.x,y:v.y,width:v.width,height:v.height} : v && !Array.isArray(v) && typeof v==='object'
                    ? Object.fromEntries(Object.keys(v).sort().map(k=>[k,v[k]])):v);
                return s && stable(normalize(s))===stable(normalize(expected));}"""

            def synced(result):
                page.wait_for_function(sync_js, arg=result["state"], timeout=15000)
                assert result["revision"] >= 1, "No committed normal-workspace revision"
                deadline = time.monotonic() + 15
                while time.monotonic() < deadline:
                    observed = api('read', control=True)
                    if observed.get('observed_revision', 0) >= result['revision'] and observed.get('browser_seen'):
                        return
                    page.wait_for_timeout(100)
                raise AssertionError('Normal browser did not acknowledge the committed revision to the server')

            def flush_ui():
                # Let normal main.ts polling commit toolbar/menu selection before
                # revision-checked controller writes; never synthesize a sync.
                deadline = time.monotonic() + 15
                while time.monotonic() < deadline:
                    before = api("read", control=True)
                    if page.evaluate(sync_js, before["state"]):
                        page.wait_for_timeout(250)
                        if page.evaluate(sync_js, api("read", control=True)["state"]):
                            return
                    page.wait_for_timeout(100)
                raise AssertionError("Normal main.ts browser/server state did not converge")

            def geometry():
                return page.locator(".docking-placeholder").evaluate_all("""nodes=>Object.fromEntries(nodes.map(n=>{
                    const r=n.getBoundingClientRect();return [n.dataset.dockingWindow,[r.x,r.y,r.width,r.height]];}))""")

            def placement():
                settle()
                current = local()
                ids = [m["id"] for m in current["monitors"]]
                diag = page.evaluate("window.__orbitDocking")
                assert diag["supported"] is True and sorted(diag["panels"]) == sorted(ids), diag
                expect(page.locator(".docking-placeholder[data-docking-window]")).to_have_count(len(ids))
                if current["view"] != "windows" or page.locator(".focus-host.visible").count():
                    return
                expect(toolbar).to_be_visible()
                expect(page.locator(".docking-surfaces > .monitor[data-docking-surface]")).to_have_count(len(ids))
                for wid in ids:
                    expect(page.locator(f'.docking-placeholder[data-docking-window="{wid}"]')).to_have_count(1)
                    expect(page.locator(f'.docking-surfaces > .monitor[data-docking-surface="{wid}"]')).to_have_count(1)
                active = diag["active"]
                assert active in ids, diag
                placeholder = page.locator(f'.docking-placeholder[data-docking-window="{active}"]')
                surface = page.locator(f'.docking-surfaces > .monitor[data-docking-surface="{active}"]')
                expect(surface).to_be_visible()
                a, b = placeholder.bounding_box(), surface.bounding_box()
                assert a and b and a["width"] > 0 and a["height"] > 0, (a, b)
                assert all(abs(a[k] - b[k]) <= 3 for k in ("x", "y", "width", "height")), (active, a, b)

            def verify(label, allow_navigation=False):
                nonlocal nav_count
                settle()
                assert not errors, f"{label}: page errors {errors}"
                if not allow_navigation:
                    assert len(navigations) == nav_count, f"{label}: unexpected iframe navigation {navigations[nav_count:]}"
                else:
                    # Lifecycle calls allow navigation only in the managed plugin
                    # window or the explicitly excluded URL-negative-control pane.
                    managed = {p["window"]["id"] for p in local().get("plugins", [])}
                    for url, binding in navigations[nav_count:]:
                        assert binding.get("pane") not in retained, f"{label}: retained fixture navigated: {url}"
                        assert binding.get("window") in managed or (
                            panes[0] not in retained and binding.get("pane") == panes[0]
                        ), f"{label}: unrelated navigation: {url}, {binding}"
                for pid in retained:
                    assert page.evaluate("""id=>{const old=window.__continuityNodes[id],pane=document.querySelector(`.pane[data-pane-id="${id}"]`);
                        return pane===old.pane && pane.isConnected && pane.querySelector('iframe')===old.iframe && old.iframe.contentWindow===old.frameWindow;}""", pid), f"{label}: DOM identity lost {pid}"
                    assert frame(pid).locator("#document-nonce").inner_text() == nonces[pid], f"{label}: nonce changed {pid}"
                    assert frame(pid).locator("#draft").input_value() == drafts[pid], f"{label}: draft lost {pid}"
                    owner = next(m["id"] for m in local()["monitors"] if pid in json.dumps(m["layout"]))
                    assert page.evaluate("""([pid,wid])=>document.querySelector(`[data-pane-id="${pid}"]`)?.closest('.monitor')?.dataset.monitorId===wid""", [pid, owner]), f"{label}: retained pane has wrong monitor owner"
                assert len(sockets) == int(args.pty), f"{label}: extra terminal WebSocket"
                if args.pty:
                    assert page.evaluate("""id=>window.__continuityNodes[id].pane===document.querySelector(`.pane[data-pane-id="${id}"]`) && window.__continuityNodes[id].pane.isConnected""", panes[2]), f"{label}: terminal DOM changed"
                    marker = "D" + secrets.token_hex(5).upper()
                    start = len(ws_data)
                    subprocess.run([shutil.which("tmux"), "-L", tmux_name, "send-keys", "-t", "pane-" + panes[2],
                        f"d {marker}", "C-m"], env=env, check=True, capture_output=True, timeout=5)
                    assert fresh_output(marker, start) == shell_pid, f"{label}: shell PID changed"
                placement()
                nav_count = len(navigations)

            count = 0

            def passed(label, allow_navigation=False):
                nonlocal count
                verify(label, allow_navigation)
                count += 1
                print(f"{count:03d} PASS {label}", flush=True)

            def apply(label, *operations, allow_navigation=False):
                flush_ui()
                before = api("read", control=True)
                result = api("apply", control=True, base_revision=before["revision"], operations=list(operations))
                assert result["state"] != before["state"], f"{label}: no state change"
                synced(result)
                passed(label, allow_navigation)
                return result

            def command(name, wid, target, activation="click", invalid=False):
                flush_ui()
                toolbar.get_by_role("combobox", name="Docking window", exact=True).select_option(wid)
                toolbar.get_by_role("combobox", name="Docking target", exact=True).select_option(target)
                before_state, before_diag, before_geometry = local(), page.evaluate("window.__orbitDocking"), geometry()
                before_server = api("read", control=True)
                mutation_count = len(mutations)
                control = toolbar.get_by_role("button", name=name, exact=True)
                if activation == "click":
                    control.click()
                else:
                    control.focus()
                    page.keyboard.press(activation)
                settle()
                expect(control).to_be_focused()
                if invalid:
                    expect(toolbar.locator("[data-docking-status]")).to_contain_text(re.compile(r"reject|same|itself|different|distinct|cannot|invalid|already|not floating", re.I))
                    assert page.evaluate("window.__orbitDocking") == before_diag
                    assert geometry() == before_geometry
                elif name == "Select window":
                    page.wait_for_function("id=>JSON.parse(localStorage.getItem('orbit.workspace.v1')).selected===id", arg=wid)
                    assert before_state["selected"] != wid, "Select transition was a no-op"
                    assert page.evaluate("window.__orbitDocking.active") == wid
                else:
                    diag = page.evaluate("window.__orbitDocking")
                    assert diag != before_diag or geometry() != before_geometry, f"{name}: no placement change"
                    if name == "Float window":
                        assert wid in diag["floating"]
                    elif name == "Return to grid":
                        assert wid not in diag["floating"] and wid in before_diag["floating"]
                    elif name == "Tab to target":
                        assert page.evaluate("""([a,b])=>document.querySelector(`[data-docking-window="${a}"]`).closest('.dv-groupview')===document.querySelector(`[data-docking-window="${b}"]`).closest('.dv-groupview')""", [wid, target])
                    else:
                        rects = geometry()
                        assert rects[wid][2] > 0 and rects[target][2] > 0
                        assert (rects[wid][0] < rects[target][0]) == (name == "Dock left"), (name, rects)
                if name != "Select window" or invalid:
                    page.wait_for_timeout(1400)  # includes a normal sync polling interval
                    assert local() == before_state, f"{name}: docking command mutated v1"
                    after_server = api("read", control=True)
                    # Docking placement is now a persisted adjunct: a valid command may
                    # send placement_save and advance the shared revision, but it must
                    # never change the v1 layout state. Rejected commands send nothing.
                    assert after_server["state"] == before_server["state"], f"{name}: docking command changed server layout state"
                    if invalid:
                        assert len(mutations) == mutation_count, f"{name}: rejected command sent server mutation {mutations[mutation_count:]}"
                    else:
                        new_actions = [action for action in mutations[mutation_count:] if action != "placement_save"]
                        assert not new_actions, f"{name}: docking command sent non-placement mutation {new_actions}"
                passed(f"{'reject ' if invalid else ''}{name} [{activation}] {windows.index(wid)}→{windows.index(target)}")
                expect(control).to_be_focused()

            flush_ui()
            verify("initial")
            # Verify actual paint, not merely CSS visibility/DOM connectivity:
            # opaque docking placeholders previously covered intact iframe views.
            frame(panes[0]).locator('body').evaluate("""body => {
                const probe=document.createElement('div'); probe.id='paint-probe';
                Object.assign(probe.style,{position:'fixed',left:'8px',top:'8px',width:'16px',height:'16px',background:'#1ab347',zIndex:'2147483647'});
                body.append(probe);
            }""")
            iframe_box = page.locator(f'.pane[data-pane-id="{panes[0]}"] iframe').bounding_box()
            assert iframe_box
            image = base64.b64encode(page.screenshot()).decode()
            pixel = page.evaluate("""async ({image,x,y}) => {
                const img=new Image(); img.src='data:image/png;base64,'+image; await img.decode();
                const canvas=document.createElement('canvas'); canvas.width=img.width; canvas.height=img.height;
                const ctx=canvas.getContext('2d'); ctx.drawImage(img,0,0);
                return [...ctx.getImageData(Math.round(x),Math.round(y),1,1).data];
            }""", {"image":image,"x":iframe_box['x']+16,"y":iframe_box['y']+16})
            assert pixel == [26,179,71,255], f'Actual iframe pixels obscured: {pixel}'
            frame(panes[0]).locator('#paint-probe').evaluate('node => node.remove()')
            if args.screenshot:
                page.screenshot(path=str(args.screenshot))
            # Windows focus must stay in the focus host across animation frames;
            # the docking animation must not reclaim the focused monitor.
            page.get_by_role('button', name='Focus selected display', exact=True).click()
            settle()
            expect(page.locator('.focus-host .monitor')).to_have_count(1)
            expect(page.locator('.focus-host .monitor')).to_be_visible()
            verify('Windows focus')
            page.get_by_role('button', name='Exit focus view', exact=True).click()
            settle()
            expect(page.locator('.focus-host .monitor')).to_have_count(0)
            verify('Windows unfocus')
            # Hidden tab visibility must not leak into the spatial renderer.
            toolbar.get_by_role('combobox', name='Docking window', exact=True).select_option(windows[0])
            toolbar.get_by_role('combobox', name='Docking target', exact=True).select_option(windows[1])
            toolbar.get_by_role('button', name='Tab to target', exact=True).click()
            settle()
            assert page.locator('.docking-surfaces > .monitor').evaluate_all("nodes => nodes.some(n => getComputedStyle(n).visibility === 'hidden')"), 'Must exercise a genuinely hidden tab'
            page.get_by_role('button', name='Switch to spatial view', exact=True).click()
            settle()
            for wid in windows:
                expect(page.locator(f'.monitor[data-monitor-id="{wid}"]')).to_be_visible()
            verify('Spatial reveals inactive docking tabs')
            page.get_by_role('button', name='Switch to movable windows', exact=True).click()
            settle()
            toolbar.get_by_role('button', name='Dock left', exact=True).click()
            settle()
            verify('Restore grid after hidden-tab regression')
            checkpoint_state = api("read", control=True)
            checkpoint = api("checkpoint", control=True, base_revision=checkpoint_state["revision"], label="Docking live baseline")["checkpoint"]
            # Five rounds × fourteen = 70 real, non-no-op transitions.
            for cycle in range(5):
                selected = local()["selected"]
                wid = windows[(windows.index(selected) + 1) % len(windows)]
                target = windows[(windows.index(wid) + 1) % len(windows)]
                activation = ("click", "Enter", "Space")[cycle % 3]
                command("Select window", wid, target, activation)
                for name in ("Tab to target", "Dock left", "Dock right", "Float window", "Return to grid"):
                    command(name, wid, target, activation)
                for name, label in (("Switch to spatial view", "Spatial"), ("Focus selected display", "Focus"),
                                    ("Exit focus view", "Exit focus"), ("Switch to movable windows", "Windows")):
                    page.get_by_role("button", name=name, exact=True).click()
                    if label == "Focus":
                        expect(page.locator(".focus-host .monitor")).to_have_count(1)
                        expect(page.locator(".focus-host .monitor")).to_be_visible()
                    elif label == "Exit focus":
                        expect(page.locator(".focus-host .monitor")).to_have_count(0)
                    else:
                        page.wait_for_function("v=>JSON.parse(localStorage.getItem('orbit.workspace.v1')).view===v", arg="spatial" if label == "Spatial" else "windows")
                    passed(f"round {cycle + 1}: {label}")
                apply(f"round {cycle + 1}: update_window name/frame", {"action": "update_window", "window_id": windows[0],
                    "name": f"Docking round {cycle + 1}", "frame": {"x": 25 + cycle, "y": 26 + cycle, "width": 620 + cycle, "height": 510, "z": cycle + 3}})
                order = [m["id"] for m in local()["monitors"]]
                apply(f"round {cycle + 1}: reorder_windows", {"action": "reorder_windows", "window_ids": order[::-1]})
                apply(f"round {cycle + 1}: update_split ratio/axis", {"action": "update_split", "window_id": windows[0], "path": [],
                    "ratio": .3 if cycle % 2 else .7, "axis": "column" if cycle % 2 else "row"})
                current = local()["monitors"]
                owners = [next(m["id"] for m in current if pid in json.dumps(m["layout"])) for pid in panes[:2]]
                apply(f"round {cycle + 1}: swap_panes", {"action": "swap_panes", "window_id": owners[0], "pane_id": panes[0],
                    "other_window_id": owners[1], "other_pane_id": panes[1]})

            apply("patch_appearance", {"action": "patch_appearance", "patch": {"accentColor": "#123456", "cornerRadius": 12}})
            # Pointer evidence is a physical drag with a measured size delta.
            hits = page.locator(".dv-sash").evaluate_all("""nodes=>nodes.map(n=>{const r=n.getBoundingClientRect(),x=r.x+r.width/2,y=r.y+r.height/2;
                return {x,y,w:r.width,h:r.height,hit:!!document.elementFromPoint(x,y)?.closest('.dv-sash')};})""")
            hit = next((h for h in hits if h["w"] > 0 and h["h"] > 0 and h["hit"]), None)
            assert hit, f"No physically reachable sash: {hits}"
            before = geometry()
            dx, dy = (45, 0) if hit["h"] > hit["w"] else (0, 45)
            page.mouse.move(hit["x"], hit["y"])
            page.mouse.down()
            page.mouse.move(hit["x"] + dx, hit["y"] + dy, steps=9)
            page.mouse.up()
            settle()
            after = geometry()
            assert any(abs(after[k][j] - before[k][j]) > 3 for k in before for j in (2, 3)), (before, after)
            pointer_evidence = {"before": before, "after": after, "drag": [dx, dy]}
            passed("physical sash drag 45px; measured panel size changed")
            # A real Tab must reach the native select command from the target select.
            toolbar.get_by_role("combobox", name="Docking target", exact=True).focus()
            page.keyboard.press("Tab")
            expect(toolbar.get_by_role("button", name="Select window", exact=True)).to_be_focused()
            for name in ("Tab to target", "Dock left", "Dock right"):
                command(name, windows[0], windows[0], "Enter", invalid=True)
            flush_ui()
            restored = api("restore", control=True, base_revision=api("read", control=True)["revision"], checkpoint_id=checkpoint, confirm=True)
            assert restored["state"] == checkpoint_state["state"], "checkpoint did not restore exact saved v1 state"
            synced(restored)
            passed("real controller checkpoint restore + main.ts acknowledgement")

            # Managed plugin is independent of the two retained fixture panes.
            # Valid plugins are supported by the contract; update/disable intentionally
            # replace/remove ONLY this additional managed runtime.
            apply("publisher plugin install", {"action": "plugin_install", "manifest": manifest})
            enabled = apply("publisher plugin enable", {"action": "plugin_enable", "plugin_id": PLUGIN}, allow_navigation=True)
            plugin = next(p for p in enabled["state"]["plugins"] if p["manifest"]["id"] == PLUGIN)
            plugin_window = plugin["window"]["id"]
            plugin_iframe = page.locator(f'.monitor[data-monitor-id="{plugin_window}"] iframe')
            expect(plugin_iframe).to_have_count(1)
            plugin_frame = page.frame_locator(f'.monitor[data-monitor-id="{plugin_window}"] iframe')
            plugin_nonce = plugin_frame.locator("#document-nonce").inner_text()
            plugin_frame.locator("#draft").fill("managed-plugin-unsaved-" + workspace)
            page.evaluate("id=>window.__pluginFrame=document.querySelector(`[data-monitor-id=\"${id}\"] iframe`)", plugin_window)
            # Wait for the expected plugin navigation before setting the next baseline.
            verify("managed plugin loaded", allow_navigation=True)
            fixture = root / "fixture/index.html"
            fixture.write_text(fixture.read_text() + "\n<!-- immutable second publication -->\n")
            updated_manifest = publish("1.0.1")
            assert updated_manifest["entry"] != manifest["entry"]
            apply("publisher plugin_update", {"action": "plugin_update", "plugin_id": PLUGIN, "manifest": updated_manifest}, allow_navigation=True)
            expect(plugin_frame.locator("#document-nonce")).not_to_have_text(plugin_nonce)
            assert plugin_frame.locator("#draft").input_value() == ""
            assert page.evaluate("!window.__pluginFrame.isConnected"), "plugin update retained old iframe"
            verify("updated plugin loaded", allow_navigation=True)
            page.evaluate("id=>window.__updatedPluginFrame=document.querySelector(`[data-monitor-id=\"${id}\"] iframe`)", plugin_window)
            apply("plugin_disable", {"action": "plugin_disable", "plugin_id": PLUGIN})
            expect(plugin_iframe).to_have_count(0)
            assert page.evaluate("!window.__updatedPluginFrame.isConnected"), "disabled plugin iframe remains connected"
            flush_ui()
            held = api("recovery_policy", recovery=True, base_revision=api("read", control=True)["revision"],
                held=True, confirm=True, operation_id=str(uuid.uuid4()), intent="Isolated docking acceptance hold")
            synced(held)
            assert held["recovery_policy"]["held"] is True
            passed("recovery hold entered")
            before = api("read", control=True)
            rejection = api("apply", control=True, base_revision=before["revision"], reject=409,
                operations=[{"action": "plugin_enable", "plugin_id": PLUGIN}])
            assert rejection["category"] == "RECOVERY_HOLD", rejection
            after = api("read", control=True)
            assert (after["revision"], after["state"]) == (before["revision"], before["state"])
            passed("recovery hold rejects plugin activation atomically")

            # Separate context, separate workspace, no shared owner/browser profile.
            unsupported = browser.new_context(viewport={"width": 1600, "height": 1000})
            try:
                seed(unsupported, str(uuid.uuid4()), state)
                unsupported.add_init_script("Element.prototype.moveBefore = undefined;")
                refused = unsupported.new_page()
                refusal_errors = []
                refused.on("pageerror", lambda error: refusal_errors.append(str(error)))
                refused.goto(origin + "/?renderer=docking", wait_until="domcontentloaded")
                expect(refused.locator(".docking-unsupported[data-docking-unsupported]")).to_be_visible()
                expect(refused.locator(".docking-unsupported")).to_contain_text("Element.moveBefore")
                assert refused.evaluate("document.documentElement.dataset.dockingRenderer==='unsupported' && window.__orbitDocking?.supported===false")
                expect(refused.locator(".desktop-host > .desktop-window")).to_have_count(len(windows))
                for wid in windows:
                    expect(refused.locator(f'.desktop-window[data-monitor-id="{wid}"]')).to_be_visible()
                refused.get_by_role("button", name="Switch to spatial view", exact=True).click()
                refused.get_by_role("button", name="Switch to movable windows", exact=True).click()
                expect(refused.locator(".desktop-host > .desktop-window")).to_have_count(len(windows))
                assert not refusal_errors, refusal_errors
            finally:
                unsupported.close()
            passed("separate-context moveBefore refusal; default placement operational")

            assert count == 83, f"Expected 83 continuity/compatibility checks before destructive controls, got {count}"
            # Negative controls exclude ONLY the deliberately replaced/closed pane.
            retained.remove(panes[0])
            current = api("read", control=True)["state"]
            owner = next(m["id"] for m in current["monitors"] if panes[0] in json.dumps(m["layout"]))
            apply("URL-change negative control", {"action": "set_pane", "window_id": owner, "pane_id": panes[0],
                "url": manifest["entry"] + "?deliberate=" + secrets.token_hex(6)}, allow_navigation=True)
            expect(frame(panes[0]).locator("#document-nonce")).not_to_have_text(nonces[panes[0]])
            assert frame(panes[0]).locator("#draft").input_value() == ""
            assert page.evaluate("id=>!window.__continuityNodes[id].pane.isConnected && !window.__continuityNodes[id].iframe.isConnected", panes[0])
            verify("URL replacement completed; other iframe retained", allow_navigation=True)
            page.evaluate("id=>window.__replacementPane=document.querySelector(`[data-pane-id=\"${id}\"]`)", panes[0])
            apply("close_pane negative control", {"action": "close_pane", "window_id": owner, "pane_id": panes[0]})
            expect(page.locator(f'.pane[data-pane-id="{panes[0]}"]')).to_have_count(0)
            assert page.evaluate("!window.__replacementPane.isConnected")
            assert count == 85
            print(json.dumps({"result": "PASS", "checks": count, "layoutTransitions": 73,
                "terminalWebSockets": len(sockets), "pty": args.pty, "browser": browser.version,
                "acknowledgement": "normal main.ts state matched (frame.z excluded) and server observed_revision reached the committed revision",
                "pointer": pointer_evidence, "noModelCalls": True}))
        finally:
            context.close()
            browser.close()


if __name__ == "__main__":
    main()
