"""Real Vite renderer for the published-output library with the real metadata
service. The workspace shelf response is mocked; `/api/output-library` is
forwarded to a real `server/output-library.mjs` process, so CAS, durability and
private-file behavior are exercised for real. No owner runtime, terminals,
providers, credentials or deployment is touched.
"""
import json
import shutil
import socket
import subprocess
import tempfile
import time
import urllib.error
import urllib.request
import uuid
from pathlib import Path

from playwright.sync_api import expect, sync_playwright

ROOT = Path(__file__).resolve().parents[1]
TOKEN = 'owner-token-' + 'f' * 32
HASH_A = 'a' * 24
HASH_B = 'b' * 24
MALICIOUS = '<img src=x onerror="window.__xss=1">Notes with <b>markup</b>'


def free_port():
    with socket.socket() as probe:
        probe.bind(('127.0.0.1', 0))
        return probe.getsockname()[1]


def post(url, payload, token=TOKEN, origin=None):
    data = json.dumps(payload).encode()
    request = urllib.request.Request(url, data=data, method='POST', headers={
        'Content-Type': 'application/json', 'Authorization': f'Bearer {token}',
        **({'Origin': origin} if origin else {}),
    })
    try:
        with urllib.request.urlopen(request, timeout=5) as response:
            return response.status, json.loads(response.read())
    except urllib.error.HTTPError as error:
        return error.code, json.loads(error.read())


with tempfile.TemporaryDirectory(prefix='orbit-output-library-', dir='/tmp/opencode') as temporary:
    root = Path(temporary)
    for name in ('src', 'contracts', 'public'):
        # Copy only files; keep the temporary tree disposable.
        shutil.copytree(ROOT / name, root / name)
    for name in ('index.html', 'package.json', 'tsconfig.json', 'vite.config.js'):
        shutil.copy2(ROOT / name, root / name)
    (root / 'node_modules').symlink_to(ROOT / 'node_modules', target_is_directory=True)

    workspace = str(uuid.uuid4())
    runtime = root / 'runtime'
    runtime.mkdir()
    vite_port = free_port()
    real_port = free_port()
    origin = f'http://127.0.0.1:{vite_port}'
    real_origin = f'http://127.0.0.1:{real_port}'

    (root / 'ol-server.mjs').write_text(f"""
import http from 'node:http';
import {{createOutputLibrary}} from {json.dumps(str(ROOT / 'server' / 'output-library.mjs'))};
const [port, runtime, token, origin, workspace] = process.argv.slice(2);
const lib = createOutputLibrary({{
  root: runtime, token, port: Number(port), devOrigins: [origin],
  reply: (res, status, data) => {{ res.writeHead(status, {{'Content-Type': 'application/json'}}); res.end(JSON.stringify(data)); }},
  workspaceRead: id => {{ if (id !== workspace) throw Object.assign(Error('missing'), {{code: 'ENOENT'}}); return {{id}}; }},
}});
http.createServer((req, res) => {{
  if (req.url === '/api/output-library') return lib.handle(req, res);
  res.writeHead(404, {{'Content-Type': 'application/json'}}); res.end('{{}}');
}}).listen(Number(port), '127.0.0.1', () => console.log('ready'));
""")

    (root / 'ol-test.html').write_text("""<!doctype html><html><body>
<div id="host"></div>
<script type="module">
import { connectWorkspace } from '/src/workspace-sync.ts';
import { mountOutputLibrary } from '/src/output-library.ts';
import { registerConversationRecipient } from '/src/conversation-transfer.ts';
const state = { version: 1, selected: 'sel', arc: 14, view: 'windows', monitors: [] };
window.__token = '';
window.__xss = 0;
window.__log = [];
window.__deliveries = [];
registerConversationRecipient({ id: 'test-chat', title: 'Test chat', receive: delivery => { window.__deliveries.push(delivery); return { accepted: true }; } });
connectWorkspace(() => state, () => {}, () => window.__token, message => window.__log.push(message));
window.__mount = host => mountOutputLibrary(host, () => window.__token);
</script></body></html>""")

    shelf_items = [
        {'title': MALICIOUS, 'url': f'/apps/notes-{HASH_A}/index.html', 'kind': 'app/report'},
        {'title': 'Quarterly report', 'url': f'/apps/reports-{HASH_B}/index.html', 'kind': 'app/report'},
        {'title': 'Raw data', 'url': f'/apps/reports-{HASH_B}/data.csv', 'kind': 'output'},
    ]
    REPORTS_INDEX = f'/apps/reports-{HASH_B}/index.html'
    RAW_URL = f'/apps/reports-{HASH_B}/data.csv'
    state = {'version': 1, 'selected': 'sel', 'arc': 14, 'view': 'windows', 'monitors': []}
    revision = 1
    shelf_calls = []
    pending_shelf = []
    hold_shelf = False
    metadata_calls = []
    pending_metadata = []
    hold_metadata = False
    errors = []

    real = subprocess.Popen(
        ['node', '--experimental-strip-types', str(root / 'ol-server.mjs'),
         str(real_port), str(runtime), TOKEN, origin, workspace],
        cwd=root, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    vite = subprocess.Popen([str(ROOT / 'node_modules/.bin/vite'), '--host', '127.0.0.1',
                             '--port', str(vite_port), '--strictPort'], cwd=root,
                            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)

    def wait_for(url, timeout=30):
        deadline = time.time() + timeout
        while time.time() < deadline:
            try:
                urllib.request.urlopen(url, timeout=1).close()
                return
            except urllib.error.HTTPError:
                return
            except OSError:
                time.sleep(.1)
        raise RuntimeError(f'readiness timeout for {url}')

    try:
        wait_for(real_origin + '/api/output-library')
        wait_for(origin + '/ol-test.html')
        with sync_playwright() as playwright:
            browser = playwright.chromium.launch(headless=True, args=['--no-sandbox',
                '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'])
            context = browser.new_context(viewport={'width': 1400, 'height': 1000})
            context.add_init_script(
                "try { localStorage.setItem('orbit.workspace.id',"
                + json.dumps(workspace) + "); } catch {} window.__xss=0;")
            page = context.new_page()
            page.on('pageerror', lambda error: errors.append(str(error)))

            def reply(route, data, status=200):
                route.fulfill(status=status, content_type='application/json', body=json.dumps(data))

            def forward_metadata(route):
                body = route.request.post_data_json or {}
                if body.get('action') == 'set':
                    metadata_calls.append(body)
                    if hold_metadata:
                        pending_metadata.append(route)
                        return
                headers = {'Authorization': route.request.headers.get('authorization', ''),
                           'Origin': origin, 'Content-Type': 'application/json'}
                response = context.request.post(real_origin + '/api/output-library',
                                                headers=headers, data=route.request.post_data or '')
                route.fulfill(status=response.status,
                              headers={'Content-Type': 'application/json'}, body=response.body())

            def api(route):
                if '/api/output-library' in route.request.url:
                    return forward_metadata(route)
                if '/api/workspace/events' in route.request.url:
                    return reply(route, {'workspace_id': workspace, 'events': [], 'cursor': 0,
                                         'has_more': False, 'reset_required': False})
                body = route.request.post_data_json or {}
                if body.get('action') == 'shelf':
                    shelf_calls.append({'auth': route.request.headers.get('authorization'), 'body': body})
                    if hold_shelf:
                        pending_shelf.append(route)
                        return
                    return reply(route, {'items': shelf_items})
                return reply(route, {'state': state, 'revision': revision, 'observed_revision': revision,
                                     'app_versions': {}, 'recovery_policy': {'held': False, 'generation': 0}})

            page.route('**/api/**', api)
            page.goto(origin + '/ol-test.html')
            page.evaluate("token => { window.__token = token; }", TOKEN)
            page.evaluate("window.__view = window.__mount(document.getElementById('host'))")
            expect(page.locator('.output-item')).to_have_count(3)
            expect(page.locator('.outputs-list')).to_contain_text('Quarterly report')

            # Malicious title is rendered as text, never interpreted as markup.
            assert page.evaluate('window.__xss') == 0
            assert page.evaluate("document.querySelector('.outputs-list img')===null")
            assert page.evaluate("document.querySelector('.output-item-title').textContent.includes('onerror')")
            assert shelf_calls[-1]['auth'] == f'Bearer {TOKEN}'

            # Search, type and pinned filters.
            page.locator('.outputs-search').fill('quarterly')
            expect(page.locator('.output-item')).to_have_count(1)
            page.locator('.outputs-search').fill('')
            page.locator('.outputs-kind').select_option('output')
            expect(page.locator('.output-item')).to_have_count(1)
            expect(page.locator('.outputs-list')).to_contain_text('Raw data')
            page.locator('.outputs-kind').select_option('all')
            expect(page.locator('.output-item')).to_have_count(3)

            # Rename persists through the real service.
            page.get_by_role('button', name='Rename Quarterly report').click()
            page.get_by_role('textbox', name='Display alias').fill('Q3 report')
            page.get_by_role('button', name='Save alias').click()
            expect(page.locator('.output-item-title', has_text='Q3 report')).to_have_count(1)
            status, listing = post(real_origin + '/api/output-library',
                                   {'action': 'list', 'workspace_id': workspace}, origin=origin)
            assert status == 200 and listing['items'][REPORTS_INDEX]['alias'] == 'Q3 report'
            revision = listing['revision']

            # Pin and tag.
            page.get_by_role('button', name='Pin Raw data').click()
            page.get_by_role('button', name='Edit tags for Raw data').click()
            page.get_by_role('textbox', name='Tags, comma separated').fill('data, finance')
            page.get_by_role('button', name='Save tags').click()
            expect(page.locator('.output-item-tag', has_text='finance')).to_have_count(1)
            page.locator('.outputs-pinned').check()
            expect(page.locator('.output-item')).to_have_count(1)
            expect(page.locator('.outputs-list')).to_contain_text('Raw data')
            page.locator('.outputs-pinned').uncheck()
            expect(page.locator('.output-item')).to_have_count(3)

            # Reload: metadata is durable and reloaded from the real service.
            page.reload()
            page.evaluate("token => { window.__token = token; }", TOKEN)
            page.evaluate("window.__view = window.__mount(document.getElementById('host'))")
            expect(page.locator('.output-item')).to_have_count(3)
            expect(page.locator('.output-item-title', has_text='Q3 report')).to_have_count(1)
            expect(page.locator('.output-item[data-pinned="true"]')).to_have_count(1)
            expect(page.locator('.output-item-tag', has_text='data')).to_have_count(1)

            # CAS conflict: an out-of-band change invalidates the loaded revision,
            # the draft is retained, and a retry against the fresh revision sticks.
            _, listing = post(real_origin + '/api/output-library',
                              {'action': 'list', 'workspace_id': workspace}, origin=origin)
            revision = listing['revision']
            post(real_origin + '/api/output-library',
                 {'action': 'set', 'workspace_id': workspace, 'url': REPORTS_INDEX,
                  'base_revision': revision, 'patch': {'pinned': True}}, origin=origin)
            page.get_by_role('button', name='Rename Q3 report').click()
            page.get_by_role('textbox', name='Display alias').fill('Conflict draft')
            page.get_by_role('button', name='Save alias').click()
            expect(page.locator('.outputs-status', has_text='draft is kept')).to_have_count(1)
            assert page.get_by_role('textbox', name='Display alias').input_value() == 'Conflict draft'
            page.get_by_role('button', name='Save alias').click()
            expect(page.locator('.output-item-title', has_text='Conflict draft')).to_have_count(1)
            _, listing = post(real_origin + '/api/output-library',
                              {'action': 'list', 'workspace_id': workspace}, origin=origin)
            assert listing['items'][REPORTS_INDEX]['alias'] == 'Conflict draft'

            # Exact-resource keying: the same logical app under a different content
            # hash is a distinct resource and does not inherit this alias.
            assert len([key for key in listing['items'] if key.startswith('/apps/reports-')]) == 2

            # Duplicate saves are blocked while a submit is in flight: two rapid
            # submits produce exactly one metadata request and one committed value.
            before = len(metadata_calls)
            page.get_by_role('button', name='Rename Conflict draft').click()
            page.get_by_role('textbox', name='Display alias').fill('Double save')
            page.evaluate("""() => {
              const form = document.querySelector('dialog.hermes-tools-dialog form');
              form.dispatchEvent(new Event('submit', {cancelable: true, bubbles: true}));
              form.dispatchEvent(new Event('submit', {cancelable: true, bubbles: true}));
            }""")
            expect(page.locator('.output-item-title', has_text='Double save')).to_have_count(1)
            page.wait_for_timeout(200)
            assert len(metadata_calls) == before + 1, metadata_calls[before:]

            # Sandboxed preview keeps the reviewed sandbox and never receives a token.
            page.get_by_role('button', name='Preview Raw data').click()
            frame = page.locator('dialog iframe')
            expect(frame).to_have_attribute('sandbox', 'allow-scripts allow-forms allow-downloads')
            assert frame.get_attribute('src') == f'/apps/reports-{HASH_B}/data.csv'
            assert TOKEN not in frame.get_attribute('src')
            page.get_by_role('button', name='Close Raw data').click()

            # Send a bounded explicit reference through the real transfer dialog;
            # the owner must pick a conversation and nothing is auto-sent.
            page.locator('.output-item', has_text='Raw data').get_by_role('button', name='Add a reference to Raw data').click()
            transfer = page.locator('dialog.conversation-transfer')
            expect(transfer).to_be_visible()
            expect(transfer.locator('.conversation-transfer-preview')).to_contain_text('Published output reference: Raw data')
            expect(transfer.locator('.conversation-transfer-preview')).to_contain_text('file contents were not fetched')
            assert len(transfer.locator('.conversation-transfer-preview').inner_text()) <= 600
            transfer.get_by_role('radio', name='Test chat').check()
            transfer.get_by_role('button', name='Insert into draft').click()
            expect(transfer).to_have_count(0)
            expect(page.locator('.outputs-status', has_text='Reference inserted into the conversation draft')).to_have_count(1)
            deliveries = page.evaluate('window.__deliveries')
            assert len(deliveries) == 1
            assert deliveries[0]['source'] == 'outputs'
            assert deliveries[0]['title'] == 'Raw data'
            assert 'file contents were not fetched' in deliveries[0]['text']
            assert len(deliveries[0]['text']) <= 600

            # Late save after disposal: the dialog is tracked and closed by dispose,
            # controls are disabled during submit, and a late response writes nothing.
            _, listing = post(real_origin + '/api/output-library',
                              {'action': 'list', 'workspace_id': workspace}, origin=origin)
            assert listing['items'][REPORTS_INDEX]['alias'] == 'Double save'
            page.get_by_role('button', name='Rename Double save').click()
            page.get_by_role('textbox', name='Display alias').fill('Late alias')
            hold_metadata = True
            before = len(metadata_calls)
            page.get_by_role('button', name='Save alias').click()
            page.wait_for_timeout(300)
            assert pending_metadata, 'no in-flight metadata request to hold'
            assert len(metadata_calls) == before + 1, 'submitting controls must disable a second save'
            assert page.get_by_role('button', name='Save alias').is_disabled()
            page.evaluate("window.__view.dispose()")
            expect(page.locator('.outputs-view')).to_have_count(0)
            expect(page.locator('dialog.hermes-tools-dialog')).to_have_count(0)
            for route in pending_metadata:
                try:
                    reply(route, {'ok': False, 'code': 'conflict', 'error': 'late conflict', 'revision': 999, 'items': {}})
                except Exception:
                    pass
            pending_metadata.clear()
            hold_metadata = False
            page.wait_for_timeout(200)
            assert page.locator('.outputs-view').count() == 0
            assert page.locator('dialog.hermes-tools-dialog').count() == 0
            _, listing = post(real_origin + '/api/output-library',
                              {'action': 'list', 'workspace_id': workspace}, origin=origin)
            assert listing['items'][REPORTS_INDEX]['alias'] == 'Double save', 'late save must not commit or overwrite'

            # Abort/disposal: a disposed view never repopulates from a late response.
            page.evaluate("window.__view.dispose()")
            expect(page.locator('.outputs-view')).to_have_count(0)
            hold_shelf = True
            page.evaluate("window.__view = window.__mount(document.getElementById('host'))")
            expect(page.locator('.outputs-view')).to_have_count(1)
            page.get_by_role('button', name='Refresh published outputs').click()
            page.wait_for_timeout(400)
            assert pending_shelf, 'no in-flight shelf request to abort'
            page.evaluate("window.__view.dispose()")
            expect(page.locator('.outputs-view')).to_have_count(0)
            for route in pending_shelf:
                try:
                    reply(route, {'items': [{'title': 'Late result', 'url': f'/apps/late-{HASH_A}/index.html', 'kind': 'app/report'}]})
                except Exception:
                    pass
            pending_shelf.clear()
            hold_shelf = False
            page.wait_for_timeout(300)
            assert page.locator('.outputs-view').count() == 0
            assert page.evaluate("document.body.textContent.includes('Late result')") is False
            assert not errors, errors
            browser.close()
            print('PASS output library: real metadata service, exact-resource keys, reload persistence, filters, textContent titles, CAS drafts, duplicate-save and late-save disposal, sandbox preview, conversation reference and abort/disposal')
    finally:
        vite.terminate()
        real.terminate()
        try:
            vite.wait(timeout=10)
        except Exception:
            vite.kill()
        try:
            real.wait(timeout=10)
        except Exception:
            real.kill()
