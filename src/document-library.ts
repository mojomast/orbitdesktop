import {ensureWorkspaceSynced,workspaceId} from './workspace-sync';
import {documentRequest,DocumentRequestError,type DocumentMetadata} from './document-store-client';
import type {DocumentData} from './document-store-client';
import {listDocumentDrafts,draftKey,retainDocumentDraft} from './document-drafts';
import {documentPreview,reviewDocumentSnapshot,importDocument} from './document-artifacts';
import type {DocumentResultOutcome} from './document-artifacts';
import {validateDocumentData} from '../contracts/documents-v1.mjs';
import './document-host.css';
export async function reviewCreateDocument(token:()=>string,title:string,data:DocumentData):Promise<DocumentResultOutcome>{
  validateDocumentData(data);data={...data};const workspace=workspaceId;
  const id=crypto.randomUUID(),paneId=crypto.randomUUID(),body={action:'create',document_id:id,kind:data.kind,title:title.trim().slice(0,160)||'Imported document',op_id:crypto.randomUUID(),intent:'Create reviewed document draft'};
  const applied=await reviewDocumentSnapshot('Create document from reviewed content','New empty document',documentPreview(data),async()=>{
    if(workspaceId!==workspace)throw Error('Workspace changed. Reopen the review.');
    await ensureWorkspaceSynced();
    if(workspaceId!==workspace)throw Error('Workspace changed. Reopen the review.');
    // Exact operation stays captured if the response is lost; clicking Apply again
    // retries this creation, never allocates a second artifact.
    await documentRequest(token,body,new AbortController().signal);
    if(!retainDocumentDraft(draftKey(workspace,paneId,id),{version:1,data,revision:1,dirty:true}))throw Error('Draft recovery storage unavailable. Retry or export the content.');
    if(workspaceId!==workspace)throw Error('Created draft retained in the original workspace. Return there to recover it.');
    window.dispatchEvent(new CustomEvent('orbit-open-document',{detail:{id,name:body.title,paneId}}));
  });
  return applied?{status:'created-draft',documentId:id,paneId}:{status:'cancelled'};
}
export function mountDocumentLibrary(host:HTMLElement,token:()=>string,_options?:{paneId?:string}):{dispose():void} {
  const controller=new AbortController();let disposed=false,busy=false,pending:Record<string,unknown>|undefined;
  const section=document.createElement('section');section.className='document-library';section.dataset.documentLibrary='true';
  const heading=document.createElement('h2');heading.textContent='Documents & canvas';
  const summary=document.createElement('p');summary.textContent='Private workspace documents. Open a saved document or create an independent rich document or canvas.';
  const title=document.createElement('input');title.placeholder='Document title';title.setAttribute('aria-label','Document title');title.maxLength=160;
  const kind=document.createElement('select');kind.setAttribute('aria-label','Document kind');for(const [value,label] of [['richtext','Rich document'],['scene','Canvas']]){const o=document.createElement('option');o.value=value;o.textContent=label;kind.append(o);}
  const create=document.createElement('button');create.textContent='Create document';
  const refresh=document.createElement('button');refresh.textContent='Refresh documents';
  const retry=document.createElement('button');retry.textContent='Retry exact creation';retry.hidden=true;
  const status=document.createElement('p');status.setAttribute('role','status');
  const list=document.createElement('div');list.className='document-library-list';
  const recoveries=document.createElement('div');recoveries.className='document-library-list';recoveries.setAttribute('aria-label','Recoverable document drafts');
  const importFormat=document.createElement('select');importFormat.setAttribute('aria-label','New document import format');for(const f of ['text','markdown','lexical','excalidraw']){const o=document.createElement('option');o.value=f;o.textContent=f;importFormat.append(o);}
  const importText=document.createElement('textarea');importText.setAttribute('aria-label','New document content');importText.placeholder='Paste a reviewed result, transcript, Markdown, Lexical JSON or Excalidraw JSON';
  const importButton=document.createElement('button');importButton.textContent='Review new document from content';importButton.onclick=async()=>{try{const data=await importDocument(importText.value,importFormat.value as 'text'|'markdown'|'lexical'|'excalidraw');await reviewCreateDocument(token,title.value,data);await load();}catch(error){status.textContent=error instanceof Error?error.message:'Import failed';}};
  section.append(heading,summary,title,kind,create,retry,refresh,status,list,recoveries,importFormat,importText,importButton);host.replaceChildren(section);
  function open(id:string,name:string){window.dispatchEvent(new CustomEvent('orbit-open-document',{detail:{id,name}}));}
  async function load(){if(disposed||busy)return;busy=true;create.disabled=true;try{await ensureWorkspaceSynced();if(disposed)return;const result=await documentRequest<{documents:DocumentMetadata[]}>(token,{action:'list'},controller.signal);if(disposed)return;list.replaceChildren();for(const d of result.documents){const b=document.createElement('button');b.textContent=`${d.title} · ${d.kind==='scene'?'Canvas':'Rich document'} · revision ${d.revision}`;b.addEventListener('click',()=>open(d.id,d.title));list.append(b);}recoveries.replaceChildren();const h=document.createElement('h3');h.textContent='Recoverable drafts · this browser tab';recoveries.append(h);for(const r of listDocumentDrafts(workspaceId)){const d=result.documents.find(d=>d.id===r.documentId);if(!d)continue;const b=document.createElement('button');b.textContent=`Recover ${d.title} · original pane ${r.paneId} · base ${r.draft.revision}${r.draft.pending?' · save outcome unknown':' · unsaved'}`;b.onclick=()=>window.dispatchEvent(new CustomEvent('orbit-open-document',{detail:{id:r.documentId,name:d.title,paneId:r.paneId}}));recoveries.append(b);}status.textContent=result.documents.length?'Choose a document or recover an independent original-pane draft.':'No documents yet.';}catch(error){if(!disposed)status.textContent=error instanceof Error?error.message:'Documents unavailable';}finally{busy=false;create.disabled=!!pending;}}
  async function commit(exact=false){if(disposed||busy)return;const body=exact?pending:{action:'create',document_id:crypto.randomUUID(),kind:kind.value,title:title.value.trim()||(kind.value==='scene'?'Untitled canvas':'Untitled document'),op_id:crypto.randomUUID(),intent:'Create private document'};if(!body)return;pending=body;busy=true;create.disabled=true;try{await ensureWorkspaceSynced();if(disposed)return;await documentRequest(token,body,controller.signal);if(disposed)return;pending=undefined;retry.hidden=true;open(String(body.document_id),String(body.title));}catch(error){if(disposed)return;if(error instanceof DocumentRequestError&&!error.unknownOutcome)pending=undefined;retry.hidden=!pending;status.textContent=pending?'Creation outcome unknown. Retry exact creation.':error instanceof Error?error.message:'Creation failed';}finally{busy=false;create.disabled=!!pending;if(!pending&&!disposed)void load();}}
  create.addEventListener('click',()=>{void commit();});retry.addEventListener('click',()=>{void commit(true);});refresh.addEventListener('click',()=>{void load();});
  const connected=()=>{void load();};window.addEventListener('orbit-host-connected',connected);void load();
  return {dispose(){disposed=true;controller.abort();window.removeEventListener('orbit-host-connected',connected);section.remove();}};
}
