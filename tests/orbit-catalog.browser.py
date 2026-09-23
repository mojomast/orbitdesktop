"""Real GitHub download + publisher + isolated Orbit server/browser lifecycle test.
Run after npm run build with a Python environment containing Playwright.
No owner workspace, credentials or server processes are used.
"""
import importlib.util
import json
import os
from pathlib import Path
import secrets
import shutil
import socket
import subprocess
import tempfile
import time
import urllib.request
from playwright.sync_api import sync_playwright, expect

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('catalog', ROOT / 'scripts/orbit_catalog.py')
catalog = importlib.util.module_from_spec(spec)
spec.loader.exec_module(catalog)
entry = json.loads((ROOT / 'examples/catalog/notes.json').read_text())
with tempfile.TemporaryDirectory(prefix='orbit-catalog-browser-') as tmp:
    root = Path(tmp)
    feed = root / 'orbit-community-catalog.json'
    # Fetches the actual committed Notes HTML from GitHub and invokes the real publisher.
    fixture = root / 'catalog'
    fixture.mkdir()
    (fixture / 'notes.json').write_text(json.dumps(entry))
    (fixture / 'removed.json').write_text('[]')
    subprocess.run([os.sys.executable, str(ROOT / 'scripts/orbit_catalog.py'), 'sync', '--catalog', str(fixture), '--runtime', str(root / 'runtime'), '--output', str(feed)], check=True)
    result = json.loads(feed.read_text())
    with socket.socket() as sock:
        sock.bind(('127.0.0.1', 0))
        port = sock.getsockname()[1]
    token = secrets.token_urlsafe(32)
    env = {**os.environ, 'PORT': str(port), 'ORBIT_TOKEN': token, 'ORBIT_RUNTIME_DIR': str(root / 'runtime'), 'ORBIT_PUBLIC_HOST': ''}
    origin = f'http://127.0.0.1:{port}'
    with (root / 'server.log').open('w') as log:
        server = subprocess.Popen(['node', '--experimental-strip-types', 'server/index.mjs'], cwd=ROOT, env=env, stdout=log, stderr=log)
        try:
            for attempt in range(100):
                try:
                    with urllib.request.urlopen(origin + '/api/health', timeout=1) as response:
                        assert response.status == 200
                    break
                except OSError:
                    if server.poll() is not None:
                        raise RuntimeError('Isolated test server exited')
                    time.sleep(0.1)
            else:
                raise RuntimeError('Test server not ready')
            with sync_playwright() as playwright:
                browser = playwright.chromium.launch(headless=True, args=['--no-sandbox'])
                page = browser.new_page(viewport={'width': 1440, 'height': 1000})
                errors = []
                page.on('pageerror', lambda error: errors.append(str(error)))
                # Intercept only deployment feeds; app files and workspace actions use the real server.
                page.route('**/orbit-plugin-catalog.json', lambda route: route.fulfill(status=404, body=''))
                page.route('**/orbit-community-catalog.json', lambda route: route.fulfill(content_type='application/json', body=feed.read_text()))
                page.goto(origin, wait_until='networkidle')
                page.get_by_role('button', name='Connect local host', exact=True).click()
                page.get_by_role('textbox', name='Host session token').fill(token)
                page.get_by_role('button', name='Unlock local host', exact=True).click()
                page.keyboard.press('Control+Alt+p')
                dialog = page.get_by_role('dialog', name='Workspace plugins', exact=True)
                expect(dialog.locator('.plugin-card')).to_have_count(1)
                expect(dialog.get_by_role('heading', name='Make space for what’s next.')).to_be_visible()
                dialog.get_by_label('Catalog source', exact=True).select_option('Local catalog')
                expect(dialog.locator('.plugin-card')).to_have_count(0)
                dialog.get_by_label('Catalog source', exact=True).select_option('GitHub community')
                expect(dialog.locator('.plugin-card')).to_have_count(1)
                dialog.get_by_label('Plugin category', exact=True).select_option(entry['category'])
                expect(dialog.locator('.plugin-card')).to_have_count(1)
                expect(dialog.get_by_role('link', name='View pinned source')).to_have_attribute('href', f"{entry['repo']}/tree/{entry['sha']}")
                page.set_viewport_size({'width': 390, 'height': 844})
                assert dialog.evaluate('(el) => el.scrollWidth <= el.clientWidth + 1')
                page.screenshot(path='/tmp/orbit-catalog-mobile.png')
                page.set_viewport_size({'width': 1440, 'height': 1000})
                page.screenshot(path='/tmp/orbit-catalog-desktop.png')
                dialog.get_by_label('Plugin category', exact=True).select_option('All categories')
                dialog.get_by_label('Catalog source', exact=True).select_option('All sources')
                expect(dialog).to_contain_text(entry['sha'][:12])
                dialog.get_by_role('button', name='Install plugin notes', exact=True).click()
                expect(dialog.get_by_role('button', name='Enable plugin notes', exact=True)).to_be_enabled()
                expect(dialog).to_contain_text('0 enabled')
                dialog.get_by_role('button', name='Enable plugin notes', exact=True).click()
                expect(dialog.get_by_role('button', name='Disable plugin notes', exact=True)).to_be_enabled()
                expect(page.frame_locator('iframe[src*="/apps/notes-"]').get_by_role('heading', name='Workspace notes')).to_be_visible()
                # Controlled catalog-version fixture tests explicit updates, not a fictional release.
                result['entries'][0]['manifest']['version'] = '1.0.1'
                feed.write_text(json.dumps(result))
                dialog.get_by_role('button', name='Refresh workspace plugins').click()
                expect(dialog.get_by_role('button', name='Update plugin notes')).to_be_enabled()
                page.once('dialog', lambda prompt: prompt.accept())
                dialog.get_by_role('button', name='Update plugin notes').click()
                expect(dialog.get_by_role('button', name='Update plugin notes')).to_have_count(0)
                expect(dialog).to_contain_text('v1.0.1')
                dialog.get_by_role('button', name='Disable plugin notes').click()
                expect(dialog.get_by_role('button', name='Enable plugin notes')).to_be_enabled()
                # Removing a listing leaves an existing installation manageable.
                feed.write_text(json.dumps({'version': 1, 'entries': []}))
                dialog.get_by_role('button', name='Refresh workspace plugins').click()
                expect(dialog).to_contain_text('not listed in the bundled catalog')
                page.once('dialog', lambda prompt: prompt.accept())
                dialog.get_by_role('button', name='Remove plugin notes').click()
                expect(dialog.locator('.plugin-card')).to_have_count(0)
                assert not errors, errors
                browser.close()
            print('PASS: real GitHub pinned source, real publisher, isolated authenticated install-disabled/enable/render/update/disable/delist/remove; no browser errors.')
        finally:
            server.terminate()
            server.wait(timeout=10)
