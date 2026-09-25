#!/usr/bin/env python3
"""Real-browser acceptance test for the independent Orbit recovery UI.

Default mode starts a disposable in-process HTTP fixture (Python stdlib only)
on 127.0.0.1:0. The fixture serves ``public/recovery.html`` / ``recovery.js`` /
``recovery.css`` straight from the repo and emulates the agreed
``/api/workspace/recovery`` backend contract, including origin/auth checks and
``server.config`` fault injection. It never touches the owner's live app,
tokens, ``.runtime`` or any running server.

This test covers the FRONTEND against the agreed contract only. Real server
integration tests are added separately by the lead.

This suite always creates its own disposable fixture. Environment variables cannot
redirect its mutations to an existing workspace. Real Node integration is covered
by recovery-real-server.browser.py, also using a disposable runtime.

Run: ``python3 tests/recovery.browser.py``
"""
import json
import os
import re
import secrets
import sys
import threading
import time
import traceback
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse

from playwright.sync_api import expect, sync_playwright

ROOT = Path(__file__).resolve().parents[1]
PUBLIC_DIR = ROOT / "public"

# Agreed fixture identifiers.
CHECKPOINT_1 = "11111111-1111-4111-8111-111111111111"
CHECKPOINT_2 = "22222222-2222-4222-8222-222222222222"
CAPABILITY = "SECRET-CAPABILITY-SHOULD-NOT-RENDER"
BROWSER_SEEN = 1700000000000
READ_REVISION = 7
OBSERVED_REVISION = 5

HARNESS = False
BASE = ""
TOKEN = "fixture-" + secrets.token_urlsafe(24)
WORKSPACE_ID = str(uuid.uuid4())
SERVER = None  # RecoveryFixture in default mode, None in harness mode.


# --------------------------------------------------------------------------
# Use the installed Playwright version's exact browser, not an arbitrary newer
# binary from an owner's cache. Override only for explicit compatibility testing.
# --------------------------------------------------------------------------
def find_chromium():
    explicit = os.environ.get("ORBIT_RECOVERY_CHROMIUM")
    if explicit:
        if os.path.exists(explicit):
            return explicit
        raise RuntimeError(
            "ORBIT_RECOVERY_CHROMIUM is set but does not exist: %s" % explicit
        )
    with sync_playwright() as playwright:
        return playwright.chromium.executable_path


def _build_number(name):
    match = re.search(r"-(\d+)$", name)
    return int(match.group(1)) if match else -1


# --------------------------------------------------------------------------
# Disposable fixture backend.
# --------------------------------------------------------------------------
class RecoveryFixture:
    def __init__(self, token, workspace_id):
        self.token = token
        self.workspace_id = workspace_id
        self.revision = READ_REVISION
        self.observed_revision = OBSERVED_REVISION
        self.browser_seen = BROWSER_SEEN
        self.config = {}
        self.requests = []
        self.lock = threading.Lock()

    def add_request(self, method, path, headers, body, status):
        with self.lock:
            self.requests.append(
                {
                    "method": method,
                    "path": path,
                    "headers": headers,
                    "body": body,
                    "status": status,
                }
            )

    def state(self):
        return {
            "version": 1,
            "selected": "m1",
            "monitors": [
                {
                    "id": "m1",
                    "name": "Main",
                    "layout": {
                        "type": "pane",
                        "pane": {
                            "id": "p1",
                            "kind": "terminal",
                            "url": "/private-secret-pane-url",
                        },
                    },
                }
            ],
            "plugins": [
                {
                    "manifest": {
                        "id": "notes",
                        "version": "1.0.0",
                        "title": "Workspace notes",
                        "entry": "/apps/secret-plugin/index.html",
                    },
                    "enabled": True,
                    "config": {},
                    "window": {},
                },
                {
                    "manifest": {
                        "id": "timer",
                        "version": "2.0.0",
                        "title": "Focus timer",
                        "entry": "/apps/secret-timer/index.html",
                    },
                    "enabled": False,
                    "config": {},
                    "window": {},
                },
            ],
        }

    def read_snapshot(self):
        # Deliberately exact: no app_versions, revision pinned to READ_REVISION.
        return {
            "workspace_id": self.workspace_id,
            "revision": READ_REVISION,
            "observed_revision": self.observed_revision,
            "browser_seen": self.browser_seen,
            "capability": CAPABILITY,
            "state": self.state(),
        }

    def safe_snapshot(self):
        return {
            "workspace_id": self.workspace_id,
            "revision": self.revision,
            "observed_revision": self.observed_revision,
            "browser_seen": self.browser_seen,
            "state": self.state(),
        }

    def history(self):
        return {
            "revision": READ_REVISION,
            "checkpoints": [
                {
                    "id": CHECKPOINT_1,
                    "created": 1700000000000,
                    "label": "Before redesign",
                    "revision": 6,
                },
                {
                    "id": CHECKPOINT_2,
                    "created": 1700000100000,
                    "label": "Initial",
                    "revision": 1,
                },
            ],
        }

    def serve_get(self, path):
        routes = {
            "/recovery": ("recovery.html", "text/html; charset=utf-8"),
            "/recovery.html": ("recovery.html", "text/html; charset=utf-8"),
            "/recovery.js": ("recovery.js", "text/javascript; charset=utf-8"),
            "/recovery.css": ("recovery.css", "text/css; charset=utf-8"),
        }
        if path not in routes:
            return 404, {"error": "Not found"}, "application/json; charset=utf-8"
        name, ctype = routes[path]
        target = PUBLIC_DIR / name
        if not target.exists():
            return (
                404,
                {"error": "Recovery asset missing: public/%s" % name},
                "application/json; charset=utf-8",
            )
        return 200, target.read_bytes(), ctype

    def dispatch_post(self, body):
        """Return (status, payload) for an authenticated recovery request."""
        action = body.get("action")
        if action == "read":
            return 200, self.read_snapshot()
        if action == "history":
            return 200, self.history()
        if action == "restore":
            if self.config.get("restore_status") == 409 or body.get(
                "base_revision"
            ) != self.revision:
                return 409, {"error": "Confirm restore against the current revision."}
            if body.get("confirm") is not True:
                return 400, {"error": "confirmation required"}
            self.revision += 1
            return 200, self.safe_snapshot()
        if action == "plugins_apply":
            if body.get("base_revision") != self.revision:
                return 409, {"error": "Workspace changed; refresh and retry"}
            if body.get("operations") != [{"action": "plugin_disable_all"}]:
                return 400, {"error": "Expected plugin operations"}
            self.revision += 1
            return 200, self.safe_snapshot()
        return 400, {"error": "Unknown recovery action"}


class RecoveryHandler(BaseHTTPRequestHandler):
    server_version = "OrbitRecoveryFixture/1.0"

    def log_message(self, *args):  # keep the test output clean
        pass

    def _headers(self):
        return {key: value for key, value in self.headers.items()}

    @staticmethod
    def _header(headers, name):
        for key, value in headers.items():
            if key.lower() == name.lower():
                return value
        return None

    # Mirrors the exact CSP the real server sends for GET /recovery (and the
    # security headers for the recovery API). The UI must function without any
    # inline script/style/handler privilege.
    RECOVERY_CSP = (
        "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; "
        "frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; "
        "frame-ancestors 'none'"
    )

    def _send(self, status, payload, ctype):
        if isinstance(payload, (bytes, bytearray)):
            data = bytes(payload)
        elif payload is None:
            data = b""
        else:
            data = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        if ctype:
            self.send_header("Content-Type", ctype)
        self.send_header("Content-Security-Policy", self.RECOVERY_CSP)
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Referrer-Policy", "no-referrer")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(data)

    def do_GET(self):
        fixture = self.server.fixture
        path = urlparse(self.path).path
        status, payload, ctype = fixture.serve_get(path)
        fixture.add_request("GET", path, self._headers(), None, status)
        self._send(status, payload, ctype)

    def do_POST(self):
        fixture = self.server.fixture
        path = urlparse(self.path).path
        length = int(self.headers.get("Content-Length") or 0)
        raw = self.rfile.read(length) if length else b""
        try:
            body = json.loads(raw.decode("utf-8")) if raw else None
        except Exception:
            body = None
        headers = self._headers()

        # Config knob: consumed by exactly the next POST.
        with fixture.lock:
            forced = fixture.config.pop("force_error", None)
        if forced is not None:
            status, payload = forced
            fixture.add_request("POST", path, headers, body, status)
            self._send(status, payload, "application/json; charset=utf-8")
            return

        if self._header(headers, "Origin") != BASE:
            status, payload = 403, {"error": "Origin rejected"}
        elif self._header(headers, "Authorization") != "Bearer %s" % fixture.token:
            status, payload = 403, {"error": "Workspace authentication required"}
        elif not isinstance(body, dict) or body.get("workspace_id") != fixture.workspace_id:
            status, payload = 404, {"error": "Workspace is not connected"}
        else:
            status, payload = fixture.dispatch_post(body)

        fixture.add_request("POST", path, headers, body, status)
        self._send(status, payload, "application/json; charset=utf-8")


def start_fixture():
    fixture = RecoveryFixture(TOKEN, WORKSPACE_ID)
    httpd = ThreadingHTTPServer(("127.0.0.1", 0), RecoveryHandler)
    httpd.fixture = fixture
    thread = threading.Thread(target=httpd.serve_forever, daemon=True)
    thread.start()
    return httpd, fixture


# --------------------------------------------------------------------------
# Small browser helpers.
# --------------------------------------------------------------------------
def goto_recovery(page):
    page.goto(BASE + "/recovery", wait_until="load")


def button(page, name):
    locator = page.get_by_role("button", name=name, exact=True)
    if locator.count() == 0:
        locator = page.get_by_role("button", name=re.compile(re.escape(name), re.I))
    return locator.first


def error_box(page):
    locator = page.locator("#error")
    if locator.count() == 0:
        locator = page.locator('[role="alert"]')
    return locator.first


def checkbox(page, id_hint, name_hint):
    for selector in (
        "#%s" % id_hint,
        '[data-testid="%s"]' % id_hint,
        'input[type="checkbox"][name="%s"]' % id_hint,
    ):
        locator = page.locator(selector)
        if locator.count() > 0:
            return locator.first
    locator = page.get_by_role("checkbox", name=re.compile(name_hint, re.I))
    if locator.count() > 0:
        return locator.first
    raise AssertionError("checkbox %r not found" % id_hint)


def choose_checkpoint(page, checkpoint_id, label):
    for selector in (
        'input[type="radio"][value="%s"]' % checkpoint_id,
        "#%s" % checkpoint_id,
        "#checkpoint-%s" % checkpoint_id,
        '[data-checkpoint-id="%s"]' % checkpoint_id,
    ):
        locator = page.locator(selector)
        if locator.count() > 0:
            locator.first.check()
            return
    locator = page.get_by_role("radio", name=re.compile(re.escape(label), re.I))
    if locator.count() > 0:
        locator.first.check()
        return
    raise AssertionError("checkpoint control for %s not found" % checkpoint_id)


def connect(page):
    goto_recovery(page)
    page.get_by_label("Owner token").fill(TOKEN)
    page.get_by_label("Workspace ID").fill(WORKSPACE_ID)
    button(page, "Connect").click()
    expect(page.get_by_test_id("meta-workspace-id")).to_contain_text(WORKSPACE_ID)


def wait_for(predicate, timeout=8.0, interval=0.05):
    deadline = time.time() + timeout
    while time.time() < deadline:
        if predicate():
            return True
        time.sleep(interval)
    return predicate()


def wait_for_request(fixture, start, action, timeout=8.0):
    def predicate():
        return any(
            (request.get("body") or {}).get("action") == action
            for request in fixture.requests[start:]
        )

    assert wait_for(predicate, timeout), "no %r request observed" % action


def requests_after(fixture, start, action=None):
    items = fixture.requests[start:]
    if action is None:
        return items
    return [item for item in items if (item.get("body") or {}).get("action") == action]


def storage_text(page):
    return page.evaluate(
        """() => {
          const out = [];
          for (const store of [localStorage, sessionStorage]) {
            for (let i = 0; i < store.length; i++) {
              const key = store.key(i);
              out.push(key + '=' + store.getItem(key));
            }
          }
          return out.join('\\n');
        }"""
    )


class SkipCase(Exception):
    pass


# --------------------------------------------------------------------------
# Test cases.
# --------------------------------------------------------------------------
def case_1_loads_independently(page, errors, fixture):
    goto_recovery(page)
    assert page.locator("iframe").count() == 0, "recovery page must not embed iframes"
    assert page.locator("script[src$='recovery.js']").count() == 1, (
        "expected exactly one script ending in recovery.js"
    )
    assert page.locator("script[src*='main']").count() == 0, (
        "recovery page must not load the main renderer"
    )
    assert page.locator("#terminal, .terminal, #agent").count() == 0, (
        "recovery page must not mount terminal/agent surfaces"
    )
    assert not errors, "page errors on load: %r" % errors
    return "loads independently, one recovery.js script, no iframes/terminal/agent, no page errors"


def case_2_token_not_persisted(page, errors, fixture):
    goto_recovery(page)
    assert TOKEN not in storage_text(page), "token present in storage before connect"
    assert TOKEN not in page.evaluate("() => document.cookie"), "token in cookie before connect"
    assert TOKEN not in page.url, "token in URL before connect"
    if not HARNESS:
        connect(page)
        assert TOKEN not in storage_text(page), "token persisted in storage after connect"
        assert TOKEN not in page.evaluate("() => document.cookie"), "token in cookie after connect"
        assert TOKEN not in page.url, "token leaked into URL after connect"
    return "token never written to localStorage/sessionStorage/cookie/URL"


def case_3_input_validation(page, errors, fixture):
    goto_recovery(page)
    if fixture is None:
        raise SkipCase("fixture request capture unavailable in harness mode")
    start = len(fixture.requests)
    connect_button = button(page, "Connect")
    if connect_button.is_enabled():
        connect_button.click()
    page.wait_for_timeout(150)
    page.get_by_label("Owner token").fill(TOKEN)
    page.get_by_label("Workspace ID").fill("definitely-not-a-workspace-id")
    connect_button = button(page, "Connect")
    if connect_button.is_enabled():
        connect_button.click()
    page.wait_for_timeout(300)
    reads = requests_after(fixture, start, "read")
    assert not reads, "read request sent for empty/invalid workspace input"
    assert error_box(page).is_visible(), "validation error not shown"
    assert error_box(page).inner_text().strip(), "validation error text is empty"
    return "invalid input blocked client-side (0 reads) with visible error text"


def case_4_connect_success(page, errors, fixture):
    if fixture is None:
        raise SkipCase("fixture request capture unavailable in harness mode")
    start = len(fixture.requests)
    connect(page)
    wait_for_request(fixture, start, "read")
    wait_for_request(fixture, start, "history")
    captured = fixture.requests[start:]
    read_index = next(
        i for i, r in enumerate(captured) if (r.get("body") or {}).get("action") == "read"
    )
    history_index = next(
        i for i, r in enumerate(captured) if (r.get("body") or {}).get("action") == "history"
    )
    assert read_index < history_index, "history must be requested after read"
    read_body = captured[read_index]["body"]
    assert read_body.get("workspace_id") == WORKSPACE_ID, "read body workspace_id mismatch"
    assert read_body.get("action") == "read", "read action missing"
    expect(page.get_by_test_id("meta-workspace-id")).to_contain_text(WORKSPACE_ID)
    expect(page.get_by_test_id("meta-revision")).to_contain_text(str(READ_REVISION))
    expect(page.get_by_test_id("meta-observed-revision")).to_contain_text(
        str(OBSERVED_REVISION)
    )
    expect(page.get_by_test_id("meta-browser-seen")).to_contain_text(str(BROWSER_SEEN))
    expect(page.get_by_text("Before redesign").first).to_be_visible()
    expect(page.get_by_text("Initial").first).to_be_visible()
    body_text = page.locator("body").inner_text()
    assert "revision 6" in body_text, "first checkpoint revision not rendered"
    assert "revision 1" in body_text, "second checkpoint revision not rendered"
    return "read then history, meta fixture values, both checkpoint labels and revisions"


def case_5_no_private_data(page, errors, fixture):
    connect(page)
    text = page.locator("body").inner_text()
    for secret in (
        CAPABILITY,
        "private-secret-pane-url",
        "secret-plugin",
        "secret-timer",
        "/apps/",
    ):
        assert secret not in text, "private data rendered: %r" % secret
    return "capability/pane/plugin URLs never rendered"


def case_6_restore_gating(page, errors, fixture):
    if fixture is None:
        raise SkipCase("fixture request capture unavailable in harness mode")
    connect(page)
    restore = button(page, "Restore checkpoint")
    expect(restore).to_be_disabled()
    choose_checkpoint(page, CHECKPOINT_1, "Before redesign")
    expect(restore).to_be_disabled()
    confirm = checkbox(page, "restore-confirm", "restore")
    confirm.check()
    expect(restore).to_be_enabled()
    start = len(fixture.requests)
    restore.click()
    wait_for_request(fixture, start, "restore")
    captured = requests_after(fixture, start, "restore")
    body = captured[0]["body"]
    assert body.get("confirm") is True, "restore confirm flag not sent as True"
    assert body.get("base_revision") == READ_REVISION, "restore base_revision mismatch"
    assert body.get("checkpoint_id") == CHECKPOINT_1, "restore checkpoint_id mismatch"
    return "restore gated behind selection+confirm, request body correct"


def case_7_409_no_retry(page, errors, fixture):
    if fixture is None:
        raise SkipCase("fixture request capture unavailable in harness mode")
    connect(page)
    fixture.config["restore_status"] = 409
    try:
        choose_checkpoint(page, CHECKPOINT_1, "Before redesign")
        confirm = checkbox(page, "restore-confirm", "restore")
        if not confirm.is_checked():
            confirm.check()
        start = len(fixture.requests)
        button(page, "Restore checkpoint").click()
        wait_for_request(fixture, start, "restore")
        expect(error_box(page)).to_contain_text("Read again instead of retrying")
        restores = requests_after(fixture, start, "restore")
        assert len(restores) == 1, "restore auto-retried (%d requests)" % len(restores)
        reads = requests_after(fixture, start, "read")
        assert not reads, "409 triggered an automatic read (%d)" % len(reads)
    finally:
        fixture.config.pop("restore_status", None)
    return "409 shows retry guidance, no automatic retry or auto-read"


def case_8_disable_apps(page, errors, fixture):
    if fixture is None:
        raise SkipCase("fixture request capture unavailable in harness mode")
    connect(page)
    text = page.locator("body").inner_text()
    assert "Workspace notes" in text, "registered plugin title missing"
    assert "Focus timer" in text, "registered plugin title missing"
    for bad in ("secret-plugin", "secret-timer", "/apps/"):
        assert bad not in text, "plugin URL leaked: %r" % bad
    disable = button(page, "Disable all apps")
    start = len(fixture.requests)
    if disable.is_enabled():
        disable.click()
        page.wait_for_timeout(300)
    assert not requests_after(fixture, start, "plugins_apply"), (
        "disable-all request sent while confirm unchecked"
    )
    confirm = checkbox(page, "disable-confirm", "disable")
    confirm.check()
    expect(disable).to_be_enabled()
    start = len(fixture.requests)
    disable.click()
    wait_for_request(fixture, start, "plugins_apply")
    body = requests_after(fixture, start, "plugins_apply")[0]["body"]
    assert body.get("operations") == [{"action": "plugin_disable_all"}], (
        "unexpected plugin operations: %r" % body.get("operations")
    )
    assert body.get("base_revision") == READ_REVISION, "plugins_apply base_revision mismatch"
    return "two plugin titles listed, gated disable-all with correct operations"


def case_9_errors_text_only(page, errors, fixture):
    if fixture is None:
        raise SkipCase("fixture request capture unavailable in harness mode")
    connect(page)
    payload = "<img src=x onerror=window.__xss=1>payload</b>"
    fixture.config["force_error"] = (400, {"error": payload})
    start = len(fixture.requests)
    button(page, "Read again").click()
    wait_for(
        lambda: any(r.get("status") == 400 for r in fixture.requests[start:]),
        timeout=8.0,
    )
    box = page.locator("#error")
    expect(box).to_contain_text("<img")
    assert "<img" in box.inner_text(), "error did not render the literal markup as text"
    assert page.locator("#error img").count() == 0, "HTML injected inside #error"
    assert page.evaluate("() => window.__xss") is None, "onerror handler executed"
    return "error payload rendered as textContent only, no DOM/JS injection"


def case_10_limitations_copy(page, errors, fixture):
    connect(page)
    lowered = page.locator("body").inner_text().lower()
    required = [
        "They exclude external effects, files, shells, conversations and image bytes.",
        "Restore is never automatic.",
        "Does not stop backends or already-disconnected frames.",
        "acknowledgement is not rendered proof",
        "Read again instead of retrying.",
        "No safe mode is claimed.",
    ]
    for phrase in required:
        assert phrase.lower() in lowered, "missing limitation copy: %r" % phrase
    without_clause = lowered.replace("no safe mode is claimed.", "")
    assert "safe mode" not in without_clause, (
        "'safe mode' appears outside the 'No safe mode is claimed.' sentence"
    )
    return "all required limitation copy present; safe-mode claim scoped correctly"


CASES = [
    (1, case_1_loads_independently),
    (2, case_2_token_not_persisted),
    (3, case_3_input_validation),
    (4, case_4_connect_success),
    (5, case_5_no_private_data),
    (6, case_6_restore_gating),
    (7, case_7_409_no_retry),
    (8, case_8_disable_apps),
    (9, case_9_errors_text_only),
    (10, case_10_limitations_copy),
]


def main():
    global BASE, SERVER
    httpd, SERVER = start_fixture()
    BASE = "http://127.0.0.1:%d" % httpd.server_address[1]
    print("Fixture origin: %s" % BASE)

    executable = find_chromium()
    print("Chromium executable: %s" % executable)

    passed = 0
    skipped = 0
    failed = 0
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(
            headless=True, args=["--no-sandbox"], executable_path=executable
        )
        try:
            for number, case in CASES:
                page = browser.new_page(viewport={"width": 1440, "height": 1000})
                errors = []
                csp = []
                page.on("pageerror", lambda event: errors.append(str(event)))

                def note_console(message):
                    text = message.text
                    if "Content Security Policy" in text or "Refused to" in text:
                        csp.append(text)

                page.on("console", note_console)
                try:
                    detail = case(page, errors, SERVER)
                    assert not csp, "CSP violation under real recovery policy: %r" % csp
                    print("PASS case %d: %s" % (number, detail))
                    passed += 1
                except SkipCase as exc:
                    print("SKIP case %d: %s" % (number, exc))
                    skipped += 1
                except Exception as exc:  # noqa: BLE001 - report and continue
                    print("FAIL case %d: %s: %s" % (number, type(exc).__name__, exc))
                    traceback.print_exc()
                    failed += 1
                finally:
                    page.close()
        finally:
            browser.close()
    if httpd is not None:
        httpd.shutdown()
        httpd.server_close()
    print("Summary: %d passed, %d skipped, %d failed" % (passed, skipped, failed))
    if failed:
        sys.exit(1)


if __name__ == "__main__":
    main()
