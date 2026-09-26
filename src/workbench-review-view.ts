import {button,el} from './dom';
import './project-workbench.css';

type Data=Record<string,any>;
type Args={paneId:string;getToken:()=>string;workspace_id:string;project_id:string};

/** Read-only, identity-bound review surface for an approved Workbench candidate. */
export function mountWorkbenchReviewView(body:HTMLElement,args:Args):{refresh():Promise<void>;dispose():void}{
  let closed=false,generation=0,controller:AbortController|null=null,selectedKey='';
  let executionState:Data={};
  const status=el('p','workbench-review-status','Loading exact candidate reviews…');status.setAttribute('role','status');
  const error=el('p','workbench-review-error');error.setAttribute('role','alert');
  const candidates=el('select');candidates.setAttribute('aria-label','Approved candidate review');
  const view=el('div','workbench-review-view');
  view.dataset.paneId=args.paneId;
  const textField=(title:string,value:unknown)=>{const node=el('p','');node.append(el('strong','',`${title}: `),document.createTextNode(typeof value==='string'?value:JSON.stringify(value??null)));return node;};
  const token=()=>args.getToken();
  function next(){generation++;controller?.abort();controller=new AbortController();return {ticket:generation,signal:controller.signal};}
  function current(ticket:number){return !closed&&ticket===generation;}
  async function api(endpoint:'execution'|'workflow'|'native',body:Data,ticket:number):Promise<Data>{
    const bearer=token();if(!bearer)throw Error('permission_denied');
    const response=await fetch(`/api/workbench/${endpoint}`,{method:'POST',headers:{Authorization:`Bearer ${bearer}`,'Content-Type':'application/json'},body:JSON.stringify({workspace_id:args.workspace_id,project_id:args.project_id,...body}),signal:controller?.signal});
    const value=await response.json();if(!current(ticket)||bearer!==token())throw Error('stale_resource');if(!response.ok||value.ok!==true)throw Error(value.code??'unavailable');return value;
  }
  function selected(){try{return JSON.parse(candidates.value) as {candidate_id:string;review_id:string;task_id:string};}catch{return null;}}
  async function renderSelected(ticket:number){
    const selection=selected();if(!selection){view.replaceChildren(el('p','','No currently approved candidate/review pair is available.'));return;}
    const [candidateReply,patch,grantList]=await Promise.all([
      api('execution',{action:'candidate_get',candidate_id:selection.candidate_id},ticket),
      api('workflow',{action:'patch_preview',...selection},ticket),
      api('native',{action:'list'},ticket),
    ]);
    if(!current(ticket))return;
    const candidate=candidateReply.candidate as Data,task=(executionState.tasks??[]).find((item:Data)=>item.id===selection.task_id),review=(executionState.reviews??[]).find((item:Data)=>item.id===selection.review_id);
    if(candidate.id!==selection.candidate_id||candidate.task_id!==selection.task_id||candidate.hash!==patch.candidate_hash||candidate.generation!==patch.candidate_generation||review?.candidate_hash!==candidate.hash||review?.decision!=='approved'||review?.review_identity!==candidateReply.review_identity)throw Error('stale_resource');
    const requirements:Data[]=task?.acceptance?.required_checks??[],reviewEvidenceIds=new Set<string>(candidateReply.review_evidence_ids??[]),jobsById=new Map<string,Data>();
    const jobs=executionState.jobs??[],jobIds=[...new Set(jobs.filter((job:Data)=>reviewEvidenceIds.has((executionState.evidence??[]).find((entry:Data)=>entry.job_id===job.id)?.id)).map((job:Data)=>job.id))].slice(0,32);
    const jobReplies=await Promise.all(jobIds.map(async id=>{try{return await api('execution',{action:'job_get',job_id:id},ticket);}catch{return null;}}));
    for(const reply of jobReplies)if(reply?.job?.id)jobsById.set(reply.job.id,reply);
    if(!current(ticket))return;
    const checks=requirements.map((required:Data)=>{
      const evidence=(candidateReply.review_evidence_ids??[]).map((id:string)=>{
        for(const reply of jobsById.values())for(const item of reply.evidence??[])if(item.id===id)return {job:reply.job,evidence:item};
        return null;
        }).find((pair:{job:Data;evidence:Data}|null)=>!!pair&&pair.evidence.definition_id===required.definition_id&&pair.evidence.definition_digest===required.definition_digest&&pair.evidence.execution_profile_id===required.execution_profile_id&&JSON.stringify(pair.evidence.execution_profile??null)===JSON.stringify(required.execution_profile??null)&&pair.evidence.candidate_id===candidate.id&&pair.evidence.candidate_hash_before===candidate.hash&&pair.evidence.candidate_hash_after===candidate.hash&&pair.evidence.project_generation===candidate.project_generation&&pair.evidence.acceptance_digest===task?.acceptance_digest&&pair.evidence.verdict==='pass'&&!pair.evidence.revoked&&!pair.evidence.superseded);
      return {required,evidence};
    });
    const complete=patch.review?.required_check_state?.complete===true&&patch.review.required_check_state.acceptance_digest===task?.acceptance_digest&&patch.review.required_check_state.required_checks_digest===task?.acceptance?.required_checks_digest&&candidateReply.acceptance_complete===true&&checks.length===requirements.length&&checks.length>0&&checks.every(item=>item.evidence),artifactChecksSupported=requirements.every((item:Data)=>item.execution_profile_id===null||item.execution_profile_id===undefined);
    const passed=checks.filter(item=>item.evidence).length;
    const summary=el('section','workbench-review-summary');summary.setAttribute('aria-label','Review summary');
    summary.append(el('strong','workbench-review-task-title',task?.title??'Candidate review'),el('span','workbench-review-generation',`Candidate generation ${candidate.generation}`),el('span','workbench-review-check-count',`${passed}/${checks.length} required checks pass`),el('span','workbench-review-freshness',complete?'Current approved identity':'Stale or incomplete'));
    const metadata=el('details','workbench-review-metadata'),metadataSummary=el('summary','','Candidate, source, acceptance and evidence identities');
    metadata.append(metadataSummary,textField('Candidate ID',candidate.id),textField('Candidate SHA-256',candidate.hash),textField('Source snapshot SHA-256',patch.source?.manifest_hash),textField('Acceptance digest',task?.acceptance_digest),textField('Required-check digest',task?.acceptance?.required_checks_digest),textField('Review identity',review.review_identity),textField('Evidence IDs',candidateReply.review_evidence_ids??[]),textField('Verified patch-export support',artifactChecksSupported?'Available after explicit artifact-check confirmation':'Unsupported for profile-bound checks; no profile equivalence is inferred'));summary.append(metadata);
    const left=el('section','workbench-review-diff');left.setAttribute('aria-label','Exact reviewed candidate diff');left.append(el('h4','','Exact candidate diff'),el('pre','workbench-review-diff-text',String(patch.patch_text??'No textual diff is available.')));
    const right=el('section','workbench-review-checks');right.setAttribute('aria-label','Frozen required checks and review evidence');right.append(el('h4','','Required checks and evidence'));
    for(const item of checks){const check=el('article','workbench-review-check');check.append(el('h5','',item.required.definition_id),el('strong',`workbench-review-verdict ${item.evidence?'is-pass':'is-pending'}`,item.evidence?item.evidence.evidence.verdict.toUpperCase():'PENDING'));const details=el('details'),summary=el('summary','','Check details');details.append(summary,textField('Profile',item.required.execution_profile_id??'Default trusted check profile'),textField('Job / evidence IDs',item.evidence?`${item.evidence.job.id} / ${item.evidence.evidence.id}`:'No exact evidence'));if(item.evidence){const raw=el('pre');raw.textContent=JSON.stringify(item.evidence.evidence.provenance??null,null,2);details.append(raw);}check.append(details);right.append(check);}
    const explanation=el('section','workbench-review-explanation');explanation.append(el('h4','','Worker explanation (not evidence)'));
    const matching=(grantList.grants??[]).filter((grant:Data)=>grant.candidate_id===candidate.id&&grant.task_id===task?.id).sort((a:Data,b:Data)=>(b.created_at??0)-(a.created_at??0));
    let nativeResult:Data|null=null;
    if(matching[0])try{nativeResult=(await api('native',{action:'status',grant_id:matching[0].id},ticket)).result??null;}catch{}
    if(!current(ticket))return;
    if(nativeResult){const exact=nativeResult.candidate_hash===candidate.hash&&nativeResult.candidate_generation===candidate.generation&&nativeResult.project_generation===candidate.project_generation,details=el('details'),summary=el('summary','','Expand literal Hermes explanation');summary.setAttribute('aria-label','Expand literal Hermes explanation');const content=el('pre','workbench-review-explanation-text');content.textContent=typeof nativeResult.text==='string'?nativeResult.text:'No explanation text was recorded.';details.append(summary,textField('Availability',nativeResult.availability),textField('Candidate binding',exact?'Exact current candidate version':'Historical/different candidate version'),content);explanation.append(textField('Attempt',matching[0].id),details);}
    else explanation.append(el('p','','No recorded worker explanation is available for this candidate. Explanations and model claims never substitute for check evidence.'));
    const human=el('section','workbench-review-owner');human.append(el('h4','','Human review'),textField('Decision',review.decision),textField('Review identity',review.review_identity),textField('Reviewed evidence IDs',review.evidence_ids??[]),textField('Freshness',complete?'Approved identity and all current required checks match.':'Review/evidence must be refreshed before relying on this view.'));
    view.replaceChildren(summary,left,right,explanation,human);
    status.textContent=`Review ready · ${passed}/${checks.length} required checks pass · artifact verification ${artifactChecksSupported?'supported':'unsupported for profile-bound checks'}.`;
  }
  async function refresh(){
    if(closed)return;const {ticket}=next();error.textContent='';status.textContent='Loading exact candidate reviews…';
    try{
      executionState=await api('execution',{action:'execution_state'},ticket);if(!current(ticket))return;
      const approved=(executionState.reviews??[]).filter((review:Data)=>review.decision==='approved').map((review:Data)=>({review,candidate:(executionState.candidates??[]).find((entry:Data)=>entry.id===review.candidate_id&&entry.hash===review.candidate_hash)})).filter((pair:{review:Data;candidate:Data|undefined}):pair is {review:Data;candidate:Data}=>!!pair.candidate);
      const previous=selectedKey;candidates.replaceChildren();
      for(const pair of approved){const task=(executionState.tasks??[]).find((item:Data)=>item.id===pair.candidate.task_id),value=JSON.stringify({candidate_id:pair.candidate.id,review_id:pair.review.id,task_id:pair.candidate.task_id}),option=el('option','',`${task?.title??'Task'} · gen ${pair.candidate.generation}`);option.title=`Candidate ${pair.candidate.id} · review ${pair.review.id}`;option.value=value;candidates.append(option);}
      if(Array.from(candidates.options).some(option=>option.value===previous))candidates.value=previous;selectedKey=candidates.value;
      if(!selectedKey){view.replaceChildren(el('p','','No approved candidate/review pair matches a current candidate version.'));status.textContent='No current approved candidate review.';return;}
      await renderSelected(ticket);
    }catch(reason){if(current(ticket)&&!(reason instanceof Error&&reason.name==='AbortError')){view.replaceChildren();error.textContent=`Could not load exact candidate review: ${reason instanceof Error?reason.message:'unavailable'}. Refresh before relying on prior evidence.`;status.textContent='Candidate review unavailable.';}}
  }
  candidates.addEventListener('change',()=>{selectedKey=candidates.value;void refresh();});
  const refreshButton=button('Refresh exact candidate review','Revalidate candidate, frozen checks, review, and worker explanation',()=>void refresh());
  const panel=el('div','workbench-review-panel');panel.append(el('h3','','Candidate review'),status,error,candidates,refreshButton,view);
  body.replaceChildren(panel);
  void refresh();
  return {refresh,dispose(){closed=true;generation++;controller?.abort();controller=null;view.replaceChildren();body.replaceChildren();}};
}
