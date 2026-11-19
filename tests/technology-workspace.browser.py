"""Integrated technologies in a built, disposable full Orbit workspace.

Use --dist to reuse an isolated release build. No terminals or model-provider
requests are admitted. Evidence is synthetic and stays outside the repository.
"""
import argparse
import base64
from contextlib import contextmanager
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import importlib.util
import hashlib
import json
import os
import re
from pathlib import Path
import secrets
import shutil
import subprocess
import tempfile
import threading
import time
import traceback
import urllib.request
import uuid

from playwright.sync_api import expect, sync_playwright

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('release_acceptance', ROOT / 'tests/workspace-release-acceptance.browser.py')
release = importlib.util.module_from_spec(spec)
spec.loader.exec_module(release)
EVIDENCE = Path('/tmp/opencode/orbit-tech-acceptance')
SURFACES = {'search': 'Knowledge search', 'documents': 'Document library',
            'interactive-results': 'Interactive results', 'trace': 'Run traces'}
ROUTES = {'/api/search': 'status', '/api/documents': 'list',
          '/api/interactive-results': 'list', '/api/run-traces': 'list'}


@contextmanager
def fixture(args, dist, configured):
    calls = []

    class Gateway(BaseHTTPRequestHandler):
        def log_message(self, *_):
            pass

        def do_GET(self):
            calls.append(('GET', self.path))
            if self.path.startswith('/api/sessions?'):
                data = {'data': [{'id': 'release-chat', 'title': 'Synthetic selected conversation'},
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
            elif self.path == '/counter':
                self.send_response(200)
                self.send_header('Content-Type', 'text/html')
                self.end_headers()
                self.wfile.write(b'<h1>Synthetic browser target</h1><button onclick="this.textContent=\'Clicked exactly once\'">Increment</button>')
                return
            else:
                self.send_response(404)
                self.end_headers()
                return
            self.send_response(200)
            self.send_header('Content-Type', 'application/json')
            self.end_headers()
            self.wfile.write(json.dumps(data).encode())

        def do_POST(self):
            calls.append(('REFUSED POST', self.path))
            self.send_response(403)
            self.end_headers()

    gateway = ThreadingHTTPServer(('127.0.0.1', 0), Gateway)
    threading.Thread(target=gateway.serve_forever, daemon=True).start()
    try:
        with tempfile.TemporaryDirectory(prefix='orbit-tech-workspace-', dir='/tmp/opencode') as temporary:
            root = Path(temporary)
            for name in ('server', 'src', 'contracts', 'public', 'docs', 'scripts'):
                shutil.copytree(ROOT / name, root / name)
            shutil.copy2(ROOT / 'package.json', root / 'package.json')
            shutil.copytree(dist, root / 'dist')
            (root / 'node_modules').symlink_to(ROOT / 'node_modules', target_is_directory=True)
            for name in ('runtime', 'home', 'cwd', 'tmux', 'widget'):
                (root / name).mkdir(mode=0o700)
            origin = f'http://127.0.0.1:{release.free_port()}'
            gateway_origin = f'http://127.0.0.1:{gateway.server_port}'
            token, workspace = secrets.token_urlsafe(36), str(uuid.uuid4())
            panes, windows = [str(uuid.uuid4()) for _ in range(2)], [str(uuid.uuid4()) for _ in range(2)]
            state = {'version': 1, 'selected': windows[0], 'arc': 14, 'view': 'windows', 'monitors': [
                {'id': windows[i], 'name': ['Selected synthetic chat', 'Untouched synthetic chat'][i],
                 'diagonal': 32, 'aspect': '16:9', 'height': 0, 'distance': 0, 'pitch': 0, 'yaw': 0,
                 'offset': 0, 'fontSize': 19, 'frame': {'x': 10 + i * 580, 'y': 10, 'width': 560, 'height': 720, 'z': i + 1},
                 'layout': {'type': 'pane', 'pane': {'id': panes[i], 'kind': 'agent', 'url': ''}}}
                for i in range(2)]}
            env = {'PATH': os.environ['PATH'], 'HOME': str(root / 'home'),
                   'PORT': origin.rsplit(':', 1)[1], 'ORBIT_TOKEN': token,
                   'ORBIT_RUNTIME_DIR': str(root / 'runtime'), 'ORBIT_CWD': str(root / 'cwd'),
                   'ORBIT_TMUX_SOCKET': 'tech-' + str(uuid.uuid4()), 'ORBIT_TMUX_CONFIG': '/dev/null',
                   'TMUX_TMPDIR': str(root / 'tmux'), 'HERMES_API_URL': gateway_origin,
                   'HERMES_API_KEY': 'synthetic-only'}
            if configured:
                model = args.search_models / 'knowledge-index/model'
                if not model.is_dir():
                    raise RuntimeError('Search fixture expects knowledge-index/model under --search-models')
                # copytree copies the model's mode, but implicit parent creation
                # follows the runner umask. The feature root must be private too.
                (root / 'runtime/knowledge-index').mkdir(mode=0o700)
                shutil.copytree(model, root / 'runtime/knowledge-index/model')
            (root / 'widget/index.html').write_text('<!doctype html><title>Synthetic widget</title><h1>Unrelated synthetic widget</h1><label>Widget draft<input id="draft"></label>')
            manifest = json.loads(subprocess.check_output(['python3', str(root / 'scripts/plugin_publish.py'),
                str(root / 'widget'), '--id', 'technology-sentinel', '--version', '1.0.0',
                '--title', 'Synthetic identity sentinel', '--runtime', str(root / 'runtime')], env=env))
            suffix = 'configured' if configured else 'off'
            with (EVIDENCE / f'{args.renderer}-{suffix}-server.log').open('w+') as log:
                server = subprocess.Popen(['node', '--experimental-strip-types', 'server/index.mjs'],
                                          cwd=root, env=env, stdout=log, stderr=log)
                try:
                    deadline = time.monotonic() + 30
                    while time.monotonic() < deadline:
                        if server.poll() is not None:
                            log.seek(0)
                            raise RuntimeError(log.read())
                        try:
                            urllib.request.urlopen(origin + '/api/health', timeout=1).close()
                            break
                        except OSError:
                            time.sleep(.05)
                    else:
                        raise RuntimeError('Disposable full server readiness timeout')
                    yield dict(root=root, origin=origin, gateway_origin=gateway_origin,
                               token=token, workspace=workspace, panes=panes, windows=windows,
                               state=state, calls=calls, manifest=manifest)
                finally:
                    server.terminate()
                    try:
                        server.wait(timeout=15)
                    except subprocess.TimeoutExpired:
                        server.kill()
                        server.wait()
    finally:
        gateway.shutdown()
        gateway.server_close()


def journey(args, dist, configured=True):
    suffix = 'configured' if configured else 'off'
    result = {'renderer': args.renderer, 'capabilities': suffix, 'status': 'RUNNING', 'coverage': [],
              'dist': str(dist.resolve()), 'index_sha256': hashlib.sha256((dist / 'index.html').read_bytes()).hexdigest()}
    errors, external, console_errors = [], [], []
    with fixture(args, dist, configured) as f, sync_playwright() as pw:
        result['server_source_sha256'] = {name: hashlib.sha256((f['root'] / name).read_bytes()).hexdigest()
            for name in ('server/index.mjs', 'server/technology-assets.mjs', 'src/main.ts', 'src/host-surfaces.ts')}
        browser = pw.chromium.launch(executable_path=args.browser_executable, headless=True,
            args=['--no-sandbox', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'])
        context = browser.new_context(viewport={'width': 1600, 'height': 1100}, accept_downloads=True)
        context.add_init_script('''if(window===window.top&&!localStorage.getItem('orbit.workspace.id')){
localStorage.setItem('orbit.onboarding.v1','done');localStorage.setItem('orbit.onboarded','true');
localStorage.setItem('orbit.workspace.id',%s);localStorage.setItem('orbit.workspace.v1',%s);}'''
            % (json.dumps(f['workspace']), json.dumps(json.dumps(f['state']))))
        context.add_init_script('''window.__technologyCspViolations=[];
document.addEventListener('securitypolicyviolation',event=>{
if(/^https?:/.test(event.blockedURI)&&!event.blockedURI.startsWith(location.origin+'/'))
window.__technologyCspViolations.push({uri:event.blockedURI,directive:event.effectiveDirective});});''')
        allowed = [f['origin']]

        def guard(route):
            url = route.request.url
            if not any(url.startswith(origin + '/') for origin in allowed):
                external.append(url)
                route.abort()
            else:
                route.continue_()

        context.route('**/*', guard)
        page = context.new_page()
        page.on('pageerror', lambda error: errors.append(str(error)))
        page.on('console', lambda message: console_errors.append(message.text) if message.type == 'error' else None)
        page.on('dialog', lambda dialog: dialog.accept())
        headers = {'Origin': f['origin'], 'Authorization': 'Bearer ' + f['token']}

        def request(route, action, **fields):
            return context.request.post(f['origin'] + route, headers=headers,
                data={'action': action, 'workspace_id': f['workspace'], **fields})

        def api(route, action, **fields):
            response = request(route, action, **fields)
            assert response.ok, (route, response.status, response.text())
            return response.json()

        def snapshot():
            return api('/api/workspace', 'read')

        def surface(key):
            page.get_by_role('button', name='Open Start', exact=True).focus()
            page.keyboard.press('Control+k')
            palette = page.get_by_role('dialog', name='Workspace commands', exact=True)
            palette.get_by_role('combobox', name='Search workspace commands').fill(SURFACES[key])
            command = palette.get_by_role('option').filter(has_text='Tools ·')
            expect(command).to_have_count(1)
            command.click()
            host = page.locator(f'[data-host-surface="{key}"]')
            expect(host).to_be_visible(timeout=45000)
            return host

        def chat(i):
            return page.locator(f'.pane[data-pane-id="{f["panes"][i]}"]')

        def unlock():
            page.keyboard.press('Escape')
            page.get_by_role('button', name='Connect local host', exact=True).click()
            page.get_by_role('textbox', name='Host session token').fill(f['token'])
            def workspace_read(response):
                return (response.url == f['origin'] + '/api/workspace' and response.status == 200
                        and response.request.method == 'POST'
                        and (response.request.post_data_json or {}).get('action') == 'read'
                        and (response.request.post_data_json or {}).get('workspace_id') == f['workspace'])
            # The shared save label can switch to "Saved locally" after a layout
            # render. Require a real read and the browser's subsequent revision
            # acknowledgement instead of racing that transient presentation.
            with page.expect_response(workspace_read, timeout=20000) as connected:
                page.get_by_role('button', name='Unlock local host', exact=True).click()
            saved_workspace = connected.value.json()
            assert saved_workspace.get('state') and isinstance(saved_workspace.get('revision'), int)
            with page.expect_response(lambda response: workspace_read(response)
                    and (response.request.post_data_json or {}).get('observed_revision', -1) >= saved_workspace['revision'], timeout=20000):
                page.wait_for_function('ids=>ids.every(id=>Number.isSafeInteger(JSON.parse(sessionStorage.getItem(`orbit-hermes-chat:${id}`)||"{}").binding_revision))', arg=f['panes'])

        def record(coverage):
            result['coverage'].append(coverage)

        try:
            page.goto(f['origin'] + ('/?renderer=docking' if args.renderer == 'docking' else '/'), wait_until='networkidle')
            if args.renderer == 'docking':
                expect(page.locator('html')).to_have_attribute('data-docking-renderer', 'docking', timeout=30000)
            unlock()
            # Authenticate the real owner routes, including bad JSON and unknown fields.
            for route, action in ROUTES.items():
                body = {'action': action, 'workspace_id': f['workspace']}
                for bad_headers in ({'Origin': f['origin']}, {**headers, 'Authorization': 'Bearer wrong'},
                                    {**headers, 'Origin': 'https://forged.invalid'}):
                    response = context.request.post(f['origin'] + route, headers=bad_headers, data=body)
                    assert response.status == 403, (route, response.status, response.text())
                response = context.request.post(f['origin'] + route, headers={**headers, 'Content-Type': 'application/json'}, data='{')
                assert response.status == 400, (route, response.status, response.text())
                response = request(route, action, unexpected=True)
                assert response.status == 400, (route, response.status, response.text())
            record('real owner routes: missing/wrong token, forged origin, malformed JSON and unknown-field rejection')
            for index, session in enumerate(('release-chat', 'other-chat')):
                page.evaluate('(paneId)=>window.dispatchEvent(new CustomEvent("orbit-open-conversation-library",{detail:{paneId}}))', f['panes'][index])
                library = page.get_by_role('dialog', name='Conversation library', exact=True)
                library.get_by_label('Search conversations').fill(session)
                expect(library.locator('.conversation-library-row')).to_have_count(1)
                library.get_by_role('button', name='Open conversation in selected pane', exact=True).click()
                expect(chat(index).get_by_label('Hermes conversation', exact=True)).to_contain_text('Synthetic saved answer')
                chat(index).get_by_label('Message to Hermes', exact=True).fill(['Selected durable draft', 'Untouched durable draft'][index])
                expect(chat(index).locator('.conversation-draft-status')).to_contain_text('Draft saved on host', timeout=15000)
            record('real conversation library and independent durable drafts')
            if not configured:
                search = surface('search')
                expect(search.get_by_role('status')).to_contain_text('Semantic off', timeout=20000)
                record('absent search-model availability remains explicit')
            else:
                # Unrelated generated widget must survive all subsequent host features.
                api('/api/workspace', 'plugins_apply', base_revision=snapshot()['revision'],
                    operation_id=str(uuid.uuid4()), intent='Synthetic widget sentinel', operations=[
                        {'action': 'plugin_install', 'manifest': f['manifest'], 'config': {}},
                        {'action': 'plugin_enable', 'plugin_id': 'technology-sentinel'}])
                entry = f['manifest']['entry']
                expect(page.frame_locator(f'iframe[src*="{entry}"]').locator('#draft')).to_have_count(1)
                widget = next(frame for frame in page.frames if entry in frame.url)
                widget.locator('#draft').fill('Unrelated widget draft')
                widget.evaluate('window.__syntheticIdentity="original"')
                widget_records = snapshot()['state']['plugins']
                assert all(m['layout']['pane']['kind'] != 'terminal' for m in snapshot()['state']['monitors'])

                search = surface('search')
                expect(search.get_by_role('status')).to_contain_text('Semantic on', timeout=20000)
                search.get_by_label('Source title').fill('Synthetic astronomy')
                search.get_by_label('Source text', exact=True).fill('Observatory telescope studies distant planets. Synthetic acceptance source.')
                search.get_by_role('button', name='Add text', exact=True).click()
                expect(search.get_by_role('status')).to_contain_text('1 sources', timeout=180000)
                search.get_by_label('Search query').fill('planets')
                search.get_by_role('button', name='Search', exact=True).click()
                expect(search.get_by_label('Passage from Synthetic astronomy')).to_have_value(re.compile('Observatory'), timeout=180000)
                assert api('/api/search', 'search', query='planets', mode='hybrid')['semantic_used'] is True
                search_sources_before_reload = api('/api/search', 'list_sources')['sources']
                assert len(search_sources_before_reload) == 1
                record('real full-server local embeddings and keyword/hybrid source discovery')

                documents = surface('documents')
                documents.get_by_label('Document title').fill('Synthetic rich acceptance')
                documents.get_by_role('button', name='Create document', exact=True).click()
                rich = page.locator('[data-document-id]').filter(has=page.get_by_role('textbox', name='Rich document content'))
                expect(rich).to_have_count(1, timeout=45000)
                content = rich.get_by_role('textbox', name='Rich document content')
                content.fill('Durable synthetic rich document')
                rich.get_by_role('button', name='Save document', exact=True).click()
                expect(rich.locator('.document-status')).to_contain_text('Saved revision', timeout=20000)
                rich_id = rich.get_attribute('data-document-id')
                documents = surface('documents')
                documents.get_by_label('Document kind').select_option('scene')
                documents.get_by_label('Document title').fill('Synthetic canvas acceptance')
                documents.get_by_role('button', name='Create document', exact=True).click()
                canvas_host = page.locator('[data-document-id]').filter(has=page.locator('.canvas-island'))
                canvas = canvas_host.locator('.excalidraw__canvas.interactive')
                expect(canvas).to_be_visible(timeout=45000)
                canvas_host.locator('label:has([data-testid="toolbar-rectangle"])').click()
                expect(canvas_host.locator('[data-testid="toolbar-rectangle"]')).to_be_checked()
                # A native tool click may scroll the 800px engine island inside
                # its narrow owned viewport. Draw only where the real canvas is
                # visible inside that viewport and its assigned pane.
                visible = canvas.evaluate('''node=>{
const island=node.getRootNode().host, viewport=island.closest('.canvas-viewport'), pane=island.closest('.pane');
if(!viewport||!pane)throw Error('Canvas is missing its owned viewport or assigned pane');
const rects=[node,island,viewport,pane].map(n=>n.getBoundingClientRect());
const left=Math.max(0,...rects.map(r=>r.left)),top=Math.max(0,...rects.map(r=>r.top));
const right=Math.min(innerWidth,...rects.map(r=>r.right)),bottom=Math.min(innerHeight,...rects.map(r=>r.bottom));
return {left,top,width:right-left,height:bottom-top,scrollLeft:viewport.scrollLeft};}''')
                assert visible['width'] >= 80 and visible['height'] >= 240, visible
                start = {'x': visible['left'] + visible['width'] * .5,
                         'y': visible['top'] + min(170, visible['height'] * .4)}
                end = {'x': visible['left'] + visible['width'] * .8,
                       'y': visible['top'] + min(250, visible['height'] * .65)}
                for point in (start, end):
                    assert canvas.evaluate('''(node,point)=>{
let hit=document.elementFromPoint(point.x,point.y);
while(hit?.shadowRoot){const next=hit.shadowRoot.elementFromPoint(point.x,point.y);if(!next||next===hit)break;hit=next;}
return hit===node&&hit.matches('canvas.interactive');}''', point), ('Pointer misses assigned interactive canvas', point, visible)
                result['canvas_drawing'] = {'visible_intersection': visible, 'start': start, 'end': end}
                page.mouse.move(start['x'], start['y'])
                page.mouse.down()
                page.mouse.move(end['x'], end['y'], steps=12)
                page.mouse.up()
                canvas_host.get_by_role('button', name='Save document', exact=True).click()
                expect(canvas_host.locator('.document-status')).to_contain_text('Saved revision', timeout=20000)
                canvas_id = canvas_host.get_attribute('data-document-id')
                saved_canvas = api('/api/documents', 'read', document_id=canvas_id)
                assert any(e['type'] == 'rectangle' and not e.get('isDeleted') and e['width'] > 5 and e['height'] > 5
                           for e in json.loads(saved_canvas['data']['content'])['elements']), saved_canvas
                page.screenshot(path=str(EVIDENCE / f'{args.renderer}-canvas.png'))
                record('real Lexical edit/save and Excalidraw rectangle/save from Document library')

                interactive = surface('interactive-results')
                interactive.get_by_role('button', name='Load editable comparison', exact=True).click()
                field = interactive.locator('a2ui-surface textarea')
                expect(field).to_have_value('Compare tradeoffs before deciding.')
                field.fill('Synthetic selected tradeoff')
                interactive.get_by_role('button', name='Save result', exact=True).click()
                expect(interactive.get_by_role('status')).to_contain_text('Saved private result revision 1', timeout=20000)
                interactive.locator('.interactive-result-toolbar').get_by_role('button', name='Prepare summary', exact=True).click()
                transfer = page.get_by_role('dialog', name='Send text to a conversation', exact=True)
                recipient = transfer.locator(f'input[type="radio"][value="chat:{f["workspace"]}:{f["panes"][0]}"]')
                recipient.check()
                page.set_viewport_size({'width': 390, 'height': 844})
                assert transfer.evaluate('n=>n.scrollWidth<=n.clientWidth'), 'Transfer overflows at 390px'
                page.keyboard.press('Tab')
                assert page.evaluate('document.activeElement.closest("dialog")!==null')
                page.screenshot(path=str(EVIDENCE / f'{args.renderer}-recipient-390.png'))
                page.set_viewport_size({'width': 1600, 'height': 1100})
                expect(transfer.locator('.conversation-transfer-preview')).to_contain_text('Selected durable draft')
                expect(transfer.locator('.conversation-transfer-preview')).to_contain_text('Synthetic selected tradeoff')
                expect(chat(0).get_by_label('Message to Hermes', exact=True)).to_have_value('Selected durable draft')
                transfer.get_by_role('button', name='Insert into draft', exact=True).click()
                # Complete the single exact-draft review before shell shortcuts.
                expect(transfer).to_have_count(0)
                expect(chat(0).locator('.conversation-draft-status')).to_contain_text('Draft saved on host', timeout=15000)
                final_draft = chat(0).get_by_label('Message to Hermes', exact=True).input_value()
                assert 'Synthetic selected tradeoff' in final_draft and final_draft.startswith('Selected durable draft')
                expect(chat(1).get_by_label('Message to Hermes', exact=True)).to_have_value('Untouched durable draft')
                record('real A2UI edit/save and selected-recipient preview/confirmed durable draft transfer')

                traces = surface('trace')
                expect(traces.get_by_role('status')).to_contain_text('No locally observed traces yet.', timeout=20000)
                traces.get_by_role('button', name='Retention preview', exact=True).click()
                expect(traces.get_by_role('status')).to_contain_text('eligible for removal')
                record('real scoped trace API empty/retention state without dispatching inference')

                baseline = snapshot()
                expected_ids = release.identities(baseline['state'])
                page.evaluate('''()=>{window.__techNodes=[...document.querySelectorAll('[data-document-id]')];
window.__techEditors=window.__techNodes.map(n=>n.querySelector('.richdoc-content,.canvas-island'));}''')
                host_size = page.locator('.docking-root' if args.renderer == 'docking' else '.desktop-host').evaluate(
                    'h=>({width:Math.floor(h.getBoundingClientRect().width),height:Math.floor(h.getBoundingClientRect().height)})')
                api('/api/workspace', 'layout_apply', base_revision=baseline['revision'], operation_id=str(uuid.uuid4()),
                    intent='Synthetic integrated arrangement', operations=[{'action': 'arrange_windows',
                    **host_size, 'columns': 4, 'gap': 8}])
                revision = snapshot()['revision']
                deadline = time.monotonic() + 20
                while time.monotonic() < deadline:
                    if snapshot().get('observed_revision', -1) >= revision:
                        break
                    page.wait_for_timeout(100)
                else:
                    raise AssertionError('Browser did not acknowledge arranged workspace revision')
                assert release.identities(snapshot()['state']) == expected_ids
                assert page.evaluate('window.__techNodes.every(n=>n.isConnected)&&window.__techEditors.every(n=>n.isConnected)')
                assert widget.evaluate('window.__syntheticIdentity') == 'original'
                expect(widget.locator('#draft')).to_have_value('Unrelated widget draft')
                def widget_definition(records):
                    return [{key: value for key, value in record.items() if key != 'window'} for record in records]
                assert widget_definition(snapshot()['state']['plugins']) == widget_definition(widget_records)
                expect(chat(1).get_by_label('Message to Hermes', exact=True)).to_have_value('Untouched durable draft')
                page.screenshot(path=str(EVIDENCE / f'{args.renderer}-integrated.png'))
                record('arrange preserves document/editor nodes, pane/widget identities and unrelated drafts')
                result['pre_reload_csp_violations'] = page.evaluate('window.__technologyCspViolations')

                page.reload(wait_until='networkidle')
                unlock()
                search_recovery_started = time.monotonic()
                # Search deliberately retries on its ordinary ten-second poll.
                # Wait within a single 15s budget after unlock, without clicking
                # Refresh, selecting its window or remounting the restored pane.
                page.wait_for_function('''()=>{
const host=document.querySelector('[data-host-surface="search"]');
const status=host?.querySelector('.knowledge-status')?.textContent||'';
const error=host?.querySelector('.knowledge-error')?.textContent;
return /^1 sources.*Semantic on \\(local MiniLM\\)/.test(status)&&error!==undefined&&error.trim()===''
&&[...host.querySelectorAll('.knowledge-source strong')].some(n=>n.textContent==='Synthetic astronomy');
}''', timeout=15000)
                search = page.locator('[data-host-surface="search"]')
                expect(search.locator('.knowledge-error')).to_have_text('')
                expect(search.locator('.knowledge-source')).to_have_count(1)
                expect(search.locator('.knowledge-source strong')).to_have_text('Synthetic astronomy')
                result['automatic_search_recovery_seconds'] = round(time.monotonic() - search_recovery_started, 3)
                search_sources_after_reload = api('/api/search', 'list_sources')['sources']
                assert [{k: s[k] for k in ('source_id', 'title', 'content_sha256')} for s in search_sources_after_reload] == [
                    {k: s[k] for k in ('source_id', 'title', 'content_sha256')} for s in search_sources_before_reload]
                record('search automatically recovers within 15s on its ordinary 10s poll, clears locked error and restores the saved source/model status')
                expect(chat(0).get_by_label('Message to Hermes', exact=True)).to_have_value(final_draft, timeout=20000)
                expect(chat(1).get_by_label('Message to Hermes', exact=True)).to_have_value('Untouched durable draft', timeout=20000)
                expect(page.locator(f'[data-document-id="{rich_id}"] .richdoc-content')).to_contain_text('Durable synthetic rich document', timeout=45000)
                expect(page.locator(f'[data-document-id="{canvas_id}"] .excalidraw__canvas.interactive')).to_have_count(1, timeout=45000)
                assert api('/api/documents', 'read', document_id=canvas_id)['data'] == saved_canvas['data']
                assert api('/api/interactive-results', 'list')['items']
                interactive = surface('interactive-results')
                expect(interactive.locator('.interactive-result-library').get_by_role('button', name='Editable comparison', exact=True)).to_have_count(1, timeout=15000)
                interactive.get_by_role('button', name='Editable comparison', exact=True).click()
                expect(interactive.locator('a2ui-surface textarea')).to_have_value('Synthetic selected tradeoff')
                assert api('/api/agent', 'draft_read', profile_id='default', session_id='release-chat')['record']['draft'] == final_draft
                assert api('/api/agent', 'draft_read', profile_id='default', session_id='other-chat')['record']['draft'] == 'Untouched durable draft'
                assert release.identities(snapshot()['state']) == expected_ids
                record('reload restores pane URLs, rich/canvas data, saved results and both host drafts')
                page.screenshot(path=str(EVIDENCE / f'{args.renderer}-reload.png'))
            assert not errors, errors
            assert not external, external
            violations = page.evaluate('window.__technologyCspViolations')
            result['post_reload_csp_violations'] = violations
            assert not result.get('pre_reload_csp_violations'), result.get('pre_reload_csp_violations')
            assert not violations, violations
            assert not [message for message in console_errors if 'https://' in message and 'Content Security Policy' in message], console_errors
            assert not any(method == 'REFUSED POST' for method, _ in f['calls']), f['calls']
            result.update(status='PASS', pageerrors=errors, external_requests=external, gateway_posts=0,
                          gateway_get_count=len(f['calls']), console_errors=console_errors,
                          screenshots=[str(EVIDENCE / f'{args.renderer}-{name}.png') for name in
                              ('recipient-390', 'canvas', 'integrated', 'reload')]
                              if configured else [])
        except Exception:
            result.update(status='FAIL', failure=traceback.format_exc(), pageerrors=errors,
                          external_requests=external, console_errors=console_errors, gateway_calls=f['calls'],
                          gateway_posts=sum(method == 'REFUSED POST' for method, _ in f['calls']))
            try:
                result['current_page_csp_violations'] = page.evaluate('window.__technologyCspViolations')
                page.screenshot(path=str(EVIDENCE / f'{args.renderer}-{suffix}-failure.png'))
                (EVIDENCE / f'{args.renderer}-{suffix}-failure.txt').write_text(page.locator('body').inner_text())
            except Exception:
                pass
            raise
        finally:
            (EVIDENCE / f'{args.renderer}-{suffix}-result.json').write_text(json.dumps(result, indent=2) + '\n')
            context.close()
            browser.close()
    print('PASS', args.renderer, suffix, ':', '; '.join(result['coverage']))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--renderer', choices=('default', 'docking'), default='default')
    parser.add_argument('--dist', type=Path, help='Previously isolated production build; copied, never modified')
    parser.add_argument('--capabilities', choices=('both', 'configured', 'off'), default='both')
    parser.add_argument('--browser-executable', default=os.environ.get('ORBIT_BROWSER_EXECUTABLE', '/tmp/opencode/orbit-evolution-browsers/chromium-1208/chrome-linux64/chrome'))
    parser.add_argument('--search-models', type=Path, default=Path('/tmp/opencode/orbit-knowledge-model-test-20260930'))
    args = parser.parse_args()
    EVIDENCE.mkdir(parents=True, exist_ok=True)
    if not Path(args.browser_executable).is_file():
        parser.error('--browser-executable must name the isolated test Chromium')
    dist = args.dist
    if dist is None:
        build = subprocess.run(['node', 'scripts/isolated_build.mjs', '--json'], cwd=ROOT,
                               capture_output=True, text=True, check=True)
        dist = Path(json.loads(build.stdout)['destination'])
        (EVIDENCE / 'build.json').write_text(build.stdout)
    if dist.resolve() == (ROOT / 'dist').resolve():
        parser.error('--dist must be an isolated build, not the checkout served dist')
    if not (dist / 'index.html').is_file():
        parser.error('--dist must contain a completed production build')
    if args.capabilities in ('both', 'off'):
        journey(args, dist, configured=False)
    if args.capabilities in ('both', 'configured'):
        journey(args, dist, configured=True)


if __name__ == '__main__':
    main()
