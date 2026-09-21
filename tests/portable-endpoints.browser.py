from playwright.sync_api import sync_playwright

with sync_playwright() as p:
    browser = p.chromium.launch(headless=True, args=['--no-sandbox'])
    page = browser.new_page()
    errors = []
    page.on('pageerror', lambda e: errors.append(str(e)))
    page.goto('http://127.0.0.1:4399/', wait_until='networkidle')
    for index, app in enumerate(('chromium', 'writer', 'calc', 'impress', 'files', 'editor', 'terminal')):
        shortcut = page.locator('[data-shortcut="xpra-' + app + '"]')
        shortcut.focus()
        shortcut.press('Enter')
        page.wait_for_timeout(150)
        urls = page.locator('iframe').evaluate_all('(frames)=>frames.map(f=>f.src)')
        expected = f'http://127.0.0.1:{4350+index}/?floating_menu=false&sharing=true&orbit_app=1'
        assert expected in urls, (app, urls)
    assert not errors, errors
    print('PASS: all seven real desktop shortcuts create local-host Xpra iframe URLs; no page JS errors. Xpra services not provisioned in this test.')
    browser.close()
