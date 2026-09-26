import {button,el} from './dom';

type Json=Record<string,any>;
type Args={container:HTMLElement;token:string|(()=>string);workspace_id:string;project_id:string;onChanged?:()=>void;onOpenEvidence?:(reference:{evidence_id:string;job_id:string})=>void;onOpenCandidate?:(reference:{candidate_id:string;candidate_hash:string;generation:number})=>void};

/** Owner-facing view of the durable native result; explanation is always literal text. */
export function mountWorkbenchTaskResult(args:Args):{refresh():Promise<void>;dispose():void}{
  let disposed=false,busy=false,selectedGrant='',selectedResult='';
  const status=el('p','workbench-result-status','Task results: loading…');status.setAttribute('role','status');
  const error=el('p','workbench-result-error');error.setAttribute('role','alert');
  const grants=el('select','workbench-result-grants'),results=el('select','workbench-result-results');
  grants.setAttribute('aria-label','Native task attempt');results.setAttribute('aria-label','Recorded task result');
  const view=el('section','workbench-task-result');
  const field=(label:string,value:unknown)=>{const row=el('p','workbench-result-field');const name=el('strong','',`${label}: `),content=el('span');content.textContent=typeof value==='string'?value:JSON.stringify(value??null);row.append(name,content);return row;};
  const api=async(endpoint:string,body:Json)=>{const token=typeof args.token==='function'?args.token():args.token;if(!token)throw Error('permission_denied');const response=await fetch(`/api/workbench/${endpoint}`,{method:'POST',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},body:JSON.stringify({workspace_id:args.workspace_id,project_id:args.project_id,...body})});const data=await response.json();if(!response.ok||data.ok!==true)throw Error(typeof data.code==='string'?data.code:'unavailable');return data;};
  const provenance=(value:Json)=>{
    const p=value??{};
    const result=el('div','workbench-result-provenance');result.append(field('Initiated by',p.initiated_by),field('Authorized by',p.authorized_by),field('Recorded by',p.recorded_by));return result;
  };
  async function refresh(){
    if(disposed||busy)return;status.textContent='Loading task results…';error.textContent='';
    try{
      const data=await api('native',{action:'list'});if(disposed)return;
      const old=grants.value;grants.replaceChildren();
      for(const grant of data.grants??[]){const option=el('option','',`${grant.id} · ${grant.status} · candidate ${grant.candidate_id}`);option.value=grant.id;grants.append(option);}
      if((data.grants??[]).some((g:Json)=>g.id===old))grants.value=old;
      selectedGrant=grants.value;
      if(!selectedGrant){results.replaceChildren();view.replaceChildren(el('p','','No native task attempts are recorded for this project.'));status.textContent='Task results ready.';return;}
      const response=await api('native',{action:'status',grant_id:selectedGrant});if(disposed)return;
      const result=response.result as Json|null;
      results.replaceChildren();
      if(result){const option=el('option','',`${result.id} · ${result.availability}${result.unavailable_reason?` (${result.unavailable_reason})`:''}`);option.value=result.id;results.append(option);selectedResult=result.id;render(result);}
      else{selectedResult='';view.replaceChildren(el('p','','No durable result is available yet. Refresh status to read; execution is never retried by refresh.'));}
      status.textContent=`Attempt status: ${response.grant?.status??'unknown'}. Result ${result?.availability??'pending or not yet recorded'}.`;
    }catch(reason){if(!disposed){error.textContent=`Could not read task result: ${reason instanceof Error?reason.message:'unavailable'}. Refresh to try again; execution will not be replayed.`;status.textContent='Task result unavailable.';}}
  }
  function render(result:Json){
    const sections:HTMLElement[]=[];
    const explanation=el('section','workbench-result-explanation');explanation.append(el('h4','','Agent explanation'));
    const availability=result.availability==='available'?'Available':`Unavailable (${result.unavailable_reason??result.availability})`;
    explanation.append(field('Availability',availability),field('Hermes completed',result.hermes_completed));
    const text=el('pre','workbench-result-text');text.textContent=typeof result.text==='string'?result.text:'No explanation text was recorded.';explanation.append(text);sections.push(explanation);
    const evidence=el('section','workbench-result-evidence');evidence.append(el('h4','','Recorded checks'));
    const refs=Array.isArray(result.resolved_references)?result.resolved_references:[];
    if(refs.length){for(const ref of refs){const item=el('div','workbench-result-field'),open=button('Open exact recorded evidence',`Open evidence ${ref.evidence_id}`,()=>args.onOpenEvidence?.({evidence_id:ref.evidence_id,job_id:ref.job_id}));open.disabled=!args.onOpenEvidence;item.append(field(`${ref.verdict} · evidence ${ref.evidence_id}`,`Job ${ref.job_id}`),open);evidence.append(item);}}
    else evidence.append(el('p','','No server-resolved evidence references in this explanation. Check results and required-check completeness are shown in the execution panel; explanation claims are not evidence.'));
    if(Array.isArray(result.model_suggested_references)&&result.model_suggested_references.length)evidence.append(field('Unverified references (not linked)',result.model_suggested_references));
    sections.push(evidence);
    const provenanceSection=el('section','workbench-result-human-review'),openCandidate=button('Open exact candidate version','Open the exact candidate generation and hash',()=>args.onOpenCandidate?.({candidate_id:result.candidate_id,candidate_hash:result.candidate_hash,generation:result.candidate_generation}));openCandidate.disabled=!args.onOpenCandidate;provenanceSection.append(el('h4','','Human review'),field('Candidate',`${result.candidate_id} · generation ${result.candidate_generation}`),field('Exact candidate hash',result.candidate_hash),field('Task / attempt',`${result.task_id} / ${result.attempt_id}`),openCandidate,field('Result recorded',result.received_at?new Date(result.received_at).toISOString():'not recorded'),field('Retention until',result.retained_until?new Date(result.retained_until).toISOString():'unknown'));
    if(result.provenance)provenanceSection.append(el('h4','','Check provenance'),provenance(result.provenance));
    const deliver=button('Return result to originating conversation','Create a host-authored result card; this does not send content to a model',()=>void deliverResult(result));
    deliver.disabled=result.availability!=='available';provenanceSection.append(el('p','','Review and accept/reject the exact candidate separately in the execution panel. This result does not establish verification.'),deliver);sections.push(provenanceSection);
    view.replaceChildren(...sections);
  }
  async function deliverResult(result:Json){
    if(busy||disposed)return;busy=true;status.textContent='Returning result to its original conversation…';error.textContent='';
    try{const recipient=result.recipient;if(!recipient?.pane_id||!recipient?.profile_id||!recipient?.session_id)throw Error('unavailable');const receipt=await api('native',{action:'result_deliver',result_id:result.id,pane_id:recipient.pane_id,profile_id:recipient.profile_id,session_id:recipient.session_id,op_id:crypto.randomUUID()});if(disposed)return;status.textContent='Host-authored result card recorded for the originating conversation. No model request was sent.';view.append(field('Card receipt',receipt.card?.id??receipt.id??'recorded'));args.onChanged?.();}
    catch(reason){if(!disposed){error.textContent=`Result was not delivered: ${reason instanceof Error?reason.message:'unavailable'}. Refresh and review the current recipient binding.`;status.textContent='Result delivery unavailable.';}}
    finally{busy=false;}
  }
  grants.addEventListener('change',()=>{selectedGrant=grants.value;void refresh();});
  const refreshButton=button('Refresh task result','Read durable status and result without retrying the native run',()=>void refresh());
  args.container.replaceChildren(el('h3','','Task result'),status,error,grants,refreshButton,results,view);
  void refresh();
  return {refresh,dispose(){disposed=true;args.container.replaceChildren();}};
}
