import {ensureWorkspaceSynced,workspaceId} from './workspace-sync';
import {documentRequest,DocumentRequestError,type DocumentMetadata} from './document-store-client';
import type {DocumentData} from './document-store-client';
import {listDocumentDrafts,draftKey,documentDraftExists,readDocumentDraft,retainDocumentDraft} from './document-drafts';
import {listDocumentCreations,readDocumentCreation,creationKey,retainDocumentCreation,finishDocumentCreation,type DocumentCreation} from './document-creations';
import {documentPreview,reviewDocumentSnapshot,importDocument} from './document-artifacts';
import type {DocumentResultOutcome} from './document-artifacts';
import {validateDocumentData,EMPTY_RICHDOC,EMPTY_CANVAS} from '../contracts/documents-v1.mjs';
import './document-host.css';
export async function reviewCreateDocument(token:()=>string,title:string,data:DocumentData,isCurrent:()=>boolean=()=>true):Promise<DocumentResultOutcome>{
  validateDocumentData(data);data={...data};const workspace=workspaceId;
  const entry:DocumentCreation={version:1,workspaceId:workspace,paneId:crypto.randomUUID(),data,request:{action:'create',workspace_id:workspace,document_id:crypto.randomUUID(),kind:data.kind,title:title.trim().slice(0,160)||'Imported document',op_id:crypto.randomUUID(),intent:'Create reviewed document draft'}};
  return reviewCreation(token,entry,isCurrent,false);
}
async function reviewCreation(token:()=>string,entry:DocumentCreation,isCurrent:()=>boolean,recovery:boolean):Promise<DocumentResultOutcome>{
  const credential=token(),{workspaceId:workspace,paneId,data,request:body}=entry,id=body.document_id;
  const current=()=>{try{return !!credential&&token()===credential&&workspaceId===workspace&&isCurrent();}catch{return false;}};
  if(!current())return {status:'rejected',reason:'Document result source, workspace or host connection changed. Reopen the review.'};
  let retained=false;
  const applied=await reviewDocumentSnapshot(recovery?'Recover pending document creation':'Create document from reviewed content',recovery?'Creation outcome unresolved. Retry the original operation; this will not duplicate its document. The reviewed content will remain an unsaved draft.':'New empty document',documentPreview(data),async()=>{
    if(!current())throw Error('Document result source, workspace or host connection changed. No new request was dispatched.');
    await ensureWorkspaceSynced();
    if(!current())throw Error('Document result source, workspace or host connection changed. No new request was dispatched.');
    if(recovery&&JSON.stringify(readDocumentCreation(creationKey(workspace,body.op_id)))!==JSON.stringify(entry))throw Error('This pending creation changed or was already resolved. Refresh Document library.');
    // Persist the exact request and reviewed content BEFORE the first possible
    // effect. Storage/quota failure refuses dispatch, not an in-memory fallback.
    retainDocumentCreation(entry);
    if(!current())throw Error('Document result source changed. No new request was dispatched; retained snapshot is available for owner review in Document library.');
    let result:{revision:number};
    try{result=await documentRequest(token,body,new AbortController().signal);}catch(error){
      throw Error(error instanceof DocumentRequestError&&error.unknownOutcome?'Creation outcome unknown. Exact request and reviewed content are retained. Retry here or recover in Document library after reload.':`Creation not confirmed. Exact request and reviewed content remain in Document library. ${error instanceof Error?error.message:'Retry failed'}`);
    }
    if(!Number.isSafeInteger(result.revision)||result.revision<1)throw Error('Creation response invalid. Recover the retained exact creation in Document library.');
    const key=draftKey(workspace,paneId,id),existing=readDocumentDraft(key);
    if(!existing&&documentDraftExists(key))throw Error('An existing pane draft cannot be validated. Export or correct it before creation recovery; the older import has not replaced it.');
    // A crash between draft retention and journal cleanup must not replace a
    // newer recovered draft (including its exact pending save).
    if(!retainDocumentDraft(key,existing??{version:1,data,revision:result.revision,dirty:true}))throw Error('Draft recovery storage unavailable. Exact creation remains retained; retry in Document library.');
    finishDocumentCreation(entry);retained=true;
    // A response may arrive after source disposal. Keep its truthful committed
    // outcome and recoverable draft, but never open into the changed context.
    if(current())window.dispatchEvent(new CustomEvent('orbit-open-document',{detail:{id,name:body.title,paneId}}));
  });
  return applied&&retained?{status:'created-draft',documentId:id,paneId,...(!current()?{reason:'Created draft retained in Document library; source changed before opening.'}:{})}:{status:'cancelled'};
}
export function mountDocumentLibrary(host:HTMLElement,token:()=>string,_options?:{paneId?:string}):{dispose():void} {
  const controller=new AbortController();let disposed=false,busy=false,pending:DocumentCreation|undefined;
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
  const creations=document.createElement('div');creations.className='document-library-list';creations.setAttribute('aria-label','Pending document creations');
  function renderCreations(){creations.replaceChildren();const pending=listDocumentCreations(workspaceId);if(!pending.length)return;const h=document.createElement('h3');h.textContent='Pending document creations · exact recovery';creations.append(h);for(const entry of pending){const b=document.createElement('button');b.textContent=`Recover creation ${entry.request.title} · document ${entry.request.document_id} · original pane ${entry.paneId}`;b.onclick=async()=>{b.disabled=true;try{await reviewCreation(token,entry,()=>!disposed,true);await load();}catch(error){status.textContent=error instanceof Error?error.message:'Creation recovery failed';}finally{b.disabled=false;}};creations.append(b);}}
  const importFormat=document.createElement('select');importFormat.setAttribute('aria-label','New document import format');for(const f of ['text','markdown','lexical','excalidraw']){const o=document.createElement('option');o.value=f;o.textContent=f;importFormat.append(o);}
  const importText=document.createElement('textarea');importText.setAttribute('aria-label','New document content');importText.placeholder='Paste a reviewed result, transcript, Markdown, Lexical JSON or Excalidraw JSON';
  const importButton=document.createElement('button');importButton.textContent='Review new document from content';importButton.onclick=async()=>{const credential=token(),workspace=workspaceId,name=title.value;try{const data=await importDocument(importText.value,importFormat.value as 'text'|'markdown'|'lexical'|'excalidraw');await reviewCreateDocument(token,name,data,()=>!disposed&&workspace===workspaceId&&credential===token());await load();}catch(error){if(!disposed)status.textContent=error instanceof Error?error.message:'Import failed';}};
  section.append(heading,summary,title,kind,create,retry,refresh,status,creations,list,recoveries,importFormat,importText,importButton);host.replaceChildren(section);
  function open(id:string,name:string,paneId?:string){window.dispatchEvent(new CustomEvent('orbit-open-document',{detail:{id,name,paneId}}));}
  async function load(){
    if(disposed||busy)return;
    renderCreations();busy=true;create.disabled=true;
    try{
      await ensureWorkspaceSynced();if(disposed)return;
      const result=await documentRequest<{documents:DocumentMetadata[]}>(token,{action:'list'},controller.signal);if(disposed)return;
      list.replaceChildren();
      for(const d of result.documents){const b=document.createElement('button');b.textContent=`${d.title} · ${d.kind==='scene'?'Canvas':'Rich document'} · revision ${d.revision}`;b.addEventListener('click',()=>open(d.id,d.title));list.append(b);}
      recoveries.replaceChildren();const h=document.createElement('h3');h.textContent='Recoverable drafts · this browser tab';recoveries.append(h);
      for(const r of listDocumentDrafts(workspaceId)){const d=result.documents.find(d=>d.id===r.documentId);if(!d)continue;const b=document.createElement('button');b.textContent=`Recover ${d.title} · original pane ${r.paneId} · base ${r.draft.revision}${r.draft.pending?' · save outcome unknown':' · unsaved'}`;b.onclick=()=>window.dispatchEvent(new CustomEvent('orbit-open-document',{detail:{id:r.documentId,name:d.title,paneId:r.paneId}}));recoveries.append(b);}
      status.textContent=result.documents.length?'Choose a document or recover an independent original-pane draft.':'No documents yet.';
    }catch(error){if(!disposed)status.textContent=error instanceof Error?error.message:'Documents unavailable';}
    finally{busy=false;create.disabled=!!pending;}
  }
  async function commit(exact=false){
    if(disposed||busy)return;
    const credential=token(),workspace=workspaceId,scene=kind.value==='scene';
    const entry:DocumentCreation|undefined=exact?pending:{version:1,workspaceId:workspace,paneId:crypto.randomUUID(),data:{kind:scene?'scene':'richtext',format:scene?'excalidraw':'lexical',content:scene?EMPTY_CANVAS:EMPTY_RICHDOC},request:{action:'create',workspace_id:workspace,document_id:crypto.randomUUID(),kind:scene?'scene':'richtext',title:title.value.trim()||(scene?'Untitled canvas':'Untitled document'),op_id:crypto.randomUUID(),intent:'Create private document'}};
    if(!entry)return;
    const current=()=>!disposed&&workspaceId===workspace&&token()===credential;
    pending=entry;busy=true;create.disabled=true;
    try{
      await ensureWorkspaceSynced();if(!current())throw Error('Document library connection changed before creation.');
      retainDocumentCreation(entry);
      const result=await documentRequest<{revision:number}>(token,entry.request,controller.signal);
      if(!Number.isSafeInteger(result.revision)||result.revision<1)throw Error('Invalid creation response. Retry exact creation.');
      if(!current())return; // journal remains discoverable after disposal
      finishDocumentCreation(entry);pending=undefined;retry.hidden=true;
      open(entry.request.document_id,entry.request.title,entry.paneId);
    }catch(error){
      if(disposed)return;
      if(!readDocumentCreation(creationKey(workspace,entry.request.op_id)))pending=undefined;
      retry.hidden=!pending;
      status.textContent=pending?'Creation not confirmed. Retry exact creation here or recover it in Document library after reload.':error instanceof Error?error.message:'Creation failed';
    }finally{busy=false;create.disabled=!!pending;if(!disposed){renderCreations();if(!pending)void load();}}
  }
  create.addEventListener('click',()=>{void commit();});retry.addEventListener('click',()=>{void commit(true);});refresh.addEventListener('click',()=>{void load();});
  const connected=()=>{renderCreations();void load();};window.addEventListener('orbit-host-connected',connected);refresh.addEventListener('click',renderCreations);renderCreations();void load();
  return {dispose(){disposed=true;controller.abort();window.removeEventListener('orbit-host-connected',connected);section.remove();}};
}
