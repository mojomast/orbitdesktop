"""Isolated real-browser Orbit docking spike gate.

Uses the already-built dist; never starts the owner's server or tmux socket.
Run with PLAYWRIGHT_BROWSERS_PATH=/tmp/opencode/orbit-evolution-browsers
  /tmp/opencode/orbit-evolution-browser-venv/bin/python tests/orbit-docking.browser.py
"""

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
from urllib.parse import quote
import uuid

from playwright.sync_api import expect, sync_playwright


ROOT = Path(__file__).resolve().parents[1]
PAGE = ROOT / "experiments/orbit-docking/index.html"
FIXTURE = ROOT / "tests/fixtures/runtime-continuity.html"


def port_number():
    with socket.socket() as probe:
        probe.bind(("127.0.0.1", 0))
        return probe.getsockname()[1]


def wait_for_server(server, origin):
    for _ in range(160):
        if server.poll() is not None:
            raise RuntimeError(f"Disposable server exited ({server.returncode})")
        try:
            with urllib.request.urlopen(origin + "/api/health", timeout=1):
                return
        except OSError:
            time.sleep(.05)
    raise RuntimeError("Disposable server startup timed out")


def main():
    build = Path("/tmp/opencode/orbit-docking-build")
    if not (PAGE.is_file() and (PAGE.parent / "build.mjs").is_file()):
        raise RuntimeError(f"Spike worker page/build missing: {PAGE}")
    if not (ROOT / "dist/index.html").is_file():
        raise RuntimeError("Existing dist missing; this gate does not build the owner tree")
    if not shutil.which("tmux") or "ORBIT_TMUX_SOCKET" not in (ROOT / "server/local-host.mjs").read_text():
        raise RuntimeError("PTY isolation requires tmux and server socket override; not a passing skip")
    subprocess.run([shutil.which("node"), str(PAGE.parent / "build.mjs"), str(build)],
                   cwd=ROOT, check=True, timeout=120)
    if not (build / "index.html").is_file():
        raise RuntimeError("Spike build did not produce index.html")

    with tempfile.TemporaryDirectory(prefix="orbit-docking-spike-", dir="/tmp/opencode") as temporary:
        root = Path(temporary)
        for name in ("server", "src", "contracts", "dist"):
            shutil.copytree(ROOT / name, root / name)
        shutil.copytree(build, root / "dist/orbit-docking")
        (root / "node_modules").symlink_to(ROOT / "node_modules", target_is_directory=True)
        shutil.copy2(ROOT / "package.json", root / "package.json")
        for name in ("runtime", "home", "cwd", "tmux"):
            (root / name).mkdir(mode=0o700)
        fixture = root / "fixture"
        fixture.mkdir()
        shutil.copy2(FIXTURE, fixture / "index.html")
        publish_env = {"PATH": os.environ["PATH"], "HOME": str(root / "home")}
        manifest = json.loads(subprocess.check_output([
            shutil.which("python3"), str(ROOT / "scripts/plugin_publish.py"), str(fixture),
            "--id", "orbit-docking-fixture", "--version", "1.0.0",
            "--title", "Isolated docking fixture", "--runtime", str(root / "runtime"),
        ], text=True, env=publish_env))
        fixture_url = manifest["entry"]
        port = port_number()
        origin = f"http://127.0.0.1:{port}"
        token, workspace = secrets.token_urlsafe(36), str(uuid.uuid4())
        tmux_name = "orbit-docking-" + secrets.token_hex(12)
        env = {"PATH": os.environ["PATH"], "HOME": str(root / "home"), "PORT": str(port),
               "ORBIT_TOKEN": token, "ORBIT_RUNTIME_DIR": str(root / "runtime"),
               "ORBIT_CWD": str(root / "cwd"), "TMUX_TMPDIR": str(root / "tmux"),
               "ORBIT_TMUX_SOCKET": tmux_name, "ORBIT_TMUX_CONFIG": "/dev/null",
               "TERM": "xterm-256color"}
        server = subprocess.Popen([shutil.which("node"), "--experimental-strip-types", "server/index.mjs"],
                                  cwd=root, env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        try:
            wait_for_server(server, origin)
            def api(action, control=False, **fields):
                credential = (json.loads((root / "runtime/workspace-access" / (workspace + ".json")).read_text())["capability"]
                              if control else token)
                request = urllib.request.Request(
                    origin + ("/api/workspace/control" if control else "/api/workspace"),
                    data=json.dumps({"workspace_id": workspace, "action": action, **fields}).encode(),
                    headers={"Origin": origin, "Authorization": "Bearer " + credential,
                             "Content-Type": "application/json"})
                try:
                    with urllib.request.urlopen(request, timeout=10) as response:
                        return json.load(response)
                except urllib.error.HTTPError as error:
                    raise AssertionError(f"Disposable {action} rejected: HTTP {error.code}: {error.read().decode()}") from error

            run_browser(origin, token, workspace, fixture_url, tmux_name, env, api)
        finally:
            server.terminate()
            try:
                server.wait(timeout=5)
            except subprocess.TimeoutExpired:
                server.kill()
                server.wait(timeout=5)
            subprocess.run([shutil.which("tmux"), "-L", tmux_name, "kill-server"], env=env,
                           stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=5, check=False)


def run_browser(origin, token, workspace, fixture_url, tmux_name, env, api):
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=True, args=[
            "--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader",
        ])
        context = browser.new_context(viewport={"width": 1600, "height": 1000})
        context.add_init_script("if(window === window.top) window.__orbitSpikeToken = " + json.dumps(token) + ";")
        page = context.new_page()
        errors, navigations, sockets, frames = [], [], [], []
        page.on("pageerror", lambda error: errors.append(str(error)))
        page.on("framenavigated", lambda frame: navigations.append(frame.url) if frame != page.main_frame else None)

        def observe_socket(ws):
            if ws.url.endswith("/api/terminal"):
                data = []
                ws.on("framereceived", lambda payload: data.append(json.loads(payload)))
                sockets.append(ws)
                frames.append(data)

        page.on("websocket", observe_socket)
        try:
            page.goto(origin + "/orbit-docking/index.html?fixture=" + quote(fixture_url, safe=""), wait_until="domcontentloaded")
            page.evaluate("() => window.orbitSpike.ready")
            assert page.evaluate("typeof Element.prototype.moveBefore === 'function'"), "native moveBefore required"
            initial = page.evaluate("window.orbitSpike.snapshot()")
            server_state = api("sync", state=initial["state"], base_revision=0)["state"]
            assert server_state == initial["state"], "Disposable server did not accept initial v1 layout"
            window_ids = [m["id"] for m in initial["state"]["monitors"]]
            pane_ids = [m["layout"]["pane"]["id"] for m in initial["state"]["monitors"]]
            assert len(window_ids) == len(pane_ids) == 3, initial
            assert all(re.fullmatch(r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}", pid)
                       for pid in pane_ids), "Pane IDs must be valid UUIDs for persistent private tmux binding"
            assert set(initial["panes"]) == set(pane_ids), initial
            assert [initial["panes"][pid]["kind"] for pid in pane_ids] == ["browser", "browser", "terminal"], initial
            assert initial["nativeMoveBefore"], initial
            for i, pid in enumerate(pane_ids[:2]):
                fixture_frame = page.frame_locator(f'.pane[data-pane-id="{pid}"] iframe')
                fixture_frame.locator("#document-nonce").wait_for(timeout=15000)
                fixture_frame.locator("#draft").fill(f"unsaved-{pid}-{workspace}")
            page.evaluate("""ids => { window.__spikeOriginal = Object.fromEntries(ids.map(id => {
                const pane = document.querySelector(`.pane[data-pane-id="${id}"]`);
                if (!pane) throw Error(`Missing real PaneView ${id}`);
                const iframe = pane.querySelector('iframe');
                return [id, {pane, iframe, frameWindow: iframe?.contentWindow}];
            })); }""", pane_ids)
            baseline = page.evaluate("window.orbitSpike.snapshot()")
            nonces = {pid: page.frame_locator(f'.pane[data-pane-id="{pid}"] iframe')
                      .locator("#document-nonce").inner_text() for pid in pane_ids[:2]}
            navigation_count = len(navigations)

            terminal = page.locator(f'.pane[data-pane-id="{pane_ids[2]}"]')
            terminal.get_by_role("button", name="Connect to local host shell").click()
            expect(terminal.locator(".connection-state")).to_contain_text("LIVE SHELL", timeout=15000)
            assert len(sockets) == 1, f"Initial PTY WebSockets: {len(sockets)}"
            terminal.locator(".xterm-helper-textarea").focus()
            # Keep subsequent shell commands short: a hidden Dockview tab may
            # have only a few rows and echoing a long printf command scrolls
            # its result out of tmux's current viewport before the WS paints.
            page.keyboard.type("export ORBIT_DOCKING_VAR=K; function d(){ printf '%s_%s_%s\\n' \"$1\" \"$ORBIT_DOCKING_VAR\" \"$$\"; }; d DOCKINIT")
            page.keyboard.press("Enter")

            def fresh_output(marker, start=0):
                deadline = time.monotonic() + 12
                while time.monotonic() < deadline:
                    output = "".join(v.get("data", "") for v in frames[0][start:] if v.get("type") == "data")
                    match = re.search(re.escape(marker) + r"_K_(\d+)", output)
                    if match:
                        return match.group(1)
                    page.wait_for_timeout(70)
                raise AssertionError(f"No fresh terminal WebSocket output for {marker}")

            shell_pid = fresh_output("DOCKINIT")
            assert shell_pid.isdigit()

            def verify(label):
                assert not errors, f"{label}: page errors: {errors}"
                assert len(navigations) == navigation_count, f"{label}: unexpected iframe navigations: {navigations[navigation_count:]}"
                snap = page.evaluate("window.orbitSpike.snapshot()")
                bindings = {p["id"]: (m["id"], p["kind"], p["url"])
                            for m in snap["state"]["monitors"] for p in
                            ([m["layout"]["pane"]] if m["layout"]["type"] == "pane" else [])}
                assert set(bindings) == set(pane_ids), f"{label}: mapped pane IDs changed: {bindings}"
                for pid in pane_ids:
                    old, now = baseline["panes"][pid], snap["panes"].get(pid)
                    assert now and now["connected"] and now["identity"] == old["identity"], f"{label}: pane object replaced: {pid}: {now}"
                    owner_id, expected_kind, expected_url = bindings[pid]
                    assert (now["kind"], now["url"]) == (expected_kind, expected_url), f"{label}: pane resource binding mismatch: {pid}"
                    assert page.evaluate("""id => {const old=window.__spikeOriginal[id];
                        const pane=document.querySelector(`.pane[data-pane-id="${id}"]`);
                        return pane && pane===old.pane && pane.isConnected &&
                        pane.querySelector('iframe')===old.iframe &&
                         (!old.iframe || old.iframe.contentWindow===old.frameWindow);} """, pid), f"{label}: DOM parent/iframe/window identity lost: {pid}"
                    assert page.evaluate("""([pid,mid]) => document.querySelector(`.pane[data-pane-id="${pid}"]`)
                        ?.closest('.monitor')?.dataset.monitorId === mid""", [pid, owner_id]), f"{label}: pane {pid} detached from mapped monitor {owner_id}"
                for pid in pane_ids[:2]:
                    assert snap["panes"][pid]["iframeIdentity"] == baseline["panes"][pid]["iframeIdentity"], f"{label}: iframe replaced {pid}"
                    assert snap["panes"][pid]["contentWindowIdentity"] == baseline["panes"][pid]["contentWindowIdentity"], f"{label}: iframe window replaced {pid}"
                    fixture_frame = page.frame_locator(f'.pane[data-pane-id="{pid}"] iframe')
                    assert fixture_frame.locator("#document-nonce").inner_text() == nonces[pid], f"{label}: nonce changed {pid}"
                    assert fixture_frame.locator("#draft").input_value() == f"unsaved-{pid}-{workspace}", f"{label}: unsaved draft lost {pid}"
                assert len(sockets) == 1, f"{label}: opened {len(sockets)} PTY WebSockets"
                assert "LIVE SHELL" in snap["panes"][pane_ids[2]]["terminalStatus"], f"{label}: terminal not live"
                marker = "D" + secrets.token_hex(3).upper()
                index = len(frames[0])
                subprocess.run([shutil.which("tmux"), "-L", tmux_name, "send-keys", "-t",
                                "pane-" + pane_ids[2],
                                 f"d {marker}", "C-m"],
                               env=env, check=True, capture_output=True, timeout=5)
                try:
                    observed_pid = fresh_output(marker, index)
                except AssertionError as error:
                    raise AssertionError(f"{label}: {error}; websocket closed={sockets[0].is_closed()}; recent frames={frames[0][-4:]}") from error
                assert observed_pid == shell_pid, f"{label}: shell PID changed"
                return snap

            verify("initial")
            count, categories = 0, {}

            def command(label, name, args=None):
                nonlocal count
                before = page.evaluate("window.orbitSpike.snapshot()")
                result = page.evaluate("([name,args]) => window.orbitSpike.command(name,args)", [name, args or {}])
                assert result and result["state"] and result["panes"], f"{label}: command returned no state"
                after = verify(label)
                assert result["state"] == after["state"], f"{label}: snapshot/state disagree"
                assert before != after, f"{label}: no observable state or placement transition"
                if name == "select":
                    assert after["state"]["selected"] == args["window_id"] != before["state"]["selected"], f"{label}: selection did not move"
                elif name == "reorder":
                    assert [m["id"] for m in after["state"]["monitors"]] == args["window_ids"] != [m["id"] for m in before["state"]["monitors"]], f"{label}: model order did not move"
                elif name in ("spatial", "windows"):
                    expected = "spatial" if name == "spatial" else "windows"
                    assert after["state"]["view"] == expected != before["state"]["view"], f"{label}: view did not change"
                elif name == "focus":
                    assert after["focused"] == args["window_id"] != before["focused"], f"{label}: focus did not move"
                elif name == "unfocus":
                    assert before["focused"] and not after["focused"], f"{label}: focus not exited"
                elif name == "reconcile":
                    assert after["state"] == args["state"] != before["state"], f"{label}: checkpoint state not reconciled"
                elif name == "apply":
                    assert after["state"] != before["state"], f"{label}: v1 operation had no model effect"
                else:
                    assert after["docking"] != before["docking"], f"{label}: Dockview placement did not change"
                count += 1
                categories[name] = categories.get(name, 0) + 1
                return after

            # Independent layout facets: do not count no-ops as transitions.
            for cycle in range(7):
                a, b, t = window_ids
                command(f"{cycle} select b", "select", {"window_id": b})
                command(f"{cycle} tab a into b", "tab", {"window_id": a, "target_window_id": b})
                command(f"{cycle} dock a", "dock", {"window_id": a, "target_window_id": b,
                                                       "direction": "left" if cycle % 2 else "right"})
                command(f"{cycle} float a", "float", {"window_id": a, "x": 40 + cycle * 12,
                                                        "y": 65 + cycle * 8, "width": 560, "height": 400})
                command(f"{cycle} spatial", "spatial")
                command(f"{cycle} focus b", "focus", {"window_id": b})
                command(f"{cycle} unfocus", "unfocus")
                command(f"{cycle} windows", "windows")
                command(f"{cycle} resize a", "resize", {"window_id": a,
                                                          "width": 525 + cycle * 15, "height": 390 + cycle * 7})
                order = [m["id"] for m in page.evaluate("window.orbitSpike.snapshot().state.monitors")]
                command(f"{cycle} reorder", "reorder", {"window_ids": order[::-1]})
                checkpoint_state = page.evaluate("window.orbitSpike.snapshot().state")
                latest = api("read")
                synced = api("sync", base_revision=latest["revision"], state=checkpoint_state)
                assert synced["state"] == checkpoint_state, f"{cycle}: server rejected mapped v1 snapshot"
                saved = api("checkpoint", control=True, base_revision=synced["revision"],
                            label=f"Docking integration cycle {cycle}")
                changed = api("apply", control=True, base_revision=synced["revision"],
                              operations=[{"action": "update_window", "window_id": t,
                                           "name": f"PTY layout {cycle}", "yaw": cycle * .1 + .01}])
                command(f"{cycle} server apply reconcile", "reconcile", {"state": changed["state"]})
                restored = api("restore", control=True, base_revision=changed["revision"],
                               checkpoint_id=saved["checkpoint"], confirm=True)
                assert restored["state"] == checkpoint_state, f"{cycle}: server checkpoint did not restore exact v1 state"
                command(f"{cycle} server checkpoint reconcile", "reconcile", {"state": restored["state"]})

            # Exercise physical geometry, not just the resize command's metadata.
            candidates = page.locator(".dv-sash:visible")
            candidates.first.wait_for(timeout=5000)
            hits = page.evaluate("""() => [...document.querySelectorAll('.dv-sash')].map(node => {
                const r=node.getBoundingClientRect(),x=r.left+r.width/2,y=r.top+r.height/2;
                const top=document.elementFromPoint(x,y);
                return {x,y,width:r.width,height:r.height,hit:!!top?.closest('.dv-sash'),top:top?.outerHTML.slice(0,120)};
            })""")
            hit = next((item for item in hits if item["width"] > 0 and item["height"] > 0 and item["hit"]), None)
            assert hit, f"No Dockview sash is physically hit-testable behind Orbit's surface overlay: {hits}"
            x, y = hit["x"], hit["y"]
            geometry = page.locator(".dv-groupview:visible").first
            before_width = geometry.evaluate("node => node.getBoundingClientRect().width")
            page.mouse.move(x, y)
            page.mouse.down()
            page.mouse.move(x + 45, y, steps=8)
            page.mouse.up()
            page.evaluate("() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))")
            after_width = geometry.evaluate("node => node.getBoundingClientRect().width")
            assert abs(after_width - before_width) > 3, f"Physical pointer resize did not change group width: {before_width} -> {after_width}"
            verify("pointer drag sash")

            # Keyboard reachability must be demonstrated with a real Tab, then
            # activate a focusable control via Enter (no synthetic dispatchEvent).
            page.locator('button[data-command="spatial"]').focus()
            assert page.evaluate("document.activeElement?.dataset.command") == "spatial"
            page.keyboard.press("Enter")
            assert verify("keyboard spatial")["state"]["view"] == "spatial", "Enter did not activate spatial control"
            page.keyboard.press("Tab")
            tab_target = page.evaluate("({tag:document.activeElement?.tagName,html:document.activeElement?.outerHTML.slice(0,200)})")
            assert tab_target["tag"] in ("BUTTON", "SELECT", "INPUT"), f"Keyboard focus escaped toolbar: {tab_target}"
            page.locator('button[data-command="windows"]').focus()
            page.keyboard.press("Enter")
            assert verify("keyboard windows")["state"]["view"] == "windows", "Enter did not activate windows control"

            # Native buttons are an authored keyboard path for the MIT core,
            # not a claim that Enterprise keyboard docking is available.
            for name, selected, target in [("select", window_ids[1], window_ids[0]),
                                           ("move", window_ids[0], window_ids[1]),
                                           ("dock", window_ids[0], window_ids[1]),
                                           ("float", window_ids[0], window_ids[1])]:
                page.locator("#window").select_option(selected)
                page.locator("#target").select_option(target)
                before_keyboard = page.evaluate("window.orbitSpike.snapshot()")
                control = page.locator(f'button[data-command="{name}"]')
                control.focus()
                page.keyboard.press("Enter")
                page.wait_for_function("name => document.querySelector('#status').textContent.startsWith(name+' complete')", arg=name)
                assert page.evaluate("document.activeElement?.dataset.command") == name, f"{name}: toolbar keyboard focus not returned"
                snap = verify("keyboard " + name)
                if name == "select":
                    assert snap["state"]["selected"] == selected, "Keyboard select did not update mapped v1 state"
                else:
                    assert snap["docking"] != before_keyboard["docking"], f"Keyboard {name} did not change Dockview placement"

            # Invalid pane ownership and unsupported appearance must reject atomically.
            for label, name, args in [
                ("invalid mapping", "apply", {"operations": [{"action": "swap_panes",
                    "window_id": window_ids[0], "pane_id": pane_ids[2],
                    "other_window_id": window_ids[1], "other_pane_id": pane_ids[1]}]}),
                ("invalid reorder", "reorder", {"window_ids": [window_ids[0], window_ids[0]]}),
                ("invalid selected mapping", "reconcile", {"state": {
                    **page.evaluate("window.orbitSpike.snapshot().state"), "selected": "missing-window"}}),
                ("unsupported appearance", "apply", {"operations": [{"action": "patch_appearance",
                    "patch": {"accentColor": "#123456"}}]}),
            ]:
                before = page.evaluate("window.orbitSpike.snapshot()")
                rejected = page.evaluate("""async ([name,args]) => {
                    try {await window.orbitSpike.command(name,args);return false;} catch {return true;}
                }""", [name, args])
                assert rejected, f"{label}: operation was unexpectedly accepted"
                assert before == page.evaluate("window.orbitSpike.snapshot()"), f"{label}: rejected operation mutated state"
                verify(label)

            assert count >= 50, f"Only {count} measured transitions"
            # Replacement controls intentionally do NOT claim continuity for A.
            replaced = page.evaluate("([name,args]) => window.orbitSpike.command(name,args)",
                                     ["set-pane", {"pane_id": pane_ids[0], "url": fixture_url + "?replacement=1"}])
            assert replaced["panes"][pane_ids[0]]["iframeIdentity"] != baseline["panes"][pane_ids[0]]["iframeIdentity"], "URL replacement retained old iframe"
            a_frame = page.frame_locator(f'.pane[data-pane-id="{pane_ids[0]}"] iframe')
            assert a_frame.locator("#document-nonce").inner_text() != nonces[pane_ids[0]], "URL replacement retained document nonce"
            assert a_frame.locator("#draft").input_value() == "", "URL replacement retained unsaved draft"
            assert page.frame_locator(f'.pane[data-pane-id="{pane_ids[1]}"] iframe').locator("#document-nonce").inner_text() == nonces[pane_ids[1]], "Unrelated B reloaded"
            page.evaluate("([name,args]) => window.orbitSpike.command(name,args)",
                          ["set-pane", {"pane_id": pane_ids[0], "kind": "terminal"}])
            assert page.locator(f'.pane[data-pane-id="{pane_ids[0]}"] iframe').count() == 0, "Kind replacement retained browser iframe"
            assert page.locator(f'.pane[data-pane-id="{pane_ids[0]}"] .xterm-helper-textarea').count() == 1, "Kind replacement did not instantiate PaneView xterm"
            page.evaluate("([name,args]) => window.orbitSpike.command(name,args)",
                          ["close", {"pane_id": pane_ids[0]}])
            expect(page.locator(f'.pane[data-pane-id="{pane_ids[0]}"]')).to_have_count(0)
            assert page.frame_locator(f'.pane[data-pane-id="{pane_ids[1]}"] iframe').locator("#document-nonce").inner_text() == nonces[pane_ids[1]], "Close reloaded unrelated B"
            marker = "D" + secrets.token_hex(3).upper()
            start = len(frames[0])
            subprocess.run([shutil.which("tmux"), "-L", tmux_name, "send-keys", "-t",
                            "pane-" + pane_ids[2],
                             f"d {marker}", "C-m"],
                           env=env, check=True, capture_output=True, timeout=5)
            assert len(sockets) == 1 and fresh_output(marker, start) == shell_pid, "Close interrupted unrelated PTY"
            print(json.dumps({"result": "PASS", "transitions": count, "categories": categories,
                              "shellPid": shell_pid, "terminalWebSockets": len(sockets),
                              "pointerWidth": [round(before_width, 1), round(after_width, 1)],
                              "keyboardTab": tab_target, "negativeControls": ["invalid mapping", "invalid reorder", "invalid selected mapping", "unsupported appearance", "URL", "kind", "close"],
                              "browser": browser.version}))
        finally:
            context.close()
            browser.close()


if __name__ == "__main__":
    main()
