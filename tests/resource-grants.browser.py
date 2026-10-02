"""Disposable real consent UI, authenticated Unix adapter and editable Lexical brief.
Synthetic owner token/corpus only; no Hermes provider, live runtime or services.
"""
import importlib.util
import json
import os
from pathlib import Path
import shutil
import socket
import subprocess
import sys
import tempfile
import time
import urllib.request
import uuid
from playwright.sync_api import sync_playwright, expect

ROOT=Path(__file__).resolve().parents[1]
TOKEN='synthetic-resource-owner-'+'f'*32
def port():
    with socket.socket() as s:
        s.bind(('127.0.0.1',0)); return s.getsockname()[1]
def wait(url):
    for _ in range(200):
        try:
            urllib.request.urlopen(url,timeout=1).close(); return
        except OSError: time.sleep(.1)
    raise RuntimeError('fixture not ready')

with tempfile.TemporaryDirectory(prefix='agency-ui-',dir='/tmp/opencode') as tmp:
    root=Path(tmp)
    for name in ('src','contracts'): shutil.copytree(ROOT/name,root/name)
    (root/'node_modules').symlink_to(ROOT/'node_modules',target_is_directory=True)
    (root/'package.json').write_text('{"type":"module"}')
    runtime=root/'runtime';runtime.mkdir(mode=0o700)
    api_port,vite_port=port(),port();origin=f'http://127.0.0.1:{vite_port}';api=f'http://127.0.0.1:{api_port}'
    ws,pane=str(uuid.uuid4()),str(uuid.uuid4())
    state={'version':1,'monitors':[],'view':'windows','selected':'','arc':14}
    (root/'vite.config.js').write_text('export default '+json.dumps({'server':{'proxy':{'/api':{'target':api,'changeOrigin':True}}}}))
    (root/'server.mjs').write_text(f"""
import http from 'node:http';
import {{createKnowledgeSearch}} from {json.dumps(str(ROOT/'server/knowledge-index.mjs'))};
import {{createDocumentsService}} from {json.dumps(str(ROOT/'server/documents-store.mjs'))};
import {{createResourceDelegation}} from {json.dumps(str(ROOT/'server/resource-delegation.mjs'))};
import {{technologyOwnerRoute}} from {json.dumps(str(ROOT/'server/technology-owner-route.mjs'))};
let documentId=null;
const workspaceRead=()=>({{state:{{monitors:documentId?[{{layout:{{type:'pane',pane:{{id:{json.dumps(pane)},kind:'browser',url:'orbit://document/'+documentId}}}}}}]:[]}}}});
const options={{root:{json.dumps(str(runtime))},workspaceRead}};
const knowledge=createKnowledgeSearch(options),documents=createDocumentsService(options),grants=await createResourceDelegation({{...options,knowledge,documents}});
await knowledge.dispatch({{action:'ingest_text',workspace_id:{json.dumps(ws)},kind:'owner_text',title:'Selected astronomy',text:'Mars has two moons.'}});
await knowledge.dispatch({{action:'ingest_text',workspace_id:{json.dumps(ws)},kind:'owner_text',title:'Excluded secret',text:'PRIVATE EXCLUDED SECRET'}});
const reply=(res,status,body)=>{{res.writeHead(status,{{'Content-Type':'application/json'}});res.end(JSON.stringify(body));}};
const services={{'/api/search':knowledge,'/api/documents':documents,'/api/resource-grants':grants,'/api/fixture-open':{{dispatch:body=>{{documentId=body.document_id;return {{}};}}}}}};
const routes=Object.fromEntries(Object.entries(services).map(([url,service])=>[url,technologyOwnerRoute({{token:{json.dumps(TOKEN)},port:{api_port},devOrigins:[{json.dumps(origin)}],reply,dispatch:b=>service.dispatch(b)}})]));
const server=http.createServer((req,res)=>{{if(routes[req.url])return routes[req.url](req,res);if(req.url==='/api/workspace')return reply(res,200,{{ok:true,workspace_id:{json.dumps(ws)},revision:1,state:{json.dumps(state)}}});if(req.url==='/api/workspace/events')return reply(res,200,{{ok:true,events:[],cursor:0}});reply(res,200,{{ok:true}});}}).listen({api_port},'127.0.0.1');
process.on('SIGTERM',async()=>{{server.close();await grants.close();await knowledge.close();process.exit();}});
""")
    (root/'test.html').write_text(f"""<!doctype html><html><body><div id="host" style="max-width:800px"></div><div id="doc"></div><script type="module">
import {{connectWorkspace}} from '/src/workspace-sync.ts';
import {{mountSearchSurface}} from '/src/search-surface.ts';
import {{mountDocumentHost}} from '/src/document-host.ts';
connectWorkspace(()=>({json.dumps(state)}),()=>{{}},()=>{json.dumps(TOKEN)},()=>{{}});
window.surface=mountSearchSurface(document.querySelector('#host'),()=>{json.dumps(TOKEN)});
window.openDoc=id=>mountDocumentHost(document.querySelector('#doc'),id,()=>{json.dumps(TOKEN)},{{paneId:{json.dumps(pane)}}});
</script></body></html>""")
    server=subprocess.Popen(['node',str(root/'server.mjs')],cwd=root,stdout=subprocess.DEVNULL,stderr=subprocess.PIPE)
    vite=subprocess.Popen([str(ROOT/'node_modules/.bin/vite'),'--host','127.0.0.1','--port',str(vite_port),'--strictPort'],cwd=root,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
    try:
        wait(api);wait(origin+'/test.html')
        with sync_playwright() as p:
            browser=p.chromium.launch(headless=True,args=['--no-sandbox'])
            context=browser.new_context();context.add_init_script("localStorage.setItem('orbit.workspace.id',"+json.dumps(ws)+");")
            page=context.new_page();errors=[];page.on('pageerror',lambda e:errors.append(str(e)));page.goto(origin+'/test.html')
            expect(page.locator('.knowledge-status')).to_contain_text('2 sources')
            page.get_by_text('Delegate selected sources to a dedicated local Hermes run',exact=True).click()
            grant=page.locator('details').filter(has=page.get_by_text('Delegate selected sources to a dedicated local Hermes run',exact=True))
            expect(grant).to_contain_text('Normal gateway delegation is unavailable')
            grant.get_by_label('Selected astronomy',exact=False).check()
            grant.get_by_label('Delegated disclosure destination').fill('Synthetic local adapter fixture; no provider')
            grant.get_by_label('Allow creating new editable briefs',exact=False).check()
            grant.get_by_role('button',name='Grant selected sources to new dedicated recipient',exact=True).click()
            expect(grant.get_by_role('status')).to_contain_text('1 dedicated recipients')
            files=list((runtime/'resource-delegation').glob('*.channel.json'));assert len(files)==1
            # Invoke the actual shipped Python handler, not a substitute HTTP client.
            spec=importlib.util.spec_from_file_location('orbit_resource_fixture',ROOT/'hermes-plugin/__init__.py',submodule_search_locations=[str(ROOT/'hermes-plugin')])
            module=importlib.util.module_from_spec(spec);sys.modules[spec.name]=module;spec.loader.exec_module(module)
            class Context:
                def get_config(self,key,default=None): return str(files[0]) if key=='resource_channel_file' else default
                def register_tool(self,**kwargs): self.tool=kwargs
            adapter=Context();module.register(adapter);assert adapter.tool['name']=='orbit_resources'
            call=lambda body:json.loads(adapter.tool['handler'](body,session_id='forged-normal-session'))
            found=call({'action':'search','query':'Mars SECRET'});assert found['ok'];assert len(found['result']['results'])==1;assert 'EXCLUDED' not in json.dumps(found)
            citation=found['result']['results'][0]
            exact=call({'action':'read_source','source_id':citation['source_id']});assert exact['result']['text']=='Mars has two moons.'
            saved=call({'action':'create_document','op_id':str(uuid.uuid4()),'title':'Editable cited brief','text':'Mars has two moons.','citations':[{k:citation[k] for k in ('source_id','content_sha256','char_start','char_end')}]})
            assert saved['saved'] and not saved['opened'] and not saved['browser_acknowledged'],saved
            response=context.request.post(api+'/api/fixture-open',headers={'Authorization':'Bearer '+TOKEN,'Origin':origin},data={'document_id':saved['document_id']});assert response.ok
            page.evaluate('id=>window.openDoc(id)',saved['document_id'])
            editor=page.locator('[contenteditable="true"]');expect(editor).to_contain_text('Mars has two moons.');expect(editor).to_contain_text(citation['source_id'])
            editor.click();page.keyboard.press('Control+End');page.keyboard.type(' Owner-edited.')
            page.get_by_role('button',name='Save document',exact=True).click();expect(page.locator('.document-status')).to_contain_text('Saved')
            grant.get_by_role('button',name='Revoke this recipient',exact=True).click();expect(grant.get_by_role('status')).to_contain_text('Revoked')
            assert call({'action':'read_source','source_id':citation['source_id']})['code']=='revoked'
            assert not errors,errors
            browser.close()
        print('PASS real disposable browser: selected-source consent, real Python private adapter, isolated search/read, cited saved Lexical brief, owner edit/save, revoke; no provider calls')
    finally:
        vite.terminate();server.terminate();vite.wait(timeout=10);server.wait(timeout=10)
