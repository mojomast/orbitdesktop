"""Disposable built-UI continuity acceptance test. Never contacts the owner's runtime.

Run after npm run build with PLAYWRIGHT_BROWSERS_PATH=/tmp/opencode/orbit-evolution-browsers
  /tmp/opencode/orbit-evolution-browser-venv/bin/python tests/runtime-continuity.browser.py
Pass --pty only when the fixture tmux override is supported and tmux is installed.
"""
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
import urllib.error
import uuid

from playwright.sync_api import expect, sync_playwright


ROOT = Path(__file__).resolve().parents[1]
parser = argparse.ArgumentParser()
parser.add_argument("--pty", action="store_true", help="include isolated tmux-backed live shell")
args = parser.parse_args()
if args.pty and (not shutil.which("tmux") or "ORBIT_TMUX_SOCKET" not in (ROOT / "server/local-host.mjs").read_text()):
    parser.error("PTY requires tmux and ORBIT_TMUX_SOCKET support; not a green skip")

with tempfile.TemporaryDirectory(prefix="orbit-continuity-", dir="/tmp/opencode") as temporary:
    root = Path(temporary)
    for name in ("server", "src", "contracts", "dist"):
        shutil.copytree(ROOT / name, root / name)
    (root / "node_modules").symlink_to(ROOT / "node_modules", target_is_directory=True)
    shutil.copy2(ROOT / "package.json", root / "package.json")
    for name in ("runtime", "home", "cwd", "tmux"):
        (root / name).mkdir(mode=0o700)
    fixture = root / "fixture"
    fixture.mkdir()
    shutil.copy2(ROOT / "tests/fixtures/runtime-continuity.html", fixture / "index.html")
    manifest = json.loads(subprocess.check_output([
        shutil.which("python3"), str(ROOT / "scripts/plugin_publish.py"), str(fixture),
        "--id", "runtime-continuity", "--version", "1.0.0", "--title", "Continuity fixture",
        "--runtime", str(root / "runtime"),
    ], text=True, env={"PATH": os.environ["PATH"], "HOME": str(root / "home")}))
    app_url = manifest["entry"]
    with socket.socket() as probe:
        probe.bind(("127.0.0.1", 0))
        port = probe.getsockname()[1]
    origin = f"http://127.0.0.1:{port}"
    token, workspace = secrets.token_urlsafe(36), str(uuid.uuid4())
    windows = [str(uuid.uuid4()) for _ in range(2 + int(args.pty))]
    panes = [str(uuid.uuid4()) for _ in windows]
    def monitor(index, kind, url=None):
        return {"id": windows[index], "name": f"Continuity {index}", "diagonal": 32,
                "aspect": "16:9", "height": 0, "distance": 0, "pitch": 0, "yaw": 0,
                "offset": 0, "fontSize": 19,
                "frame": {"x": 30 + 220 * index, "y": 30 + 45 * index,
                          "width": 620, "height": 510, "z": index + 1},
                "layout": {"type": "pane", "pane": {"id": panes[index], "kind": kind,
                                                   "url": url or "orbit://welcome"}}}
    state = {"version": 1, "selected": windows[0], "arc": 14, "view": "windows",
             "monitors": [monitor(i, "terminal" if args.pty and i == 2 else "browser",
                                  None if args.pty and i == 2 else app_url) for i in range(len(windows))]}
    tmux_name = "orbit-continuity-" + secrets.token_hex(12)
    env = {"PATH": os.environ["PATH"], "HOME": str(root / "home"), "PORT": str(port),
           "ORBIT_TOKEN": token, "ORBIT_RUNTIME_DIR": str(root / "runtime"),
           "ORBIT_CWD": str(root / "cwd"), "TMUX_TMPDIR": str(root / "tmux"),
           "ORBIT_TMUX_SOCKET": tmux_name, "ORBIT_TMUX_CONFIG": "/dev/null",
           "TERM": "xterm-256color"}
    server = subprocess.Popen([shutil.which("node"), "--experimental-strip-types", "server/index.mjs"],
                              cwd=root, env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)

    def api(action, control=False, **fields):
        capability = json.loads((root / "runtime/workspace-access" / (workspace + ".json")).read_text())["capability"] if control else token
        request = urllib.request.Request(origin + ("/api/workspace/control" if control else "/api/workspace"),
            data=json.dumps({"workspace_id": workspace, "action": action, **fields}).encode(),
            headers={"Origin": origin, "Authorization": "Bearer " + capability,
                     "Content-Type": "application/json"})
        try:
            with urllib.request.urlopen(request, timeout=10) as response:
                return json.load(response)
        except urllib.error.HTTPError as error:
            raise AssertionError(f"{action} rejected: HTTP {error.code}: {error.read().decode()}") from error

    browser = context = None
    transitions = 0
    try:
        for _ in range(120):
            if server.poll() is not None:
                raise RuntimeError("Disposable server exited before readiness")
            try:
                with urllib.request.urlopen(origin + "/api/health", timeout=1):
                    break
            except OSError:
                time.sleep(.05)
        else:
            raise RuntimeError("Disposable server startup timed out")
        with sync_playwright() as playwright:
            browser = playwright.chromium.launch(headless=True, args=["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"])
            context = browser.new_context(viewport={"width": 1600, "height": 1000})
            context.add_init_script("if(window===window.top){localStorage.setItem('orbit.onboarding.v1','done');localStorage.setItem('orbit.menu.pinned','true');localStorage.setItem('orbit.workspace.id', " + json.dumps(workspace) + ");localStorage.setItem('orbit.workspace.v1',JSON.stringify(" + json.dumps(state) + "));}")
            page = context.new_page()
            errors, navigations, sockets = [], [], []
            page.on("pageerror", lambda error: errors.append(str(error)))
            page.on("framenavigated", lambda frame: navigations.append(frame.url) if frame != page.main_frame else None)
            page.on("websocket", lambda ws: sockets.append(ws))
            page.goto(origin + "/", wait_until="domcontentloaded")
            if not page.evaluate("typeof Element.prototype.moveBefore === 'function'"):
                raise RuntimeError("UNSUPPORTED BROWSER: Element.moveBefore is required for connected-DOM continuity; this is not a passing skip")
            page.keyboard.press("Escape")
            page.get_by_role("button", name="Connect local host", exact=True).click()
            page.get_by_role("textbox", name="Host session token").fill(token)
            page.get_by_role("button", name="Unlock local host", exact=True).click()
            expect(page.locator(".saved")).to_contain_text("Workspace connected", timeout=15000)

            def iframe(pid):
                return page.locator(f'.pane[data-pane-id="{pid}"] iframe')

            for i, pid in enumerate(panes[:2]):
                try:
                    expect(iframe(pid)).to_have_count(1, timeout=15000)
                except AssertionError as error:
                    raise AssertionError(f"Initial browser pane {pid} missing; rendered={page.locator('.pane').evaluate_all('(nodes)=>nodes.map(n=>n.dataset.paneId)')}; pageerrors={errors}; state={page.evaluate('localStorage.getItem(\"orbit.workspace.v1\")')}") from error
                page.frame_locator(f'.pane[data-pane-id="{pid}"] iframe').locator("#draft").fill(f"unsaved-{i}-{workspace}")
            page.evaluate("""ids => {window.__continuityNodes = Object.fromEntries(ids.map(id => {
                const pane = document.querySelector(`.pane[data-pane-id="${id}"]`);
                return [id, {pane, frame:pane.querySelector('iframe'), frameWindow:pane.querySelector('iframe').contentWindow}];
            }));}""", panes[:2])
            baseline = {pid: page.frame_locator(f'.pane[data-pane-id="{pid}"] iframe').locator("#document-nonce").inner_text() for pid in panes[:2]}
            nav_count = len(navigations)
            frames = {pid: page.frame_locator(f'.pane[data-pane-id="{pid}"] iframe') for pid in panes[:2]}

            terminal_frames = []
            if args.pty:
                ws_data = []
                def watch(ws):
                    if ws.url.endswith("/api/terminal"):
                        terminal_frames.append(ws)
                        ws.on("framereceived", lambda payload: ws_data.append(json.loads(payload)))
                page.on("websocket", watch)
                page.locator(f'.pane[data-pane-id="{panes[2]}"]').get_by_role("button", name="Connect to local host shell").click()
                expect(page.locator(f'.pane[data-pane-id="{panes[2]}"] .connection-state')).to_contain_text("LIVE SHELL", timeout=15000)
                assert len(terminal_frames) == 1, len(terminal_frames)
                terminal = page.locator(f'.pane[data-pane-id="{panes[2]}"] .xterm-helper-textarea')
                terminal.focus()
                page.keyboard.type("export ORBIT_CONTINUITY_VAR=retained; printf 'ORBIT_INITIAL_%s_%s\\n' \"$ORBIT_CONTINUITY_VAR\" \"$$\"")
                page.keyboard.press("Enter")
                def live_output(prefix):
                    deadline = time.monotonic() + 10
                    while time.monotonic() < deadline:
                        output = "".join(v.get("data", "") for v in ws_data if v.get("type") == "data")
                        found = re.search(prefix + r"_retained_(\d+)", output)
                        if found:
                            return found.group(1)
                        page.wait_for_timeout(100)
                    raise AssertionError(f"No fresh {prefix} shell output frame")
                shell_pid = live_output("ORBIT_INITIAL")
                page.evaluate("id => window.__terminalNode = document.querySelector(`.pane[data-pane-id=\"${id}\"]`)", panes[2])

            def verify(label):
                # A new document, iframe, or pane fails this assertion.
                assert not errors, f"{label}: page errors {errors}"
                assert len(navigations) == nav_count, f"{label}: unexpected iframe navigation {navigations[nav_count:]}"
                for i, pid in enumerate(panes[:2]):
                    assert page.evaluate("""id => {const old=window.__continuityNodes[id]; const pane=document.querySelector(`.pane[data-pane-id="${id}"]`);
                        return !!pane && pane === old.pane && pane.querySelector('iframe') === old.frame && old.frame.contentWindow === old.frameWindow && pane.isConnected;}""", pid), f"{label}: pane/iframe DOM identity changed: {pid}"
                    assert frames[pid].locator("#document-nonce").inner_text() == baseline[pid], f"{label}: document nonce changed: {pid}"
                    assert frames[pid].locator("#draft").input_value() == f"unsaved-{i}-{workspace}", f"{label}: unsaved draft lost: {pid}"
                assert len([ws for ws in sockets if ws.url.endswith('/api/terminal')]) == int(args.pty), f"{label}: layout opened a new PTY WebSocket"
                if args.pty:
                    assert page.evaluate("id => window.__terminalNode === document.querySelector(`.pane[data-pane-id=\"${id}\"]`) && window.__terminalNode.isConnected", panes[2]), f"{label}: terminal pane DOM identity changed"
                    marker = "ORBIT_LIVE_" + secrets.token_hex(6).upper()
                    # The shell may be behind the focused browser pane. Send to the
                    # fixture-only tmux socket and require NEW terminal WS data.
                    subprocess.run(["/usr/bin/tmux", "-L", tmux_name, "send-keys", "-t",
                                    "pane-" + panes[2],
                                    f"printf '{marker}_%s_%s\\n' \"$ORBIT_CONTINUITY_VAR\" \"$$\"",
                                    "C-m"], env=env, check=True, capture_output=True, timeout=5)
                    assert live_output(marker) == shell_pid, f"{label}: live shell PID changed"

            verify("initial")
            def apply(label, *ops):
                before = api("read")
                result = api("apply", control=True, base_revision=before["revision"], operations=list(ops))
                expected = result["state"]
                try:
                    page.wait_for_function("""expected => {const s=JSON.parse(localStorage.getItem('orbit.workspace.v1')||'null');
                    if(!s) return false; return s.view===expected.view && s.selected===expected.selected &&
                    JSON.stringify(s.monitors.map(m=>[m.id,m.name,m.layout,m.diagonal,m.height,m.distance,m.pitch,m.yaw,m.offset,m.frame?.x,m.frame?.y,m.frame?.width,m.frame?.height])) ===
                    JSON.stringify(expected.monitors.map(m=>[m.id,m.name,m.layout,m.diagonal,m.height,m.distance,m.pitch,m.yaw,m.offset,m.frame?.x,m.frame?.y,m.frame?.width,m.frame?.height])) &&
                    JSON.stringify(s.appearance||{})===JSON.stringify(expected.appearance||{});}""", arg=expected, timeout=15000)
                except Exception:
                    actual = page.evaluate("JSON.parse(localStorage.getItem('orbit.workspace.v1'))")
                    raise AssertionError(f"{label}: browser sync mismatch: browser={actual!r}; expected={expected!r}")
                verify(label)
                return result

            def menu_click(name):
                page.get_by_role("button", name=name, exact=True).click()

            apply("baseline split", {"action": "split_pane", "window_id": windows[0],
                  "pane_id": panes[0], "axis": "row", "kind": "browser"})
            checkpoint = api("checkpoint", control=True, label="Continuity baseline")["checkpoint"]

            for cycle in range(10):
                # Real UI view/focus/minimize interactions; exact structural changes use scoped API.
                menu_click("Switch to spatial view")
                expect(page.locator(".workspace")).not_to_have_class(re.compile(r"windows-mode"))
                verify(f"{cycle}: spatial")
                transitions += 1
                menu_click("Focus selected display")
                expect(page.locator(".focus-host .monitor")).to_have_count(1)
                verify(f"{cycle}: focus")
                transitions += 1
                page.get_by_role("button", name="Exit focus view").click()
                verify(f"{cycle}: unfocus")
                transitions += 1
                menu_click("Switch to movable windows")
                expect(page.locator(".workspace")).to_have_class(re.compile(r"windows-mode"))
                verify(f"{cycle}: windows")
                transitions += 1
                first = api("read")["state"]["monitors"][0]["id"]
                apply(f"{cycle}: metadata", {"action": "update_window", "window_id": first,
                      "name": f"Continuity round {cycle}", "distance": cycle * .1,
                      "frame": {"x": 25 + cycle, "y": 26 + cycle, "width": 620 + cycle,
                                "height": 510, "z": cycle + 3}})
                transitions += 1
                order = [m["id"] for m in api("read")["state"]["monitors"]]
                apply(f"{cycle}: reorder", {"action": "reorder_windows", "window_ids": order[::-1]})
                transitions += 1
                apply(f"{cycle}: split ratio/axis", {"action": "update_split", "window_id": windows[0],
                      "path": [], "ratio": .3 if cycle % 2 else .7,
                      "axis": "column" if cycle % 2 else "row", "swap": cycle % 2 == 0})
                transitions += 1
                # Alternate cross-window ownership, retaining both browser pane identities.
                layouts = api("read")["state"]["monitors"]
                owner0 = next(m["id"] for m in layouts if panes[0] in json.dumps(m["layout"]))
                owner1 = next(m["id"] for m in layouts if panes[1] in json.dumps(m["layout"]))
                apply(f"{cycle}: cross-window swap", {"action": "swap_panes", "window_id": owner0,
                      "pane_id": panes[0], "other_window_id": owner1, "other_pane_id": panes[1]})
                transitions += 1
                if cycle % 2 == 0:
                    name = next(m["name"] for m in api("read")["state"]["monitors"] if m["id"] == windows[0])
                    page.get_by_role("button", name=f"Minimize {name}").click(force=True)
                    expect(page.locator(f'.monitor[data-monitor-id="{windows[0]}"]')).to_have_class(re.compile("window-minimized"))
                    verify(f"{cycle}: minimize")
                    transitions += 1
                    page.get_by_role("button", name=f"Restore {name}").click()
                    verify(f"{cycle}: restore")
                    transitions += 1

            apply("appearance metadata", {"action": "patch_appearance", "patch": {"accentColor": "#123456", "cornerRadius": 12}})
            transitions += 1
            if args.pty:
                apply("irrelevant terminal URL metadata", {"action": "set_pane", "window_id": windows[2], "pane_id": panes[2], "url": "orbit://metadata-only"})
                transitions += 1

            # Remove source windows while moving their surviving runtimes into
            # another window. This exercises connected parking before anchor disposal.
            merged = api("read")["state"]
            target = next(m for m in merged["monitors"] if m["id"] == windows[0])
            for source in merged["monitors"]:
                if source is not target:
                    target["layout"] = {"type": "split", "axis": "column", "ratio": .5,
                                        "first": target["layout"], "second": source["layout"]}
            merged["monitors"] = [target]
            merged["selected"] = target["id"]
            merged["view"] = "spatial"
            apply("source-window removal and runtime reparent", {"action": "set_workspace", "state": merged})
            transitions += 1

            before = api("read")
            restored = api("restore", control=True, base_revision=before["revision"],
                           checkpoint_id=checkpoint, confirm=True)
            page.wait_for_function("""expected => {const s=JSON.parse(localStorage.getItem('orbit.workspace.v1')||'null');
                return s && JSON.stringify(s.monitors.map(m=>[m.id,m.name,m.layout]))===
                JSON.stringify(expected.monitors.map(m=>[m.id,m.name,m.layout]));}""",
                arg=restored["state"], timeout=15000)
            verify("checkpoint restoration")
            transitions += 1

            # A deliberate URL change MUST replace/reload a browser document (negative control).
            before = api("read")
            target_window = next(m["id"] for m in before["state"]["monitors"] if panes[0] in json.dumps(m["layout"]))
            changed = api("apply", control=True, base_revision=before["revision"], operations=[
                {"action": "set_pane", "window_id": target_window, "pane_id": panes[0], "url": app_url + "?deliberate=1"}])
            page.wait_for_function("""([id,url]) => {const s=JSON.parse(localStorage.getItem('orbit.workspace.v1'));
                return JSON.stringify(s.monitors).includes(url) && !!document.querySelector(`.pane[data-pane-id="${id}"] iframe[src*="deliberate"]`);}""", arg=[panes[0], "?deliberate=1"], timeout=15000)
            assert frames[panes[0]].locator("#document-nonce").inner_text() != baseline[panes[0]], "URL-change negative control did not reload"
            assert frames[panes[0]].locator("#draft").input_value() == "", "URL-change negative control retained unsaved text"
            assert frames[panes[1]].locator("#document-nonce").inner_text() == baseline[panes[1]], "unaffected iframe reloaded"
            before = api("read")
            target_window = next(m["id"] for m in before["state"]["monitors"] if panes[0] in json.dumps(m["layout"]))
            api("apply", control=True, base_revision=before["revision"], operations=[
                {"action": "close_pane", "window_id": target_window, "pane_id": panes[0]}])
            expect(page.locator(f'.pane[data-pane-id="{panes[0]}"]')).to_have_count(0, timeout=15000)
            if args.pty:
                assert len(terminal_frames) == 1
            print(f"PASS {transitions} continuity transitions; two sandboxed iframe nonces/drafts and DOM identities retained; URL reload and close negative controls; PTY={'live' if args.pty else 'not requested'}; Chromium {browser.version}")
            context.close()
            browser.close()
    finally:
        server.terminate()
        try:
            server.wait(timeout=5)
        except subprocess.TimeoutExpired:
            server.kill()
            server.wait(timeout=5)
        if args.pty:
            subprocess.run(["/usr/bin/tmux", "-L", tmux_name, "kill-server"], env=env,
                           stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=5, check=False)
