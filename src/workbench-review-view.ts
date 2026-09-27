import {button,el} from './dom';
import {candidateDiffFromDetail} from './candidate-diff-adapter';
import {createCandidateDiffViewer} from './candidate-diff-viewer';
import './project-workbench.css';

type Data=Record<string,any>;
type Args={paneId:string;getToken:()=>string;workspace_id:string;project_id:string};

/** Read-only, identity-bound review surface for an approved Workbench candidate. */
export function mountWorkbenchReviewView(body:HTMLElement,args:Args):{refresh():Promise<void>;dispose():void}{
  let closed=false,generation=0,controller:AbortController|null=null,selectedKey='';
  let diffViewer:{element:HTMLElement;dispose():void}|null=null;
  function clearDiff(){diffViewer?.dispose();diffViewer=null;}
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
  async function api(endpoint:'execution'|'workflow'|'native'|'live',body:Data,ticket:number):Promise<Data>{
    const bearer=token();if(!bearer)throw Error('permission_denied');
    const response=await fetch(`/api/workbench/${endpoint}`,{method:'POST',headers:{Authorization:`Bearer ${bearer}`,'Content-Type':'application/json'},body:JSON.stringify({workspace_id:args.workspace_id,project_id:args.project_id,...body}),signal:controller?.signal});
    const value=await response.json();if(!current(ticket)||bearer!==token())throw Error('stale_resource');if(!response.ok||value.ok!==true)throw Error(value.code??'unavailable');return value;
  }
  function selected(){try{return JSON.parse(candidates.value) as {candidate_id:string;review_id:string;task_id:string};}catch{return null;}}
  async function renderSelected(ticket:number){
    const selection=selected();if(!selection){view.replaceChildren(el('p','','No currently approved candidate/review pair is available.'));return;}
    const selectedReview=(executionState.reviews??[]).find((entry:Data)=>entry.id===selection.review_id);
    const currentCandidate=(executionState.candidates??[]).find((entry:Data)=>entry.id===selection.candidate_id);
    if(selectedReview?.decision==='approved'&&currentCandidate&&selectedReview.candidate_hash!==currentCandidate.hash){
      diffViewer?.dispose();diffViewer=null;
      const stale=el('section','workbench-review-historical');
      stale.append(el('h4','','Historical approved review · candidate changed since this review'),textField('Reviewed candidate',selectedReview.candidate_id),textField('Reviewed hash',selectedReview.candidate_hash),textField('Current generation',currentCandidate.generation),textField('Current hash',currentCandidate.hash),textField('Review identity',selectedReview.review_identity),textField('Historical evidence IDs',selectedReview.evidence_ids??[]),el('p','','Historical approval is not current authorization. Current candidate content is never substituted.'));
      try{
        const recorded=await api('live',{action:'detail',reference:{kind:'review',id:selectedReview.id}},ticket),ref=recorded.candidate_reference;
        if(ref?.kind!=='candidate'||ref.id!==selectedReview.candidate_id||ref.hash!==selectedReview.candidate_hash||!Number.isSafeInteger(ref.generation))throw Error('historical_diff_unavailable');
        const reply=await api('live',{action:'detail',reference:ref,comparison:'initial'},ticket);
        if(!current(ticket))return;
        const diff=candidateDiffFromDetail(reply,{candidate_id:ref.id,generation:ref.generation,candidate_hash:ref.hash});
        diffViewer=createCandidateDiffViewer(diff,{title:`Historical approved review · generation ${ref.generation}`});stale.append(diffViewer.element);
      }catch(reason){if(!current(ticket))return;stale.append(el('p','','Exact historical comparison unavailable. The server could not resolve and validate the retained approved generation; current source was NOT substituted.'));}
      if(!current(ticket))return;
      view.replaceChildren(stale);status.textContent='Historical approved review · not current authorization.';return;
    }
    const [candidateReply,patch,grantList]=await Promise.all([
      api('execution',{action:'candidate_get',candidate_id:selection.candidate_id},ticket),
      api('workflow',{action:'patch_preview',...selection},ticket),
      api('native',{action:'list'},ticket),
    ]);
    if(!current(ticket))return;
    const candidate=candidateReply.candidate as Data,task=(executionState.tasks??[]).find((item:Data)=>item.id===selection.task_id),review=(executionState.reviews??[]).find((item:Data)=>item.id===selection.review_id);
    if(candidate.id!==selection.candidate_id||candidate.task_id!==selection.task_id||candidate.hash!==patch.candidate_hash||candidate.generation!==patch.candidate_generation||review?.candidate_hash!==candidate.hash||review?.decision!=='approved'||review?.review_identity!==candidateReply.review_identity)throw Error('stale_resource');
    const exactReference={kind:'candidate',id:candidate.id,generation:candidate.generation,hash:candidate.hash};
    const diffReply=await api('live',{action:'detail',reference:exactReference,comparison:'initial'},ticket);
    const diff=candidateDiffFromDetail(diffReply,{candidate_id:candidate.id,generation:candidate.generation,candidate_hash:candidate.hash});
    let verifiedPatch:Data|null=null;
    try {
      const listed=await api('workflow',{action:'patch_list'},ticket);
      const match=(listed.patches??[]).find((entry:Data)=>entry.review_id===review.id&&entry.status==='available'&&entry.verification_status==='verified');
      if(match){
        if(match.candidate_id!==candidate.id||match.candidate_hash!==candidate.hash||match.candidate_generation!==candidate.generation)throw Error('verified_patch_identity_inconsistent');
        const fetched=await api('workflow',{action:'private_patch_get',artifact_id:match.artifact_id},ticket),receipt=fetched.receipt;
        const verification=receipt?.verification,roundtrip=receipt?.roundtrip;
        if(receipt?.artifact_id!==match.artifact_id||receipt?.artifact_hash!==match.artifact_hash||receipt?.candidate_id!==candidate.id||receipt?.candidate_hash!==candidate.hash||receipt?.candidate_generation!==candidate.generation||receipt?.review_id!==review.id||receipt?.review_identity!==review.review_identity||verification?.status!=='verified'||verification?.artifact_hash!==receipt.artifact_hash||verification?.candidate_id!==candidate.id||verification?.candidate_hash!==candidate.hash||verification?.candidate_generation!==candidate.generation||verification?.review_id!==review.id||verification?.review_identity!==review.review_identity||roundtrip?.verified!==true||roundtrip?.unrelated_unchanged!==true||roundtrip?.base_identity!==patch.source?.manifest_hash||roundtrip?.result_identity!==candidate.hash)throw Error('verified_patch_identity_inconsistent');
        verifiedPatch=receipt;
      }
    }catch(reason){if(!current(ticket))return;verifiedPatch={inconsistent:true,reason:reason instanceof Error?reason.message:'unavailable'};}
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
    const complete=patch.review?.required_check_state?.complete===true&&patch.review.required_check_state.acceptance_digest===task?.acceptance_digest&&patch.review.required_check_state.required_checks_digest===task?.acceptance?.required_checks_digest&&candidateReply.acceptance_complete===true&&checks.length===requirements.length&&checks.length>0&&checks.every(item=>item.evidence),support=patch.verification_support as Data|undefined;
    const artifactChecksSupported=support?.ready===true&&support.candidate_hash===candidate.hash&&support.candidate_generation===candidate.generation&&support.acceptance_digest===task?.acceptance_digest;
    const passed=checks.filter(item=>item.evidence).length;
    const summary=el('section','workbench-review-summary');summary.setAttribute('aria-label','Review summary');
    summary.append(el('strong','workbench-review-task-title',task?.title??'Candidate review'),el('span','workbench-review-generation',`Candidate generation ${candidate.generation}`),el('span','workbench-review-check-count',`${passed}/${checks.length} required checks pass`),el('span','workbench-review-freshness',complete?'Current approved identity':'Stale or incomplete'));
    const metadata=el('details','workbench-review-metadata'),metadataSummary=el('summary','','Candidate, source, acceptance and evidence identities');
    metadata.append(metadataSummary,textField('Candidate ID',candidate.id),textField('Candidate SHA-256',candidate.hash),textField('Source snapshot SHA-256',patch.source?.manifest_hash),textField('Acceptance digest',task?.acceptance_digest),textField('Required-check digest',task?.acceptance?.required_checks_digest),textField('Review identity',review.review_identity),textField('Evidence IDs',candidateReply.review_evidence_ids??[]),textField('Verified patch-export support',artifactChecksSupported?support?.message??'Supported for this exact preview':support?.message??'Server support unavailable; refresh this review'),...(support?.required_checks??[]).filter((check:Data)=>!check.ready).map((check:Data)=>textField(`Check ${check.definition_id} · profile ${check.execution_profile_id??'default'}`,check.message)));summary.append(metadata);
    const left=el('section','workbench-review-diff');left.setAttribute('aria-label','Exact reviewed candidate diff');
    diffViewer?.dispose();diffViewer=createCandidateDiffViewer(diff,{title:`Initial candidate generation 1 → reviewed generation ${candidate.generation}`});
    left.append(el('h4','','Exact candidate diff'),diffViewer.element);
    if(!diff.available)left.append(el('p','workbench-review-diff-unavailable',`Exact retained generation comparison unavailable (${diff.reason??'unavailable'}). The current candidate is not substituted.`));
    const patchStatus=el('p','workbench-review-verified-patch',verifiedPatch?.inconsistent
      ?`Verified patch identity unavailable or inconsistent (${verifiedPatch.reason}). Do not infer no text difference.`
      :verifiedPatch
        ?`Server-verified patch round-trip · base ${verifiedPatch.roundtrip.base_identity} → candidate ${verifiedPatch.roundtrip.result_identity} · identities match, no manifest difference · artifact SHA-256 ${verifiedPatch.artifact_hash} · independent recorder verification. The candidate-generation comparison above is separate from Git base.`
         :'No server-verified patch artifact for this exact review. No patch equality is inferred.');
    if(verifiedPatch?.reason==='verified_patch_identity_inconsistent'){patchStatus.setAttribute('role','alert');patchStatus.classList.add('workbench-review-error');patchStatus.prepend(document.createTextNode('INCONSISTENCY · '));}
    left.append(patchStatus);
    const right=el('section','workbench-review-checks');right.setAttribute('aria-label','Frozen required checks and review evidence');right.append(el('h4','','Required checks and evidence'));
    for(const item of checks){const check=el('article','workbench-review-check');check.append(el('h5','',item.required.definition_id),el('strong',`workbench-review-verdict ${item.evidence?'is-pass':'is-pending'}`,item.evidence?item.evidence.evidence.verdict.toUpperCase():'PENDING'));const details=el('details'),summary=el('summary','','Check details');details.append(summary,textField('Profile',item.required.execution_profile_id??'Default trusted check profile'),textField('Job / evidence IDs',item.evidence?`${item.evidence.job.id} / ${item.evidence.evidence.id}`:'No exact evidence'));if(item.evidence){const raw=el('pre');raw.textContent=JSON.stringify(item.evidence.evidence.provenance??null,null,2);details.append(raw);}check.append(details);right.append(check);}
    const explanation=el('section','workbench-review-explanation');explanation.append(el('h4','','Worker explanation (not evidence)'));
    const recorded=checks.map(item=>item.evidence?.evidence?.test_results).filter((results:Data|undefined)=>results?.valid===true&&Number.isSafeInteger(results.tests)&&Number.isSafeInteger(results.passed)&&results.tests>=results.passed&&results.passed>=0&&Array.isArray(results.required_files)&&Array.isArray(results.covered_files));
    const recorder=el('p','workbench-review-recorder-counts',recorded.length?`Service-recorded checks · ${recorded.reduce((count:number,result:Data)=>count+result.passed,0)}/${recorded.reduce((count:number,result:Data)=>count+result.tests,0)} tests passed · ${recorded.reduce((count:number,result:Data)=>count+result.covered_files.filter((file:unknown)=>result.required_files.includes(file)).length,0)}/${recorded.reduce((count:number,result:Data)=>count+result.required_files.length,0)} required files covered`:'Service-recorded test/file counts unavailable');
    right.append(recorder);
    const matching=(grantList.grants??[]).filter((grant:Data)=>grant.candidate_id===candidate.id&&grant.project_generation===candidate.project_generation&&typeof grant.attempt_id==='string').sort((a:Data,b:Data)=>(b.created_at??0)-(a.created_at??0));
    let nativeResult:Data|null=null;
    if(matching[0])try{const result=(await api('native',{action:'status',grant_id:matching[0].id},ticket)).result??null;if(result?.attempt_id===matching[0].attempt_id&&result?.candidate_id===candidate.id&&result?.task_id===task?.id&&result?.project_generation===candidate.project_generation)nativeResult=result;}catch{}
    if(!current(ticket))return;
    if(nativeResult){const exact=nativeResult.candidate_hash===candidate.hash&&nativeResult.candidate_generation===candidate.generation&&nativeResult.project_generation===candidate.project_generation,details=el('details'),summary=el('summary','','Expand literal Hermes explanation');summary.setAttribute('aria-label','Expand literal Hermes explanation');const content=el('pre','workbench-review-explanation-text');content.textContent=typeof nativeResult.text==='string'?nativeResult.text:'No explanation text was recorded.';details.append(summary,textField('Availability',nativeResult.availability),textField('Candidate binding',exact?'Exact current candidate version':'Historical/different candidate version'),content);explanation.append(textField('Attempt',matching[0].id),details);}
    else explanation.append(el('p','','No recorded worker explanation is available for this candidate. Explanations and model claims never substitute for check evidence.'));
    const human=el('section','workbench-review-owner');human.append(el('h4','','Human review'),textField('Decision',review.decision),textField('Review identity',review.review_identity),textField('Reviewed evidence IDs',review.evidence_ids??[]),textField('Freshness',complete?'Approved identity and all current required checks match.':'Review/evidence must be refreshed before relying on this view.'));
    view.replaceChildren(summary,left,right,explanation,human);
    status.textContent=`Review ready · ${passed}/${checks.length} required checks pass · artifact verification ${artifactChecksSupported?'supported':'unavailable for this preview'}.`;
  }
  async function refresh(){
    if(closed)return;const {ticket}=next();error.textContent='';status.textContent='Loading exact candidate reviews…';
    clearDiff();view.replaceChildren();
    try{
      executionState=await api('execution',{action:'execution_state'},ticket);if(!current(ticket))return;
      const approved=(executionState.reviews??[]).filter((review:Data)=>review.decision==='approved').map((review:Data)=>({review,candidate:(executionState.candidates??[]).find((entry:Data)=>entry.id===review.candidate_id)})).filter((pair:{review:Data;candidate:Data|undefined}):pair is {review:Data;candidate:Data}=>!!pair.candidate);
      const previous=selectedKey;candidates.replaceChildren();
      for(const pair of approved){const task=(executionState.tasks??[]).find((item:Data)=>item.id===pair.candidate.task_id),value=JSON.stringify({candidate_id:pair.candidate.id,review_id:pair.review.id,task_id:pair.candidate.task_id}),option=el('option','',`${task?.title??'Task'} · ${pair.candidate.hash===pair.review.candidate_hash?`gen ${pair.candidate.generation}`:'historical approval'}`);option.title=`Candidate ${pair.candidate.id} · review ${pair.review.id}`;option.value=value;candidates.append(option);}
      if(Array.from(candidates.options).some(option=>option.value===previous))candidates.value=previous;selectedKey=candidates.value;
      if(!selectedKey){view.replaceChildren(el('p','','No approved candidate review is available.'));status.textContent='No approved candidate review.';return;}
      await renderSelected(ticket);
    }catch(reason){if(current(ticket)&&!(reason instanceof Error&&reason.name==='AbortError')){diffViewer?.dispose();diffViewer=null;view.replaceChildren();error.textContent=`Could not load exact candidate review: ${reason instanceof Error?reason.message:'unavailable'}. Refresh before relying on prior evidence.`;status.textContent='Candidate review unavailable.';}}
  }
  candidates.addEventListener('change',()=>{selectedKey=candidates.value;void refresh();});
  const refreshButton=button('Refresh exact candidate review','Revalidate candidate, frozen checks, review, and worker explanation',()=>void refresh());
  const panel=el('div','workbench-review-panel');panel.append(el('h3','','Candidate review'),status,error,candidates,refreshButton,view);
  body.replaceChildren(panel);
  void refresh();
  return {refresh,dispose(){closed=true;generation++;controller?.abort();controller=null;diffViewer?.dispose();diffViewer=null;view.replaceChildren();body.replaceChildren();}};
}
