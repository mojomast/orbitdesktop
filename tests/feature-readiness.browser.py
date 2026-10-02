"""Disposable real shell Start/palette integration with content-free owner fixtures."""
import json
import os
from pathlib import Path
import shutil
import socket
import subprocess
import tempfile
import time
import urllib.request
import uuid
from datetime import datetime, timezone
from playwright.sync_api import expect, sync_playwright

ROOT = Path(__file__).resolve().parents[1]
with tempfile.TemporaryDirectory(prefix='orbit-readiness-browser-', dir='/tmp/opencode') as tmp:
    root = Path(tmp)
    for name in ('src', 'contracts', 'server', 'scripts', 'docs', 'public'):
        shutil.copytree(ROOT / name, root / name)
    for name in ('index.html', 'package.json', 'package-lock.json', 'tsconfig.json', 'vite.config.js'):
        shutil.copy2(ROOT / name, root / name)
    (root / 'node_modules').symlink_to(ROOT / 'node_modules', target_is_directory=True)
    with socket.socket() as probe:
        probe.bind(('127.0.0.1', 0))
        port = probe.getsockname()[1]
    origin = f'http://127.0.0.1:{port}'
    workspace, window, pane = [str(uuid.uuid4()) for _ in range(3)]
    state = {'version': 1, 'selected': window, 'arc': 14, 'view': 'windows', 'monitors': [
        {'id': window, 'name': 'Fixture', 'diagonal': 32, 'aspect': '16:9', 'height': 0,
         'distance': 0, 'pitch': 0, 'yaw': 0, 'offset': 0, 'fontSize': 16,
         'frame': {'x': 20, 'y': 20, 'width': 600, 'height': 700, 'z': 0},
         'layout': {'type': 'pane', 'pane': {'id': pane, 'kind': 'browser', 'url': 'orbit://welcome'}}}]}
    server = subprocess.Popen([str(ROOT / 'node_modules/.bin/vite'), '--host', '127.0.0.1',
                               '--port', str(port), '--strictPort'], cwd=root,
                              stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    try:
        for _ in range(150):
            try:
                urllib.request.urlopen(origin, timeout=1).close()
                break
            except OSError:
                time.sleep(.1)
        with sync_playwright() as p:
            browser = p.chromium.launch(headless=True, executable_path=os.environ.get('ORBIT_TEST_CHROMIUM'), args=['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'])
            context = browser.new_context(viewport={'width': 1500, 'height': 1000})
            context.add_init_script("if(window===window.top){localStorage.setItem('orbit.onboarding.v1','done');localStorage.setItem('orbit.workspace.id',%s);localStorage.setItem('orbit.workspace.v1',%s);}" % (json.dumps(workspace), json.dumps(json.dumps(state))))
            page = context.new_page()
            configured = False
            reads = []
            errors = []
            page.on('pageerror', lambda error: errors.append(str(error)))
            def api(route):
                body = route.request.post_data_json or {}
                path = route.request.url.split('?')[0]
                def reply(data):
                    route.fulfill(content_type='application/json', body=json.dumps(data))
                if path.endswith('/api/auth'):
                    return reply({'ok': True})
                if path.endswith('/api/technology-capabilities'):
                    reads.append(path)
                    return reply({'descriptors': {'observed_at': datetime.now(timezone.utc).isoformat(), 'features': [
                        {'surface_uri': 'orbit://surface/voice', 'formats': ['audio'], 'delegated': {'availability': 'unsupported'}, 'readiness': {'detail': 'Model files present; browser audio unknown.' if configured else 'Voice model files missing; provision voice models.'}},
                        {'surface_uri': 'orbit://surface/mcp-apps', 'formats': ['HTML snapshot'], 'readiness': {'detail': 'MCP Apps is off or proxy configuration unavailable.'}}]}})
                if path.endswith('/api/workspace/events'):
                    return reply({'workspace_id': workspace, 'events': [], 'cursor': 0, 'has_more': False, 'reset_required': False})
                return reply({'state': state, 'revision': 1, 'observed_revision': 1})
            page.route('**/api/**', api)
            page.goto(origin)
            page.get_by_role('button', name='Connect local host', exact=True).click()
            page.get_by_role('textbox', name='Host session token').fill('fixture-token')
            page.get_by_role('button', name='Unlock local host', exact=True).click()
            page.get_by_role('button', name='Open Start', exact=True).click()
            start = page.get_by_role('region', name='Start launcher')
            voice = start.get_by_role('button', name='Voice transcript', exact=True)
            expect(voice).to_contain_text('Voice model files missing')
            expect(voice).to_contain_text('Agent tools unsupported')
            expect(start.get_by_role('button', name='MCP Apps', exact=True)).to_contain_text('MCP Apps is off')
            expect(start.get_by_role('button', name='New Workbench window', exact=True)).to_have_count(0)
            page.keyboard.press('Escape')
            configured = True
            page.get_by_role('button', name='Open Start', exact=True).focus()
            page.keyboard.press('Control+k')
            palette = page.get_by_role('dialog', name='Workspace commands', exact=True)
            palette.get_by_role('combobox').fill('Voice transcript')
            expect(palette.get_by_role('option')).to_contain_text('Model files present; browser audio unknown')
            expect(palette.get_by_role('option')).to_contain_text('Checked ')
            expect(palette.get_by_role('option')).to_contain_text('Formats: audio')
            page.keyboard.press('Escape')
            page.get_by_role('button', name='Open Start', exact=True).click()
            expect(voice).to_contain_text('Model files present; browser audio unknown')
            voice.focus()
            configured = False
            page.evaluate("window.dispatchEvent(new Event('orbit-command-discovery'))")
            expect(voice).to_contain_text('Voice model files missing')
            expect(voice).to_be_focused()
            assert len(reads) >= 3, reads
            assert not errors, errors
            browser.close()
            print('PASS: real Start/palette shared detail, request-time refresh, optional setup, off-default Workbench')
    finally:
        server.terminate()
        server.wait(timeout=10)
