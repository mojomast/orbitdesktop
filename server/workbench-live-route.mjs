import {allowedRequest,tokenMatches} from './security.mjs';
import {validateWorkbenchLive,LIVE_LIMITS} from '../contracts/workbench-live-v1.mjs';

// Owner-only private live surface for the Workbench observability projection.
// Read-only: it never dispatches work, never claims execution and never replays
// a task. `stream` is an SSE-formatted fetch stream (the client supplies the
// owner bearer explicitly); `page`/`detail`/`tail` are bounded JSON.
const MAX_BODY=8192;
const HEARTBEAT_MS=15000;
const pageFrame=page=>`event: page\ndata: ${JSON.stringify(page)}\n\n`;
const heartbeatFrame=data=>`event: heartbeat\ndata: ${JSON.stringify(data)}\n\n`;
const FENCED_FRAME='event: fenced\ndata: {}\n\n';

export function createWorkbenchLiveHandler({token,port,devOrigins,live,reply,heartbeatMs=HEARTBEAT_MS}={}){
  if(!live||typeof live.page!=='function'||typeof live.subscribe!=='function'||typeof live.dispatch!=='function')throw Error('createWorkbenchLiveHandler requires createWorkbenchLive');
  const deny=(res,status,code)=>reply(res,status,{ok:false,code,error:code});
  const streams=new Set();
  const handler=async function handle(req,res){
    res.setHeader('Cache-Control','no-store');
    if(req.method!=='POST')return deny(res,405,'invalid_request');
    const auth=req.headers.authorization??'';
    if(!allowedRequest(req,port,devOrigins)||!auth.startsWith('Bearer ')||!tokenMatches(auth.slice(7),token))return deny(res,403,'permission_denied');
    let body;
    try{
      const chunks=[];let bytes=0;
      for await(const chunk of req){bytes+=Buffer.byteLength(chunk);if(bytes>MAX_BODY)throw Error('limit');chunks.push(Buffer.from(chunk));}
      body=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(chunks)));
    }catch{return deny(res,400,'invalid_request');}
    if(!validateWorkbenchLive(body))return deny(res,400,'invalid_request');

    if(body.action==='stream')return stream(req,res,body);

    try{
      const result=body.action==='detail'?await live.detail(body):await live.dispatch(body);
      if(body.action==='page'&&live.projectionErrors?.()>0)result.projection_incomplete=true;
      const serialized=JSON.stringify(result??{});
      if(Buffer.byteLength(serialized)>LIVE_LIMITS.bufferBytes)return deny(res,413,'limit_exceeded');
      return reply(res,200,{...JSON.parse(serialized),ok:true});
    }catch(error){
      const statuses={invalid_request:400,permission_denied:403,revoked:410,expired:410,stale_resource:409,conflict:409,unsupported:422,unavailable:404,limit_exceeded:413,busy:429};
      const code=Object.hasOwn(statuses,error?.code)?error.code:'unavailable';
      return deny(res,statuses[code],code);
    }

    async function stream(req,res,body){
      // Keep one replay frame below the wire buffer even at maximum item size.
      body={...body,limit:Math.min(body.limit??LIVE_LIMITS.page,32)};
      let page;
      try{page=live.page(body);}
      catch(error){
        const statuses={invalid_request:400,permission_denied:403,revoked:410,expired:410,unavailable:404};
        const code=Object.hasOwn(statuses,error?.code)?error.code:'unavailable';
        return deny(res,statuses[code],code);
      }
      res.writeHead(200,{
        'Content-Type':'text/event-stream; charset=utf-8',
        'Cache-Control':'no-store',
        'Connection':'keep-alive',
        'X-Accel-Buffering':'no',
        'X-Content-Type-Options':'nosniff',
      });
      let closed=false,unsubscribe=null,timer=null,writing=false,dirty=true,heartbeat=false;
      const generation=page.project_generation;
      let cursor=page.after_sequence;
      const scopeAttempt=typeof body.attempt_id==='string'&&body.attempt_id?body.attempt_id:null;
      const cleanup=()=>{
        if(closed)return;closed=true;
        streams.delete(res);
        if(timer)clearInterval(timer);timer=null;
        try{unsubscribe?.();}catch{}
        unsubscribe=null;
      };
      res.on('close',cleanup);
      res.on('error',cleanup);
      streams.add(res);
      const write=async text=>{
        if(closed)return false;
        if(Buffer.byteLength(text)>LIVE_LIMITS.bufferBytes)throw Error('frame bound');
        if(res.write(text))return true;
        await new Promise(resolve=>{const done=()=>{res.removeListener('drain',done);res.removeListener('close',done);res.removeListener('error',done);resolve();};res.once('drain',done);res.once('close',done);res.once('error',done);});
        return !closed;
      };
      const fenceOk=()=>{try{return live.records.project(body.workspace_id,body.project_id).generation===generation;}catch{return false;}};
      const endFenced=async()=>{if(closed)return;await write(FENCED_FRAME);cleanup();try{res.end();}catch{}};
      // Notifications only mark the durable cursor dirty. They never accumulate
      // event payloads or start parallel writes for a slow browser.
      const pump=async()=>{
        if(writing||closed)return;writing=true;
        try{
          while(!closed&&(dirty||heartbeat)){
            if(!fenceOk()){await endFenced();return;}
            if(dirty){
              dirty=false;
              const next=page??live.page({...body,after_sequence:cursor});page=null;
              if(live.projectionErrors?.()>0)next.projection_incomplete=true;
              if(next.project_generation!==generation){await endFenced();return;}
              if(!await write(pageFrame(next)))return;
              cursor=next.after_sequence;
              if(next.has_more)dirty=true;
            }else{
              heartbeat=false;
              if(!await write(heartbeatFrame({version:1,lane:live.lane(),project_generation:generation,after_sequence:cursor,snapshot:live.snapshot(body),projection_incomplete:live.projectionErrors?.()>0})))return;
            }
          }
        }catch{cleanup();try{res.end();}catch{}}
        finally{writing=false;}
      };
      try{
        // Subscribe before the first asynchronous write: committed notifications
        // during backpressure must trigger another durable page read.
        unsubscribe=live.subscribe(notification=>{
          if(closed)return;
          if(notification.workspace_id!==body.workspace_id||notification.project_id!==body.project_id)return;
          // An un-attributed candidate mutation still invalidates a selected
          // resource view. Wake a scoped page/snapshot read without relabelling
          // the mutation as this attempt's action or forwarding foreign events.
          if(scopeAttempt&&notification.attempt_id!==scopeAttempt&&notification.event?.kind!=='candidate')return;
          if(notification.sequence<=cursor)return;
          dirty=true;void pump();
        });
        timer=setInterval(()=>{
          if(closed)return;
          heartbeat=true;void pump();
        },heartbeatMs);
        timer.unref?.();
        void pump();
      }catch{cleanup();try{res.end();}catch{}}
    }
  };
  handler.close=()=>{for(const res of streams){try{res.end();res.destroy();}catch{}}streams.clear();};
  return handler;
}
