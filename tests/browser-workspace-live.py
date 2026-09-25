"""Opt-in browser acceptance test against the real deployed host and Hermes gateway."""
import json
import re
from pathlib import Path
from playwright.sync_api import sync_playwright, expect
import os as _os, sys as _sys
_sys.path.insert(0, _os.path.dirname(_os.path.abspath(__file__)))
from orbit_menu import menu, open_menu, close_menu

ROOT = Path(__file__).resolve().parents[1]
env = dict(line.split('=', 1) for line in (ROOT / '.env.deploy').read_text().splitlines() if '=' in line)
with sync_playwright() as p:
    browser = p.chromium.launch(headless=True, args=['--no-sandbox'])
    page = browser.new_page(viewport={'width': 1600, 'height': 1000})
    errors = []
    page.on('pageerror', lambda e: errors.append(str(e)))
    page.goto(env['ORBIT_PUBLIC_ORIGIN'], wait_until='networkidle')
    expect(page.locator('.desktop-window')).to_have_count(3)
    window = page.locator('.desktop-window').nth(2)
    window_id = window.get_attribute('data-monitor-id')
    before = window.bounding_box()
    bar = window.locator('.monitor-bar').bounding_box()
    page.mouse.move(bar['x'] + 160, bar['y'] + 18)
    page.mouse.down(); page.mouse.move(bar['x'] + 290, bar['y'] + 78, steps=8); page.mouse.up()
    after = window.bounding_box()
    assert after['x'] - before['x'] >= 120 and after['y'] - before['y'] >= 50, (before, after)
    handle = window.locator('.window-resize').bounding_box()
    page.mouse.move(handle['x'] + 12, handle['y'] + 12)
    page.mouse.down(); page.mouse.move(handle['x'] + 112, handle['y'] + 72, steps=8); page.mouse.up()
    resized = window.bounding_box()
    assert resized['width'] - after['width'] >= 90 and resized['height'] - after['height'] >= 50
    menu(page, 'Toggle side panel')
    expect(page.locator('.inspector')).to_be_hidden()
    expect(page.locator('.saved')).to_have_text('Saved locally')
    page.reload(wait_until='networkidle')
    expect(page.locator('.inspector')).to_be_hidden()
    restored = page.locator(f'[data-monitor-id="{window_id}"]').bounding_box()
    assert abs(restored['width'] - resized['width']) < 2 and abs(restored['x'] - resized['x']) < 2
    print('Pointer move, resize, sidebar toggle, and reload persistence: passed', flush=True)
    menu(page, 'Toggle side panel')
    page.get_by_role('button', name='Connect local host', exact=True).click()
    page.get_by_role('textbox', name='Host session token').fill(env['ORBIT_TOKEN'])
    page.get_by_role('button', name='Unlock local host', exact=True).click()
    expect(page.locator('dialog')).to_have_count(0)
    # Focus the chat so user-like typing has no overlap/interception.
    page.get_by_role('button', name='Focus Display 03', exact=True).click(force=True)
    prompt = ('This is a real Comet workspace acceptance test. Use your workspace controller to inspect this workspace, '
              'hide the side panel, and rename the first terminal window to Host Workshop. Then BUILD a small self-contained '
              'static app from scratch in this repository at examples/comet-counter-test (do not use external libraries). '
              'The app must have an h1 reading Comet Counter, a button with exact text Add star, and an element with id count initially displaying 0. '
              'Clicking the button must increment the number. Publish and OPEN it in this workspace with slug comet-counter-test and title Comet Counter. '
              'Use the injected workspace tools and verify browser_applied. Do not alter or restart the workspace service. '
              'When done, reply with a brief factual confirmation. Do not just explain how to do it.')
    page.get_by_role('textbox', name='Message to Hermes').fill(prompt)
    page.get_by_role('button', name='Send message to Hermes', exact=True).click()
    expect(page.locator('.agent-status')).to_have_text(re.compile(r'^(COMPLETED|FAILED|ATTENTION)$'), timeout=300000)
    status = page.locator('.agent-status').inner_text()
    reply = page.locator('.chat-message.assistant').last.inner_text()
    print('Agent status:', status, flush=True)
    print('Agent reply:', reply, flush=True)
    assert status == 'COMPLETED', page.locator('.agent-progress').inner_text()
    expect(page.locator('.inspector')).to_be_hidden()
    expect(page.get_by_role('button', name='Focus Host Workshop', exact=True)).to_have_count(1)
    app_iframe = page.locator('iframe[src*="/apps/comet-counter-test/"]')
    expect(app_iframe).to_have_count(1, timeout=15000)
    frame = app_iframe.content_frame
    expect(frame.get_by_role('heading', name='Comet Counter', exact=True)).to_be_visible()
    expect(frame.locator('#count')).to_have_text('0')
    frame.get_by_role('button', name='Add star', exact=True).click()
    expect(frame.locator('#count')).to_have_text('1')
    assert 'allow-same-origin' not in app_iframe.get_attribute('sandbox')
    inner = next(f for f in page.frames if '/apps/comet-counter-test/' in f.url)
    assert inner.evaluate("() => {try { return !!parent.document.body; } catch { return false; }}") is False
    print('Hermes-built app published, displayed, interactive, and parent-DOM isolated: passed', flush=True)
    assert not errors, errors
    page.screenshot(path=str(ROOT / 'workspace-verified.png'))
    workspace = page.evaluate("localStorage.getItem('orbit.workspace.id')")
    (ROOT / 'workspace-verification.json').write_text(json.dumps({'passed': True, 'workspace': workspace, 'reply': reply, 'checks': ['drag', 'resize', 'sidebar', 'persistence', 'agent-workspace-control', 'agent-app-build', 'publish-and-display', 'interactive-app', 'sandbox-isolation']}, indent=2))
    print('Workspace browser verification: PASSED', flush=True)
    browser.close()
