"""Disposable Vite/browser fixture; synthetic API only, no provider or live runtime."""
import json, shutil, socket, subprocess, tempfile, time, urllib.request, uuid
from pathlib import Path
from playwright.sync_api import sync_playwright, expect

ROOT = Path(__file__).resolve().parents[1]
with tempfile.TemporaryDirectory(prefix='orbit-everyday-ux-', dir='/tmp/opencode') as tmp:
    root = Path(tmp)
    for name in ('src', 'contracts', 'public'): shutil.copytree(ROOT / name, root / name)
    for name in ('index.html', 'package.json'): shutil.copy2(ROOT / name, root / name)
    (root / 'node_modules').symlink_to(ROOT / 'node_modules', target_is_directory=True)
    (root / 'fixture.html').write_text('<!doctype html><html><body></body></html>')
    with socket.socket() as sock: sock.bind(('127.0.0.1', 0)); port = sock.getsockname()[1]
    origin = f'http://127.0.0.1:{port}'
    with (root / 'vite.log').open('w') as log:
        server = subprocess.Popen(['node', str(ROOT / 'node_modules/vite/bin/vite.js'), '--host', '127.0.0.1', '--port', str(port), '--strictPort'], cwd=root, stdout=log, stderr=log)
        try:
            for _ in range(120):
                try: urllib.request.urlopen(origin, timeout=1); break
                except OSError: time.sleep(.1)
            with sync_playwright() as p:
                browser = p.chromium.launch(headless=True, args=['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'])
                context = browser.new_context(viewport={'width': 1400, 'height': 1000})
                page = context.new_page(); errors = []; page.on('pageerror', lambda e: errors.append(str(e)))
                page.goto(origin + '/fixture.html')
                page.evaluate('''async()=>{
                  const {installStart}=await import('/src/taskbar.ts');
                  const host=document.createElement('nav');document.body.append(host);window.executed=[];
                  installStart(host,{list:(q='')=>[
                    {id:'a',title:'A enabled',detail:''}, {id:'b',title:'B disabled',disabledReason:'Connect host'},
                    {id:'c',title:'C enabled',detail:''}].filter(x=>x.title.toLowerCase().includes(q)),execute:id=>window.executed.push(id)});
                }''')
                page.get_by_role('button', name='Open Start', exact=True).click()
                page.get_by_role('button', name='A enabled', exact=True).focus()
                page.keyboard.press('ArrowDown'); expect(page.get_by_role('button', name='C enabled', exact=True)).to_be_focused()
                page.keyboard.press('ArrowUp'); expect(page.get_by_role('button', name='A enabled', exact=True)).to_be_focused()
                search = page.get_by_label('Search Start'); search.fill('disabled'); search.press('Enter')
                assert page.evaluate('window.executed') == []
                search.fill('missing'); search.press('ArrowUp'); search.press('Escape')
                expect(page.get_by_role('button', name='Open Start', exact=True)).to_be_focused()
                page.get_by_role('button', name='Open Start', exact=True).click(); search.press('Enter')
                assert page.evaluate('window.executed') == ['a']
                page.set_viewport_size({'width': 320, 'height': 480})
                page.evaluate('''async()=>{const {showOnboarding}=await import('/src/onboarding.ts');
                  window.goalActions=[];window.tour=()=>showOnboarding({connected:()=>false,run:id=>goalActions.push(id)});window.tour();}''')
                tour = page.get_by_role('dialog', name='What would you like to do?')
                expect(tour.get_by_text('Readiness not checked.', exact=False)).to_be_visible()
                assert tour.evaluate('(e)=>e.scrollWidth<=e.clientWidth'), 'Onboarding must reflow at 320 CSS pixels'
                tour.get_by_role('button', name='Next tour step', exact=True).click()
                page.get_by_role('button', name='Close getting started', exact=True).click()
                page.wait_for_function("!document.querySelector('.orbit-onboarding')")
                page.evaluate("async()=>{const {offerOnboarding}=await import('/src/onboarding.ts');offerOnboarding();}")
                expect(page.locator('.orbit-onboarding')).to_have_count(0)
                page.evaluate('()=>{window.tour();}')
                expect(page.get_by_role('heading', name='Your everyday controls')).to_be_visible()
                page.get_by_role('button', name='Previous tour step').click()
                page.get_by_role('button', name='Transcribe audio:', exact=False).click()
                assert page.evaluate('goalActions') == ['technology-voice']
                page.set_viewport_size({'width': 1400, 'height': 1000})

                requests = []; held_pages = []; hold_page = False; reject_selection = False; binding_ready = False; binding = {'session': 'original', 'profile_id': 'B', 'messages': [], 'binding_revision': 1}
                def api(route):
                    body = route.request.post_data_json or {}; action = body.get('action'); requests.append(body)
                    if action == 'profiles': data = {'profiles': [{'id': 'default', 'label': 'Default'}, {'id': 'B', 'label': 'Profile B'}]}
                    elif action == 'conversation_library':
                        offset = body.get('offset', 0)
                        if hold_page and offset == 100: held_pages.append(route); return
                        data = {'supported': True, 'has_more': offset < 200, 'conversations': [{'session_id': f'session-{offset}', 'profile_id': body['profile_id'], 'title': 'Needle' if offset == 200 else f'Page {offset}', 'pinned': False, 'archived': False, 'revision': 0}]}
                    elif action == 'shared_chat': data = {'state': binding if binding_ready else None}
                    elif action == 'select_session':
                        if reject_selection: route.fulfill(status=409, json={'error': 'Current run outcome is unresolved. Wait for reconciliation.'}); return
                        binding.update(session=body['target_session_id'], profile_id=body['target_profile_id'], binding_revision=binding['binding_revision']+1); data = {'state': binding}
                    elif action in ('draft_read', 'draft_write'): data = {'record': {'draft': '', 'revision': 0}}
                    else: data = {'sessions': [], 'cards': [], 'features': {}}
                    route.fulfill(json=data)
                context.route('**/api/**', api)
                page.evaluate('''async()=>{
                  const {connectWorkspace}=await import('/src/workspace-sync.ts');
                  const {initial}=await import('/src/model.ts');connectWorkspace(initial,()=>{},()=> 'fixture-token',()=>{});
                  const {createAgentChat}=await import('/src/agent-chat.ts');
                  const body=document.createElement('div');document.body.append(body);
                  window.disposeChat=createAgentChat(body,'fixture-pane',()=> 'fixture-token');
                  const {showConversationLibrary}=await import('/src/conversation-library.ts');
                  window.openLibrary=()=>showConversationLibrary(()=> 'fixture-token','fixture-pane','B');window.openLibrary();
                }''')
                dialog = page.get_by_role('dialog', name='Conversation library', exact=True)
                expect(dialog.get_by_label('Library profile')).to_have_value('B')
                expect(dialog.get_by_text('Page 0', exact=True)).to_be_visible()
                dialog.get_by_label('Search conversations').fill('Needle')
                dialog.get_by_role('button', name='Search up to 10 more catalog pages').click()
                expect(dialog.get_by_text('Needle', exact=True)).to_be_visible()
                expect(dialog.get_by_role('status').first).to_contain_text('Catalog complete')
                assert [x.get('offset', 0) for x in requests if x.get('action') == 'conversation_library'] == [0, 100, 200]
                dialog.get_by_role('button', name='Open conversation in selected pane').click()
                expect(dialog.get_by_role('button', name='Cancel waiting conversation choice')).to_be_visible()
                dialog.get_by_role('button', name='Cancel waiting conversation choice').click()
                binding_ready = True
                page.wait_for_timeout(2200)
                assert not any(x.get('action') == 'select_session' for x in requests)
                dialog.get_by_role('button', name='Open conversation in selected pane').click()
                try: expect(dialog).not_to_be_visible()
                except AssertionError:
                    print(dialog.inner_text(), requests, errors); raise
                assert len([x for x in requests if x.get('action') == 'select_session']) == 1
                page.wait_for_function("!document.querySelector('.conversation-library')")
                reject_selection = True
                page.evaluate('()=>{window.openLibrary();}')
                expect(dialog.get_by_label('Search conversations')).to_have_value('Needle')
                dialog.get_by_label('Search conversations').fill('Page')
                expect(dialog.get_by_text('Page 0', exact=True)).to_be_visible()
                dialog.get_by_role('button', name='Open conversation in selected pane').click()
                expect(dialog.get_by_role('status').last).to_contain_text('unresolved')
                expect(dialog).to_be_visible()
                assert binding['session'] == 'session-200'
                hold_page = True
                dialog.get_by_role('button', name='Search up to 10 more catalog pages').click()
                page.wait_for_timeout(150)
                assert len(held_pages) == 1
                dialog.get_by_role('button', name='Cancel older-title search').click()
                held_pages.pop().fulfill(json={'supported': True, 'has_more': False, 'conversations': [{'session_id': 'stale', 'profile_id': 'B', 'title': 'Page stale', 'revision': 0}]})
                expect(dialog.get_by_role('status').first).to_contain_text('cancelled')
                expect(dialog.locator('.conversation-library-row')).to_have_count(1)
                expect(dialog.get_by_text('Page stale', exact=True)).to_have_count(0)
                dialog.get_by_role('button', name='Close conversation library', exact=True).click()
                page.evaluate('window.disposeChat()')
                assert not errors, errors
                context.close()

                # Full shell: both renderers retain Spatial and the same connected iframe.
                for renderer in ('default', 'docking'):
                    ctx = browser.new_context(viewport={'width': 1400, 'height': 1000})
                    ctx.route('**/api/**', lambda route: route.fulfill(status=401, json={'error': 'Locked synthetic fixture'}))
                    wid, pane, workspace = (str(uuid.uuid4()) for _ in range(3))
                    state = {'version': 1, 'selected': wid, 'arc': 14, 'view': 'spatial', 'monitors': [{'id': wid, 'name': 'Continuity fixture', 'diagonal': 32, 'aspect': '16:9', 'height': 0, 'distance': 0, 'pitch': 0, 'yaw': 0, 'offset': 0, 'fontSize': 19, 'frame': {'x': 20, 'y': 20, 'width': 700, 'height': 500, 'z': 0}, 'layout': {'type': 'pane', 'pane': {'id': pane, 'kind': 'browser', 'url': 'about:blank'}}}]}
                    state['monitors'][0]['layout']['pane']['url'] = 'https://fixture.invalid/'
                    ctx.route('https://fixture.invalid/**', lambda route: route.fulfill(content_type='text/html', body='<p>Synthetic persistent frame</p>'))
                    ctx.add_init_script("if(window===window.top){localStorage.setItem('orbit.onboarding.v1','done');localStorage.setItem('orbit.workspace.id',%s);localStorage.setItem('orbit.workspace.v1',%s);}" % (json.dumps(workspace), json.dumps(json.dumps(state))))
                    shell = ctx.new_page(); shell.goto(origin + ('/?renderer=docking' if renderer == 'docking' else '/'), wait_until='networkidle')
                    shell.evaluate("window.originalFrame=document.querySelector('iframe')")
                    frame = shell.frame(url='https://fixture.invalid/'); assert frame
                    frame.evaluate("window.continuityMarker='preserved'")
                    for _ in range(2):
                        shell.evaluate("window.dispatchEvent(new CustomEvent('orbit-open-host-surface',{detail:{id:'data'}}))")
                        shell.wait_for_function("JSON.parse(localStorage.getItem('orbit.workspace.v1')).monitors.length===2")
                        assert shell.evaluate("JSON.parse(localStorage.getItem('orbit.workspace.v1')).view") == 'spatial'
                    shell.evaluate("window.dispatchEvent(new CustomEvent('orbit-open-document',{detail:{id:'00000000-0000-4000-8000-000000000001',name:'Fixture document'}}))")
                    shell.wait_for_function("JSON.parse(localStorage.getItem('orbit.workspace.v1')).monitors.length===3")
                    assert shell.evaluate("JSON.parse(localStorage.getItem('orbit.workspace.v1')).view") == 'spatial'
                    assert shell.evaluate("originalFrame.isConnected && originalFrame===document.querySelector('iframe')")
                    assert frame.evaluate("window.continuityMarker==='preserved'")
                    ctx.close()
                browser.close()
                print('PASS: Start traversal/Enter/escape; active profile; page-three title search; cancelled initial-link choice never selects; acknowledged selection once; Spatial new/existing tool + document with iframe continuity in both renderers')
        finally:
            server.terminate(); server.wait(timeout=15)
