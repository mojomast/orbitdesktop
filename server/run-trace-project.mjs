import {createHash} from 'node:crypto';

export const opaque=value=>typeof value==='string'&&/^[A-Za-z0-9_.:-]{1,128}$/.test(value)?value:null;
const hash=(value,n)=>createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0,n);
export const traceId=scope=>hash(['orbit-run-trace-v1',scope.workspace_id,scope.method,scope.project_id??'',scope.profile_id??'',scope.session_id??'',scope.run_id??scope.attempt_id],32);
export const spanIdFor=(scope,kind,id)=>hash([traceId(scope),kind,id],16);
export const attemptSpanId=scope=>spanIdFor(scope,'run',scope.run_id??scope.attempt_id);
export function timestamp(value){
  if(typeof value==='number'&&Number.isFinite(value)&&value>=0)return value<1e12?value*1000:value;
  if(typeof value==='string'&&value.length<=40){const n=Date.parse(value);if(Number.isFinite(n)&&n>=0)return n;}
  return null;
}
export const terminal=status=>['completed','failed','cancelled','stopped','error','accepted','rejected','available','verified','passed','pass','fail','denied','finalized','checked'].includes(status);
export const errorStatus=status=>['failed','error','rejected','denied','fail'].includes(status)?'error':terminal(status)?'ok':'unset';
const states=new Set(['created','ready','approved','starting','running','started','pending','stop_requested','completed','failed','cancelled','stopped','error','accepted','rejected','available','unavailable','verified','passed','pass','fail','denied','unknown','outcome_unknown','dispatch_unknown','inconclusive','expired','revoked','candidate_ready','checked','preparing','dispatched','finalized','paused_budget','result_pending','acknowledged_unknown','fenced','finalization_pending','cancel_requested']);
export const safeStatus=value=>states.has(value)?value:'unknown';
const categories={attempts:'agent',toolcalls:'tools',jobs:'checks',grants:'agent',candidates:'files',evidence:'evidence',results:'agent',patches:'files',reviews:'evidence'};
const singular={attempts:'attempt',toolcalls:'toolcall',jobs:'job',grants:'grant',candidates:'candidate',evidence:'evidence',results:'result',patches:'patch',reviews:'review'};
export function projectTraceSpan(kind,record,{phase='update',now=Date.now}={}){
  if(!categories[kind]||!opaque(record?.workspace_id)||!opaque(record.project_id)||!opaque(record.id))return null;
  const attempt=kind==='attempts'?record.id:opaque(record.attempt_id);
  if(!attempt)return null;
  const scope={workspace_id:record.workspace_id,project_id:record.project_id,attempt_id:attempt,run_id:attempt,method:'workbench'};
  const status=safeStatus(record.status??record.availability??record.verdict??record.decision);
  // Record created/updated times are commit observations, not process execution times.
  const exactStart=typeof record.started_at==='number'?record.started_at:null;
  const exactEnd=typeof record.ended_at==='number'?record.ended_at:null;
  const start=exactStart??(Number.isFinite(record.created_at)?record.created_at:now());
  const isDuration=['attempts','toolcalls','jobs','grants'].includes(kind)&&!['created','approved','ready'].includes(status);
  const end=!isDuration?start:terminal(status)?exactEnd??(Number.isFinite(record.updated_at)?record.updated_at:start):null;
  const attributes=[{key:'source_status',value:status},{key:'phase',value:phase}];
  for(const key of ['exit_code','log_bytes','generation','total_bytes','bytes','calls_used','checks_used','repairs_used'])if(Number.isFinite(record[key]))attributes.push({key,value:record[key]});
  const action=opaque(record.action);if(action)attributes.push({key:'action',value:action});
  if(record.trace_relationship==='unique_candidate')attributes.push({key:'relationship',value:'unique_candidate'});
  const span={version:1,trace_id:traceId(scope),span_id:kind==='attempts'?attemptSpanId(scope):spanIdFor(scope,kind,record.id),parent_span_id:kind==='attempts'?null:attemptSpanId(scope),name:kind==='toolcalls'?`tool ${action??'call'}`.slice(0,120):singular[kind],kind:'internal',start_unix_ms:start,end_unix_ms:end===null?null:Math.max(start,end),status:errorStatus(status),duration_origin:!isDuration?'instant':exactStart!==null&&(end===null||exactEnd!==null)?'observed':'local_observation',authority:kind==='evidence'?'recorder':kind==='reviews'?'human':'observed',category:categories[kind],attributes,references:[{kind:singular[kind],id:record.id}],sequence:0};
  if(Number.isSafeInteger(record.revision))span.attributes.push({key:'record_revision',value:record.revision});
  return {scope,span,identity:`${kind}:${record.id}:${record.revision}`,revision:record.revision,hasStart:exactStart!==null};
}

export function observeAgentEvent({workspace_id,profile_id,session_id,run_id,event,at=Date.now()}){
  if(![workspace_id,profile_id,session_id,run_id].every(opaque)||!event||typeof event!=='object')return null;
  const name=event.event??event.type;
  if(!['run.started','run.completed','run.failed','run.cancelled','run.status','tool.started','tool.completed','tool.failed','tool.result','tool_start','tool_end'].includes(name))return null;
  const isTool=name.startsWith('tool');
  const call=opaque(event.tool_call_id??event.toolCallId??event.call_id??event.callId);
  const tool=opaque(event.tool??event.tool_name??event.name);
  if(isTool&&(!call||!tool))return null;
  const scope={workspace_id,profile_id,session_id,run_id,method:'normal'};
  const status=safeStatus(event.status??(name.includes('failed')||event.error===true?'failed':name.includes('completed')||name==='tool_end'||name==='tool.result'?'completed':name.includes('cancelled')?'cancelled':'running'));
  const explicit=timestamp(event.timestamp??event.at);
  const start=timestamp(event.started_at)??explicit??at;
  const ended=timestamp(event.ended_at);
  const span={version:1,trace_id:traceId(scope),span_id:isTool?spanIdFor(scope,'tool',call):attemptSpanId(scope),parent_span_id:isTool?attemptSpanId(scope):null,name:isTool?`tool ${tool}`.slice(0,120):'run',kind:'internal',start_unix_ms:start,end_unix_ms:terminal(status)?ended??explicit??at:null,status:errorStatus(status),duration_origin:explicit!==null||timestamp(event.started_at)!==null?'observed':'local_observation',authority:'observed',category:isTool?'tools':'agent',attributes:[{key:'source_status',value:status},{key:'event',value:name}],references:[{kind:isTool?'toolcall':'run',id:isTool?call:run_id}],sequence:0};
  return {scope,span,identity:hash([span.span_id,name,status,explicit,ended,timestamp(event.started_at)],64),terminalOnly:terminal(status)&&timestamp(event.started_at)===null,hasStart:timestamp(event.started_at)!==null||['run.started','tool.started','tool_start'].includes(name),at};
}
