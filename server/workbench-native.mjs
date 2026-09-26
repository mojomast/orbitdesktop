import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import {createHash,createHmac,randomBytes,randomUUID,timingSafeEqual} from 'node:crypto';
import {nativeSchema,nativeRequests,validateNative,validateNativeTool,HERMES_NATIVE_CONTRACT} from '../contracts/workbench-native-v1.mjs';
import {wbError} from './workbench-store.mjs';
export {nativeSchema,nativeRequests};
const digest=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const clone=value=>structuredClone(value);
const publicGrant=g=>({...g}); // Secrets exist only in the process-local channel map.
const closedAttempt=a=>['closed','stopped','cancelled','completed','revoked','failed','accepted','rejected'].includes(a.status);
const unknownDigest=g=>digest({id:g.id,run_id:g.run_id,status:g.status,authority_generation:g.authority_generation,candidate_id:g.candidate_id,project_generation:g.project_generation,calls_used:g.calls_used,checks_used:g.checks_used});
export const NATIVE_UNKNOWN_POLICY='This native runtime outcome is unknown. Confirm only after independently establishing that the old runtime is terminated. Acknowledgement records your risk decision and releases quarantine; it never replays a run or reverses effects.';

// The owner router authenticates dispatch. This private UDS authenticates tools
// independently. The injected Hermes adapter must implement readBinding,
// startNative and stopNative; it must share the lead's agent dispatch lease.
export function createWorkbenchNative({store,records,data,execution,hermes,now=Date.now}={}){
  if(!store||!records||!data||!execution)throw Error('Native Workbench dependencies required');
  const previews=new Map(),channels=new Map(),running=new Map(),quarantineFailures=new Set();let closed=false,server,socketDir,listenPromise;
  const get=(kind,s,id)=>data.get(kind,s.workspace_id,s.project_id,id);
  const update=(kind,s,id,patch)=>{const row=get(kind,s,id);return data.update(kind,s.workspace_id,s.project_id,id,row.revision,patch);};
  const requireScope=s=>{if(closed)throw wbError('unavailable');store.read(s.workspace_id);return records.project(s.workspace_id,s.project_id);};
  function quarantine(g){try{if(typeof hermes?.quarantineNative!=='function')throw wbError('unavailable');hermes.quarantineNative({grant_id:g.id});quarantineFailures.delete(g.id);}catch{quarantineFailures.add(g.id);}}
  function markUnknown(g){quarantine(g);return update('grants',g,g.id,{status:'dispatch_unknown',runtime_status:'unknown'});}
  function health(){const unknown=data.db.prepare("SELECT id FROM wb_grants WHERE json_extract(record_json,'$.status')='dispatch_unknown'").all();return {supported:typeof hermes?.startNative==='function',healthy:typeof hermes?.startNative==='function'&&unknown.length===0,cause:unknown.length?'native_dispatch_unknown':typeof hermes?.startNative==='function'?null:'native_runtime_unconfigured',unknown_runs:unknown.length,shared_quarantine:quarantineFailures.size===0,policy:NATIVE_UNKNOWN_POLICY};}
  async function binding(attempt,s){
    if(!attempt.recipient?.pane_id||typeof hermes?.readBinding!=='function')throw wbError('unavailable');
    const b=await hermes.readBinding({workspace_id:s.workspace_id,pane_id:attempt.recipient.pane_id});
    if(b?.trusted_host!==true||b.sandbox!==false||b.profile_id!==attempt.recipient.profile_id||b.session_id!==attempt.recipient.session_id||b.config_generation===undefined||b.binding_revision===undefined)throw wbError('stale_resource');
    const n=b.native_runtime;
    if(n?.kind!=='local-pinned'||n?.commit!==HERMES_NATIVE_CONTRACT.commit||typeof n.model!=='string'||n.model.length>200||n.destination!=='loopback configured model endpoint'||!/^[a-f0-9]{64}$/.test(n.configuration_hash??''))throw wbError('unavailable');
    return {pane_id:attempt.recipient.pane_id,profile_id:b.profile_id,session_id:b.session_id,config_generation:b.config_generation,binding_revision:b.binding_revision,native_runtime:{kind:n.kind,commit:n.commit,model:n.model,destination:n.destination,configuration_hash:n.configuration_hash}};
  }
  async function authorize(g,{active=false}={}){
    const current=get('grants',g,g.id),project=requireScope(g),a=get('attempts',g,g.attempt_id),c=get('candidates',g,g.candidate_id),t=get('tasks',g,a.task_id);
    if(!['approved','running'].includes(current.status)||(active&&current.status!=='running')||closedAttempt(a)||[a.project_generation,c.project_generation,t.project_generation].some(value=>value!==project.generation)||now()>=g.expires_at||project.generation!==g.project_generation||a.candidate_id!==g.candidate_id||c.task_id!==a.task_id||t.acceptance_digest!==g.acceptance_digest||t.check_definition_id!==g.definition_id||digest(await binding(a,g))!==digest(g.recipient)||current.authority_generation!==g.authority_generation)throw wbError('expired');
    for(const context of g.contexts){const row=get('contexts',g,context.id);if(row.purged_at||row.retention_until<=now()||!row.snapshot||row.snapshot.hash!==context.hash||typeof row.snapshot.text!=='string'||digest(row.snapshot.text)!==context.text_digest)throw wbError('expired');}
    const latest=get('grants',g,g.id);
    if(latest.status!==current.status||latest.authority_generation!==g.authority_generation||closedAttempt(get('attempts',g,g.attempt_id))||now()>=g.expires_at||requireScope(g).generation!==g.project_generation)throw wbError('expired');
    return latest;
  }
  async function snapshot(body){
    const project=requireScope(body),attempt=get('attempts',body,body.attempt_id),candidate=get('candidates',body,attempt.candidate_id),task=get('tasks',body,attempt.task_id);
    if(closedAttempt(attempt)||[attempt.project_generation,candidate.project_generation,task.project_generation].some(value=>value!==project.generation)||candidate.task_id!==task.id||task.candidate_id!==candidate.id)throw wbError('stale_resource');
    const recipient=await binding(attempt,body);
    const contexts=body.context_ids.map(id=>{const c=get('contexts',body,id);if(c.attempt_id!==attempt.id||c.purged_at||!Number.isFinite(c.retention_until)||c.retention_until<=now()||typeof c.snapshot?.text!=='string'||createHash('sha256').update(c.snapshot.text).digest('hex')!==c.snapshot.hash||(c.snapshot.provenance?.project_generation!==undefined&&c.snapshot.provenance.project_generation!==project.generation))throw wbError('permission_denied');return {id,hash:c.snapshot.hash,text_digest:digest(c.snapshot.text)};});
    return {workspace_id:body.workspace_id,project_id:body.project_id,attempt_id:attempt.id,candidate_id:candidate.id,candidate_hash:candidate.hash,project_generation:project.generation,acceptance_digest:task.acceptance_digest,definition_id:task.check_definition_id,required_checks:task.acceptance.required_checks,recipient,contexts,budget:clone(body.budget),authority_generation:randomUUID()};
  }
  async function dispatch(body){
    if(validateNative(body)&&body.action==='list'){store.read(body.workspace_id);return {grants:data.list('grants',body.workspace_id,body.project_id).map(publicGrant),health:health()};}
    if(!validateNative(body))throw wbError('invalid_request');
    if(closed)throw wbError('unavailable');
    if(body.action==='preview'){
      for(const [id,p] of previews)if(p.expires_at<=now())previews.delete(id);
      if(previews.size>=64)throw wbError('busy');
      const scope=await snapshot(body),preview_id=randomUUID(),expires_at=now()+60000,preview_digest=digest(scope);
      const p={...scope,preview_id,preview_digest,expires_at};previews.set(preview_id,p);
      return {preview:p,preview_id,preview_digest,expires_at,repair_iteration_limit:p.budget.repair_iterations??3,output_limit_bytes:1048576,storage_policy:'Bounded candidate/file/retained-log inputs; no host disk quota or filesystem isolation',contract:HERMES_NATIVE_CONTRACT};
    }
    if(body.action==='approve'){
      const p=previews.get(body.preview_id);
      if(!p||p.workspace_id!==body.workspace_id||p.project_id!==body.project_id||p.expires_at<=now()||p.preview_digest!==body.preview_digest)throw wbError('expired');
      const fresh=await snapshot({...body,attempt_id:p.attempt_id,context_ids:p.contexts.map(c=>c.id),budget:p.budget});fresh.authority_generation=p.authority_generation;
      const {preview_id,preview_digest,expires_at,...scope}=p;
      if(digest(fresh)!==digest(scope))throw wbError('stale_resource');
      if(previews.get(preview_id)!==p)throw wbError('expired');
      previews.delete(preview_id);
      return {grant:publicGrant(data.create('grants',{...scope,status:'approved',expires_at:now()+p.budget.duration_ms,calls_used:0,checks_used:0,run_id:null}))};
    }
    const g=get('grants',body,body.grant_id);
    if(body.action==='status')return {grant:publicGrant(g),toolcalls:data.list('toolcalls',body.workspace_id,body.project_id).filter(c=>c.grant_id===g.id),health:health(),...(g.status==='dispatch_unknown'?{unknown_digest:unknownDigest(g),unknown_policy:NATIVE_UNKNOWN_POLICY}:{})};
    if(body.action==='acknowledge_unknown'){
      if(g.status!=='dispatch_unknown'||body.expected_digest!==unknownDigest(g)||running.has(g.id))throw wbError('stale_resource');
      if(typeof hermes?.acknowledgeNativeUnknown!=='function')throw wbError('unavailable');
      update('grants',g,g.id,{status:'acknowledged_unknown',acknowledged_digest:body.expected_digest,owner_asserted_terminated:true,acknowledged_at:now(),authority_generation:randomUUID(),risk_policy:NATIVE_UNKNOWN_POLICY});
      hermes.acknowledgeNativeUnknown({grant_id:g.id});quarantineFailures.delete(g.id);
      return {grant:publicGrant(get('grants',g,g.id)),replayed:false};
    }
    if(body.action==='stop'){
      if(g.status==='dispatch_unknown'&&!running.has(g.id))return {grant:publicGrant(g),stop_requested:false,outcome_unknown:true};
      if(g.runtime_status==='exited')return {grant:publicGrant(g),stop_requested:false,termination_confirmed:true};
      channels.delete(g.id);update('grants',g,g.id,{status:g.run_id?'stop_requested':'stopped',authority_generation:randomUUID(),...(g.run_id?{}:{runtime_status:'not_started'})});
      if(g.run_id)await hermes.stopNative({run_id:g.run_id,grant_id:g.id});
      return {grant:publicGrant(get('grants',g,g.id)),stop_requested:!!g.run_id,termination_confirmed:!g.run_id};
    }
    const authorized=await authorize(g);
    if(authorized.status!=='approved'||typeof hermes?.startNative!=='function')throw wbError('unavailable');
    if(get('candidates',g,g.candidate_id).hash!==g.candidate_hash)throw wbError('stale_resource');
    if(data.db.prepare("SELECT 1 FROM wb_grants WHERE json_extract(record_json,'$.status')='dispatch_unknown' LIMIT 1").get())throw wbError('outcome_unknown');
    if(data.list('grants',g.workspace_id,g.project_id).some(x=>x.id!==g.id&&x.attempt_id===g.attempt_id&&['running','dispatch_unknown'].includes(x.status)))throw wbError('busy');
    data.update('grants',g.workspace_id,g.project_id,g.id,authorized.revision,{status:'starting'});
    let socket;try{socket=await listen();}catch(e){update('grants',g,g.id,{status:'failed'});throw e;}
    if(get('grants',g,g.id).status!=='starting')throw wbError('expired');
    const secret=randomBytes(32).toString('hex'),run_id=randomUUID();
    channels.set(g.id,{secret,sequence:0,busy:false,scope:clone(g)});
    update('grants',g,g.id,{status:'running',runtime_status:'running',run_id});
    try{
      const handle=await hermes.startNative({scope:clone(g),run_id,channel:{socket,secret,grant_id:g.id},input:'Work only on the approved candidate. Inspect the task and context, make bounded candidate changes, and use recorded check evidence. Completion text is not verification.',authorize:()=>authorize(g,{active:true})});
      if(!handle?.completion||typeof handle.completion.then!=='function')throw wbError('unavailable');
      running.set(g.id,{...handle,scope:clone(g)});
      Promise.resolve(handle.completion).then(outcome=>settled(g,outcome,true),error=>settled(g,error,false)).catch(()=>{}).finally(()=>{channels.delete(g.id);running.delete(g.id);});
      if(get('grants',g,g.id).status==='stop_requested')await hermes.stopNative({run_id,grant_id:g.id});
    }catch(error){channels.delete(g.id);if(error?.native_outcome==='not_started')update('grants',g,g.id,{status:get('grants',g,g.id).status==='stop_requested'?'stopped':'failed',runtime_status:'not_started'});else markUnknown(g);throw wbError(error?.code==='busy'?'busy':'unavailable');}
    return {grant:publicGrant(get('grants',g,g.id))};
  }
  async function settled(g,outcome,success){
    if(closed)return;
    if(outcome?.termination_confirmed!==true){markUnknown(g);return;}
    let current=get('grants',g,g.id),status=current.status;
    if(status==='stop_requested')status='stopped';
    else if(status==='running'){
      try{await authorize(g,{active:true});status=success?'completed':'failed';}catch{status=now()>=g.expires_at?'expired':'fenced';}
    }
    current=get('grants',g,g.id);
    if(current.status==='stop_requested')status='stopped';
    else if(current.status!=='running')status=current.status;
    update('grants',g,g.id,{status,runtime_status:'exited',termination_confirmed:true,exit_code:Number.isInteger(outcome.exit_code)?outcome.exit_code:null,ended_at:now()});
  }
  function pauseBudget(g){channels.delete(g.id);update('grants',g,g.id,{status:'paused_budget',reason:'calls_exhausted',authority_generation:randomUUID()});Promise.resolve(hermes.stopNative?.({run_id:get('grants',g,g.id).run_id,grant_id:g.id})).catch(()=>{});}
  async function tool(g,args){
    if(!validateNativeTool(args))throw wbError('invalid_request');
    const current=await authorize(g,{active:true});
    if(current.calls_used>=g.budget.calls){pauseBudget(g);throw wbError('limit_exceeded');}
    if(args.action==='job_start'&&current.checks_used>=g.budget.checks)throw wbError('limit_exceeded');
    if(args.action==='candidate_patch'&&(current.repairs_used??0)>=(g.budget.repair_iterations??3)){update('grants',g,g.id,{status:'paused_budget',reason:'repair_iterations_exhausted'});channels.delete(g.id);throw wbError('limit_exceeded');}
    update('grants',g,g.id,{calls_used:current.calls_used+1,checks_used:current.checks_used+(args.action==='job_start'?1:0),repairs_used:(current.repairs_used??0)+(args.action==='candidate_patch'?1:0)});
    const call=data.create('toolcalls',{workspace_id:g.workspace_id,project_id:g.project_id,grant_id:g.id,attempt_id:g.attempt_id,action:args.action,args_digest:digest(args),status:'started'});
    const base={workspace_id:g.workspace_id,project_id:g.project_id},candidate={...base,candidate_id:g.candidate_id};
    try{
      let result;
      switch(args.action){
        case 'inspect': {const a=get('attempts',g,g.attempt_id),t=get('tasks',g,a.task_id),c=await execution.dispatch({action:'candidate_get',...candidate});result={task:{title:t.title,acceptance:t.acceptance},candidate:c.candidate,contexts:g.contexts.map(c=>({id:c.id,hash:c.hash})),budget:g.budget};break;}
        case 'read_context':if(!g.contexts.some(c=>c.id===args.context_id))throw wbError('permission_denied');result={snapshot:get('contexts',g,args.context_id).snapshot};break;
        case 'candidate_read':result=await execution.dispatch({action:'candidate_read',...candidate,path:args.path});break;
        case 'candidate_patch':result=await execution.dispatch({action:'candidate_apply',...candidate,changes:args.changes,expected_candidate_hash:args.expected_candidate_hash},{kind:'native_agent',grant_id:g.id});break;
        case 'job_start': {const definition_id=args.definition_id??g.definition_id;if(!(g.required_checks??[{definition_id:g.definition_id}]).some(check=>check.definition_id===definition_id))throw wbError('permission_denied');const p=await execution.dispatch({action:'check_preview',...candidate,definition_id});await authorize(g,{active:true});result=await execution.dispatch({action:'check_run',...candidate,preview_id:p.preview_id,preview_digest:p.preview.spec_digest,op_id:call.id});break;}
        case 'job_status':case 'evidence': {const j=get('jobs',g,args.job_id);if(j.candidate_id!==g.candidate_id||!data.list('toolcalls',g.workspace_id,g.project_id).some(c=>c.grant_id===g.id&&c.id===j.op_id))throw wbError('permission_denied');result=await execution.dispatch({action:'job_get',...base,job_id:j.id});break;}
      }
      await authorize(g,{active:true});
      if(Buffer.byteLength(JSON.stringify(result))>524288)throw wbError('limit_exceeded');
      update('toolcalls',g,call.id,{status:'completed',result_digest:digest(result)});
      if(get('grants',g,g.id).calls_used>=g.budget.calls)pauseBudget(g);
      return result;
    }catch(e){update('toolcalls',g,call.id,{status:'failed',error:e?.code??'unavailable'});const latest=get('grants',g,g.id);if(latest.status==='running'&&latest.calls_used>=g.budget.calls)pauseBudget(g);throw e;}
  }
  async function listen(){
    if(listenPromise)return listenPromise;
    listenPromise=openSocket();return listenPromise;
  }
  async function openSocket(){
    const root=path.join(store.root,'native-channels');fs.mkdirSync(root,{recursive:true,mode:0o700});
    socketDir=fs.mkdtempSync(path.join(root,'c-'));fs.chmodSync(socketDir,0o700);
    const socket=path.join(socketDir,'bridge.sock');if(Buffer.byteLength(socket)>100)throw wbError('unavailable');
    server=http.createServer(async(req,res)=>{
      res.setHeader('Content-Type','application/json');res.setHeader('Cache-Control','no-store');
      let channel,acquired=false;
      try{
        if(req.method!=='POST'||req.url!=='/tool')throw wbError('permission_denied');
        let bytes=0;const chunks=[];for await(const chunk of req){bytes+=chunk.length;if(bytes>300000)throw wbError('limit_exceeded');chunks.push(chunk);}
        let raw;try{raw=new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(chunks));}catch{throw wbError('invalid_request');}
        const id=req.headers['x-orbit-grant'],seq=req.headers['x-orbit-sequence'],mac=req.headers['x-orbit-mac'];channel=channels.get(id);
        if(!channel||channel.busy||seq!==String(channel.sequence+1)||typeof mac!=='string'||!/^[a-f0-9]{64}$/.test(mac))throw wbError('permission_denied');
        const expected=createHmac('sha256',channel.secret).update(`${seq}\n${raw}`).digest();
        if(!timingSafeEqual(expected,Buffer.from(mac,'hex')))throw wbError('permission_denied');
        channel.busy=true;acquired=true;channel.sequence++;
        // Resolve the durable scope via the server-owned channel, never body IDs.
        const scope=channel.scope;
        if(!scope)throw wbError('permission_denied');
        const result=await tool(scope,JSON.parse(raw));res.end(JSON.stringify({ok:true,result}));
      }catch(e){res.statusCode=403;res.end(JSON.stringify({ok:false,error:e?.code??'unavailable'}));}
      finally{if(acquired)channel.busy=false;}
    });
    await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(socket,resolve);});fs.chmodSync(socket,0o600);return socket;
  }
  function close(){
    if(closed)return;closed=true;previews.clear();
    for(const [id,handle] of running){try{const g=get('grants',handle.scope??channels.get(id)?.scope,id);markUnknown(g);Promise.resolve(hermes.stopNative?.({run_id:g.run_id,grant_id:id})).catch(()=>{});}catch{}}
    channels.clear();server?.close();if(socketDir){try{fs.unlinkSync(path.join(socketDir,'bridge.sock'));}catch{}try{fs.rmdirSync(socketDir);}catch{}}
  }
  function onRevoke(projectId){for(const [id,c] of channels)if(c.scope?.project_id===projectId)channels.delete(id);}
  // Losing the adapter process handle never authorizes replay. Persist the fence
  // across server restart; status exposes it, stop cannot falsely acknowledge it.
  for(const row of data.db.prepare("SELECT record_json FROM wb_grants WHERE json_extract(record_json,'$.status') IN ('starting','running','stop_requested') OR json_extract(record_json,'$.runtime_status')='running'").all()){
    const g=JSON.parse(row.record_json);markUnknown(g);
  }
  for(const row of data.db.prepare("SELECT record_json FROM wb_grants WHERE json_extract(record_json,'$.status')='dispatch_unknown'").all())quarantine(JSON.parse(row.record_json));
  for(const row of data.db.prepare("SELECT record_json FROM wb_toolcalls WHERE json_extract(record_json,'$.status')='started'").all()){
    const call=JSON.parse(row.record_json);update('toolcalls',call,call.id,{status:'outcome_unknown'});
  }
  return {dispatch,close,onRevoke,health};
}
