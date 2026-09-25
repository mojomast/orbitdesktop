from pathlib import Path
from playwright.sync_api import sync_playwright, expect
root = Path(__file__).resolve().parents[1]
env = dict(x.split('=', 1) for x in (root / '.env.deploy').read_text().splitlines() if '=' in x)
origin = env['ORBIT_PUBLIC_ORIGIN'].rstrip('/')
with sync_playwright() as p:
    browser = p.chromium.launch(headless=True, args=['--no-sandbox'])
    page = browser.new_page()
    page.goto(origin + '/apps/hermes-token-stats/')
    expect(page.locator('#total')).not_to_have_text('—')
    for selector in ['html', 'body', 'select']:
        assert page.locator(selector).evaluate('(e)=>getComputedStyle(e).backgroundColor') == 'rgba(0, 0, 0, 0)', selector
        assert page.locator(selector).evaluate('(e)=>getComputedStyle(e).backgroundImage') == 'none', selector
    page.select_option('#scope','profile')
    expect(page.locator('#total')).not_to_have_text('—')
    page.goto(origin)
    page.wait_for_selector('.workspace')
    page.evaluate('''() => { const w=document.querySelector('.workspace');w.classList.add('windows-mode');const m=document.createElement('div');m.dataset.monitorId='480f30c9-9d43-4be3-950e-63832e4f50de';m.id='transparency-test';w.append(m); }''')
    styles = page.locator('#transparency-test').evaluate('(e)=>{const s=getComputedStyle(e);return {background:s.backgroundColor,shadow:s.boxShadow,border:s.borderTopWidth,radius:s.borderRadius}}')
    assert styles == dict(background='rgba(0, 0, 0, 0)',shadow='none',border='0px',radius='0px'), styles
    print('PASS: live app background and scope control transparent; counters working; deployed desktop overlay has no background, shadow, border or rounding.')
    browser.close()
