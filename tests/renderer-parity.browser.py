"""Disposable real-browser parity gate: default renderer vs opt-in docking renderer.

Runs the SAME runtime-continuity scenario against the built Orbit UI twice on one
disposable server, once with the unchanged default renderer and once with
`?renderer=docking`, in two isolated contexts and two isolated workspaces. It then
asserts the normalized behavior transcripts are equal and that docking keeps its
placement invariants without disposing any runtime.

Build first (`npm run build`). Run:

  PLAYWRIGHT_BROWSERS_PATH=/tmp/opencode/orbit-evolution-browsers \
    /tmp/opencode/orbit-evolution-browser-venv/bin/python tests/renderer-parity.browser.py [--pty]

No owner/live server, browser profile, tmux socket or personal data is used: the
server is a disposable copy with a fresh loopback port, token, workspace UUIDs,
HOME, cwd, private TMUX_TMPDIR, unique tmux socket and /dev/null tmux config.
Missing capabilities (Element.moveBefore, the docking contract in dist) fail
explicitly, never as a green skip. Chromium only.
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
import urllib.error
import urllib.request
import uuid

from playwright.sync_api import expect, sync_playwright


ROOT = Path(__file__).resolve().parents[1]
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("--pty", action="store_true",
                    help="include an isolated tmux-backed live shell probed at every transition")
args = parser.parse_args()
if args.pty and (not shutil.which("tmux") or
                 "ORBIT_TMUX_SOCKET" not in (ROOT / "server/local-host.mjs").read_text()):
    parser.error("PTY requires tmux and ORBIT_TMUX_SOCKET support; this is not a passing skip")

if not (ROOT / "dist/index.html").is_file():
    raise RuntimeError("dist/index.html missing; npm run build required")
if "dockingRenderer" not in "\n".join(p.read_text() for p in (ROOT / "dist").rglob("*.js")):
    raise RuntimeError("dist lacks the optional docking contract; npm run build required")


def main():
    with tempfile.TemporaryDirectory(prefix="orbit-renderer-parity-", dir="/tmp/opencode") as temporary:
        root = Path(temporary)
        for name in ("server", "src", "contracts", "dist", "scripts"):
            shutil.copytree(ROOT / name, root / name)
        (root / "node_modules").symlink_to(ROOT / "node_modules", target_is_directory=True)
        shutil.copy2(ROOT / "package.json", root / "package.json")
        for name in ("runtime", "home", "cwd", "tmux", "fixture"):
            (root / name).mkdir(mode=0o700)
        shutil.copy2(ROOT / "tests/fixtures/runtime-continuity.html", root / "fixture/index.html")
        manifest = json.loads(subprocess.check_output([
            shutil.which("python3"), str(ROOT / "scripts/plugin_publish.py"), str(root / "fixture"),
            "--id", "renderer-parity-fixture", "--version", "1.0.0", "--title", "Renderer parity fixture",
            "--runtime", str(root / "runtime"),
        ], cwd=root, text=True, env={"PATH": os.environ["PATH"], "HOME": str(root / "home")}, timeout=60))
        app_url = manifest["entry"]

        with socket.socket() as probe:
            probe.bind(("127.0.0.1", 0))
            port = probe.getsockname()[1]
        origin = f"http://127.0.0.1:{port}"
        token = secrets.token_urlsafe(36)
        tmux_name = "orbit-parity-" + secrets.token_hex(8)
        env = {"PATH": os.environ["PATH"], "HOME": str(root / "home"), "PORT": str(port),
               "ORBIT_TOKEN": token, "ORBIT_RUNTIME_DIR": str(root / "runtime"),
               "ORBIT_CWD": str(root / "cwd"), "TMUX_TMPDIR": str(root / "tmux"),
               "ORBIT_TMUX_SOCKET": tmux_name, "ORBIT_TMUX_CONFIG": "/dev/null",
               "TERM": "xterm-256color"}
        server = subprocess.Popen([shutil.which("node"), "--experimental-strip-types", "server/index.mjs"],
                                  cwd=root, env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)

        def call(action, workspace, control=False, **fields):
            credential = token
            if control:
                credential = json.loads((root / "runtime/workspace-access" / (workspace + ".json")).read_text())["capability"]
            request = urllib.request.Request(origin + ("/api/workspace/control" if control else "/api/workspace"),
                data=json.dumps({"workspace_id": workspace, "action": action, **fields}).encode(),
                headers={"Origin": origin, "Authorization": "Bearer " + credential,
                         "Content-Type": "application/json"})
            try:
                with urllib.request.urlopen(request, timeout=15) as response:
                    return json.load(response)
            except urllib.error.HTTPError as error:
                raise AssertionError(f"{action} rejected: HTTP {error.code}: {error.read().decode()}") from error

        browser = None
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

            with sync_playwright() as playwright:
                browser = playwright.chromium.launch(headless=True, args=[
                    "--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"])
                transcripts = {}

                def build_state(windows, panes, extra):
                    def monitor(index, kind, url):
                        return {"id": windows[index], "name": f"Parity {index}", "diagonal": 32,
                                "aspect": "16:9", "height": 0, "distance": 0, "pitch": 0, "yaw": 0,
                                "offset": 0, "fontSize": 19,
                                "frame": {"x": 30 + 220 * index, "y": 30 + 45 * index,
                                          "width": 620, "height": 510, "z": index + 1},
                                "layout": {"type": "pane", "pane": {"id": panes[index], "kind": kind,
                                                                   "url": url or "orbit://welcome"}}}
                    monitors = [monitor(i, "terminal" if args.pty and i == 2 else "browser",
                                        None if (args.pty and i == 2) else app_url) for i in range(len(windows))]
                    # A stable extra welcome pane makes update_split on window 0 valid
                    # without generating server-assigned pane ids between the two runs.
                    monitors[0]["layout"] = {"type": "split", "axis": "row", "ratio": .5,
                                             "first": monitors[0]["layout"],
                                             "second": {"type": "pane", "pane": {"id": extra,
                                                                                 "kind": "browser", "url": "orbit://welcome"}}}
                    return {"version": 1, "selected": windows[0], "arc": 14, "view": "windows",
                            "monitors": monitors}

                def run_scene(renderer, workspace, windows, panes, extra, state):
                    context = browser.new_context(viewport={"width": 1600, "height": 1000})
                    context.add_init_script("if(window===window.top){localStorage.setItem('orbit.onboarding.v1','done');"
                        "localStorage.setItem('orbit.menu.pinned','true');localStorage.setItem('orbit.workspace.id'," +
                        json.dumps(workspace) + ");localStorage.setItem('orbit.workspace.v1',JSON.stringify(" +
                        json.dumps(state) + "));}")
                    page = context.new_page()
                    try:
                        errors, navigations, sockets, ws_data, terminal_frames = [], [], [], [], []
                        page.on("pageerror", lambda error: errors.append(str(error)))
                        page.on("framenavigated", lambda frame: navigations.append(frame.url) if frame != page.main_frame else None)

                        def watch(ws):
                            sockets.append(ws)
                            if ws.url.endswith("/api/terminal"):
                                terminal_frames.append(ws)
                                ws.on("framereceived", lambda payload: ws_data.append(json.loads(payload)))

                        page.on("websocket", watch)
                        page.goto(origin + ("/?renderer=docking" if renderer == "docking" else "/"),
                                  wait_until="domcontentloaded")
                        if renderer == "docking":
                            # Arrow-function predicate: the served UI sets script-src 'self',
                            # which makes Playwright's plain-expression polling eval fail.
                            page.wait_for_function("() => document.documentElement.dataset.dockingRenderer === 'docking' && window.__orbitDocking?.supported === true")
                        if not page.evaluate("typeof Element.prototype.moveBefore === 'function'"):
                            raise RuntimeError("UNSUPPORTED BROWSER: Element.moveBefore is required; this is not a passing skip")
                        page.keyboard.press("Escape")
                        page.get_by_role("button", name="Connect local host", exact=True).click()
                        page.get_by_role("textbox", name="Host session token").fill(token)
                        page.get_by_role("button", name="Unlock local host", exact=True).click()
                        expect(page.locator(".saved")).to_contain_text("Workspace connected", timeout=15000)

                        def api(action, **fields):
                            return call(action, workspace, **fields)

                        def apply_api(*operations):
                            before = api("read")
                            return api("apply", control=True, base_revision=before["revision"],
                                       operations=list(operations))

                        def settle():
                            page.evaluate("() => new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))")

                        sync_js = """expected => {const s=JSON.parse(localStorage.getItem('orbit.workspace.v1')||'null');
                            if(!s) return false;
                            const clean=x=>JSON.parse(JSON.stringify(x,(k,v)=>k==='z'?undefined:v));
                            return JSON.stringify(clean({v:s.view,sel:s.selected,mon:s.monitors,app:s.appearance||{}}))===
                                   JSON.stringify(clean({v:expected.view,sel:expected.selected,mon:expected.monitors,app:expected.appearance||{}}));}"""

                        def ack(revision):
                            deadline = time.monotonic() + 15
                            while time.monotonic() < deadline:
                                observed = api("read", control=True)
                                if observed.get("observed_revision", 0) >= revision and observed.get("browser_seen"):
                                    return
                                page.wait_for_timeout(100)
                            raise AssertionError(f"Browser did not acknowledge committed revision {revision}")

                        def synced(result):
                            page.wait_for_function(sync_js, arg=result["state"], timeout=15000)
                            ack(result["revision"])

                        def iframe(pid):
                            return page.locator(f'.pane[data-pane-id="{pid}"] iframe')

                        retained = list(panes[:2])
                        expected_drafts = {pid: f"parity-{panes.index(pid)}-{workspace}" for pid in retained}
                        for pid in retained:
                            try:
                                expect(iframe(pid)).to_have_count(1, timeout=15000)
                            except AssertionError as error:
                                raise AssertionError(f"initial browser pane {pid} missing; rendered={page.locator('.pane').evaluate_all('(n)=>n.map(x=>x.dataset.paneId)')}; errors={errors}") from error
                            frames = page.frame_locator(f'.pane[data-pane-id="{pid}"] iframe')
                            frames.locator("#draft").fill(expected_drafts[pid])
                        page.evaluate("""ids => {window.__continuityNodes = Object.fromEntries(ids.map(id => {
                            const pane = document.querySelector(`.pane[data-pane-id="${id}"]`);
                            const frame = pane.querySelector('iframe');
                            return [id, {pane, frame, frameWindow: frame.contentWindow}];}));}""", retained)
                        baseline = {pid: page.frame_locator(f'.pane[data-pane-id="{pid}"] iframe').locator("#document-nonce").inner_text() for pid in retained}
                        nav_count = len(navigations)

                        shell_pid = None
                        if args.pty:
                            terminal_pane = page.locator(f'.pane[data-pane-id="{panes[2]}"]')
                            terminal_pane.get_by_role("button", name="Connect to local host shell").click()
                            expect(terminal_pane.locator(".connection-state")).to_contain_text("LIVE SHELL", timeout=15000)
                            assert len(terminal_frames) == 1, terminal_frames
                            terminal_pane.locator(".xterm-helper-textarea").focus()
                            page.keyboard.type("export ORBIT_PARITY_VAR=retained; printf 'ORBIT_PARITY_INIT_%s_%s\\n' \"$ORBIT_PARITY_VAR\" \"$$\"")
                            page.keyboard.press("Enter")

                            def fresh_output(prefix):
                                deadline = time.monotonic() + 12
                                while time.monotonic() < deadline:
                                    output = "".join(v.get("data", "") for v in ws_data if v.get("type") == "data")
                                    found = re.search(prefix + r"_retained_(\d+)", output)
                                    if found:
                                        return found.group(1)
                                    page.wait_for_timeout(80)
                                raise AssertionError(f"No fresh {prefix} shell output frame")

                            shell_pid = fresh_output("ORBIT_PARITY_INIT")
                            page.evaluate("id => window.__terminalNode = document.querySelector(`.pane[data-pane-id=\"${id}\"]`)", panes[2])

                        pane_index = {pid: i for i, pid in enumerate(panes)}
                        pane_index[extra] = len(panes)

                        def norm_layout(node):
                            if node.get("type") == "pane":
                                pane = node["pane"]
                                return ["pane", pane_index.get(pane["id"], pane["id"]), pane.get("kind"), pane.get("url")]
                            if node.get("type") == "split":
                                return ["split", node.get("axis"), round(float(node.get("ratio", .5)), 4),
                                        norm_layout(node["first"]), norm_layout(node["second"])]
                            return ["?", node]

                        def win_index(wid):
                            return windows.index(wid)

                        def docking_invariants(check_active=True):
                            diagnostic = page.evaluate("window.__orbitDocking")
                            assert diagnostic and diagnostic["renderer"] == "docking" and diagnostic["supported"] is True, diagnostic
                            local = page.evaluate("JSON.parse(localStorage.getItem('orbit.workspace.v1'))")
                            ids = [m["id"] for m in local["monitors"]]
                            # Library metadata must reconcile even while its grid is hidden.
                            assert sorted(diagnostic["panels"]) == sorted(ids), (diagnostic, ids)
                            focused = page.locator(".focus-host .monitor").count() > 0
                            if local["view"] != "windows" or focused:
                                return
                            assert sorted(diagnostic["panels"]) == sorted(ids), (diagnostic, ids)
                            if check_active:
                                assert diagnostic["active"] in ids and diagnostic["active"] == local["selected"], (diagnostic, local["selected"])
                            expect(page.locator(".docking-placeholder[data-docking-window]")).to_have_count(len(ids))
                            expect(page.locator(".docking-surfaces > .monitor[data-docking-surface]")).to_have_count(len(ids))
                            active = diagnostic["active"]
                            placeholder = page.locator(f'.docking-placeholder[data-docking-window="{active}"]')
                            surface = page.locator(f'.docking-surfaces > .monitor[data-docking-surface="{active}"]')
                            if "window-minimized" in (surface.get_attribute("class") or ""):
                                return  # a minimized window has no painted surface; v1/placement checks still ran
                            expect(surface).to_be_visible()
                            a, b = placeholder.bounding_box(), surface.bounding_box()
                            assert a and b and a["width"] > 0 and a["height"] > 0, (a, b)
                            assert all(abs(a[k] - b[k]) <= 3 for k in ("x", "y", "width", "height")), (active, a, b)

                        transcript = []

                        def record(label):
                            nonlocal nav_count
                            settle()
                            assert not errors, f"{label}: page errors {errors}"
                            assert len(navigations) == nav_count, f"{label}: unexpected iframe navigation {navigations[nav_count:]}"
                            minimized = {}
                            for wid in windows:
                                element = page.locator(f'.monitor[data-monitor-id="{wid}"]')
                                minimized[win_index(wid)] = bool(element.count()) and "window-minimized" in (element.get_attribute("class") or "")
                            retained_state = {}
                            for pid in retained:
                                i = panes.index(pid)
                                dom_ok = page.evaluate("""id => {const old=window.__continuityNodes[id];
                                    const pane=document.querySelector(`.pane[data-pane-id="${id}"]`);
                                    return !!pane && pane===old.pane && pane.querySelector('iframe')===old.frame &&
                                           old.frame.contentWindow===old.frameWindow && pane.isConnected;}""", pid)
                                nonce_ok = page.frame_locator(f'.pane[data-pane-id="{pid}"] iframe').locator("#document-nonce").inner_text() == baseline[pid]
                                draft_ok = page.frame_locator(f'.pane[data-pane-id="{pid}"] iframe').locator("#draft").input_value() == expected_drafts[pid]
                                assert dom_ok and nonce_ok and draft_ok, f"{label}: continuity lost for {i}: dom={dom_ok} nonce={nonce_ok} draft={draft_ok}"
                                retained_state[i] = [dom_ok, nonce_ok, draft_ok]
                            assert len([ws for ws in sockets if ws.url.endswith("/api/terminal")]) == int(args.pty), f"{label}: terminal WebSocket count changed"
                            if args.pty:
                                assert page.evaluate("id => window.__terminalNode === document.querySelector(`.pane[data-pane-id=\"${id}\"]`) && window.__terminalNode.isConnected", panes[2]), f"{label}: terminal pane DOM identity changed"
                                marker = "PAR" + secrets.token_hex(6).upper()
                                subprocess.run(["/usr/bin/tmux", "-L", tmux_name, "send-keys", "-t", "pane-" + panes[2],
                                                f"printf '{marker}_%s_%s\\n' \"$ORBIT_PARITY_VAR\" \"$$\"", "C-m"],
                                               env=env, check=True, capture_output=True, timeout=5)
                                assert fresh_output(marker) == shell_pid, f"{label}: live shell PID changed"
                            if renderer == "docking":
                                docking_invariants()
                            local = page.evaluate("JSON.parse(localStorage.getItem('orbit.workspace.v1'))")
                            transcript.append({
                                "label": label,
                                "view": local["view"],
                                "selected": win_index(local["selected"]),
                                "monitors": [{"id": win_index(m["id"]), "name": m["name"],
                                              "frame": [m["frame"]["x"], m["frame"]["y"], m["frame"]["width"], m["frame"]["height"]] if m.get("frame") else None,
                                              "layout": norm_layout(m["layout"])} for m in local["monitors"]],
                                "minimized": minimized,
                                "focusHost": page.locator(".focus-host .monitor").count(),
                                "navigations": len(navigations),
                                "terminalSockets": len([ws for ws in sockets if ws.url.endswith("/api/terminal")]),
                                "retained": retained_state,
                            })
                            nav_count = len(navigations)

                        def apply(label, *operations):
                            result = apply_api(*operations)
                            synced(result)
                            record(label)
                            return result

                        def ui(label, fn):
                            fn()
                            record(label)

                        record("initial")
                        assert api("read", control=True)["placement_revision"] == 0
                        result = apply("baseline nested split", {"action": "update_split", "window_id": windows[0],
                                      "path": [], "ratio": .55, "axis": "column", "swap": False})
                        checkpoint = api("checkpoint", control=True, label="Parity baseline")["checkpoint"]

                        for cycle in range(3):
                            ui(f"{cycle}: spatial", lambda: (
                                page.get_by_role("button", name="Switch to spatial view", exact=True).click(),
                                page.wait_for_function("() => JSON.parse(localStorage.getItem('orbit.workspace.v1')).view === 'spatial'"),
                                expect(page.locator(".workspace")).not_to_have_class(re.compile(r"windows-mode"))))
                            ui(f"{cycle}: focus", lambda: (
                                page.get_by_role("button", name="Focus selected display", exact=True).click(),
                                expect(page.locator(".focus-host .monitor")).to_have_count(1)))
                            ui(f"{cycle}: unfocus", lambda: (
                                page.get_by_role("button", name="Exit focus view", exact=True).click(),
                                expect(page.locator(".focus-host .monitor")).to_have_count(0)))
                            ui(f"{cycle}: windows", lambda: (
                                page.get_by_role("button", name="Switch to movable windows", exact=True).click(),
                                page.wait_for_function("() => JSON.parse(localStorage.getItem('orbit.workspace.v1')).view === 'windows'"),
                                expect(page.locator(".workspace")).to_have_class(re.compile("windows-mode"))))
                            first = api("read")["state"]["monitors"][0]["id"]
                            apply(f"{cycle}: metadata", {"action": "update_window", "window_id": first,
                                  "name": f"Parity round {cycle}", "distance": cycle * .1,
                                  "frame": {"x": 25 + cycle, "y": 26 + cycle, "width": 620 + cycle, "height": 510, "z": cycle + 3}})
                            order = [m["id"] for m in api("read")["state"]["monitors"]]
                            apply(f"{cycle}: reorder", {"action": "reorder_windows", "window_ids": order[::-1]})
                            apply(f"{cycle}: split ratio/axis", {"action": "update_split", "window_id": windows[0],
                                  "path": [], "ratio": .3 if cycle % 2 else .7,
                                  "axis": "column" if cycle % 2 else "row", "swap": cycle % 2 == 0})
                            layouts = api("read")["state"]["monitors"]
                            owner0 = next(m["id"] for m in layouts if panes[0] in json.dumps(m["layout"]))
                            owner1 = next(m["id"] for m in layouts if panes[1] in json.dumps(m["layout"]))
                            apply(f"{cycle}: cross-window swap", {"action": "swap_panes", "window_id": owner0,
                                  "pane_id": panes[0], "other_window_id": owner1, "other_pane_id": panes[1]})
                            if cycle % 2 == 0:
                                name = next(m["name"] for m in api("read")["state"]["monitors"] if m["id"] == windows[0])
                                ui(f"{cycle}: minimize", lambda n=name: (
                                    page.get_by_role("button", name=f"Minimize {n}", exact=True).click(force=True),
                                    expect(page.locator(f'.monitor[data-monitor-id="{windows[0]}"]')).to_have_class(re.compile("window-minimized"))))
                                ui(f"{cycle}: restore", lambda n=name: page.get_by_role("button", name=f"Restore {n}", exact=True).click())

                        apply("appearance metadata", {"action": "patch_appearance", "patch": {"accentColor": "#123456", "cornerRadius": 12}})

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

                        before = api("read")
                        restored = api("restore", control=True, base_revision=before["revision"],
                                       checkpoint_id=checkpoint, confirm=True)
                        try:
                            page.wait_for_function("""expected => {const s=JSON.parse(localStorage.getItem('orbit.workspace.v1')||'null');
                                return s && JSON.stringify(s.monitors.map(m=>[m.id,m.name,m.layout]))===
                                       JSON.stringify(expected.monitors.map(m=>[m.id,m.name,m.layout]));}""",
                                arg=restored["state"], timeout=20000)
                        except Exception as error:
                            actual = page.evaluate("JSON.parse(localStorage.getItem('orbit.workspace.v1'))")
                            raise AssertionError(f"restore not applied to browser: actual={json.dumps(actual)[:1500]} expected={json.dumps(restored['state'])[:1500]}") from error
                        ack(restored["revision"])
                        record("checkpoint rollback restore")
                        applied = page.evaluate("JSON.parse(localStorage.getItem('orbit.workspace.v1'))")
                        rollback_xy = {m["id"]: [m["frame"]["x"], m["frame"]["y"]] for m in applied["monitors"] if m.get("frame")}
                        expected_xy = {m["id"]: [m["frame"]["x"], m["frame"]["y"]] for m in restored["state"]["monitors"] if m.get("frame")}
                        assert rollback_xy == expected_xy, f"{renderer} did not preserve rollback frames: {rollback_xy} != {expected_xy}"
                        # Outwait both Dockview's 2-rAF suppression and the save debounce.
                        # A remote rollback/default layout must never become a local save.
                        page.wait_for_timeout(1200)
                        passive_placement_revision = api("read", control=True)["placement_revision"]
                        assert passive_placement_revision == 0, passive_placement_revision

                        if renderer == "docking":
                            # Docking-only placement transition: tab a window into another group
                            # and prove no runtime is disposed and v1 is untouched (placement is an adjunct).
                            toolbar = page.get_by_role("toolbar", name="Docking layout", exact=True)
                            toolbar.get_by_role("combobox", name="Docking window", exact=True).select_option(windows[1])
                            toolbar.get_by_role("combobox", name="Docking target", exact=True).select_option(windows[0])
                            before_local = page.evaluate("JSON.parse(localStorage.getItem('orbit.workspace.v1'))")
                            before_nav = len(navigations)
                            toolbar.get_by_role("button", name="Tab to target", exact=True).click()
                            settle()
                            assert len(navigations) == before_nav, "docking tab transition navigated a retained iframe"
                            assert page.evaluate("JSON.parse(localStorage.getItem('orbit.workspace.v1'))") == before_local, "docking tab transition mutated v1"
                            for pid in retained:
                                i = panes.index(pid)
                                assert page.evaluate("""id => {const old=window.__continuityNodes[id];
                                    const pane=document.querySelector(`.pane[data-pane-id="${id}"]`);
                                    return !!pane && pane===old.pane && pane.querySelector('iframe')===old.frame &&
                                           old.frame.contentWindow===old.frameWindow && pane.isConnected;}""", pid), f"docking tab lost runtime {i}"
                                assert page.frame_locator(f'.pane[data-pane-id="{pid}"] iframe').locator("#document-nonce").inner_text() == baseline[pid]
                                assert page.frame_locator(f'.pane[data-pane-id="{pid}"] iframe').locator("#draft").input_value() == expected_drafts[pid]
                            docking_invariants(check_active=False)
                            deadline = time.monotonic() + 10
                            while api("read", control=True)["placement_revision"] == 0 and time.monotonic() < deadline:
                                page.wait_for_timeout(100)
                            assert api("read", control=True)["placement_revision"] > 0, "explicit toolbar edit was not saved"
                            tab_revision = api("read", control=True)["placement_revision"]
                            toolbar.get_by_role("button", name="Dock right", exact=True).click()
                            deadline = time.monotonic() + 10
                            while api("read", control=True)["placement_revision"] == tab_revision and time.monotonic() < deadline:
                                page.wait_for_timeout(100)
                            assert api("read", control=True)["placement_revision"] > tab_revision
                            saved_placement_checkpoint = api("checkpoint", control=True, label="Saved docking placement")["checkpoint"]
                            saved_placement = api("read", control=True)["placement"]
                            before_placement_revision = api("read", control=True)["placement_revision"]
                            toolbar.get_by_role("button", name="Float window", exact=True).click()
                            deadline = time.monotonic() + 10
                            while api("read", control=True)["placement_revision"] == before_placement_revision and time.monotonic() < deadline:
                                page.wait_for_timeout(100)
                            assert api("read", control=True)["placement_revision"] > before_placement_revision
                            before = api("read", control=True)
                            rollback = api("restore", control=True, base_revision=before["revision"],
                                           checkpoint_id=saved_placement_checkpoint, confirm=True)
                            synced(rollback)
                            page.wait_for_timeout(1200)
                            after_rollback = api("read", control=True)
                            assert after_rollback["placement"] == saved_placement
                            assert after_rollback["placement_revision"] == rollback["placement_revision"], "saved placement rollback echoed a placement_save"
                            saved_rollback_revision = after_rollback["placement_revision"]
                            # A physical sash drag must still produce a placement save.
                            hits = page.locator(".dv-sash").evaluate_all("""nodes=>nodes.map(n=>{const r=n.getBoundingClientRect(),x=r.x+r.width/2,y=r.y+r.height/2;
                                return {x,y,w:r.width,h:r.height,hit:!!document.elementFromPoint(x,y)?.closest('.dv-sash')};})""")
                            hit = next((h for h in hits if h["hit"] and h["w"] > 0 and h["h"] > 0), None)
                            assert hit, hits
                            page.mouse.move(hit["x"], hit["y"])
                            page.mouse.down()
                            page.mouse.move(hit["x"] + (45 if hit["h"] > hit["w"] else 0),
                                            hit["y"] + (45 if hit["w"] >= hit["h"] else 0), steps=9)
                            page.mouse.up()
                            deadline = time.monotonic() + 10
                            while api("read", control=True)["placement_revision"] == saved_rollback_revision and time.monotonic() < deadline:
                                page.wait_for_timeout(100)
                            assert api("read", control=True)["placement_revision"] > saved_rollback_revision, "physical sash drag was not saved"
                            assert len(navigations) == before_nav, "placement rollback/drag navigated a retained iframe"
                            for pid in retained:
                                assert page.evaluate("""id => {const old=window.__continuityNodes[id];
                                    const pane=document.querySelector(`.pane[data-pane-id="${id}"]`);
                                    return pane===old.pane && pane.querySelector('iframe')===old.frame &&
                                        old.frame.contentWindow===old.frameWindow && pane.isConnected;}""", pid)
                                assert page.frame_locator(f'.pane[data-pane-id="{pid}"] iframe').locator("#document-nonce").inner_text() == baseline[pid]
                                assert page.frame_locator(f'.pane[data-pane-id="{pid}"] iframe').locator("#draft").input_value() == expected_drafts[pid]
                            if args.pty:
                                marker = "PAR" + secrets.token_hex(6).upper()
                                subprocess.run(["/usr/bin/tmux", "-L", tmux_name, "send-keys", "-t", "pane-" + panes[2],
                                                f"printf '{marker}_%s_%s\\n' \"$ORBIT_PARITY_VAR\" \"$$\"", "C-m"],
                                               env=env, check=True, capture_output=True, timeout=5)
                                assert fresh_output(marker) == shell_pid, "docking tab transition reset the shell"

                        # Negative controls: a deliberate URL change replaces only its document,
                        # and closing a pane removes only its DOM. Identical on both renderers.
                        before = api("read")
                        owner = next(m["id"] for m in before["state"]["monitors"] if panes[0] in json.dumps(m["layout"]))
                        api("apply", control=True, base_revision=before["revision"], operations=[
                            {"action": "set_pane", "window_id": owner, "pane_id": panes[0], "url": app_url + "?deliberate=1"}])
                        page.wait_for_function("""([id,url]) => {const s=JSON.parse(localStorage.getItem('orbit.workspace.v1'));
                            return JSON.stringify(s.monitors).includes(url) && !!document.querySelector(`.pane[data-pane-id="${id}"] iframe[src*="deliberate"]`);}""",
                            arg=[panes[0], "?deliberate=1"], timeout=15000)
                        url_nonce_changed = page.frame_locator(f'.pane[data-pane-id="{panes[0]}"] iframe').locator("#document-nonce").inner_text() != baseline[panes[0]]
                        url_draft_empty = page.frame_locator(f'.pane[data-pane-id="{panes[0]}"] iframe').locator("#draft").input_value() == ""
                        other_retained = page.frame_locator(f'.pane[data-pane-id="{panes[1]}"] iframe').locator("#document-nonce").inner_text() == baseline[panes[1]]
                        assert url_nonce_changed and url_draft_empty and other_retained, (url_nonce_changed, url_draft_empty, other_retained)
                        before = api("read")
                        owner = next(m["id"] for m in before["state"]["monitors"] if panes[0] in json.dumps(m["layout"]))
                        api("apply", control=True, base_revision=before["revision"], operations=[
                            {"action": "close_pane", "window_id": owner, "pane_id": panes[0]}])
                        expect(page.locator(f'.pane[data-pane-id="{panes[0]}"]')).to_have_count(0, timeout=15000)
                        assert len([ws for ws in sockets if ws.url.endswith("/api/terminal")]) == int(args.pty)
                        transcript.append({"label": "negative controls", "url_nonce_changed": url_nonce_changed,
                                           "url_draft_empty": url_draft_empty, "other_retained": other_retained,
                                           "closed_pane_removed": True})

                        final = api("read")
                        for _ in range(80):
                            if final["observed_revision"] >= final["revision"]:
                                break
                            page.wait_for_timeout(100)
                            final = api("read")
                        assert final["observed_revision"] >= final["revision"], final
                        assert not errors, errors
                        page.screenshot(path=f"/tmp/opencode/orbit-renderer-parity-{renderer}.png")
                        return {"transcript": transcript, "browser": browser.version, "errors": errors,
                                "revision": final["revision"], "observed_revision": final["observed_revision"],
                                "passive_placement_revision": passive_placement_revision,
                                "placement_revision": final["placement_revision"],
                                "saved_rollback_revision": saved_rollback_revision if renderer == "docking" else None,
                                "rollback_xy": rollback_xy, "expected_xy": expected_xy}
                    finally:
                        context.close()

                for renderer in ("default", "docking"):
                    workspace = str(uuid.uuid4())
                    windows = [str(uuid.uuid4()) for _ in range(3 if args.pty else 2)]
                    panes = [str(uuid.uuid4()) for _ in windows]
                    extra = str(uuid.uuid4())
                    transcripts[renderer] = run_scene(renderer, workspace, windows, panes, extra,
                                                      build_state(windows, panes, extra))
                browser.close()
                browser = None

        finally:
            if browser is not None:
                try:
                    browser.close()
                except Exception:
                    pass
            server.terminate()
            try:
                server.wait(timeout=5)
            except subprocess.TimeoutExpired:
                server.kill()
                server.wait(timeout=5)
            if args.pty:
                subprocess.run(["/usr/bin/tmux", "-L", tmux_name, "kill-server"], env=env,
                               stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=5, check=False)

    default, docking = transcripts["default"], transcripts["docking"]
    assert default["errors"] == [] and docking["errors"] == [], (default["errors"], docking["errors"])

    default_transcript = default["transcript"]
    docking_transcript = docking["transcript"]
    if default_transcript != docking_transcript:
        for a, b in zip(default_transcript, docking_transcript):
            if a != b:
                raise AssertionError("renderer behavior diverged:\n"
                                     f"  default: {json.dumps(a, sort_keys=True)}\n"
                                     f"  docking: {json.dumps(b, sort_keys=True)}")
        raise AssertionError(f"renderer transcripts differ in length: {len(default_transcript)} vs {len(docking_transcript)}")
    assert docking["rollback_xy"] == docking["expected_xy"], (docking["rollback_xy"], docking["expected_xy"])
    assert default["rollback_xy"] == default["expected_xy"], (default["rollback_xy"], default["expected_xy"])
    print(json.dumps({"result": "PASS", "renderers": ["default", "docking"],
                      "transitionsPerRenderer": len(default["transcript"]), "pty": args.pty,
                      "browser": default["browser"], "pageErrors": 0,
                      "zeroPageErrors": True, "identicalTranscripts": True,
                      "default": {"revision": default["revision"], "observed_revision": default["observed_revision"]},
                      "docking": {"revision": docking["revision"], "observed_revision": docking["observed_revision"],
                                  "passive_placement_revision": docking["passive_placement_revision"],
                                  "saved_rollback_revision": docking["saved_rollback_revision"],
                                  "placement_revision": docking["placement_revision"]},
                      "rollbackFrameXY": {"default": default["rollback_xy"], "docking": docking["rollback_xy"],
                                           "restored": docking["expected_xy"], "bothMatchRestored": True},
                      "checks": ["windows/spatial", "focus/unfocus", "minimize/restore", "update_window",
                                 "reorder_windows", "update_split", "swap_panes", "patch_appearance",
                                 "source-window removal + reparent", "checkpoint rollback restore",
                                 "URL replacement negative control", "close_pane negative control",
                                  "docking placement invariants", "docking tab without runtime loss",
                                  "no default placement save", "saved placement rollback without echo",
                                  "physical sash drag saves placement"]}))


if __name__ == "__main__":
    main()
