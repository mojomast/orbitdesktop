// Cross-boundary fault regressions. These do not call a model: they prove the
// deterministic boundaries that make a model's claims and actions non-authoritative.
// They must stay green as Sol/Luna add the result channel.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import {createHmac,randomUUID} from 'node:crypto';
import {SqliteWorkspaceStore} from '../server/sqlite-workspace-store.mjs';
import {WorkbenchStore} from '../server/workbench-store.mjs';
import {WorkbenchData} from '../server/workbench-data.mjs';
import {createWorkbenchGate} from '../server/workbench-gate.mjs';
import {openProjectRoot} from '../server/project-files.mjs';
import {createWorkbenchExecution} from '../server/workbench-execution.mjs';
import {createWorkbenchNative} from '../server/workbench-native.mjs';
import {HERMES_NATIVE_CONTRACT,validateNative,validateNativeTool} from '../contracts/workbench-native-v1.mjs';
import {initial} from '../src/model.ts';
import {commandIdentity} from '../server/command-identity.mjs';

const WRONG='export const sum = (a,b) => a - b;\n',RIGHT='export const sum = (a,b) => a + b;\n';
const wait=ms=>new Promise(r=>setTimeout(r,ms));

function fixture(t,adapter={}){
  const root=fs.mkdtempSync('/tmp/opencode/wfb-'),projectRoot=path.join(root,'project');
  fs.mkdirSync(projectRoot);fs.writeFileSync(path.join(projectRoot,'math.js'),WRONG);
  const store=new SqliteWorkspaceStore(path.join(root,'r')),workspace_id=randomUUID(),pane_id=randomUUID();
  store.commit(commandIdentity({workspace_id,action:'sync',base_revision:0,state:initial(),operation_id:randomUUID(),intent:'Fault fixture'},'owner'),{create:()=>({id:workspace_id,revision:1,state:initial(),capability:randomUUID(),api:'http://127.0.0.1:4318'})});
  const data=new WorkbenchData(store),records=new WorkbenchStore(store),opened=openProjectRoot(projectRoot);
  const project=records.register(workspace_id,{root:projectRoot,name:'Fault fixture',identity:opened.identity});opened.close();
  const gate=createWorkbenchGate(),execution=createWorkbenchExecution({store,records,data,gate}),base={workspace_id,project_id:project.id};
  const hermes={quarantineNative:()=>true,acknowledgeNativeUnknown:()=>{},readBinding:async()=>({trusted_host:true,sandbox:false,profile_id:'fixture',session_id:'native-fixture',config_generation:1,binding_revision:1,native_runtime:hermes.bindingMetadata??{kind:'local-pinned',commit:HERMES_NATIVE_CONTRACT.commit,model:'orbit-local-fixture',destination:'loopback configured model endpoint',configuration_hash:'0'.repeat(64)}}),...adapter};
  const native=createWorkbenchNative({store,records,data,execution,hermes});
  const call=(action,fields={})=>execution.dispatch({...base,action,...fields});
  async function prepare({nativeCall=body=>native.dispatch(body),budget={calls:15,checks:2,duration_ms:90000}}={}){
    const {task}=await call('task_create',{title:'Repair sum',acceptance_statement:'sum must add',check_definition_id:'host-regression',profile_id:'fixture',session_id:'native-fixture',pane_id});
    const p=await call('candidate_preview',{task_id:task.id});const {candidate}=await call('candidate_create',{task_id:task.id,preview_id:p.preview_id,preview_digest:p.preview.digest});
    const {attempt}=await call('attempt_create',{task_id:task.id,candidate_id:candidate.id,profile_id:'fixture',session_id:'native-fixture',pane_id});
    const preview=await nativeCall({...base,action:'preview',attempt_id:attempt.id,context_ids:[],budget});
    const {grant}=await nativeCall({...base,action:'approve',preview_id:preview.preview_id,preview_digest:preview.preview_digest});
    return {candidate,attempt,grant,task};
  }
  t.after(()=>{try{native.close();}catch{}execution.close();store.close();fs.rmSync(root,{recursive:true,force:true});});
  return {root,projectRoot,store,data,records,gate,execution,native,hermes,base,call,prepare};
}
async function settleJob(f,id){
  for(let i=0;i<300;i++){const {job}=await f.call('job_get',{job_id:id});if(['completed','failed','cancelled','inconclusive','outcome_unknown'].includes(job.status)&&!job.pending_result)return job;await wait(100);}
  throw Error('job did not settle');
}

// Baseline boundary regression only: there is no result text in this case. It
// proves the server refuses an owner approval over a failing recorded evidence set,
// so no explanation string can substitute for the recorder verdict. The stronger
// mandatory fault — a delivered result text that claims success while the checks
// failed — requires the merged Sol/Luna result channel and real workflow routes.
test('review approval is refused for a failing recorded evidence set',async t=>{
  const f=fixture(t);
  const {candidate}=await f.prepare();
  const p=await f.call('check_preview',{candidate_id:candidate.id,definition_id:'host-regression'});
  const run=await f.call('check_run',{candidate_id:candidate.id,preview_id:p.preview_id,preview_digest:p.preview.spec_digest,op_id:randomUUID()});
  const job=await settleJob(f,run.job.id);
  const evidence=f.data.list('evidence',f.base.workspace_id,f.base.project_id).filter(entry=>entry.job_id===job.id).at(-1);
  assert.equal(evidence.verdict,'fail','the recorder, not the model, decides the verdict');
  // A fabricated explanation is inert: approving a failing evidence set is refused.
  const state=await f.call('candidate_get',{candidate_id:candidate.id});
  await assert.rejects(f.call('review_decide',{candidate_id:candidate.id,evidence_ids:[evidence.id],decision:'approved',expected_identity:state.review_identity}),{code:'stale_resource'});
  const evidenceAfter=f.data.list('evidence',f.base.workspace_id,f.base.project_id).at(-1);
  assert.equal(evidenceAfter.verdict,'fail','claims never rewrite recorded evidence');
  assert.equal(fs.readFileSync(path.join(f.projectRoot,'math.js'),'utf8'),WRONG);
});

// Baseline boundary regression only: this exercises candidate_apply compare-and-swap
// and path escape refusal, not Luna's patch_preview/patch_export workflow. The
// stronger mandatory fault — source Git moves between patch_preview and
// patch_export, so the export must refuse — requires the merged workflow routes.
test('candidate_apply refuses unknown hashes and path escapes without writing the original',async t=>{
  const f=fixture(t);
  const {candidate}=await f.prepare();
  const current=await f.call('candidate_get',{candidate_id:candidate.id});
  const file=current.candidate.files.find(entry=>entry.path==='math.js');
  await assert.rejects(f.call('candidate_apply',{candidate_id:candidate.id,expected_candidate_hash:'0'.repeat(64),changes:[{op:'change',path:'math.js',expected_hash:file.hash,content:RIGHT}]}),{code:'stale_resource'});
  await assert.rejects(f.call('candidate_apply',{candidate_id:candidate.id,expected_candidate_hash:current.candidate.hash,changes:[{op:'change',path:'math.js',expected_hash:'0'.repeat(64),content:RIGHT}]}),{code:'stale_resource'});
  await assert.rejects(f.call('candidate_apply',{candidate_id:candidate.id,expected_candidate_hash:current.candidate.hash,changes:[{op:'change',path:'../escape',expected_hash:file.hash,content:RIGHT}]}));
  assert.equal(fs.readFileSync(path.join(f.projectRoot,'math.js'),'utf8'),WRONG,'the original project is never edited');
  const after=await f.call('candidate_get',{candidate_id:candidate.id});
  assert.equal(after.candidate.hash,current.candidate.hash,'a refused application leaves the candidate unchanged');
});

test('owner requests and model arguments cannot forge principals or authority',()=>{
  const workspace_id=randomUUID(),project_id=randomUUID();
  for(const field of ['actor','principal','initiated_by','authorized_by','recorded_by','grant_id','run_id']){
    assert.equal(validateNative({action:'preview',workspace_id,project_id,attempt_id:randomUUID(),context_ids:[],budget:{calls:1,checks:0,duration_ms:1000},[field]:'forged'}),false,field);
    assert.equal(validateNativeTool({action:'inspect',[field]:randomUUID()}),false,field);
  }
  assert.equal(validateNative({action:'acknowledge_unknown',workspace_id,project_id,grant_id:randomUUID(),expected_digest:'0'.repeat(64),known_externally_terminated:true,actor:'owner'}),false);
});

test('interrupted runtime ownership stays unknown and is never replayed',async t=>{
  let channel;
  const f=fixture(t,{startNative:async config=>{channel=config.channel;await config.authorize();return {completion:new Promise(()=>{})};},stopNative:async()=>({requested:true})});
  const a=await f.prepare();
  await f.native.dispatch({...f.base,action:'start',grant_id:a.grant.id});
  f.native.close();
  const replacement=createWorkbenchNative({store:f.store,records:f.records,data:f.data,execution:f.execution,hermes:f.hermes});
  t.after(()=>replacement.close());
  const status=await replacement.dispatch({...f.base,action:'status',grant_id:a.grant.id});
  assert.equal(status.grant.status,'dispatch_unknown');
  assert.equal((await replacement.dispatch({...f.base,action:'stop',grant_id:a.grant.id})).outcome_unknown,true);
  await assert.rejects(replacement.dispatch({...f.base,action:'acknowledge_unknown',grant_id:a.grant.id,expected_digest:'0'.repeat(64),known_externally_terminated:true}),{code:'stale_resource'});
  await assert.rejects(replacement.dispatch({...f.base,action:'start',grant_id:a.grant.id}),'a new start is refused while ownership is unknown');
  const acknowledged=await replacement.dispatch({...f.base,action:'acknowledge_unknown',grant_id:a.grant.id,expected_digest:status.unknown_digest,known_externally_terminated:true});
  assert.equal(acknowledged.replayed,false,'acknowledging an unknown run never replays it');
});
