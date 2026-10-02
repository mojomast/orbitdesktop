import {validateDocumentData} from '../contracts/documents-v1.mjs';
import type {DocumentData} from './document-store-client';

export type DocumentDraft={version:1;data:DocumentData;revision:number;dirty:boolean;pending?:Record<string,unknown>};
const prefix='orbit.document-draft.v1:';
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const memory=new Map<string,DocumentDraft>();
export function draftKey(workspace:string,pane:string,document:string){return `${prefix}${workspace}:${pane}:${document}`;}
export function retainDocumentDraft(key:string,draft:DocumentDraft):boolean {
  if(draft.dirty||draft.pending)memory.set(key,structuredClone(draft));else memory.delete(key);
  try{if(draft.dirty||draft.pending)sessionStorage.setItem(key,JSON.stringify(draft));else sessionStorage.removeItem(key);return true;}catch{return false;}
}
export function readDocumentDraft(key:string):DocumentDraft|undefined {
  try{
    const [workspace,pane,id]=key.slice(prefix.length).split(':');
    if(!key.startsWith(prefix)||![workspace,pane,id].every(v=>uuid.test(v)))return;
    const text=memory.has(key)?JSON.stringify(memory.get(key)):sessionStorage.getItem(key);
    if(!text||text.length>1500000)return;
    const d=JSON.parse(text) as DocumentDraft;validateDocumentData(d.data);
    if(d.version!==1||!Number.isSafeInteger(d.revision)||d.revision<1||typeof d.dirty!=='boolean')return;
    if(d.pending){const p=d.pending;if(p.action!=='save'||p.document_id!==id||p.pane_id!==pane||typeof p.op_id!=='string'||!uuid.test(p.op_id)||!Number.isSafeInteger(p.expected_revision))return;validateDocumentData(p.data);}
    return d;
  }catch{return;}
}
export function listDocumentDrafts(workspace:string){
  const keys=new Set(memory.keys());try{for(let i=0;i<sessionStorage.length;i++){const key=sessionStorage.key(i);if(key)keys.add(key);}}catch{}
  return [...keys].filter(key=>key.startsWith(`${prefix}${workspace}:`)).flatMap(key=>{const draft=readDocumentDraft(key);const [,paneId,documentId]=key.slice(prefix.length).split(':');return draft&&(draft.dirty||draft.pending)?[{key,paneId,documentId,draft}]:[];});
}

// Trusted shell hook. Remote layout replacement still preserves drafts on disposal.
const guards=new Map<string,()=>Promise<boolean>>();
export function registerDocumentClose(paneId:string,guard:()=>Promise<boolean>){guards.set(paneId,guard);return ()=>{if(guards.get(paneId)===guard)guards.delete(paneId);};}
export async function requestDocumentClose(paneIds:string[]){for(const id of paneIds){if(!await (guards.get(id)?.()??true))return false;}return true;}
