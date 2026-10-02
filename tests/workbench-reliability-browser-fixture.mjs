// Disposable real persistence/API fixture. Vite serves the real host components
// on demand; no production bundle copy, provider, model or live runtime is used.
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import {randomUUID} from 'node:crypto';
import {createServer} from 'vite';
import {SqliteWorkspaceStore} from '../server/sqlite-workspace-store.mjs';
import {WorkbenchStore} from '../server/workbench-store.mjs';
import {WorkbenchData} from '../server/workbench-data.mjs';
import {createWorkbenchExecution} from '../server/workbench-execution.mjs';
import {createWorkbenchWorkflow} from '../server/workbench-workflow.mjs';
import {createWorkbenchSetup,SETUP_PUBLIC_REASONS} from '../server/workbench-setup.mjs';
import {createWorkbenchGate} from '../server/workbench-gate.mjs';
import {workbenchOwnerRoute} from '../server/workbench-owner-route.mjs';
import {openProjectRoot} from '../server/project-files.mjs';
import {initial} from '../src/model.ts';
import {commandIdentity} from '../server/command-identity.mjs';

const root=process.argv[2];if(!root?.startsWith('/tmp/opencode/reliability-browser-'))throw Error('Disposable root required');
const source=path.join(root,'source');fs.mkdirSync(source,{recursive:true});
fs.writeFileSync(path.join(source,'math.js'),'export const sum=(a,b)=>a+b;\n');
fs.writeFileSync(path.join(source,'sum.test.mjs'),"import test from 'node:test';test('fixture',()=>{});\n");
const store=new SqliteWorkspaceStore(path.join(root,'runtime')),workspace_id=randomUUID(),pane_id=randomUUID(),token=randomUUID();
store.commit(commandIdentity({workspace_id,action:'sync',base_revision:0,state:initial(),operation_id:randomUUID()},'owner'),{create:()=>({id:workspace_id,revision:1,state:initial(),capability:randomUUID()})});
const records=new WorkbenchStore(store),data=new WorkbenchData(store),opened=openProjectRoot(source),project=records.register(workspace_id,{root:source,name:'Browser reliability',identity:opened.identity});opened.close();
const base={workspace_id,project_id:project.id},gate=createWorkbenchGate(),execution=createWorkbenchExecution({store,records,data,gate}),workflow=createWorkbenchWorkflow({store,records,data,execution});
const call=(action,fields={})=>execution.dispatch({...base,action,...fields}),flow=(action,fields={})=>workflow.dispatch({...base,action,...fields});
// Generate a real retained publication, then fail only its final DB update.
const {task}=await call('task_create',{title:'Integration fixture',acceptance_statement:'sum adds',check_definition_id:'host-regression',profile_id:'fixture',session_id:'fixture'});
const cp=await call('candidate_preview',{task_id:task.id}),{candidate}=await call('candidate_create',{task_id:task.id,preview_id:cp.preview_id,preview_digest:cp.preview.digest});
const check=await call('check_preview',{candidate_id:candidate.id,definition_id:'host-regression'}),run=await call('check_run',{candidate_id:candidate.id,preview_id:check.preview_id,preview_digest:check.preview.spec_digest,op_id:randomUUID()});
const observed=await call('candidate_get',{candidate_id:candidate.id}),{review}=await call('review_decide',{candidate_id:candidate.id,evidence_ids:[run.evidence.id],decision:'approved',expected_identity:observed.review_identity});
const ip=await flow('integration_preview',{candidate_id:candidate.id,review_id:review.id});
store.db.exec("CREATE TRIGGER fixture_receipt_fault BEFORE UPDATE ON wb_integrations WHEN json_extract(NEW.record_json,'$.status')='integrated' BEGIN SELECT RAISE(ABORT,'fixture lost publication receipt'); END");
try{await flow('integrate_confirm',{candidate_id:candidate.id,review_id:review.id,preview_id:ip.preview_id,preview_digest:ip.preview_digest,op_id:randomUUID()});}catch{}
store.db.exec('DROP TRIGGER fixture_receipt_fault');
const integration=data.list('integrations',workspace_id,project.id)[0];if(integration.status!=='receipt_pending')throw Error('Fixture publication must be pending');
let release=gate.quarantine('fixture-unknown'),starts=0,previews=0,clockOffset=0;
const hermes={readBinding:async()=>({trusted_host:true,sandbox:false,profile_id:'fixture',session_id:'fixture',binding_revision:1,config_generation:1})};
const native={health:()=>({healthy:true,supported:true}),dispatch:async body=>{if(body.action==='preview'){previews++;return {preview_id:randomUUID(),preview_digest:'a'.repeat(64),expires_at:Date.now()+60000,preview:{budget:body.budget,candidate_id:candidate.id,required_checks:[]}};}starts++;throw Error('Browser fixture must never authorize or start a worker');}};
const setup=createWorkbenchSetup({store,records,data,execution,hermes,native,gate,now:()=>Date.now()+clockOffset});
const vite=await createServer({configFile:false,root:process.cwd(),cacheDir:path.join(root,'vite-cache'),server:{middlewareMode:true},appType:'custom',optimizeDeps:{noDiscovery:true,include:[]}});
const reply=(res,status,body)=>{res.writeHead(status,{'Content-Type':'application/json'});res.end(JSON.stringify(body));};
const server=http.createServer();await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const port=server.address().port;
const route=dispatch=>workbenchOwnerRoute({token,port,reply,dispatch,publicReasons:SETUP_PUBLIC_REASONS});
const fixture=route(async body=>{
  if(body.action==='release'){release?.();release=null;}
  if(body.action==='expire')clockOffset+=86400000;
  if(body.action==='drift')fs.appendFileSync(path.join(source,'sum.test.mjs'),'// source drift\n');
  if(body.action==='tamper')fs.appendFileSync(path.join(integration.private_root,'math.js'),'// tamper\n');
  if(body.action==='repair')fs.writeFileSync(path.join(integration.private_root,'math.js'),'export const sum=(a,b)=>a+b;\n');
  if(body.action==='complete'){
    const t=data.list('tasks',workspace_id,project.id).find(t=>t.title==='Browser waiting task');if(!t)throw Error('Expected browser task');
    const grant=data.create('grants',{...base,task_id:t.id,candidate_id:t.candidate_id,status:'completed',runtime_status:'exited',termination_confirmed:true});
    data.create('results',{...base,task_id:t.id,grant_id:grant.id,run_id:randomUUID(),availability:'available',text:'Fixture result',retained_until:Date.now()+60000});
    data.create('evidence',{...base,task_id:t.id,candidate_id:t.candidate_id,verdict:'fail'});
  }
  if(body.action==='change_status'){const t=data.list('tasks',workspace_id,project.id).find(t=>t.title==='Browser waiting task');data.update('tasks',workspace_id,project.id,t.id,t.revision,{status:'needs_review'});}
  return {starts,previews,integrations:data.list('integrations',workspace_id,project.id).map(i=>({id:i.id,status:i.status,commit:i.candidate_commit})),waits:(await setup.dispatch({action:'state',workspace_id,pane_id,expected_binding_revision:1})).waiting_intents};
});
server.on('request',(req,res)=>{
  if(req.url==='/api/workbench/setup')return route(body=>setup.dispatch(body))(req,res);
  if(req.url==='/api/workbench/workflow')return route(body=>workflow.dispatch(body))(req,res);
  if(req.url==='/api/workbench/execution')return route(body=>execution.dispatch(body))(req,res);
  if(req.url==='/fixture')return fixture(req,res);
  if(req.url==='/'){
    res.writeHead(200,{'Content-Type':'text/html'});res.end(`<!doctype html><html><head><style>body{font:14px sans-serif;max-width:850px;margin:auto}button,input,select{margin:4px}pre{white-space:pre-wrap;overflow-wrap:anywhere}section,article{padding:8px;border:1px solid #aaa}details{margin:8px 0}</style></head><body><main id="setup"></main><main id="inbox"></main><main id="workflow"></main><output id="opened"></output><script type="module">
import {createWorkbenchSetup} from '/src/workbench-setup.ts';
import {createWorkbenchTaskInbox} from '/src/workbench-task-inbox.ts';
import {mountWorkbenchWorkflow} from '/src/workbench-workflow.ts';
import '/src/pane-workbench.css';
const token=${JSON.stringify(token)},workspaceId=${JSON.stringify(workspace_id)},projectId=${JSON.stringify(project.id)},paneId=${JSON.stringify(pane_id)};
const setup=createWorkbenchSetup({workspaceId,paneId,getToken:()=>token,binding:()=>({profileId:'fixture',sessionId:'fixture',bindingRevision:1}),selectedProject:()=>projectId,selectedTask:()=>null,onProject:()=>{},onRegister:()=>{},onPrepared:()=>{}});document.querySelector('#setup').append(setup.element);
const inbox=createWorkbenchTaskInbox({workspaceId,projectId:()=>projectId,getToken:()=>token,open:(id,view)=>{document.querySelector('#opened').textContent=id+':'+view;}});document.querySelector('#inbox').append(inbox.element);inbox.element.open=true;inbox.refresh();
mountWorkbenchWorkflow({container:document.querySelector('#workflow'),token,workspace_id:workspaceId,project_id:projectId});
</script></body></html>`);return;
  }
  vite.middlewares(req,res,()=>{res.writeHead(404);res.end();});
});
fs.writeFileSync(path.join(root,'ready.json'),JSON.stringify({origin:`http://127.0.0.1:${port}`,token,workspace_id,project_id:project.id,integration_id:integration.id}));
let closing=false;async function close(){if(closing)return;closing=true;await vite.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));execution.close();store.close();process.exit(0);}
process.on('SIGTERM',close);process.on('SIGINT',close);
