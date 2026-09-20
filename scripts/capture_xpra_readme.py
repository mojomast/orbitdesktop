"""Fresh, credential-free README captures in an isolated browser workspace.
Requires the configured deployment and Playwright; never types in native apps.
"""
from pathlib import Path
from playwright.sync_api import sync_playwright, expect
R = Path(__file__).resolve().parents[1]
env = dict(x.split('=', 1) for x in (R / '.env.deploy').read_text().splitlines() if '=' in x)
out = R / 'docs/images'
out.mkdir(exist_ok=True)
with sync_playwright() as p:
    browser = p.chromium.launch(headless=True, args=['--no-sandbox'])
    page = browser.new_page(viewport={'width': 1600, 'height': 1000})
    page.goto(env['ORBIT_PUBLIC_ORIGIN'], wait_until='networkidle')
    page.get_by_role('button', name='Show desktop shortcuts', exact=True).click()
    expect(page.locator('[data-shortcut="xpra-writer"]')).to_be_visible()
    page.screenshot(path=str(out / 'desktop-launchers.png'))
    page.get_by_role('button', name='Open Connection passwords', exact=True).evaluate('(e)=>e.click()')
    expect(page.get_by_role('button', name='Copy Xpra password', exact=True)).to_be_visible()
    page.screenshot(path=str(out / 'connection-passwords.png'))
    page.get_by_role('button', name='Close connection passwords').click()
    page.locator('[data-shortcut="xpra-writer"]').click()
    frame = page.frame_locator('iframe[src*="4351"]')
    frame.locator('#password').fill((R / '.runtime/xpra/password').read_text().strip())
    frame.get_by_text('Connect', exact=True).click()
    expect(frame.locator('canvas').first).to_be_visible(timeout=30000)
    page.wait_for_timeout(2500)
    # Only the owner-approved README document is intended for this capture.
    page.screenshot(path=str(out / 'xpra-writer.png'))
    browser.close()
print('Captured desktop launchers, password-copy dialog (no credentials), and real Xpra Writer; no native typing or live workspace mutation.')
