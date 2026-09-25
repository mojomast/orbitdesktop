"""Real Chromium, disposable HTTP fixture, exact external packages; no Orbit server/PTY.

Run experiments/docking/setup.sh first. This fixture never reads .runtime, contacts
the owner server, or installs dependencies into this repository.
"""
import argparse
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
import json
from pathlib import Path
import threading
import time

from playwright.sync_api import expect, sync_playwright


ROOT = Path(__file__).resolve().parents[1]
PACKAGE_VERSIONS = {"dockview-core": "8.3.1", "golden-layout": "2.6.0"}


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, deps, **kwargs):
        self.deps = deps
        super().__init__(*args, directory=str(ROOT / "experiments/docking"), **kwargs)

    def translate_path(self, path):
        from urllib.parse import urlsplit, unquote
        route = unquote(urlsplit(path).path)
        if route == "/fixture":
            return str(ROOT / "tests/fixtures/runtime-continuity.html")
        if route.startswith("/vendor/"):
            relative = route[len("/vendor/"):]
            file = (self.deps / "node_modules" / relative).resolve()
            base = (self.deps / "node_modules").resolve()
            if not file.is_relative_to(base):
                return str(base / "__invalid__")
            # Golden Layout publishes extensionless relative ESM imports.
            if not file.is_file() and file.with_suffix(".js").is_file():
                return str(file.with_suffix(".js"))
            return str(file)
        return super().translate_path(path)

    def guess_type(self, path):
        if path.endswith((".mjs", ".js")) or "/dist/esm/" in path:
            return "text/javascript"
        return super().guess_type(path)

    def log_message(self, *args):
        pass


def verify_packages(deps):
    for name, version in PACKAGE_VERSIONS.items():
        package = json.loads((deps / "node_modules" / name / "package.json").read_text())
        assert package["version"] == version and package["license"] == "MIT", (name, package)


def run_case(browser, origin, candidate, native):
    context = browser.new_context(viewport={"width": 1400, "height": 900})
    if not native:
        context.add_init_script("Element.prototype.moveBefore = undefined")
    page = context.new_page()
    errors, navigations = [], []
    page.on("pageerror", lambda error: errors.append(str(error)))
    page.on("framenavigated", lambda frame: navigations.append(frame.url) if frame != page.main_frame else None)
    report = {"candidate": candidate, "nativeMoveBefore": native, "operations": {}, "failures": [], "errors": errors}
    try:
        start = time.perf_counter()
        page.goto(f"{origin}/?candidate={candidate}", wait_until="domcontentloaded")
        page.wait_for_function("window.experiment || window.experimentError", timeout=20000)
        report["coldWallMs"] = round((time.perf_counter() - start) * 1000, 2)
        failure = page.evaluate("window.experimentError")
        if failure:
            raise AssertionError(f"Adapter initialization: {failure}")
        report["coldAdapterMs"] = round(page.evaluate("window.experiment.coldMs"), 2)
        report["capabilities"] = page.evaluate("window.experiment.adapter.capabilities")
        if not report["capabilities"]:
            raise AssertionError("No candidate-supported operations")
        frames = {}
        for id in ("a", "b"):
            locator = page.frame_locator(f'[data-surface-id="{id}"] iframe')
            locator.locator("#document-nonce").wait_for(state="attached", timeout=10000)
            locator.locator("#draft").evaluate("(node, value) => {node.value=value; node.dispatchEvent(new Event('input', {bubbles:true}));}", f"unsaved-{id}-{candidate}")
            frames[id] = {"nonce": locator.locator("#document-nonce").inner_text(), "locator": locator}
        page.evaluate("""() => {window._originalSurfaces = Object.fromEntries(['a','b'].map(id => {
            const root = window.experiment.surfaces.get(id); const iframe = root.querySelector('iframe');
            return [id, {root, iframe, frameWindow: iframe.contentWindow}];
        }));}""")
        initial_navigations = len(navigations)

        def check(label):
            if errors:
                raise AssertionError(f"page errors: {errors}")
            if len(navigations) != initial_navigations:
                raise AssertionError(f"unexpected iframe navigations: {navigations[initial_navigations:]}")
            for id in ("a", "b"):
                intact = page.evaluate("""id => { const old=window._originalSurfaces[id];
                    return old.root.isConnected && old.root === window.experiment.surfaces.get(id) &&
                    old.iframe === old.root.querySelector('iframe') && old.frameWindow === old.iframe.contentWindow; }""", id)
                if not intact:
                    raise AssertionError(f"{id}: disconnected/replaced surface or iframe/window identity")
                locator = frames[id]["locator"]
                if locator.locator("#document-nonce").inner_text(timeout=2000) != frames[id]["nonce"]:
                    raise AssertionError(f"{id}: document nonce changed")
                if locator.locator("#draft").input_value(timeout=2000) != f"unsaved-{id}-{candidate}":
                    raise AssertionError(f"{id}: unsaved draft lost")

        check("initial")
        # Repeated actual candidate operations, not artificial DOM shuffles. A failed
        # transition remains a failure even if subsequent transitions happen to work.
        capabilities = report["capabilities"]
        transitions = 0
        timings = []
        for iteration in range(12):
            for type in capabilities:
                label = f"{transitions + 1}: {type} iteration {iteration}"
                started = time.perf_counter()
                try:
                    result = page.evaluate("op => window.experiment.adapter.perform(op)", {"type": type, "iteration": iteration})
                    if isinstance(result, dict) and (result.get("recreatedRenderers") or result.get("replacedPanels")):
                        raise AssertionError(f"save/load recreated runtime owners: {result}")
                    page.wait_for_timeout(30)
                    transitions += 1
                    report["operations"][type] = report["operations"].get(type, 0) + 1
                    check(label)
                except Exception as error:
                    report["failures"].append(f"{label}: {str(error)[:500]}")
                    # A thrown operation is not counted as an actual supported transition.
                    if report["operations"].get(type, 0) and "perform" in str(error):
                        report["operations"][type] -= 1
                timings.append(round((time.perf_counter() - started) * 1000, 2))
        report["transitionsAttempted"] = 12 * len(capabilities)
        report["transitionsExecuted"] = transitions
        report["transitionWallMs"] = {"median": sorted(timings)[len(timings)//2], "max": max(timings)}
        report["keyboard"] = {"explicitTabStopCount": page.locator('#host [tabindex]').evaluate_all('(nodes) => nodes.filter(node => node.tabIndex >= 0).length')}
        page.keyboard.press("Tab")
        report["keyboard"]["activeElement"] = page.evaluate("document.activeElement?.outerHTML.slice(0,180)")
        handle = page.locator('#host .lm_splitter, #host .dv-sash').first
        report["pointerResize"] = {"handleCount": page.locator('#host .lm_splitter, #host .dv-sash').count()}
        if report["pointerResize"]["handleCount"]:
            box = handle.bounding_box()
            report["pointerResize"]["handleBox"] = box
            if box and box["width"] and box["height"]:
                geometry = page.locator('#host .lm_stack').first if candidate == 'golden' else page.locator('[data-surface-id="a"]')
                before = geometry.evaluate("el => el.getBoundingClientRect().width")
                x, y = box["x"] + box["width"] / 2, box["y"] + box["height"] / 2
                report["pointerResize"]["hitTarget"] = page.evaluate("p => document.elementFromPoint(p.x,p.y)?.className", {"x": x, "y": y})
                page.mouse.move(x, y)
                page.mouse.down()
                page.mouse.move(x + 40, y, steps=5)
                page.mouse.up()
                # Golden Layout commits splitter sizes on the next animation
                # frame. Observe after layout settles, not immediately on mouseup.
                page.evaluate("() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))")
                after = geometry.evaluate("el => el.getBoundingClientRect().width")
                report["pointerResize"].update(before=round(before, 1), after=round(after, 1), changed=abs(after-before) > 3)
                try:
                    check("pointer resize")
                except Exception as error:
                    report["failures"].append(f"pointer resize: {error}")
        # Separate negative controls; direct URL mutation tests the fixture's
        # assertion sensitivity, not the candidate's Orbit model integration.
        old_nonce = frames["a"]["nonce"]
        page.evaluate("window.experiment.surfaces.get('a').querySelector('iframe').src='/fixture?replacement=1'")
        expect(frames["a"]["locator"].locator("#document-nonce")).not_to_have_text(old_nonce, timeout=5000)
        new_nonce = frames["a"]["locator"].locator("#document-nonce").inner_text(timeout=5000)
        report["negativeUrlReplacement"] = new_nonce != old_nonce and frames["a"]["locator"].locator("#draft").input_value() == ""
        page.evaluate("() => window.experiment.adapter.close('a')")
        report["negativeCloseDisposed"] = page.evaluate("!window.experiment.surfaces.get('a').isConnected")
        page.evaluate("() => window.experiment.adapter.dispose()")
    except Exception as error:
        report["failures"].append(str(error)[:1200])
    finally:
        context.close()
    return report


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--deps", type=Path, default=Path("/tmp/opencode/orbit-docking-deps"))
    parser.add_argument("--candidate", choices=["dockview", "golden", "both"], default="both")
    parser.add_argument("--move-control", action="store_true", help="also disable native moveBefore in isolated context")
    args = parser.parse_args()
    verify_packages(args.deps)
    server = ThreadingHTTPServer(("127.0.0.1", 0), partial(Handler, deps=args.deps))
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        with sync_playwright() as playwright:
            browser = playwright.chromium.launch(headless=True)
            try:
                candidates = ["dockview", "golden"] if args.candidate == "both" else [args.candidate]
                reports = [run_case(browser, f"http://127.0.0.1:{server.server_port}", candidate, native)
                           for candidate in candidates for native in ([True, False] if args.move_control else [True])]
                print(json.dumps({"chromium": browser.version, "results": reports}, indent=2))
                if any(r["failures"] or r["errors"] or r.get("transitionsExecuted", 0) < 50 or
                       not r.get("pointerResize", {}).get("changed") or
                       not r.get("negativeUrlReplacement") or not r.get("negativeCloseDisposed") for r in reports):
                    raise SystemExit(1)
            finally:
                browser.close()
    finally:
        server.shutdown()
        server.server_close()


if __name__ == "__main__":
    main()
