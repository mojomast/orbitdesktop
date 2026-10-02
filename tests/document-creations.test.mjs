import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {creationKey,retainDocumentCreation,readDocumentCreation,listDocumentCreations,finishDocumentCreation,MAX_CREATION_BYTES} from '../src/document-creations.ts';
import {EMPTY_RICHDOC} from '../contracts/documents-v1.mjs';

function fixture(){
  const storage=new Map();globalThis.sessionStorage={setItem:(k,v)=>storage.set(k,v),getItem:k=>storage.get(k)??null,removeItem:k=>storage.delete(k),key:i=>[...storage.keys()][i],get length(){return storage.size;}};
  const workspace=randomUUID();
  const entry=()=>({version:1,workspaceId:workspace,paneId:randomUUID(),data:{kind:'richtext',format:'lexical',content:EMPTY_RICHDOC},request:{action:'create',workspace_id:workspace,document_id:randomUUID(),op_id:randomUUID(),kind:'richtext',title:'Reviewed content',intent:'Create reviewed document draft'}});
  return {storage,workspace,entry};
}
test('pending creation journal survives serialized reload, binds exact workspace/op/document/pane and refuses replacement',()=>{
  const f=fixture(),entry=f.entry(),key=creationKey(f.workspace,entry.request.op_id);
  retainDocumentCreation(entry);const serialized=f.storage.get(key);
  assert.deepEqual(readDocumentCreation(key),entry);retainDocumentCreation(structuredClone(entry));assert.equal(f.storage.get(key),serialized);
  assert.throws(()=>retainDocumentCreation({...entry,paneId:randomUUID()}),/different payload/);
  assert.equal(listDocumentCreations(randomUUID()).length,0);
  assert.equal(listDocumentCreations(f.workspace).length,1);
  const wrongKey=creationKey(randomUUID(),entry.request.op_id);f.storage.set(wrongKey,serialized);assert.equal(readDocumentCreation(wrongKey),undefined);
  const changed={...entry,data:{...entry.data,content:entry.data.content.replace('root','script')}};f.storage.set(key,JSON.stringify(changed));
  assert.equal(readDocumentCreation(key),undefined);assert.throws(()=>finishDocumentCreation(entry),/changed during recovery/);assert.ok(f.storage.has(key));
  f.storage.set(key,serialized);finishDocumentCreation(entry);assert.equal(readDocumentCreation(key),undefined);
});
test('journal capacity counts malformed slots; quota failure and invalid/oversized bytes cannot authorize dispatch',()=>{
  const f=fixture();for(let i=0;i<8;i++)retainDocumentCreation(f.entry());
  assert.throws(()=>retainDocumentCreation(f.entry()),/limit 8/);
  const [key]=f.storage.keys();f.storage.set(key,'invalid');assert.equal(listDocumentCreations(f.workspace).length,7);
  assert.throws(()=>retainDocumentCreation(f.entry()),/limit 8/);
  f.storage.clear();const entry=f.entry(),entryKey=creationKey(f.workspace,entry.request.op_id);
  f.storage.set(entryKey,' '.repeat(MAX_CREATION_BYTES+1));assert.equal(readDocumentCreation(entryKey),undefined);
  f.storage.clear();globalThis.sessionStorage.setItem=()=>{throw Error('quota');};
  assert.throws(()=>retainDocumentCreation(entry),/quota/);assert.equal(f.storage.size,0);
  assert.throws(()=>retainDocumentCreation({...entry,request:{...entry.request,workspace_id:randomUUID()}}),/Invalid pending/);
});
