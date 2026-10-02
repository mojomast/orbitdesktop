import {validateDocumentData} from '../contracts/documents-v1.mjs';
import type {DocumentData} from './document-store-client';
import {workspaceId} from './workspace-sync';

export async function documentDigest(content:string){const bytes=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(content));return [...new Uint8Array(bytes)].map(b=>b.toString(16).padStart(2,'0')).join('');}
export function textDocument(text:string):DocumentData {
  const data:DocumentData={kind:'richtext',format:'lexical',content:JSON.stringify({root:{type:'root',version:1,format:'',indent:0,direction:null,children:text.split(/\r?\n/).map(line=>({type:'paragraph',version:1,format:'',indent:0,direction:null,children:line?[{type:'text',version:1,text:line,format:0,style:'',mode:'normal',detail:0}]:[]}))}})};
  validateDocumentData(data);return data;
}
/** Finite owner-import adapter; never treats prose as executable markup. */
export async function importDocument(text:string,format:'text'|'markdown'|'lexical'|'excalidraw'):Promise<DocumentData>{
  if(new TextEncoder().encode(text).length>524288)throw Error('Import exceeds the document limit.');
  if(format==='text')return textDocument(text);
  if(format==='markdown')return (await import('./richdoc-editor')).markdownDocument(text);
  const data:DocumentData={kind:format==='lexical'?'richtext':'scene',format,content:text};validateDocumentData(data);return data;
}
/** Explicit result envelope. Callers must supply the complete authenticated reply. */
export function extractDocumentResult(text:string):{title:string;data:DocumentData}|null {
  if(text.length>750000)return null;
  try{const match=/^\s*```orbit-document\s*\n([\s\S]*?)\n```\s*$/.exec(text);const value=JSON.parse(match?match[1]:text);if(Object.keys(value).length!==1||!value.document)return null;const d=value.document;if(Object.keys(d).some(k=>!['title','kind','format','content'].includes(k))||typeof d.title!=='string'||!d.title.trim()||d.title.length>160)return null;const data={kind:d.kind,format:d.format,content:d.content};validateDocumentData(data);return {title:d.title,data};}catch{return null;}
}
export type DocumentResultOutcome={status:'created-draft'|'cancelled'|'rejected';documentId?:string;paneId?:string;reason?:string};
const deliveries=new Set<string>();
/** Bounded independent parent deliveries; acknowledgement is creation+draft retention,
 * not proof of editor display or a saved body. No global replaceable pending slot. */
export async function requestDocumentFromResult(text:string,isCurrent:()=>boolean=()=>true):Promise<DocumentResultOutcome>{
  const current=()=>{try{return isCurrent();}catch{return false;}};
  if(!current())return {status:'rejected',reason:'Document result source changed. Reopen the result.'};
  const result=extractDocumentResult(text);if(!result)return {status:'rejected',reason:'Unsupported complete document envelope'};
  if(deliveries.size>=8)return {status:'rejected',reason:'Finish an open document review first'};
  const deliveryId=crypto.randomUUID();deliveries.add(deliveryId);
  try{return await new Promise<DocumentResultOutcome>(resolve=>{const event=new CustomEvent('orbit-review-document-result',{cancelable:true,detail:{...result,workspaceId,deliveryId,isCurrent:current,respond:resolve}});window.dispatchEvent(event);if(!event.defaultPrevented)resolve({status:'rejected',reason:'Document shell unavailable'});});}finally{deliveries.delete(deliveryId);}
}

export function reviewDocumentSnapshot(title:string,before:string,after:string,apply:()=>Promise<void>):Promise<boolean>{
  return new Promise(resolve=>{const dialog=document.createElement('dialog');dialog.className='document-review';dialog.setAttribute('aria-label',title);const heading=document.createElement('h2');heading.textContent=title;
    const grid=document.createElement('div');grid.className='document-review-grid';for(const [label,text] of [['Current snapshot',before],['Proposed snapshot',after]]){const section=document.createElement('section'),h=document.createElement('h3'),pre=document.createElement('pre');h.textContent=label;pre.textContent=text;section.append(h,pre);grid.append(section);}
    const status=document.createElement('p');status.setAttribute('role','status');const cancel=document.createElement('button');cancel.textContent='Cancel';cancel.onclick=()=>dialog.close();const accept=document.createElement('button');accept.textContent='Apply reviewed draft';let applied=false,busy=false;accept.onclick=async()=>{busy=true;accept.disabled=cancel.disabled=true;try{await apply();applied=true;dialog.close();}catch(error){status.textContent=error instanceof Error?error.message:'Review failed';}finally{busy=false;accept.disabled=cancel.disabled=false;}};dialog.addEventListener('cancel',e=>{if(busy)e.preventDefault();});dialog.addEventListener('close',()=>{dialog.remove();resolve(applied);},{once:true});dialog.append(heading,grid,status,cancel,accept);document.body.append(dialog);dialog.showModal();});
}
export function documentPreview(data:DocumentData){return JSON.stringify(JSON.parse(data.content),null,2);}
