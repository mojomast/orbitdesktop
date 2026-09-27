import type { LiveConnection, LiveItem, LiveReference } from './agent-live-types';

export type WorkbenchLivePage = {
  version: 1; events: LiveItem[]; after_sequence: number; reset_required: boolean;
  has_more: boolean; project_generation: number;
  projection_incomplete?: boolean;
  snapshot?: Record<string, unknown>;
  lane?: { agent_busy: boolean; job_busy: boolean; unknown: boolean };
};
type Options = {
  workspaceId: string; projectId: string; attemptId?: string;
  getToken: () => string;
  onPage: (page: WorkbenchLivePage) => void;
  onConnection: (state: LiveConnection, message: string) => void;
  onReset?: () => void;
  onLane?: (lane: NonNullable<WorkbenchLivePage['lane']>) => void;
  onSnapshot?: (snapshot: Record<string, unknown>) => void;
};

/** A reconnect is always an owner-authenticated read, never an execution retry. */
export function watchWorkbenchLive(options: Options) {
  let disposed=false, fenced=false, cursor=0, failures=0;
  let controller:AbortController|undefined, timer:ReturnType<typeof setTimeout>|undefined;
  const scope={workspace_id:options.workspaceId,project_id:options.projectId,...(options.attemptId?{attempt_id:options.attemptId}:{})};
  const MAX_BUFFER=262144;
  function acceptPage(value:unknown) {
    const page=value as WorkbenchLivePage;
    if(!page||page.version!==1||!Array.isArray(page.events)||page.events.length>200||!Number.isSafeInteger(page.after_sequence)||page.after_sequence<0||!Number.isSafeInteger(page.project_generation))throw Error('Invalid private activity page');
    if(page.reset_required){options.onReset?.();cursor=0;options.onConnection('connected','Live history was truncated; restoring retained events and current durable state.');}
    if(page.after_sequence<cursor)throw Error('Activity cursor moved backwards');
    const rows=page.events.filter(item=>item?.version===1&&typeof item.id==='string'&&item.id.length<=160&&Number.isSafeInteger(item.sequence)&&item.sequence!>cursor&&item.sequence!<=page.after_sequence);
    if(rows.length!==page.events.length)throw Error('Invalid private activity sequence');
    cursor=page.after_sequence;options.onPage({...page,events:rows});
    if(page.projection_incomplete)options.onConnection('unavailable','Some activity observations could not be retained. Inspect authoritative task records; execution will not be replayed.');
    if(page.lane)options.onLane?.(page.lane);
  }
  async function request(action:'page'|'detail'|'tail',fields:Record<string,unknown>={},signal?:AbortSignal) {
    if(disposed||fenced)throw Error('Activity scope is closed');
    const token=options.getToken();if(!token)throw Error('Unlock the local host to inspect private activity');
    const response=await fetch('/api/workbench/live',{method:'POST',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},body:JSON.stringify({...scope,action,...fields}),cache:'no-store',signal});
    if(action==='page'&&(response.status===403||response.status===410)){fenced=true;controller?.abort();options.onConnection('closed','Project authority changed. Refresh the selected scope before acting.');}
    if(!response.body)throw Error('Private activity response unavailable');
    const reader=response.body.getReader(),decoder=new TextDecoder();let text='',bytes=0;
    try{while(true){const part=await reader.read();if(part.done)break;bytes+=part.value.byteLength;if(bytes>MAX_BUFFER)throw Error('Private activity response exceeds its bound');text+=decoder.decode(part.value,{stream:true});}text+=decoder.decode();}
    finally{await reader.cancel().catch(()=>{});reader.releaseLock();}
    if(disposed||fenced||options.getToken()!==token)throw Error('Activity scope changed');
    const value=JSON.parse(text);if(!response.ok||value.ok===false)throw Error(value.code??'Private activity unavailable');
    return value;
  }
  function schedule() {
    if(disposed||fenced)return;
    timer=setTimeout(()=>void connect(),Math.min(15000,500*2**Math.min(failures,5)));
  }
  async function connect() {
    if(disposed||fenced)return;
    controller=new AbortController();const own=controller,token=options.getToken();
    if(!token){options.onConnection('unavailable','Unlock the local host to inspect private activity');failures++;schedule();return;}
    options.onConnection('connecting',cursor?'Reconnecting from the last observed activity cursor…':'Connecting to private Workbench activity…');
    try{
      const response=await fetch('/api/workbench/live',{method:'POST',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json',Accept:'text/event-stream'},body:JSON.stringify({...scope,action:'stream',after_sequence:cursor,limit:200}),cache:'no-store',signal:own.signal});
      if(response.status===403||response.status===410){fenced=true;options.onConnection('closed','Project authority changed. No execution will be replayed.');return;}
      if(!response.ok||!response.body||!response.headers.get('content-type')?.includes('text/event-stream'))throw Error('Private activity stream unavailable');
      const reader=response.body.getReader(),decoder=new TextDecoder();let buffer='';
      options.onConnection('connected','Private durable activity connected');failures=0;
      while(!disposed&&!fenced){
        const chunk=await reader.read();if(chunk.done)break;
        if(options.getToken()!==token){own.abort();throw Error('Owner session changed');}
        buffer+=decoder.decode(chunk.value,{stream:true}).replace(/\r\n/g,'\n');
        if(buffer.length>MAX_BUFFER)throw Error('Private activity stream exceeded its buffer bound');
        let end:number;
        while((end=buffer.indexOf('\n\n'))>=0){
          const block=buffer.slice(0,end);buffer=buffer.slice(end+2);
          let type='message';const data:string[]=[];
          for(const line of block.split('\n')){if(line.startsWith('event:'))type=line.slice(6).trim();else if(line.startsWith('data:'))data.push(line.slice(5).trimStart());}
          if(!data.length)continue;
          const value=JSON.parse(data.join('\n'));
          if(type==='page')acceptPage(value);
          else if(type==='heartbeat'){
            if(value.lane)options.onLane?.(value.lane);
            if(value.snapshot&&typeof value.snapshot==='object'&&!Array.isArray(value.snapshot))options.onSnapshot?.(value.snapshot);
            if(value.projection_incomplete)options.onConnection('unavailable','Some activity observations could not be retained. Inspect authoritative task records; execution will not be replayed.');
          }
          else if(type==='fenced'){fenced=true;options.onConnection('closed','Authority revoked or changed. Execution will not be replayed automatically.');own.abort();return;}
        }
      }
      if(!disposed&&!fenced)throw Error('Activity stream disconnected');
    }catch(error){
      own.abort();
      if(disposed||fenced)return;
      failures++;options.onConnection('disconnected',`${error instanceof Error?error.message:'Activity disconnected'}. Reconnecting read-only; the worker lifecycle is independent.`);
      // A focused durable event page is the fallback, never a whole-project poll.
      if(options.getToken()===token){controller=new AbortController();try{acceptPage(await request('page',{after_sequence:cursor,limit:200},controller.signal));}catch{/* Keep the disconnect visible and back off. */}}
    }finally{if(!disposed&&!fenced)schedule();}
  }
  void connect();
  return {
    detail:(reference:LiveReference,signal?:AbortSignal)=>request('detail',{reference},signal),
    tail:(jobId:string,signal?:AbortSignal)=>request('tail',{job_id:jobId},signal),
    getCursor:()=>cursor,
    dispose(){disposed=true;controller?.abort();if(timer!==undefined)clearTimeout(timer);},
  };
}
