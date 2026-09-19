"""Opt-in live browser test. Requires Playwright and .env.deploy; uses real Hermes."""
import json
from pathlib import Path
from playwright.sync_api import sync_playwright, expect

ROOT = Path(__file__).resolve().parents[1]
env = dict(line.split('=', 1) for line in (ROOT / '.env.deploy').read_text().splitlines() if '=' in line)
with sync_playwright() as p:
    browser = p.chromium.launch(headless=True, args=['--no-sandbox'])
    page = browser.new_page(viewport={'width': 1600, 'height': 1000})
    errors = []
    page.on('pageerror', lambda error: errors.append(str(error)))
    page.goto(env['ORBIT_PUBLIC_ORIGIN'], wait_until='networkidle')
    page.get_by_role('button', name='Focus Display 03', exact=True).click(force=True)
    message = page.get_by_role('textbox', name='Message to Hermes')
    message.fill('This must not send until unlocked.')
    page.get_by_role('button', name='Send message to Hermes', exact=True).click()
    expect(page.locator('.agent-progress')).to_contain_text('Connect host')

    def unlock():
        page.get_by_role('button', name='Connect local host', exact=True).click()
        page.get_by_role('textbox', name='Host session token').fill(env['ORBIT_TOKEN'])
        page.get_by_role('button', name='Unlock local host', exact=True).click()
        expect(page.locator('dialog')).to_have_count(0)

    def send(text, expected):
        page.get_by_role('textbox', name='Message to Hermes').fill(text)
        page.get_by_role('button', name='Send message to Hermes', exact=True).click()
        expect(page.locator('.chat-message.assistant').last).to_have_text('HERMES' + expected, timeout=180000)

    unlock()
    send('Browser integration test: remember the code browser-jade-418. Reply exactly ORBIT_BROWSER_CONNECTED.', 'ORBIT_BROWSER_CONNECTED')
    print('Browser message and actual Hermes reply: passed')
    page.reload(wait_until='networkidle')
    page.get_by_role('button', name='Focus Display 03', exact=True).click(force=True)
    expect(page.locator('.chat-message.assistant').last).to_contain_text('ORBIT_BROWSER_CONNECTED')
    unlock()
    send('Reply with only the code I asked you to remember in my previous message. No tools needed.', 'browser-jade-418')
    print('Reload persistence, reauthentication, and follow-up memory: passed')
    page.screenshot(path=str(ROOT / 'browser-hermes-verified.png'))
    page.get_by_role('button', name='Start a separate Hermes conversation').click()
    expect(page.locator('.chat-message.user')).to_have_count(0)
    message = page.get_by_role('textbox', name='Message to Hermes')
    message.fill('Cancellation integration test: use terminal to run sleep 20, then reply FINISHED. Do not change files.')
    page.get_by_role('button', name='Send message to Hermes', exact=True).click()
    stop = page.get_by_role('button', name='Ask Hermes to stop this run')
    expect(stop).to_be_visible(timeout=30000)
    stop.click()
    expect(page.locator('.agent-status')).to_have_text('CANCELLED', timeout=90000)
    print('New chat and live cooperative Stop: passed')
    assert not errors, errors
    print('Browser JavaScript errors: none')
    (ROOT / 'browser-verification.json').write_text(json.dumps({'passed': True, 'checks': ['locked-auth', 'live-message', 'reload', 'follow-up-memory', 'new-chat', 'live-stop', 'no-js-errors']}, indent=2))
    browser.close()
