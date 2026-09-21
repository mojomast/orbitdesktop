"""Run against a disposable production Orbit server, never the owner's workspace."""
import os
from playwright.sync_api import sync_playwright, expect
with sync_playwright() as p:
    b = p.chromium.launch(headless=True)
    page = b.new_page()
    page.goto(os.environ.get('ORBIT_TEST_URL', 'http://127.0.0.1:4179'))
    page.wait_for_selector('canvas', state='attached')
    page.evaluate("window.dispatchEvent(new Event('orbit-open-devplan-studio'))")
    frame = page.frame_locator('iframe[src$="/devplan-studio/index.html"]')
    expect(frame.locator('#answer')).to_be_visible()
    frame.locator('#answer').fill('Launcher draft preserved')
    assert 'memory only' in frame.locator('#storage').inner_text()
    page.evaluate("window.dispatchEvent(new Event('orbit-open-devplan-studio'))")
    assert page.locator('iframe[src$="/devplan-studio/index.html"]').count() == 1
    expect(frame.locator('#answer')).to_have_value('Launcher draft preserved')
    print('PASS: production Orbit launcher, sandboxed app rendered, repeated launch reuses window and preserves draft')
    b.close()
