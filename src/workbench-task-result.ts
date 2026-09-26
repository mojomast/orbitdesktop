import {button,el} from './dom';

type Json=Record<string,any>;
type Args={container:HTMLElement;token:string|(()=>string);workspace_id:string;project_id:string;onChanged?:()=>void;onOpenEvidence?:(reference:{evidence_id:string;job_id:string})=>void;onOpenCandidate?:(reference:{candidate_id:string;candidate_hash:string;generation:number})=>void};

/** Owner-facing view of the durable native result; explanation is always literal text. */
export function mountWorkbenchTaskResult(args:Args):{refresh():Promise<void>;dispose():void}{
  let disposed=false,busy=false,selectedGrant='',selectedResult='',generation=0,activeRequest:AbortController|null=null;
  let knownToken=readToken();
  const deliveryOps=new Map<string,string>();
  const status=el('p','workbench-result-status','Task results: loading…');status.setAttribute('role','status');
  const error=el('p','workbench-result-error');error.setAttribute('role','alert');
  const grants=el('select','workbench-result-grants'),results=el('select','workbench-result-results');
  grants.setAttribute('aria-label','Result native attempt');results.setAttribute('aria-label','Recorded task result');
  const view=el('section','workbench-task-result');
  const field=(label:string,value:unknown)=>{const row=el('p','workbench-result-field');const name=el('strong','',`${label}: `),content=el('span');content.textContent=typeof value==='string'?value:JSON.stringify(value??null);row.append(name,content);return row;};
  function readToken(){return typeof args.token==='function'?args.token():args.token;}
  function clearPrivateView(){selectedResult='';results.replaceChildren();view.replaceChildren();}
  function invalidate(){generation++;activeRequest?.abort();activeRequest=null;}
  function checkToken(){const current=readToken();if(current!==knownToken){knownToken=current;invalidate();clearPrivateView();error.textContent='';status.textContent='Owner authorization changed. Refresh to read authorized results.';}return current;}
  function isCurrent(ticket:number,token:string,grantId:string,resultId=''){
    if(disposed||ticket!==generation||token!==readToken()||token!==knownToken){if(token!==readToken())checkToken();return false;}
    if(grantId&&grants.value!==grantId)return false;
    if(resultId&&selectedResult!==resultId)return false;
    return true;
  }
  function controller(){activeRequest?.abort();const next=new AbortController();activeRequest=next;return next;}
  const api=async(endpoint:string,body:Json,token:string,signal:AbortSignal)=>{if(!token)throw Error('permission_denied');const response=await fetch(`/api/workbench/${endpoint}`,{method:'POST',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},body:JSON.stringify({workspace_id:args.workspace_id,project_id:args.project_id,...body}),signal});const data=await response.json();if(!response.ok||data.ok!==true)throw Error(typeof data.code==='string'?data.code:'unavailable');return data;};
  const provenance=(value:Json)=>{
    const p=value??{};
    const initiator=p.initiated_by??{},authorizer=p.authorized_by??{},recorder=p.recorded_by??{};
    const initiatorLabel=initiator.kind==='native_agent'?'Supervised native worker':initiator.kind==='owner_action'?'Owner action':'Historical origin unknown';
    const authorizerLabel=authorizer.kind==='owner_grant'?'Owner-approved native grant':authorizer.kind==='owner_approval'?'Owner approval':'Historical authorization unknown';
    const recorderLabel=recorder.kind==='comet_service'?`Comet service recorder (${recorder.component})`:'Historical recorder unknown';
    const result=el('div','workbench-result-provenance');result.append(field('Initiated by',initiatorLabel),field('Authorized by',authorizerLabel),field('Recorded by',recorderLabel));
    const details=el('details'),summary=el('summary','','Show provenance identifiers');const raw=el('pre');raw.textContent=JSON.stringify({initiated_by:initiator,authorized_by:authorizer,recorded_by:recorder},null,2);details.append(summary,raw);result.append(details);return result;
  };
  const checkProvenance=(value:Json)=>{
    const p=value??{},initiator=p.initiated_by??{},authorizer=p.authorized_by??{},recorder=p.recorded_by??{};
    const view=el('div','workbench-result-provenance');view.append(field('Check initiated by',initiator.kind==='native_agent'?'Supervised worker':'Owner or historical actor'),field('Check authorized by',authorizer.kind==='owner_grant'?'Approved native task grant':authorizer.kind==='owner_approval'?'Owner-approved check':'Historical/unknown authority'),field('Check recorded by',recorder.kind==='comet_service'?`Comet check recorder · ${recorder.verifier_id??recorder.component??'verifier unavailable'}`:'Historical recorder unknown'));
    const details=el('details'),summary=el('summary','','Show check provenance identifiers'),raw=el('pre');raw.textContent=JSON.stringify(p,null,2);details.append(summary,raw);view.append(details);return view;
  };
  async function refresh(){
    const token=checkToken();if(disposed||busy)return;invalidate();const ticket=generation,requestController=controller();clearPrivateView();status.textContent='Loading task results…';error.textContent='';
    try{
      const data=await api('native',{action:'list'},token,requestController.signal);if(!isCurrent(ticket,token,''))return;
      const old=grants.value;grants.replaceChildren();
      for(const grant of data.grants??[]){const option=el('option','',`${grant.id} · ${grant.status} · candidate ${grant.candidate_id}`);option.value=grant.id;grants.append(option);}
      if((data.grants??[]).some((g:Json)=>g.id===old))grants.value=old;
      selectedGrant=grants.value;if(!selectedGrant){view.replaceChildren(el('p','','No native task attempts are recorded for this project.'));status.textContent='Task results ready.';return;}
      const grantId=selectedGrant,response=await api('native',{action:'status',grant_id:grantId},token,requestController.signal);if(!isCurrent(ticket,token,grantId))return;
      const result=response.result as Json|null;
      results.replaceChildren();
      if(result){const option=el('option','',`${result.id} · ${result.availability}${result.unavailable_reason?` (${result.unavailable_reason})`:''}`);option.value=result.id;results.append(option);selectedResult=result.id;const detail=await loadDetails(result,response.grant,token,requestController.signal);if(!isCurrent(ticket,token,grantId,result.id))return;render(result,response.grant,{ticket,token,grantId},detail);}
      else{selectedResult='';view.replaceChildren(el('p','','No durable result is available yet. Refresh status to read; execution is never retried by refresh.'));}
      status.textContent=`Attempt status: ${response.grant?.status??'unknown'}. Result ${result?.availability??'pending or not yet recorded'}.`;
    }catch(reason){if(isCurrent(ticket,token,selectedGrant)&&!(reason instanceof Error&&reason.name==='AbortError')){clearPrivateView();error.textContent=`Could not read task result: ${reason instanceof Error?reason.message:'unavailable'}. Refresh to try again; execution will not be replayed.`;status.textContent='Task result unavailable.';}}
    finally{if(activeRequest===requestController)activeRequest=null;}
  }
  async function loadDetails(result:Json,grant:Json,token:string,signal:AbortSignal):Promise<Json>{
    try{
      const [state,fresh]=await Promise.all([api('execution',{action:'execution_state'},token,signal),api('execution',{action:'candidate_get',candidate_id:result.candidate_id},token,signal)]);
      const task=(state.tasks??[]).find((item:Json)=>item.id===result.task_id),candidate=fresh.candidate??{},candidateMatches=candidate.hash===result.candidate_hash&&candidate.generation===result.candidate_generation&&candidate.project_generation===result.project_generation&&!fresh.target_changed&&task?.acceptance_digest===grant.acceptance_digest;
      const requirements=Array.isArray(task?.acceptance?.required_checks)?task.acceptance.required_checks:[],jobs:Json[]=state.jobs??[],evidence:Json[]=state.evidence??[],needed=new Set<string>((result.resolved_references??[]).map((ref:Json)=>ref.job_id));
      const latestJobs=requirements.map((required:Json)=>jobs.filter((job:Json)=>job.candidate_id===result.candidate_id&&job.candidate_hash===result.candidate_hash&&job.project_generation===result.project_generation&&job.acceptance_version===task?.acceptance_version&&job.acceptance_digest===grant.acceptance_digest&&job.definition_id===required.definition_id&&job.definition_digest===required.definition_digest&&job.execution_profile_id===required.execution_profile_id&&JSON.stringify(job.execution_profile??null)===JSON.stringify(required.execution_profile??null)).sort((a:Json,b:Json)=>(a.created_at??0)-(b.created_at??0)).at(-1)??null);
      for(const job of latestJobs)if(job?.id)needed.add(job.id);
      const jobReplies=await Promise.all([...needed].slice(0,24).map(async job_id=>{try{return await api('execution',{action:'job_get',job_id},token,signal);}catch{return null;}}));
      const detailByJob=new Map<string,Json>();for(const reply of jobReplies)if(reply?.job?.id)detailByJob.set(reply.job.id,reply);
      const acceptedIds=new Set(candidateMatches&&fresh.acceptance_complete?fresh.review_evidence_ids??[]:[]);
      const checks=requirements.map((required:Json,index:number)=>{
        const job=latestJobs[index],reply=job?detailByJob.get(job.id):null,rows:Json[]=reply?.evidence??[],entry=rows.find((item:Json)=>item.job_id===job?.id&&item.candidate_hash_before===result.candidate_hash&&item.candidate_hash_after===result.candidate_hash&&item.acceptance_digest===grant.acceptance_digest&&item.project_generation===result.project_generation&&!item.revoked&&!item.superseded);
        const isRequiredPass=!!entry&&acceptedIds.has(entry.id)&&entry.verdict==='pass'&&candidateMatches;
        return {definition_id:required.definition_id,execution_profile_id:required.execution_profile_id,status:isRequiredPass?'latest complete pass':entry?`${entry.verdict}${job?.status==='completed'?'':' · job '+(job?.status??'unknown')}`:job?.status??'not run',evidence:entry??null,job:reply?.job??job??null};
      });
      const review=(state.reviews??[]).filter((item:Json)=>item.candidate_id===result.candidate_id&&item.candidate_hash===result.candidate_hash).at(-1)??null;
      const currentReview=review&&candidateMatches&&review.review_identity===fresh.review_identity?review:null;
      const refs=(result.resolved_references??[]).map((reference:Json)=>{const reply=detailByJob.get(reference.job_id),entry=(reply?.evidence??[]).find((item:Json)=>item.id===reference.evidence_id&&item.candidate_id===result.candidate_id&&item.candidate_hash_after===result.candidate_hash&&item.verdict===reference.verdict&&!item.revoked&&!item.superseded);return {reference,evidence:entry??null,job:reply?.job??null};});
      return {available:true,candidateMatches,acceptanceComplete:candidateMatches&&fresh.acceptance_complete===true,checks,refs,currentReview,review};
    }catch{return {available:false,candidateMatches:false,acceptanceComplete:false,checks:[],refs:[],currentReview:null,review:null};}
  }
  function render(result:Json,grant:Json|undefined,auth:{ticket:number;token:string;grantId:string},detail:Json){
    const sections:HTMLElement[]=[];
    const explanation=el('section','workbench-result-explanation');explanation.append(el('h4','','Agent explanation'));
    const availability=result.availability==='available'?'Available':result.availability==='pending'?'Persistence pending':`Unavailable (${result.unavailable_reason??result.availability})`;
    explanation.append(field('Availability',availability),field('Hermes completed',result.hermes_completed));
    const text=el('pre','workbench-result-text');text.textContent=typeof result.text==='string'?result.text:'No explanation text was recorded.';explanation.append(text);sections.push(explanation);
    const evidence=el('section','workbench-result-evidence');evidence.append(el('h4','','Recorded checks'));
    evidence.append(field('Latest complete required-check set',detail.available?(detail.acceptanceComplete?'Complete for this exact candidate and acceptance revision':'Incomplete, stale, or changed'):'Current check state unavailable. Refresh to re-read; no check is inferred from explanation text.'));
    if(detail.checks.length){for(const check of detail.checks){const item=el('div','workbench-result-check');item.append(field(`Required check · ${check.definition_id}`,`${check.status}${check.execution_profile_id?` · profile ${check.execution_profile_id}`:''}`));if(check.evidence){item.append(field('Recorded result',`${check.evidence.verdict} · evidence ${check.evidence.id}`));item.append(checkProvenance(check.evidence.provenance));}else if(check.job)item.append(field('Latest job',`${check.job.status} · ${check.job.id}`));evidence.append(item);}}
    const refs=detail.refs??[];
    if(refs.length){evidence.append(el('h5','','Evidence references resolved by the service'));for(const item of refs){const ref=item.reference;if(!item.evidence){evidence.append(field(`Historical/unavailable reference ${ref.evidence_id}`,`Job ${ref.job_id} · ${ref.verdict}; it is not linked as current evidence.`));continue;}const open=button('Open exact recorded evidence',`Open evidence ${ref.evidence_id}`,()=>{if(isCurrent(auth.ticket,auth.token,auth.grantId,result.id))args.onOpenEvidence?.({evidence_id:ref.evidence_id,job_id:ref.job_id});});open.disabled=!args.onOpenEvidence;evidence.append(field(`${ref.verdict} · evidence ${ref.evidence_id}`,`Job ${ref.job_id}`),open,checkProvenance(item.evidence.provenance));}}
    else evidence.append(el('p','','No server-resolved evidence references in this explanation. All required checks above are read independently of model-suggested references.'));
    if(Array.isArray(result.model_suggested_references)&&result.model_suggested_references.length)evidence.append(field('Unverified model-suggested references (not linked)',result.model_suggested_references));
    sections.push(evidence);
    const provenanceSection=el('section','workbench-result-human-review'),openCandidate=button('Open exact candidate version','Open the exact candidate generation and hash',()=>{if(isCurrent(auth.ticket,auth.token,auth.grantId,result.id))args.onOpenCandidate?.({candidate_id:result.candidate_id,candidate_hash:result.candidate_hash,generation:result.candidate_generation});});openCandidate.disabled=!args.onOpenCandidate;provenanceSection.append(el('h4','','Human review'),field('Candidate',`${result.candidate_id} · generation ${result.candidate_generation}`),field('Candidate freshness',detail.candidateMatches?'Matches the current candidate and acceptance revision':'Historical or stale relative to the current candidate'),field('Exact candidate hash',result.candidate_hash),field('Task / attempt',`${result.task_id} / ${result.attempt_id}`),openCandidate,field('Result recorded',result.received_at?new Date(result.received_at).toISOString():'not recorded'),field('Retention until',result.retained_until?new Date(result.retained_until).toISOString():'unknown'),field('Owner review',detail.currentReview?`${detail.currentReview.decision} · review ${detail.currentReview.id}`:detail.review?'Historical review does not match the current review identity':'No exact owner review recorded'));
    if(result.availability==='pending'&&grant?.status==='result_pending'&&typeof grant.pending_digest==='string')provenanceSection.append(el('p','','The result receipt is durable-retry pending. This action finalizes the recorded frame only; it never reruns Hermes.'),button('Retry result persistence','Retry database-only finalization for this exact pending receipt',()=>void retryPersistence(result,grant,auth)));
    if(result.provenance){const provenanceSectionView=el('section','workbench-result-provenance-view');provenanceSectionView.append(el('h4','','Result provenance'),provenance(result.provenance));provenanceSection.append(provenanceSectionView);}
    const deliver=button('Return result to originating conversation','Create a host-authored result card; this does not send content to a model',()=>void deliverResult(result,auth));
    deliver.disabled=result.availability!=='available';provenanceSection.append(el('p','','Review and accept/reject the exact candidate separately in the execution panel. This result does not establish verification.'),deliver);sections.push(provenanceSection);
    view.replaceChildren(...sections);
  }
  async function retryPersistence(result:Json,grant:Json,auth:{ticket:number;token:string;grantId:string}){
    const expected_digest=grant.pending_digest as string;
    if(busy||!isCurrent(auth.ticket,auth.token,auth.grantId,result.id))return;busy=true;invalidate();const ticket=generation,requestController=controller();status.textContent='Retrying durable result finalization only…';error.textContent='';
    try{const response=await api('native',{action:'result_retry',result_id:result.id,expected_digest},auth.token,requestController.signal);if(!isCurrent(ticket,auth.token,auth.grantId,result.id))return;const finalizedGrant={...grant,status:'finalized',pending_digest:null},detail=await loadDetails(response.result,finalizedGrant,auth.token,requestController.signal);if(!isCurrent(ticket,auth.token,auth.grantId,result.id))return;status.textContent='Result receipt finalized without rerunning Hermes.';render(response.result,finalizedGrant,{ticket,token:auth.token,grantId:auth.grantId},detail);args.onChanged?.();}
    catch(reason){if(isCurrent(ticket,auth.token,auth.grantId,result.id)&&!(reason instanceof Error&&reason.name==='AbortError')){clearPrivateView();error.textContent=`Result persistence is still pending: ${reason instanceof Error?reason.message:'unavailable'}. No Hermes execution was retried.`;status.textContent='Result persistence pending.';}}
    finally{if(activeRequest===requestController)activeRequest=null;busy=false;}
  }
  async function deliverResult(result:Json,auth:{ticket:number;token:string;grantId:string}){
    if(busy||!isCurrent(auth.ticket,auth.token,auth.grantId,result.id))return;busy=true;invalidate();const ticket=generation,requestController=controller();status.textContent='Returning result to its original conversation…';error.textContent='';
    try{const recipient=result.recipient;if(!recipient?.pane_id||!recipient?.profile_id||!recipient?.session_id)throw Error('unavailable');const key=`orbit-workbench-result-delivery:${args.workspace_id}:${args.project_id}:${result.id}`;let op_id=deliveryOps.get(result.id);if(!op_id){try{op_id=localStorage.getItem(key)??'';}catch{}if(!op_id){op_id=crypto.randomUUID();try{localStorage.setItem(key,op_id);}catch{}}deliveryOps.set(result.id,op_id);}const receipt=await api('native',{action:'result_deliver',result_id:result.id,pane_id:recipient.pane_id,profile_id:recipient.profile_id,session_id:recipient.session_id,op_id},auth.token,requestController.signal);if(!isCurrent(ticket,auth.token,auth.grantId,result.id))return;auth.ticket=ticket;status.textContent='Host-authored result card recorded for the originating conversation. No model request was sent.';view.append(field('Card receipt',receipt.card?.id??receipt.id??'recorded'));args.onChanged?.();}
    catch(reason){if(isCurrent(ticket,auth.token,auth.grantId,result.id)&&!(reason instanceof Error&&reason.name==='AbortError')){clearPrivateView();error.textContent=`Result was not delivered: ${reason instanceof Error?reason.message:'unavailable'}. Refresh and review the current recipient binding.`;status.textContent='Result delivery unavailable.';}}
    finally{if(activeRequest===requestController)activeRequest=null;busy=false;}
  }
  grants.addEventListener('change',()=>{checkToken();invalidate();selectedGrant=grants.value;clearPrivateView();void refresh();});
  const refreshButton=button('Refresh task result','Read durable status and result without retrying the native run',()=>void refresh());
  args.container.replaceChildren(el('h3','','Task result'),status,error,grants,refreshButton,results,view);
  const tokenWatcher=setInterval(()=>{if(!disposed)checkToken();},1000);
  void refresh();
  return {refresh,dispose(){disposed=true;clearInterval(tokenWatcher);invalidate();clearPrivateView();args.container.replaceChildren();}};
}
