from playwright.sync_api import sync_playwright, expect

with sync_playwright() as p:
    browser = p.chromium.launch(headless=True, args=['--no-sandbox'])
    page = browser.new_page(viewport={'width': 1400, 'height': 950})
    errors = []
    page.on('pageerror', lambda e: errors.append(str(e)))
    page.goto('https://kimi.tailec998.ts.net:4325/', wait_until='networkidle')
    page.get_by_role('button', name='Show desktop shortcuts', exact=True).click()
    folders = page.locator('.desktop-folder')
    assert folders.count() >= 4
    assert page.locator('.desktop-icons > .desktop-shortcut:not(.desktop-folder)').count() == 0
    labels = folders.locator('.desktop-shortcut-label').all_text_contents()
    for label in labels:
        page.get_by_role('button', name=f'Open {label} folder', exact=True).click()
        expect(page.locator('.desktop-folder-panel')).to_be_visible()
        assert page.locator('.desktop-folder-grid .desktop-shortcut').count() > 0
        page.keyboard.press('Escape')
        expect(page.locator('.desktop-folder-panel')).to_have_count(0)
    page.get_by_role('button', name='Open Development folder', exact=True).click()
    before = page.locator('[data-monitor-id]').count()
    page.get_by_role('button', name='Open New terminal', exact=True).click()
    expect(page.locator('.desktop-folder-panel')).to_have_count(0)
    assert page.locator('[data-monitor-id]').count() == before + 1
    assert not errors, errors
    print('PASS: grouped folders, item counts, open/close, Escape, terminal launch, no JavaScript errors; isolated browser context')
    browser.close()
