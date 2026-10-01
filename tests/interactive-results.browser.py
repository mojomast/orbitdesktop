"""Real pinned A2UI renderer in a disposable Vite root; no owner workspace."""
import json
import re
import os
from pathlib import Path
import socket
import subprocess
import tempfile
import time
import urllib.request
import sys
from playwright.sync_api import sync_playwright, expect

ROOT = Path(__file__).resolve().parents[1]
os.environ.setdefault('PLAYWRIGHT_BROWSERS_PATH', '/tmp/opencode/orbit-evolution-browsers')

def run():
    with tempfile.TemporaryDirectory(prefix='orbit-interactive-', dir='/tmp/opencode') as directory:
        root = Path(directory)
        (root / 'node_modules').symlink_to(ROOT / 'node_modules')
        (root / 'src').symlink_to(ROOT / 'src')
        (root / 'contracts').symlink_to(ROOT / 'contracts')
        with socket.socket() as probe:
            probe.bind(('127.0.0.1', 0))
            port = probe.getsockname()[1]
        origin = f'http://127.0.0.1:{port}'
        (root / 'index.html').write_text('<div id="host"></div><script type="module" src="/fixture.js"></script>')
        spike = '''
          import {MessageProcessor} from '@a2ui/web_core/v0_9';
          import {A2uiSurface,basicCatalog} from '@a2ui/lit/v0_9';
          const processor=new MessageProcessor([basicCatalog]);
          processor.processMessages([
            {version:'v0.9',createSurface:{surfaceId:'comparison',catalogId:basicCatalog.id}},
            {version:'v0.9',updateComponents:{surfaceId:'comparison',components:[
              {id:'root',component:'Column',children:['heading','notes']},
              {id:'heading',component:'Text',text:'Editable comparison'},
              {id:'notes',component:'TextField',label:'Decision notes',value:{path:'/notes'}}]}},
            {version:'v0.9',updateDataModel:{surfaceId:'comparison',path:'/',value:{notes:'Initial'}}}
          ]);
          const surface=document.createElement('a2ui-surface');
          surface.surface=processor.getSurface('comparison');
          document.querySelector('#host').append(surface);
        '''
        (root / 'fixture.js').write_text(spike)
        (root / 'vite.config.mjs').write_text('''
          import {createInteractiveResults} from ''' + json.dumps(str(ROOT / 'server/interactive-results.mjs')) + ''';
          const feature=createInteractiveResults({root:''' + json.dumps(str(root / 'private')) + ''',workspaceRead:()=>({id:'fixture'})});
          export default {server:{fs:{allow:[''' + json.dumps(str(ROOT)) + ',' + json.dumps(str(root)) + ''']}},plugins:[{name:'private-fixture',configureServer(server){
            server.middlewares.use(async(req,res,next)=>{
              if(!req.url.startsWith('/api/'))return next();
              let text='';for await(const chunk of req)text+=chunk;
              const body=JSON.parse(text||'{}');let output;
              try{
                if(req.url==='/api/interactive-results'){
                  if(req.headers.authorization!=='Bearer fixture-token')throw Error('Missing fixture authentication');
                  output=await feature.dispatch(body);
                }else output={revision:1,state:body.state,workspace_id:body.workspace_id,events:[],cursor:0};
                res.setHeader('Content-Type','application/json');res.end(JSON.stringify({...output,ok:true}));
              }catch(error){res.statusCode=error.code==='stale_resource'||error.code==='conflict'?409:400;res.setHeader('Content-Type','application/json');res.end(JSON.stringify({ok:false,code:error.code,error:error.message}));}
            });
          }}]};
        ''')
        build=subprocess.run([str(ROOT / 'node_modules/.bin/vite'),'build'],cwd=root,capture_output=True,text=True)
        assert build.returncode==0, build.stdout+build.stderr
        server = subprocess.Popen([str(ROOT / 'node_modules/.bin/vite'), '--host', '127.0.0.1', '--port', str(port), '--strictPort'], cwd=root, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        try:
            for _ in range(150):
                try:
                    urllib.request.urlopen(origin, timeout=1).close()
                    break
                except OSError:
                    time.sleep(.1)
            with sync_playwright() as playwright:
                browser = playwright.chromium.launch(headless=True, args=['--no-sandbox'])
                page = browser.new_page(viewport={'width': 380, 'height': 760})
                errors = []
                page.on('pageerror', lambda error: errors.append(str(error)))
                page.goto(origin)
                expect(page.locator('a2ui-surface')).to_contain_text('Editable comparison')
                expect(page.locator('a2ui-surface input')).to_have_value('Initial')
                page.locator('a2ui-surface input').fill('Owner decision')
                expect(page.locator('a2ui-surface input')).to_have_value('Owner decision')
                assert not errors, errors
                print('PASS: actual Vite v0.9 MessageProcessor + A2uiSurface render/edit spike')
                if '--spike' not in sys.argv:
                    (root / 'fixture.js').write_text('''
                      import {mountInteractiveResults,queueInteractiveResult} from '/src/interactive-result-host.ts';
                      import {comparisonExample} from '/src/interactive-result-example.ts';
                      import {connectWorkspace} from '/src/workspace-sync.ts';
                      import {registerConversationRecipient} from '/src/conversation-transfer.ts';
                      import {setMarkdownRenderer} from '@a2ui/web_core/v0_9/basic_catalog';
                      document.body.dataset.markdownCalls='0';
                      setMarkdownRenderer(()=>{document.body.dataset.markdownCalls=String(Number(document.body.dataset.markdownCalls)+1);return '<b class="injected-markdown">untrusted plugin HTML</b>';});
                      let ownerToken=new URL(location.href).searchParams.has('locked')?'':'fixture-token';
                      connectWorkspace(()=>({version:1,selected:'',arc:14,view:'windows',monitors:[]}),()=>{},()=> ownerToken,()=>{});
                      const draft=document.createElement('textarea');draft.setAttribute('aria-label','Conversation draft');document.body.append(draft);
                      registerConversationRecipient({id:'synthetic-chat',title:'Synthetic conversation',receive:delivery=>{draft.value=delivery.text;return {accepted:true};}});
                      const host=document.querySelector('#host');
                      let view=mountInteractiveResults(host,()=> ownerToken,{paneId:'fixture-pane'});
                      const remount=document.createElement('button');remount.textContent='Remount fixture';remount.onclick=()=>{view.dispose();view=mountInteractiveResults(host,()=> ownerToken,{paneId:'fixture-pane'});};document.body.append(remount);
                      const unlock=document.createElement('button');unlock.textContent='Unlock fixture host';unlock.onclick=()=>{ownerToken='fixture-token';window.dispatchEvent(new Event('orbit-host-connected'));};document.body.append(unlock);
                      const lock=document.createElement('button');lock.textContent='Lock fixture host';lock.onclick=()=>{ownerToken='';window.dispatchEvent(new Event('orbit-host-connected'));};document.body.append(lock);
                      const silent=document.createElement('button');silent.textContent='Clear fixture credential silently';silent.onclick=()=>{ownerToken='';};document.body.append(silent);
                      const dispose=document.createElement('button');dispose.textContent='Dispose fixture';dispose.onclick=()=>view.dispose();document.body.append(dispose);
                      const adapted=document.createElement('button');adapted.textContent='Import authenticated envelope fixture';adapted.onclick=()=>queueInteractiveResult(JSON.stringify({a2ui:comparisonExample}),{id:'complete-tool-result',version:'exact-v1'},{paneId:'fixture-pane'});document.body.append(adapted);
                    ''')
                    build=subprocess.run([str(ROOT / 'node_modules/.bin/vite'),'build'],cwd=root,capture_output=True,text=True)
                    assert build.returncode==0, build.stdout+build.stderr
                    page.reload()
                    imported=[
                        {'version':'v0.9','createSurface':{'surfaceId':'comparison','catalogId':'https://a2ui.org/specification/v0_9/catalogs/basic/catalog.json'}},
                        {'version':'v0.9','updateComponents':{'surfaceId':'comparison','components':[
                            {'id':'root','component':'Column','children':['heading','notes']},
                            {'id':'heading','component':'Text','text':'Explicit file producer'},
                            {'id':'notes','component':'TextField','label':'Decision notes','value':{'path':'/notes'}}]}},
                        {'version':'v0.9','updateDataModel':{'surfaceId':'comparison','value':{'notes':'File import works'}}}
                    ]
                    page.get_by_label('Import JSON file').set_input_files({'name':'comparison.json','mimeType':'application/json','buffer':json.dumps(imported).encode()})
                    expect(page.get_by_role('textbox',name='Decision notes',exact=True)).to_have_value('File import works')
                    page.get_by_role('textbox',name='A2UI JSON import or incremental messages').fill('\n'.join(json.dumps(message) for message in imported))
                    page.get_by_role('button',name='Import JSON',exact=True).click()
                    expect(page.locator('a2ui-surface')).to_contain_text('Explicit file producer')
                    page.get_by_role('button',name='Import authenticated envelope fixture',exact=True).click()
                    expect(page.get_by_role('textbox',name='Decision notes',exact=True)).to_have_value('Compare tradeoffs before deciding.')
                    page.get_by_role('button', name='Load editable comparison', exact=True).click()
                    field = page.locator('a2ui-surface textarea')
                    expect(field).to_have_value('Compare tradeoffs before deciding.')
                    field.fill('Owner tradeoff notes')
                    textbox = page.get_by_role('textbox', name='A2UI JSON import or incremental messages')
                    textbox.fill(json.dumps({'version':'v0.9','updateComponents':{'surfaceId':'comparison','components':[{'id':'comparison','component':'Text','text':'Updated recommendation without resetting fields.'}]}}))
                    page.get_by_role('button',name='Apply incremental updates',exact=True).click()
                    expect(page.locator('a2ui-surface')).to_contain_text('Updated recommendation')
                    expect(field).to_have_value('Owner tradeoff notes')
                    textbox.fill(json.dumps({'version':'v0.9','updateDataModel':{'surfaceId':'comparison','path':'/notes','value':'Incoming conflict'}}))
                    page.get_by_role('button',name='Apply incremental updates',exact=True).click()
                    expect(page.get_by_role('alert')).to_contain_text('/notes')
                    expect(field).to_have_value('Owner tradeoff notes')
                    page.get_by_role('button',name='Remount fixture',exact=True).click()
                    expect(field).to_have_value('Owner tradeoff notes')
                    expect(page.get_by_role('alert')).to_contain_text('/notes')
                    page.get_by_role('button',name='Use incoming value',exact=True).click()
                    expect(field).to_have_value('Incoming conflict')
                    field.fill('Saved owner decision')
                    page.get_by_role('button',name='Save result',exact=True).click()
                    expect(page.get_by_role('status')).to_contain_text('Saved private result revision 1')
                    page.get_by_role('button',name='Pin result',exact=True).click()
                    expect(page.get_by_role('status')).to_contain_text('Saved private result revision 2')
                    page.reload()
                    page.get_by_role('button',name='★ Editable comparison',exact=True).click()
                    expect(field).to_have_value('Saved owner decision')
                    workspace=page.evaluate("localStorage.getItem('orbit.workspace.id')")
                    headers={'Authorization':'Bearer fixture-token'}
                    items=page.request.post(origin+'/api/interactive-results',headers=headers,data={'action':'list','workspace_id':workspace}).json()['items']
                    record=page.request.post(origin+'/api/interactive-results',headers=headers,data={'action':'read','workspace_id':workspace,'id':items[0]['id']}).json()['record']
                    update={key:record[key] for key in ('id','title','messages','user_values','source','pinned')}
                    update.update(action='update',workspace_id=workspace,expected_revision=record['revision'],op_id='00000000-0000-4000-8000-000000000001')
                    assert page.request.post(origin+'/api/interactive-results',headers=headers,data=update).ok
                    field.fill('Unsaved across stale CAS')
                    page.get_by_role('button',name='Save result',exact=True).click()
                    expect(page.get_by_role('status')).to_contain_text('stale_resource')
                    expect(field).to_have_value('Unsaved across stale CAS')
                    page.locator('.interactive-result-toolbar').get_by_role('button',name='Prepare summary',exact=True).click()
                    expect(page.get_by_role('status')).to_contain_text('Saved source/stream changed')
                    expect(page.get_by_role('dialog')).to_have_count(0)
                    page.get_by_role('button',name='★ Editable comparison',exact=True).click()
                    expect(field).to_have_value('Saved owner decision')
                    model_requests=[]
                    page.on('request',lambda request:model_requests.append(request.url) if '/api/agent' in request.url else None)
                    page.locator('.interactive-result-toolbar').get_by_role('button',name='Prepare summary',exact=True).click()
                    expect(page.get_by_role('dialog')).to_be_visible()
                    page.get_by_role('button',name='Cancel',exact=True).click()
                    expect(page.get_by_role('textbox',name='Conversation draft')).to_have_value('')
                    page.locator('.interactive-result-toolbar').get_by_role('button',name='Prepare summary',exact=True).click()
                    page.get_by_role('radio',name='Synthetic conversation').check()
                    current=page.request.post(origin+'/api/interactive-results',headers=headers,data={'action':'read','workspace_id':workspace,'id':items[0]['id']}).json()['record']
                    amended={key:current[key] for key in ('id','title','messages','user_values','source','pinned')}
                    amended['messages'].append({'version':'v0.9','updateComponents':{'surfaceId':'comparison','components':[{'id':'comparison','component':'Text','text':'Another owner view amended the comparison.'}]}})
                    amended.update(action='update',workspace_id=workspace,expected_revision=current['revision'],op_id='00000000-0000-4000-8000-000000000002')
                    assert page.request.post(origin+'/api/interactive-results',headers=headers,data=amended).ok
                    page.get_by_role('button',name='Insert into draft',exact=True).click()
                    expect(page.get_by_role('dialog')).to_have_count(0)
                    expect(page.get_by_role('status')).to_contain_text('Source/version changed since preview')
                    expect(page.get_by_role('textbox',name='Conversation draft')).to_have_value('')
                    page.get_by_role('button',name='★ Editable comparison',exact=True).click()
                    expect(page.locator('a2ui-surface')).to_contain_text('Another owner view amended')
                    page.locator('.interactive-result-toolbar').get_by_role('button',name='Prepare summary',exact=True).click()
                    page.get_by_role('radio',name='Synthetic conversation').check()
                    page.get_by_role('button',name='Insert into draft',exact=True).click()
                    expect(page.get_by_role('textbox',name='Conversation draft')).to_have_value(re.compile('Saved owner decision'))
                    assert not model_requests, model_requests
                    page.locator('.interactive-result-toolbar').get_by_role('button',name='Prepare summary',exact=True).click()
                    # Programmatic fixture disposal while modal is open exercises detached cleanup.
                    page.get_by_role('button',name='Dispose fixture',exact=True).evaluate('(button)=>button.click()')
                    expect(page.get_by_role('dialog')).to_have_count(0)
                    expect(page.locator('a2ui-surface')).to_have_count(0)
                    page.get_by_role('button',name='Remount fixture',exact=True).click()
                    expect(field).to_have_value('Saved owner decision')
                    textbox.fill(json.dumps({'version':'v0.9','updateComponents':{'surfaceId':'comparison','components':[{'id':'comparison','component':'Image','url':'https://evil.test'}]}}))
                    page.get_by_role('button',name='Apply incremental updates',exact=True).click()
                    expect(page.get_by_role('status')).to_contain_text('URLs are not allowed')
                    expect(field).to_have_value('Saved owner decision')
                    textbox.fill(json.dumps({'version':'v0.9','updateComponents':{'surfaceId':'comparison','components':[{'id':'comparison','component':'Text','text':'<img src=x onerror=alert(1)> Literal text, not HTML.'}]}}))
                    page.get_by_role('button',name='Apply incremental updates',exact=True).click()
                    expect(page.locator('a2ui-surface')).to_contain_text('<img src=x onerror=alert(1)>')
                    expect(page.locator('a2ui-surface img, .injected-markdown')).to_have_count(0)
                    assert page.locator('body').get_attribute('data-markdown-calls') == '0'
                    page.evaluate("document.documentElement.style.colorScheme='dark'")
                    expect(page.get_by_role('textbox',name='Decision notes',exact=True)).to_have_value('Saved owner decision')
                    page.evaluate("document.documentElement.style.colorScheme='light'")
                    assert page.evaluate('document.documentElement.scrollWidth <= innerWidth'), 'Narrow viewport overflow'
                    assert not errors, errors
                    print('PASS: official renderer edit preservation, conflicts, private save/reload/pin, summary cancel/draft-only insertion and dispose at 380px')
                    # A saved record remains in the real private API while a restored
                    # surface mounts locked. Unlock must reload just the library.
                    page.goto(origin+'?locked')
                    expect(page.get_by_role('status')).to_contain_text('Connect host to enable workspace control')
                    expect(page.get_by_role('button',name='★ Editable comparison',exact=True)).to_have_count(0)
                    page.get_by_role('button',name='Load editable comparison',exact=True).click()
                    field.fill('Local edit made while locked')
                    page.get_by_role('button',name='Unlock fixture host',exact=True).click()
                    saved_button=page.get_by_role('button',name='★ Editable comparison',exact=True)
                    expect(saved_button).to_be_visible()
                    expect(field).to_have_value('Local edit made while locked')
                    saved_button.click()
                    expect(field).to_have_value('Saved owner decision')
                    field.fill('Retained through host reconnect')

                    network={'offline':False,'hold_next':False,'held':[],'lists':0}
                    def connection_route(route):
                        body=route.request.post_data_json
                        if body.get('action')!='list':
                            return route.continue_()
                        network['lists']+=1
                        if network['hold_next']:
                            network['hold_next']=False
                            network['held'].append(route)
                            return
                        if network['offline']:
                            return route.fulfill(status=503,content_type='application/json',body=json.dumps({'ok':False,'code':'unavailable','error':'Synthetic host disconnected'}))
                        route.continue_()
                    page.route('**/api/interactive-results',connection_route)
                    network['hold_next']=True
                    page.get_by_role('button',name='Unlock fixture host',exact=True).click()
                    page.wait_for_function("document.querySelector('.interactive-result-library').children.length===0")
                    # Route callbacks are driven while Playwright waits; wait for
                    # the held old authenticated list before rotating its binding.
                    for _ in range(30):
                        if network['held']: break
                        page.wait_for_timeout(100)
                    assert network['held'], 'Expected in-flight old-binding list'
                    page.get_by_role('button',name='Lock fixture host',exact=True).click()
                    page.get_by_role('button',name='Unlock fixture host',exact=True).click()
                    expect(saved_button).to_be_visible()
                    try:
                        network['held'][0].fulfill(status=200,content_type='application/json',body=json.dumps({'ok':True,'items':[{'id':items[0]['id'],'title':'STALE old host reply','pinned':False}]}))
                    except Exception as error:
                        assert 'already' in str(error).lower() or 'closed' in str(error).lower() or 'abort' in str(error).lower(), str(error)
                    page.wait_for_timeout(150)
                    expect(page.get_by_role('button',name='STALE old host reply',exact=True)).to_have_count(0)
                    expect(field).to_have_value('Retained through host reconnect')

                    # A temporary service failure must recover without a new
                    # unlock event; the bounded retry loop reloads real records.
                    network['offline']=True
                    page.get_by_role('button',name='Unlock fixture host',exact=True).click()
                    expect(page.get_by_role('status')).to_contain_text('Synthetic host disconnected')
                    network['offline']=False
                    expect(saved_button).to_be_visible(timeout=10000)
                    expect(field).to_have_value('Retained through host reconnect')
                    page.get_by_role('button',name='Clear fixture credential silently',exact=True).click()
                    expect(page.get_by_role('status')).to_contain_text('Connect host to enable workspace control')
                    expect(saved_button).to_have_count(0)
                    expect(field).to_have_value('Retained through host reconnect')
                    page.get_by_role('button',name='Unlock fixture host',exact=True).click()
                    expect(saved_button).to_be_visible()
                    page.evaluate("localStorage.setItem('orbit.workspace.id','00000000-0000-4000-8000-000000000099')")
                    expect(page.get_by_role('status')).to_contain_text('Workspace binding changed')
                    expect(saved_button).to_have_count(0)
                    expect(field).to_have_value('Retained through host reconnect')
                    page.evaluate('(id)=>localStorage.setItem("orbit.workspace.id",id)',workspace)
                    expect(saved_button).to_be_visible()
                    page.get_by_role('button',name='Dispose fixture',exact=True).click()
                    count=network['lists']
                    page.get_by_role('button',name='Unlock fixture host',exact=True).click()
                    page.wait_for_timeout(1600)
                    assert network['lists']==count, 'Disposed host retained reconnect listener/timer'
                    assert not errors, errors
                    print('PASS: mount locked -> explicit unlock -> saved library reopen; edits survive binding changes, stale reply fencing, disconnect retry and disposed-listener cleanup')
                browser.close()
        finally:
            server.terminate()
            server.wait(timeout=10)

if __name__ == '__main__':
    run()
