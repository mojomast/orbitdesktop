import json
from playwright.sync_api import sync_playwright, expect
import os as _os, sys as _sys
_sys.path.insert(0, _os.path.dirname(_os.path.abspath(__file__)))
from orbit_menu import menu, open_menu, close_menu

with sync_playwright() as p:
    browser = p.chromium.launch(headless=True, args=['--no-sandbox'])
    page = browser.new_page(viewport={'width': 1440, 'height': 1000})
    errors = []
    page.on('pageerror', lambda e: errors.append(str(e)))
    page.goto('https://kimi.tailec998.ts.net:4325/', wait_until='networkidle')
    # Unauthenticated isolated browser: never imports owner credentials or workspace ID.
    state = page.evaluate('JSON.parse(localStorage.getItem("orbit.workspace.v1"))')
    for i, m in enumerate(state['monitors']):
        m['name'] = f'Test window {i}'
        m['layout'] = {'type': 'pane', 'pane': {'id': m['layout']['pane']['id'], 'kind': 'browser', 'url': 'https://example.com'}}
        m['frame'] = {'x': 10+i*340, 'y': 10, 'width': 330, 'height': 400, 'z': i+1}
    state['monitors'][0]['id'] = '67143ce5-4b26-40e6-9077-b082cb498584'
    if len(state['monitors']) > 1:
        state['monitors'][1]['id'] = '480f30c9-9d43-4be3-950e-63832e4f50de'
    state['selected'] = state['monitors'][-1]['id']
    state['view'] = 'windows'
    page.add_init_script('if (!sessionStorage.getItem("minimize-fixture")) { localStorage.setItem("orbit.workspace.v1", JSON.stringify(' + json.dumps(state) + ')); sessionStorage.setItem("minimize-fixture", "1"); }')
    page.reload(wait_until='networkidle')
    for m in state['monitors']:
        win = page.locator(f'[data-monitor-id="{m["id"]}"]')
        control = win.get_by_role('button', name=f'Minimize {m["name"]}', exact=True)
        expect(control).to_be_visible()
        page.evaluate('(id) => {window.savedMonitor=document.querySelector(`[data-monitor-id="${id}"]`); window.savedFrame=window.savedMonitor.querySelector("iframe");}', m['id'])
        control.click()
        expect(win).to_be_hidden()
        restore = page.get_by_role('button', name=f'Restore {m["name"]}', exact=True)
        expect(restore).to_be_visible()
        restore.click()
        expect(win).to_be_visible()
        assert page.evaluate('window.savedMonitor.isConnected && window.savedFrame === window.savedMonitor.querySelector("iframe")')
    print('PASS: all windows including companion/HUD minimize completely and restore identical DOM/iframe nodes')
    m = state['monitors'][-1]
    page.get_by_role('button', name=f'Minimize {m["name"]}', exact=True).click()
    page.reload(wait_until='networkidle')
    expect(page.locator(f'[data-monitor-id="{m["id"]}"]')).to_be_hidden()
    page.get_by_role('button', name=f'Select {m["name"]}', exact=True).click()
    expect(page.locator(f'[data-monitor-id="{m["id"]}"]')).to_be_visible()
    print('PASS: reload persistence and taskbar restore')
    page.get_by_role('button', name=f'Focus {m["name"]}', exact=True).click()
    page.get_by_role('button', name=f'Minimize {m["name"]}', exact=True).click()
    expect(page.locator('.focus-host')).not_to_have_class('focus-host visible')
    page.get_by_role('button', name=f'Restore {m["name"]}', exact=True).click()
    menu(page,'Switch to spatial view')
    page.get_by_role('button', name=f'Minimize {m["name"]}', exact=True).click()
    expect(page.locator(f'[data-anchor-id="{m["id"]}"]')).to_be_hidden()
    page.get_by_role('button', name=f'Restore {m["name"]}', exact=True).click()
    print('PASS: focus exit and spatial anchor hidden/restored')
    assert not errors, errors
    print('PASS: no JavaScript errors')
    browser.close()
