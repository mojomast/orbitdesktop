import {ensureWorkspaceSynced} from './workspace-sync';
import {documentRequest,DocumentRequestError,type DocumentMetadata} from './document-store-client';
import './document-host.css';
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
  section.append(heading,summary,title,kind,create,retry,refresh,status,list);host.replaceChildren(section);
  function open(id:string,name:string){window.dispatchEvent(new CustomEvent('orbit-open-document',{detail:{id,name}}));}
  async function load(){if(disposed||busy)return;busy=true;create.disabled=true;try{await ensureWorkspaceSynced();if(disposed)return;const result=await documentRequest<{documents:DocumentMetadata[]}>(token,{action:'list'},controller.signal);if(disposed)return;list.replaceChildren();for(const d of result.documents){const b=document.createElement('button');b.textContent=`${d.title} · ${d.kind==='scene'?'Canvas':'Rich document'} · revision ${d.revision}`;b.addEventListener('click',()=>open(d.id,d.title));list.append(b);}status.textContent=result.documents.length?'Choose a document to open.':'No documents yet.';}catch(error){if(!disposed)status.textContent=error instanceof Error?error.message:'Documents unavailable';}finally{busy=false;create.disabled=!!pending;}}
  async function commit(exact=false){if(disposed||busy)return;const body=exact?pending:{action:'create',document_id:crypto.randomUUID(),kind:kind.value,title:title.value.trim()||(kind.value==='scene'?'Untitled canvas':'Untitled document'),op_id:crypto.randomUUID(),intent:'Create private document'};if(!body)return;pending=body;busy=true;create.disabled=true;try{await ensureWorkspaceSynced();if(disposed)return;await documentRequest(token,body,controller.signal);if(disposed)return;pending=undefined;retry.hidden=true;open(String(body.document_id),String(body.title));}catch(error){if(disposed)return;if(error instanceof DocumentRequestError&&!error.unknownOutcome)pending=undefined;retry.hidden=!pending;status.textContent=pending?'Creation outcome unknown. Retry exact creation.':error instanceof Error?error.message:'Creation failed';}finally{busy=false;create.disabled=!!pending;if(!pending&&!disposed)void load();}}
  create.addEventListener('click',()=>{void commit();});retry.addEventListener('click',()=>{void commit(true);});refresh.addEventListener('click',()=>{void load();});
  const connected=()=>{void load();};window.addEventListener('orbit-host-connected',connected);void load();
  return {dispose(){disposed=true;controller.abort();window.removeEventListener('orbit-host-connected',connected);section.remove();}};
}
