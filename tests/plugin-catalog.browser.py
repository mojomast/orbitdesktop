"""Read-only live UI checks, plus a real pinned install in a disposable Hermes home.
Does not install or enable plugins in the owner's active profile.
"""
from pathlib import Path
import importlib.util
import json
import os
import subprocess
import tempfile
import time
import urllib.request
from playwright.sync_api import sync_playwright, expect

ROOT = Path(__file__).resolve().parents[1]
CONFIG = json.loads((ROOT / '.runtime/plugin-catalog/config.json').read_text())
ORIGIN = CONFIG['public_origin']
env = dict(line.split('=', 1) for line in (ROOT / '.env.deploy').read_text().splitlines() if '=' in line)
with sync_playwright() as p:
    b = p.chromium.launch(headless=True, args=['--no-sandbox'])
    page = b.new_page(viewport={'width': 1440, 'height': 1000})
    errors = []
    page.on('pageerror', lambda e: errors.append(str(e)))
    page.goto(ORIGIN)
    expected_count = len(json.load(urllib.request.urlopen(ORIGIN + '/api/catalog'))['entries'])
    expect(page.locator('.card')).to_have_count(expected_count, timeout=60000)
    page.locator('#search').fill('orbit')
    expect(page.get_by_role('button', name='View orbit-desktop', exact=True)).to_be_visible()
    page.get_by_role('button', name='View orbit-desktop', exact=True).click()
    expect(page.locator('#detailBody')).to_contain_text('Reviewed commit')
    page.get_by_role('button', name='Close plugin details', exact=True).click()
    page.locator('#search').fill('zzzz_no_plugin')
    expect(page.locator('.empty')).to_contain_text('No plugins match')
    page.locator('#search').fill('')
    page.locator('#unlock').click()
    page.locator('#token').fill(env['ORBIT_TOKEN'].strip().strip('"'))
    page.get_by_role('button', name='Unlock', exact=True).click()
    expect(page.locator('#connection')).to_have_text('Management unlocked', timeout=30000)
    assert page.locator('#token').input_value() == ''
    page.locator('#search').fill('orbit-desktop')
    page.get_by_role('button', name='View orbit-desktop', exact=True).click()
    page.get_by_role('button', name='Review installation', exact=True).click()
    expect(page.locator('#confirm')).to_be_disabled()
    page.locator('#consent').check()
    expect(page.locator('#confirm')).to_be_enabled()
    # Cancel without installing into the active profile.
    page.get_by_role('button', name='Cancel operation', exact=True).click()
    page.get_by_role('button', name='Close plugin details', exact=True).click()
    page.locator('#search').fill('')
    page.locator('#unlock').click()
    expect(page.locator('#connection')).to_have_text('Browse mode')
    page.screenshot(path=str(ROOT / '.runtime/plugin-catalog/catalog-desktop.png'), full_page=False)
    page.set_viewport_size({'width': 390, 'height': 844})
    assert page.locator('body').evaluate('e=>e.scrollWidth<=window.innerWidth'), 'Mobile overflow'
    page.screenshot(path=str(ROOT / '.runtime/plugin-catalog/catalog-mobile.png'), full_page=False)
    # Exercise the real service inside Orbit's external-browser sandbox contract.
    page.set_viewport_size({'width': 1250, 'height': 950})
    page.goto(CONFIG['orbit_origin'])
    page.set_content(f'<iframe title="Catalog" sandbox="allow-scripts allow-forms allow-same-origin allow-popups" src="{ORIGIN}" style="width:1200px;height:900px"></iframe>')
    frame = page.frame_locator('iframe')
    expect(frame.locator('.card')).to_have_count(expected_count, timeout=60000)
    frame.locator('#unlock').click()
    frame.locator('#token').fill(env['ORBIT_TOKEN'].strip().strip('"'))
    frame.get_by_role('button', name='Unlock', exact=True).click()
    expect(frame.locator('#connection')).to_have_text('Management unlocked', timeout=30000)
    frame.locator('#unlock').click()
    expect(frame.locator('#connection')).to_have_text('Browse mode')
    assert not errors, errors
    b.close()
print('PASS live browser: catalog, search, details, unlock, consent, cancel, lock, responsive layout; no page errors')

spec = importlib.util.spec_from_file_location('catalog_service', ROOT / 'extensions/plugin-catalog/main.py')
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)
m.CONFIG = CONFIG.copy()
with tempfile.TemporaryDirectory(prefix='orbit-catalog-install-') as temp:
    m.CONFIG['hermes_home'] = temp
    data = m.catalog(force=True)
    # A real catalog package; keep it disabled and delete the disposable home afterwards.
    entry = next(e for e in data['entries'] if e['name'] == 'diff-review')
    m.JOBS['test'] = {'status': 'running', 'log': ''}
    m.OP_LOCK.acquire()
    m.execute_job('test', entry, 'install')
    result = m.JOBS['test']
    print('Real isolated install:', json.dumps(result, indent=2))
    assert result['status'] == 'succeeded', result
    assert result['installed']['revision'] == entry['sha']
    assert result['installed']['status'] == 'disabled'
print('PASS real catalog install: exact SHA verified, installed disabled, disposable home removed')
