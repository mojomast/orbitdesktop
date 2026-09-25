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
    assert 'linear-gradient' in page.locator('.topbar').evaluate('(e)=>getComputedStyle(e).backgroundImage')
    expect(page.locator('.chat-form').first).to_have_css('border-radius', '17px')
    expect(page.locator('.chat-message').first).to_have_css('border-radius', '16px')
    menu(page,'Choose workspace theme')
    dialog = page.get_by_role('dialog', name='Workspace themes')
    expect(dialog).to_be_visible()
    expect(dialog).to_have_css('border-radius', '20px')
    page.get_by_role('button', name='Close workspace themes').click()
    page.locator('.start-button').click()
    expect(page.locator('.start-panel')).to_be_visible()
    page.locator('.start-button').click()
    assert not errors, errors
    page.emulate_media(reduced_motion='reduce')
    assert page.locator('.topbar button').first.evaluate('(e)=>getComputedStyle(e).transitionDuration') == '0s'
    page.set_viewport_size({'width': 390, 'height': 844})
    assert page.evaluate('document.documentElement.scrollWidth <= innerWidth')
    browser.close()
    print('PASS: production Nebula CSS, chat cards/composer, theme dialog, Start menu, reduced-motion, mobile document width; zero JS errors. Isolated browser workspace only.')
