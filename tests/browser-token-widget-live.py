from pathlib import Path
from playwright.sync_api import sync_playwright, expect
root = Path(__file__).resolve().parents[1]
env = dict(x.split('=', 1) for x in (root / '.env.deploy').read_text().splitlines() if '=' in x)
with sync_playwright() as p:
    browser = p.chromium.launch(headless=True, args=['--no-sandbox'])
    page = browser.new_page(viewport={'width': 340, 'height': 335})
    errors = []
    page.on('pageerror', lambda e: errors.append(str(e)))
    page.goto(env['ORBIT_PUBLIC_ORIGIN'].rstrip('/') + '/apps/hermes-token-stats/')
    expect(page.locator('#status')).to_contain_text('Updated')
    first = page.locator('#total').inner_text()
    assert first != '—'
    page.select_option('#scope', 'profile')
    second = page.locator('#total').inner_text()
    assert int(second.replace(',', '')) >= int(first.replace(',', ''))
    old = page.locator('#status').inner_text()
    page.wait_for_timeout(32000)
    assert page.locator('#status').inner_text() != old
    assert not errors, errors
    assert page.evaluate('document.documentElement.scrollWidth <= innerWidth')
    print('PASS: real counters rendered, scope switch, automatic refresh, no horizontal overflow, no JS errors; Orbit='+first+' Profile='+second)
    browser.close()
