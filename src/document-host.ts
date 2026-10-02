import {workspaceId,ensureWorkspaceSynced} from './workspace-sync';
import {documentRequest,DocumentRequestError,downloadDocument,type DocumentRead,type DocumentData,type MountedDocumentEditor} from './document-store-client';
import {validateDocumentData} from '../contracts/documents-v1.mjs';
import {draftKey,readDocumentDraft,retainDocumentDraft,registerDocumentClose,type DocumentDraft} from './document-drafts';
import {documentDigest,documentPreview,importDocument,reviewDocumentSnapshot} from './document-artifacts';
import {requestConversationContext} from './conversation-transfer';
import './document-host.css';
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export const DOCUMENT_URL_PREFIX='orbit://document/';
export function documentId(url:string):string|null {const id=url.startsWith(DOCUMENT_URL_PREFIX)?url.slice(DOCUMENT_URL_PREFIX.length):'';return UUID.test(id)?id:null;}
export function documentUrl(id:string):string {if(!UUID.test(id))throw Error('Invalid document ID');return DOCUMENT_URL_PREFIX+id;}
type Draft=DocumentDraft;
export function mountDocumentHost(host:HTMLElement,id:string,token:()=>string,options:{paneId:string}):{dispose():void} {
  if(!UUID.test(id)||!UUID.test(options.paneId))throw Error('Invalid document binding');
  const key=draftKey(workspaceId,options.paneId,id);
  const controller=new AbortController();let disposed=false,editor:MountedDocumentEditor|undefined,draft:Draft|undefined,busy=false,valid=false,title='Document',remoteRevision:number|undefined,generation=0;
  const shell=document.createElement('section');shell.className='document-host';shell.dataset.documentId=id;
  const bar=document.createElement('div');bar.className='document-actions';
  const heading=document.createElement('strong');heading.textContent='Private document';
  const status=document.createElement('div');status.className='document-status';status.setAttribute('role','status');
  const area=document.createElement('div');area.className='document-editor';
  function button(name:string,fn:()=>void) {const b=document.createElement('button');b.type='button';b.textContent=name;b.addEventListener('click',fn);bar.append(b);return b;}
  bar.append(heading);
  const save=button('Save document',()=>{void commit(false);});
  const retry=button('Retry exact save',()=>{void commit(true);});
  const reload=button('Reload saved document',()=>{if(!draft?.dirty||window.confirm('Discard this pane’s unsaved edits and reload the saved document?'))void load(true);});
  const rebase=button('Keep draft on current revision',()=>{if(draft&&remoteRevision!==undefined&&!draft.pending){generation++;draft.revision=remoteRevision;remoteRevision=undefined;persist();message('Draft retained. Save document explicitly to replace the current saved revision.');}});
  const json=button('Export JSON',()=>{if(!draft)return;try{validateDocumentData(draft.data);downloadDocument(draft.data.content,`${title.replace(/[^a-z0-9_-]/gi,'_')}.${draft.data.kind==='scene'?'excalidraw':'json'}`);}catch(error){message(error instanceof Error?error.message:'Document export refused');}});
  const markdown=button('Export Markdown',()=>{if(editor?.exportMarkdown)downloadDocument(editor.exportMarkdown(),`${title.replace(/[^a-z0-9_-]/gi,'_')}.md`,'text/markdown');});
  const importButton=button('Import / review replacement',()=>{void reviewImport();});
  const share=button('Share selected content',()=>{void shareSelection();});
  share.addEventListener('mousedown',e=>e.preventDefault());
  shell.append(bar,status,area);host.replaceChildren(shell);
  function message(text:string) {if(!disposed){status.textContent=text;controls();}}
  function controls() {save.disabled=busy||!valid||!draft?.dirty||!!draft?.pending;retry.hidden=!draft?.pending;retry.disabled=busy||!valid;reload.disabled=busy||!!draft?.pending;rebase.hidden=remoteRevision===undefined||!!draft?.pending;json.disabled=!draft;markdown.hidden=!editor?.exportMarkdown;importButton.disabled=busy||!valid||!editor||!!draft?.pending;share.disabled=!editor;}
  function persist() {
    if(!draft)return;
    if(!retainDocumentDraft(key,draft))message('Draft is retained in memory; browser recovery storage is unavailable. Export before reloading.');
  }
  function changed(content:string) {
    if(!draft||disposed)return;
    generation++;draft.data={...draft.data,content};draft.dirty=true;persist();message(`Unsaved edits · base revision ${draft.revision}`);
  }
  function recovered():Draft|undefined {
    return readDocumentDraft(key);
  }
  async function shareSelection(){
    if(!draft||!editor)return;const text=editor.selectedContent(),snapshot=draft.data.content,revision=draft.revision,dirty=draft.dirty;
    if(!text.trim()){message('Select text or shapes inside the editor first.');return;}
    const digest=await documentDigest(snapshot);
    const payload=`${text}\n\n[Orbit document selection · ${dirty?'unsaved draft snapshot':'saved-base snapshot'}]\nDocument: ${id}\nOriginal pane: ${options.paneId}\nBase revision: ${revision}\nDraft SHA-256: ${digest}\nSelection is an included excerpt, not the complete document. Historical bodies are not retained by the store.`;
    if(payload.length>20000){message('Selection exceeds 20,000 characters including provenance. Select fewer text or shapes.');return;}
    if(disposed)return;await requestConversationContext({text:payload,title:'Selected document content'});
  }
  async function reviewImport(){
    if(!draft||!editor||busy||draft.pending)return;
    const dialog=document.createElement('dialog');dialog.className='document-review';dialog.setAttribute('aria-label','Import document draft');
    const info=document.createElement('p');info.textContent='Paste supported content or a proposal {base_revision, base_digest, data:{kind,format,content}}. Review replaces the whole draft, is undoable, and does not save.';
    const format=document.createElement('select');format.setAttribute('aria-label','Import format');for(const f of draft.data.kind==='scene'?['excalidraw','proposal']:['text','markdown','lexical','proposal']){const o=document.createElement('option');o.value=f;o.textContent=f;format.append(o);}
    const input=document.createElement('textarea');input.setAttribute('aria-label','Import content');const file=document.createElement('input');file.type='file';file.accept='.json,.excalidraw,.md,.txt';file.setAttribute('aria-label','Import file');file.onchange=async()=>{const f=file.files?.[0];if(f){if(f.size>524288){status.textContent='File exceeds the document limit.';return;}input.value=await f.text();}};
    const status=document.createElement('p');status.setAttribute('role','status');const cancel=document.createElement('button');cancel.textContent='Cancel';cancel.onclick=()=>dialog.close();const preview=document.createElement('button');preview.textContent='Review replacement';preview.onclick=async()=>{preview.disabled=true;try{
      if(!draft||!editor||draft.pending||busy||disposed)throw Error('Document is unavailable or a save is unresolved.');
      const before={...draft.data},revision=draft.revision,baseGeneration=generation,digest=await documentDigest(before.content);
      let next:DocumentData;
      if(format.value==='proposal'){if(new TextEncoder().encode(input.value).length>1500000)throw Error('Proposal envelope exceeds the import limit.');const p=JSON.parse(input.value);if(p.base_revision!==revision||p.base_digest!==digest)throw Error('Proposal base is stale. Request a proposal for the current revision and draft digest.');next=p.data;validateDocumentData(next);}else next=await importDocument(input.value,format.value as 'text'|'markdown'|'lexical'|'excalidraw');
      if(next.kind!==before.kind)throw Error('Import kind must match this document.');
      dialog.close();await reviewDocumentSnapshot('Review whole-document replacement',documentPreview(before),documentPreview(next),async()=>{
        if(disposed||!draft||!editor||!valid||busy||draft.pending||generation!==baseGeneration||draft.revision!==revision||draft.data.content!==before.content)throw Error('Draft changed during review. Reopen review against the current draft.');
        const remote=await documentRequest<DocumentRead>(token,{action:'read',document_id:id,pane_id:options.paneId},controller.signal);
        if(disposed||!draft||!editor||busy||draft.pending||generation!==baseGeneration||draft.revision!==revision||draft.data.content!==before.content||remote.revision!==revision)throw Error('Saved revision or local draft changed during review. Keep your edits and review again.');
        editor.applySnapshot(next.content);changed(editor.getContent());
      });
    }catch(error){status.textContent=error instanceof Error?error.message:'Import failed';}finally{preview.disabled=false;}};
    dialog.append(info,format,file,input,status,cancel,preview);dialog.addEventListener('close',()=>dialog.remove(),{once:true});document.body.append(dialog);dialog.showModal();
  }
  const unregisterClose=registerDocumentClose(options.paneId,async()=>{
    if(!draft?.dirty&&!draft?.pending)return true;
    return new Promise<boolean>(resolve=>{const dialog=document.createElement('dialog');dialog.setAttribute('aria-label','Close private document');const text=document.createElement('p');text.textContent=draft?.pending?'Save outcome is unresolved. Retain this exact draft and pending operation for recovery, or keep editing.':'This document has unsaved edits. Save before closing or retain a recoverable draft in this browser tab.';const status=document.createElement('p');status.setAttribute('role','status');let allowed=false;
      const keep=document.createElement('button');keep.textContent='Keep editing';keep.onclick=()=>dialog.close();const retain=document.createElement('button');retain.textContent='Retain draft and close';retain.onclick=()=>{if(draft&&!retainDocumentDraft(key,draft)){status.textContent='Recovery storage unavailable. Export the draft before closing.';return;}allowed=true;dialog.close();};const saveClose=document.createElement('button');saveClose.textContent='Save and close';saveClose.disabled=busy||!!draft?.pending||!valid;saveClose.onclick=async()=>{saveClose.disabled=true;await commit(false);if(!draft?.dirty&&!draft?.pending){allowed=true;dialog.close();}else{status.textContent='Not closed: save failed, is unresolved, or newer edits remain.';saveClose.disabled=busy||!!draft?.pending||!valid;}};
      dialog.append(text,status,keep,retain,saveClose);dialog.addEventListener('close',()=>{dialog.remove();resolve(allowed);},{once:true});document.body.append(dialog);dialog.showModal();});
  });
  async function load(discard=false) {
    if(busy||disposed)return;busy=true;message('Loading private document…');
    try {
      await ensureWorkspaceSynced();if(disposed)return;
      const result=await documentRequest<DocumentRead>(token,{action:'read',document_id:id,pane_id:options.paneId},controller.signal);
      if(disposed)return;validateDocumentData(result.data);valid=true;title=result.document.title;heading.textContent=title;
      const cache=discard?undefined:recovered();
      generation++;draft=cache??{version:1,data:result.data,revision:result.revision,dirty:false};
      if(cache&&cache.revision!==result.revision)remoteRevision=result.revision;else remoteRevision=undefined;
      if(editor){editor.setContent(draft.data.content);editor.setReadOnly(false);}
      else {
        const module=draft.data.kind==='richtext'?await import('./richdoc-editor'):await import('./canvas-editor');
        if(disposed)return;editor=await module.mountEditor(area,draft.data.content,changed);if(disposed){editor.dispose();editor=undefined;return;}
      }
      persist();message(draft.pending?'Previous save outcome unknown. Retry the exact save before sending another save.':cache?'Recovered pane draft. Saved content has not replaced your edits.':`Saved revision ${result.revision}`);
    }catch(error){if(!disposed)message(error instanceof Error?error.message:'Document unavailable');}
    finally {busy=false;controls();}
  }
  async function commit(exact:boolean) {
    if(busy||!valid||!draft||disposed)return;
    if(!exact&&draft.pending)return;
    const request=exact?draft.pending:{action:'save',document_id:id,pane_id:options.paneId,expected_revision:draft.revision,data:{...draft.data},op_id:crypto.randomUUID(),intent:'Save private document'};
    if(!request)return;
    try {validateDocumentData(request.data);}catch(error){message(error instanceof Error?error.message:'Invalid document');return;}
    draft.pending=request;persist();busy=true;message('Saving…');
    try {
      const result=await documentRequest<{revision:number}>(token,request,controller.signal);
      if(disposed)return;
      if(!Number.isSafeInteger(result.revision))throw new DocumentRequestError('invalid_response',true);
      generation++;draft.revision=result.revision;draft.dirty=draft.data.content!==(request.data as DocumentData).content;delete draft.pending;remoteRevision=undefined;persist();
      message(draft.dirty?`Saved revision ${result.revision}; newer edits remain unsaved`:`Saved revision ${result.revision}`);
    }catch(error) {
      if(disposed)return;
      if(error instanceof DocumentRequestError&&!error.unknownOutcome){delete draft.pending;if(error.code==='conflict')remoteRevision=error.revision;}
      persist();message(draft.pending?'Save outcome unknown. Your edits are retained; retry the exact save.':error instanceof DocumentRequestError&&error.code==='conflict'?'Save conflict. Your draft is retained. Reload or explicitly keep it on the current revision.':error instanceof Error?error.message:'Save failed');
    }finally{busy=false;controls();}
  }
  async function revalidate() {
    if(disposed||busy||!token())return;
    try {await documentRequest(token,{action:'resolve',document_id:id,pane_id:options.paneId},controller.signal);if(disposed)return;valid=true;editor?.setReadOnly(false);controls();if(!editor)void load();}
    catch {if(disposed)return;valid=false;editor?.setReadOnly(true);message('Document binding unavailable. Draft retained; reconnect or restore the exact pane.');}
  }
  const timer=setInterval(()=>{void revalidate();},2000);
  const connected=()=>{void revalidate();};host.addEventListener('orbit-host-connected',connected);window.addEventListener('orbit-host-connected',connected);
  // Editor keystrokes belong to the native editor, not shell navigation.
  shell.addEventListener('keydown',event=>event.stopPropagation());
  controls();void load();
  return {dispose(){disposed=true;persist();unregisterClose();controller.abort();clearInterval(timer);host.removeEventListener('orbit-host-connected',connected);window.removeEventListener('orbit-host-connected',connected);editor?.dispose();shell.remove();}};
}
