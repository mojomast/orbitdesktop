"""Real HTTP/browser install-enable-disable round trip, isolated Hermes home.
Policy edge cases use explicit fixtures; catalog/install integration uses live upstream.
"""
import copy
import importlib.util
import json
from pathlib import Path
import tempfile
import threading
import time
import urllib.error
import urllib.request
from playwright.sync_api import sync_playwright, expect

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('catalog_service', ROOT / 'extensions/plugin-catalog/main.py')
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)
config = json.loads((ROOT / '.runtime/plugin-catalog/config.json').read_text())
secrets = dict(line.split('=', 1) for line in (ROOT / '.env.deploy').read_text().splitlines() if '=' in line)
data = m.catalog(force=True)
entry = next(e for e in data['entries'] if e['name'] == 'diff-review')
for description, mutated, name, sha in [
    ('stale SHA', data, entry['name'], '0' * 40),
    ('unknown entry', data, 'not-in-catalog', entry['sha']),
    ('removed name', dict(data, removed=[{'name': entry['name']}]), entry['name'], entry['sha']),
    ('removed repo', dict(data, removed=[{'repo': entry['repo'] + '.git'}]), entry['name'], entry['sha']),
]:
    try:
        m.entry_for(mutated, name, sha)
        raise AssertionError(description + ' was accepted')
    except ValueError:
        print('PASS rejected:', description)
malicious = copy.deepcopy(data)
malicious['entries'][0]['subdir'] = '../../escape'
try:
    m.validate_catalog(malicious)
    raise AssertionError('Traversal accepted')
except ValueError:
    print('PASS rejected: subdirectory traversal')

with tempfile.TemporaryDirectory(prefix='orbit-catalog-e2e-') as temp:
    m.CONFIG = dict(config, hermes_home=temp, profile_label='Disposable browser test profile')
    server = m.ThreadingHTTPServer(('127.0.0.1', 0), m.Handler)
    origin = f'http://127.0.0.1:{server.server_port}'
    m.CONFIG['public_origin'] = origin
    threading.Thread(target=server.serve_forever, daemon=True).start()
    def request(path, body=None, headers=None):
        h = {'Content-Type': 'application/json', 'Origin': origin, **(headers or {})}
        req = urllib.request.Request(origin + path, data=None if body is None else json.dumps(body).encode(), headers=h)
        try:
            with urllib.request.urlopen(req) as r:
                return r.status, json.load(r)
        except urllib.error.HTTPError as r:
            return r.code, json.load(r)
    assert request('/health')[1]['ok'] is True
    assert request('/api/installed')[0] == 401
    assert request('/api/action', {'confirm': True, 'action': 'install'})[0] == 403
    assert request('/api/unlock', {'token': 'x' * 32}, {'Origin': 'https://evil.invalid'})[0] == 403
    assert request('/api/catalog', headers={'Host': 'evil.invalid'})[0] == 403
    assert request('/api/unlock', {'token': 'x' * 32})[0] == 401
    print('PASS HTTP: protected state, unauthorized mutation, foreign origin, hostile Host, invalid token')
    status, auth = request('/api/unlock', {'token': secrets['ORBIT_TOKEN'].strip().strip('"')})
    assert status == 200
    headers = {'Authorization': 'Bearer ' + auth['session_token']}
    action = {'action': 'install', 'name': entry['name'], 'sha': entry['sha'], 'confirm': True}
    assert request('/api/action', action, headers)[0] == 403
    action['csrf'] = auth['csrf']
    assert request('/api/action', dict(action, confirm=False), headers)[0] == 400
    assert request('/api/action', dict(action, action='shell'), headers)[0] == 400
    assert request('/api/action', dict(action, sha='0'*40), headers)[0] == 400
    m.OP_LOCK.acquire()
    try:
        assert request('/api/action', action, headers)[0] == 409
    finally:
        m.OP_LOCK.release()
    assert request('/api/lock', {'csrf': auth['csrf']}, headers)[0] == 200
    assert request('/api/installed', headers=headers)[0] == 401
    print('PASS HTTP: CSRF, explicit consent, action allowlist, stale pin, serialization, session revocation')
    code, text = m.run_bridge(['compatible', '>=999.0'])
    assert code != 0 and 'requires Hermes' in text
    print('PASS minimum Hermes version enforced')
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True, args=['--no-sandbox'])
        page = browser.new_page(viewport={'width': 1300, 'height': 950})
        errors = []
        page.on('pageerror', lambda e: errors.append(str(e)))
        page.goto(origin)
        expect(page.locator('.card')).to_have_count(len(data['entries']), timeout=60000)
        page.locator('#unlock').click()
        page.locator('#token').fill(secrets['ORBIT_TOKEN'].strip().strip('"'))
        page.get_by_role('button', name='Unlock', exact=True).click()
        expect(page.locator('#connection')).to_have_text('Management unlocked', timeout=30000)
        page.locator('#search').fill('diff-review')
        page.get_by_role('button', name='View diff-review', exact=True).click()
        page.get_by_role('button', name='Review installation', exact=True).click()
        expect(page.locator('#confirm')).to_be_disabled()
        page.locator('#consent').check()
        page.locator('#confirm').click()
        expect(page.locator('#jobs')).to_contain_text('install · diff-review · succeeded', timeout=180000)
        meta = m.installed()
        actual = m.match_installed(entry, meta)
        assert actual['revision'] == entry['sha'] and actual['status'] == 'disabled', actual
        print('PASS real browser install:', entry['name'], entry['sha'], 'disabled')
        # Enabling changes configuration only; no Hermes session starts and no plugin code loads.
        for action, label, state in [('enable', 'Review & enable', 'enabled'), ('disable', 'Disable plugin', 'disabled')]:
            expect(page.locator('.card .state')).to_have_text('disabled' if action == 'enable' else 'enabled', timeout=30000)
            page.get_by_role('button', name='View diff-review', exact=True).click()
            page.get_by_role('button', name=label, exact=True).click()
            page.locator('#consent').check()
            page.locator('#confirm').click()
            expect(page.locator('#jobs')).to_contain_text(f'{action} · diff-review · succeeded', timeout=90000)
            assert m.match_installed(entry, m.installed())['status'] == state
            print('PASS real browser:', action)
        page.screenshot(path=str(ROOT / '.runtime/plugin-catalog/isolated-install-evidence.png'))
        page.reload()
        expect(page.locator('#connection')).to_have_text('Browse mode')
        assert not errors, errors
        print('PASS memory-only session resets on reload; no page errors')
        browser.close()
    server.shutdown()
print('PASS: temporary Hermes home removed; owner profile untouched')
