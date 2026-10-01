import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {createDocumentsService} from '../server/documents-store.mjs';
import {EMPTY_RICHDOC,EMPTY_CANVAS,validateDocumentData} from '../contracts/documents-v1.mjs';
function fixture(t) {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'orbit-document-test-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const workspace_id=randomUUID(),document_id=randomUUID(),pane_id=randomUUID();
  const state={monitors:[{layout:{type:'split',first:{type:'pane',pane:{id:pane_id,kind:'browser',url:`orbit://document/${document_id}`}},second:{type:'pane',pane:{id:randomUUID(),kind:'agent'}}}}]};
  const service=createDocumentsService({root,workspaceRead:w=>w===workspace_id?{state,recovery_policy:{held:true}}:null});
  const scope={workspace_id,document_id,pane_id},run=body=>service.dispatch({workspace_id,...body});
  const create=(id=document_id,kind='richtext')=>run({action:'create',document_id:id,kind,title:'Synthetic document',op_id:randomUUID(),intent:'Create document'});
  const save=(expected_revision,content=EMPTY_RICHDOC)=>({...scope,action:'save',expected_revision,data:{kind:'richtext',format:'lexical',content},op_id:randomUUID(),intent:'Save document'});
  return {root,state,scope,run,service,create,save};
}
test('private documents: live pane binding, owner-library reads and hold-independent manual CAS',async t=>{
  const f=fixture(t);await f.create();
  assert.equal((await f.run({action:'read',document_id:f.scope.document_id})).revision,1);
  const op=f.save(1);assert.equal((await f.service.dispatch(op)).revision,2);
  await assert.rejects(f.service.dispatch(f.save(1)),e=>e.code==='conflict'&&e.revision===2);
  const read=await f.service.dispatch({...f.scope,action:'read'});assert.equal(read.data.content,EMPTY_RICHDOC);
  f.state.monitors[0].layout.first.pane.url='orbit://welcome';
  await assert.rejects(f.service.dispatch(op),e=>e.code==='permission_denied');
  await assert.rejects(f.service.dispatch({...f.scope,action:'read'}),e=>e.code==='permission_denied');
  await assert.rejects(f.service.dispatch({...f.scope,workspace_id:randomUUID(),action:'read'}),e=>e.code==='unavailable');
});
test('atomic exact receipts survive later edits and service restart, contain no body',async t=>{
  const f=fixture(t);await f.create();const op=f.save(1);const result=await f.service.dispatch(op);await f.service.dispatch(f.save(2));
  const restarted=createDocumentsService({root:f.root,workspaceRead:()=>({state:f.state})});
  assert.deepEqual(await restarted.dispatch(op),result);
  await assert.rejects(restarted.dispatch({...op,intent:'Changed intent'}),e=>e.code==='conflict'&&e.reason==='operation_mismatch');
  const receipt=await restarted.dispatch({...f.scope,action:'receipt',op_id:op.op_id});assert.deepEqual(receipt.result,result);assert.equal(receipt.found,true);
  const record=JSON.parse(fs.readFileSync(path.join(f.root,'documents',f.scope.workspace_id,`${f.scope.document_id}.json`)));
  assert.ok(record.receipts.every(r=>Object.keys(r).sort().join(',')==='digest,op_id,result'));
  assert.ok(!JSON.stringify(record.receipts).includes('content'));
  assert.equal(fs.statSync(path.join(f.root,'documents',f.scope.workspace_id,`${f.scope.document_id}.json`)).mode&0o777,0o600);
});
test('independent documents and simultaneous CAS: exactly one writer succeeds',async t=>{
  const f=fixture(t),other=randomUUID();await f.create();await f.create(other,'scene');
  const results=await Promise.allSettled([f.service.dispatch(f.save(1)),f.service.dispatch(f.save(1))]);assert.equal(results.filter(r=>r.status==='fulfilled').length,1);
  const canvas=await f.run({action:'read',document_id:other});assert.equal(canvas.revision,1);assert.equal(canvas.data.content,EMPTY_CANVAS);
  assert.equal((await f.run({action:'list'})).documents.length,2);
  assert.ok(!('data' in (await f.run({action:'list'})).documents[0]));
});
test('bounded hostile stored JSON and unsupported binaries never reach engines',async t=>{
  const f=fixture(t);await f.create();
  const malicious=[{root:{type:'script',version:1,children:[]}},{root:{type:'root',version:1,children:[{type:'text',version:1,text:'bad',style:'background:url(https://evil.test)'}]}},JSON.parse('{"root":{"type":"root","version":1,"children":[],"__proto__":{}}}')];
  for(const v of malicious) assert.throws(()=>validateDocumentData({kind:'richtext',format:'lexical',content:JSON.stringify(v)}));
  let root={type:'text',version:1,text:'deep'};for(let i=0;i<40;i++)root={type:i===39?'root':'paragraph',version:1,children:[root]};
  assert.throws(()=>validateDocumentData({kind:'richtext',format:'lexical',content:JSON.stringify({root})}),e=>e.code==='limit_exceeded');
  assert.throws(()=>validateDocumentData({kind:'richtext',format:'lexical',content:' '.repeat(262145)}),e=>e.code==='limit_exceeded');
  assert.throws(()=>validateDocumentData({kind:'scene',format:'excalidraw',content:' '.repeat(524289)}),e=>e.code==='limit_exceeded');
  assert.throws(()=>validateDocumentData({kind:'scene',format:'excalidraw',content:JSON.stringify({...JSON.parse(EMPTY_CANVAS),files:{image:{dataURL:'data:image/png;base64,abc'}}})}));
  const file=path.join(f.root,'documents',f.scope.workspace_id,`${f.scope.document_id}.json`),record=JSON.parse(fs.readFileSync(file));record.id=randomUUID();fs.writeFileSync(file,JSON.stringify(record));
  await assert.rejects(f.run({action:'read',document_id:f.scope.document_id}),e=>e.code==='unavailable');
});
test('strict request schemas and symlink records fail closed',async t=>{
  const f=fixture(t);await f.create();
  await assert.rejects(f.run({action:'list',extra:true}),e=>e.code==='invalid_request');
  await assert.rejects(f.service.dispatch({...f.save(1),pane_id:undefined}),e=>e.code==='invalid_request');
  await assert.rejects(f.run({action:'read',document_id:'../../escape'}),e=>e.code==='invalid_request');
  const file=path.join(f.root,'documents',f.scope.workspace_id,`${f.scope.document_id}.json`);fs.renameSync(file,file+'.bak');fs.symlinkSync(file+'.bak',file);
  await assert.rejects(f.run({action:'read',document_id:f.scope.document_id}),e=>e.code==='unavailable');
});
