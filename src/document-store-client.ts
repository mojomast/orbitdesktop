import {workspaceId} from './workspace-sync';
export interface DocumentData {kind:'richtext'|'scene';format:'lexical'|'excalidraw';content:string}
export interface DocumentMetadata {id:string;kind:DocumentData['kind'];format:DocumentData['format'];title:string;revision:number;updated_at:string}
export interface DocumentRead {document:DocumentMetadata;data:DocumentData;revision:number;data_schema_version:1}
export class DocumentRequestError extends Error {
  constructor(public code:string,public unknownOutcome=false,public revision?:number){super(code.replaceAll('_',' '));}
}
export async function documentRequest<T>(token:()=>string,body:Record<string,unknown>,signal:AbortSignal):Promise<T> {
  if(!token())throw new DocumentRequestError('Connect host to access private documents');
  const mutation=['save','create','rename'].includes(String(body.action));
  let response:Response;
  try {response=await fetch('/api/documents',{method:'POST',headers:{'Content-Type':'application/json',Authorization:`Bearer ${token()}`},body:JSON.stringify({...body,workspace_id:workspaceId}),signal});}
  catch {throw new DocumentRequestError(signal.aborted?'request_disposed':'request_failed',mutation);}
  let result:any;try{result=await response.json();}catch{throw new DocumentRequestError('invalid_response',mutation);}
  if(!response.ok || result.ok===false)throw new DocumentRequestError(typeof result.code==='string'?result.code:'request_failed',mutation&&response.status>=500,Number.isSafeInteger(result.revision)?result.revision:undefined);
  return result as T;
}
export function downloadDocument(content:string,name:string,type='application/json') {
  const url=URL.createObjectURL(new Blob([content],{type})),a=document.createElement('a');
  a.href=url;a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
}
export interface MountedDocumentEditor {getContent():string;setContent(content:string):void;applySnapshot(content:string):void;selectedContent():string;setReadOnly(readonly:boolean):void;exportMarkdown?():string;dispose():void}
