"""Real deployed private endpoint and iframe tests; isolated browser, not owner's page."""
from pathlib import Path
import json
import urllib.request
import urllib.error
from playwright.sync_api import sync_playwright, expect

ROOT = Path(__file__).resolve().parents[1]
ORIGIN = 'https://kimi.tailec998.ts.net:4365'
HOST = 'https://kimi.tailec998.ts.net:4325'

# No process data is served to unauthenticated loopback clients or foreign origins.
for headers in ({}, {'Tailscale-User-Login': 'not-the-owner'}, {'Tailscale-User-Login': 'mojomasta@gmail.com', 'Origin': 'https://example.com'}):
    try:
        urllib.request.urlopen(urllib.request.Request('http://127.0.0.1:8682/api/metrics', headers=headers))
        raise AssertionError('Unauthorized access accepted')
    except urllib.error.HTTPError as e:
        assert e.code == 403

with sync_playwright() as p:
    browser = p.chromium.launch(headless=True, args=['--no-sandbox'])
    page = browser.new_page(viewport={'width': 720, 'height': 1300})
    errors = []
    page.on('pageerror', lambda e: errors.append(str(e)))
    page.goto(ORIGIN)
    expect(page.locator('#inflight')).not_to_have_text('—')
    expect(page.locator('#cpu')).not_to_have_text('—')
    expect(page.locator('#total')).not_to_have_text('—')
    assert page.locator('.core').count() > 0
    assert page.locator('#top-cpu .process-row').count() == 5
    assert page.locator('#top-memory .process-row').count() == 5
    assert page.evaluate('document.documentElement.scrollWidth <= innerWidth')
    page.locator('#settings-toggle').click()
    page.select_option('#grouping', 'processes')
    expect(page.locator('#top-cpu .process-name small').first).to_contain_text('PID')
    page.select_option('#grouping', 'apps')
    expect(page.locator('#top-cpu .process-name small').first).to_contain_text('processes')
    page.select_option('#theme', 'mint')
    page.select_option('#layout', 'columns')
    page.select_option('#rows', '3')
    page.locator('input[data-key="opencode"]').uncheck()
    expect(page.locator('#opencode-tokens')).to_be_hidden()
    page.reload()
    expect(page.locator('body')).to_have_attribute('data-theme', 'mint')
    expect(page.locator('body')).to_have_attribute('data-layout', 'columns')
    expect(page.locator('#opencode-tokens')).to_be_hidden()
    expect(page.locator('#top-cpu .process-row')).to_have_count(3)
    page.locator('#settings-toggle').click()
    page.locator('#reset').click()
    page.locator('#settings-toggle').click()
    for period in ['24h', '7d', '30d', 'all']:
        page.select_option('#period', period)
        expect(page.locator('#total')).not_to_have_text('—')
    for theme in ['paper', 'graphite', 'glass', 'nebula']:
        page.locator('#settings-toggle').click()
        page.select_option('#theme', theme)
        page.locator('#settings-toggle').click()
        expect(page.locator('body')).to_have_attribute('data-theme', theme)
    page.locator('#collapse').click()
    expect(page.locator('#content')).to_be_hidden()
    page.locator('#collapse').click()
    page.locator('#pause').click()
    expect(page.locator('#status')).to_have_text('Paused')
    page.locator('#pause').click()
    page.screenshot(path=str(ROOT / '.runtime/telemetry-desktop.png'), full_page=True)
    page.set_viewport_size({'width': 340, 'height': 850})
    assert page.evaluate('document.documentElement.scrollWidth <= innerWidth')
    page.screenshot(path=str(ROOT / '.runtime/telemetry-mobile.png'), full_page=True)
    # Failure-injection tests: these are deliberately synthetic, not live readings.
    payload = page.evaluate("async()=>await (await fetch('/api/metrics')).json()")
    stale = {**payload, 'gateway':{**payload['gateway'],'updated_at':0}, 'host':{**payload['host'],'updated_at':0}, 'usage':{**payload['usage'],'updated_at':0}}
    page.route('**/api/metrics',lambda route:route.fulfill(json=stale))
    page.evaluate('refresh()')
    expect(page.locator('#inflight')).to_have_text('—')
    expect(page.locator('#cpu')).to_have_text('—')
    expect(page.locator('#tps')).to_have_text('—')
    expect(page.locator('#top-cpu .process-row')).to_have_count(0)
    page.unroute('**/api/metrics')
    page.route('**/api/metrics',lambda route:route.abort())
    page.evaluate('refresh()')
    expect(page.locator('#status')).to_have_text('Disconnected')
    page.unroute('**/api/metrics')
    page.evaluate('refresh()')
    expect(page.locator('#cpu')).not_to_have_text('—')
    # Exercise the same external-app sandbox that Orbit uses.
    page.goto(HOST)
    page.evaluate('''url=>{const frame=document.createElement('iframe');frame.id='pulse-test';frame.style='position:fixed;inset:0;width:100%;height:100%;z-index:2147483647';frame.sandbox='allow-scripts allow-forms allow-same-origin allow-popups';frame.src=url;document.body.append(frame);}''', ORIGIN)
    frame = page.frame_locator('#pulse-test')
    expect(frame.locator('#cpu')).not_to_have_text('—')
    expect(frame.locator('#inflight')).not_to_have_text('—')
    expect(frame.locator('#total')).not_to_have_text('—')
    frame.locator('#settings-toggle').click()
    frame.locator('#theme').select_option('mint')
    page.locator('#pulse-test').evaluate('(e)=>e.src=e.src')
    expect(frame.locator('body')).to_have_attribute('data-theme', 'mint')
    assert not errors, errors
    print(json.dumps({'result':'PASS','checks':['private auth rejects anonymous/wrong owner/foreign origin','real host + gateway + token data','per-core grid','CPU and memory rankings','saved section/theme/layout/row settings survive reload','four reporting periods','all five themes','collapse and pause','mobile no overflow','actual Orbit-origin external iframe and persisted settings'], 'cores':frame.locator('.core').count()}))
    browser.close()
