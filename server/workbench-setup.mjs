import fs from 'node:fs';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {validateSetup,validateSetupProposal} from '../contracts/workbench-setup-v1.mjs';
import {wbError} from './workbench-store.mjs';
import {captureProject} from './project-files.mjs';
import {previewCandidate} from './workbench-candidates.mjs';
import {discoverTestFiles,checkDefinition,definitionDigest} from './workbench-checks.mjs';

const canonical=value=>JSON.stringify(value,(_k,v)=>v&&typeof v==='object'&&!Array.isArray(v)?Object.fromEntries(Object.keys(v).sort().map(k=>[k,v[k]])):v);
const hash=value=>createHash('sha256').update(canonical(value)).digest('hex');
const sha=text=>createHash('sha256').update(text).digest('hex');
const fail=(code,reason)=>{throw Object.assign(wbError(code),{reason});};
const queues=new Map();
const MAX_BYTES=4*1024*1024,MAX_RECORDS=128,MAX_OPS=512;
export const SETUP_PUBLIC_REASONS=Object.freeze([
  'invalid_setup_request','invalid_setup_proposal','setup_storage_full','recovery_hold','binding_changed','operation_key_reused','setup_operation_limit','draft_binding_changed',
  'check_not_supported_for_project_setup','no_discoverable_node_tests','incomplete_source_capture','setup_source_or_policy_changed','execution_lane_busy_or_unknown',
  'native_unavailable','native_dispatch_or_result_unknown','native_runtime_unconfigured','native_result_persistence_failed','prepared_records_changed','prepared_context_changed',
  'multiple_authoritative_grants','setup_suggestion_limit','setup_draft_limit','setup_already_prepared','setup_preview_limit','setup_preview_changed','setup_preview_already_consumed',
  'setup_preview_expired','setup_candidate_materialization_unknown','setup_not_prepared','setup_launch_already_requested','setup_launch_preview_limit','launch_preview_changed',
  'launch_start_not_replayed','launch_approval_unknown','launch_not_started',
  'waiting_intent_limit','waiting_intent_expired','waiting_intent_review_required','waiting_intent_changed',
]);
const publicDraft=d=>Object.fromEntries(['id','op_id','project_id','goal','title','acceptance_statement','check_definition_id','status','task_id','candidate_id','attempt_id','context_ids','grant_id','reason','created_at'].filter(k=>d[k]!==undefined).map(k=>[k,d[k]]));
const publicGrant=({pending_result,...grant})=>grant;

// Private, fsync + atomic-rename journal. Single host service ownership follows
// the workspace store. The module queue also serializes reconstructed factories
// in this process. No setup bytes enter layout, checkpoints or metadata events.
export function createWorkbenchSetup({store,records,data,execution,hermes,context,native,gate,nativeConfigured=true,now=Date.now}={}){
  if(!path.isAbsolute(store?.root??'')||!records||!data||!execution?.setupStep||!hermes?.readBinding||!native?.dispatch||!gate?.busy)throw Error('Workbench setup dependencies required');
  const root=path.join(store.root,'workbench-setup');
  fs.mkdirSync(root,{recursive:true,mode:0o700});
  if(!fs.lstatSync(root).isDirectory()||fs.lstatSync(root).isSymbolicLink())throw wbError('unavailable');
  fs.chmodSync(root,0o700);
  function load(w){
    const file=path.join(root,`${w}.json`);
    let fd;
    try{fd=fs.openSync(file,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);const s=fs.fstatSync(fd);if(!s.isFile()||s.size>MAX_BYTES)throw wbError('limit_exceeded');const j=JSON.parse(fs.readFileSync(fd,'utf8'));j.waits??=[];return j;}
    catch(e){if(e.code==='ENOENT')return {version:1,drafts:[],suggestions:[],previews:[],launches:[],ops:[],waits:[]};throw e;}
    finally{if(fd!==undefined)fs.closeSync(fd);}
  }
  function save(w,j){
    const bytes=JSON.stringify(j);if(Buffer.byteLength(bytes)>MAX_BYTES)fail('limit_exceeded','setup_storage_full');
    const temp=path.join(root,`.write-${randomUUID()}`),file=path.join(root,`${w}.json`);
    const fd=fs.openSync(temp,'wx',0o600);
    try{fs.writeFileSync(fd,bytes);fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
    try{fs.renameSync(temp,file);const dir=fs.openSync(root,fs.constants.O_RDONLY|fs.constants.O_DIRECTORY|fs.constants.O_NOFOLLOW);try{fs.fsyncSync(dir);}finally{fs.closeSync(dir);}}
    finally{try{fs.unlinkSync(temp);}catch(e){if(e.code!=='ENOENT')throw e;}}
  }
  function serial(work){
    const previous=queues.get(root)??Promise.resolve();const next=previous.catch(()=>{}).then(work);
    queues.set(root,next);return next.finally(()=>{if(queues.get(root)===next)queues.delete(root);});
  }
  function policy(w){const p=store.read(w).recovery_policy??{generation:0,held:false};if(p.held)fail('permission_denied','recovery_hold');return hash(p);}
  async function binding(body){
    store.read(body.workspace_id);
    const b=await hermes.readBinding({workspace_id:body.workspace_id,pane_id:body.pane_id});
    if(b?.trusted_host!==true||b.sandbox!==false||!b.profile_id||!b.session_id||b.config_generation===undefined||b.binding_revision!==body.expected_binding_revision)fail('stale_resource','binding_changed');
    return {pane_id:body.pane_id,profile_id:b.profile_id,session_id:b.session_id,binding_revision:b.binding_revision,config_generation:b.config_generation,native_runtime:b.native_runtime??null};
  }
  function operation(j,body,actor){
    const identity=hash(body);let op=j.ops.find(o=>o.actor===actor&&o.id===body.op_id);
    if(op&&op.identity!==identity)fail('conflict','operation_key_reused');
    if(!op){if(j.ops.length>=MAX_OPS)fail('limit_exceeded','setup_operation_limit');op={actor,id:body.op_id,identity};j.ops.push(op);}
    return op;
  }
  function draftFor(j,id,b){const d=j.drafts.find(d=>d.id===id);if(!d||hash(d.binding)!==hash(b))fail('stale_resource','draft_binding_changed');return d;}
  function source(d,w){
    const project=records.project(w,d.project_id),capture=captureProject(project);
    if(d.check_definition_id!=='node-test')fail('unsupported','check_not_supported_for_project_setup');
    const tests=discoverTestFiles(capture.files);
    if(!tests.length)fail('unsupported','no_discoverable_node_tests');
    // Validate materialization limits before asking the owner to approve.
    const candidate=previewCandidate({project,capture,now});
    if(capture.limited||capture.exclusions.some(e=>e.reason!=='excluded_by_policy'))fail('unsupported','incomplete_source_capture');
    return {project_identity:hash(project),project_generation:project.generation,source_hash:capture.hash,source_files:candidate.base.files,exclusions:candidate.base.exclusions,total_bytes:candidate.base.total_bytes,check:{definition_id:'node-test',definition_digest:definitionDigest(checkDefinition('node-test')),required_test_files:tests},policy:policy(w)};
  }
  async function guard(body,d,frozen){
    const b=await binding(body);
    if(hash(b)!==hash(d.binding))fail('stale_resource','binding_changed');
    if(hash(source(d,body.workspace_id))!==hash(frozen))fail('stale_resource','setup_source_or_policy_changed');
  }
  function lane(){
    const h=native.health?.();
    if(!nativeConfigured||h?.supported===false)fail('unavailable','native_runtime_unconfigured');
    if(gate.busy('agent')||gate.busy('job'))fail('busy','execution_lane_busy_or_unknown');
    if(h&&!h.healthy)fail('outcome_unknown',h.cause??'native_unavailable');
  }
  function receipt(j,d,step){return data.list('annotations',d.workspace_id,d.project_id).find(r=>r.kind==='setup_step'&&r.setup_id===d.id&&r.step===step&&r.status==='completed')?.result;}
  function reconcile(d){
    for(const [step,key,field] of [['task','task','task_id'],['candidate','candidate','candidate_id'],['attempt','attempt','attempt_id'],['context','context','context_ids']]){
      const r=receipt(null,d,step);if(r)d[field]=step==='context'?[r[key].id]:r[key].id;
    }
    if(d.context_ids?.length&&!d.grant_id&&!d.status.startsWith('launch'))d.status='prepared';
  }
  function preparedIdentity(d){
    const get=(kind,id)=>data.get(kind,d.workspace_id,d.project_id,id);
    const t=get('tasks',d.task_id),c=get('candidates',d.candidate_id),a=get('attempts',d.attempt_id);
    const originalTask=receipt(null,d,'task')?.task,originalCandidate=receipt(null,d,'candidate')?.candidate;
    const recipient={pane_id:d.binding.pane_id,profile_id:d.binding.profile_id,session_id:d.binding.session_id};
    if(!originalTask||!originalCandidate||t.title!==d.title||t.acceptance_digest!==originalTask.acceptance_digest||hash(t.acceptance)!==hash(originalTask.acceptance)||t.candidate_id!==c.id||c.task_id!==t.id||c.hash!==originalCandidate.hash||a.task_id!==t.id||a.candidate_id!==c.id||a.acceptance_digest!==originalTask.acceptance_digest||hash(a.recipient)!==hash(recipient))fail('stale_resource','prepared_records_changed');
    const text=JSON.stringify({goal:d.goal,acceptance_statement:d.acceptance_statement});
    for(const id of d.context_ids){const context=get('contexts',id);if(context.attempt_id!==a.id||context.snapshot?.text!==text||context.snapshot.hash!==sha(text)||context.retention_until<=now())fail('stale_resource','prepared_context_changed');}
  }
  function grants(d,p){return data.list('grants',d.workspace_id,d.project_id).filter(g=>g.authority_generation===p.result.preview.authority_generation&&g.attempt_id===d.attempt_id);}
  const publicWait=i=>Object.fromEntries(['id','draft_id','task_id','candidate_id','state','reason','created_at','deadline','budget','review_preview_id'].filter(k=>i[k]!==undefined).map(k=>[k,i[k]]));
  async function reconcileWaits(body,j,b){
    let position=0;
    const visible=[];
    for(const i of j.waits){
      if(hash(i.binding)!==hash(b))continue;
      if(['waiting_lane','needs_review'].includes(i.state)){
        if(now()>=i.deadline){i.state='expired';i.reason='waiting_intent_expired';}
        else{
          const d=draftFor(j,i.draft_id,b);
          try{
            await guard(body,d,i.frozen);preparedIdentity(d);
            if(d.grant_id){i.state='reviewed';i.reason='setup_launch_already_requested';}
            else if(gate.busy('agent')||gate.busy('job')){i.state='waiting_lane';i.reason='execution_lane_busy_or_unknown';}
            else{i.state='needs_review';i.reason='waiting_intent_review_required';}
          }catch(error){i.state='needs_review';i.reason=error.reason??error.code??'waiting_intent_changed';}
        }
      }
      visible.push({...publicWait(i),position:['waiting_lane','needs_review'].includes(i.state)?++position:null});
    }
    return visible;
  }
  function recoverLaunch(d,p,op){
    // Once saved, grant identity survives authority rotation (stop/budget/fence).
    // Before that save only the exact preview's authority generation can recover
    // an approval whose response was lost.
    const found=op.grant_id?[data.get('grants',d.workspace_id,d.project_id,op.grant_id)]:grants(d,p);
    if(found.length>1)fail('outcome_unknown','multiple_authoritative_grants');
    const g=found[0];if(!g)return null;
    if(g.attempt_id!==d.attempt_id||g.candidate_id!==d.candidate_id)fail('outcome_unknown','multiple_authoritative_grants');
    d.grant_id=g.id;op.grant_id=g.id;
    if(g.status!=='approved'){
      const unknown=['starting','dispatch_unknown'].includes(g.status);
      const notStarted=g.runtime_status==='not_started'||(!g.run_id&&!unknown);
      d.status=notStarted?'failed':unknown?'launch_unknown':'launched';
      if(notStarted)d.reason='launch_not_started';
      return g;
    }
    d.status='launch_unknown';
    return g;
  }
  async function propose(body){
    if(!validateSetupProposal(body))fail('invalid_request','invalid_setup_proposal');
    return serial(()=>{
      // Workspace capability validation is the controller adapter's job. This
      // method never resolves a pane, project, transcript, or private source.
      store.read(body.workspace_id);const j=load(body.workspace_id),op=operation(j,body,'controller');
      if(op.result)return op.result;
      if(j.suggestions.length>=MAX_RECORDS)fail('limit_exceeded','setup_suggestion_limit');
      const suggestion={id:randomUUID(),goal:body.goal,title:body.title??body.goal.slice(0,240),acceptance_statement:body.acceptance_statement??body.goal,...(body.project_id?{project_id:body.project_id}:{}),...(body.check_definition_id?{check_definition_id:body.check_definition_id}:{})};
      j.suggestions.push(suggestion);op.result={id:suggestion.id};save(body.workspace_id,j);return op.result;
    });
  }
  async function dispatch(body){
    if(!validateSetup(body))fail('invalid_request','invalid_setup_request');
    return serial(async()=>{
      const w=body.workspace_id,b=await binding(body),j=load(w);policy(w);
      if(body.action==='state'){
        const drafts=j.drafts.filter(d=>hash(d.binding)===hash(b));
        for(const d of drafts){reconcile(d);for(const p of j.launches.filter(p=>p.draft_id===d.id)){const op=j.ops.find(o=>o.preview_id===p.id&&o.actor==='owner');if(op)recoverLaunch(d,p,op);}}
        const waiting_intents=await reconcileWaits(body,j,b);save(w,j);
        const capacity={bytes:{used:Buffer.byteLength(JSON.stringify(j)),limit:MAX_BYTES},records:Object.fromEntries(['drafts','suggestions','previews','launches','waits','ops'].map(k=>[k,{retained:j[k].length,limit:k==='ops'?MAX_OPS:MAX_RECORDS,remaining:Math.max(0,(k==='ops'?MAX_OPS:MAX_RECORDS)-j[k].length)}]))};
        return {projects:records.list(w).filter(p=>p.active!==false).map(p=>({id:p.id,name:p.name})),suggestions:j.suggestions,drafts:drafts.map(publicDraft),waiting_intents,capacity};
      }
      const op=body.op_id?operation(j,body,'owner'):null;
      if(body.action==='wait_cancel'){
        if(op.result)return op.result;
        const i=j.waits.find(i=>i.id===body.intent_id&&hash(i.binding)===hash(b));if(!i)fail('stale_resource','waiting_intent_changed');
        // Cancelling a waiting intention is never a process stop/revoke signal.
        if(!['waiting_lane','needs_review','cancelled','expired'].includes(i.state))fail('conflict','setup_launch_already_requested');
        i.state='cancelled';op.result={intent:publicWait(i)};save(w,j);return op.result;
      }
      if(body.action==='draft'){
        if(op.draft_id){const d=draftFor(j,op.draft_id,b);return {draft:publicDraft(d)};}
        if(j.drafts.length>=MAX_RECORDS)fail('limit_exceeded','setup_draft_limit');
        const d={id:randomUUID(),op_id:body.op_id,workspace_id:w,project_id:body.project_id,goal:body.goal,title:body.title??body.goal.slice(0,240),acceptance_statement:body.acceptance_statement??body.goal,check_definition_id:body.check_definition_id??'node-test',binding:b,status:'draft',created_at:now()};
        source(d,w);j.drafts.push(d);op.draft_id=d.id;save(w,j);return {draft:publicDraft(d)};
      }
      if(body.action==='preview'){
        const d=draftFor(j,body.draft_id,b);
        if(op.result)return op.result;
        if(d.status!=='draft')fail('conflict','setup_already_prepared');
        const frozen=source(d,w),id=randomUUID(),expires_at=now()+60000;
        const effects={task:{title:d.title,acceptance_statement:d.acceptance_statement},candidate:{source_hash:frozen.source_hash,file_count:frozen.source_files.length,total_bytes:frozen.total_bytes},attempt:{recipient:b},context:{kind:'owner_drafted_goal',text:JSON.stringify({goal:d.goal,acceptance_statement:d.acceptance_statement})},check:frozen.check,execution:false,disclosure:false};
        const preview_digest=hash({id,draft_id:d.id,frozen,binding:b,effects,expires_at});
        const result={preview_id:id,preview_digest,expires_at,summary:'Create a task, private candidate, bound attempt and goal-only context. No model or check runs.',draft:publicDraft(d),effects,source:{hash:frozen.source_hash,files:frozen.source_files,exclusions:frozen.exclusions},check:frozen.check};
        j.previews=j.previews.filter(p=>p.expires_at>now()||p.prepare_op);
        if(j.previews.length>=MAX_RECORDS)fail('limit_exceeded','setup_preview_limit');
        j.previews.push({id,draft_id:d.id,frozen,expires_at,preview_digest});op.result=result;save(w,j);return result;
      }
      if(body.action==='prepare'){
        const p=j.previews.find(p=>p.id===body.preview_id);if(!p||p.preview_digest!==body.preview_digest)fail('stale_resource','setup_preview_changed');
        const d=draftFor(j,p.draft_id,b);reconcile(d);
        if(p.prepare_op&&p.prepare_op!==op.id)fail('conflict','setup_preview_already_consumed');
        if(!p.prepare_op&&p.expires_at<=now())fail('expired','setup_preview_expired');
        await guard(body,d,p.frozen);
        if(receipt(null,d,'context')){
          for(const launch of j.launches.filter(p=>p.draft_id===d.id)){const launchOp=j.ops.find(o=>o.actor==='owner'&&o.preview_id===launch.id&&!o.approval_rejected);if(launchOp)recoverLaunch(d,launch,launchOp);}
          save(w,j);return {draft:publicDraft(d)};
        }
        p.prepare_op=op.id;d.status='preparing';d.frozen=p.frozen;save(w,j);
        const base={workspace_id:w,project_id:d.project_id},recipient={pane_id:b.pane_id,profile_id:b.profile_id,session_id:b.session_id};
        const step=async(name,args,snapshot)=>{
          await guard(body,d,p.frozen);
          return execution.setupStep({setup_id:d.id,step:name,request_hash:hash({setup:d.id,preview:p.preview_digest,step:name}),body:{...base,...args},snapshot,source_hash:p.frozen.source_hash,authorize:()=>{if(hash(source(d,w))!==hash(p.frozen))fail('stale_resource','setup_source_or_policy_changed');}});
        };
        try{
          d.task_id=(await step('task',{title:d.title,acceptance_statement:d.acceptance_statement,check_definition_id:d.check_definition_id,...recipient})).task.id;save(w,j);
          d.candidate_id=(await step('candidate',{task_id:d.task_id})).candidate.id;save(w,j);
          d.attempt_id=(await step('attempt',{task_id:d.task_id,candidate_id:d.candidate_id,...recipient})).attempt.id;save(w,j);
          const text=JSON.stringify({goal:d.goal,acceptance_statement:d.acceptance_statement});
          d.context_ids=[(await step('context',{task_id:d.task_id,attempt_id:d.attempt_id},{text,hash:sha(text),bytes:Buffer.byteLength(text),captured_at:now(),truncated:false,exclusions:[],provenance:{kind:'owner_drafted_goal',setup_id:d.id,project_generation:p.frozen.project_generation},manifest:{kind:'owner_drafted_goal'}})).context.id];
          await guard(body,d,p.frozen);d.status='prepared';delete d.reason;save(w,j);return {draft:publicDraft(d)};
        }catch(error){reconcile(d);d.status=error.code==='outcome_unknown'?'prepare_unknown':'failed';d.reason=error.reason??error.code??'setup_failed';save(w,j);throw error;}
      }
      const d=draftFor(j,body.draft_id,b);reconcile(d);
      if(!d.frozen||!d.context_ids?.length)fail('conflict','setup_not_prepared');
      await guard(body,d,d.frozen);
      const base={workspace_id:w,project_id:d.project_id};
      if(body.action==='wait'){
        if(op.result)return op.result;
        preparedIdentity(d);
        if(d.grant_id)fail('conflict','setup_launch_already_requested');
        if(body.deadline<=now()||body.deadline>now()+86400000)fail('expired','waiting_intent_expired');
        if(j.waits.length>=MAX_RECORDS)fail('limit_exceeded','waiting_intent_limit');
        if(j.waits.some(i=>i.draft_id===d.id&&['waiting_lane','needs_review'].includes(i.state)))fail('conflict','waiting_intent_changed');
        const i={id:randomUUID(),draft_id:d.id,task_id:d.task_id,candidate_id:d.candidate_id,attempt_id:d.attempt_id,binding:b,frozen:d.frozen,budget:body.budget,deadline:body.deadline,created_at:now(),state:'waiting_lane'};
        j.waits.push(i);op.result={intent:publicWait(i),execution_authorized:false};save(w,j);return op.result;
      }
      if(body.action==='launch_preview'){
        if(d.grant_id||j.ops.some(o=>o.draft_id===d.id&&o.preview_id&&!o.approval_rejected))fail('conflict','setup_launch_already_requested');
        preparedIdentity(d);lane();
        const result=await native.dispatch({...base,action:'preview',attempt_id:d.attempt_id,context_ids:d.context_ids,budget:body.budget});
        await guard(body,d,d.frozen);
        j.launches=j.launches.filter(p=>p.result.expires_at>now()||j.ops.some(o=>o.preview_id===p.id));
        if(j.launches.length>=MAX_RECORDS)fail('limit_exceeded','setup_launch_preview_limit');
        j.launches.push({id:result.preview_id,draft_id:d.id,result});
        for(const i of j.waits.filter(i=>i.draft_id===d.id&&['waiting_lane','needs_review'].includes(i.state))){i.state=now()>=i.deadline?'expired':'reviewed';i.review_preview_id=result.preview_id;}
        save(w,j);return result;
      }
      const p=j.launches.find(p=>p.id===body.preview_id&&p.draft_id===d.id);
      if(!p||p.result.preview_digest!==body.preview_digest)fail('stale_resource','launch_preview_changed');
      if(op.approval_rejected)fail('expired','launch_preview_changed');
      const other=j.ops.find(o=>o!==op&&o.draft_id===d.id&&o.preview_id&&!o.approval_rejected);if(other)fail('conflict','setup_launch_already_requested');
      op.draft_id=d.id;op.preview_id=p.id;
      let grant=recoverLaunch(d,p,op);
      if(grant&&grant.status!=='approved'){save(w,j);return {draft:publicDraft(d),grant:publicGrant(grant)};}
      if(op.start_intent){d.status='launch_unknown';save(w,j);fail('outcome_unknown','launch_start_not_replayed');}
      preparedIdentity(d);
      if(!grant){
        if(op.approve_intent)fail('outcome_unknown','launch_approval_unknown');
        lane();op.approve_intent=true;d.status='launch_unknown';save(w,j);
        // If this response disappears, recover by the saved preview's unique
        // authority generation, never by issuing a fresh approval.
        try{({grant}=await native.dispatch({...base,action:'approve',preview_id:p.id,preview_digest:body.preview_digest}));}
        catch(error){
          grant=recoverLaunch(d,p,op);
          if(!grant){
            if(error.native_approval_outcome==='not_created'){
              op.approval_rejected=true;d.status='prepared';delete op.approve_intent;save(w,j);
            }
            throw error;
          }
        }
        d.grant_id=grant.id;op.grant_id=grant.id;save(w,j);
      }
      await guard(body,d,d.frozen);preparedIdentity(d);lane();
      op.start_intent=true;d.status='launch_unknown';save(w,j);
      try{({grant}=await native.dispatch({...base,action:'start',grant_id:grant.id},{authorizeStart:()=>guard(body,d,d.frozen)}));}
      catch(error){recoverLaunch(d,p,op);save(w,j);throw error;}
      recoverLaunch(d,p,op);save(w,j);return {draft:publicDraft(d),grant:publicGrant(grant)};
    });
  }
  return {dispatch,propose};
}
