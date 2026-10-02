"""Real disposable HTTP server + Chromium + rendered host acceptance.

ORBIT_BROWSER_EXECUTABLE=/tmp/opencode/orbit-evolution-browsers/chromium-1208/chrome-linux64/chrome \
  /tmp/opencode/orbit-evolution-browser-venv/bin/python tests/browser-copilot.browser.py
"""
import json, os, pathlib, subprocess, tempfile, shutil
from playwright.sync_api import sync_playwright, expect

ROOT = pathlib.Path(__file__).resolve().parents[1]
executable = os.environ.get('ORBIT_BROWSER_EXECUTABLE')
if not executable:
    raise SystemExit('ORBIT_BROWSER_EXECUTABLE must explicitly name the disposable test Chromium')
home = tempfile.mkdtemp(prefix='browser-copilot-home-', dir='/tmp/opencode')
env = {**os.environ, 'HOME': home, 'ORBIT_BROWSER_EXECUTABLE': executable, 'ORBIT_TMUX_SOCKET': 'orbit-copilot-fixture', 'ORBIT_TMUX_CONFIG': '/dev/null'}
process = subprocess.Popen(['node', '--experimental-strip-types', 'tests/browser-copilot-fixture.mjs'], cwd=ROOT, env=env, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
try:
    while True:
        line = process.stdout.readline()
        if not line:
            raise RuntimeError(process.stderr.read())
        if line.startswith('{'):
            config = json.loads(line)
            break
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(executable_path=executable, headless=True)
        context = browser.new_context(viewport={'width': 1100, 'height': 1000})
        page = context.new_page()
        errors=[]
        page.on('pageerror', lambda e: errors.append(str(e)))
        calls=[]
        page.on('request',lambda req: calls.append(req.post_data_json['action']) if req.url.endswith('/api/browser-copilot') else None)
        page.goto(config['url']+'/?locked=1')
        expect(page.get_by_role('status')).to_have_text('Connect host to enable workspace control.')
        draft_url=config['url']+'/fixture'
        page.get_by_label('Start / navigation URL').fill(draft_url)
        page.get_by_label('Fill text (never passwords or uploads)').fill('Draft preserved across unlock')
        page.get_by_label('Action',exact=True).select_option('fill')
        page.get_by_role('button',name='Unlock fixture host',exact=True).click()
        expect(page.get_by_role('status')).to_contain_text('Playwright 1.58.0 ready',timeout=15000)
        expect(page.get_by_label('Disposable session').locator('option')).to_have_count(1)
        assert calls==['capability','list'], calls
        expect(page.get_by_label('Start / navigation URL')).to_have_value(draft_url)
        expect(page.get_by_label('Fill text (never passwords or uploads)')).to_have_value('Draft preserved across unlock')
        # An old real response arrives after relock. Generation checks, rather
        # than fetch cancellation alone, must prevent status/list restoration.
        page.get_by_role('button',name='Hold next capability response',exact=True).click()
        page.get_by_role('button',name='Reconnect fixture host',exact=True).click()
        expect(page.locator('#held')).to_have_text('Capability response held',timeout=15000)
        page.get_by_role('button',name='Lock fixture host',exact=True).click()
        expect(page.get_by_role('status')).to_have_text('Connect host to enable workspace control.')
        page.get_by_role('button',name='Release held response',exact=True).click()
        page.wait_for_timeout(600)
        expect(page.get_by_role('status')).to_have_text('Connect host to enable workspace control.')
        expect(page.get_by_label('Disposable session').locator('option')).to_have_count(0)
        assert calls==['capability','list','capability'], calls
        page.get_by_role('button',name='Unlock fixture host',exact=True).click()
        expect(page.get_by_role('status')).to_contain_text('Playwright 1.58.0 ready',timeout=15000)
        assert calls==['capability','list','capability','capability','list'], calls
        expect(page.get_by_label('Fill text (never passwords or uploads)')).to_have_value('Draft preserved across unlock')
        assert 'open' not in calls and 'execute' not in calls
        page.get_by_role('button',name='Hold next capability response',exact=True).click()
        page.get_by_role('button',name='Reconnect fixture host',exact=True).click()
        expect(page.locator('#held')).to_have_text('Capability response held',timeout=15000)
        original_workspace=page.evaluate("localStorage.getItem('orbit.workspace.id')")
        page.evaluate("localStorage.setItem('orbit.workspace.id',crypto.randomUUID());window.dispatchEvent(new Event('orbit-host-connected'))")
        expect(page.get_by_role('status')).to_have_text('Workspace binding changed; reopen Browser Copilot in this workspace.')
        count=len(calls)
        page.get_by_role('button',name='Release held response',exact=True).click()
        page.wait_for_timeout(600)
        expect(page.get_by_role('status')).to_have_text('Workspace binding changed; reopen Browser Copilot in this workspace.')
        assert len(calls)==count, calls
        page.evaluate("scope=>{localStorage.setItem('orbit.workspace.id',scope);window.dispatchEvent(new Event('orbit-host-connected'));}",original_workspace)
        expect(page.get_by_role('status')).to_contain_text('Playwright 1.58.0 ready',timeout=15000)
        expect(page.get_by_label('Start / navigation URL')).to_have_value(draft_url)
        expect(page.get_by_label('Fill text (never passwords or uploads)')).to_have_value('Draft preserved across unlock')
        page.get_by_role('button',name='Hold next capability response',exact=True).click()
        page.get_by_role('button',name='Reconnect fixture host',exact=True).click()
        expect(page.locator('#held')).to_have_text('Capability response held',timeout=15000)
        page.get_by_role('button',name='Dispose fixture pane',exact=True).click()
        expect(page.locator('.browser-copilot')).to_have_count(0)
        count=len(calls)
        page.get_by_role('button',name='Reconnect fixture host',exact=True).click()
        page.wait_for_timeout(600)
        assert len(calls)==count, calls
        page.goto(config['url'])
        expect(page.get_by_role('status')).not_to_contain_text('Checking',timeout=15000)
        page.get_by_label('Start / navigation URL').fill(config['url']+'/fixture')
        page.get_by_role('button',name='Start disposable browser',exact=True).click()
        try:
            expect(page.locator('.bc-snapshot')).to_contain_text('Counter 0',timeout=20000)
        except Exception:
            print(page.locator('body').inner_text())
            raise
        expect(page.locator('.bc-evidence img')).to_have_count(1)
        page.get_by_role('button',name='Snapshot selected target',exact=True).click()
        expect(page.get_by_label('Observation text (select an excerpt to share)')).to_have_value(__import__('re').compile('Counter 0'))
        page.evaluate('''async()=>{const {registerConversationRecipient}=await import('/src/conversation-transfer.ts');registerConversationRecipient({id:'browser-evidence',title:'Browser evidence recipient',receive:d=>{window.evidenceDelivery=d;return {accepted:true};}});}''')
        page.get_by_role('button',name='Share selected observation',exact=True).click()
        page.get_by_role('dialog').get_by_role('radio').check()
        page.get_by_role('button',name='Insert into draft',exact=True).click()
        shared=json.loads(page.evaluate('window.evidenceDelivery.text'))
        assert 'Counter 0' in shared['text'] and len(shared['observation_sha256'])==64 and shared['captured_at']>0
        assert 'data_base64' not in shared
        # The controls operate through the real authenticated Node driver route.
        page.get_by_label('Action',exact=True).select_option('click')
        options=page.get_by_label('Snapshot control reference').locator('option')
        ref=next(o.get_attribute('value') for o in options.all() if 'Increment' in o.inner_text())
        count=len(calls)
        page.get_by_label('Proposed action JSON (stages controls only)').fill(json.dumps({'kind':'click','ref':ref}))
        page.get_by_role('button',name='Stage proposed action',exact=True).click()
        expect(page.locator('.bc-preview')).to_contain_text('Suggestion staged in controls only')
        assert len(calls)==count
        expect(page.get_by_label('Snapshot control reference')).to_have_value(ref)
        page.get_by_role('button',name='Preview action',exact=True).click()
        expect(page.locator('.bc-preview')).to_contain_text('Review exact action',timeout=15000)
        page.get_by_role('button',name='Execute reviewed action once',exact=True).click()
        expect(page.locator('.bc-snapshot')).to_contain_text('Counter 1',timeout=15000)
        expect(page.locator('.bc-evidence img')).to_have_count(2)
        expect(page.locator('.bc-evidence figcaption').first).to_contain_text('Before')
        expect(page.locator('.bc-evidence figcaption').last).to_contain_text('After')
        for image in page.locator('.bc-evidence img').all():
            expect(image).to_be_visible()
            assert image.evaluate('(image)=>image.complete && image.naturalWidth > 0')
        assert page.locator('.bc-evidence img').first.get_attribute('src') != page.locator('.bc-evidence img').last.get_attribute('src')
        page.screenshot(path='/tmp/opencode/browser-copilot-action.png',full_page=True)
        page.get_by_role('button',name='Pause',exact=True).click()
        expect(page.get_by_role('button',name='Resume',exact=True)).to_be_visible()
        page.get_by_role('button',name='Preview action',exact=True).click()
        expect(page.get_by_role('status')).to_have_text('permission_denied')
        page.get_by_role('button',name='Resume',exact=True).click()
        expect(page.get_by_role('button',name='Pause',exact=True)).to_be_visible()
        # Fill via the actual bounded action, then use its rendered screenshot.
        page.get_by_label('Action',exact=True).select_option('fill')
        ref=next(o.get_attribute('value') for o in options.all() if 'Note' in o.inner_text())
        page.get_by_label('Snapshot control reference').select_option(ref)
        page.get_by_label('Fill text (never passwords or uploads)').fill('Synthetic owner note')
        page.get_by_label('Control mode (same exact tab)').select_option('manual')
        page.get_by_role('button',name='Preview action',exact=True).click()
        expect(page.locator('.bc-preview')).to_contain_text('Synthetic owner note',timeout=15000)
        page.get_by_role('button',name='Execute reviewed action once',exact=True).click()
        expect(page.locator('pre').last).to_contain_text('"operation_kind": "fill"',timeout=15000)
        expect(page.locator('pre').last).to_contain_text('"mode": "manual"')
        # Popup creates a second exact target in this disposable context.
        page.get_by_label('Action',exact=True).select_option('click')
        ref=next(o.get_attribute('value') for o in options.all() if 'Open neighbor' in o.inner_text())
        page.get_by_label('Snapshot control reference').select_option(ref)
        page.get_by_role('button',name='Preview action',exact=True).click()
        expect(page.locator('.bc-preview')).to_contain_text('"kind": "click"',timeout=15000)
        page.get_by_role('button',name='Execute reviewed action once',exact=True).click()
        expect(page.locator('pre').last).to_contain_text('"operation_kind": "click"',timeout=15000)
        page.get_by_role('button',name='Refresh exact targets',exact=True).click()
        expect(page.get_by_label('Exact target').locator('option')).to_have_count(2,timeout=15000)
        selected=page.get_by_label('Exact target').input_value()
        session=page.get_by_label('Disposable session').input_value()
        neighbor=next(o.get_attribute('value') for o in page.get_by_label('Exact target').locator('option').all() if o.get_attribute('value')!=selected)
        headers={'Authorization':'Bearer '+config['token'],'Origin':config['url']}
        workspace=page.evaluate("localStorage.getItem('orbit.workspace.id')")
        def api(action,**fields):
            return context.request.post(config['url']+'/api/browser-copilot',headers=headers,data={'action':action,'workspace_id':workspace,**fields})
        current=api('targets',session_id=session).json()['session']['revision']
        staged=api('preview',session_id=session,target_id=selected,expected_revision=current,mode='owner',operation={'kind':'click','ref':'r0'}).json()['proposal']
        # Close the chosen tab, then try observe and a stale proposal, never fallback.
        page.get_by_role('button',name='Close selected target',exact=True).click()
        expect(page.get_by_label('Exact target').locator('option').filter(has_text='closed')).to_have_count(1,timeout=15000)
        page.get_by_role('button',name='Snapshot selected target',exact=True).click()
        expect(page.get_by_role('status')).to_have_text('stale_resource')
        assert api('observe',session_id=session,target_id=selected).status==409
        assert api('execute',session_id=session,target_id=selected,expected_revision=current,proposal_id=staged['proposal_id'],op_key='closed-real-target').status==409
        other=api('observe',session_id=session,target_id=neighbor)
        assert other.status==200, other.text()
        assert 'Neighbor untouched' in other.json()['observation']['text']
        assert 'WRONG TARGET MUTATED' not in other.json()['observation']['text']
        # Remaining finite primitives use real driver calls, not mocked responses.
        for number,operation in enumerate([{'kind':'scroll','dy':700},{'kind':'snapshot'},{'kind':'navigate','url':config['url']+'/neighbor'}]):
            revision=api('targets',session_id=session).json()['session']['revision']
            p=api('preview',session_id=session,target_id=neighbor,expected_revision=revision,mode='owner',operation=operation).json()['proposal']
            result=api('execute',session_id=session,target_id=neighbor,expected_revision=revision,proposal_id=p['proposal_id'],op_key='primitive-'+str(number)).json()['receipt']
            assert result['status']=='completed', result
            assert result['result']['target_id']==neighbor
        assert context.request.post(config['url']+'/api/browser-copilot',data={'action':'list','workspace_id':workspace}).status==403
        current=api('targets',session_id=session).json()['session']['revision']
        forbidden=api('preview',session_id=session,target_id=neighbor,expected_revision=current,mode='owner',operation={'kind':'navigate','url':'file:///etc/passwd'})
        assert forbidden.status==403
        assert not errors, errors
        shot='/tmp/opencode/browser-copilot-acceptance.png'
        page.screenshot(path=shot,full_page=True)
        page.get_by_role('button',name='Close disposable session',exact=True).click()
        context.close();browser.close()
        print('PASS real Node route + rendered Chromium host: locked mount/unlock/reconnect, draft preservation, no implicit launch, stale actual response ignored, disposed listeners/timer; click, fill/manual, before/after images, pause, two targets, selected-close refusal, neighbor untouched, auth, forbidden navigation. Screenshot: '+shot)
finally:
    process.terminate()
    try: process.wait(timeout=20)
    except subprocess.TimeoutExpired: process.kill();process.wait()
    shutil.rmtree(home,ignore_errors=True)
