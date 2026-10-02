"""Real chat/renderer adapters against authenticated synthetic responses; no provider/runtime."""
import json, os, socket, subprocess, tempfile, time, urllib.request
from pathlib import Path
from playwright.sync_api import sync_playwright, expect

ROOT = Path(__file__).resolve().parents[1]
EXAMPLE = json.dumps({'a2ui':[
    {'version':'v0.9','createSurface':{'surfaceId':'decision','catalogId':'https://a2ui.org/specification/v0_9/catalogs/basic/catalog.json'}},
    {'version':'v0.9','updateComponents':{'surfaceId':'decision','components':[
        {'id':'root','component':'Column','children':['notes']},
        {'id':'notes','component':'TextField','label':'Decision notes','value':{'path':'/notes'}}]}},
    {'version':'v0.9','updateDataModel':{'surfaceId':'decision','value':{'notes':'Compare tradeoffs before deciding.'}}}
]})
os.environ.setdefault('PLAYWRIGHT_BROWSERS_PATH', '/tmp/opencode/orbit-evolution-browsers')
with tempfile.TemporaryDirectory(prefix='orbit-handoff-browser-', dir='/tmp/opencode') as tmp:
    root = Path(tmp)
    for name in ('src','contracts','node_modules'): (root/name).symlink_to(ROOT/name)
    (root/'index.html').write_text('<main id="chat"></main><main id="one"></main><main id="two"></main><main id="mcp"></main><script type="module" src="/fixture.js"></script>')
    (root/'vite.config.mjs').write_text('export default {server:{hmr:false,fs:{allow:'+json.dumps([str(ROOT),str(root)])+'}}}')
    (root/'fixture.js').write_text('''
import {connectWorkspace} from '/src/workspace-sync.ts';
import {createAgentChat} from '/src/agent-chat.ts';
import {mountInteractiveResults,queueInteractiveResult,interactiveResultTargets} from '/src/interactive-result-host.ts';
import {mountMcpApps} from '/src/mcp-apps-host.ts';
import {completeResultActions} from '/src/interactive-result-delivery.ts';
import {comparisonExample} from '/src/interactive-result-example.ts';
connectWorkspace(()=>({version:1,selected:'',arc:14,view:'windows',monitors:[]}),()=>{},()=> 'fixture-token',()=>{});
window.example=JSON.stringify({a2ui:comparisonExample});window.queue=queueInteractiveResult;window.targets=interactiveResultTargets;
createAgentChat(document.querySelector('#chat'),'chat',()=> 'fixture-token');
window.one=mountInteractiveResults(document.querySelector('#one'),()=> 'fixture-token',{paneId:'one'});
window.two=mountInteractiveResults(document.querySelector('#two'),()=> 'fixture-token',{paneId:'two'});
mountMcpApps(document.querySelector('#mcp'),()=> 'fixture-token',{paneId:'mcp'});
window.remount=()=>{window.one.dispose();window.one=mountInteractiveResults(document.querySelector('#one'),()=> 'fixture-token',{paneId:'one'});};
window.mcpResult=()=>document.body.append(completeResultActions(JSON.stringify({mcp_snapshot:{title:'Synthetic SDK snapshot',resource_uri:'ui://fixture',html:'<p>snapshot</p>',arguments:{exact:42},result:{content:[{type:'text',text:'exact result'}]}}}),{id:'authenticated-fixture',version:'1'},()=>true));
// Observe the actual Normal source seam; document engine/storage acceptance is
// independently exercised by documents.browser.py and canvas.browser.py.
window.addEventListener('orbit-review-document-result',event=>{event.preventDefault();window.documentRequest={title:event.detail.title,data:event.detail.data};event.detail.respond({status:'rejected',reason:'Synthetic source-seam acknowledgement; no record created.'});});
''')
    with socket.socket() as probe: probe.bind(('127.0.0.1',0)); port=probe.getsockname()[1]
    origin=f'http://127.0.0.1:{port}'
    server=subprocess.Popen([str(ROOT/'node_modules/.bin/vite'),'--host','127.0.0.1','--port',str(port),'--strictPort'],cwd=root,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
    try:
        for _ in range(150):
            try: urllib.request.urlopen(origin,timeout=1).close(); break
            except OSError: time.sleep(.1)
        with sync_playwright() as p:
            browser=p.chromium.launch(headless=True,args=['--no-sandbox'])
            page=browser.new_page(viewport={'width':1280,'height':900}); errors=[]; actions=[]; completed=False; output=EXAMPLE
            page.on('pageerror',lambda e:errors.append(str(e)))
            def api(route):
                global completed
                body=route.request.post_data_json or {}; action=body.get('action'); url=route.request.url
                if '/api/agent' in url:
                    actions.append(action)
                    assert route.request.headers.get('authorization')=='Bearer fixture-token'
                    if action=='shared_chat':
                        state={**body.get('initial',{}),'binding_revision':1}
                        if not completed: state['run']='fixture-complete-run'
                        data={'state':state}
                    elif action=='status':
                        completed=True; data={'run_id':'fixture-complete-run','status':'completed','output':output}
                    elif action=='profiles': data={'profiles':[{'id':'default','label':'Default'}]}
                    elif action=='sessions': data={'sessions':[]}
                    elif action in ('draft_read','draft_write'): data={'record':{'revision':1,'draft':body.get('text',''),'metadata':{}}}
                    else: data={}
                elif '/api/interactive-results' in url: data={'items':[]}
                elif '/api/mcp-apps' in url: data={'available':True,'sandbox_origin':'http://127.0.0.1:1','items':[],'revision':'fixture'}
                else: data={'revision':1,'state':body.get('state'),'events':[],'cursor':0}
                route.fulfill(status=200,content_type='application/json',body=json.dumps({'ok':True,**data}))
            page.route('**/api/**',api)
            page.goto(origin)
            open_result=page.get_by_role('button',name='Choose a results pane for this complete reply',exact=True)
            expect(open_result).to_be_visible(timeout=15000)
            open_result.click()
            page.get_by_role('dialog').get_by_role('button',name='Deliver to this pane').nth(1).click()
            expect(page.locator('#one').get_by_role('button',name='Open queued result',exact=True)).to_have_count(0)
            page.locator('#two').get_by_role('button',name='Open queued result',exact=True).click()
            field=page.locator('#two').get_by_role('textbox',name='Decision notes',exact=True)
            expect(field).to_have_value('Compare tradeoffs before deciding.')
            field.fill('Edited actual complete reply')
            page.locator('#two .interactive-result-toolbar').get_by_role('button',name='Prepare summary',exact=True).click()
            page.get_by_role('dialog').get_by_role('radio').check()
            expect(page.get_by_label('Text to transfer')).to_contain_text('Edited actual complete reply')
            page.get_by_role('button',name='Insert into draft',exact=True).click()
            expect(page.get_by_label('Message to Hermes',exact=True)).to_have_value(__import__('re').compile('Edited actual complete reply'))
            # Two delivery acknowledgements, pane isolation, bound, stale mount refusal.
            outcome=page.evaluate('''()=>{const target=window.targets().find(t=>t.paneId==='one');window.oldTarget=target;window.acks=[];return Array.from({length:9},(_,i)=>window.queue(window.example,{id:'run-'+i,version:'1'},{...target,onAcknowledgement:ack=>window.acks.push(ack)}));}''')
            assert all(v['status']=='queued' for v in outcome[:8]) and outcome[8]['status']=='unavailable'
            expect(page.locator('#one').get_by_role('button',name='Open queued result',exact=True)).to_have_count(8)
            page.evaluate('window.remount()')
            acknowledgements=page.evaluate('window.acks')
            assert len(acknowledgements)==8 and all(a['status']=='stale' and a['paneId']=='one' and a['generation']==outcome[0]['generation'] for a in acknowledgements)
            assert len({a['deliveryId'] for a in acknowledgements})==8
            assert page.evaluate("window.queue(window.example,{id:'late',version:'1'},window.oldTarget)")['status']=='unavailable'
            expect(page.locator('#one').get_by_role('button',name='Open queued result',exact=True)).to_have_count(0)
            page.evaluate('window.mcpResult()')
            page.get_by_role('button',name='Choose an MCP Apps pane; import and execution stay explicit').click()
            page.get_by_role('dialog').get_by_role('button',name='Deliver to this pane').click()
            snapshot=json.loads(page.get_by_label('MCP App snapshot JSON').input_value())
            assert snapshot['arguments']=={'exact':42} and snapshot['result']['content'][0]['text']=='exact result'
            assert page.locator('#mcp iframe').count()==0
            # A second authenticated complete reply reaches the document adapter
            # after integration of the independent result-action branches.
            document={'title':'Cited synthetic brief','kind':'richtext','format':'lexical','content':json.dumps({'root':{'type':'root','version':1,'format':'','indent':0,'direction':None,'children':[{'type':'paragraph','version':1,'format':'','indent':0,'direction':None,'children':[{'type':'text','version':1,'text':'Exact synthetic brief','format':0,'style':'','mode':'normal','detail':0}]}]}})}
            output=json.dumps({'document':document}); completed=False
            page.reload()
            page.get_by_role('button',name='Review this complete reply as a new private document draft',exact=True).click()
            page.wait_for_function('window.documentRequest !== undefined')
            assert page.evaluate('window.documentRequest') == {'title':document['title'],'data':{key:document[key] for key in ('kind','format','content')}}
            expect(page.locator('.agent-progress')).to_contain_text('Synthetic source-seam acknowledgement')
            assert 'submit' not in actions and 'run' not in actions,actions
            assert not errors,errors
            browser.close()
            print('PASS actual Normal complete reply -> chosen A2UI pane -> real edit -> exact chat draft; bounded concurrent inbox, stale mount refusal; MCP snapshot staging without opening; no model send')
    finally:
        server.terminate();server.wait(timeout=10)
