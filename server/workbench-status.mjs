import {createHash} from 'node:crypto';
import {wbError} from './workbench-store.mjs';

const digest=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const pick=(record,keys)=>Object.fromEntries(['id','revision','updated_at',...keys].filter(k=>record[k]!==undefined).map(k=>[k,record[k]]));
const unknown=new Set(['outcome_unknown','dispatch_unknown','finalization_pending','receipt_pending','result_pending','acknowledged_unknown']);
const active=new Set(['approved','starting','running','queued','stop_requested','preparing']);

// Reconnect starts with a consistent SQLite snapshot, never a trace/SSE verdict.
// One current item per task; its revision-derived identity and read marker are
// durable. Missed intermediate transitions are explicitly not synthesized.
export function createWorkbenchStatus({data,recordedAcceptance=()=>null,now=Date.now}){
  function snapshot(body){
    const {workspace_id:w,project_id:p}=body;
    const tables=Object.fromEntries(['tasks','candidates','attempts','jobs','grants','results','reviews','evidence','integrations','annotations'].map(k=>[k,data.list(k,w,p)]));
    const items=tables.tasks.map(task=>{
      const candidateIds=new Set(tables.candidates.filter(c=>c.task_id===task.id).map(c=>c.id));
      const attemptIds=new Set(tables.attempts.filter(a=>a.task_id===task.id).map(a=>a.id));
      const related=r=>r.task_id===task.id||candidateIds.has(r.candidate_id)||attemptIds.has(r.attempt_id);
      const jobs=tables.jobs.filter(related).map(r=>pick(r,['status','candidate_id','started_at','ended_at','deadline','termination_confirmed']));
      const grants=tables.grants.filter(related).map(r=>pick(r,['status','runtime_status','result_status','expires_at','termination_confirmed','owner_asserted_terminated']));
      const results=tables.results.filter(related).map(r=>({...pick(r,['availability','unavailable_reason','candidate_id','candidate_hash','retained_until']),availability:r.retained_until<=now()?'explanation_unavailable':r.availability}));
      const reviews=tables.reviews.filter(related).map(r=>pick(r,['decision','candidate_id','candidate_hash','review_identity']));
      const evidence=tables.evidence.filter(related).map(r=>pick(r,['verdict','candidate_id','candidate_hash_after','acceptance_digest','superseded','revoked']));
      const integrations=tables.integrations.filter(related).map(r=>pick(r,['status','candidate_id','candidate_hash','recovery_digest']));
      const resources=[...jobs,...grants,...integrations];
      const latestGrant=grants.at(-1);
      const category=resources.some(r=>unknown.has(r.status))?'review_needed':resources.some(r=>active.has(r.status))?'pending':latestGrant?.runtime_status==='exited'&&latestGrant.termination_confirmed===true?'completed':'review_needed';
      const state={task:pick(task,['title','status','candidate_id','acceptance_digest']),category,jobs,grants,results,reviews,evidence,integrations,check_acceptance:recordedAcceptance({...body,task_id:task.id}),trace_backfill:'not_available'};
      const identity=digest(state),read=tables.annotations.find(r=>r.kind==='task_status_read'&&r.task_id===task.id);
      return {...state,task_id:task.id,notification_id:identity,read:read?.notification_id===identity,last_authoritative_observation:Math.max(task.updated_at,...[...jobs,...grants,...results,...reviews,...evidence,...integrations].map(r=>r.updated_at)),targets:{live:{view:'live',task_id:task.id},checks:task.candidate_id?{view:'checks',candidate_id:task.candidate_id}:null,result:{view:'result',task_id:task.id}}};
    });
    return {items,snapshot_digest:digest(items.map(i=>[i.task_id,i.notification_id,i.read])),reset:true,history:'current_authoritative_snapshot_only',observed_at:now()};
  }
  function dispatch(body){
    return data.db.transaction(()=>{
      const result=snapshot(body);
      if(body.action==='task_status_snapshot')return result;
      const item=result.items.find(i=>i.task_id===body.task_id);
      if(!item||item.notification_id!==body.expected_notification_id)throw wbError('stale_resource');
      const old=data.list('annotations',body.workspace_id,body.project_id).find(r=>r.kind==='task_status_read'&&r.task_id===body.task_id);
      if(old?.notification_id===item.notification_id)return {task_id:item.task_id,notification_id:item.notification_id,read:true,idempotent:true};
      if(old)data.update('annotations',body.workspace_id,body.project_id,old.id,old.revision,{notification_id:item.notification_id});
      else data.create('annotations',{workspace_id:body.workspace_id,project_id:body.project_id,kind:'task_status_read',task_id:body.task_id,notification_id:item.notification_id});
      return {task_id:item.task_id,notification_id:item.notification_id,read:true,idempotent:false};
    }).immediate();
  }
  return {dispatch};
}
