"""Real narrow Dockview groups, normal shell/palette and reviewed host modules.

Disposable Vite copy and synthetic owner API; no owner runtime/provider/terminal.
Checks actual pointer hits without force-clicking and live iframe/Lexical identity.
"""
import copy
import json
from pathlib import Path
import shutil
import socket
import subprocess
import tempfile
import time
import urllib.request
import uuid
from playwright.sync_api import expect, sync_playwright

ROOT = Path(__file__).resolve().parents[1]
with tempfile.TemporaryDirectory(prefix='orbit-docking-narrow-', dir='/tmp/opencode') as temporary:
    root = Path(temporary)
    for name in ('src', 'contracts', 'server', 'scripts', 'docs', 'public'):
        shutil.copytree(ROOT / name, root / name)
    for name in ('index.html', 'package.json', 'package-lock.json', 'tsconfig.json', 'vite.config.js'):
        shutil.copy2(ROOT / name, root / name)
    (root / 'node_modules').symlink_to(ROOT / 'node_modules', target_is_directory=True)
    with socket.socket() as probe:
        probe.bind(('127.0.0.1', 0))
        port = probe.getsockname()[1]
    origin = f'http://127.0.0.1:{port}'
    workspace, document_id = str(uuid.uuid4()), str(uuid.uuid4())
    windows, panes = ([str(uuid.uuid4()) for _ in range(13)] for _ in range(2))
    state = {'version': 1, 'selected': windows[6], 'arc': 14, 'view': 'windows', 'monitors': []}
    for i in range(13):
        url = {1: 'https://narrow-identity.invalid/', 3: f'orbit://document/{document_id}',
               6: 'orbit://surface/interactive-results', 7: 'orbit://surface/voice'}.get(i, 'orbit://welcome')
        name = {1: 'Narrow iframe', 3: 'Narrow editor', 6: 'Narrow card', 7: 'Adjacent voice'}.get(i, f'Neighbor {i}')
        state['monitors'].append({'id': windows[i], 'name': name, 'diagonal': 32, 'aspect': '16:9',
            'height': 0, 'distance': 0, 'pitch': 0, 'yaw': 0, 'offset': 0, 'fontSize': 16,
            'frame': {'x': 20, 'y': 20, 'width': 600, 'height': 700, 'z': i},
            'layout': {'type': 'pane', 'pane': {'id': panes[i], 'kind': 'browser', 'url': url}}})
    content = json.dumps({'root': {'children': [{'children': [], 'direction': None, 'format': '',
        'indent': 0, 'type': 'paragraph', 'version': 1, 'textFormat': 0, 'textStyle': ''}],
        'direction': None, 'format': '', 'indent': 0, 'type': 'root', 'version': 1}})
    data = {'kind': 'richtext', 'format': 'lexical', 'content': content}
    metadata = {'id': document_id, 'title': 'Narrow editor', 'kind': 'richtext', 'format': 'lexical',
                'revision': 1, 'updated_at': '2026-09-30T00:00:00Z'}
    result = {'id': 'fixture-result', 'title': 'Editable comparison', 'revision': 1, 'pinned': False,
              'source': {'id': 'fixture', 'version': '1'}, 'user_values': {}, 'messages': [
                  {'version': 'v0.9', 'createSurface': {'surfaceId': 'narrow',
                   'catalogId': 'https://a2ui.org/specification/v0_9/catalogs/basic/catalog.json'}},
                  {'version': 'v0.9', 'updateComponents': {'surfaceId': 'narrow', 'components': [
                      {'id': 'root', 'component': 'Text', 'text': 'Narrow card loaded'}]}}]}
    revision, reads = 1, []
    server = subprocess.Popen([str(ROOT / 'node_modules/.bin/vite'), '--host', '127.0.0.1',
                               '--port', str(port), '--strictPort'], cwd=root,
                              stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    try:
        for _ in range(150):
            if server.poll() is not None:
                raise RuntimeError('Disposable Vite exited')
            try:
                urllib.request.urlopen(origin, timeout=1).close()
                break
            except OSError:
                time.sleep(.1)
        else:
            raise RuntimeError('Disposable Vite readiness timeout')
        with sync_playwright() as playwright:
            browser = playwright.chromium.launch(headless=True, args=['--use-gl=angle',
                '--use-angle=swiftshader', '--enable-unsafe-swiftshader'])
            context = browser.new_context(viewport={'width': 1600, 'height': 1100})
            context.add_init_script("if(window===window.top){localStorage.setItem('orbit.onboarding.v1','done');"
                "localStorage.setItem('orbit.workspace.id',%s);if(!localStorage.getItem('orbit.workspace.v1'))"
                "localStorage.setItem('orbit.workspace.v1',%s);}" % (json.dumps(workspace), json.dumps(json.dumps(state))))
            context.route('https://narrow-identity.invalid/**', lambda route: route.fulfill(content_type='text/html',
                body='<input id="draft"><script>window.documentNonce=crypto.randomUUID()</script>'))
            page = context.new_page()
            errors, navigations = [], []
            page.on('pageerror', lambda error: errors.append(str(error)))
            page.on('framenavigated', lambda frame: navigations.append(frame.url) if frame != page.main_frame else None)

            def api(route):
                global state, revision
                body = route.request.post_data_json or {}
                action, path = body.get('action'), route.request.url.split('?')[0]
                def reply(value):
                    route.fulfill(content_type='application/json', body=json.dumps(value))
                if path.endswith('/api/auth'):
                    return reply({'ok': True})
                if path.endswith('/api/technology-capabilities'):
                    return reply({'ok': True, 'browser_copilot': False, 'mcp_apps': False})
                if path.endswith('/api/workspace/events'):
                    return reply({'workspace_id': workspace, 'events': [], 'cursor': 0, 'has_more': False, 'reset_required': False})
                if path.endswith('/api/interactive-results'):
                    if action == 'list':
                        return reply({'ok': True, 'items': [result]})
                    reads.append(body)
                    return reply({'ok': True, 'record': result})
                if path.endswith('/api/documents'):
                    return reply({'ok': True, 'document': metadata, 'data': data, 'revision': 1, 'data_schema_version': 1})
                if action == 'sync':
                    state = copy.deepcopy(body['state'])
                    revision += 1
                return reply({'state': state, 'revision': revision, 'observed_revision': revision})

            page.route('**/api/**', api)

            def unlock():
                page.get_by_role('button', name='Connect local host', exact=True).click()
                page.get_by_role('textbox', name='Host session token').fill('fixture-token')
                page.get_by_role('button', name='Unlock local host', exact=True).click()

            def select(name):
                page.get_by_role('button', name='Open Start', exact=True).focus()
                page.keyboard.press('Control+k')
                palette = page.get_by_role('dialog', name='Workspace commands', exact=True)
                palette.get_by_role('combobox', name='Search workspace commands').fill(name)
                palette.get_by_role('option').filter(has_text=name).first.click()

            def bounds():
                geometry = page.evaluate('''() => [...document.querySelectorAll('.docking-surfaces>.monitor')].map(m=>{
                  const own=m.getBoundingClientRect(), slot=document.querySelector(`[data-docking-window="${m.dataset.monitorId}"]`).getBoundingClientRect();
                  return {id:m.dataset.monitorId,width:own.width,slot:slot.width,left:own.left,expectedLeft:slot.left};})''')
                assert len(geometry) == 13, geometry
                for item in geometry:
                    assert abs(item['width'] - item['slot']) < 1, item
                    assert abs(item['left'] - item['expectedLeft']) < 1, item
                assert geometry[6]['width'] < 140, geometry[6]
                assert page.locator(f'[data-document-id="{document_id}"]').evaluate('''node=>{
                  const r=node.closest('.monitor').getBoundingClientRect();
                  const target=document.elementFromPoint(r.right+3,r.top+r.height/2);
                  return !target || !node.contains(target);
                }'''), 'Document view captures adjacent group pixels'

            def open_card():
                select('Narrow card')
                button = page.locator('[data-host-surface="interactive-results"]').get_by_role('button', name='Editable comparison', exact=True)
                expect(button).to_be_visible()
                button.scroll_into_view_if_needed()
                assert button.evaluate('''node=>{const r=node.getBoundingClientRect();return node.contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2));}'''), 'Adjacent group intercepts saved result'
                count = len(reads)
                button.click()
                for _ in range(100):
                    if len(reads) == count + 1:
                        break
                    page.wait_for_timeout(50)
                page.wait_for_function('document.querySelector(".interactive-results").textContent.includes("Rendered with official A2UI")')
                assert len(reads) == count + 1

            def snapshot():
                frame = page.frame_locator(f'[data-pane-id="{panes[1]}"] iframe')
                frame.locator('#draft').fill('retained iframe draft')
                editor = page.locator(f'[data-document-id="{document_id}"] [contenteditable="true"]')
                expect(editor).to_be_visible()
                # Owner typing via DOM input is independent of viewport clipping;
                # all pointer reachability assertions use ordinary click/hit tests.
                editor.fill('retained editor draft')
                page.evaluate('''ids=>{window.narrowIdentity={iframe:document.querySelector(`[data-pane-id="${ids[0]}"] iframe`),
                  editor:document.querySelector(`[data-document-id="${ids[1]}"] [contenteditable="true"]`)};}''', [panes[1], document_id])
                return frame.locator('#draft').evaluate('node=>window.documentNonce'), len(navigations)

            def continuity(identity):
                assert page.evaluate('''() => narrowIdentity.iframe.isConnected && narrowIdentity.editor.isConnected &&
                  document.querySelector('[contenteditable="true"]')===narrowIdentity.editor &&
                  narrowIdentity.editor.textContent==='retained editor draft' ''')
                frame = page.frame_locator(f'[data-pane-id="{panes[1]}"] iframe')
                assert frame.locator('#draft').input_value() == 'retained iframe draft'
                assert frame.locator('#draft').evaluate('node=>window.documentNonce') == identity[0]
                assert len(navigations) == identity[1], navigations
                assert not errors, errors

            page.goto(origin + '/?renderer=docking')
            page.wait_for_function('document.documentElement.dataset.dockingRenderer==="docking" && document.querySelectorAll(".docking-surfaces>.monitor").length===13')
            unlock()
            bounds()
            identity = snapshot()
            open_card()
            continuity(identity)
            page.set_viewport_size({'width': 1400, 'height': 1100})
            page.wait_for_timeout(200)
            bounds()
            open_card()
            continuity(identity)
            page.reload()
            page.wait_for_function('document.querySelectorAll(".docking-surfaces>.monitor").length===13')
            unlock()
            bounds()
            identity = snapshot()
            open_card()
            continuity(identity)
            select('Narrow editor')
            page.get_by_label('Docking layout controls', exact=True).click()
            toolbar = page.get_by_role('toolbar', name='Docking layout', exact=True)
            toolbar.get_by_label('Docking window', exact=True).select_option(windows[3])
            toolbar.get_by_role('button', name='Float window', exact=True).click()
            continuity(identity)
            toolbar.get_by_role('button', name='Return to grid', exact=True).click()
            page.get_by_label('Docking layout controls', exact=True).click()
            open_card()
            continuity(identity)
            print('PASS narrow docking: 13 assigned bounds, real adjacent-pane hit testing, resize/reload/unlock/palette, iframe and Lexical continuity through float/return')
            context.close()
            browser.close()
    finally:
        server.terminate()
        try:
            server.wait(timeout=5)
        except subprocess.TimeoutExpired:
            server.kill()
            server.wait(timeout=5)
