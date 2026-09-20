"""Verify desktop launchers in a fresh workspace without typing into shared apps."""
from pathlib import Path
from playwright.sync_api import sync_playwright, expect
R = Path(__file__).resolve().parents[1]
env = dict(x.split('=', 1) for x in (R / '.env.deploy').read_text().splitlines() if '=' in x)
with sync_playwright() as p:
    b = p.chromium.launch(headless=True, args=['--no-sandbox'])
    g = b.new_page(viewport={'width': 1600, 'height': 1100})
    errors = []
    g.on('pageerror', lambda e: errors.append(str(e)))
    g.goto(env['ORBIT_PUBLIC_ORIGIN'], wait_until='networkidle')
    for app in ['chromium', 'writer', 'calc', 'impress', 'files', 'editor', 'terminal']:
        icon = g.locator(f'[data-shortcut="xpra-{app}"]')
        icon.focus(); icon.press('Enter')
        count = g.locator('.desktop-window').count()
        icon.focus(); icon.press('Enter')
        assert g.locator('.desktop-window').count() == count, app
    g.get_by_role('button', name='Show desktop shortcuts', exact=True).click()
    expect(g.locator('.desktop-window:not(.window-minimized)')).to_have_count(0)
    g.locator('[data-shortcut="xpra-writer"]').click()
    expect(g.locator('.desktop-window:not(.window-minimized)')).to_have_count(1)
    f = g.frame_locator('iframe[src*="4351"]')
    f.locator('#password').fill((R / '.runtime/xpra/password').read_text().strip())
    f.get_by_text('Connect', exact=True).click()
    expect(f.locator('canvas').first).to_be_visible(timeout=30000)
    assert not errors, errors
    b.close()
print('PASS: seven launchers, deduplication, desktop minimize/restore, real Writer canvas, no page errors; no native keystrokes sent.')
