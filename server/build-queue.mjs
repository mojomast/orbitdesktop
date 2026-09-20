import { mkdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const terminal = new Set(['completed','failed','cancelled','interrupted']);
export function createBuildQueue({ directory, upstream, context, interval = 3000 }) {
 mkdirSync(directory,{recursive:true,mode:0o700});
 const file=path.join(directory,'queue.json');
 let state={version:1,revision:0,enabled:false,tasks:[]}, busy=false;
 try { state=JSON.parse(readFileSync(file,'utf8')); } catch(e) { if(e.code!=='ENOENT') throw e; }
 // Never automatically replay a request whose acceptance was not durably recorded.
 state.enabled=false;
 for(const t of state.tasks) if(t.status==='starting') { t.status='blocked';t.note='Submission outcome unknown. Check Hermes before adding a replacement.'; }
 function save(){state.revision++;const tmp=file+'.tmp';writeFileSync(tmp,JSON.stringify(state),{mode:0o600});renameSync(tmp,file);}
 save();
 function view(workspace){return {...state,tasks:state.tasks.filter(t=>t.workspace===workspace)};}
 async function tick(){
  if(busy)return;busy=true;
  try {
   const active=state.tasks.find(t=>t.run && !terminal.has(t.status) && t.status!=='blocked');
   if(active){
    try{
     const run=await upstream(`/v1/runs/${active.run}`);
     if(run.session_id!==active.session)throw Error('Run conversation mismatch');
     active.status=run.status;active.output=String(run.output||'').slice(-24000);active.updated=new Date().toISOString();
     active.note=run.status==='waiting_for_approval'?'Approval required. Queue paused.':String(run.last_event?.type||run.status);
     if(run.status==='waiting_for_approval')state.enabled=false;
     if(terminal.has(run.status)){
      if(run.status!=='completed'||!active.output.trimEnd().endsWith('[WORKSHOP_DONE]')){state.enabled=false;active.status='blocked';active.note='Review required: task did not report verified completion.';}
      else active.note='Hermes reported completion. Read its evidence; this is not independent verification.';
     }
     save();
    }catch(e){state.enabled=false;active.note='Cannot confirm run status. Paused; no duplicate task will be started.';save();}
    return;
   }
   if(!state.enabled)return;
   const t=state.tasks.find(t=>t.status==='queued');
   if(!t){state.enabled=false;save();return;}
   t.status='starting';t.note='Submitting to Hermes';save();
   try{
    const data=await upstream('/v1/runs',{session_id:t.session,input:t.input,instructions:'You are executing an owner-approved Orbit build queue task. Follow normal tool approval policies. Work only on the requested task. Verify results with real tools. Do not claim success without evidence. If blocked or needing clarification, explain and do not emit the completion marker. Only when the requested task is fully complete and verified, finish your final response with [WORKSHOP_DONE].'+context(t.workspace)});
    if(typeof data.run_id!=='string')throw Error('Missing run ID');
    t.run=data.run_id;t.status=data.status||'running';t.note='Run accepted';
   }catch(e){
    state.enabled=false;
    t.status=e.status===429?'queued':'blocked';
    t.note=e.status===429?'Hermes is busy. Press Start queue after the current chat finishes.':'Submission outcome unknown; inspect Hermes before retrying. No automatic retry.';
   }
   save();
  }finally{busy=false;}
 }
 async function action(body){
  if(!uuid.test(body.workspace_id||''))throw Error('Invalid workspace');
  context(body.workspace_id);
  if(body.operation==='read')return view(body.workspace_id);
  if(busy)throw Error('Queue is updating; refresh and retry.');
  if(body.base_revision!==state.revision)throw Error('Queue changed; refresh before editing.');
  const t=state.tasks.find(t=>t.id===body.task_id&&t.workspace===body.workspace_id);
  switch(body.operation){
   case 'add': {
    if(typeof body.input!=='string'||!body.input.trim()||body.input.length>8000||state.tasks.length>=200)throw Error('Task must contain 1–8000 characters; queue limit 200.');
    state.tasks.push({id:randomUUID(),workspace:body.workspace_id,session:'orbit-'+randomUUID(),input:body.input.trim(),status:'queued',note:'Not started',created:new Date().toISOString()});break;
   }
   case 'start':
    if(body.confirm!==true)throw Error('Confirm task execution');
    if(state.tasks.some(t=>t.workspace!==body.workspace_id&&!terminal.has(t.status)&&t.status!=='blocked'))throw Error('Another workspace has pending tasks.');
    if(state.tasks.some(t=>t.workspace===body.workspace_id&&t.status==='blocked'))throw Error('Review and dismiss blocked tasks before continuing.');
    state.enabled=true;break;
   case 'pause':state.enabled=false;break;
   case 'dismiss':
    if(!t||!['queued','blocked',...terminal].includes(t.status))throw Error('Cannot dismiss active task');
    // Unknown submissions cannot be silently retried: dismissal is explicit acknowledgement.
    if(body.confirm!==true)throw Error('Confirm dismissal');
    state.tasks=state.tasks.filter(x=>x!==t);break;
   case 'stop':
   case 'approval': {
    if(!t?.run||terminal.has(t.status)||t.status==='blocked'||body.confirm!==true)throw Error('Confirm an active run');
    state.enabled=false;save();busy=true;
    try{
     if(body.operation==='approval'){
      if(t.status!=='waiting_for_approval'||!['once','deny'].includes(body.choice))throw Error('Invalid approval');
      await upstream(`/v1/runs/${t.run}/approval`,{choice:body.choice});t.status='running';t.note='Approval sent; queue remains paused';
     }else{await upstream(`/v1/runs/${t.run}/stop`,{});t.note='Stop requested; waiting for run confirmation';}
    }finally{busy=false;}
    break;
   }
   default:throw Error('Invalid queue operation');
  }
  save();return view(body.workspace_id);
 }
 async function approvals(body){const t=state.tasks.find(t=>t.id===body.task_id&&t.workspace===body.workspace_id);if(!t||t.status!=='waiting_for_approval')return [];const d=await upstream(`/v1/approvals/pending?session_id=${encodeURIComponent(t.run)}`);return (d.approvals||[]).map(a=>({command:String(a.command||a.description||a.tool_name||'Approval requested').slice(0,4000),reason:String(a.reason||'').slice(0,1000)}));}
 const timer=interval?setInterval(()=>{tick().catch(()=>{state.enabled=false;});},interval):null;timer?.unref();
 return {action,tick,approvals,close:()=>clearInterval(timer)};
}
