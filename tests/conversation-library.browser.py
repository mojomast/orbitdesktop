"""Real isolated Orbit HTTP server, fake Hermes catalog, no inference/provider calls."""
import json, os, secrets, shutil, socket, subprocess, tempfile, threading, time, urllib.request, uuid
from pathlib import Path
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from playwright.sync_api import sync_playwright, expect

ROOT = Path(__file__).resolve().parents[1]
calls = []
class Gateway(BaseHTTPRequestHandler):
    def log_message(self, *_): pass
    def do_GET(self):
        calls.append(self.path)
        if self.path.startswith('/api/sessions?'):
            data = {'data': [{'id': 'saved-session', 'title': 'Saved Hermes title'}, {'id': 'other-session', 'title': 'Other title'}], 'has_more': False}
        elif self.path in ('/api/sessions/saved-session', '/api/sessions/other-session', '/api/sessions/read-cycle'):
            data = {'id': self.path.split('/')[-1], 'title': 'Saved Hermes title'}
        elif '/messages' in self.path:
            data = {'data': [{'role': 'user', 'content': 'Old question'}, {'role': 'assistant', 'content': 'Saved history'}]}
        elif self.path == '/v1/capabilities': data = {'features': {}}
        elif self.path.startswith('/v1/runs'): data = {'data': [], 'runs': []}
        else: self.send_response(404); self.end_headers(); return
        self.send_response(200); self.send_header('Content-Type', 'application/json'); self.end_headers(); self.wfile.write(json.dumps(data).encode())
    def do_POST(self):
        calls.append('UNEXPECTED POST ' + self.path)
        self.send_response(500); self.end_headers()

gateway = ThreadingHTTPServer(('127.0.0.1', 0), Gateway)
threading.Thread(target=gateway.serve_forever, daemon=True).start()
try:
  with tempfile.TemporaryDirectory(prefix='orbit-conversation-browser-', dir='/tmp/opencode') as temporary:
    root = Path(temporary)
    for name in ('server', 'src', 'contracts', 'public', 'docs', 'scripts'): shutil.copytree(ROOT / name, root / name)
    (root / 'node_modules').symlink_to(ROOT / 'node_modules', target_is_directory=True)
    for name in ('package.json', 'index.html', 'tsconfig.json', 'vite.config.js'): shutil.copy2(ROOT / name, root / name)
    for name in ('runtime', 'home', 'cwd'): (root / name).mkdir()
    with socket.socket() as probe: probe.bind(('127.0.0.1', 0)); port = probe.getsockname()[1]
    with socket.socket() as probe: probe.bind(('127.0.0.1', 0)); dev_port = probe.getsockname()[1]
    origin = f'http://127.0.0.1:{dev_port}'
    backend = f'http://127.0.0.1:{port}'
    (root / 'vite.config.js').write_text('export default ' + json.dumps({'server': {'host': '127.0.0.1', 'port': dev_port, 'strictPort': True, 'proxy': {'/api': {'target': backend, 'ws': True, 'changeOrigin': True}}}}))
    token, workspace, window_id, pane = secrets.token_urlsafe(36), str(uuid.uuid4()), str(uuid.uuid4()), str(uuid.uuid4())
    state = {'version': 1, 'selected': window_id, 'arc': 14, 'view': 'windows', 'monitors': [
        {'id': window_id, 'name': 'Conversation fixture', 'diagonal': 32, 'aspect': '16:9', 'height': 0, 'distance': 0, 'pitch': 0, 'yaw': 0, 'offset': 0, 'fontSize': 19,
         'frame': {'x': 0, 'y': 0, 'width': 900, 'height': 900, 'z': 0}, 'layout': {'type': 'pane', 'pane': {'id': pane, 'kind': 'agent', 'url': ''}}}]}
    env = {'PATH': os.environ['PATH'], 'HOME': str(root / 'home'), 'PORT': str(port), 'ORBIT_TOKEN': token, 'ORBIT_RUNTIME_DIR': str(root / 'runtime'), 'ORBIT_CWD': str(root / 'cwd'),
           'HERMES_API_URL': f'http://127.0.0.1:{gateway.server_port}', 'HERMES_API_KEY': 'fake-private-key', 'ORBIT_DEV_ORIGINS': origin}
    with (root / 'server.log').open('w+') as log:
      server = subprocess.Popen(['node', '--experimental-strip-types', 'server/index.mjs'], cwd=root, env=env, stdout=log, stderr=log)
      dev = subprocess.Popen(['node', str(ROOT / 'node_modules/vite/bin/vite.js'), '--config', str(root / 'vite.config.js')], cwd=root, env={**env, 'NODE_ENV': 'development'}, stdout=log, stderr=log)
      try:
        for _ in range(120):
            if server.poll() is not None: log.seek(0); raise RuntimeError(log.read())
            try:
                with urllib.request.urlopen(origin, timeout=1), urllib.request.urlopen(origin + '/api/health', timeout=1): break
            except OSError: time.sleep(.05)
        else: raise RuntimeError('Server readiness timeout')
        with sync_playwright() as p:
          browser = p.chromium.launch(headless=True, args=['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'])
          context = browser.new_context(viewport={'width': 1400, 'height': 1100})
          context.add_init_script('if(window===window.top && !localStorage.getItem("orbit.workspace.id")){localStorage.setItem("orbit.workspace.id",' + json.dumps(workspace) + ');localStorage.setItem("orbit.workspace.v1",JSON.stringify(' + json.dumps(state) + '));}')
          page = context.new_page(); errors = []; page.on('pageerror', lambda error: errors.append(str(error)))
          def unlock():
            page.get_by_role('button', name='Connect local host', exact=True).click()
            page.get_by_role('textbox', name='Host session token').fill(token)
            page.get_by_role('button', name='Unlock local host', exact=True).click()
            page.wait_for_function('(id)=>Number.isSafeInteger(JSON.parse(sessionStorage.getItem(`orbit-hermes-chat:${id}`)||"{}").binding_revision)', arg=pane)
          def library():
            page.evaluate('(paneId)=>window.dispatchEvent(new CustomEvent("orbit-open-conversation-library",{detail:{paneId}}))', pane)
            dialog = page.get_by_role('dialog', name='Conversation library', exact=True)
            expect(dialog.get_by_text('Saved Hermes title', exact=True)).to_be_visible()
            return dialog
          headers = {'Origin': origin, 'Authorization': 'Bearer ' + token}
          identity = {'workspace_id': workspace, 'profile_id': 'default', 'session_id': 'saved-session'}
          def api(body):
            result = page.request.post(origin + '/api/agent', headers=headers, data=body)
            assert result.ok, result.text()
            return result.json()
          page.goto(origin, wait_until='networkidle'); page.keyboard.press('Escape'); unlock()
          dialog = library()
          dialog.get_by_label('Search conversations').fill('saved-session')
          expect(dialog.locator('.conversation-library-row')).to_have_count(1)
          row = dialog.locator('.conversation-library-row')
          row.get_by_role('button', name='Rename Orbit display title').click()
          row.get_by_label('Orbit conversation name').fill('Owner renamed')
          metadata = api({'action': 'draft_read', **identity})['record']
          api({'action': 'conversation_metadata', **identity, 'expected_revision': metadata['revision'], 'patch': {'title': 'Concurrent owner name'}})
          row.get_by_role('button', name='Save Orbit display title').click()
          expect(row.get_by_role('status')).to_contain_text('Your typed name is preserved')
          expect(row.get_by_label('Orbit conversation name')).to_have_value('Owner renamed')
          expect(row.get_by_role('button', name='Save Orbit display title')).to_be_enabled()
          row.get_by_role('button', name='Save Orbit display title').click()
          expect(row).to_contain_text('Owner renamed')
          row.get_by_role('button', name='Toggle conversation pin').click()
          expect(row).to_contain_text('★')
          row.get_by_role('button', name='Toggle Orbit archive flag').click()
          expect(dialog.locator('.conversation-library-row')).to_have_count(0)
          dialog.get_by_label('Show archived conversations').check()
          row = dialog.locator('.conversation-library-row'); expect(row).to_contain_text('Archived')
          row.get_by_role('button', name='Open conversation in selected pane').click()
          composer = page.get_by_label('Message to Hermes', exact=True)
          expect(page.get_by_label('Hermes conversation', exact=True)).to_contain_text('Saved history')
          composer.fill('Owner durable draft')
          expect(page.locator('.conversation-draft-status')).to_contain_text('Draft saved on host', timeout=10000)
          assert api({'action': 'draft_read', **identity})['record']['draft'] == 'Owner durable draft'
          # A separate client changes the same draft. Local edits must not overwrite it.
          record = api({'action': 'draft_read', **identity})['record']
          api({'action': 'draft_write', **identity, 'expected_revision': record['revision'], 'text': 'Other device draft'})
          composer.fill('Local conflicting draft')
          expect(page.locator('.conversation-draft-status')).to_contain_text('Draft conflict', timeout=10000)
          expect(composer).to_have_value('Local conflicting draft')
          page.get_by_role('button', name='Save this tab draft over reviewed host draft').click()
          expect(page.locator('.conversation-draft-status')).to_contain_text('Draft saved on host', timeout=10000)
          assert api({'action': 'draft_read', **identity})['record']['draft'] == 'Local conflicting draft'
          # Close-tab continuity: new browser tab has no pane chat/session cache.
          page.close(); page = context.new_page(); page.on('pageerror', lambda error: errors.append(str(error)))
          page.goto(origin, wait_until='networkidle'); page.keyboard.press('Escape'); unlock()
          composer = page.get_by_label('Message to Hermes', exact=True)
          expect(composer).to_have_value('Local conflicting draft', timeout=10000)
          expect(page.get_by_role('button', name='Start a separate Hermes conversation', exact=True)).to_be_enabled(timeout=10000)
          page.reload(wait_until='networkidle'); page.keyboard.press('Escape')
          composer = page.get_by_label('Message to Hermes', exact=True)
          composer.fill('Owner edit before unlock')
          unlock()
          expect(composer).to_have_value('Owner edit before unlock')
          expect(page.locator('.conversation-draft-status')).to_contain_text('Draft saved on host', timeout=10000)
          assert api({'action': 'draft_read', **identity})['record']['draft'] == 'Owner edit before unlock'
          composer.fill('Local conflicting draft')
          expect(page.locator('.conversation-draft-status')).to_contain_text('Draft saved on host', timeout=10000)
          # Delayed old-session draft reads cannot restore text into a switched binding.
          pending = []
          def delay(route):
            if route.request.post_data_json.get('action') == 'draft_read' and route.request.post_data_json.get('session_id') == 'other-session': pending.append((route, route.fetch()))
            else: route.continue_()
          page.route('**/api/agent', delay)
          page.evaluate('(paneId)=>window.dispatchEvent(new CustomEvent("orbit-select-conversation",{detail:{paneId,profileId:"default",sessionId:"other-session"}}))', pane)
          page.wait_for_function('(id)=>JSON.parse(sessionStorage.getItem(`orbit-hermes-chat:${id}`)).session==="other-session"', arg=pane)
          for _ in range(100):
            if pending: break
            page.wait_for_timeout(50)
          assert pending
          composer.fill('Other conversation draft')
          page.evaluate('(paneId)=>window.dispatchEvent(new CustomEvent("orbit-select-conversation",{detail:{paneId,profileId:"default",sessionId:"saved-session"}}))', pane)
          expect(composer).to_have_value('Local conflicting draft')
          for route, response in pending: route.fulfill(response=response)
          page.wait_for_timeout(800)
          expect(composer).to_have_value('Local conflicting draft')
          page.unroute('**/api/agent', delay)
          # Parent-page selection command -> trusted recipient choice -> full draft preview.
          page.get_by_label('Hermes conversation', exact=True).evaluate('''node => {
            const range=document.createRange();range.selectNodeContents(node.querySelector('.chat-message.assistant .chat-message-text') || node.querySelector('.chat-message.assistant'));
            const selection=window.getSelection();selection.removeAllRanges();selection.addRange(range);
            document.dispatchEvent(new Event('selectionchange'));
          }''')
          page.get_by_role('button', name='Open orbit menu', exact=True).click()
          page.get_by_role('button', name='Send selected text to conversation', exact=True).click()
          transfer = page.get_by_role('dialog', name='Send text to a conversation', exact=True)
          expect(transfer).to_be_visible()
          transfer.get_by_role('radio').first.check()
          transfer.get_by_role('button', name='Insert into draft', exact=True).click()
          preview = page.get_by_role('dialog', name='Preview conversation draft', exact=True)
          expect(preview).to_contain_text('Local conflicting draft')
          expect(preview).to_contain_text('Saved history')
          expect(composer).to_have_value('Local conflicting draft')
          preview.get_by_role('button', name='Confirm append to conversation draft', exact=True).click()
          assert 'Saved history' in composer.input_value()
          expect(page.locator('.conversation-draft-status')).to_contain_text('Draft saved on host', timeout=10000)
          assert 'Saved history' in api({'action': 'draft_read', **identity})['record']['draft']
          # Actual library New window -> parent creates a distinct pane and host validates selection.
          original = page.locator(f'section.pane[data-pane-id="{pane}"]')
          original_draft = composer.input_value()
          original_binding = page.evaluate('(id)=>JSON.parse(sessionStorage.getItem(`orbit-hermes-chat:${id}`))', pane)
          page.evaluate('(paneId)=>window.dispatchEvent(new CustomEvent("orbit-open-conversation-library",{detail:{paneId}}))', pane)
          dialog = page.get_by_role('dialog', name='Conversation library', exact=True)
          dialog.get_by_label('Show archived conversations').check()
          dialog.get_by_label('Search conversations').fill('saved-session')
          expect(dialog.locator('.conversation-library-row')).to_have_count(1)
          with page.expect_response(lambda response: response.url == origin + '/api/agent'
                                    and response.request.post_data_json.get('action') == 'select_session'
                                    and response.request.post_data_json.get('pane_id') != pane) as new_selection:
              dialog.get_by_role('button', name='Open conversation in a new window', exact=True).click()
          selected = new_selection.value
          assert selected.status == 200, selected.text()
          new_pane = selected.request.post_data_json['pane_id']
          assert new_pane != pane and selected.json()['state']['session'] == 'saved-session'
          second = page.locator(f'section.pane[data-pane-id="{new_pane}"]')
          expect(second.get_by_label('Hermes conversation', exact=True)).to_contain_text('Saved history')
          expect(second.get_by_label('Message to Hermes', exact=True)).to_have_value(original_draft)
          expect(original.get_by_label('Message to Hermes', exact=True)).to_have_value(original_draft)
          assert page.evaluate('(id)=>JSON.parse(sessionStorage.getItem(`orbit-hermes-chat:${id}`))', pane) == original_binding

          # Two panes share the host scope but must retain two DIFFERENT recovery copies.
          host = api({'action': 'draft_read', **identity})['record']
          api({'action': 'draft_write', **identity, 'expected_revision': host['revision'], 'text': 'Outside competing draft'})
          original.get_by_label('Message to Hermes', exact=True).fill('Pane one local recovery')
          second.get_by_label('Message to Hermes', exact=True).fill('Pane two local recovery')
          expect(original.locator('.conversation-draft-status')).to_contain_text('Draft conflict', timeout=10000)
          expect(second.locator('.conversation-draft-status')).to_contain_text('Draft conflict', timeout=10000)
          def cached_text(pane_id, session='saved-session'):
              scope = {'workspace_id': workspace, 'profile_id': 'default', 'session_id': session}
              return page.evaluate('({scope,id})=>JSON.parse(sessionStorage.getItem(`orbit-conversation-draft:${JSON.stringify(scope)}:pane:${encodeURIComponent(id)}`)).text', {'scope': scope, 'id': pane_id})
          assert cached_text(pane) == 'Pane one local recovery'
          assert cached_text(new_pane) == 'Pane two local recovery'
          page.reload(wait_until='networkidle'); page.keyboard.press('Escape'); unlock()
          original = page.locator(f'section.pane[data-pane-id="{pane}"]')
          second = page.locator(f'section.pane[data-pane-id="{new_pane}"]')
          expect(original.get_by_label('Message to Hermes', exact=True)).to_have_value('Pane one local recovery')
          expect(second.get_by_label('Message to Hermes', exact=True)).to_have_value('Pane two local recovery')
          expect(original.locator('.conversation-draft-status')).to_contain_text('Draft conflict', timeout=10000)
          expect(second.locator('.conversation-draft-status')).to_contain_text('Draft conflict', timeout=10000)
          assert cached_text(pane) == 'Pane one local recovery'
          assert cached_text(new_pane) == 'Pane two local recovery'

          original.get_by_role('button', name='Replace composer with host draft').click()
          composer = original.get_by_label('Message to Hermes', exact=True)
          def select(session):
              page.evaluate('({paneId,sessionId})=>window.dispatchEvent(new CustomEvent("orbit-select-conversation",{detail:{paneId,profileId:"default",sessionId}}))', {'paneId': pane, 'sessionId': session})
              page.wait_for_function('({pane,session})=>JSON.parse(sessionStorage.getItem(`orbit-hermes-chat:${pane}`)).session===session', arg={'pane': pane, 'session': session})
          def await_pending(pending):
              for _ in range(160):
                  if pending: return
                  page.wait_for_timeout(25)
              raise AssertionError('No deferred draft request observed')

          # X -> Y -> X while X's write is pending reuses X, no extra read/writer.
          held_writes, cycle_reads, cycle_writes = [], [], []
          def delay_write(route):
              body = route.request.post_data_json
              if body.get('session_id') == 'saved-session':
                  if body.get('action') == 'draft_read': cycle_reads.append(body)
                  if body.get('action') == 'draft_write': cycle_writes.append(body)
              if body.get('action') == 'draft_write' and body.get('text') == 'X pending write': held_writes.append((route, route.fetch()))
              else: route.continue_()
          page.route('**/api/agent', delay_write)
          composer.fill('X pending write'); await_pending(held_writes)
          select('other-session'); select('saved-session')
          expect(composer).to_have_value('X pending write')
          composer.fill('X latest after return')
          page.wait_for_timeout(700)
          assert len(cycle_writes) == 1 and not cycle_reads, (cycle_reads, cycle_writes)
          for route, response in held_writes: route.fulfill(response=response)
          expect(original.locator('.conversation-draft-status')).to_contain_text('Draft saved on host', timeout=10000)
          expect(composer).to_have_value('X latest after return')
          assert cached_text(pane) == 'X latest after return'
          assert api({'action': 'draft_read', **identity})['record']['draft'] == 'X latest after return'
          assert [body['text'] for body in cycle_writes] == ['X pending write', 'X latest after return']
          page.unroute('**/api/agent', delay_write)

          # The same cycle with an initial deferred read never creates another X entry.
          held_reads = []
          def delay_read_cycle(route):
              body = route.request.post_data_json
              if body.get('action') == 'draft_read' and body.get('session_id') == 'read-cycle': held_reads.append((route, route.fetch()))
              else: route.continue_()
          page.route('**/api/agent', delay_read_cycle)
          select('read-cycle'); await_pending(held_reads)
          composer.fill('Read cycle initial local')
          select('saved-session'); select('read-cycle')
          expect(composer).to_have_value('Read cycle initial local')
          composer.fill('Read cycle newest local')
          page.wait_for_timeout(700)
          assert len(held_reads) == 1, 'Returning to X launched a duplicate read/controller entry'
          for route, response in held_reads: route.fulfill(response=response)
          expect(original.locator('.conversation-draft-status')).to_contain_text('Draft saved on host', timeout=10000)
          assert cached_text(pane, 'read-cycle') == 'Read cycle newest local'
          assert api({'action': 'draft_read', **identity, 'session_id': 'read-cycle'})['record']['draft'] == 'Read cycle newest local'
          page.unroute('**/api/agent', delay_read_cycle)

          # Instrument actual draft timers, dispose during a deferred save, then
          # release its response. It must not re-cache old text or start retries.
          lifecycle_writes, lifecycle_pending = [], []
          def hold_lifecycle(route):
              body = route.request.post_data_json
              if body.get('action') == 'draft_write' and body.get('session_id') == 'lifecycle-test':
                  lifecycle_writes.append(body); lifecycle_pending.append((route, route.fetch()))
              else: route.continue_()
          page.route('**/api/agent', hold_lifecycle)
          page.evaluate('''async ({workspace,token}) => {
            const {createConversationDraft}=await import('/src/conversation-draft.ts');
            const set=window.setTimeout.bind(window),clear=window.clearTimeout.bind(window),timers=new Set();
            window.__draftTimers=timers;
            window.setTimeout=(callback,delay,...args)=>{
              const tracked=new Error().stack.includes('conversation-draft.ts');
              const id=set(()=>{timers.delete(id);callback(...args);},delay);
              if(tracked)timers.add(id);return id;
            };
            window.clearTimeout=id=>{timers.delete(id);clear(id);};
            let value='';window.__lifecycleStatus='';
            const controller=createConversationDraft({cacheNamespace:'lifecycle-pane',token:()=>token,value:()=>value,restore:text=>{value=text;},status:text=>{window.__lifecycleStatus=text;}});
            const scope={workspace_id:workspace,profile_id:'default',session_id:'lifecycle-test'};
            controller.select(scope,'');
            window.__lifecycle={controller,scope,set:text=>{value=text;controller.edit();}};
          }''', {'workspace': workspace, 'token': token})
          page.wait_for_function('window.__lifecycleStatus === "Draft saved on host."')
          page.evaluate('window.__lifecycle.set("Lifecycle pending write")')
          await_pending(lifecycle_pending)
          page.evaluate('window.__lifecycle.set("Lifecycle newest before disposal");window.__lifecycle.controller.dispose()')
          assert page.evaluate('window.__draftTimers.size') == 0, 'Dispose left a debounce/retry timer'
          for route, response in lifecycle_pending: route.fulfill(response=response)
          page.wait_for_timeout(1500)
          assert len(lifecycle_writes) == 1, 'Disposed controller started another save'
          assert page.evaluate('window.__draftTimers.size') == 0, 'In-flight completion rescheduled after disposal'
          assert cached_text('lifecycle-pane', 'lifecycle-test') == 'Lifecycle newest before disposal'
          page.unroute('**/api/agent', hold_lifecycle)

          # Scope-only migration is copy-only, so a second pane keeps its fallback.
          migration = page.evaluate('''async ({workspace,token})=>{
            const {createConversationDraft}=await import('/src/conversation-draft.ts');
            const scope={workspace_id:workspace,profile_id:'default',session_id:'migration-test'};
            const legacy=`orbit-conversation-draft:${JSON.stringify(scope)}`;
            const raw=JSON.stringify({text:'Legacy recovery owner text',dirty:true,base:'Different host base',revision:0});
            sessionStorage.setItem(legacy,raw);
            const values=[];
            for(const id of ['migration-one','migration-two']) {
              const draft=createConversationDraft({cacheNamespace:id,token:()=>'',value:()=>'',restore:text=>values.push(text),status:()=>{}});
              draft.select(scope,id==='migration-one'?'Pane-specific legacy owner text':'');draft.dispose();
            }
            return {values,unchanged:sessionStorage.getItem(legacy)===raw};
          }''', {'workspace': workspace, 'token': token})
          assert migration == {'values': ['Pane-specific legacy owner text', 'Legacy recovery owner text'], 'unchanged': True}, migration

          # Same-title recipients must stay distinguishable. The fake gateway
          # titles every per-session metadata response 'Saved Hermes title', so
          # the bound panes share one conversation title and the original and
          # secondary panes share one window/title shape too. Each recipient
          # label must lead with its own stable pane discriminator, include its
          # recognizable monitor window name, and identify the conversation.
          saved_before = api({'action': 'draft_read', **identity})['record']['draft']
          other_identity = {'workspace_id': workspace, 'profile_id': 'default', 'session_id': 'other-session'}
          other_before = api({'action': 'draft_read', **other_identity})['record']['draft']
          saved_composer_before = original.get_by_label('Message to Hermes', exact=True).input_value()
          second_composer_before = second.get_by_label('Message to Hermes', exact=True).input_value()

          page.evaluate('(paneId)=>window.dispatchEvent(new CustomEvent("orbit-open-conversation-library",{detail:{paneId}}))', pane)
          dialog = page.get_by_role('dialog', name='Conversation library', exact=True)
          dialog.get_by_label('Search conversations').fill('other-session')
          expect(dialog.locator('.conversation-library-row')).to_have_count(1)
          with page.expect_response(lambda response: response.url == origin + '/api/agent'
                                    and response.request.post_data_json.get('action') == 'select_session'
                                    and response.request.post_data_json.get('target_session_id') == 'other-session') as third_selection:
            dialog.get_by_role('button', name='Open conversation in a new window', exact=True).click()
          third_pane = third_selection.value.request.post_data_json['pane_id']
          assert third_pane not in (pane, new_pane)
          third = page.locator(f'section.pane[data-pane-id="{third_pane}"]')
          expect(third.get_by_label('Hermes conversation', exact=True)).to_contain_text('Saved history')
          expect(third.locator('.conversation-draft-status')).to_contain_text('Draft saved on host', timeout=10000)
          third.get_by_label('Message to Hermes', exact=True).fill('Third pane draft')
          expect(third.locator('.conversation-draft-status')).to_contain_text('Draft saved on host', timeout=10000)
          assert api({'action': 'draft_read', **other_identity})['record']['draft'] == 'Third pane draft'

          # Open the real transfer dialog and inspect every registered recipient.
          page.evaluate('''async () => {
            const m = await import('/src/conversation-transfer.ts');
            window.__recipientOutcome = m.requestConversationContext({text: 'Recipient identity probe', title: 'Recipient identity probe'});
          }''')
          transfer = page.get_by_role('dialog', name='Send text to a conversation', exact=True)
          expect(transfer).to_be_visible()
          recipients = page.evaluate('''() => [...document.querySelectorAll('dialog.conversation-transfer input[type=radio]')].map(radio => ({value: radio.value, label: radio.getAttribute('aria-label')}))''')
          assert len(recipients) == 3, recipients
          labels = [entry['label'] for entry in recipients]
          assert all(labels) and len(set(labels)) == len(labels), recipients
          for pane_id in (pane, new_pane, third_pane):
            entry = next(item for item in recipients if item['value'] == f'chat:{workspace}:{pane_id}')
            assert pane_id in entry['label'], (pane_id, entry)
            window_name = page.locator(f'section.pane[data-pane-id="{pane_id}"]').evaluate(
              "node => node.closest('.monitor').querySelector('.monitor-bar strong').textContent.trim()")
            assert window_name in entry['label'], (window_name, entry)
          third_value = f'chat:{workspace}:{third_pane}'
          transfer.locator(f'input[type="radio"][value="{third_value}"]').check()
          transfer.get_by_role('button', name='Insert into draft', exact=True).click()
          preview = page.get_by_role('dialog', name='Preview conversation draft', exact=True)
          expect(preview).to_contain_text('Third pane draft')
          expect(preview).to_contain_text('Recipient identity probe')
          # The confirmation names the same recipient identity as the radio.
          assert third_pane in preview.inner_text(), preview.inner_text()
          preview.get_by_role('button', name='Confirm append to conversation draft', exact=True).click()
          expect(third.locator('.conversation-draft-status')).to_contain_text('Draft saved on host', timeout=10000)

          # Only the chosen pane's host draft changes. The same-title sibling
          # panes, their composers and the untouched saved-session draft are not
          # changed by a delivery to a different recipient.
          other_after = api({'action': 'draft_read', **other_identity})['record']['draft']
          assert other_after == 'Third pane draft\n\nRecipient identity probe', other_after
          assert api({'action': 'draft_read', **identity})['record']['draft'] == saved_before
          assert other_after == third.get_by_label('Message to Hermes', exact=True).input_value()
          expect(original.get_by_label('Message to Hermes', exact=True)).to_have_value(saved_composer_before)
          expect(second.get_by_label('Message to Hermes', exact=True)).to_have_value(second_composer_before)
          outcome = page.evaluate('window.__recipientOutcome')
          assert outcome['status'] == 'delivered', outcome
          assert not errors, errors
          assert not any(call.startswith('UNEXPECTED POST') for call in calls), calls
          print('PASS: library rename CAS retains edit, search/pin/archive/reopen/new-window, durable drafts, per-pane conflict reload, X-Y-X deferred read/write, teardown timer fence, copy-only migration, selected-context preview/append/save, distinct same-title recipient identity and exact-pane delivery')
          browser.close()
      finally:
        dev.terminate()
        try: dev.wait(timeout=10)
        except subprocess.TimeoutExpired: dev.kill(); dev.wait()
        server.terminate()
        try: server.wait(timeout=10)
        except subprocess.TimeoutExpired: server.kill(); server.wait()
finally:
    gateway.shutdown(); gateway.server_close()
