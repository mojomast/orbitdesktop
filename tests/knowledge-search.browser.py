"""Disposable Vite surface + real authenticated HTTP service, synthetic content only.
No owner runtime, providers or terminal processes. Workspace sync is a fixture response.
"""
import json
import shutil
import socket
import subprocess
import tempfile
import time
import urllib.request
import urllib.error
import uuid
from pathlib import Path
from playwright.sync_api import sync_playwright, expect

ROOT = Path(__file__).resolve().parents[1]
TOKEN = 'synthetic-owner-token-' + 'f' * 32

def port():
    with socket.socket() as s:
        s.bind(('127.0.0.1', 0))
        return s.getsockname()[1]

def wait(url):
    deadline = time.time() + 30
    while time.time() < deadline:
        try:
            urllib.request.urlopen(url, timeout=1).close()
            return
        except urllib.error.HTTPError:
            return
        except OSError:
            time.sleep(.1)
    raise RuntimeError('Readiness timeout: ' + url)

with tempfile.TemporaryDirectory(prefix='knowledge-browser-', dir='/tmp/opencode') as tmp:
    root = Path(tmp)
    shutil.copytree(ROOT / 'src', root / 'src')
    shutil.copytree(ROOT / 'contracts', root / 'contracts')
    (root / 'node_modules').symlink_to(ROOT / 'node_modules', target_is_directory=True)
    (root / 'package.json').write_text('{"type":"module"}')
    runtime = root / 'runtime'
    runtime.mkdir(mode=0o700)
    vite_port, api_port = port(), port()
    origin = f'http://127.0.0.1:{vite_port}'
    api_origin = f'http://127.0.0.1:{api_port}'
    workspace = str(uuid.uuid4())
    state = {'version': 1, 'selected': 'sel', 'arc': 14, 'view': 'windows', 'monitors': []}
    (root / 'vite.config.js').write_text('export default ' + json.dumps({'server': {'proxy': {'/api': {'target': api_origin, 'changeOrigin': True}}}}))
    (root / 'server.mjs').write_text(f"""
import http from 'node:http';
import {{createKnowledgeSearch,createKnowledgeSearchRoute}} from {json.dumps(str(ROOT/'server/knowledge-index.mjs'))};
const service=createKnowledgeSearch({{root:{json.dumps(str(runtime))},workspaceRead:id=>{{if(id!=={json.dumps(workspace)})throw Error('gone');return {{id}};}}}});
const reply=(res,status,body)=>{{res.writeHead(status,{{'Content-Type':'application/json'}});res.end(JSON.stringify(body));}};
const route=createKnowledgeSearchRoute({{service,token:{json.dumps(TOKEN)},port:{api_port},devOrigins:[{json.dumps(origin)}],reply}});
const server=http.createServer((req,res)=>{{
 if(req.url==='/api/search')return route(req,res);
 if(req.url==='/api/workspace')return reply(res,200,{{ok:true,workspace_id:{json.dumps(workspace)},revision:1,state:{json.dumps(state)}}});
 if(req.url==='/api/workspace/events')return reply(res,200,{{ok:true,events:[],cursor:0}});
 reply(res,404,{{ok:false}});
}}).listen({api_port},'127.0.0.1');
process.on('SIGTERM',async()=>{{server.close();await service.close();process.exit();}});
""")
    (root / 'test.html').write_text(f"""<!doctype html><html><body><div id="host" style="width:420px;height:900px"></div><script type="module">
import {{connectWorkspace}} from '/src/workspace-sync.ts';
import {{mountSearchSurface}} from '/src/search-surface.ts';
import {{registerConversationRecipient}} from '/src/conversation-transfer.ts';
import {{createAgentChat}} from '/src/agent-chat.ts';
window.deliveries=[];
connectWorkspace(()=>({json.dumps(state)}),()=>{{}},()=>{json.dumps(TOKEN)},()=>{{}});
const chat=document.createElement('div');document.body.append(chat);createAgentChat(chat,'research-chat',()=>{json.dumps(TOKEN)});
window.surface=mountSearchSurface(document.querySelector('#host'),()=>{json.dumps(TOKEN)});
</script></body></html>""")
    api = subprocess.Popen(['node', str(root / 'server.mjs')], cwd=root, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
    vite = subprocess.Popen([str(ROOT/'node_modules/.bin/vite'),'--host','127.0.0.1','--port',str(vite_port),'--strictPort'],cwd=root,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
    try:
        wait(api_origin + '/api/search')
        wait(origin + '/test.html')
        with sync_playwright() as p:
            browser = p.chromium.launch(headless=True, args=['--no-sandbox'])
            context = browser.new_context(accept_downloads=True)
            context.add_init_script("localStorage.setItem('orbit.workspace.id'," + json.dumps(workspace) + ');')
            # Conflict recovery must work without the search surface's 10-second poll.
            context.add_init_script("const originalInterval=window.setInterval; window.setInterval=(fn,ms,...args)=>ms===10000?0:originalInterval(fn,ms,...args);")
            page = context.new_page()
            agent_calls = []
            def agent_fixture(route):
                body = route.request.post_data_json
                agent_calls.append(body['action'])
                action = body['action']
                if action == 'shared_chat': data = {'state': {**body.get('initial', {}), 'binding_revision': 1}}
                elif action == 'draft_read': data = {'record': {'revision': 0, 'draft': '', 'metadata': {}}}
                elif action == 'draft_write': data = {'record': {'revision': 1, 'draft': body.get('text', ''), 'metadata': {}}}
                elif action == 'profiles': data = {'profiles': [{'id': 'default', 'label': 'Default'}]}
                elif action == 'sessions': data = {'sessions': []}
                else: data = {}
                route.fulfill(status=200, content_type='application/json', body=json.dumps(data))
            page.route('**/api/agent', agent_fixture)
            errors = []
            page.on('pageerror',lambda e: errors.append(str(e)))
            page.goto(origin + '/test.html')
            expect(page.locator('.knowledge-status')).to_contain_text('Semantic off')
            malicious = '<img src=x onerror="window.xss=1"> Observatory telescope studies distant planets.'
            page.get_by_label('Source title').fill('Public astronomy')
            page.get_by_label('Source text',exact=True).fill(malicious)
            page.get_by_role('button',name='Add text',exact=True).click()
            expect(page.locator('.knowledge-status')).to_contain_text('1 sources')
            page.get_by_label('Search query').fill('planets')
            page.get_by_role('button',name='Search',exact=True).click()
            expect(page.get_by_label('Passage from Public astronomy')).to_have_value(malicious)
            assert page.locator('img').count() == 0
            assert page.evaluate('window.xss || 0') == 0
            result = page.locator('.knowledge-result')
            result.get_by_role('button',name='Open exact snapshot').click()
            expect(page.get_by_label('Exact source snapshot')).to_have_text(malicious)
            with page.expect_download() as info:
                page.get_by_role('button',name='Download original bytes').click()
            assert Path(info.value.path()).read_bytes() == malicious.encode()
            passage = page.get_by_label('Passage from Public astronomy')
            expect(page.get_by_role('button',name='Send message to Hermes',exact=True)).to_be_enabled(timeout=15000)
            passage.evaluate('(node)=>node.setSelectionRange(node.value.indexOf("Observatory"), node.value.indexOf("Observatory")+11)')
            result.get_by_role('button',name='Preview passage into draft').click()
            expect(page.get_by_label('Text to transfer')).to_contain_text('Observatory\n\n[Knowledge included-excerpt]')
            page.get_by_role('radio').check()
            page.get_by_role('button',name='Insert into draft',exact=True).click()
            expect(page.get_by_role('dialog')).to_have_count(0)
            composer = page.get_by_label('Message to Hermes', exact=True)
            delivered = composer.input_value()
            assert delivered.startswith('Observatory\n\n[Knowledge included-excerpt]')
            assert 'Text SHA256:' in delivered and 'Content SHA256:' in delivered and 'UTF-16 offsets:' in delivered
            assert 'submit' not in agent_calls and 'run' not in agent_calls
            # Final source revalidation occurs after the owner has reviewed the exact appended draft.
            result.get_by_role('button',name='Preview passage into draft').click()
            page.get_by_role('radio').check()
            expect(page.get_by_label('Text to transfer')).to_contain_text(delivered)
            page.route('**/api/search', lambda route: route.fulfill(status=404,content_type='application/json',body='{"ok":false,"code":"not_found"}') if route.request.post_data_json.get('action') == 'get_source' else route.continue_())
            page.get_by_role('button',name='Insert into draft',exact=True).click()
            expect(page.locator('.conversation-transfer-status')).to_contain_text('could not accept')
            expect(composer).to_have_value(delivered)
            page.get_by_role('button',name='Cancel',exact=True).click()
            page.unroute('**/api/search')
            # An HTTP/CAS failure preserves input and exposes the current conflict.
            page.route('**/api/search',lambda route: route.fulfill(status=409,content_type='application/json',body=json.dumps({'ok':False,'code':'conflict','current':{'consent_generation':99}})) if route.request.post_data_json.get('action') == 'ingest_text' else route.continue_())
            page.get_by_label('Source text',exact=True).fill('Preserve this draft on conflict')
            page.get_by_role('button',name='Add text',exact=True).click()
            expect(page.get_by_role('alert')).to_contain_text('Conflict')
            expect(page.get_by_label('Source text',exact=True)).to_have_value('Preserve this draft on conflict')
            page.unroute('**/api/search')
            page.get_by_label('Choose source file').set_input_files({'name':'public.txt','mimeType':'text/plain','buffer':b'Garden roses are blooming.'})
            page.get_by_role('button',name='Add chosen file',exact=True).click()
            expect(page.locator('.knowledge-status')).to_contain_text('2 sources')
            page.get_by_text('Sources and retention',exact=True).click()
            page.on('dialog',lambda d:d.accept())
            # Another owner request advances the real generation while this UI still holds zero.
            advanced = context.request.post(api_origin + '/api/search', headers={'Authorization':f'Bearer {TOKEN}', 'Origin':origin}, data={'action':'reset_index','workspace_id':workspace,'confirm':True,'base_consent_generation':0})
            assert advanced.status == 200, advanced.text()
            page.get_by_label('Source title').fill('Pending title retained')
            page.get_by_label('Choose source file').set_input_files({'name':'pending.txt','mimeType':'text/plain','buffer':b'Pending unsubmitted bytes.'})
            delete_requests, refresh_attempts = [], []
            hold_refresh = True
            def conflict_refresh(route):
                body = route.request.post_data_json
                if body.get('action') == 'delete_source':
                    delete_requests.append(body)
                if hold_refresh and body.get('action') in ('status','list_sources'):
                    refresh_attempts.append(body['action'])
                    route.fulfill(status=503,content_type='application/json',body=json.dumps({'ok':False,'code':'unavailable'}))
                else:
                    route.continue_()
            page.route('**/api/search',conflict_refresh)
            with page.expect_response(lambda r: r.url.endswith('/api/search') and r.request.post_data_json.get('action') == 'delete_source') as conflict_response:
                page.locator('.knowledge-source').filter(has_text='Public astronomy').get_by_role('button',name='Remove source').click()
            assert conflict_response.value.status == 409
            expect(page.get_by_role('alert')).to_contain_text('reported generation and your edits are retained')
            expect(page.locator('.knowledge-search')).not_to_have_attribute('aria-busy','true')
            assert sorted(refresh_attempts) == ['list_sources','status']
            expect(page.get_by_label('Source title')).to_have_value('Pending title retained')
            expect(page.get_by_label('Source text',exact=True)).to_have_value('Preserve this draft on conflict')
            expect(page.get_by_label('Search query')).to_have_value('planets')
            assert page.get_by_label('Choose source file').evaluate('(node)=>node.files[0].name') == 'pending.txt'
            hold_refresh = False
            page.locator('.knowledge-source').filter(has_text='Public astronomy').get_by_role('button',name='Remove source').click()
            expect(page.locator('.knowledge-status')).to_contain_text('1 sources')
            assert [body['base_consent_generation'] for body in delete_requests] == [0,1]
            page.unroute('**/api/search',conflict_refresh)
            page.get_by_label('Search query').fill('planets')
            page.get_by_role('button',name='Search',exact=True).click()
            expect(page.get_by_label('Search results')).to_contain_text('No matching passages')
            def inspect_busy_actions(route):
                if (route.request.post_data_json or {}).get('action') == 'reset_index':
                    assert page.get_by_role('button',name='Purge ingested snapshots').is_disabled(), 'Busy actions must not silently accept then drop another operation'
                route.continue_()
            page.route('**/api/search',inspect_busy_actions)
            page.get_by_role('button',name='Rebuild derived index').click()
            expect(page.locator('.knowledge-status')).to_contain_text('1 sources')
            page.get_by_role('button',name='Purge ingested snapshots').click()
            expect(page.locator('.knowledge-status')).to_contain_text('0 sources')
            page.unroute('**/api/search',inspect_busy_actions)
            assert not errors, errors
            page.evaluate('window.surface.dispose()')
            expect(page.get_by_role('region',name='Local source search')).to_have_count(0)
            browser.close()
        print('PASS real browser: text/file ingest, FTS, exact citation/download, selected draft preview, immediate conflict-generation adoption with failed metadata refresh and retained inputs, delete/reset/purge, dispose')
    finally:
        vite.terminate(); api.terminate()
        vite.wait(timeout=10); api.wait(timeout=10)
