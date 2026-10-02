"""Standalone real-browser fixture for selected-context transfer.

Imports `src/conversation-transfer.ts` directly through an isolated Vite server
(no owner runtime, terminals, providers or full app boot). Verifies the recipient
registry and host dialog: the chosen target receives once, cancel delivers
nothing, a stale/disconnected recipient fails with the preview retained,
disconnected recipients are omitted, the HTML preview is inert, no network or
model send happens, and the character bound is reported instead of silently
truncated.
"""
from pathlib import Path
import shutil
import socket
import subprocess
import tempfile
import time
import urllib.request

from playwright.sync_api import expect, sync_playwright

ROOT = Path(__file__).resolve().parents[1]
with tempfile.TemporaryDirectory(prefix='orbit-conversation-transfer-', dir='/tmp/opencode') as temporary:
    root = Path(temporary)
    for name in ('src', 'contracts', 'server', 'scripts', 'docs'):
        shutil.copytree(ROOT / name, root / name)
    for name in ('package.json', 'package-lock.json', 'tsconfig.json', 'vite.config.js'):
        shutil.copy2(ROOT / name, root / name)
    (root / 'node_modules').symlink_to(ROOT / 'node_modules', target_is_directory=True)
    (root / 'fixture.html').write_text(
        '<!doctype html><html><head><meta charset="utf-8">'
        '<title>conversation-transfer fixture</title></head><body>'
        "<script type=\"module\">import * as transfer from '/src/conversation-transfer.ts';"
        'window.transfer = transfer; window.__ready = true;</script></body></html>',
        encoding='utf-8')
    with socket.socket() as probe:
        probe.bind(('127.0.0.1', 0))
        port = probe.getsockname()[1]
    origin = f'http://127.0.0.1:{port}'
    server = subprocess.Popen([str(ROOT / 'node_modules/.bin/vite'), '--host', '127.0.0.1',
                               '--port', str(port), '--strictPort'], cwd=root,
                              stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    try:
        for _ in range(150):
            if server.poll() is not None:
                raise RuntimeError('Isolated Vite exited')
            try:
                urllib.request.urlopen(origin + '/fixture.html', timeout=1).close()
                break
            except OSError:
                time.sleep(.1)
        else:
            raise RuntimeError('Isolated Vite readiness timeout')
        with sync_playwright() as playwright:
            browser = playwright.chromium.launch(headless=True, args=['--no-sandbox',
                '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'])
            context = browser.new_context(viewport={'width': 1280, 'height': 900})
            page = context.new_page()
            errors = []
            page.on('pageerror', lambda error: errors.append(str(error)))
            api_calls = []
            page.route('**/api/**', lambda route: (api_calls.append(route.request.url),
                                                   route.fulfill(status=200, content_type='application/json', body='{}')))
            page.goto(origin + '/fixture.html')
            page.wait_for_function('window.__ready === true')
            page.evaluate('''()=>{
              window.__storageBefore=JSON.stringify([Object.keys(localStorage).sort(),Object.keys(sessionStorage).sort()]);
              window.__fetchCalls=0;
              const realFetch=window.fetch.bind(window);
              window.fetch=(...args)=>{window.__fetchCalls++;return realFetch(...args);};
              window.__calls=[];
              window.__regA=window.transfer.registerConversationRecipient({id:'pane-a',title:'Pane A',available:true,receive:d=>{window.__calls.push({id:'pane-a',delivery:d});return {accepted:true};}});
              window.__regB=window.transfer.registerConversationRecipient({id:'pane-b',title:'Pane B',available:true,receive:d=>{window.__calls.push({id:'pane-b',delivery:d});return {accepted:true};}});
            }''')
            summaries = page.evaluate('window.transfer.listConversationRecipients()')
            assert {s['id'] for s in summaries} == {'pane-a', 'pane-b'}, summaries

            # 1. Explicit target receives exactly once; the preview is inert HTML.
            payload = 'Hello <img src=x onerror="window.__pwned=1"> world'
            page.evaluate('''text=>{window.__open1=window.transfer.requestConversationContext({text,title:'Selected note',source:'workspace selection'});}''', payload)
            dialog = page.locator('dialog.conversation-transfer')
            expect(dialog).to_have_count(1)
            preview = dialog.locator('.conversation-transfer-preview')
            expect(preview).to_have_text(payload)
            assert preview.locator('img').count() == 0, 'Preview rendered markup instead of inert text'
            assert page.evaluate('window.__pwned') is None
            assert page.evaluate('window.__calls.length') == 0
            insert = dialog.get_by_role('button', name='Insert into draft')
            expect(dialog.get_by_role('radio')).to_have_count(2)
            expect(insert).to_be_disabled()
            dialog.get_by_role('radio', name='Pane B').check()
            expect(insert).to_be_enabled()
            insert.click()
            assert page.evaluate('window.__open1') == {'status': 'delivered', 'recipientId': 'pane-b'}
            assert dialog.count() == 0, 'Dialog stayed open after a successful insert'
            calls = page.evaluate('window.__calls')
            assert len(calls) == 1 and calls[0]['id'] == 'pane-b', calls
            delivery = calls[0]['delivery']
            assert delivery['text'] == payload
            assert delivery['title'] == 'Selected note' and delivery['source'] == 'workspace selection'
            assert delivery['truncated'] is False and delivery['originalLength'] == len(payload)

            # 2. Cancel delivers nothing.
            page.evaluate("()=>{window.__calls.length=0;window.__open2=window.transfer.requestConversationContext({text:'cancel me'});}")
            dialog = page.locator('dialog.conversation-transfer')
            expect(dialog).to_have_count(1)
            dialog.get_by_role('radio', name='Pane A', exact=True).check()
            dialog.get_by_role('button', name='Cancel').click()
            assert page.evaluate('window.__open2') == {'status': 'cancelled'}
            assert dialog.count() == 0
            assert page.evaluate('window.__calls.length') == 0

            # 3. Unavailable and disposed recipients are omitted from the target list.
            page.evaluate('''()=>{
              window.__regOff=window.transfer.registerConversationRecipient({id:'pane-off',title:'Pane Off',available:false,receive:()=>({accepted:true})});
              const gone=window.transfer.registerConversationRecipient({id:'pane-gone',title:'Pane Gone',available:true,receive:()=>({accepted:true})});
              gone.dispose();
              window.__open3=window.transfer.requestConversationContext({text:'targets'});
            }''')
            dialog = page.locator('dialog.conversation-transfer')
            expect(dialog.get_by_role('radio')).to_have_count(2)
            names = page.evaluate("[...document.querySelectorAll('dialog.conversation-transfer input[type=radio]')].map(r=>r.getAttribute('aria-label'))")
            assert names == ['Pane A', 'Pane B'], names
            dialog.get_by_role('button', name='Cancel').click()
            assert page.evaluate('window.__open3') == {'status': 'cancelled'}

            # 4. A stale/disconnected selected target is refused while the preview stays.
            page.evaluate('''()=>{
              window.__calls.length=0;
              window.__regStale=window.transfer.registerConversationRecipient({id:'pane-stale',title:'Pane Stale',available:true,receive:d=>{window.__calls.push({id:'pane-stale',delivery:d});return {accepted:true};}});
              window.__regAsync=window.transfer.registerConversationRecipient({id:'pane-async',title:'Pane Async',available:true,receive:async d=>{window.__calls.push({id:'pane-async',delivery:d});await new Promise(r=>setTimeout(r,25));return {accepted:false,reason:'conversation changed'};}});
              window.__open4=window.transfer.requestConversationContext({text:'keep this preview',source:'selection'});
            }''')
            dialog = page.locator('dialog.conversation-transfer')
            dialog.get_by_role('radio', name='Pane Stale').check()
            page.evaluate('window.__regStale.dispose()')
            dialog.get_by_role('button', name='Insert into draft').click()
            expect(dialog).to_have_count(1)
            expect(dialog.locator('.conversation-transfer-preview')).to_have_text('keep this preview')
            expect(dialog.locator('.conversation-transfer-status')).to_contain_text('no longer available')
            assert page.evaluate('window.__calls.length') == 0, 'Disposed recipient was still called'

            # 4b. A changed live binding can also decline asynchronously; the
            # preview is retained and the outcome is not a delivery.
            dialog.get_by_role('radio', name='Pane Async').check()
            dialog.get_by_role('button', name='Insert into draft').click()
            page.wait_for_function("document.querySelector('.conversation-transfer-status').textContent.includes('conversation changed')")
            expect(dialog).to_have_count(1)
            expect(dialog.locator('.conversation-transfer-preview')).to_have_text('keep this preview')
            calls = page.evaluate('window.__calls')
            assert [c['id'] for c in calls] == ['pane-async'], calls
            dialog.get_by_role('button', name='Cancel').click()
            assert page.evaluate('window.__open4') == {'status': 'rejected', 'recipientId': 'pane-async', 'reason': 'conversation changed'}

            # 5. The character bound is reported, not silently truncated.
            page.evaluate('''()=>{
              window.__calls.length=0;
              window.__open5=window.transfer.requestConversationContext({text:'a'.repeat(20000)+'b'.repeat(5000),title:'Big selection'});
            }''')
            dialog = page.locator('dialog.conversation-transfer')
            expect(dialog).to_have_count(1)
            assert page.evaluate("document.querySelector('.conversation-transfer-preview').textContent === 'a'.repeat(20000)")
            expect(dialog.locator('.conversation-transfer-bound')).to_contain_text('20000')
            expect(dialog.locator('.conversation-transfer-bound')).to_contain_text('5000')
            dialog.get_by_role('radio', name='Pane A', exact=True).check()
            dialog.get_by_role('button', name='Insert into draft').click()
            assert page.evaluate('window.__open5') == {'status': 'delivered', 'recipientId': 'pane-a'}
            expect(dialog).to_have_count(0)
            delivery = page.evaluate('window.__calls')[0]['delivery']
            assert delivery['truncated'] is True and delivery['originalLength'] == 25000
            assert len(delivery['text']) == 20000 and delivery['text'] == 'a' * 20000

            # The selected pane can disappear after the click handler but before
            # its queued delivery microtask. Its callback must never run.
            page.evaluate('''()=>{
              window.__calls.length=0;
              window.__race=window.transfer.registerConversationRecipient({id:'race',title:'Race target',receive:d=>{window.__calls.push(d);return {accepted:true};}});
              window.__raceOpen=window.transfer.requestConversationContext({text:'race preview'});
            }''')
            dialog = page.locator('dialog.conversation-transfer')
            dialog.get_by_role('radio', name='Race target', exact=True).check()
            page.evaluate('''()=>{
              document.querySelector('.conversation-transfer-insert').click();
              window.__race.dispose();
            }''')
            expect(dialog.locator('.conversation-transfer-status')).to_contain_text('no longer available')
            assert page.evaluate('window.__calls.length') == 0
            dialog.get_by_role('button', name='Cancel', exact=True).click()
            assert page.evaluate('window.__raceOpen')['status'] == 'rejected'

            # 6. With every recipient gone the dialog still reports truthfully.
            page.evaluate('''()=>{
              window.__regA.dispose(); window.__regB.dispose(); window.__regAsync.dispose(); window.__regOff.dispose();
              window.__calls.length=0;
              window.__open6=window.transfer.requestConversationContext({text:'nobody home'});
            }''')
            dialog = page.locator('dialog.conversation-transfer')
            expect(dialog).to_have_count(1)
            expect(dialog.get_by_role('radio')).to_have_count(0)
            expect(dialog.locator('.conversation-transfer-none')).to_contain_text('No conversation')
            expect(dialog.get_by_role('button', name='Insert into draft')).to_be_disabled()
            dialog.get_by_role('button', name='Cancel').click()
            assert page.evaluate('window.__open6') == {'status': 'no-recipient'}
            assert page.evaluate('window.__calls.length') == 0

            # Exact final draft review, source validation and changed-draft races.
            page.evaluate('''()=>{
              window.ownerDraft='existing';window.revoked=false;
              window.transfer.registerConversationRecipient({id:'prepared',title:'Prepared chat',receive:()=>{throw Error('Legacy receive must not run');},prepare:delivery=>{
                const original=window.ownerDraft, text=original+'\\n\\n'+delivery.text;
                return {text,commit:()=>{if(window.ownerDraft!==original)return {accepted:false,reason:'Draft changed'};window.ownerDraft=text;return {accepted:true};}};
              }});
              window.transfer.requestConversationContext({text:'evidence',validate:()=>{if(window.revoked)throw Error('Source revoked');}});
            }''')
            dialog = page.locator('dialog.conversation-transfer')
            dialog.get_by_role('radio',name='Prepared chat').check()
            expect(dialog.locator('.conversation-transfer-preview')).to_have_text('existing\n\nevidence')
            page.evaluate('window.revoked=true')
            dialog.get_by_role('button',name='Insert into draft').click()
            expect(dialog.locator('.conversation-transfer-status')).to_contain_text('Source revoked')
            assert page.evaluate('window.ownerDraft') == 'existing'
            page.evaluate("window.revoked=false;window.ownerDraft='new edit'")
            dialog.get_by_role('button',name='Insert into draft').click()
            expect(dialog.locator('.conversation-transfer-status')).to_contain_text('Draft changed')
            assert page.evaluate('window.ownerDraft') == 'new edit'
            dialog.get_by_role('radio',name='Prepared chat').click()
            expect(dialog.locator('.conversation-transfer-preview')).to_have_text('new edit\n\nevidence')
            dialog.get_by_role('button',name='Insert into draft').click()
            expect(dialog).to_have_count(0)
            assert page.evaluate('window.ownerDraft') == 'new edit\n\nevidence'

            # 7. No network request, no model send and no private persistence.
            assert page.evaluate('window.__fetchCalls') == 0, 'Transfer issued a fetch'
            assert api_calls == [], api_calls
            storage_after = page.evaluate('JSON.stringify([Object.keys(localStorage).sort(),Object.keys(sessionStorage).sort()])')
            assert page.evaluate('window.__storageBefore') == storage_after, 'Transfer wrote to browser storage'
            assert page.locator('iframe').count() == 0, 'Fixture unexpectedly hosts a frame'
            assert not errors, errors
            browser.close()
            print('PASS conversation transfer: chosen target receives once, cancel/HTML inert, stale and async-refused recipients keep the preview, disconnected targets omitted, no-recipient reported, no network/send/storage, bounded preview reports omissions')
    finally:
        server.terminate()
        server.wait(timeout=10)
