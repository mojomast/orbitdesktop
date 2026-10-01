import {workspaceId,ensureWorkspaceSynced} from './workspace-sync';
import {documentRequest,DocumentRequestError,downloadDocument,type DocumentRead,type DocumentData,type MountedDocumentEditor} from './document-store-client';
import {validateDocumentData} from '../contracts/documents-v1.mjs';
import './document-host.css';
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export const DOCUMENT_URL_PREFIX='orbit://document/';
export function documentId(url:string):string|null {const id=url.startsWith(DOCUMENT_URL_PREFIX)?url.slice(DOCUMENT_URL_PREFIX.length):'';return UUID.test(id)?id:null;}
export function documentUrl(id:string):string {if(!UUID.test(id))throw Error('Invalid document ID');return DOCUMENT_URL_PREFIX+id;}
type Draft={version:1;data:DocumentData;revision:number;dirty:boolean;pending?:Record<string,unknown>};
const drafts=new Map<string,Draft>();
export function mountDocumentHost(host:HTMLElement,id:string,token:()=>string,options:{paneId:string}):{dispose():void} {
  if(!UUID.test(id)||!UUID.test(options.paneId))throw Error('Invalid document binding');
  const key=`orbit.document-draft.v1:${workspaceId}:${options.paneId}:${id}`;
  const controller=new AbortController();let disposed=false,editor:MountedDocumentEditor|undefined,draft:Draft|undefined,busy=false,valid=false,title='Document',remoteRevision:number|undefined;
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
  const rebase=button('Keep draft on current revision',()=>{if(draft&&remoteRevision!==undefined&&!draft.pending){draft.revision=remoteRevision;remoteRevision=undefined;persist();message('Draft retained. Save document explicitly to replace the current saved revision.');}});
  const json=button('Export JSON',()=>{if(!draft)return;try{validateDocumentData(draft.data);downloadDocument(draft.data.content,`${title.replace(/[^a-z0-9_-]/gi,'_')}.${draft.data.kind==='scene'?'excalidraw':'json'}`);}catch(error){message(error instanceof Error?error.message:'Document export refused');}});
  const markdown=button('Export Markdown',()=>{if(editor?.exportMarkdown)downloadDocument(editor.exportMarkdown(),`${title.replace(/[^a-z0-9_-]/gi,'_')}.md`,'text/markdown');});
  shell.append(bar,status,area);host.replaceChildren(shell);
  function message(text:string) {if(!disposed){status.textContent=text;controls();}}
  function controls() {save.disabled=busy||!valid||!draft?.dirty||!!draft?.pending;retry.hidden=!draft?.pending;retry.disabled=busy||!valid;reload.disabled=busy||!!draft?.pending;rebase.hidden=remoteRevision===undefined||!!draft?.pending;json.disabled=!draft;markdown.hidden=!editor?.exportMarkdown;}
  function persist() {
    if(!draft)return;drafts.set(key,draft);
    try {if(draft.dirty||draft.pending)sessionStorage.setItem(key,JSON.stringify(draft));else sessionStorage.removeItem(key);}catch {message('Draft is retained in memory; browser recovery storage is unavailable. Export before reloading.');}
  }
  function changed(content:string) {
    if(!draft||disposed)return;
    draft.data={...draft.data,content};draft.dirty=true;persist();message(`Unsaved edits · base revision ${draft.revision}`);
  }
  function recovered():Draft|undefined {
    let d=drafts.get(key);
    try {if(!d){const text=sessionStorage.getItem(key);if(text&&text.length<1500000)d=JSON.parse(text);}
      if(d){validateDocumentData(d.data);if(d.version!==1||!Number.isSafeInteger(d.revision)||d.revision<1||typeof d.dirty!=='boolean')return;
        if(d.pending&&(d.pending.action!=='save'||d.pending.document_id!==id||d.pending.pane_id!==options.paneId||typeof d.pending.op_id!=='string'||!UUID.test(d.pending.op_id)||!Number.isSafeInteger(d.pending.expected_revision)))return;
        if(d.pending)validateDocumentData(d.pending.data);return d;}
    }catch{}return;
  }
  async function load(discard=false) {
    if(busy||disposed)return;busy=true;message('Loading private document…');
    try {
      await ensureWorkspaceSynced();if(disposed)return;
      const result=await documentRequest<DocumentRead>(token,{action:'read',document_id:id,pane_id:options.paneId},controller.signal);
      if(disposed)return;validateDocumentData(result.data);valid=true;title=result.document.title;heading.textContent=title;
      const cache=discard?undefined:recovered();
      draft=cache??{version:1,data:result.data,revision:result.revision,dirty:false};
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
      draft.revision=result.revision;draft.dirty=draft.data.content!==(request.data as DocumentData).content;delete draft.pending;remoteRevision=undefined;persist();
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
  return {dispose(){disposed=true;persist();controller.abort();clearInterval(timer);host.removeEventListener('orbit-host-connected',connected);window.removeEventListener('orbit-host-connected',connected);editor?.dispose();shell.remove();}};
}
