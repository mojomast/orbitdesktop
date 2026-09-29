"""Shared disposable fixture for the theme browser acceptance tests.

Builds an isolated copy of the tracked source with scripts/isolated_build.mjs and
serves it from a private runtime/HOME/tmux socket on an ephemeral port. It never
reads a checkout dist, the owner runtime, inherited credentials, or the fixed
4398 port. Logs and screenshots go under /tmp/opencode.

Owned by the theme browser acceptance fixtures. This module is intentionally not
named *.browser.py so it is not picked up as a standalone gate.
"""
import contextlib
import os
import secrets
import shutil
import socket
import subprocess
import tempfile
import time
import urllib.request
import uuid
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
ARTIFACTS = Path("/tmp/opencode")

# All merged theme personalities: (menu/card name, data-orbit-style personality).
# Includes the Hermes Relay and MS-DOS additions plus every pre-existing preset.
THEMES = (
    ("Nous Atelier", "nous"), ("Hermes Relay", "relay"), ("Midnight", "midnight"),
    ("Windows XP", "xp"), ("Classic 95", "classic"), ("MS-DOS", "msdos"),
    ("Paper Studio", "paper"), ("Cyberpunk", "cyberpunk"), ("Aurora Glass", "aurora"),
    ("Phosphor", "phosphor"), ("Blueprint", "blueprint"), ("Pop Art", "pop"),
    ("Ocean", "ocean"), ("Forest", "forest"), ("Plum", "plum"), ("Ember", "ember"),
    ("Deep Field", "deepfield"), ("Sakura", "sakura"), ("Amber CRT", "amber"),
)


def _run(argv, cwd, env):
    return subprocess.run(argv, cwd=cwd, env=env, text=True, capture_output=True)


def unlock(page, token, pause=1200):
    """Unlock the already-loaded workspace with the fixture owner token."""
    page.get_by_role("button", name="Connect local host", exact=True).click()
    page.get_by_role("textbox", name="Host session token").fill(token)
    page.get_by_role("button", name="Unlock local host", exact=True).click()
    page.wait_for_timeout(pause)


def connect(page, origin, token, pause=1200):
    """Open the workspace and unlock with the fixture owner token."""
    page.goto(origin + "/", wait_until="networkidle")
    page.keyboard.press("Escape")
    unlock(page, token, pause)
    page.wait_for_function("() => localStorage.getItem('orbit.workspace.v1') !== null", timeout=15000)


def open_theme_picker(page):
    """Open the real orbit-menu -> Themes flow (the old direct button is gone)."""
    if page.locator("dialog[open]").count():
        page.keyboard.press("Escape")
        page.wait_for_timeout(200)
    item = page.locator(".orbit-menu-item", has_text="Themes").first
    if not item.is_visible():
        page.get_by_role("button", name="Open orbit menu", exact=True).click()
        page.wait_for_timeout(300)
    if not item.is_visible():
        page.get_by_role("button", name="Open orbit menu", exact=True).click()
        page.wait_for_timeout(300)
    item.click()
    page.wait_for_timeout(400)


@contextlib.contextmanager
def theme_fixture(prefix):
    """Yield {root, origin, token} for a disposable isolated server."""
    with tempfile.TemporaryDirectory(prefix=prefix, dir="/tmp/opencode") as temporary:
        root = Path(temporary)
        for name in ("server", "src", "contracts", "docs", "public", "scripts"):
            if (ROOT / name).is_dir():
                shutil.copytree(ROOT / name, root / name)
        for name in ("index.html", "package.json", "tsconfig.json", "vite.config.js"):
            if (ROOT / name).is_file():
                shutil.copy2(ROOT / name, root / name)
        (root / "node_modules").symlink_to(ROOT / "node_modules", target_is_directory=True)
        for name in ("runtime", "home", "cwd", "tmux"):
            (root / name).mkdir()
        # Build with a disposable HOME/cache only; no owner credentials inherited.
        build_env = {"HOME": str(root / "home"), "PATH": os.environ["PATH"], "npm_config_cache": str(root / ".npm")}
        build = _run([shutil.which("node"), str(ROOT / "scripts/isolated_build.mjs"), "--source", str(root),
                      "--dest", str(root / "dist"), "--allow-source-dist"], root, build_env)
        if build.returncode or not (root / "dist" / "index.html").is_file():
            raise RuntimeError("Isolated build failed:\n" + build.stdout + "\n" + build.stderr)
        with socket.socket() as probe:
            probe.bind(("127.0.0.1", 0))
            port = probe.getsockname()[1]
        origin = f"http://127.0.0.1:{port}"
        token = secrets.token_urlsafe(36)
        # Explicit minimal server env: private runtime, HOME, cwd and tmux socket.
        server_env = {"PORT": str(port), "ORBIT_TOKEN": token, "ORBIT_RUNTIME_DIR": str(root / "runtime"),
                      "ORBIT_TMUX_SOCKET": "theme-" + str(uuid.uuid4()), "ORBIT_TMUX_CONFIG": "/dev/null",
                      "TMUX_TMPDIR": str(root / "tmux"), "ORBIT_CWD": str(root / "cwd"),
                      "HOME": str(root / "home"), "PATH": os.environ["PATH"]}
        with (root / "server.log").open("w+") as log:
            server = subprocess.Popen([shutil.which("node"), "--experimental-strip-types", "server/index.mjs"],
                                      cwd=root, env=server_env, stdout=log, stderr=log)
            try:
                for _ in range(300):
                    if server.poll() is not None:
                        log.seek(0)
                        raise RuntimeError("Server exited:\n" + log.read().replace(token, "[REDACTED]"))
                    try:
                        urllib.request.urlopen(origin + "/api/health", timeout=1)
                        break
                    except OSError:
                        time.sleep(.05)
                else:
                    raise RuntimeError("Server readiness timeout")
                yield {"root": root, "origin": origin, "token": token}
            finally:
                server.terminate()
                try:
                    server.wait(timeout=10)
                except subprocess.TimeoutExpired:
                    server.kill()
                    server.wait()
