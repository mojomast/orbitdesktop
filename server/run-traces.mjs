import {validateRunTraceRequest,TRACE_LIMITS} from '../contracts/run-trace-v1.mjs';
import {serviceError as wbError} from './service-error.mjs';
import {createRunTracesStore} from './run-traces-store.mjs';
import {observeAgentEvent,projectTraceSpan,opaque} from './run-trace-project.mjs';
export {createRunTraceTee} from './run-trace-tee.mjs';

export function createRunTraces({root,workspaceRead,now=Date.now}){
  let store=null,closed=false,errors=0;const listeners=new Set();
  const open=()=>{if(closed)throw wbError('unavailable');return store??=createRunTracesStore({root,now});};
  const scoped=id=>{try{const record=workspaceRead(id);if(!record)throw Error();return record;}catch{throw wbError('permission_denied');}};
  function observe(evt){try{if(closed)return;
    if(evt?.event?.event==='trace.gap'&&[evt.workspace_id,evt.profile_id,evt.session_id,evt.run_id].every(opaque)){scoped(evt.workspace_id);open().markGap({...evt,method:'normal'});errors++;return;}
    const projected=evt?.record?projectTraceSpan(evt.kind,evt.record,{phase:evt.phase,now}):observeAgentEvent(evt);if(!projected)return;scoped(projected.scope.workspace_id);const span=open().append(projected);if(span)for(const listener of listeners){try{listener(span);}catch{}}}catch{errors++;}}
  return {observe,observer:observe,observeAgentRunEvent:observe,projectionErrors:()=>errors,subscribe(listener){listeners.add(listener);return ()=>listeners.delete(listener);},
    dispatch(body){if(!validateRunTraceRequest(body))throw wbError('invalid_request');scoped(body.workspace_id);
      if(body.action==='capability'){try{open();return {available:true,version:1,otlp:'manual-json',normal_source:'trusted-agent-hook',sdk:{api:'1.9.1',sdk_trace_base:'2.11.0'},limits:TRACE_LIMITS};}catch{return {available:false,reason:'store_unavailable'};}}
      const db=open();
      if(body.action==='list')return db.list(body);
      if(body.action==='page')return db.page(body);
      if(body.action==='detail')return db.detail(body);
      if(body.action==='export')return db.exportJson(body);
      if(body.action==='remove')return db.remove(body);
      if(body.action==='retention')return db.retention(body);
      throw wbError('invalid_request');
    },sdkExports:()=>store?.sdkExports()??0,close(){closed=true;listeners.clear();store?.close();}};
}
