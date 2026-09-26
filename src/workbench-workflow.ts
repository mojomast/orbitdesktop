import {button, el} from './dom';

type Reply = Record<string, unknown>;
type Preview = {preview_id:string;preview_digest:string;expires_at:number};
type PatchPreview = Preview & {patch_text:string;artifact_hash:string;bytes:number};
export function mountWorkbenchWorkflow(args:{container:HTMLElement;token:string|(()=>string);workspace_id:string;project_id:string;candidate?:()=>{id:string;review_id:string}|null;onError?:(message:string)=>void}):{refresh():Promise<void>;dispose():void}{
  const status=el('p','','Workflow: loading…');status.setAttribute('role','status');
  const error=el('p');error.setAttribute('role','alert');
  const integration=el('section'),patch=el('section'),recipes=el('section'),retention=el('section');
  const candidateSelect=el('select');candidateSelect.setAttribute('aria-label','Approved candidate and review');
  const previewView=el('div'),patchView=el('div'),recipeView=el('div'),patchInventory=el('div','workbench-patch-inventory');
  let integrationPreview:Preview|null=null,recipePreview:Preview|null=null,recipeName:'project_focus'|'investigate'|'implement'|'review'|'return'='project_focus';
  let patchPreview:PatchPreview|null=null,patchArtifactId='',patchRecords:Reply[]=[],patchAfterId:string|null=null,patchBefore:(string|null)[]=[],patchList:Reply={};
  const savedPatch=el('select');savedPatch.setAttribute('aria-label','Saved private patch artifact');
  const terminated=el('input');terminated.type='checkbox';terminated.setAttribute('aria-label','I independently confirmed the patch verifier has terminated');
  let integrationOperation='';
  let closed=false,busy=false,epoch=0,refreshGeneration=0,patchPollTimer:ReturnType<typeof setTimeout>|null=null;const controllers=new Set<AbortController>();
  const field=(name:string,value:unknown)=>el('p','',`${name}: ${typeof value==='string'?value:JSON.stringify(value??null)}`);
  const report=(text:string)=>{error.textContent=text;if(text)args.onError?.(text);};
  function cancel(){epoch++;for(const controller of controllers)controller.abort();controllers.clear();}
  async function request(body:Reply,ticket:number):Promise<Reply|null>{
    const controller=new AbortController();controllers.add(controller);
    try{
      const token=typeof args.token==='function'?args.token():args.token;
      if(!token)throw Error('permission_denied');
      const response=await fetch('/api/workbench/workflow',{method:'POST',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},body:JSON.stringify({workspace_id:args.workspace_id,project_id:args.project_id,...body}),signal:controller.signal});
      const data=await response.json() as Reply;
      if(closed||ticket!==epoch)return null;
      if(!response.ok||data.ok!==true)throw Error(typeof data.code==='string'?data.code:'unavailable');
      return data;
    }catch(reason){if(!closed&&ticket===epoch&&!(reason instanceof Error&&reason.name==='AbortError'))report(`Workflow: ${reason instanceof Error&&/^[a-z_]+$/.test(reason.message)?reason.message:'unavailable'}. Refresh and preview again.`);return null;}
    finally{controllers.delete(controller);}
  }
  async function requestIndependent(body:Reply):Promise<Reply|null>{
    const controller=new AbortController();controllers.add(controller);const bearer=typeof args.token==='function'?args.token():args.token;
    try{
      if(!bearer)throw Error('permission_denied');
      const response=await fetch('/api/workbench/workflow',{method:'POST',headers:{Authorization:`Bearer ${bearer}`,'Content-Type':'application/json'},body:JSON.stringify({workspace_id:args.workspace_id,project_id:args.project_id,...body}),signal:controller.signal});
      const data=await response.json() as Reply;if(closed||bearer!==(typeof args.token==='function'?args.token():args.token))return null;
      if(!response.ok||data.ok!==true)throw Error(typeof data.code==='string'?data.code:'unavailable');return data;
    }catch(reason){if(!closed&&!(reason instanceof Error&&reason.name==='AbortError'))report(`Workflow: ${reason instanceof Error&&/^[a-z_]+$/.test(reason.message)?reason.message:'unavailable'}. Refresh and preview again.`);return null;}
    finally{controllers.delete(controller);}
  }
  async function act(label:string,body:Reply,render:(reply:Reply)=>void){
    if(closed||busy)return;busy=true;report('');const ticket=++epoch;status.textContent=`${label}…`;
    try{const reply=await request(body,ticket);if(reply){render(reply);status.textContent=`${label} complete.`;}}finally{busy=false;}
  }
  const previewIntegration=button('Preview private integration','Preview an exact reviewed candidate in a separate private Git repository',()=>{
    const [candidate_id,review_id]=candidateSelect.value.split(':');if(!candidate_id||!review_id)return;
    void act('Integration preview',{action:'integration_preview',candidate_id,review_id},reply=>{
      integrationPreview=reply as Preview;
      integrationOperation=crypto.randomUUID();
      previewView.replaceChildren(field('Private artifact kind',reply.artifact_kind),field('Warning',reply.warning),field('Source hash',reply.source_hash),field('Candidate hash',reply.candidate_hash),field('Source files',reply.source_files),field('Candidate files',reply.files),field('Excluded paths',reply.excluded_paths),field('Preview digest',reply.preview_digest),field('Expires at',reply.expires_at));
      confirmIntegration.disabled=false;
    });
  });
  const confirmIntegration=button('Create private integration branch','Confirm exactly the previewed approved candidate',()=>{
    if(!integrationPreview)return;
    const [candidate_id,review_id]=candidateSelect.value.split(':');
    void act('Integrating reviewed candidate',{action:'integrate_confirm',candidate_id,review_id,preview_id:integrationPreview.preview_id,preview_digest:integrationPreview.preview_digest,op_id:integrationOperation},reply=>{
      integrationPreview=null;confirmIntegration.disabled=true;
      const record=reply.integration as Reply;
      previewView.replaceChildren(field('Status',record.status),field('Private repository',record.artifact_path),field('Branch',record.branch),field('Base commit',record.base_commit),field('Candidate commit',record.candidate_commit),field('Independent history','This branch has its own captured-source base; it does not share history with the original.'));
      void refresh();
    });
  });confirmIntegration.disabled=true;
  const previewPatch=button('Preview reviewed patch','Build and verify an exact private patch for this reviewed candidate',()=>{
    const [candidate_id,review_id,task_id]=candidateSelect.value.split(':');if(!candidate_id||!review_id||!task_id)return;
    void act('Reviewed patch preview',{action:'patch_preview',task_id,candidate_id,review_id},reply=>{
       patchPreview=reply as PatchPreview;patchArtifactId='';
       const exact=el('pre','workbench-patch-preview-text',patchPreview.patch_text);exact.setAttribute('aria-label','Exact unified diff bytes proposed for verified patch export');
       patchView.replaceChildren(field('Format',reply.format),field('Source identity',reply.source),field('Candidate identity',reply.candidate),field('Reviewed checks and evidence',reply.review),field('Exact changes',reply.changes),field('Exclusions (not deletions)',reply.exclusions),field('Unsupported changes',reply.unsupported),field('Round-trip verification',reply.roundtrip),field('Patch bytes / SHA-256',`${reply.bytes} / ${reply.artifact_hash}`),field('Preview digest',reply.preview_digest),el('h4','','Exact patch bytes to be confirmed'),exact);
      confirmPatch.disabled=false;
    });
  });
  const confirmPatch=button('Create private verified patch','Persist the exact previewed patch in the private authenticated artifact store',()=>{
    if(!patchPreview)return;const [candidate_id,review_id,task_id]=candidateSelect.value.split(':');if(!candidate_id||!review_id||!task_id)return;
    const op_id=crypto.randomUUID();void act('Exporting verified patch',{action:'patch_export',task_id,candidate_id,review_id,preview_id:patchPreview.preview_id,preview_digest:patchPreview.preview_digest,op_id},reply=>{
      const record=reply.patch as Reply;patchArtifactId=String(record.artifact_id??record.id??'');patchPreview=null;confirmPatch.disabled=true;
       patchView.replaceChildren(field('Status',record.status),field('Private artifact ID',patchArtifactId),field('SHA-256 / bytes',`${record.artifact_hash} / ${record.bytes}`),field('Round-trip verification',record.roundtrip),field('Required-check verification',record.verification),field('File changes',record.changes));downloadPatch.disabled=!patchArtifactId||record.status!=='available';void refresh();
    });
    startPatchIntentPolling(op_id);
  });confirmPatch.disabled=true;
  const downloadPatch=button('Retrieve private patch','Fetch only this verified artifact through owner-authenticated Workbench API',()=>{
    if(!patchArtifactId)return;void act('Retrieving verified patch',{action:'private_patch_get',artifact_id:patchArtifactId},reply=>{
      const content=typeof reply.patch==='string'?reply.patch:'';
      if(!content){report('Private patch is unavailable; no partial file was downloaded.');return;}
      const url=URL.createObjectURL(new Blob([content],{type:'text/x-diff;charset=utf-8'})),anchor=el('a','','Download verified patch');anchor.href=url;anchor.download=`workbench-${patchArtifactId}.patch`;anchor.click();setTimeout(()=>URL.revokeObjectURL(url),0);status.textContent='Downloaded the exact verified private patch. Original files were not changed.';
    });
  });downloadPatch.disabled=true;
  const finalizePatch=button('Finalize recorded patch checks','Finalize only the durable observed check journal; never rerun checks',()=>{
    const item=patchRecords.find((record:Reply)=>String(record.artifact_id??record.id)===savedPatch.value),recovery=item?.recovery as Reply|undefined;if(!item||typeof recovery?.recovery_digest!=='string')return;
    void requestIndependent({action:'patch_finalize_retry',artifact_id:savedPatch.value,expected_digest:recovery.recovery_digest}).then(reply=>{if(!reply)return;const result=reply.patch as Reply;patchView.replaceChildren(field('Status',result.status),field('Durable verification',result.verification));void refresh();});
  });finalizePatch.disabled=true;
  const cancelPatchCheck=button('Request patch-check cancellation','Request termination of the recorded verifier process; this does not claim it stopped',()=>{
    if(!savedPatch.value)return;void requestIndependent({action:'patch_check_cancel',artifact_id:savedPatch.value}).then(reply=>{if(!reply)return;patchView.replaceChildren(field('Cancellation request',reply.cancellation),field('Status','Termination is not confirmed until the recorder observes process exit.'));void refresh();});
  });cancelPatchCheck.disabled=true;
  const acknowledgePatchUnknown=button('Acknowledge unknown patch-check outcome','Release quarantine only after independently confirming verifier termination',()=>{
    const item=patchRecords.find((record:Reply)=>String(record.artifact_id??record.id)===savedPatch.value),recovery=item?.recovery as Reply|undefined;if(!item||!terminated.checked||typeof recovery?.recovery_digest!=='string')return;
    void requestIndependent({action:'patch_acknowledge_unknown',artifact_id:savedPatch.value,expected_digest:recovery.recovery_digest,known_externally_terminated:true}).then(reply=>{if(!reply)return;terminated.checked=false;const result=reply.patch as Reply;patchView.replaceChildren(field('Status',result.status),field('Verification',result.verification));void refresh();});
  });acknowledgePatchUnknown.disabled=true;
  const olderPatchPage=button('Show older patch receipts','Load the next older bounded patch receipt page',()=>{
    const cursor=patchList.next_after_id;if(typeof cursor!=='string')return;patchBefore.push(patchAfterId);patchAfterId=cursor;void loadPatchPage();
  });olderPatchPage.disabled=true;
  const newerPatchPage=button('Show newer patch receipts','Return to the preceding newer bounded patch receipt page',()=>{
    if(!patchBefore.length)return;patchAfterId=patchBefore.pop()??null;void loadPatchPage();
  });newerPatchPage.disabled=true;
  const refreshPatchReceipts=button('Refresh patch receipts','Refresh persisted receipt and verifier recovery state without waiting for other workflow operations',()=>void loadPatchPage());
  function showSelectedPatch(){
    const item=patchRecords.find((record:Reply)=>String(record.artifact_id??record.id)===savedPatch.value);patchArtifactId=savedPatch.value;
    downloadPatch.disabled=!item||item.status!=='available';const recovery=item?.recovery as Reply|undefined;
    finalizePatch.disabled=!item||!['verified','verification_pending'].includes(String(item.status))||item.status==='verification_pending'&&recovery?.recoverable!==true||typeof recovery?.recovery_digest!=='string';
    cancelPatchCheck.disabled=!item||item.status!=='verifying'||recovery?.process_owned!==true;
    acknowledgePatchUnknown.disabled=!item||!['verifying','outcome_unknown'].includes(String(item.status))||recovery?.process_owned===true||recovery?.recoverable===true||!terminated.checked;
     patchView.replaceChildren();if(!item){patchView.append(el('p','','No saved private patch artifacts on this bounded newest-first page.'));return;}
     patchView.append(field('Status',item.status),field('Artifact ID',item.artifact_id??item.id),field('Task / candidate / review',`${item.task_id} / ${item.candidate_id} / ${item.review_id}`),field('Candidate SHA-256 / generation',`${item.candidate_hash} / ${item.candidate_generation}`),field('Artifact SHA-256 / bytes',`${item.artifact_hash} / ${item.bytes}`),field('Verification state',item.verification_status),field('Recovery state',recovery));
    if(item.status==='verification_failed')patchView.append(el('p','','This patch did not pass all frozen required checks or has an inconclusive/acknowledged outcome. It cannot be downloaded.'));
  }
  terminated.addEventListener('change',showSelectedPatch);
  savedPatch.addEventListener('change',showSelectedPatch);
  function installPatchList(reply:Reply,preferArtifactId?:string){
    patchList=reply;patchRecords=(reply.patches??[]) as Reply[];const selected=preferArtifactId??savedPatch.value;savedPatch.replaceChildren();
    for(const record of patchRecords){const id=String(record.artifact_id??record.id),option=el('option','',`${record.created_at??''} · ${record.task_id} · ${record.status} · ${id}`);option.value=id;savedPatch.append(option);}
    if(patchRecords.some((record:Reply)=>String(record.artifact_id??record.id)===selected))savedPatch.value=selected;else if(patchRecords.length)savedPatch.selectedIndex=0;
    olderPatchPage.disabled=reply.truncated!==true||typeof reply.next_after_id!=='string';newerPatchPage.disabled=!patchBefore.length;
    const listNotice=el('p','',reply.truncated===true?`Showing ${patchRecords.length} receipts from ${reply.total_count} total; older receipts are available on the next page.`:`Showing ${patchRecords.length} receipts on this page.`);
    const terminationLabel=el('label');terminationLabel.append(el('span','','I independently confirmed the patch verifier has terminated '),terminated);
    showSelectedPatch();patchInventory.replaceChildren(el('h4','','Persisted private patch receipts'),listNotice,refreshPatchReceipts,newerPatchPage,olderPatchPage,savedPatch,downloadPatch,finalizePatch,cancelPatchCheck,terminationLabel,acknowledgePatchUnknown,patchView);
  }
  async function loadPatchPage(preferArtifactId?:string){
    const reply=await requestIndependent({action:'patch_list',...(patchAfterId?{after_id:patchAfterId}:{})});if(reply&&!closed)installPatchList(reply,preferArtifactId);
  }
  function startPatchIntentPolling(opId:string){
    if(patchPollTimer)clearTimeout(patchPollTimer);
    let stopped=false,attempts=0;
    const poll=async()=>{
      if(closed||stopped||attempts++>=180)return;
      const reply=await requestIndependent({action:'patch_list',op_id:opId});
      if(reply&&!closed){
        const item=(reply.patches as Reply[]|undefined)?.[0],id=String(item?.artifact_id??'');
        if(item&&id){patchAfterId=null;patchBefore=[];await loadPatchPage(id);}
        if(item&&['available','verification_failed','preparation_failed'].includes(String(item.status))){stopped=true;patchPollTimer=null;return;}
      }
      if(!closed&&!stopped)patchPollTimer=setTimeout(()=>void poll(),500);
    };
    patchPollTimer=setTimeout(()=>void poll(),100);
  }
  function previewRecipe(recipe:'project_focus'|'investigate'|'implement'|'review'|'return'){
    const host=document.querySelector<HTMLElement>('.desktop-host'),measurement=recipe==='review'?{width:host?.clientWidth??0,height:host?.clientHeight??0}:{};
    void act('Recipe preview',{action:'recipe_preview',recipe,...measurement},reply=>{
      recipeName=recipe;recipePreview=reply as Preview;
      recipeView.replaceChildren(field('Recipe',recipe),field('Base revision',reply.base_revision),field('Operations',reply.operations),field('Changed',reply.changed),field('Continuity',reply.warning));applyRecipe.disabled=false;
    });
  }
  const applyRecipe=button('Apply previewed arrangement','Apply with exact workspace revision and saved pane IDs',()=>{
    if(!recipePreview)return;
    void act('Applying recipe',{action:'recipe_apply',recipe:recipeName,preview_id:recipePreview.preview_id,preview_digest:recipePreview.preview_digest,op_id:crypto.randomUUID()},reply=>{
      recipePreview=null;applyRecipe.disabled=true;recipeView.replaceChildren(field('Committed workspace revision',(reply.workspace as Reply)?.revision),field('Browser acknowledgement','Pending; inspect connected workspace before claiming visibility.'));
    });
  });applyRecipe.disabled=true;
  const openReview=button('Open trusted Review view','Open the owner-bound candidate review pane for this project',()=>{
    window.dispatchEvent(new CustomEvent('orbit-open-workbench-review',{detail:{workspace_id:args.workspace_id,project_id:args.project_id}}));
  });
  candidateSelect.addEventListener('change',()=>{integrationPreview=null;confirmIntegration.disabled=true;previewView.replaceChildren();patchPreview=null;patchArtifactId='';confirmPatch.disabled=true;downloadPatch.disabled=true;patchView.replaceChildren();});
  integration.append(el('h3','','Private Git integration'),candidateSelect,previewIntegration,previewView,confirmIntegration);
   patch.append(el('h3','','Verified patch handoff'),el('p','','Exports only the reviewed captured source-to-candidate change. Excluded paths are never inferred as deletions. A disposable exact-base round trip and all frozen required checks are required; unsupported or oversized artifacts are refused.'),previewPatch,patchView,confirmPatch,patchInventory);
  recipes.append(el('h3','','Workspace arrangements'),openReview,button('Preview Investigate','Preview Investigate arrangement',()=>previewRecipe('investigate')),button('Preview Implement','Preview Implement arrangement',()=>previewRecipe('implement')),button('Preview Review','Preview Review arrangement',()=>previewRecipe('review')),button('Preview return','Restore the previously saved Review arrangement',()=>previewRecipe('return')),recipeView,applyRecipe);
  retention.append(el('h3','','Retention inventory'));
  args.container.replaceChildren(el('h2','','Workflow'),status,error,integration,patch,recipes,retention);
  async function refresh(){
    if(closed)return;const ticket=++refreshGeneration;
    const [state,inventory,patches]=await Promise.all([
      requestIndependent({action:'integration_list'}),requestIndependent({action:'retention_plan'}),requestIndependent({action:'patch_list',...(patchAfterId?{after_id:patchAfterId}:{})}),
    ]);
    if(!state||!inventory||!patches||closed||ticket!==refreshGeneration)return;
    const bearer=typeof args.token==='function'?args.token():args.token,controller=new AbortController();controllers.add(controller);let executionState:Reply|null=null;
    try{const response=await fetch('/api/workbench/execution',{method:'POST',headers:{Authorization:`Bearer ${bearer}`,'Content-Type':'application/json'},body:JSON.stringify({action:'execution_state',workspace_id:args.workspace_id,project_id:args.project_id}),signal:controller.signal});const value=await response.json() as Reply;if(response.ok&&bearer===(typeof args.token==='function'?args.token():args.token))executionState=value;}catch{}finally{controllers.delete(controller);}
    if(closed||ticket!==refreshGeneration)return;
    const reviews=executionState?.reviews as {id:string;candidate_id:string;task_id:string;decision:string}[]|undefined;
    const selected=candidateSelect.value;
    candidateSelect.replaceChildren();
    for(const review of reviews??[])if(review.decision==='approved'){const option=el('option','',`${review.candidate_id} · review ${review.id}`);option.value=`${review.candidate_id}:${review.id}:${review.task_id}`;candidateSelect.append(option);}
    const preferred=args.candidate?.();candidateSelect.value=selected||`${preferred?.id??''}:${preferred?.review_id??''}`;
     if(!candidateSelect.value&&candidateSelect.options.length)candidateSelect.selectedIndex=0;
     previewIntegration.disabled=!candidateSelect.value;
    installPatchList(patches);
     retention.replaceChildren(el('h3','','Retention inventory'),field('Private record counts',inventory.counts),field('Private integration artifacts',state.integrations),field('Cleanup plan',inventory.reason),field('Deletions',inventory.deletions));
    if(!busy)status.textContent='Workflow ready. Actions require explicit preview and confirmation.';
  }
  void refresh();
  return {refresh,dispose(){closed=true;if(patchPollTimer)clearTimeout(patchPollTimer);cancel();args.container.replaceChildren();}};
}
