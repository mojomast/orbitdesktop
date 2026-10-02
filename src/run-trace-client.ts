import {workspaceId,ensureWorkspaceSynced} from './workspace-sync';
export type TraceSpan={version:1;trace_id:string;span_id:string;parent_span_id:string|null;name:string;start_unix_ms:number;end_unix_ms:number|null;status:'unset'|'ok'|'error';duration_origin:'observed'|'instant'|'local_observation';category:string;authority:string;sequence:number;attributes:{key:string;value:string|number}[];references:{kind:string;id:string}[]};
export type RunTrace={trace_id:string;method:'normal'|'workbench';run_id:string;profile_id?:string;session_id?:string;status:string;partial:boolean;updated_at:number};
export function createRunTraceClient(getToken:()=>string){
  const controller=new AbortController();
  return {async request<T>(action:string,fields:Record<string,unknown>={}):Promise<T>{
    if(!getToken())throw Error('Connect host to view local run traces.');
    await ensureWorkspaceSynced();
    const response=await fetch('/api/run-traces',{method:'POST',headers:{'Content-Type':'application/json',Authorization:`Bearer ${getToken()}`},body:JSON.stringify({action,workspace_id:workspaceId,...fields}),signal:controller.signal});
    const data=await response.json();if(!response.ok||data.ok===false)throw Error(`Run traces: ${data.code||'unavailable'}`);return data as T;
  },dispose(){controller.abort();}};
}
