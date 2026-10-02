import {validateDocumentData} from '../contracts/documents-v1.mjs';
import type {DocumentData} from './document-store-client';

export const MAX_CREATION_BYTES=4*1024*1024;
export const MAX_PENDING_CREATIONS=8;
const PREFIX='orbit.document-create.v1:';
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export interface DocumentCreation {
  version:1;
  workspaceId:string;
  paneId:string;
  data:DocumentData;
  request:{action:'create';workspace_id:string;document_id:string;op_id:string;kind:DocumentData['kind'];title:string;intent:string};
}
const fields=(value:unknown,keys:string[])=>!!value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).length===keys.length&&Object.keys(value).every(k=>keys.includes(k));
function validate(value:unknown):asserts value is DocumentCreation {
  if(!fields(value,['version','workspaceId','paneId','data','request']))throw Error('Invalid pending document creation.');
  const e=value as DocumentCreation,r=e.request;
  if(e.version!==1||!UUID.test(e.workspaceId)||!UUID.test(e.paneId)||!fields(r,['action','workspace_id','document_id','op_id','kind','title','intent'])||r.action!=='create'||r.workspace_id!==e.workspaceId||!UUID.test(r.document_id)||!UUID.test(r.op_id)||r.kind!==e.data?.kind||typeof r.title!=='string'||!r.title.trim()||r.title.length>160||/[\u0000-\u001f\u007f]/.test(r.title)||typeof r.intent!=='string'||!r.intent||r.intent.length>200)throw Error('Invalid pending document creation.');
  validateDocumentData(e.data);
}
export function creationKey(workspace:string,opId:string){return `${PREFIX}${workspace}:${opId}`;}
function encode(entry:DocumentCreation){validate(entry);const text=JSON.stringify(entry);if(new TextEncoder().encode(text).length>MAX_CREATION_BYTES)throw Error('Pending document creation exceeds the 4 MiB journal limit.');return text;}
export function readDocumentCreation(key:string):DocumentCreation|undefined {
  try{const text=sessionStorage.getItem(key);if(!text||text.length>MAX_CREATION_BYTES||new TextEncoder().encode(text).length>MAX_CREATION_BYTES)return;const entry=JSON.parse(text);validate(entry);if(key!==creationKey(entry.workspaceId,entry.request.op_id))return;return entry;}catch{return;}
}
export function listDocumentCreations(workspace:string){
  const entries:DocumentCreation[]=[];
  try{for(let i=0;i<sessionStorage.length;i++){const key=sessionStorage.key(i);if(!key?.startsWith(`${PREFIX}${workspace}:`))continue;const entry=readDocumentCreation(key);if(entry)entries.push(entry);}}catch{}
  return entries;
}
/** Durable same-tab journal first; no in-memory-only fallback may authorize POST. */
export function retainDocumentCreation(entry:DocumentCreation){
  const text=encode(entry),key=creationKey(entry.workspaceId,entry.request.op_id);
  const old=sessionStorage.getItem(key);
  if(old!==null){if(old!==text)throw Error('Pending creation identity already has a different payload.');return;}
  let count=0;for(let i=0;i<sessionStorage.length;i++)if(sessionStorage.key(i)?.startsWith(`${PREFIX}${entry.workspaceId}:`))count++;
  if(count>=MAX_PENDING_CREATIONS)throw Error('Resolve a pending document creation in Document library first (limit 8 per workspace).');
  sessionStorage.setItem(key,text);
  if(sessionStorage.getItem(key)!==text)throw Error('Document creation recovery storage could not be verified. Nothing was dispatched.');
}
/** Compare-before-clear: a stale callback cannot clear a different operation. */
export function finishDocumentCreation(entry:DocumentCreation){
  const key=creationKey(entry.workspaceId,entry.request.op_id),text=encode(entry);
  if(sessionStorage.getItem(key)!==text)throw Error('Pending creation changed during recovery. The retained draft is available in the library.');
  sessionStorage.removeItem(key);
}
