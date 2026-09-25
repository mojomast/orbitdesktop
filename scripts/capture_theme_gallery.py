"""Capture the README theme gallery: every public theme with an agent chat window.

Runs an isolated server in a throwaway runtime and a headless Chromium, seeds a
synthetic workspace that contains an agent conversation pane, then applies each
public preset through the real Themes picker and screenshots the desktop.

The conversation is clearly-labelled presentation text injected into the chat
surface. Nothing is sent to an agent, and the owner's workspace, conversations,
credentials and host terminals are never touched or captured.

The six owner-only brand themes (see docs/PERSONAL_BRAND_THEMES.md) are
deliberately excluded from this public gallery.
"""
import os, secrets, socket, subprocess, sys, tempfile, time, urllib.request
from pathlib import Path
from playwright.sync_api import sync_playwright, expect

R = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(R / 'tests'))
from orbit_menu import menu  # noqa: E402

DEST = R / 'docs' / 'images' / 'themes'
DEST.mkdir(parents=True, exist_ok=True)

# Public presets only: name as shown in the picker -> file slug / data-orbit-style.
THEMES = [
    ('Nous Atelier', 'nous'),
    ('Midnight', 'midnight'),
    ('Windows XP', 'xp'),
    ('Classic 95', 'classic'),
    ('Paper Studio', 'paper'),
    ('Cyberpunk', 'cyberpunk'),
    ('Aurora Glass', 'aurora'),
    ('Phosphor', 'phosphor'),
    ('Blueprint', 'blueprint'),
    ('Pop Art', 'pop'),
    ('Ocean', 'ocean'),
    ('Forest', 'forest'),
    ('Plum', 'plum'),
    ('Ember', 'ember'),
]

SEED = """() => {
  const s = JSON.parse(localStorage.getItem('orbit.workspace.v1'));
  s.view = 'windows';
  s.sidebarHidden = true;
  s.appearance = { fullViewport: false };
  s.monitors = [
    { id:'gallery-agent', name:'Hermes', diagonal:32, aspect:'16:9', height:0, distance:0,
      pitch:0, yaw:0, offset:0, fontSize:17, opacity:1,
      layout:{type:'pane',pane:{id:'gallery-agent-pane',kind:'agent',url:'orbit://welcome'}},
      frame:{x:60,y:40,width:1200,height:820,z:2} },
    { id:'gallery-term', name:'Terminal', diagonal:32, aspect:'16:9', height:0, distance:0,
      pitch:0, yaw:0, offset:0, fontSize:15, opacity:1,
      layout:{type:'pane',pane:{id:'gallery-term-pane',kind:'terminal',url:'orbit://welcome'}},
      frame:{x:1285,y:40,width:520,height:400,z:1} },
  ];
  s.selected = 'gallery-agent';
  localStorage.setItem('orbit.workspace.v1', JSON.stringify(s));
}"""

FIXTURE = """() => {
  const chat = document.querySelector('.chat-messages');
  if (!chat) return false;
  chat.innerHTML =
    '<div class="chat-message"><small>Hermes &middot; demo</small>'
    + '<p>Arranged your workspace: the terminal sits on the left and this conversation '
    + 'on the right. Existing pane IDs and running sessions were preserved.</p></div>'
    + '<div class="chat-message user"><small>You &middot; demo</small>'
    + '<p>Build a small focus timer and place it beside my editor.</p></div>'
    + '<div class="chat-message"><small>Hermes &middot; demo</small>'
    + '<p>Published <a href="#">focus-timer 1.0.0</a> as a sandboxed plugin, enabled it, '
    + 'and saved a checkpoint you can roll back to.</p></div>';
  return true;
}"""


def main():
    with socket.socket() as s:
        s.bind(('127.0.0.1', 0))
        port = s.getsockname()[1]
    url = f'http://127.0.0.1:{port}'
    with tempfile.TemporaryDirectory(prefix='orbit-gallery-') as runtime:
        token = secrets.token_urlsafe(36)
        server = subprocess.Popen(
            ['node', '--experimental-strip-types', 'server/index.mjs'], cwd=R,
            env={**os.environ, 'PORT': str(port), 'ORBIT_TOKEN': token, 'ORBIT_RUNTIME_DIR': runtime},
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        try:
            for _ in range(80):
                try:
                    urllib.request.urlopen(url, timeout=1)
                    break
                except OSError:
                    time.sleep(0.1)
            else:
                raise RuntimeError('Readiness failed')
            with sync_playwright() as p:
                browser = p.chromium.launch(headless=True, args=['--no-sandbox'])
                page = browser.new_page(viewport={'width': 1440, 'height': 1000})
                errors = []
                page.on('pageerror', lambda e: errors.append(str(e)))

                def unlock():
                    page.get_by_role('button', name='Connect local host', exact=True).click()
                    page.get_by_role('textbox', name='Host session token').fill(token)
                    page.get_by_role('button', name='Unlock local host', exact=True).click()
                    page.wait_for_timeout(800)

                page.goto(url, wait_until='networkidle')
                page.keyboard.press('Escape')
                unlock()
                page.evaluate(SEED)
                page.reload(wait_until='networkidle')
                page.keyboard.press('Escape')
                unlock()
                page.wait_for_timeout(900)

                captured = []
                for name, slug in THEMES:
                    menu(page, 'Choose workspace theme')
                    page.get_by_role('button', name=f'Apply {name} theme', exact=True).click()
                    expect(page.locator('html')).to_have_attribute('data-orbit-style', slug)
                    page.get_by_role('button', name='Close workspace themes').click()
                    page.wait_for_timeout(1300)
                    if not page.evaluate(FIXTURE):
                        raise RuntimeError('agent chat surface not present for ' + name)
                    page.wait_for_timeout(250)
                    out = DEST / f'{slug}.png'
                    page.screenshot(path=str(out))
                    captured.append((name, out))
                    print('captured', name, '->', out.relative_to(R))

                assert not errors, errors
                browser.close()
            print(f'PASS captured {len(captured)} public theme screenshots; no JS exceptions.')
        finally:
            server.terminate()
            server.wait(timeout=10)


if __name__ == '__main__':
    main()
