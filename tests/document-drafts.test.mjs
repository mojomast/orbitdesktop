import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {draftKey,documentDraftExists,retainDocumentDraft,readDocumentDraft,listDocumentDrafts,registerDocumentClose,requestDocumentClose} from '../src/document-drafts.ts';
import {EMPTY_RICHDOC} from '../contracts/documents-v1.mjs';

test('divergent recovery is keyed by document and original pane; unknown payload stays exact',()=>{
  const storage=new Map();globalThis.sessionStorage={setItem:(k,v)=>storage.set(k,v),getItem:k=>storage.get(k)??null,removeItem:k=>storage.delete(k),key:i=>[...storage.keys()][i],get length(){return storage.size;}};
  const workspace=randomUUID(),document=randomUUID(),pane=randomUUID(),other=randomUUID();
  const data={kind:'richtext',format:'lexical',content:EMPTY_RICHDOC};
  const pending={action:'save',document_id:document,pane_id:pane,expected_revision:2,data:{...data},op_id:randomUUID(),intent:'Synthetic exact save'};
  const first={version:1,data:{...data},revision:2,dirty:true,pending};
  retainDocumentDraft(draftKey(workspace,pane,document),first);
  retainDocumentDraft(draftKey(workspace,other,document),{...first,revision:3,pending:undefined});
  first.pending.intent='Mutated caller object';
  const rows=listDocumentDrafts(workspace);assert.equal(rows.length,2);
  assert.equal(rows.find(r=>r.paneId===pane).draft.pending.intent,'Synthetic exact save');
  assert.equal(rows.find(r=>r.paneId===other).draft.revision,3);
  assert.equal(listDocumentDrafts(randomUUID()).length,0);
  const invalidKey=draftKey(workspace,randomUUID(),document);storage.set(invalidKey,JSON.stringify(first));
  assert.equal(readDocumentDraft(invalidKey),undefined,'pending pane may not be transplanted');
  assert.equal(documentDraftExists(invalidKey),true,'an unreadable retained draft is not an empty slot for an older import');
  retainDocumentDraft(draftKey(workspace,other,document),{...first,dirty:false,pending:undefined});
  assert.equal(listDocumentDrafts(workspace).length,1);
  const scene={kind:'scene',format:'excalidraw',content:JSON.stringify({type:'excalidraw',version:2,source:'Orbit',elements:[0,1].map(i=>({id:`text-${i}`,type:'text',x:0,y:0,width:1,height:1,angle:0,version:1,seed:1,versionNonce:1,isDeleted:false,fontFamily:5,fontSize:20,text:'\\'.repeat(60000),originalText:'\\'.repeat(60000)})),appState:{},files:{}})};
  const large={version:1,data:scene,revision:2,dirty:true,pending:{...pending,intent:'Large exact scene',data:scene}};
  assert.ok(JSON.stringify(large).length>1500000,'valid pending scene exceeds the old cache envelope cap');
  const largeKey=draftKey(workspace,pane,document);retainDocumentDraft(largeKey,large);
  assert.equal(readDocumentDraft(largeKey).pending.data.content,scene.content);
});
test('close guards preserve cancellation and only a current registration can unregister',async()=>{
  const id=randomUUID(),old=registerDocumentClose(id,async()=>true),current=registerDocumentClose(id,async()=>false);old();
  assert.equal(await requestDocumentClose([id]),false);current();assert.equal(await requestDocumentClose([id]),true);
});
