import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import {execFileSync} from 'node:child_process';
import {createHash,randomUUID} from 'node:crypto';
import {SqliteWorkspaceStore} from '../server/sqlite-workspace-store.mjs';
import {WorkbenchStore} from '../server/workbench-store.mjs';
import {WorkbenchData} from '../server/workbench-data.mjs';
import {createWorkbenchGate} from '../server/workbench-gate.mjs';
import {openProjectRoot,captureProject} from '../server/project-files.mjs';
import {createWorkbenchExecution} from '../server/workbench-execution.mjs';
import {createWorkbenchNative} from '../server/workbench-native.mjs';
import {createWorkbenchNativeRuntime} from '../server/workbench-native-runtime.mjs';
import {initial} from '../src/model.ts';
import {commandIdentity} from '../server/command-identity.mjs';

const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const revision='5b31fdaba1f867eeaf7b0aa30438f096a55b54f6';
const inputs={'server/agent-profiles.mjs':'6482d38cce935e23dec3f54ba9fb2360fb554f62e409bd62076a1561081312ba','tests/agent-profiles.test.mjs':'8762a26cf205f4585e7ba92c364be0dc9f90866867be4be19ed33c72e27483c0'};
const sourceRoot=path.resolve(new URL('../',import.meta.url).pathname);
const sourceFile='server/agent-profiles.mjs';
const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));

test('pinned maintained Node project: native repair, structured checks, owner review and artifact verification', {skip:!process.env.HERMES_NATIVE_SOURCE,timeout:120000},async t=>{
  const base=fs.mkdtempSync('/tmp/opencode/workbench-real-native-'),projectRoot=path.join(base,'project');fs.mkdirSync(projectRoot);
  t.after(()=>fs.rmSync(base,{recursive:true,force:true}));
  const manifestFile=path.join(sourceRoot,'tests/workbench-real-project/manifest.json');
  if(fs.existsSync(manifestFile)){const manifest=JSON.parse(fs.readFileSync(manifestFile));assert.equal(manifest.revision,revision);assert.deepEqual(manifest.input_hashes,inputs);assert.deepEqual(manifest.inputs,Object.keys(inputs));}
  for(const [relative,expected] of Object.entries(inputs)){
    const bytes=execFileSync('/usr/bin/git',['-C',sourceRoot,'show',`${revision}:${relative}`],{env:{PATH:'/usr/bin:/bin'},maxBuffer:1024*1024});
    assert.equal(sha(bytes),expected);const target=path.join(projectRoot,relative);fs.mkdirSync(path.dirname(target),{recursive:true});fs.writeFileSync(target,bytes);
  }
  const original=fs.readFileSync(path.join(projectRoot,sourceFile),'utf8');
  assert.match(original,/data\.slice\(0, 100\)\.filter/);
  const defect=original.replace('data.slice(0, 100).filter','data.slice(0, 200).filter');
  const repaired=original.replace('/** Keep only safe identifiers','const SESSIONS_PAGE_LIMIT = 100;\n\n/** Keep only safe identifiers').replace('data.slice(0, 100).filter','data.slice(0, SESSIONS_PAGE_LIMIT).filter').replace('data.length > 100','data.length > SESSIONS_PAGE_LIMIT');
  assert.notEqual(repaired,original);assert.notEqual(defect,original);
  const baseline=execFileSync(process.execPath,['--experimental-strip-types','--test','tests/agent-profiles.test.mjs'],{cwd:projectRoot,env:{PATH:'/usr/bin:/bin',NODE_OPTIONS:''},encoding:'utf8'});
  assert.match(baseline,/# pass [1-9]/);
  const store=new SqliteWorkspaceStore(path.join(base,'runtime')),workspace_id=randomUUID(),pane_id=randomUUID();
  t.after(()=>store.close());
  store.commit(commandIdentity({workspace_id,action:'sync',base_revision:0,state:initial(),operation_id:randomUUID(),intent:'Pinned real project'},'owner'),{create:()=>({id:workspace_id,revision:1,state:initial(),capability:randomUUID(),api:'http://127.0.0.1:4318'})});
  const data=new WorkbenchData(store),records=new WorkbenchStore(store),opened=openProjectRoot(projectRoot),project=records.register(workspace_id,{root:projectRoot,name:'Pinned agent profiles',identity:opened.identity});opened.close();
  const gate=createWorkbenchGate(),execution=createWorkbenchExecution({store,records,data,gate}),scope={workspace_id,project_id:project.id},calls=[];
  t.after(()=>execution.close());
  const model=http.createServer(async(req,res)=>{
    if(req.method!=='POST'){res.setHeader('content-type','application/json');res.end(JSON.stringify({object:'list',data:[]}));return;}
    let raw='';for await(const chunk of req)raw+=chunk;
    const body=JSON.parse(raw);if(!Array.isArray(body.messages)){res.statusCode=404;res.end('{}');return;}
    const results=body.messages.filter(item=>item.role==='tool').map(item=>{try{return JSON.parse(item.content);}catch{return {};}}),step=results.length;
    calls.push({step,model:body.model});let args={action:'inspect'};
    if(step===1||step===4)args={action:'candidate_read',path:sourceFile};
    if(step===2)args={action:'candidate_patch',expected_candidate_hash:results[0].result.candidate.hash,changes:[{op:'change',path:sourceFile,expected_hash:results[1].result.file.hash,content:defect}]};
    if(step===3||step===6)args={action:'job_start'};
    if(step===5)args={action:'candidate_patch',expected_candidate_hash:results[2].result.candidate.hash,changes:[{op:'change',path:sourceFile,expected_hash:results[4].result.file.hash,content:repaired}]};
    if(step===7)args={action:'evidence',job_id:results[6].result.job.id};
    const message=step<8?{role:'assistant',content:null,tool_calls:[{id:`real_${step}`,type:'function',function:{name:'orbit_workbench',arguments:JSON.stringify(args)}}]}:{role:'assistant',content:`The bounded sessions page is repaired; see recorder evidence:${results[7].result.evidence[0].id}`};
    const completion={id:'real-project-fixture',object:'chat.completion',created:1,model:'orbit-local-fixture',choices:[{index:0,message,finish_reason:step<8?'tool_calls':'stop'}],usage:{prompt_tokens:10,completion_tokens:10,total_tokens:20}};
    if(body.stream){const delta=structuredClone(message);if(delta.tool_calls)delta.tool_calls[0].index=0;res.setHeader('content-type','text/event-stream');res.end(`data: ${JSON.stringify({...completion,object:'chat.completion.chunk',choices:[{index:0,delta,finish_reason:null}]})}\n\ndata: ${JSON.stringify({...completion,object:'chat.completion.chunk',choices:[{index:0,delta:{},finish_reason:step<8?'tool_calls':'stop'}]})}\n\ndata: [DONE]\n\n`);}
    else{res.setHeader('content-type','application/json');res.end(JSON.stringify(completion));}
  });
  await new Promise(resolve=>model.listen(0,'127.0.0.1',resolve));t.after(()=>model.close());
  const source=process.env.HERMES_NATIVE_SOURCE,keyFile=path.join(base,'endpoint-key');fs.writeFileSync(keyFile,'fixture-private-key\n',{mode:0o600});
  const runtime=createWorkbenchNativeRuntime({source,python:process.env.HERMES_NATIVE_PYTHON??path.join(source,'.venv/bin/python'),root:path.join(base,'agents'),endpoint:`http://127.0.0.1:${model.address().port}/v1`,profile_id:'fixture',config_generation:1,apiKeyFile:keyFile,gate});
  const hermes={...runtime,readBinding:async()=>({trusted_host:true,sandbox:false,profile_id:'fixture',session_id:'real-project',config_generation:1,binding_revision:1,native_runtime:runtime.bindingMetadata})};
  const native=createWorkbenchNative({store,records,data,execution,hermes});t.after(()=>native.close());
  const call=(action,fields={})=>execution.dispatch({...scope,action,...fields});
  const {task}=await call('task_create',{title:'Repair bounded sessions page',acceptance_statement:'Pinned sessions-page tests must pass and keep the page at 100 items',check_definition_id:'node-test',profile_id:'fixture',session_id:'real-project',pane_id});
  const preview=await call('candidate_preview',{task_id:task.id});const {candidate}=await call('candidate_create',{task_id:task.id,preview_id:preview.preview_id,preview_digest:preview.preview.digest});
  assert.deepEqual(task.acceptance.required_checks[0].required_test_files,['tests/agent-profiles.test.mjs']);
  assert.equal(task.acceptance.required_checks[0].execution_profile_id,null);
  const {attempt}=await call('attempt_create',{task_id:task.id,candidate_id:candidate.id,profile_id:'fixture',session_id:'real-project',pane_id});
  const consent=await native.dispatch({...scope,action:'preview',attempt_id:attempt.id,context_ids:[],budget:{calls:12,checks:2,duration_ms:90000}});
  const {grant}=await native.dispatch({...scope,action:'approve',preview_id:consent.preview_id,preview_digest:consent.preview_digest});
  await native.dispatch({...scope,action:'start',grant_id:grant.id});
  let status;for(let i=0;i<900;i++){status=await native.dispatch({...scope,action:'status',grant_id:grant.id});if(status.grant.status!=='running')break;await wait(100);}
  assert.equal(status.grant.status,'completed',JSON.stringify(status));
  assert.equal(status.result.availability,'available');assert.equal(status.result.resolved_references.length,1);
  const evidence=data.list('evidence',workspace_id,project.id);assert.deepEqual(evidence.map(item=>item.verdict),['fail','pass']);
  assert.equal(evidence[1].test_results.valid,true);assert.equal(evidence[1].test_results.complete,true);assert.ok(evidence[1].test_results.passed>0);
  const current=await call('candidate_get',{candidate_id:candidate.id});
  const {review}=await call('review_decide',{candidate_id:candidate.id,evidence_ids:[evidence[1].id],decision:'approved',expected_identity:current.review_identity});
  assert.equal(review.decision,'approved');
  const candidateRecord=data.get('candidates',workspace_id,project.id,candidate.id),captured=captureProject(project),patchRoot=path.join(store.root,'workbench-patches');fs.mkdirSync(patchRoot,{recursive:true});
  const stage=path.join(patchRoot,`.verify-${randomUUID()}`,'roundtrip');fs.mkdirSync(path.join(stage,'.git'),{recursive:true});
  for(const relative of Object.keys(inputs)){const target=path.join(stage,relative);fs.mkdirSync(path.dirname(target),{recursive:true});fs.writeFileSync(target,relative===sourceFile?repaired:fs.readFileSync(path.join(projectRoot,relative)));}
  const privatePatch=path.join(patchRoot,`${randomUUID()}.patch`);
  let patchText;try{patchText=execFileSync('/usr/bin/diff',['-u','--label',`a/${sourceFile}`,'--label',`b/${sourceFile}`,path.join(projectRoot,sourceFile),path.join(stage,sourceFile)],{encoding:'utf8',maxBuffer:1024*1024,stdio:['ignore','pipe','pipe']});}
  catch(error){if(error.status!==1)throw error;patchText=error.stdout;}
  fs.writeFileSync(privatePatch,patchText);
  fs.writeFileSync(path.join(stage,sourceFile),original);
  const gitEnv={PATH:'/usr/bin:/bin',HOME:'/dev/null',GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:'/dev/null',GIT_TERMINAL_PROMPT:'0'};
  execFileSync('/usr/bin/git',['-c','core.hooksPath=/dev/null','-c','protocol.allow=never','-C',stage,'init','--quiet'],{env:gitEnv});
  execFileSync('/usr/bin/git',['-c','core.hooksPath=/dev/null','-c','protocol.allow=never','-C',stage,'apply','--check',privatePatch],{env:gitEnv});
  execFileSync('/usr/bin/git',['-c','core.hooksPath=/dev/null','-c','protocol.allow=never','-C',stage,'apply',privatePatch],{env:gitEnv});
  assert.equal(fs.readFileSync(path.join(stage,sourceFile),'utf8'),repaired);
  const artifact=data.create('patches',{...scope,task_id:task.id,candidate_id:candidate.id,candidate_hash:candidateRecord.hash,candidate_generation:candidateRecord.generation,review_id:review.id,review_identity:review.review_identity,status:'preparing',artifact_hash:sha(patchText),bytes:Buffer.byteLength(patchText),private_root:privatePatch,source:{manifest_hash:captured.hash,files:captured.manifest.map(file=>({...file,mode:'100644'}))},candidate:{files:candidateRecord.files.map(file=>({path:file.path,hash:file.hash,bytes:file.bytes,mode:'100644'}))},review:{required_check_state:{acceptance_digest:task.acceptance_digest}},roundtrip:{verified:true}});
  const verified=await execution.verifyPatchArtifact({...scope,artifact_id:artifact.id,stage_root:stage});
  assert.equal(verified.verification.status,'verified');assert.equal(verified.verification.results[0].test_results.complete,true);
  assert.equal(fs.readFileSync(path.join(projectRoot,sourceFile),'utf8'),original);
  assert.equal(data.list('evidence',workspace_id,project.id).length,2);
  assert.equal(calls.length,9);assert.equal(JSON.stringify(calls).includes('fixture-private-key'),false);
});
