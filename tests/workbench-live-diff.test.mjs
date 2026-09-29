import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {SqliteWorkspaceStore} from '../server/sqlite-workspace-store.mjs';
import {WorkbenchStore} from '../server/workbench-store.mjs';
import {WorkbenchData} from '../server/workbench-data.mjs';
import {createWorkbenchGate} from '../server/workbench-gate.mjs';
import {openProjectRoot} from '../server/project-files.mjs';
import {createWorkbenchExecution} from '../server/workbench-execution.mjs';
import {readLiveCandidateDiff} from '../server/workbench-live-diff.mjs';
import {initial} from '../src/model.ts';
import {commandIdentity} from '../server/command-identity.mjs';

test('live candidate detail compares exact historical generations after later edits and refuses altered history',async t=>{
  const root=fs.mkdtempSync('/tmp/opencode/live-diff-'),projectRoot=path.join(root,'project');fs.mkdirSync(projectRoot);
   fs.writeFileSync(path.join(projectRoot,'math.js'),'export const sum=(a,b)=>a-b;\n');
   fs.writeFileSync(path.join(projectRoot,'note.txt'),'original\n');
  const store=new SqliteWorkspaceStore(path.join(root,'runtime')),workspace_id=randomUUID();
  store.commit(commandIdentity({workspace_id,action:'sync',base_revision:0,state:initial(),operation_id:randomUUID(),intent:'Fixture'},'owner'),{create:()=>({id:workspace_id,revision:1,state:initial(),capability:randomUUID(),api:'http://127.0.0.1:4318'})});
  const records=new WorkbenchStore(store),data=new WorkbenchData(store),opened=openProjectRoot(projectRoot);
  const project=records.register(workspace_id,{root:projectRoot,name:'Exact diff',identity:opened.identity});opened.close();
  const execution=createWorkbenchExecution({store,records,data,gate:createWorkbenchGate()});
  t.after(()=>{execution.close();store.close();fs.rmSync(root,{recursive:true,force:true});});
  const scope={workspace_id,project_id:project.id},call=(action,fields={})=>execution.dispatch({...scope,action,...fields});
  const {task}=await call('task_create',{title:'Fix sum',acceptance_statement:'sum(2,3)===5',check_definition_id:'host-regression',profile_id:'default',session_id:'orbit-live-diff'});
  const preview=await call('candidate_preview',{task_id:task.id});
  const {candidate}=await call('candidate_create',{task_id:task.id,preview_id:preview.preview_id,preview_digest:preview.preview.digest});
  const original=await call('candidate_read',{candidate_id:candidate.id,path:'math.js'});
  const second=await call('candidate_edit',{candidate_id:candidate.id,path:'math.js',expected_hash:original.file.hash,content:'export const sum=(a,b)=>a+b;\n'});
  const secondFile=await call('candidate_read',{candidate_id:candidate.id,path:'math.js'});
   const third=await call('candidate_edit',{candidate_id:candidate.id,path:'math.js',expected_hash:secondFile.file.hash,content:'export const sum=(a,b)=>Number(a)+Number(b);\n'});
   const note=await call('candidate_read',{candidate_id:candidate.id,path:'note.txt'});
   const fourth=await call('candidate_edit',{candidate_id:candidate.id,path:'note.txt',expected_hash:note.file.hash,content:'updated\n'});
  const privateCandidate=data.get('candidates',workspace_id,project.id,candidate.id);
  const reference={kind:'candidate',id:candidate.id,generation:2,hash:second.candidate.hash};
  const diff=await readLiveCandidateDiff({execution,candidate:privateCandidate,...scope,reference});
  assert.equal(diff.available,true);assert.equal(diff.from.generation,1);assert.equal(diff.to.generation,2);
   assert.equal(diff.files[0].old_text,original.file.text);assert.equal(diff.files[0].new_text,secondFile.file.text);
   assert.equal(diff.files[0].old_bytes,Buffer.byteLength(original.file.text));
   assert.equal(diff.files[0].new_bytes,Buffer.byteLength(secondFile.file.text));
   assert.equal(diff.files[0].old_mode,'100644');assert.equal(diff.files[0].new_mode,'100644');
   assert.equal(JSON.stringify(diff).includes('Number(a)'),false,'current generation is never substituted');
   const later={kind:'candidate',id:candidate.id,generation:4,hash:fourth.candidate.hash};
   const previous=await readLiveCandidateDiff({execution,candidate:privateCandidate,...scope,reference:later});
   const overall=await readLiveCandidateDiff({execution,candidate:privateCandidate,...scope,reference:later,comparison:'initial'});
   assert.deepEqual(previous.files.map(file=>file.path),['note.txt']);
   assert.deepEqual(overall.files.map(file=>file.path),['math.js','note.txt']);
   assert.equal(overall.from.generation,1);assert.equal(overall.to.generation,4);
   assert.equal(overall.comparison,'initial');
   const secondInitial=await readLiveCandidateDiff({execution,candidate:privateCandidate,...scope,reference,comparison:'initial'});
   assert.equal(secondInitial.to.generation,2);assert.equal(secondInitial.files.length,1);
   assert.equal(secondInitial.files[0].new_text,secondFile.file.text);
   assert.equal(JSON.stringify(secondInitial).includes('Number(a)'),false);
   const first=privateCandidate.root_history.find(entry=>entry.generation===1);
   const self=await readLiveCandidateDiff({execution,candidate:privateCandidate,...scope,reference:{generation:1,hash:first.hash},comparison:'initial'});
   assert.equal(self.available,true);assert.equal(self.changed_files,0);assert.equal(self.from.generation,1);assert.equal(self.to.generation,1);
   const missing=await readLiveCandidateDiff({execution,candidate:{...privateCandidate,root_history:[]},...scope,reference,comparison:'initial'});
   assert.equal(missing.available,false);assert.equal(missing.to.generation,2);
   const wrong=await readLiveCandidateDiff({execution,candidate:privateCandidate,...scope,reference:{generation:2,hash:'0'.repeat(64)},comparison:'initial'});
   assert.equal(wrong.available,false);assert.equal(wrong.to.candidate_hash,'0'.repeat(64));
    const oldRoot=privateCandidate.root_history.find(version=>version.generation===1).root;
    const secondRoot=privateCandidate.root_history.find(version=>version.generation===2).root;
    fs.chmodSync(path.join(secondRoot,'note.txt'),0o700);
    const modes=await readLiveCandidateDiff({execution,candidate:privateCandidate,...scope,reference});
    const modeOnly=modes.files.find(file=>file.path==='note.txt');
    assert.equal(modeOnly.old_hash,modeOnly.new_hash);assert.equal(modeOnly.old_mode,'100644');assert.equal(modeOnly.new_mode,'100755');
    assert.equal(modes.mode_provenance,'retained_tree_observation');
    fs.chmodSync(path.join(secondRoot,'note.txt'),0o600);
  fs.writeFileSync(path.join(oldRoot,'math.js'),'tampered historical tree\n');
  const unavailable=await readLiveCandidateDiff({execution,candidate:privateCandidate,...scope,reference});
  assert.equal(unavailable.available,false);assert.equal(unavailable.reason,'historical_diff_unavailable');
   assert.equal(unavailable.current_generation,4);assert.equal(unavailable.from.generation,1);assert.equal(unavailable.to.generation,2);
   assert.equal(JSON.stringify(unavailable).includes('tampered'),false);
   const tamperedInitial=await readLiveCandidateDiff({execution,candidate:privateCandidate,...scope,reference:later,comparison:'initial'});
   assert.equal(tamperedInitial.available,false);assert.equal(tamperedInitial.from.generation,1);
 });

test('read race revalidates both identities and refuses partial source; binary and byte limits retain metadata',async()=>{
  const candidate={id:'candidate',generation:2,hash:'new',root_history:[{generation:1,hash:'old'}]};
  const reference={generation:2,hash:'new'},scope={workspace_id:'workspace',project_id:'project'};
  const version={old:{files:[{path:'image.bin',hash:'a',mode:33188,bytes:12}]},new:{files:[{path:'image.bin',hash:'b',mode:33188,bytes:14}]}};
  let gets=0;
  const execution={dispatch:async request=>{
    if(request.action==='candidate_version_get'){
      gets++;
      if(gets===4)throw Object.assign(new Error('changed during read'),{code:'stale_resource'});
      return {candidate:version[request.candidate_hash]};
    }
    return {file:{binary:true,bytes:request.candidate_hash==='old'?12:14}};
  }};
  const unavailable=await readLiveCandidateDiff({execution,candidate,...scope,reference});
  assert.equal(gets,4);
  assert.deepEqual({from:unavailable.from,to:unavailable.to},
    {from:{candidate_id:'candidate',generation:1,candidate_hash:'old'},to:{candidate_id:'candidate',generation:2,candidate_hash:'new'}});
  assert.equal(unavailable.available,false);assert.equal(unavailable.files,undefined);
  let rechecks=0;
  const afterText=await readLiveCandidateDiff({execution:{dispatch:async request=>{
    if(request.action==='candidate_version_read')return {file:{binary:false,text:'secret before failure'}};
    if(++rechecks===4)throw Object.assign(new Error('retained tree changed'),{code:'stale_resource'});
    return {candidate:version[request.candidate_hash]};
  }},candidate,...scope,reference});
  assert.equal(afterText.available,false);assert.equal(afterText.files,undefined);
  assert.equal(JSON.stringify(afterText).includes('secret before failure'),false);
  const binary=await readLiveCandidateDiff({execution:{dispatch:async request=>request.action==='candidate_version_get'
    ?{candidate:version[request.candidate_hash]}:{file:{binary:true}}},candidate,...scope,reference});
  assert.deepEqual(binary.files,[{path:'image.bin',old_hash:'a',new_hash:'b',old_mode:33188,new_mode:33188,
    old_bytes:12,new_bytes:14,text_available:false,reason:'binary'}]);
  const huge={old:{files:[{path:'big.txt',hash:'a',mode:33188,bytes:40000}]},new:{files:[{path:'big.txt',hash:'b',mode:33188,bytes:40000}]}};
  const bounded=await readLiveCandidateDiff({execution:{dispatch:async request=>{
    assert.equal(request.action,'candidate_version_get');return {candidate:huge[request.candidate_hash]};
  }},candidate,...scope,reference});
  assert.equal(bounded.files[0].text_available,false);assert.equal(bounded.files[0].reason,'detail_byte_bound');
  assert.equal(bounded.files[0].old_bytes,40000);assert.equal(bounded.truncated,true);
});

test('a retained executable-mode race fails closed without returning previously read text',async()=>{
  const candidate={id:'candidate',generation:2,hash:'new',root_history:[{generation:1,hash:'old'}]};
  let gets=0;
  const execution={dispatch:async request=>{
    if(request.action==='candidate_version_get')return {candidate:{files:[{path:'script.sh',hash:request.candidate_hash,bytes:1,mode:++gets===4?'100755':'100644'}]}};
    return {file:{binary:false,text:'private'}};
  }};
  const diff=await readLiveCandidateDiff({execution,candidate,workspace_id:'workspace',project_id:'project',reference:{generation:2,hash:'new'}});
  assert.equal(diff.available,false);assert.equal(diff.reason,'historical_mode_changed_during_read');assert.equal(diff.files,undefined);
  assert.equal(JSON.stringify(diff).includes('private'),false);
});

test('47 changed paths report the exact total and return only the first 32 sorted paths',async()=>{
  const candidate={id:'candidate',generation:2,hash:'new',root_history:[{generation:1,hash:'old'}]};
  const oldFiles=Array.from({length:47},(_,i)=>({path:`file-${String(i).padStart(2,'0')}.txt`,hash:`old-${i}`,mode:33188,bytes:0}));
  const newFiles=oldFiles.map(file=>({...file,hash:file.hash.replace('old-','new-')}));
  const readPaths=[];
  const execution={dispatch:async request=>{
    if(request.action==='candidate_version_get')return {candidate:{files:request.candidate_hash==='old'?oldFiles:newFiles}};
    readPaths.push(request.path);
    return {file:{text:'',binary:false}};
  }};
  const diff=await readLiveCandidateDiff({execution,candidate,workspace_id:'workspace',project_id:'project',reference:{generation:2,hash:'new'}});
  assert.equal(diff.available,true);assert.equal(diff.changed_files,47);assert.equal(diff.files.length,32);assert.equal(diff.truncated,true);
  assert.deepEqual(diff.files.map(file=>file.path),oldFiles.slice(0,32).map(file=>file.path));
  assert.equal(readPaths.length,64);
  assert.ok(diff.files.every(file=>file.old_bytes===0&&file.new_bytes===0&&file.text_available));
  readPaths.length=0;
  const focused=await readLiveCandidateDiff({execution,candidate,workspace_id:'workspace',project_id:'project',reference:{generation:2,hash:'new'},file_path:'file-46.txt'});
  assert.equal(focused.changed_files,47);assert.deepEqual(focused.files.map(file=>file.path),['file-46.txt']);assert.deepEqual(readPaths,['file-46.txt','file-46.txt']);
  readPaths.length=0;
  const escaped=await readLiveCandidateDiff({execution,candidate,workspace_id:'workspace',project_id:'project',reference:{generation:2,hash:'new'},file_path:'../../outside'});
  assert.equal(escaped.available,false);assert.equal(escaped.reason,'path_not_in_exact_changes');assert.equal(readPaths.length,0);
});

test('mode-only change and added/deleted empty files retain exact identities and metadata',async()=>{
  const candidate={id:'candidate',generation:2,hash:'new',root_history:[{generation:1,hash:'old'}]};
  const versions={old:[
    {path:'deleted.txt',hash:'empty-old',mode:33188,bytes:0},
    {path:'mode.txt',hash:'same',mode:33188,bytes:4}
  ],new:[
    {path:'added.txt',hash:'empty-new',mode:33188,bytes:0},
    {path:'mode.txt',hash:'same',mode:33261,bytes:4}
  ]};
  const execution={dispatch:async request=>request.action==='candidate_version_get'
    ?{candidate:{files:versions[request.candidate_hash]}}
    :{file:{text:request.path==='mode.txt'?'same':'',binary:false}}};
  const diff=await readLiveCandidateDiff({execution,candidate,workspace_id:'workspace',project_id:'project',reference:{generation:2,hash:'new'}});
  assert.equal(diff.changed_files,3);assert.equal(diff.truncated,false);
  const byPath=Object.fromEntries(diff.files.map(file=>[file.path,file]));
  assert.deepEqual([byPath['added.txt'].old_hash,byPath['added.txt'].new_hash,byPath['added.txt'].old_bytes,byPath['added.txt'].new_bytes,byPath['added.txt'].old_text,byPath['added.txt'].new_text],
    [null,'empty-new',0,0,null,'']);
  assert.deepEqual([byPath['deleted.txt'].old_hash,byPath['deleted.txt'].new_hash,byPath['deleted.txt'].old_text,byPath['deleted.txt'].new_text],
    ['empty-old',null,'',null]);
  assert.deepEqual([byPath['mode.txt'].old_mode,byPath['mode.txt'].new_mode,byPath['mode.txt'].old_text,byPath['mode.txt'].new_text],
    [33188,33261,'same','same']);
});

test('binary metadata and actual UTF-8 bytes enforce the cumulative 64 KiB bound without source leakage',async()=>{
  const candidate={id:'candidate',generation:2,hash:'new',root_history:[{generation:1,hash:'old'}]};
  const oldFiles=['a-binary.bin','b-small.txt','c-too-big.txt'].map(path=>({path,hash:`old-${path}`,mode:33188,bytes:path==='a-binary.bin'?12:1}));
  const newFiles=oldFiles.map(file=>({...file,hash:file.hash.replace('old-','new-'),bytes:file.path==='a-binary.bin'?14:1}));
  const secret='🎯'.repeat(20000);
  const execution={dispatch:async request=>{
    if(request.action==='candidate_version_get')return {candidate:{files:request.candidate_hash==='old'?oldFiles:newFiles}};
    if(request.path==='a-binary.bin')return {file:{binary:true,text:'private binary text'}};
    return {file:{binary:false,text:request.path==='b-small.txt'?'✓':secret}};
  }};
  const diff=await readLiveCandidateDiff({execution,candidate,workspace_id:'workspace',project_id:'project',reference:{generation:2,hash:'new'}});
  assert.equal(diff.available,true);assert.equal(diff.changed_files,3);assert.equal(diff.truncated,true);
  assert.equal(diff.files[0].reason,'binary');assert.equal(diff.files[0].old_bytes,12);assert.equal(diff.files[0].new_bytes,14);
  assert.equal(diff.files[1].text_available,true);assert.equal(diff.files[1].old_text,'✓');
  assert.equal(diff.files[2].text_available,false);assert.equal(diff.files[2].reason,'detail_byte_bound');
  assert.equal(JSON.stringify(diff).includes(secret),false);assert.equal(JSON.stringify(diff).includes('private binary text'),false);
  assert.ok(diff.files.reduce((total,file)=>total+Buffer.byteLength(file.old_text??'')+Buffer.byteLength(file.new_text??''),0)<=65536);
});

test('candidate moving to a later generation during read does not substitute current source',async()=>{
  const candidate={id:'candidate',generation:2,hash:'new',root_history:[{generation:1,hash:'old'}]};
  const version={old:{files:[{path:'file.txt',hash:'before',mode:33188,bytes:3}]},new:{files:[{path:'file.txt',hash:'after',mode:33188,bytes:3}]}};
  const requests=[];
  const execution={dispatch:async request=>{
    requests.push([request.action,request.generation,request.candidate_hash]);
    if(request.action==='candidate_version_get')return {candidate:version[request.candidate_hash]};
    candidate.root_history.push({generation:2,hash:'new'});
    candidate.generation=3;candidate.hash='latest';
    return {file:{binary:false,text:request.candidate_hash==='old'?'old':'new'}};
  }};
  const diff=await readLiveCandidateDiff({execution,candidate,workspace_id:'workspace',project_id:'project',reference:{generation:2,hash:'new'}});
  assert.equal(diff.available,true);assert.equal(diff.files[0].old_text,'old');assert.equal(diff.files[0].new_text,'new');
  assert.equal(diff.to.generation,2);
  assert.equal(requests.length,6);
  assert.ok(requests.every(([,generation,hash])=>generation===1&&hash==='old'||generation===2&&hash==='new'));
});
