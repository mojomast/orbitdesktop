"""Integrated release acceptance on an isolated built Orbit server.

Run with --renderer default|docking. All features share one disposable workspace;
only synthetic screenshots/results survive under /tmp/opencode. No inference,
terminal panes, owner runtime, environment files, or deployed server are used.
"""
import argparse
from contextlib import contextmanager
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import hashlib
import json
import os
from pathlib import Path
import secrets
import shutil
import socket
import subprocess
import tempfile
import threading
import time
import urllib.request
import uuid

from playwright.sync_api import expect, sync_playwright

ROOT = Path(__file__).resolve().parents[1]
EVIDENCE = Path('/tmp/opencode/orbit-release-acceptance')


def free_port():
    with socket.socket() as probe:
        probe.bind(('127.0.0.1', 0))
        return probe.getsockname()[1]


@contextmanager
def fixture(renderer):
    calls = []

    class Gateway(BaseHTTPRequestHandler):
        def log_message(self, *_):
            pass

        def do_GET(self):
            calls.append(self.path)
            if self.path.startswith('/api/sessions?'):
                data = {'data': [{'id': 'release-chat', 'title': 'Synthetic release conversation'},
                                 {'id': 'other-chat', 'title': 'Synthetic untouched conversation'}], 'has_more': False}
            elif '/messages' in self.path:
                data = {'data': [{'role': 'user', 'content': 'Synthetic previous question'},
                                 {'role': 'assistant', 'content': 'Synthetic saved answer'}]}
            elif self.path.startswith('/api/sessions/'):
                data = {'id': self.path.split('/')[-1], 'title': 'Synthetic saved conversation'}
            elif self.path == '/v1/capabilities':
                data = {'features': {}}
            elif self.path.startswith('/v1/runs'):
                data = {'data': [], 'runs': []}
            else:
                self.send_response(404)
                self.end_headers()
                return
            self.send_response(200)
            self.send_header('Content-Type', 'application/json')
            self.end_headers()
            self.wfile.write(json.dumps(data).encode())

        def do_POST(self):
            calls.append('REFUSED POST ' + self.path)
            self.send_response(403)
            self.end_headers()

    gateway = ThreadingHTTPServer(('127.0.0.1', 0), Gateway)
    threading.Thread(target=gateway.serve_forever, daemon=True).start()
    try:
        with tempfile.TemporaryDirectory(prefix='orbit-release-acceptance-', dir='/tmp/opencode') as temporary:
            root = Path(temporary)
            for name in ('server', 'src', 'contracts', 'public', 'docs', 'scripts'):
                shutil.copytree(ROOT / name, root / name)
            for name in ('package.json', 'package-lock.json', 'index.html', 'tsconfig.json', 'vite.config.js'):
                shutil.copy2(ROOT / name, root / name)
            (root / 'node_modules').symlink_to(ROOT / 'node_modules', target_is_directory=True)
            for name in ('runtime', 'home', 'cwd', 'widget'):
                (root / name).mkdir()
            env = {'PATH': os.environ['PATH'], 'HOME': str(root / 'home')}
            (root / 'widget/index.html').write_text('''<!doctype html><html lang="en"><meta charset="utf-8">
<title>Synthetic release widget</title><style>body{background:#14202b;color:#e5f0fa;font:20px sans-serif;padding:20px}input{font:inherit}</style>
<h1>Synthetic release widget</h1><p id="value"></p><label>Private widget draft <input id="draft"></label>
<script>const config=JSON.parse(decodeURIComponent(location.hash.replace(/^#orbit-config=/,''))||'{}');
document.getElementById('value').textContent='Minutes: '+config.minutes;</script></html>''')
            schema = {'fields': [{'key': 'minutes', 'type': 'number', 'title': 'Minutes', 'min': 1, 'max': 180, 'default': 25}]}
            (root / 'schema.json').write_text(json.dumps(schema))
            manifest = json.loads(subprocess.check_output([
                'python3', str(root / 'scripts/plugin_publish.py'), str(root / 'widget'),
                '--id', 'release-widget', '--version', '1.0.0', '--title', 'Synthetic release widget',
                '--config-schema', str(root / 'schema.json'), '--runtime', str(root / 'runtime')], env=env))
            subprocess.run(['node', str(ROOT / 'scripts/isolated_build.mjs'), '--source', str(root),
                            '--dest', str(root / 'dist'), '--allow-source-dist'], cwd=root,
                           env=env, check=True, capture_output=True)
            origin = f'http://127.0.0.1:{free_port()}'
            token, workspace = secrets.token_urlsafe(36), str(uuid.uuid4())
            windows, panes = [str(uuid.uuid4()) for _ in range(2)], [str(uuid.uuid4()) for _ in range(2)]
            state = {'version': 1, 'selected': windows[0], 'arc': 14, 'view': 'windows', 'monitors': [
                {'id': windows[i], 'name': ['Release chat', 'Untouched chat'][i], 'diagonal': 32,
                 'aspect': '16:9', 'height': 0, 'distance': 0, 'pitch': 0, 'yaw': 0, 'offset': 0,
                 'fontSize': 19, 'frame': {'x': 10 + i * 570, 'y': 10, 'width': 550, 'height': 720, 'z': i + 1},
                 'layout': {'type': 'pane', 'pane': {'id': panes[i], 'kind': 'agent', 'url': ''}}}
                for i in range(2)]}
            env.update({'PORT': origin.rsplit(':', 1)[1], 'ORBIT_TOKEN': token,
                        'ORBIT_RUNTIME_DIR': str(root / 'runtime'), 'ORBIT_CWD': str(root / 'cwd'),
                        'HERMES_API_URL': f'http://127.0.0.1:{gateway.server_port}', 'HERMES_API_KEY': 'synthetic-only'})
            with (EVIDENCE / f'{renderer}-server.log').open('w+') as log:
                server = subprocess.Popen(['node', '--experimental-strip-types', 'server/index.mjs'],
                                          cwd=root, env=env, stdout=log, stderr=log)
                try:
                    for _ in range(200):
                        if server.poll() is not None:
                            log.seek(0)
                            raise RuntimeError(log.read())
                        try:
                            urllib.request.urlopen(origin + '/api/health', timeout=1).close()
                            break
                        except OSError:
                            time.sleep(.05)
                    else:
                        raise RuntimeError('Disposable server readiness timeout')
                    yield {'origin': origin, 'token': token, 'workspace': workspace, 'state': state,
                           'panes': panes, 'windows': windows, 'manifest': manifest, 'calls': calls,
                           'source_sha256': {name: hashlib.sha256((root / name).read_bytes()).hexdigest()
                                              for name in ('src/plugins.ts', 'src/agent-chat.ts', 'src/main.ts', 'src/conversation-transfer.css')}}
                finally:
                    server.terminate()
                    try:
                        server.wait(timeout=10)
                    except subprocess.TimeoutExpired:
                        server.kill()
                        server.wait()
    finally:
        gateway.shutdown()
        gateway.server_close()


def identities(state):
    def leaves(node):
        if node['type'] == 'pane':
            return [node['pane']['id']]
        return leaves(node['first']) + leaves(node['second'])
    return {'windows': sorted(m['id'] for m in state['monitors']),
            'panes': sorted(p for m in state['monitors'] for p in leaves(m['layout'])),
            'plugins': sorted((p['manifest']['id'], p.get('instance_id', 'primary'), p['window']['id'])
                              for p in state.get('plugins', []))}


def acceptance(renderer):
    EVIDENCE.mkdir(parents=True, exist_ok=True)
    with fixture(renderer) as f, sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=True, args=[
            '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'])
        context = browser.new_context(viewport={'width': 1600, 'height': 1100})
        context.add_init_script('''if(window===window.top && !localStorage.getItem('orbit.workspace.id')) {
localStorage.setItem('orbit.onboarding.v1','done');localStorage.setItem('orbit.onboarded','true');
localStorage.setItem('orbit.workspace.id',%s);localStorage.setItem('orbit.workspace.v1',%s);}'''
                                % (json.dumps(f['workspace']), json.dumps(json.dumps(f['state']))))
        page = context.new_page()
        errors = []
        page.on('pageerror', lambda error: errors.append(str(error)))
        page.on('dialog', lambda dialog: dialog.accept())
        origin, token, workspace = f['origin'], f['token'], f['workspace']
        headers = {'Origin': origin, 'Authorization': 'Bearer ' + token}

        def api(action, route='/api/workspace', **fields):
            response = context.request.post(origin + route, headers=headers,
                                            data={'action': action, 'workspace_id': workspace, **fields})
            assert response.ok, response.text()
            return response.json()

        def snapshot():
            return api('read')

        def unlock():
            page.get_by_role('button', name='Connect local host', exact=True).click()
            page.get_by_role('textbox', name='Host session token').fill(token)
            page.get_by_role('button', name='Unlock local host', exact=True).click()
            expect(page.locator('.saved')).to_contain_text('Workspace connected', timeout=15000)
            page.wait_for_function('ids=>ids.every(id=>Number.isSafeInteger(JSON.parse(sessionStorage.getItem(`orbit-hermes-chat:${id}`)||"{}").binding_revision))', arg=f['panes'])

        def menu(name):
            opener = page.get_by_role('button', name='Open orbit menu', exact=True)
            if opener.get_attribute('aria-expanded') != 'true':
                opener.click()
            page.locator('.orbit-menu').get_by_role('button', name=name, exact=True).click()

        def chat(index):
            return page.locator(f'.pane[data-pane-id="{f["panes"][index]}"]')

        def host_draft(session):
            return api('draft_read', '/api/agent', profile_id='default', session_id=session)['record']['draft']

        page.goto(origin + ('/?renderer=docking' if renderer == 'docking' else '/'), wait_until='networkidle')
        if renderer == 'docking':
            page.wait_for_function("document.documentElement.dataset.dockingRenderer==='docking'")
        page.keyboard.press('Escape')
        unlock()
        # Reopen through the actual library and retain independent host drafts.
        for index, session in enumerate(('release-chat', 'other-chat')):
            page.evaluate('(paneId)=>window.dispatchEvent(new CustomEvent("orbit-open-conversation-library",{detail:{paneId}}))', f['panes'][index])
            library = page.get_by_role('dialog', name='Conversation library', exact=True)
            library.get_by_label('Search conversations').fill(session)
            expect(library.locator('.conversation-library-row')).to_have_count(1)
            library.get_by_role('button', name='Open conversation in selected pane', exact=True).click()
            expect(chat(index).get_by_label('Hermes conversation', exact=True)).to_contain_text('Synthetic saved answer')
            chat(index).get_by_label('Message to Hermes', exact=True).fill(['Release owner durable draft', 'Untouched owner draft'][index])
            expect(chat(index).locator('.conversation-draft-status')).to_contain_text('Draft saved on host', timeout=10000)
        assert host_draft('release-chat') == 'Release owner durable draft'
        assert host_draft('other-chat') == 'Untouched owner draft'

        # Actual publisher manifest, sandbox frame, duplicate UI, typed config editor.
        api('plugins_apply', base_revision=snapshot()['revision'], operation_id=str(uuid.uuid4()),
            intent='Synthetic release widget install', operations=[
                {'action': 'plugin_install', 'manifest': f['manifest'], 'config': {'minutes': 25}},
                {'action': 'plugin_enable', 'plugin_id': 'release-widget'}])
        entry = f['manifest']['entry']
        expect(page.frame_locator(f'iframe[src*="{entry}"]').locator('#value')).to_have_text('Minutes: 25')
        original = next(frame for frame in page.frames if entry in frame.url)
        original.locator('#draft').fill('Synthetic iframe draft survives layout')
        original.evaluate("window.__releaseContinuity='same-original-document'")
        original_config = snapshot()['state']['plugins'][0]['config']
        menu('Workspace plugins')
        manager = page.get_by_role('dialog', name='Workspace plugins', exact=True)
        manager.get_by_role('button', name='Duplicate plugin release-widget', exact=True).click()
        expect(manager.locator('.plugin-card[data-plugin-id="release-widget"]')).to_have_count(2)
        copy = snapshot()['state']['plugins'][1]
        label = 'release-widget instance ' + copy['instance_id']
        card = manager.locator(f'.plugin-card[data-instance-id="{copy["instance_id"]}"]')
        card.get_by_role('button', name='Configure plugin ' + label, exact=True).click()
        config = page.get_by_role('dialog', name='Configure ' + copy['window']['name'], exact=True)
        config.locator('.plugin-editor-row[data-key="minutes"] input[type="number"]').fill('7')
        config.get_by_role('button', name='Save configuration', exact=True).click()
        expect(config).to_have_count(0)
        assert snapshot()['state']['plugins'][0]['config'] == original_config
        assert snapshot()['state']['plugins'][1]['config']['minutes'] == 7
        expect(page.frame_locator('iframe[src*="%3A7%7D"]').locator('#value')).to_have_text('Minutes: 7')
        assert original.evaluate('window.__releaseContinuity') == 'same-original-document'
        page.keyboard.press('Escape')
        expect(manager).not_to_be_visible()

        # Full host Outputs window: real shelf + durable alias + explicit recipient.
        menu('Apps and outputs')
        outputs = page.locator('.outputs-view')
        expect(outputs).to_be_visible()
        outputs.locator('.outputs-search').fill('release-widget')
        expect(outputs.locator('.output-item')).to_have_count(1)
        item = outputs.locator('.output-item')
        item.get_by_role('button', name='Rename ', exact=False).click()
        page.get_by_role('textbox', name='Display alias', exact=True).fill('Release widget reference')
        page.get_by_role('button', name='Save alias', exact=True).click()
        expect(item.locator('.output-item-title')).to_have_text('Release widget reference')
        metadata = api('list', '/api/output-library')
        assert metadata['items'][entry]['alias'] == 'Release widget reference'
        before_transfer = chat(0).get_by_label('Message to Hermes', exact=True).input_value()
        item.get_by_role('button', name='Add a reference to Release widget reference in the conversation draft', exact=True).click()
        transfer = page.get_by_role('dialog', name='Send text to a conversation', exact=True)
        expect(transfer).to_contain_text('file contents were not fetched')
        radios = transfer.get_by_role('radio')
        assert radios.count() == 2
        # Pane identity, not current selection or widget focus, chooses the chat.
        assert len(set(radios.evaluate_all('nodes=>nodes.map(node=>node.value)'))) == 2
        assert len(set(radios.evaluate_all('nodes=>nodes.map(node=>node.getAttribute("aria-label"))'))) == 2
        recipient = transfer.locator(f'input[type="radio"][value="chat:{workspace}:{f["panes"][0]}"]')
        assert f['panes'][0] in recipient.get_attribute('aria-label')
        recipient.check()
        page.screenshot(path=str(EVIDENCE / f'{renderer}-recipient.png'))
        page.set_viewport_size({'width': 390, 'height': 844})
        assert transfer.evaluate('node=>node.scrollWidth<=node.clientWidth'), 'Recipient chooser overflows at 390px'
        assert radios.evaluate_all('nodes=>nodes.every(node=>node.getBoundingClientRect().width<40)'), 'Radio controls expanded into text columns'
        page.screenshot(path=str(EVIDENCE / f'{renderer}-recipient-small-screen.png'))
        page.set_viewport_size({'width': 1600, 'height': 1100})
        transfer.get_by_role('button', name='Insert into draft', exact=True).click()
        preview = page.get_by_role('dialog', name='Preview conversation draft', exact=True)
        expect(preview).to_contain_text(f['panes'][0])
        expect(preview).to_contain_text(before_transfer)
        expect(preview).to_contain_text('Release widget reference')
        expect(chat(0).get_by_label('Message to Hermes', exact=True)).to_have_value(before_transfer)
        expect(chat(1).get_by_label('Message to Hermes', exact=True)).to_have_value('Untouched owner draft')
        page.screenshot(path=str(EVIDENCE / f'{renderer}-draft-preview.png'))
        preview.get_by_role('button', name='Confirm append to conversation draft', exact=True).click()
        expect(chat(0).locator('.conversation-draft-status')).to_contain_text('Draft saved on host', timeout=10000)
        final_draft = chat(0).get_by_label('Message to Hermes', exact=True).input_value()
        assert final_draft.startswith(before_transfer) and entry in final_draft
        assert host_draft('release-chat') == final_draft
        assert host_draft('other-chat') == 'Untouched owner draft'
        page.screenshot(path=str(EVIDENCE / f'{renderer}-integrated.png'))

        # Save/apply one layout containing chats, widget siblings and host Outputs.
        baseline = snapshot()
        expected_ids = identities(baseline['state'])
        menu('Saved workspace layouts')
        layouts = page.get_by_role('dialog', name='Saved workspace layouts', exact=True)
        layouts.get_by_role('textbox', name='Layout name', exact=True).fill('Integrated synthetic layout')
        layouts.get_by_role('button', name='Save current workspace layout', exact=True).click()
        expect(layouts.get_by_label('Saved layout', exact=True)).to_contain_text('Integrated synthetic layout')
        api('layout_apply', base_revision=snapshot()['revision'], operation_id=str(uuid.uuid4()),
            intent='Synthetic geometry change', operations=[{'action': 'arrange_windows',
                'width': 1400, 'height': 950, 'columns': 2, 'gap': 8}])
        changed_revision = snapshot()['revision']
        layouts.get_by_role('button', name='Preview saved workspace layout', exact=True).click()
        apply = layouts.get_by_role('button', name='Apply saved workspace layout preview', exact=True)
        expect(apply).to_be_enabled()
        assert snapshot()['revision'] == changed_revision
        apply.click()
        expect(layouts.locator('.saved-layout-status')).to_contain_text('Saved revision', timeout=20000)
        assert identities(snapshot()['state']) == expected_ids
        assert original.evaluate('window.__releaseContinuity') == 'same-original-document'
        expect(original.locator('#draft')).to_have_value('Synthetic iframe draft survives layout')
        expect(chat(0).get_by_label('Message to Hermes', exact=True)).to_have_value(final_draft)
        page.screenshot(path=str(EVIDENCE / f'{renderer}-saved-layout.png'))
        page.keyboard.press('Escape')

        # Checkpoint comparison is read-only; restore returns same registrations/IDs.
        checkpoint_state = snapshot()
        api('checkpoint', base_revision=checkpoint_state['revision'], label='Integrated release checkpoint')
        changed = json.loads(json.dumps(checkpoint_state['state']))
        next(m for m in changed['monitors'] if m['id'] == f['windows'][0])['name'] = 'Changed release chat'
        changed['appearance'] = {**changed.get('appearance', {}), 'background': '#123456'}
        api('sync', base_revision=snapshot()['revision'], state=changed,
            client_features=['plugin-instances-v1', 'plugin-config-schema-v1'])
        menu('Workspace checkpoints')
        checkpoints = page.get_by_role('dialog', name='Workspace checkpoints', exact=True)
        revision = snapshot()['revision']
        checkpoints.get_by_role('button', name='Preview checkpoint Integrated release checkpoint', exact=True).click()
        comparison = checkpoints.get_by_role('region', name='Checkpoint comparison')
        expect(comparison).to_contain_text('Appearance')
        expect(comparison).to_contain_text('Release chat')
        assert snapshot()['revision'] == revision
        page.screenshot(path=str(EVIDENCE / f'{renderer}-checkpoint.png'))
        checkpoints.get_by_role('button', name='Restore previewed checkpoint', exact=True).click()
        expect(checkpoints.get_by_role('status')).to_contain_text('Layout restored', timeout=20000)
        restored = snapshot()['state']
        assert identities(restored) == expected_ids
        assert restored['plugins'] == checkpoint_state['state']['plugins']
        assert restored['monitors'][0]['name'] == 'Release chat'
        assert host_draft('release-chat') == final_draft
        page.keyboard.press('Escape')

        # New tab lacks sessionStorage: continuity must come from durable host state.
        page.close()
        page = context.new_page()
        page.on('pageerror', lambda error: errors.append(str(error)))
        page.goto(origin + ('/?renderer=docking' if renderer == 'docking' else '/'), wait_until='networkidle')
        unlock()
        expect(chat(0).get_by_label('Message to Hermes', exact=True)).to_have_value(final_draft, timeout=15000)
        expect(chat(1).get_by_label('Message to Hermes', exact=True)).to_have_value('Untouched owner draft', timeout=15000)
        assert identities(snapshot()['state']) == expected_ids
        expect(page.frame_locator('iframe[src*="%3A7%7D"]').locator('#value')).to_have_text('Minutes: 7')
        outputs = page.locator('.outputs-view')
        expect(outputs).to_contain_text('Release widget reference')
        page.reload(wait_until='networkidle')
        unlock()
        expect(chat(0).get_by_label('Message to Hermes', exact=True)).to_have_value(final_draft, timeout=15000)
        assert identities(snapshot()['state']) == expected_ids

        # Small-screen keyboard opening/closing and focus-return sanity.
        page.set_viewport_size({'width': 390, 'height': 844})
        page.locator('body').click(position={'x': 3, 'y': 3})
        page.keyboard.press('Control+Alt+p')
        manager = page.get_by_role('dialog', name='Workspace plugins', exact=True)
        expect(manager).to_be_visible()
        bounds = manager.bounding_box()
        assert bounds and bounds['x'] >= 0 and bounds['x'] + bounds['width'] <= 391
        page.keyboard.press('Tab')
        assert page.evaluate('document.activeElement.closest("dialog") !== null')
        page.screenshot(path=str(EVIDENCE / f'{renderer}-small-screen.png'))
        page.keyboard.press('Escape')
        expect(manager).not_to_be_visible()
        assert not errors, errors
        assert not any(call.startswith('REFUSED POST') for call in f['calls']), f['calls']
        result = {'renderer': renderer, 'status': 'PASS', 'workspace': workspace,
                  'source_sha256': f['source_sha256'],
                  'identities': expected_ids, 'pageerrors': errors, 'gateway_posts': 0,
                  'gateway_get_count': len(f['calls']), 'screenshots': [str(p) for p in EVIDENCE.glob(f'{renderer}-*.png')],
                  'coverage': ['library reopen', 'durable independent drafts', 'published schema widget',
                               'duplicate independent config and original iframe continuity',
                               'real host Outputs search/alias/reference recipient preview append',
                               'saved layout preview/apply identity and iframe continuity',
                               'checkpoint comparison/restore', 'new-tab and reload host continuity',
                               '390px keyboard dialog sanity']}
        (EVIDENCE / f'{renderer}-result.json').write_text(json.dumps(result, indent=2) + '\n')
        context.close()
        browser.close()
        print('PASS ' + renderer + ': ' + ', '.join(result['coverage']) + '; zero pageerrors/inference POSTs')


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--renderer', choices=('default', 'docking'), default='default')
    acceptance(parser.parse_args().renderer)
