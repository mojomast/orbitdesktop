"""Real Lexical/Excalidraw + desktop + private Node API in a disposable runtime.

No owner runtime, terminals, models or mocked editor engines. HTTP interception
delays real module/workspace responses for source fences and drops genuinely
committed create/save responses to exercise recovery and exact receipts.
"""
import copy
import hashlib
import json
import os
import re
import secrets
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
from browser_workspace import wait_for_workspace_connection

ROOT = Path(__file__).resolve().parents[1]


def free_port():
    with socket.socket() as s:
        s.bind(('127.0.0.1', 0))
        return s.getsockname()[1]


def post(origin, token, path, body):
    req = urllib.request.Request(origin + path, data=json.dumps(body).encode(), headers={
        'Content-Type': 'application/json', 'Origin': origin, 'Authorization': 'Bearer ' + token})
    try:
        with urllib.request.urlopen(req, timeout=20) as response:
            return response.status, json.load(response)
    except urllib.error.HTTPError as e:
        return e.code, json.load(e)


def run_fixture(kind='richtext'):
    with tempfile.TemporaryDirectory(prefix='orbit-documents-browser-', dir='/tmp/opencode') as temporary:
        root = Path(temporary)
        for name in ('src', 'server', 'contracts', 'public', 'docs'):
            shutil.copytree(ROOT / name, root / name)
        for name in ('index.html', 'package.json', 'tsconfig.json'):
            shutil.copy2(ROOT / name, root / name)
        # Observe the real engine's imperative API only in this disposable copy.
        # No substitute editor or production debug hook: this lets us assert the
        # native-control/React boundary before another browser task flushes it.
        canvas_source = root / 'src/canvas-editor.ts'
        canvas_text = canvas_source.read_text()
        api_hook = 'api=instance;font.disabled=readonly;'
        assert canvas_text.count(api_hook) == 1
        canvas_source.write_text(canvas_text.replace(api_hook,
            'api=instance;(window as any).__fixtureCanvasApi=instance;font.disabled=readonly;'))
        (root / 'node_modules').symlink_to(ROOT / 'node_modules', target_is_directory=True)
        for name in ('home', 'cwd', 'runtime', 'tmux', 'dist'):
            (root / name).mkdir()
        # Vite fixture serves exact pinned local fonts, never a network CDN.
        for family in ('Assistant', 'ComicShanns', 'Excalifont', 'Lilita', 'Nunito', 'Xiaolai'):
            shutil.copytree(ROOT / 'node_modules/@excalidraw/excalidraw/dist/prod/fonts' / family,
                            root / 'public/vendor/excalidraw-0.18.1/fonts' / family)
        shutil.copy2(ROOT / 'docs/licenses/EXCALIDRAW_FONTS.txt', root / 'public/vendor/excalidraw-0.18.1/EXCALIDRAW_FONTS.txt')
        api_port, port = free_port(), free_port()
        origin, api_origin = f'http://127.0.0.1:{port}', f'http://127.0.0.1:{api_port}'
        (root / 'vite.config.js').write_text("import {canvasFontPolicyPlugin} from './server/documents-canvas-assets.mjs'; const config=" + json.dumps({'server': {
            'host': '127.0.0.1', 'port': port, 'strictPort': True, 'fs': {'allow': [str(root), str(ROOT), str((ROOT / 'node_modules').resolve())]},
            'proxy': {'/api': {'target': api_origin, 'ws': True, 'changeOrigin': True}}}}) + '; config.plugins=[canvasFontPolicyPlugin()]; export default config;')
        token = secrets.token_urlsafe(32)
        env = {**os.environ, 'PORT': str(api_port), 'ORBIT_TOKEN': token,
               'ORBIT_RUNTIME_DIR': str(root / 'runtime'), 'ORBIT_CWD': str(root / 'cwd'),
               'HOME': str(root / 'home'), 'ORBIT_DEV_ORIGINS': origin,
               'ORBIT_TMUX_SOCKET': 'documents-' + str(uuid.uuid4()),
               'ORBIT_TMUX_CONFIG': '/dev/null', 'TMUX_TMPDIR': str(root / 'tmux')}
        log = open(root / 'server.log', 'w+')
        server = subprocess.Popen(['node', '--experimental-strip-types', 'server/index.mjs'], cwd=root, env=env, stdout=log, stderr=log)
        vite = subprocess.Popen([str(ROOT / 'node_modules/.bin/vite')], cwd=root, env=env, stdout=log, stderr=log)
        try:
            for _ in range(200):
                if server.poll() is not None or vite.poll() is not None:
                    log.flush(); raise AssertionError((root / 'server.log').read_text())
                try:
                    urllib.request.urlopen(origin, timeout=1).close()
                    post(api_origin, token, '/api/auth', {})
                    break
                except OSError:
                    time.sleep(.1)
            else:
                raise AssertionError('Fixture readiness timeout')
            w, document_id, second_id, pane_id, second_pane, spare_pane = [str(uuid.uuid4()) for _ in range(6)]
            monitors = []
            for i, (pid, url) in enumerate([(pane_id, 'orbit://document/' + document_id),
                                           (second_pane, 'orbit://document/' + second_id), (spare_pane, 'orbit://welcome')]):
                monitors.append({'id': str(uuid.uuid4()), 'name': 'Primary document' if i == 0 else 'Independent pane',
                    'diagonal': 32, 'aspect': '16:9', 'height': 0, 'distance': 0, 'pitch': 0, 'yaw': 0,
                    'offset': 0, 'fontSize': 19, 'frame': {'x': 35 + i * 40, 'y': 30 + i * 40,
                    'width': 1000, 'height': 740, 'z': 3 - i}, 'layout': {'type': 'pane', 'pane': {'id': pid, 'kind': 'browser', 'url': url}}})
            state = {'version': 1, 'selected': monitors[0]['id'], 'arc': 14, 'view': 'windows', 'monitors': monitors}

            def api(path, body):
                return post(api_origin, token, path, {'workspace_id': w, **body})

            status, result = api('/api/workspace', {'action': 'sync', 'base_revision': 0,
                'state': state, 'operation_id': str(uuid.uuid4()), 'intent': 'Seed isolated document fixture'})
            assert status == 200, result
            for did, doc_kind in [(document_id, kind), (second_id, 'richtext')]:
                status, result = api('/api/documents', {'action': 'create', 'document_id': did,
                    'kind': doc_kind, 'title': 'Synthetic ' + doc_kind, 'op_id': str(uuid.uuid4()), 'intent': 'Create fixture'})
                assert status == 200, result
            assert post(api_origin, 'wrong-token', '/api/documents', {'action': 'list', 'workspace_id': w})[0] == 403
            with sync_playwright() as p:
                browser = p.chromium.launch(headless=True, args=['--no-sandbox', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'])
                context = browser.new_context(viewport={'width': 1600, 'height': 1050}, accept_downloads=True)
                context.add_init_script(f"localStorage.setItem('orbit.workspace.id',{json.dumps(w)});localStorage.setItem('orbit.workspace.v1',JSON.stringify({json.dumps(state)}));localStorage.setItem('orbit.onboarding.v1','done');localStorage.setItem('orbit.menu.pinned','true');")
                page = context.new_page()
                errors, outside_requests, excluded_font_requests = [], [], []
                page.on('pageerror', lambda e: errors.append(str(e)))
                page.on('request', lambda r: outside_requests.append(r.url) if not r.url.startswith(origin) and not r.url.startswith('blob:') and not r.url.startswith('data:') else None)
                page.on('request', lambda r: excluded_font_requests.append(r.url) if any('/fonts/' + family + '/' in r.url for family in ('Liberation', 'Cascadia', 'Virgil')) else None)
                try:
                    page.goto(origin)
                except Exception as e:
                    raise AssertionError((root / 'server.log').read_text()[-7000:]) from e

                def unlock():
                    page.keyboard.press('Escape')
                    page.get_by_role('button', name='Connect local host', exact=True).click()
                    page.get_by_role('textbox', name='Host session token').fill(token)
                    page.get_by_role('button', name='Unlock local host', exact=True).click()
                    wait_for_workspace_connection(page)

                unlock()
                host = page.locator(f'[data-document-id="{document_id}"]')
                expect(host).to_be_visible(timeout=45000)
                expect(page.locator(f'[data-document-id="{second_id}"] .richdoc-content')).to_have_count(1, timeout=45000)
                # The real shell must carry source freshness through its first
                # lazy library import, not only check the button's old binding.
                lazy_library = []
                def hold_document_library(route):
                    response = route.fetch()
                    page.evaluate('window.__resultSourceCurrent=false')
                    lazy_library.append(route.request.url)
                    route.fulfill(response=response)
                page.route('**/src/document-library.ts*', hold_document_library)
                page.evaluate('''async()=>{const {requestDocumentFromResult,textDocument}=await import('/src/document-artifacts.ts');window.__resultSourceCurrent=true;window.__staleLazyResult=requestDocumentFromResult(JSON.stringify({document:{title:'Stale lazy source',...textDocument('Never create this')}}),()=>window.__resultSourceCurrent);}''')
                deadline = time.monotonic() + 20
                while not lazy_library and time.monotonic() < deadline:
                    page.wait_for_timeout(50)
                assert lazy_library, 'Expected a held real document library module import'
                page.unroute('**/src/document-library.ts*', hold_document_library)
                assert page.evaluate('window.__staleLazyResult')['status'] == 'rejected'
                expect(page.get_by_role('dialog', name='Create document from reviewed content', exact=True)).to_have_count(0)
                assert len(api('/api/documents', {'action':'list'})[1]['documents']) == 2
                if kind == 'richtext':
                    content = host.get_by_role('textbox', name='Rich document content')
                    expect(content).to_be_visible(timeout=45000)
                    content.click(); page.keyboard.type('# Durable heading'); page.keyboard.press('Enter')
                    page.keyboard.type('Synthetic rich document'); page.keyboard.press('Enter')
                    page.keyboard.type('- list item'); page.keyboard.press('Enter')
                    host.get_by_role('button', name='Code block', exact=True).click()
                    page.keyboard.type('const orbit = "private";')
                else:
                    canvas = host.locator('.excalidraw__canvas.interactive')
                    try:
                        expect(canvas).to_be_visible(timeout=30000)
                    except AssertionError as e:
                        raise AssertionError({'errors': errors, 'host': host.inner_text(), 'html': host.inner_html()[:1500], 'log': (root / 'server.log').read_text()[-2500:]}) from e
                    host.locator('label:has([data-testid="toolbar-rectangle"])').click()
                    box = canvas.bounding_box(); assert box
                    page.mouse.move(box['x'] + 260, box['y'] + 230); page.mouse.down()
                    page.mouse.move(box['x'] + 470, box['y'] + 360, steps=12); page.mouse.up()
                    font_boundary = host.get_by_label('Canvas text font', exact=True).evaluate('''select=>{
                      const result=[];
                      for(const id of [7,8,6,5]){
                        select.value=String(id);select.dispatchEvent(new Event('change',{bubbles:true}));
                        result.push({selected:id,actual:window.__fixtureCanvasApi.getAppState().currentItemFontFamily});
                      }
                      return result;
                    }''')
                    assert all(row['selected'] == row['actual'] for row in font_boundary), font_boundary
                    # The real picker must expose only the four admitted IDs,
                    # and each offered family must draw real editable text.
                    for i, (family_id, family_name) in enumerate(((5, 'Excalifont'), (6, 'Nunito'), (7, 'Lilita One'), (8, 'Comic Shanns'))):
                        canvas.click(position={'x': 800, 'y': 520})
                        host.locator('label:has([data-testid="toolbar-text"])').click()
                        expect(host.locator('[data-testid="toolbar-text"]')).to_be_checked()
                        font_picker = host.get_by_label('Canvas text font', exact=True)
                        assert sorted(font_picker.locator('option').evaluate_all('(nodes)=>nodes.map(n=>Number(n.value))')) == [5, 6, 7, 8]
                        font_picker.select_option(str(family_id))
                        box = canvas.bounding_box()
                        page.mouse.click(box['x'] + 570, box['y'] + 140 + i * 80)
                        # Native text editing mounts asynchronously. Wait for the
                        # actual editor/font before sending keys, and for its font
                        # to load before Escape tears down the editing textarea.
                        text_editor = host.locator('textarea.excalidraw-wysiwyg')
                        expect(text_editor).to_be_visible()
                        expect(text_editor).to_have_css('font-family', re.compile(re.escape(family_name)))
                        text_editor.press_sequentially(f'Font {family_id} real text 字')
                        expect(text_editor).to_have_value(f'Font {family_id} real text 字')
                        page.wait_for_function('''name=>[...document.fonts].some(face=>face.family.replaceAll('"','')===name&&face.status==='loaded')''', arg=family_name, timeout=15000)
                        text_editor.press('Escape')
                        expect(text_editor).to_have_count(0)
                    try:
                        page.wait_for_function('''()=>['Excalifont','Nunito','Lilita One','Comic Shanns'].every(name=>[...document.fonts].some(face=>face.family.replaceAll('"','')===name&&face.status==='loaded'))''', timeout=15000)
                    except Exception as e:
                        raise AssertionError({'fonts': page.evaluate('[...document.fonts].map(f=>[f.family,f.status])'), 'status': host.locator('.document-status').inner_text(), 'errors': errors, 'excluded': excluded_font_requests}) from e
                    # Narrow-pane regression: an owned 180px component, ordinary
                    # native-tool clicks (no force), and pointer hit testing in
                    # the visible portion of its horizontally scrolled canvas.
                    host.evaluate('''node=>{window.__narrowIsland=node.querySelector('.canvas-island');window.__narrowCanvas=window.__narrowIsland.shadowRoot.querySelector('canvas.interactive');node.style.width='180px';}''')
                    viewport = host.locator('.canvas-viewport')
                    expect(viewport).to_have_css('width', '180px')

                    def visible_canvas_point(dx, dy):
                        visible, whole = viewport.bounding_box(), canvas.bounding_box()
                        assert visible and whole
                        x, y = visible['x'] + dx, whole['y'] + dy
                        assert visible['x'] <= x < visible['x'] + visible['width']
                        assert visible['y'] <= y < visible['y'] + visible['height']
                        assert page.evaluate('''({x,y})=>{let hit=document.elementFromPoint(x,y);while(hit?.shadowRoot)hit=hit.shadowRoot.elementFromPoint(x,y);return hit?.tagName==='CANVAS'&&hit.classList.contains('interactive');}''', {'x': x, 'y': y}), 'Pointer escaped assigned canvas viewport'
                        return x, y

                    host.locator('label:has([data-testid="toolbar-rectangle"])').click()
                    expect(host.locator('[data-testid="toolbar-rectangle"]')).to_be_checked()
                    assert viewport.evaluate('n=>n.scrollLeft') > 0, 'Native toolbar should scroll into its owned viewport'
                    start, end = visible_canvas_point(85, 170), visible_canvas_point(145, 230)
                    page.mouse.move(*start); page.mouse.down(); page.mouse.move(*end, steps=6); page.mouse.up()
                    host.locator('label:has([data-testid="toolbar-text"])').click()
                    expect(host.locator('[data-testid="toolbar-text"]')).to_be_checked()
                    page.mouse.click(*visible_canvas_point(80, 380))
                    expect(host.locator('textarea.excalidraw-wysiwyg')).to_be_visible()
                    page.keyboard.type('Narrow pane text'); page.keyboard.press('Escape')
                    for width in ('400px', '800px', ''):
                        host.evaluate('(node,width)=>node.style.width=width', width)
                        page.wait_for_timeout(100)
                        assert page.evaluate('window.__narrowIsland.isConnected&&window.__narrowCanvas.isConnected&&window.__narrowIsland.shadowRoot.querySelector("canvas.interactive")===window.__narrowCanvas'), 'Resize remounted the real scene/editor'
                expect(host.get_by_role('button', name='Save document', exact=True)).to_be_enabled()
                host.get_by_role('button', name='Save document', exact=True).click()
                expect(host.locator('.document-status')).to_contain_text('Saved revision', timeout=20000)
                saved = api('/api/documents', {'action': 'read', 'document_id': document_id, 'pane_id': pane_id})[1]
                if kind == 'richtext':
                    assert 'Durable heading' in saved['data']['content'] and 'code' in saved['data']['content']
                else:
                    assert any(e['type'] == 'rectangle' for e in json.loads(saved['data']['content'])['elements']), saved
                    assert {e['fontFamily'] for e in json.loads(saved['data']['content'])['elements'] if e['type'] == 'text'} == {5, 6, 7, 8}, saved
                    for family_id in (5, 6, 7, 8):
                        assert any(e.get('text') == f'Font {family_id} real text 字' and e.get('fontFamily') == family_id
                                   for e in json.loads(saved['data']['content'])['elements']), saved
                    assert any(e.get('text') == 'Narrow pane text' for e in json.loads(saved['data']['content'])['elements']), saved
                    assert sum(e['type'] == 'rectangle' for e in json.loads(saved['data']['content'])['elements']) >= 2, saved
                    narrow_rectangle = [e for e in json.loads(saved['data']['content'])['elements'] if e['type'] == 'rectangle'][-1]
                    assert abs(narrow_rectangle['width'] - 60) < 2 and abs(narrow_rectangle['height'] - 60) < 2, narrow_rectangle
                    for legacy_id in (1, 2, 3, 4, 9):
                        legacy = copy.deepcopy(saved['data'])
                        legacy_scene = json.loads(legacy['content'])
                        next(e for e in legacy_scene['elements'] if e['type'] == 'text')['fontFamily'] = legacy_id
                        legacy['content'] = json.dumps(legacy_scene)
                        result = api('/api/documents', {'action': 'save', 'document_id': document_id, 'pane_id': pane_id,
                            'expected_revision': saved['revision'], 'data': legacy, 'op_id': str(uuid.uuid4()), 'intent': 'Reject legacy font fixture'})
                        assert result[0] == 422 and result[1]['code'] == 'unsupported', result
                assert api('/api/documents', {'action': 'read', 'document_id': second_id})[1]['revision'] == 1
                # Reviewed whole snapshots use the real engines' native history.
                # A whole-scene empty replacement also exercises removed IDs.
                replacement = 'Reviewed replacement text' if kind == 'richtext' else json.dumps({'type':'excalidraw','version':2,'source':'Orbit','elements':[],'appState':{'viewBackgroundColor':'#ffffff'},'files':{}})
                def stage_replacement(value, format_name):
                    host.get_by_role('button', name='Import / review replacement', exact=True).click()
                    dialog = page.get_by_role('dialog', name='Import document draft', exact=True)
                    dialog.get_by_label('Import format', exact=True).select_option(format_name)
                    dialog.get_by_label('Import content', exact=True).fill(value)
                    dialog.get_by_role('button', name='Review replacement', exact=True).click()
                    return page.get_by_role('dialog', name='Review whole-document replacement', exact=True)
                proposed_data = page.evaluate('''async text=>{const {textDocument}=await import('/src/document-artifacts.ts');return textDocument(text);}''', replacement) if kind == 'richtext' else {'kind':'scene','format':'excalidraw','content':replacement}
                proposal = {'base_revision':saved['revision'],'base_digest':hashlib.sha256(saved['data']['content'].encode()).hexdigest(),'data':proposed_data}
                review = stage_replacement(json.dumps(proposal), 'proposal')
                expect(review).to_be_visible()
                review.get_by_role('button', name='Apply reviewed draft', exact=True).click()
                expect(review).to_have_count(0)
                if kind == 'richtext':
                    expect(content).to_contain_text(replacement)
                    host.get_by_role('button', name='Undo', exact=True).click()
                    expect(content).to_contain_text('Durable heading')
                    expect(content).not_to_contain_text(replacement)
                else:
                    page.wait_for_function('window.__fixtureCanvasApi.getSceneElements().length===0')
                    canvas.click(position={'x':740,'y':480})
                    page.keyboard.press('Control+z')
                    page.wait_for_function('window.__fixtureCanvasApi.getSceneElements().some(e=>e.type==="rectangle")')
                    shifted = json.loads(saved['data']['content'])
                    moved = next(e for e in shifted['elements'] if e['type']=='rectangle')
                    original_x, moved_id = moved['x'], moved['id']
                    moved['x'] += 55
                    same_id_review = stage_replacement(json.dumps(shifted), 'excalidraw')
                    same_id_review.get_by_role('button', name='Apply reviewed draft', exact=True).click()
                    page.wait_for_function('p=>window.__fixtureCanvasApi.getSceneElements().find(e=>e.id===p.id)?.x===p.x',arg={'id':moved_id,'x':original_x+55})
                    canvas.click(position={'x':740,'y':480});page.keyboard.press('Control+z')
                    page.wait_for_function('p=>window.__fixtureCanvasApi.getSceneElements().find(e=>e.id===p.id)?.x===p.x',arg={'id':moved_id,'x':original_x})
                # Another pane/save racing a review cannot replace the local draft.
                review = stage_replacement(replacement, 'text' if kind == 'richtext' else 'excalidraw')
                assert api('/api/documents', {'action':'save','document_id':document_id,'pane_id':pane_id,'expected_revision':saved['revision'],'data':saved['data'],'op_id':str(uuid.uuid4()),'intent':'Change saved revision during review'})[0] == 200
                review.get_by_role('button', name='Apply reviewed draft', exact=True).click()
                expect(review.get_by_role('status')).to_contain_text('changed during review')
                review.get_by_role('button', name='Cancel', exact=True).click()
                page.once('dialog', lambda dialog: dialog.accept())
                host.get_by_role('button', name='Reload saved document', exact=True).click()
                expect(host.locator('.document-status')).to_contain_text('Saved revision')
                saved = api('/api/documents', {'action':'read','document_id':document_id,'pane_id':pane_id})[1]
                # Select through the real native engine; transfer captures only
                # that selection plus its exact snapshot reference, never sends.
                page.evaluate('''async()=>{const {registerConversationRecipient}=await import('/src/conversation-transfer.ts');window.__selectionReceiver=registerConversationRecipient({id:'document-fixture-recipient',title:'Synthetic recipient draft',receive:delivery=>{window.__selectedDelivery=delivery;return {accepted:true};}});}''')
                if kind == 'richtext':
                    content.click();page.keyboard.press('Control+a')
                else:
                    canvas.click(position={'x':740,'y':480});page.keyboard.press('Control+a')
                host.get_by_role('button', name='Share selected content', exact=True).click()
                transfer = page.get_by_role('dialog', name='Send text to a conversation', exact=True)
                transfer.get_by_role('radio', name='Synthetic recipient draft', exact=True).check()
                transfer.get_by_role('button', name='Insert into draft', exact=True).click()
                shared = page.evaluate('window.__selectedDelivery.text')
                assert document_id in shared and 'Draft SHA-256:' in shared and 'Base revision:' in shared, shared
                assert ('Durable heading' in shared) if kind == 'richtext' else ('excalidraw-selection' in shared and 'rectangle' in shared)
                page.evaluate('window.__selectionReceiver.dispose()')
                # A local editor mutation while review is open invalidates its
                # generation even if a later undo returns identical bytes.
                review = stage_replacement(replacement, 'text' if kind == 'richtext' else 'excalidraw')
                if kind == 'richtext':
                    content.evaluate('''node=>{const editor=node.__lexicalEditor,state=editor.getEditorState().toJSON();state.root.children[0].children[0].text+=' Concurrent local text';editor.setEditorState(editor.parseEditorState(JSON.stringify(state)),{tag:'history-push'});}''')
                else:
                    page.evaluate('window.__fixtureCanvasApi.updateScene({appState:{viewBackgroundColor:"#eeeeee"}})')
                review.get_by_role('button', name='Apply reviewed draft', exact=True).click()
                expect(review.get_by_role('status')).to_contain_text('changed during review')
                review.get_by_role('button', name='Cancel', exact=True).click()
                page.once('dialog', lambda dialog: dialog.accept())
                host.get_by_role('button', name='Reload saved document', exact=True).click()
                expect(host.locator('.document-status')).to_contain_text('Saved revision')
                # Stable native editor/React island across actual core renderer/focus moves.
                page.evaluate('(id)=>{window.__documentNode=document.querySelector(`[data-document-id="${id}"]`);window.__editorNode=window.__documentNode.querySelector(".richdoc-content,.canvas-island");window.__spare=document.querySelector(`[data-pane-id="' + spare_pane + '"]`);}', document_id)
                for _ in range(2):
                    page.get_by_role('button', name='Switch to spatial view', exact=True).click()
                    page.get_by_role('button', name='Focus selected display', exact=True).click()
                    page.get_by_role('button', name='Exit focus view', exact=True).click()
                    page.get_by_role('button', name='Switch to movable windows', exact=True).click()
                    assert page.evaluate('window.__documentNode.isConnected&&window.__editorNode.isConnected&&window.__spare.isConnected')
                # Export actual current engine output.
                with page.expect_download() as download:
                    host.get_by_role('button', name='Export JSON', exact=True).click()
                exported = json.loads(Path(download.value.path()).read_text())
                assert 'root' in exported if kind == 'richtext' else exported['elements'][0]['type'] == 'rectangle'
                if kind == 'scene':
                    assert {e['fontFamily'] for e in exported['elements'] if e['type'] == 'text'} == {5, 6, 7, 8}
                if kind == 'richtext':
                    with page.expect_download() as download:
                        host.get_by_role('button', name='Export Markdown', exact=True).click()
                    assert 'Durable heading' in Path(download.value.path()).read_text()
                    content.click(); page.keyboard.press('Control+End'); page.keyboard.type(' retained draft')
                else:
                    host.locator('label:has([data-testid="toolbar-ellipse"])').click()
                    box = canvas.bounding_box()
                    page.mouse.move(box['x'] + 280, box['y'] + 390); page.mouse.down(); page.mouse.move(box['x'] + 400, box['y'] + 460); page.mouse.up()
                remote_save = {'action': 'save', 'document_id': document_id, 'pane_id': pane_id,
                    'expected_revision': saved['revision'], 'data': saved['data'], 'op_id': str(uuid.uuid4()), 'intent': 'Concurrent fixture edit'}
                assert api('/api/documents', remote_save)[0] == 200
                host.get_by_role('button', name='Save document', exact=True).click()
                expect(host.locator('.document-status')).to_contain_text('Save conflict')
                # Reload the whole page; per-pane recovery retains the conflict draft.
                page.reload(); unlock()
                expect(host.locator('.document-status')).to_contain_text('Recovered pane draft', timeout=45000)
                with page.expect_download() as download:
                    host.get_by_role('button', name='Export JSON', exact=True).click()
                recovered = Path(download.value.path()).read_text()
                assert 'retained draft' in recovered if kind == 'richtext' else any(e['type'] == 'ellipse' for e in json.loads(recovered)['elements'])
                # Split using a disposable browser sibling, never a terminal.
                def update_layout(change):
                    page.evaluate('async()=>{await (await import("/src/workspace-sync.ts")).ensureWorkspaceSynced();}')
                    current_state = api('/api/workspace', {'action':'read'})[1]
                    changed_state = copy.deepcopy(current_state['state'])
                    change(changed_state)
                    status_code, reply = api('/api/workspace', {'action':'sync','base_revision':current_state['revision'],'state':changed_state,'client_features':['plugin-instances-v1','plugin-config-schema-v1'],'operation_id':str(uuid.uuid4()),'intent':'Synthetic document pane binding update'})
                    assert status_code == 200, reply
                sibling_id = str(uuid.uuid4())
                def split_primary(layout):
                    primary = next(m for m in layout['monitors'] if m['id']==monitors[0]['id'])
                    primary['layout']={'type':'split','axis':'row','ratio':.75,'first':primary['layout'],'second':{'type':'pane','pane':{'id':sibling_id,'kind':'browser','url':'orbit://welcome'}}}
                update_layout(split_primary)
                expect(page.locator(f'[data-pane-id="{sibling_id}"]')).to_have_count(1, timeout=15000)
                page.locator(f'[data-pane-id="{pane_id}"]').get_by_role('button', name='Close pane', exact=True).click()
                page.get_by_role('button', name='Confirm change', exact=True).click()
                dirty_close = page.get_by_role('dialog', name='Close private document', exact=True)
                expect(dirty_close).to_be_visible()
                dirty_close.get_by_role('button', name='Keep editing', exact=True).click()
                expect(host).to_have_count(1)
                host.get_by_role('button', name='Keep draft on current revision', exact=True).click()
                # Actual server commits; only the response is lost.
                dropped = []

                def lose_response(route):
                    body = route.request.post_data_json or {}
                    if body.get('action') == 'save' and not dropped:
                        response = route.fetch(); assert response.status == 200
                        dropped.append(body); route.abort('failed')
                    else:
                        route.continue_()

                page.route('**/api/documents', lose_response)
                host.get_by_role('button', name='Save document', exact=True).click()
                expect(host.locator('.document-status')).to_contain_text('outcome unknown')
                if kind == 'richtext':
                    host.get_by_role('textbox', name='Rich document content').click()
                    page.keyboard.press('Control+End'); page.keyboard.type(' newer unsaved edit')
                page.locator(f'[data-pane-id="{pane_id}"]').get_by_role('button', name='Close pane', exact=True).click()
                page.get_by_role('button', name='Confirm change', exact=True).click()
                close_review = page.get_by_role('dialog', name='Close private document', exact=True)
                expect(close_review.get_by_role('button', name='Save and close', exact=True)).to_be_disabled()
                close_review.get_by_role('button', name='Keep editing', exact=True).click()
                expect(host).to_have_count(1)
                page.locator(f'[data-pane-id="{pane_id}"]').get_by_role('button', name='Close pane', exact=True).click()
                page.get_by_role('button', name='Confirm change', exact=True).click()
                page.get_by_role('button', name='Retain draft and close', exact=True).click()
                expect(host).to_have_count(0)
                page.evaluate('window.dispatchEvent(new CustomEvent("orbit-open-host-surface",{detail:{id:"documents"}}))')
                recovery_library = page.locator('[data-document-library="true"]')
                try:
                    recovery_library.get_by_role('button', name=re.compile('^Recover Synthetic ' + kind + ' · original pane ' + pane_id)).click()
                except Exception as e:
                    raise AssertionError({'library': recovery_library.inner_text(), 'drafts': page.evaluate('Object.fromEntries(Object.entries(sessionStorage).filter(([k])=>k.startsWith("orbit.document")))'), 'errors': errors}) from e
                expect(host.locator('.document-status')).to_contain_text('Previous save outcome unknown', timeout=45000)
                # Recovery changes placement but restores the original pane binding.
                monitors[0]['id'] = host.evaluate('n=>n.closest("[data-monitor-id]").dataset.monitorId')
                host.get_by_role('button', name='Retry exact save', exact=True).click()
                expect(host.locator('.document-status')).to_contain_text('Saved revision')
                assert api('/api/documents', {'action': 'read', 'document_id': document_id})[1]['revision'] == remote_save['expected_revision'] + 2
                if kind == 'richtext':
                    expect(host.locator('.document-status')).to_contain_text('newer edits remain unsaved')
                    expect(host.get_by_role('textbox', name='Rich document content')).to_contain_text('newer unsaved edit')
                    assert 'newer unsaved edit' not in api('/api/documents', {'action': 'read', 'document_id': document_id})[1]['data']['content']
                else:
                    # Force the actual FontFace failure/fallback path after a
                    # fresh document load. Both URLs must stay same-origin;
                    # missing local assets must never cause esm.sh requests.
                    missing_fonts = []

                    def missing_font(route):
                        missing_fonts.append(route.request.url)
                        route.fulfill(status=404, body='font fixture unavailable')

                    page.route('**/fonts/Excalifont/*.woff2', missing_font)
                    page.reload(); unlock()
                    expect(host.locator('.excalidraw__canvas.interactive')).to_be_visible(timeout=30000)
                    page.wait_for_timeout(1500)
                    assert missing_fonts, 'Real Excalifont fallback path was not exercised'
                    assert not outside_requests, outside_requests
                # A disposed pane aborts requests, unregisters polling/connection
                # listeners, and refuses late resolve responses.
                page.unroute('**/api/documents', lose_response)
                held, primary_resolves = [], []

                def hold_resolve(route):
                    body = route.request.post_data_json or {}
                    if body.get('action') == 'resolve' and body.get('document_id') == document_id:
                        primary_resolves.append(body)
                        if not held:
                            held.append(route)
                            return
                    route.continue_()

                page.route('**/api/documents', hold_resolve)
                page.evaluate('window.dispatchEvent(new Event("orbit-host-connected"))')
                page.wait_for_timeout(300)
                assert held, 'Expected a live binding request to dispose'
                page.locator(f'.monitor[data-monitor-id="{monitors[0]["id"]}"] .window-close').click()
                page.get_by_role('button', name='Confirm change', exact=True).click()
                if kind == 'richtext':
                    close_review = page.get_by_role('dialog', name='Close private document', exact=True)
                    expect(close_review).to_be_visible()
                    close_review.get_by_role('button', name='Retain draft and close', exact=True).click()
                expect(host).to_have_count(0)
                before = len(primary_resolves)
                try:
                    held[0].fulfill(status=200, content_type='application/json', body=json.dumps({'ok': True, 'document': saved['document'], 'revision': saved['revision'], 'data_schema_version': 1}))
                except Exception:
                    pass  # Chromium can cancel the request before late delivery.
                page.evaluate('window.dispatchEvent(new Event("orbit-host-connected"))')
                page.wait_for_timeout(2400)
                assert len(primary_resolves) == before, 'Disposed document retained polling or connection listeners'
                expect(host).to_have_count(0)
                # Real owner library creates before placement; the reviewed
                # opener event then binds a standard live document pane.
                library_lists = []
                def hold_library_list(route):
                    if (route.request.post_data_json or {}).get('action') == 'list':
                        library_lists.append(route)
                    else:
                        route.fallback()
                page.route('**/api/documents', hold_library_list)
                page.evaluate('window.dispatchEvent(new CustomEvent("orbit-open-host-surface",{detail:{id:"documents"}}))')
                page.evaluate('window.dispatchEvent(new Event("orbit-host-connected"))')
                library = page.locator('[data-document-library="true"]')
                expect(library).to_be_visible(timeout=20000)
                library.get_by_label('Document title', exact=True).fill('Created through owner library')
                expect(library.get_by_role('button', name='Create document', exact=True)).to_be_disabled()
                deadline = time.monotonic() + 15
                while not library_lists and time.monotonic() < deadline:
                    page.wait_for_timeout(50)
                assert len(library_lists) == 1, 'Expected the pending real library read'
                page.unroute('**/api/documents', hold_library_list)
                library_lists[0].continue_()
                library.get_by_role('button', name='Create document', exact=True).click()
                created = page.locator('.document-host', has=page.locator('strong', has_text='Created through owner library'))
                expect(created.get_by_role('textbox', name='Rich document content')).to_be_visible(timeout=30000)
                assert len(api('/api/documents', {'action': 'list'})[1]['documents']) == 3
                if kind == 'richtext':
                    # Ordinary saved reopen uses a new pane, then library recovery
                    # restores the independent original pane without stealing it.
                    page.evaluate('window.dispatchEvent(new CustomEvent("orbit-open-host-surface",{detail:{id:"documents"}}))')
                    library.get_by_role('button', name='Refresh documents', exact=True).click()
                    library.get_by_role('button', name=f'Synthetic richtext · Rich document · revision {remote_save["expected_revision"] + 2}', exact=True).click()
                    expect(page.locator(f'[data-document-id="{document_id}"]')).to_have_count(1)
                    expect(page.locator(f'[data-document-id="{document_id}"] .richdoc-content')).not_to_contain_text('newer unsaved edit')
                    page.evaluate('window.dispatchEvent(new CustomEvent("orbit-open-host-surface",{detail:{id:"documents"}}))')
                    library.get_by_role('button', name=re.compile('^Recover Synthetic richtext · original pane ' + pane_id)).click()
                    recovered_host = page.locator(f'[data-pane-id="{pane_id}"] [data-document-id="{document_id}"]')
                    expect(recovered_host.locator('.richdoc-content')).to_contain_text('newer unsaved edit', timeout=30000)
                    expect(page.locator(f'[data-document-id="{document_id}"]')).to_have_count(2)
                # A source that changes during the workspace flush is refused at
                # the final dispatch boundary, with no create or journal entry.
                page.evaluate('''async()=>{const {requestDocumentFromResult,textDocument}=await import('/src/document-artifacts.ts');window.__resultSourceCurrent=true;window.__staleReviewedResult=requestDocumentFromResult(JSON.stringify({document:{title:'Stale reviewed source',...textDocument('Never dispatch this')}}),()=>window.__resultSourceCurrent);}''')
                stale_review = page.get_by_role('dialog', name='Create document from reviewed content', exact=True)
                expect(stale_review).to_be_visible()
                workspace_reads = []
                def hold_workspace_flush(route):
                    if not page.evaluate('window.__reviewApplyClicked===true'):
                        route.continue_(); return
                    response = route.fetch()
                    page.evaluate('window.__resultSourceCurrent=false')
                    workspace_reads.append(route.request.post_data_json)
                    route.fulfill(response=response)
                page.route('**/api/workspace', hold_workspace_flush)
                stale_review.get_by_role('button', name='Apply reviewed draft', exact=True).evaluate('b=>b.addEventListener("click",()=>{window.__reviewApplyClicked=true;},{capture:true})')
                stale_review.get_by_role('button', name='Apply reviewed draft', exact=True).click()
                deadline = time.monotonic() + 15
                while not workspace_reads and time.monotonic() < deadline:
                    page.wait_for_timeout(50)
                assert workspace_reads
                page.unroute('**/api/workspace', hold_workspace_flush)
                expect(stale_review.get_by_role('status')).to_contain_text('source, workspace or host connection changed')
                assert len(api('/api/documents', {'action':'list'})[1]['documents']) == 3
                assert page.evaluate('Object.keys(sessionStorage).filter(k=>k.startsWith("orbit.document-create.v1:")).length') == 0
                stale_review.get_by_role('button', name='Cancel', exact=True).click()

                # Committed create response lost -> whole-page reload -> owner
                # library exact recovery. The engine/body is not mocked.
                creations = []
                def lose_creation_response(route):
                    body = route.request.post_data_json or {}
                    if body.get('action') == 'create' and body.get('title') == 'Reviewed agent result':
                        journal = page.evaluate('Object.fromEntries(Object.entries(sessionStorage).filter(([k])=>k.startsWith("orbit.document-create.v1:")))')
                        assert len(journal) == 1, 'Creation dispatched before durable journal'
                        entry = json.loads(next(iter(journal.values())))
                        assert entry['request'] == body
                        creations.append(body)
                        if len(creations) == 1:
                            response = route.fetch(); assert response.status == 200
                            route.abort('failed'); return
                    route.continue_()
                page.route('**/api/documents', lose_creation_response)
                page.evaluate('''async data=>{const {requestDocumentFromResult,importDocument}=await import('/src/document-artifacts.ts');const imported=data??await importDocument(`## Exact complete result\n\nReviewed Markdown paragraph`,'markdown');window.__resultDelivery=requestDocumentFromResult(JSON.stringify({document:{title:'Reviewed agent result',...imported}}));}''', saved['data'] if kind == 'scene' else None)
                result_review = page.get_by_role('dialog', name='Create document from reviewed content', exact=True)
                result_review.get_by_role('button', name='Apply reviewed draft', exact=True).click()
                expect(result_review.get_by_role('status')).to_contain_text('Creation outcome unknown')
                journal_entry = page.evaluate('JSON.parse(Object.entries(sessionStorage).find(([k])=>k.startsWith("orbit.document-create.v1:"))[1])')
                delivery = {'documentId':journal_entry['request']['document_id'],'paneId':journal_entry['paneId']}
                assert len(api('/api/documents', {'action':'list'})[1]['documents']) == 4
                page.reload();unlock()
                page.evaluate('async()=>{await (await import("/src/workspace-sync.ts")).ensureWorkspaceSynced();}')
                page.evaluate('window.dispatchEvent(new CustomEvent("orbit-open-host-surface",{detail:{id:"documents"}}))')
                library = page.locator('[data-document-library="true"]')
                expect(library).to_be_visible(timeout=15000)
                page.get_by_role('button', name='Focus selected display', exact=True).click()
                library.get_by_role('button', name=re.compile('^Recover creation Reviewed agent result · document ' + delivery['documentId'])).click()
                creation_recovery = page.get_by_role('dialog', name='Recover pending document creation', exact=True)
                creation_recovery.get_by_role('button', name='Apply reviewed draft', exact=True).click()
                result_host = page.locator('.document-host', has=page.locator('strong', has_text='Reviewed agent result'))
                if kind == 'richtext':
                    expect(result_host.locator('.richdoc-content h2')).to_contain_text('Exact complete result', timeout=30000)
                else:
                    expect(result_host.locator('.excalidraw__canvas.interactive')).to_be_visible(timeout=30000)
                assert len(creations) == 2 and creations[0] == creations[1]
                assert len(api('/api/documents', {'action':'list'})[1]['documents']) == 4
                assert page.evaluate('Object.keys(sessionStorage).filter(k=>k.startsWith("orbit.document-create.v1:")).length') == 0
                expect(page.locator(f'[data-pane-id="{delivery["paneId"]}"] .document-host')).to_have_count(1)
                before_explicit_save = api('/api/documents', {'action':'read','document_id':delivery['documentId']})[1]
                assert before_explicit_save['revision'] == 1
                assert 'Exact complete result' not in before_explicit_save['data']['content'] if kind == 'richtext' else json.loads(before_explicit_save['data']['content'])['elements'] == []
                result_window = result_host.evaluate('n=>n.closest("[data-monitor-id]").dataset.monitorId')
                result_sibling = str(uuid.uuid4())
                def split_result(layout):
                    target = next(m for m in layout['monitors'] if m['id']==result_window)
                    target['layout']={'type':'split','axis':'row','ratio':.75,'first':target['layout'],'second':{'type':'pane','pane':{'id':result_sibling,'kind':'browser','url':'orbit://welcome'}}}
                update_layout(split_result)
                expect(page.locator(f'[data-pane-id="{result_sibling}"]')).to_have_count(1, timeout=15000)
                result_pane = page.locator(f'[data-pane-id="{delivery["paneId"]}"]')
                result_pane.get_by_role('button', name='Close pane', exact=True).click()
                page.get_by_role('button', name='Confirm change', exact=True).click()
                expect(page.get_by_role('dialog', name='Close private document', exact=True)).to_be_visible()
                def set_result_url(layout, document):
                    target = next(m for m in layout['monitors'] if m['id']==result_window)
                    target['layout']['first']['pane']['url']='orbit://document/' + document
                # Change the authoritative pane binding while close is waiting.
                # The old close approval must not remove the replacement view.
                update_layout(lambda layout:set_result_url(layout,second_id))
                expect(result_pane.locator(f'[data-document-id="{second_id}"]')).to_have_count(1, timeout=15000)
                page.get_by_role('dialog', name='Close private document', exact=True).get_by_role('button', name='Retain draft and close', exact=True).click()
                expect(result_pane.locator(f'[data-document-id="{second_id}"]')).to_have_count(1)
                update_layout(lambda layout:set_result_url(layout,delivery['documentId']))
                expect(result_host).to_have_count(1, timeout=15000)
                expect(result_host.get_by_role('button', name='Save document', exact=True)).to_be_enabled(timeout=15000)
                if page.get_by_role('button', name='Exit focus view', exact=True).is_visible():
                    page.get_by_role('button', name='Exit focus view', exact=True).click()
                page.locator(f'.monitor[data-monitor-id="{result_window}"] .window-close').click()
                page.get_by_role('button', name='Confirm change', exact=True).click()
                page.get_by_role('dialog', name='Close private document', exact=True).get_by_role('button', name='Save and close', exact=True).click()
                expect(result_host).to_have_count(0)
                result_saved = api('/api/documents', {'action':'read','document_id':delivery['documentId']})[1]
                assert result_saved['revision'] == 2
                assert 'Exact complete result' in result_saved['data']['content'] if kind == 'richtext' else any(e['type']=='rectangle' for e in json.loads(result_saved['data']['content'])['elements'])
                assert not page.evaluate('localStorage.getItem("orbit.workspace.v1").includes("retained draft")')
                assert page.locator('.pane iframe').count() == 0
                assert not outside_requests, outside_requests
                assert not excluded_font_requests, excluded_font_requests
                assert not errors, errors
                browser.close()
                print('PASS', kind, ': real editing/Undo, split dirty+unknown close/rebind fencing, lost create/save response+reload+exact retry, stale lazy/final source no-create, explicit Save, independent recovery, local assets')
        finally:
            vite.terminate(); server.terminate()
            vite.wait(timeout=15); server.wait(timeout=15); log.close()


if __name__ == '__main__':
    run_fixture()
