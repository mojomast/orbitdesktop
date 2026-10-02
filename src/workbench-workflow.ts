import {button, el} from './dom';
import {captureLayout,type SavedLayout} from './layout-presets';
import type {Workspace} from './model';
import './workbench-arrangements.css';

type Reply = Record<string, unknown>;
type Preview = {preview_id:string;preview_digest:string;expires_at:number};
type Recipe = 'project_focus'|'investigate'|'implement'|'review'|'return';
type SavedRecipe = {id:string;version:number;name:string;roles:string[];layout:'prioritize'|'columns'|'rows';renderer:'windows'|'spatial'|'docking';project_id?:string};
type Binding = {id:string;role:string;pane_id:string;resource_id:string};
type RecipePreview = Preview & {base_revision:number;changed:boolean;operations:unknown[];warning:string;semantic_diff?:{kind:string;summary:string;window_id?:string}[];renderer?:string;viewport?:{width:number;height:number};unbound?:string[];geometry?:string};
type PatchPreview = Preview & {patch_text:string;artifact_hash:string;bytes:number};
type VerificationSupport={ready:boolean;reason:string|null;message:string;candidate_hash:string;candidate_generation:number;acceptance_digest:string;required_checks:{definition_id:string;execution_profile_id:string|null;ready:boolean;reason:string|null;message:string}[]};
export function mountWorkbenchWorkflow(args:{container:HTMLElement;arrangementContainer?:HTMLElement;token:string|(()=>string);workspace_id:string;project_id:string;candidate?:()=>{id:string;review_id:string}|null;onError?:(message:string)=>void}):{refresh():Promise<void>;dispose():void}{
  const status=el('p','','Workflow: loading…');status.setAttribute('role','status');
  const error=el('p');error.setAttribute('role','alert');
  const integration=el('section'),patch=el('section'),recipes=el('section'),retention=el('section');
  const candidateSelect=el('select');candidateSelect.setAttribute('aria-label','Approved candidate and review');
  const previewView=el('div'),patchView=el('div'),recipeView=el('div'),patchInventory=el('div','workbench-patch-inventory');
  const integrationReceipts=el('div','workbench-integration-receipts'),integrationRecovery=el('p');integrationRecovery.setAttribute('role','status');
  function showIntegrationReceipts(records:Reply[]){
    integrationReceipts.replaceChildren(el('h4','','Saved integration receipts'));
    for(const record of records){
      const row=el('article');row.dataset.integrationId=String(record.id);
      row.append(field('Integration',record.id),field('Status',record.status));
      if(record.status==='integrated')row.append(field('Recorded candidate commit',record.candidate_commit),el('p','','Private publication recorded. This does not apply changes to the original project or authorize execution.'));
      if(record.status==='receipt_pending'){
        row.append(el('p','','Publication outcome needs verification. Finalization verifies the retained artifact and records historical metadata only; it never republishes or reruns checks.'));
        if(typeof record.recovery_digest==='string'){
          const digest=record.recovery_digest,id=String(record.id);
          const finalize=button('Finalize integration receipt','Verify this exact retained publication and update only its database receipt',()=>{
            finalize.disabled=true;integrationRecovery.textContent='Verifying retained artifact; no publication is being repeated…';
            void requestIndependent({action:'integration_finalize_retry',integration_id:id,expected_recovery_digest:digest}).then(reply=>{
              if(closed)return;
              if(reply){integrationRecovery.textContent=`Historical receipt ${reply.status}${reply.idempotent?' (already finalized)':''}. Commit ${reply.candidate_commit}. No artifact was republished; no execution was authorized.`;void refresh();}
              else{report('Integration receipt not finalized. Refresh retained receipts; do not republish.');integrationRecovery.textContent='Finalization unconfirmed or refused. Refresh receipts and inspect the retained artifact. Missing or tampered artifacts stay fenced; do not create another integration to retry.';finalize.disabled=false;}
            });
          });row.append(field('Exact recovery digest',digest),finalize);
        }else row.append(el('p','','No recoverable publication manifest is recorded. Retain the artifact for inspection; finalization cannot guess its identity.'));
      }
      integrationReceipts.append(row);
    }
    if(!records.length)integrationReceipts.append(el('p','','No saved integrations.'));
  }
  let integrationPreview:Preview|null=null,recipePreview:RecipePreview|null=null,recipeName:Recipe='investigate';
  let savedRecipes:SavedRecipe[]=[],bindings:Binding[]=[],proposalRows:Reply[]=[],selectedSavedId='',recipeListGeneration=0,recipeOperationId='',previewSurface='',recovered=false,proposalAfter:string|null=null,proposalNext:string|null=null,proposalTotal=0;
  const proposalBefore:(string|null)[]=[];
  let saveIntent:{body:Reply;fingerprint:string}|null=null,roleOrder:string[]=[];
  let stagedImport:{layoutId:string;digest:string;roles:string[]}|null=null;
  let patchPreview:PatchPreview|null=null,patchArtifactId='',patchRecords:Reply[]=[],patchAfterId:string|null=null,patchBefore:(string|null)[]=[],patchList:Reply={};
  let historicalView=false;
  const savedPatch=el('select');savedPatch.setAttribute('aria-label','Saved private patch artifact');
  const terminated=el('input');terminated.type='checkbox';terminated.setAttribute('aria-label','I independently confirmed the patch verifier has terminated');
  let integrationOperation='';
  let closed=false,busy=false,epoch=0,refreshGeneration=0,recipeGeneration=0,lastWorkflowError='',ackTimer:ReturnType<typeof setTimeout>|null=null,patchPollTimer:ReturnType<typeof setTimeout>|null=null;const controllers=new Set<AbortController>();
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
    }catch(reason){if(!closed&&ticket===epoch&&!(reason instanceof Error&&reason.name==='AbortError')){lastWorkflowError=reason instanceof Error&&/^[a-z_]+$/.test(reason.message)?reason.message:'unavailable';report(`Workflow: ${lastWorkflowError}. Refresh and preview again.`);}return null;}
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
    if(closed||busy)return;busy=true;lastWorkflowError='';report('');const ticket=++epoch;status.textContent=`${label}…`;
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
       const support=reply.verification_support as VerificationSupport|undefined;
       const exact=el('pre','workbench-patch-preview-text',patchPreview.patch_text);exact.setAttribute('aria-label','Exact unified diff bytes proposed for verified patch export');
        patchView.replaceChildren(field('Format',reply.format),field('Source identity',reply.source),field('Candidate identity',reply.candidate),field('Reviewed checks and evidence',reply.review),field('Verification support',support?.message??'Server support unavailable; refresh the preview'),...(support?.required_checks??[]).filter(check=>!check.ready).map(check=>field(`${check.definition_id} · profile ${check.execution_profile_id??'default'}`,check.message)),field('Exact changes',reply.changes),field('Exclusions (not deletions)',reply.exclusions),field('Unsupported changes',reply.unsupported),field('Round-trip verification',reply.roundtrip),field('Patch bytes / SHA-256',`${reply.bytes} / ${reply.artifact_hash}`),field('Preview digest',reply.preview_digest),el('h4','','Exact patch bytes to be confirmed'),exact);
       confirmPatch.disabled=support?.ready!==true||support.candidate_hash!==reply.candidate_hash||support.candidate_generation!==reply.candidate_generation||support.acceptance_digest!==((reply.review as Reply|undefined)?.required_check_state as Reply|undefined)?.acceptance_digest;
    });
  });
  const confirmPatch=button('Create private verified patch','Persist the exact previewed patch in the private authenticated artifact store',()=>{
    if(!patchPreview||(patchPreview as PatchPreview&{verification_support?:VerificationSupport}).verification_support?.ready!==true)return;const [candidate_id,review_id,task_id]=candidateSelect.value.split(':');if(!candidate_id||!review_id||!task_id)return;
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
  function installPatchList(reply:Reply,preferArtifactId?:string,historical=historicalView){
    historicalView=historical;
    patchList=reply;patchRecords=(reply.patches??[]) as Reply[];const selected=preferArtifactId??savedPatch.value;savedPatch.replaceChildren();
    for(const record of patchRecords){const id=String(record.artifact_id??record.id),option=el('option','',`${record.created_at??''} · ${record.task_id} · ${record.status} · ${id}`);option.value=id;savedPatch.append(option);}
    if(patchRecords.some((record:Reply)=>String(record.artifact_id??record.id)===selected))savedPatch.value=selected;else if(patchRecords.length)savedPatch.selectedIndex=0;
    olderPatchPage.disabled=reply.truncated!==true||typeof reply.next_after_id!=='string';newerPatchPage.disabled=!patchBefore.length;
    const listNotice=el('p','',`${historical?'Historical recovery view · project access is unavailable; candidate, integration, and export controls are disabled. ':''}${reply.truncated===true?`Showing ${patchRecords.length} receipts from ${reply.total_count} total; older receipts are available on the next page.`:`Showing ${patchRecords.length} receipts on this page.`}`);
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
  const recipeStatus=el('p','workbench-arrangement-status','Choose an arrangement to preview.');recipeStatus.setAttribute('role','status');
  const recoveryControls=el('div','workbench-arrangement-recovery');
  const recipeChoices=el('div','workbench-arrangement-choices');
  const savedSection=el('details','workbench-arrangement-saved'),bindingChoices=el('div','workbench-arrangement-bindings');
  const choiceSelects=new Map<string,HTMLSelectElement>();
  const recipeNameInput=el('input');recipeNameInput.maxLength=60;recipeNameInput.setAttribute('aria-label','Portable recipe name');recipeNameInput.placeholder='Name this portable recipe';
  const savedSelect=el('select');savedSelect.setAttribute('aria-label','Saved portable recipe');
  const layoutSelect=el('select');layoutSelect.setAttribute('aria-label','Portable recipe layout');
  for(const [key,name] of [['prioritize','Prioritize windows'],['columns','Measured columns'],['rows','Measured rows']]){const option=el('option','',name);option.value=key;layoutSelect.append(option);}
  const rendererSelect=el('select');rendererSelect.setAttribute('aria-label','Portable recipe renderer');
  for(const key of ['windows','spatial','docking']){const option=el('option','',key);option.value=key;rendererSelect.append(option);}
  const roleInputs=new Map<string,HTMLInputElement>();
  const rolesHost=el('div','workbench-arrangement-roles'),orderHost=el('div','workbench-arrangement-order');
  for(const role of ['primary_agent','active_terminal','preview','candidate_diff','project_files']){
    const input=el('input');input.type='checkbox';input.setAttribute('aria-label',`Include ${role}`);roleInputs.set(role,input);
    const label=el('label');label.append(input,el('span','',role.replaceAll('_',' ')));rolesHost.append(label);
    input.addEventListener('change',()=>{if(input.checked&&!roleOrder.includes(role))roleOrder.push(role);if(!input.checked)roleOrder=roleOrder.filter(item=>item!==role);renderRoleOrder();clearRecipe();});
  }
  function renderRoleOrder(){
    orderHost.replaceChildren(el('span','','Role priority: '));
    for(const [index,role] of roleOrder.entries()){
      const item=el('span','',role.replaceAll('_',' '));
      const up=button('↑',`Move ${role} earlier`,()=>{if(index){[roleOrder[index-1],roleOrder[index]]=[roleOrder[index],roleOrder[index-1]];renderRoleOrder();clearRecipe();}});
      const down=button('↓',`Move ${role} later`,()=>{if(index<roleOrder.length-1){[roleOrder[index+1],roleOrder[index]]=[roleOrder[index],roleOrder[index+1]];renderRoleOrder();clearRecipe();}});
      up.disabled=index===0;down.disabled=index===roleOrder.length-1;item.append(up,down);orderHost.append(item);
    }
  }
  const proposalSection=el('details','workbench-arrangement-proposals'),proposalSelect=el('select');proposalSelect.setAttribute('aria-label','Recorded arrangement proposal');
  const proposalDetails=el('div','workbench-arrangement-proposal-details'),proposalCount=el('p','','No proposals loaded.');
  const importSection=el('details','workbench-arrangement-import'),importSelect=el('select'),importView=el('div','workbench-arrangement-import-preview'),importChoiceHost=el('div','workbench-arrangement-bindings');
  const importChoiceSelects=new Map<string,HTMLSelectElement>();importSelect.setAttribute('aria-label','Local saved layout to import');
  const recipeDetails=el('details','workbench-arrangement-details');recipeDetails.append(el('summary','','Advanced details'));
  const recipeActions=el('div','workbench-arrangement-actions');
  const recipeLabels:Record<Recipe,string>={project_focus:'Portable recipe',investigate:'Investigate',implement:'Implement',review:'Review',return:'Undo arrangement'};
  const builtinRoles:Record<Recipe,string[]>={project_focus:[],investigate:['primary_agent','project_files','active_terminal','preview'],implement:['primary_agent','candidate_diff','project_files'],review:['candidate_diff','project_files','primary_agent'],return:[]};
  const intentKey=(kind:'save'|'apply')=>`orbit.arrangement.${kind}:${args.workspace_id}:${args.project_id}`;
  function storeIntent(kind:'save'|'apply',body:Reply|null){try{if(body)sessionStorage.setItem(intentKey(kind),JSON.stringify(body));else sessionStorage.removeItem(intentKey(kind));}catch{}}
  function readIntent(kind:'save'|'apply'):Reply|null{try{const raw=sessionStorage.getItem(intentKey(kind));return raw&&raw.length<5000?JSON.parse(raw) as Reply:null;}catch{return null;}}
  function clearAck(){if(ackTimer)clearTimeout(ackTimer);ackTimer=null;}
  function clearRecipe(){recipeGeneration++;recipePreview=null;recipeOperationId='';previewSurface='';applyRecipe.disabled=true;cancelRecipe.disabled=true;recipeView.replaceChildren();recipeDetails.replaceChildren(el('summary','','Advanced details'));recipeDetails.open=false;}
  function measuredViewport():{width:number;height:number;renderer:string}|null{
    const docking=document.documentElement.dataset.dockingRenderer==='docking';
    const host=docking?document.querySelector<HTMLElement>('.docking-root'):document.querySelector<HTMLElement>('.desktop-host');
    // Spatial/focus mode hides the Windows surface. Its sibling stage has the
    // same actual viewport bounds; neither an offscreen nor zero-sized host is used.
    const measured=host&&host.getClientRects().length&&host.getBoundingClientRect().width&&host.getBoundingClientRect().height?host:document.querySelector<HTMLElement>('.stage');
    if(!measured||!measured.getClientRects().length)return null;
    const rect=measured.getBoundingClientRect(),width=Math.floor(rect.width),height=Math.floor(rect.height);
    return width>=280&&height>=180?{width,height,renderer:docking?'docking':'default'}:null;
  }
  function surfaceIdentity(){
    const spatial=(()=>{try{return (JSON.parse(localStorage.getItem('orbit.workspace.v1')??'null') as {view?:string}|null)?.view==='spatial';}catch{return false;}})();
    return `${document.documentElement.dataset.dockingRenderer==='docking'?'docking':'default'}:${spatial?'spatial':'windows'}`;
  }
  function activeRenderer(){const surface=surfaceIdentity();return surface.endsWith(':spatial')?'spatial':surface.startsWith('docking:')?'docking':'windows';}
  function showRecipe(preview:RecipePreview,recipe:Recipe){
    const title=el('strong','',`${recipe==='project_focus'?savedRecipes.find(item=>item.id===selectedSavedId)?.name??recipeLabels[recipe]:recipeLabels[recipe]} · ${preview.changed?'Changes proposed':'Already arranged'}`);
    const list=el('ul','workbench-arrangement-diff');
    for(const item of preview.semantic_diff??[]){const line=el('li','',item.summary);list.append(line);}
    if(!list.childElementCount)list.append(el('li','',preview.changed?'Existing windows will be rearranged. See exact operations in Advanced details.':'No arrangement changes are proposed.'));
    recipeView.replaceChildren(title,list,...(preview.unbound?.length?[el('p','workbench-arrangement-unbound',`Unbound roles: ${preview.unbound.join(', ')}. These roles have no matching project binding; no binding will be created.`)]:[]),...(preview.geometry==='deferred'?[el('p','','Measured geometry was deferred; only available ordering is proposed.')]:[]));
    recipeDetails.replaceChildren(el('summary','','Advanced details'),field('Base revision',preview.base_revision),field('Recipe renderer',preview.renderer??'Unspecified'),field('Measured browser surface',previewSurface),field('Geometry',preview.geometry??'none'),field('Measured viewport',preview.viewport??'Not required'),field('Exact operations',preview.operations),field('Continuity',preview.warning),field('Preview digest',preview.preview_digest),field('Expires at',new Date(preview.expires_at).toLocaleString()));
    recipeStatus.textContent='Preview ready. Apply only if these changes match your intent.';
    applyRecipe.disabled=!preview.changed;cancelRecipe.disabled=false;
  }
  function previewRecipe(recipe:Recipe,saved?:SavedRecipe){
    if(busy)return;
    clearRecipe();clearAck();
    const roles=saved?.roles??builtinRoles[recipe];
    if(!saved)renderBindings(roles);
    if(saved&&saved.renderer!==activeRenderer()){recipeStatus.textContent=`This recipe targets ${saved.renderer}. Switch the workspace to that renderer before previewing, or edit the recipe explicitly.`;return;}
    const needsMeasurement=recipe==='review'||!!saved&&saved.layout!=='prioritize';
    const measurement=needsMeasurement?measuredViewport():null;
    if(needsMeasurement&&!measurement){recipeStatus.textContent='Arrangement unavailable: a measurable workspace viewport of at least 280 × 180 is required.';return;}
    const choices:Record<string,string>={};
    for(const [role,select] of choiceSelects)if(roles.includes(role)){
      if(!select.value){recipeStatus.textContent=`Choose one bound pane for ${role.replaceAll('_',' ')} before previewing.`;select.focus();return;}
      choices[role]=select.value;
    }
    const generation=recipeGeneration;
    previewSurface=surfaceIdentity();
    recipeStatus.textContent=`Previewing ${saved?.name??recipeLabels[recipe]}…`;
    void act('Arrangement preview',{action:'recipe_preview',recipe,...(recipe!=='return'?{role_choices:choices,renderer:saved?.renderer??activeRenderer()}:{}),...(saved?{recipe_id:saved.id}:{}),...(measurement?{width:measurement.width,height:measurement.height}:{})},reply=>{
      if(generation!==recipeGeneration)return;
      recipeName=recipe;recipePreview=reply as RecipePreview;showRecipe(recipePreview,recipe);
    }).finally(()=>{if(generation===recipeGeneration&&!recipePreview)recipeStatus.textContent='Preview unavailable. Refresh the project and try again.';});
  }
  const applyRecipe=button('Apply preview','Apply the exact preview under workspace revision check',()=>{
    if(!recipePreview||!recipePreview.changed||busy)return;
    const preview=recipePreview,recipe=recipeName,generation=recipeGeneration;
    if(!recipeOperationId){
      const current=preview.viewport?measuredViewport():null;
      if(surfaceIdentity()!==previewSurface||preview.viewport&&(!current||current.width!==preview.viewport.width||current.height!==preview.viewport.height)){
        clearRecipe();recipeStatus.textContent='Renderer or measured workspace viewport changed. Preview again before applying.';return;
      }
    }
    recipeOperationId ||= crypto.randomUUID();const op_id=recipeOperationId;
    const body={action:'recipe_apply',recipe,preview_id:preview.preview_id,preview_digest:preview.preview_digest,op_id,...(preview.viewport?{viewport:preview.viewport}:{})};
    storeIntent('apply',body);
    busy=true;lastWorkflowError='';applyRecipe.disabled=true;cancelRecipe.disabled=true;recipeStatus.textContent='Applying exact preview…';
    const ticket=++epoch;
    void (async()=>{
      try{
        const reply=await request(body,ticket);
        if(closed||generation!==recipeGeneration)return;
        if(reply){
          storeIntent('apply',null);
          clearRecipe();const revision=(reply.workspace as Reply|undefined)?.revision;
          recipeStatus.textContent=`Saved workspace revision ${revision}. Waiting for connected browser acknowledgement; inspect the workspace to confirm placement.`;
          if(typeof revision==='number'&&Number.isSafeInteger(revision))void watchAcknowledgement(revision);
          void loadArrangements();return;
        }
        // A lost response is not evidence that apply failed. Reconcile the
        // durable proposal and retain the same operation key for an exact retry.
        const record=(await requestIndependent({action:'proposal_get',proposal_id:preview.preview_id}))?.proposal as Reply|undefined;
        if(closed||generation!==recipeGeneration)return;
        if(record?.status==='committed'){
          storeIntent('apply',null);
          clearRecipe();const revision=record.committed_revision;
          recipeStatus.textContent=`Saved workspace revision ${revision}. Waiting for connected browser acknowledgement; inspect the workspace to confirm placement.`;
          if(typeof revision==='number')void watchAcknowledgement(revision);
        }else if(record?.status==='stale'||record?.status==='rejected'||['expired','stale_resource','conflict','invalid_request'].includes(lastWorkflowError)){
          storeIntent('apply',null);
          clearRecipe();recipeStatus.textContent='Preview is stale. Refresh and preview the current workspace again.';
        }else{
          applyRecipe.disabled=false;recipeStatus.textContent='Apply outcome unconfirmed. Retry uses the same exact operation key; inspect recorded proposals before another action.';
        }
      }finally{busy=false;}
    })();
  });applyRecipe.disabled=true;
  const cancelRecipe=button('Cancel preview','Discard the arrangement preview without changing the workspace',()=>{
    const discarded=recipePreview?.preview_id;clearRecipe();recipeStatus.textContent='Preview cancelled. Workspace unchanged.';
    if(discarded)void requestIndependent({action:'proposal_get',proposal_id:discarded}).then(reply=>{
      const record=reply?.proposal as Reply|undefined;
      if(record?.status==='previewed'&&typeof record.version==='number')void requestIndependent({action:'proposal_reject',proposal_id:discarded,expected_version:record.version}).then(()=>void loadArrangements());
    });
  });cancelRecipe.disabled=true;
  async function watchAcknowledgement(revision:number){
    clearAck();const generation=recipeGeneration;let checks=0;
    const check=async()=>{
      if(closed||generation!==recipeGeneration)return;
      const controller=new AbortController();controllers.add(controller);
      try{
        const bearer=typeof args.token==='function'?args.token():args.token;
        const response=await fetch('/api/workspace',{method:'POST',headers:{Authorization:`Bearer ${bearer}`,'Content-Type':'application/json'},body:JSON.stringify({workspace_id:args.workspace_id,action:'read'}),signal:controller.signal});
        const value=await response.json() as Reply;
        if(closed||generation!==recipeGeneration||bearer!==(typeof args.token==='function'?args.token():args.token))return;
        if(response.ok&&typeof value.observed_revision==='number'&&value.observed_revision>=revision){recipeStatus.textContent=`Browser acknowledged revision ${revision}. Inspect the workspace to confirm placement.`;return;}
      }catch{}finally{controllers.delete(controller);}
      if(!closed&&generation===recipeGeneration&&checks++<15)ackTimer=setTimeout(()=>void check(),1200);
      else if(!closed&&generation===recipeGeneration)recipeStatus.textContent=`Saved revision ${revision}; browser acknowledgement not yet observed. Inspect the connected workspace before claiming visibility.`;
    };
    void check();
  }
  function selectedSaved(){return savedRecipes.find(item=>item.id===savedSelect.value)??null;}
  function renderBindings(roles=selectedSaved()?.roles??[]){
    const previous=new Map([...choiceSelects].map(([role,select])=>[role,select.value]));
    bindingChoices.replaceChildren();choiceSelects.clear();
    for(const role of roles){
      const matches=bindings.filter(binding=>binding.role===role);
      if(!matches.length){bindingChoices.append(el('p','workbench-arrangement-unbound',`${role.replaceAll('_',' ')}: no bound pane in this project`));continue;}
      if(matches.length===1)continue;
      const select=el('select');select.setAttribute('aria-label',`Binding for ${role}`);
      const placeholder=el('option','','Choose one bound pane');placeholder.value='';select.append(placeholder);
      for(const binding of matches){const option=el('option','',`${role.replaceAll('_',' ')} · pane ${binding.pane_id}`);option.value=binding.id;select.append(option);}
      if(matches.some(binding=>binding.id===previous.get(role)))select.value=previous.get(role)!;
      const label=el('label');label.append(el('span','',`${role.replaceAll('_',' ')}: `),select);bindingChoices.append(label);choiceSelects.set(role,select);
    }
    renderImportChoices();
  }
  function renderImportChoices(){
    importChoiceHost.replaceChildren();importChoiceSelects.clear();
    for(const role of ['primary_agent','active_terminal','preview','candidate_diff','project_files']){
      const matches=bindings.filter(item=>item.role===role);
      if(matches.length<2)continue;
      const select=el('select');select.setAttribute('aria-label',`Import binding for ${role}`);
      const blank=el('option','','Choose a binding for import');blank.value='';select.append(blank);
      for(const binding of matches){const option=el('option','',`${role.replaceAll('_',' ')} · pane ${binding.pane_id}`);option.value=binding.id;select.append(option);}
      const label=el('label');label.append(el('span','',`${role.replaceAll('_',' ')}: `),select);importChoiceHost.append(label);importChoiceSelects.set(role,select);
    }
  }
  function renderSaved(){
    const previous=selectedSavedId||savedSelect.value;savedSelect.replaceChildren();
    const blank=el('option','','New portable recipe');blank.value='';savedSelect.append(blank);
    for(const recipe of savedRecipes){const option=el('option','',`${recipe.name} · ${recipe.layout}${recipe.project_id&&recipe.project_id!==args.project_id?' · other project':''}`);option.value=recipe.id;savedSelect.append(option);}
    savedSelect.value=savedRecipes.some(item=>item.id===previous)?previous:'';selectedSavedId=savedSelect.value;
    if(selectedSavedId){const recipe=selectedSaved();if(recipe){recipeNameInput.value=recipe.name;layoutSelect.value=recipe.layout;rendererSelect.value=recipe.renderer;roleOrder=[...recipe.roles];for(const [role,input] of roleInputs)input.checked=recipe.roles.includes(role);renderRoleOrder();}}
    saveRecipe.disabled=!!selectedSaved()?.project_id&&selectedSaved()?.project_id!==args.project_id;
    renderBindings();
  }
  function showProposalList(){
    const current=proposalSelect.value;proposalSelect.replaceChildren();
    for(const record of proposalRows){
      const option=el('option','',`${record.recipe_id?savedRecipes.find(item=>item.id===record.recipe_id)?.name??'Portable recipe':record.recipe} · ${record.status} · revision ${record.committed_revision??record.base_revision} · ${record.id}`);
      option.value=String(record.id);proposalSelect.append(option);
    }
    if(proposalRows.some(item=>item.id===current))proposalSelect.value=current;
    proposalCount.textContent=`Showing ${proposalRows.length} of ${proposalTotal} recorded proposals on this page${proposalNext?'; older records available':''}.`;
    olderProposals.disabled=!proposalNext;newerProposals.disabled=!proposalBefore.length;
    if(!proposalRows.length)proposalDetails.replaceChildren(el('p','','No recorded proposals for this project.'));
  }
  async function loadArrangements(){
    const generation=++recipeListGeneration;
    const [listed,history]=await Promise.all([requestIndependent({action:'recipe_list'}),requestIndependent({action:'proposal_list',...(proposalAfter?{after_id:proposalAfter}:{})})]);
    if(closed||generation!==recipeListGeneration)return;
    if(listed){savedRecipes=(listed.recipes??[]) as SavedRecipe[];bindings=(listed.bindings??[]) as Binding[];renderSaved();}
    if(history){proposalRows=(history.proposals??[]) as Reply[];proposalNext=typeof history.next_after_id==='string'?history.next_after_id:null;proposalTotal=typeof history.total_count==='number'?history.total_count:proposalRows.length;showProposalList();}
    if(listed&&history&&!recovered){recovered=true;void recoverIntents();}
  }
  async function recoverIntents(){
    const save=readIntent('save'),apply=readIntent('apply');recoveryControls.replaceChildren();
    if(save?.action==='recipe_save'&&typeof save.op_id==='string'){
      // A list cannot prove whether a particular save receipt exists. Never
      // infer success from a name match; the explicit retry reads that receipt
      // first using the unchanged durable operation key.
      recoveryControls.append(el('p','','A recipe save response was not recorded here. The saved recipe list is available for inspection.'),button('Retry exact pending save','Replay the same durable save operation key before considering any new save',()=>{
        void requestIndependent(save).then(reply=>{if(!reply)return;storeIntent('save',null);saveIntent=null;recoveryControls.replaceChildren();selectedSavedId=String((reply.recipe as Reply)?.id??'');recipeStatus.textContent='Durable save receipt reconciled; inspect the saved recipe.';void loadArrangements();});
      }));
      saveIntent={body:save,fingerprint:JSON.stringify(Object.fromEntries(Object.entries(save).filter(([key])=>key!=='op_id')))};
    }
    if(apply?.action==='recipe_apply'&&typeof apply.preview_id==='string'&&typeof apply.op_id==='string'){
      const record=(await requestIndependent({action:'proposal_get',proposal_id:apply.preview_id}))?.proposal as Reply|undefined;
      if(closed)return;
      if(record?.status==='committed'&&record.op_id===apply.op_id){
        storeIntent('apply',null);recipeStatus.textContent=`Saved revision ${record.committed_revision}; browser rendering still requires inspection.`;
        if(typeof record.committed_revision==='number')void watchAcknowledgement(record.committed_revision);
      }else if(record?.status==='previewed'){
        recoveryControls.append(el('p','','A previous apply response is unresolved. Inspect this exact persisted proposal before deciding to retry.'),button('Retry exact pending apply','Replay the retained preview digest, viewport and operation key',()=>{
          void requestIndependent({action:'proposal_get',proposal_id:apply.preview_id}).then(current=>{
            const proposal=current?.proposal as Reply|undefined;
            if(proposal?.status==='committed'&&proposal.op_id===apply.op_id){storeIntent('apply',null);recoveryControls.replaceChildren();recipeStatus.textContent=`Saved revision ${proposal.committed_revision}; inspect browser rendering.`;return;}
             if(proposal?.status!=='previewed'){recipeStatus.textContent='Pending proposal is no longer applicable. Preview again.';storeIntent('apply',null);recoveryControls.replaceChildren();return;}
             const viewport=proposal.viewport as {width:number;height:number}|null|undefined,currentViewport=viewport?measuredViewport():null;
             if(proposal.recipe!=='return'&&proposal.renderer!==activeRenderer()||viewport&&(!currentViewport||viewport.width!==currentViewport.width||viewport.height!==currentViewport.height)){
               recipeStatus.textContent='The saved proposal has not committed and its renderer or viewport no longer matches. Create a fresh preview.';storeIntent('apply',null);recoveryControls.replaceChildren();return;
             }
            void requestIndependent(apply).then(reply=>{if(!reply)return;storeIntent('apply',null);recoveryControls.replaceChildren();const revision=(reply.workspace as Reply|undefined)?.revision;recipeStatus.textContent=`Saved revision ${revision}; waiting for browser acknowledgement and inspection.`;if(typeof revision==='number')void watchAcknowledgement(revision);void loadArrangements();});
          });
        }));
      }else if(record?.status==='rejected'||record?.status==='stale')storeIntent('apply',null);
      else recoveryControls.append(el('p','','Pending apply record could not be inspected. Reconnect and refresh before retrying. No new arrangement was applied from this page.'));
    }
  }
  async function currentWorkspace():Promise<Workspace|null>{
    const controller=new AbortController();controllers.add(controller);
    try{
      const bearer=typeof args.token==='function'?args.token():args.token;
      const response=await fetch('/api/workspace',{method:'POST',headers:{Authorization:`Bearer ${bearer}`,'Content-Type':'application/json'},body:JSON.stringify({workspace_id:args.workspace_id,action:'read'}),signal:controller.signal});
      const value=await response.json() as Reply;
      if(!response.ok||closed||bearer!==(typeof args.token==='function'?args.token():args.token))return null;
      return value.state as Workspace;
    }catch{return null;}finally{controllers.delete(controller);}
  }
  function localLayouts():SavedLayout[]{
    try{
      const value=JSON.parse(localStorage.getItem(`orbit.layouts.${args.workspace_id}`)??'null') as {layouts?:SavedLayout[]}|null;
      return Array.isArray(value?.layouts)?value.layouts.slice(0,32):[];
    }catch{return [];}
  }
  const importMarkerKey=`orbit.arrangement.imports:${args.workspace_id}`;
  function importMarkers():Record<string,{digest:string;recipe_id:string}>{try{return JSON.parse(localStorage.getItem(importMarkerKey)??'{}') as Record<string,{digest:string;recipe_id:string}>;}catch{return {};}}
  async function layoutDigest(layout:SavedLayout){const bytes=new TextEncoder().encode(JSON.stringify(layout));return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))).map(value=>value.toString(16).padStart(2,'0')).join('');}
  function showImportLayouts(){
    const previous=importSelect.value;importSelect.replaceChildren();
    const layouts=localLayouts(),markers=importMarkers();
    for(const layout of layouts){const option=el('option','',layout.name);option.value=layout.id;importSelect.append(option);
      void layoutDigest(layout).then(digest=>{if(!closed&&option.isConnected&&markers[layout.id]?.digest===digest)option.textContent=`${layout.name} · already imported`;});}
    if(Array.from(importSelect.options).some(option=>option.value===previous))importSelect.value=previous;
    if(!importSelect.options.length)importView.replaceChildren(el('p','','No browser-local saved layouts were found for this workspace.'));
  }
  async function previewImport(current:boolean){
    importView.replaceChildren(el('p','','Reading current workspace and portable binding order…'));
    const state=await currentWorkspace();if(!state){importView.textContent='Current workspace unavailable. Connect and retry.';return;}
    const choices:Record<string,string>={};for(const [role,select] of importChoiceSelects){
      if(!select.value){importView.textContent=`Choose one binding for ${role.replaceAll('_',' ')} before import.`;select.focus();return;}
      choices[role]=select.value;
    }
    const layout=current?captureLayout(state,'Current role order',crypto.randomUUID()):localLayouts().find(item=>item.id===importSelect.value);
    if(!layout){importView.textContent='Choose an existing local layout to import.';return;}
    try{
      const {importSavedLayoutAsWorkspaceRecipe}=await import('./workspace-recipe-import');
      const portableBindings=bindings.map(({id,pane_id,role})=>({id,pane_id,role})) as Parameters<typeof importSavedLayoutAsWorkspaceRecipe>[2];
      const converted=importSavedLayoutAsWorkspaceRecipe(layout,state,portableBindings,choices);
      if(closed)return;
      const definition=converted.definition,digest=current?'':await layoutDigest(layout);
      if(closed)return;
      const use=button('Use these portable constraints','Fill the portable recipe editor; original local layout stays unchanged',()=>{
        savedSelect.value='';selectedSavedId='';recipeNameInput.value=definition.name;layoutSelect.value=definition.layout;rendererSelect.value=definition.renderer;
        saveRecipe.disabled=false;
        roleOrder=[...definition.roles];for(const [role,input] of roleInputs)input.checked=definition.roles.includes(role as typeof definition.roles[number]);renderRoleOrder();
        stagedImport=current?null:{layoutId:layout.id,digest,roles:[...definition.roles]};
        savedSection.open=true;
        clearRecipe();recipeStatus.textContent='Imported constraints staged in the editor. Review the omitted geometry and warnings, then save and preview the named recipe.';
      });
      importView.replaceChildren(el('strong','',`${definition.name} · ${definition.roles.join(' → ')||'no bound roles'}`),...(digest&&importMarkers()[layout.id]?.digest===digest?[el('p','','This local layout was already imported. Import again only if you intend a new portable recipe.')]:[]),field('Portable renderer / layout',`${definition.renderer} / ${definition.layout}`),...converted.warnings.map(warning=>el('p','',warning)),field('Fields not carried over',converted.omitted_fields.join(', ')),field('Absent roles',converted.absent_roles.join(', ')||'none'),use);
    }catch(reason){importView.textContent=reason instanceof Error?reason.message:'Unable to convert this local layout.';}
  }
  importSection.append(el('summary','','Import local layout as role order'),el('p','','One-time conversion only. The original browser-local layout remains untouched; positions, sizes, minimized state, selection and camera are omitted.'),importSelect,button('Refresh local layouts','Read this browser’s saved layouts',showImportLayouts),importChoiceHost,button('Preview local layout import','Convert one selected local layout to portable role-order constraints without saving',()=>void previewImport(false)),button('Preview current role order','Capture current window role order as portable constraints without saving geometry',()=>void previewImport(true)),importView);
  importSection.addEventListener('toggle',()=>{if(importSection.open)showImportLayouts();});
  savedSelect.addEventListener('change',()=>{selectedSavedId=savedSelect.value;clearRecipe();if(!selectedSavedId){roleOrder=[];for(const input of roleInputs.values())input.checked=false;renderRoleOrder();}renderSaved();});
  for(const input of [recipeNameInput,layoutSelect,rendererSelect])input.addEventListener(input===recipeNameInput?'input':'change',()=>clearRecipe());
  bindingChoices.addEventListener('change',()=>clearRecipe());
  const saveRecipe=button('Save portable recipe','Save only role priorities, layout type and renderer; never current window frames',()=>{
    const name=recipeNameInput.value.trim(),roles=roleOrder.filter(role=>roleInputs.get(role)?.checked),current=selectedSaved();
    if(!name){recipeStatus.textContent='Enter a recipe name before saving.';recipeNameInput.focus();return;}
    const definition={action:'recipe_save',name,roles,layout:layoutSelect.value,renderer:rendererSelect.value,...(current?{recipe_id:current.id,expected_version:current.version}:{})};
    const fingerprint=JSON.stringify(definition);
    if(saveIntent&&saveIntent.fingerprint!==fingerprint){recipeStatus.textContent='Previous save outcome is unresolved. Restore its fields and retry with the retained operation key before starting another save.';return;}
    saveIntent??={body:{...definition,op_id:crypto.randomUUID()},fingerprint};
    storeIntent('save',saveIntent.body);
    void act('Saving portable recipe',saveIntent.body,reply=>{
      saveIntent=null;storeIntent('save',null);selectedSavedId=String((reply.recipe as Reply)?.id??'');
      if(stagedImport&&JSON.stringify(stagedImport.roles)===JSON.stringify(roles)&&selectedSavedId){
        try{localStorage.setItem(importMarkerKey,JSON.stringify({...importMarkers(),[stagedImport.layoutId]:{digest:stagedImport.digest,recipe_id:selectedSavedId}}));}catch{}
        showImportLayouts();
      }
      stagedImport=null;clearRecipe();recipeStatus.textContent='Portable recipe saved: role priorities, layout type and renderer only. Current window geometry was not saved.';void loadArrangements();
    }).finally(()=>{if(saveIntent){if(['conflict','stale_resource','invalid_request','limit_exceeded'].includes(lastWorkflowError)){saveIntent=null;storeIntent('save',null);recipeStatus.textContent='Save refused. Revise the name or recipe and retry.';}else recipeStatus.textContent='Save outcome unconfirmed. Retry this exact recipe with its retained operation key; no new save was started.';}});
  });
  const previewSaved=button('Preview selected recipe','Resolve current project bindings and preview this portable recipe',()=>{
    const selected=selectedSaved();if(!selected){recipeStatus.textContent='Choose a saved recipe first.';return;}
    for(const [role,select] of choiceSelects)if(!select.value){recipeStatus.textContent=`Choose one bound pane for ${role.replaceAll('_',' ')} before previewing.`;select.focus();return;}
    selectedSavedId=selected.id;previewRecipe('project_focus',selected);
  });
  const openProposal=button('Inspect proposal','Read the durable exact proposal for the selected record',()=>{
    if(!proposalSelect.value)return;
    void requestIndependent({action:'proposal_get',proposal_id:proposalSelect.value}).then(reply=>{
      if(!reply)return;const record=reply.proposal as Reply;
      proposalDetails.replaceChildren(field('Status',record.status),field('Base / committed revision',`${record.base_revision} / ${record.committed_revision??'not committed'}`),field('Changed',record.changed),field('Semantic changes',record.semantic_diff),field('Unbound roles',record.unbound),field('Geometry',record.geometry),field('Browser rendering','Not established by this record'),field('Exact operations',record.operations));
      if(record.status==='previewed'&&typeof record.expires_at==='number'&&record.expires_at>Date.now()&&typeof record.preview_digest==='string'){
        const restore=button('Use pending preview','Load the exact persisted preview for a deliberate apply or cancel',()=>{
          if(record.recipe!=='return'&&record.renderer!==activeRenderer()){
            clearRecipe();recipeStatus.textContent='This pending preview targets a different renderer. Switch to its renderer or create a fresh preview.';return;
          }
          clearRecipe();previewSurface=surfaceIdentity();recipeName=record.recipe as Recipe;recipePreview={...record,preview_id:String(record.id),preview_digest:record.preview_digest as string,base_revision:record.base_revision as number,changed:record.changed===true,operations:record.operations as unknown[],warning:String(record.warning??''),expires_at:record.expires_at as number};
          showRecipe(recipePreview,recipeName);
        });proposalDetails.append(restore);
      }
    });
  });
  const olderProposals=button('Older proposals','Load the next bounded page of older arrangement proposals',()=>{if(!proposalNext)return;proposalBefore.push(proposalAfter);proposalAfter=proposalNext;void loadArrangements();});
  const newerProposals=button('Newer proposals','Return to the previous bounded page of arrangement proposals',()=>{if(!proposalBefore.length)return;proposalAfter=proposalBefore.pop()??null;void loadArrangements();});
  olderProposals.disabled=true;newerProposals.disabled=true;
  proposalSection.append(el('summary','','Recorded proposals'),el('p','','Committed records are saved workspace changes, not proof of browser rendering. Pending previews can be inspected and explicitly resumed or cancelled.'),proposalCount,proposalSelect,newerProposals,olderProposals,openProposal,proposalDetails);
  savedSection.append(el('summary','','New / edit portable recipe'),el('p','','Save role order and grid intent, not current window geometry. Recipes are reusable across this workspace and editable from their source project. Spatial supports order only.'),recipeNameInput,rolesHost,orderHost,layoutSelect,rendererSelect,saveRecipe);
  const openReview=button('Open trusted Review view','Open the owner-bound candidate review pane for this project',()=>{
    window.dispatchEvent(new CustomEvent('orbit-open-workbench-review',{detail:{workspace_id:args.workspace_id,project_id:args.project_id}}));
  });
  candidateSelect.addEventListener('change',()=>{integrationPreview=null;confirmIntegration.disabled=true;previewView.replaceChildren();patchPreview=null;patchArtifactId='';confirmPatch.disabled=true;downloadPatch.disabled=true;patchView.replaceChildren();});
   integration.append(el('h3','','Private Git integration'),candidateSelect,previewIntegration,previewView,confirmIntegration,button('Refresh integration receipts','Read retained integration state without publishing',()=>void refresh()),integrationRecovery,integrationReceipts);
   patch.append(el('h3','','Verified patch handoff'),el('p','','Exports only the reviewed captured source-to-candidate change. Excluded paths are never inferred as deletions. A disposable exact-base round trip and all frozen required checks are required; unsupported or oversized artifacts are refused.'),previewPatch,patchView,confirmPatch,patchInventory);
    recipeChoices.append(button('Investigate','Preview Investigate arrangement',()=>previewRecipe('investigate')),button('Implement','Preview Implement arrangement',()=>previewRecipe('implement')),button('Review','Preview Review arrangement',()=>previewRecipe('review')),button('Undo arrangement','Preview return arrangement',()=>previewRecipe('return')),button('Debug template','Prepare a portable Debug recipe for explicit save and preview',()=>{
       clearRecipe();savedSelect.value='';selectedSavedId='';recipeNameInput.value='Debug';roleOrder=['primary_agent','active_terminal','preview','project_files'];
      for(const [role,input] of roleInputs)input.checked=roleOrder.includes(role);
      renderRoleOrder();layoutSelect.value=activeRenderer()==='spatial'?'prioritize':'columns';rendererSelect.value=activeRenderer();saveRecipe.disabled=false;savedSection.open=true;
      recipeStatus.textContent='Debug is an editable portable recipe template. Save its role constraints, then preview against this project’s current bindings; no arrangement has been applied.';
    }));
   recipeActions.append(applyRecipe,cancelRecipe);
    recipes.className='workbench-arrangements';recipes.append(el('h3','','Workspace arrangements'),el('p','workbench-arrangement-intro','Arrange existing project windows without replacing their panes.'),recipeChoices,el('label','','Saved portable recipe '),savedSelect,bindingChoices,previewSaved,savedSection,importSection,recipeStatus,recoveryControls,recipeView,recipeActions,recipeDetails,proposalSection,openReview);
  retention.append(el('h3','','Retention inventory'));
   args.container.replaceChildren(el('h2','','Workflow'),status,error,integration,patch,...(args.arrangementContainer?[]:[recipes]),retention);
   args.arrangementContainer?.replaceChildren(recipes);
  async function refresh(){
    if(closed)return;const ticket=++refreshGeneration;
    void loadArrangements();
    const [state,inventory,patches]=await Promise.all([
      requestIndependent({action:'integration_list'}),requestIndependent({action:'retention_plan'}),requestIndependent({action:'patch_list',...(patchAfterId?{after_id:patchAfterId}:{})}),
    ]);
    if(closed||ticket!==refreshGeneration)return;
    if(state)showIntegrationReceipts((state.integrations??[]) as Reply[]);
    if(patches)installPatchList(patches,undefined,!state||!inventory);
    if(!state||!inventory){
       clearRecipe();clearAck();recipeStatus.textContent='Project access unavailable. Arrangements require an active project.';
      integrationPreview=null;patchPreview=null;candidateSelect.replaceChildren();candidateSelect.disabled=true;
      previewIntegration.disabled=true;confirmIntegration.disabled=true;previewPatch.disabled=true;confirmPatch.disabled=true;downloadPatch.disabled=true;
      previewView.replaceChildren();patchView.replaceChildren();retention.replaceChildren(el('h3','','Retention inventory'),el('p','','Active project details are unavailable. Scoped historical receipt recovery remains available where identity can be verified.'));
      status.textContent='Project access unavailable · historical receipt recovery only.';return;
    }
    if(!patches)return;
    candidateSelect.disabled=false;previewIntegration.disabled=true;previewPatch.disabled=true;
    const bearer=typeof args.token==='function'?args.token():args.token,controller=new AbortController();controllers.add(controller);let executionState:Reply|null=null;
    try{const response=await fetch('/api/workbench/execution',{method:'POST',headers:{Authorization:`Bearer ${bearer}`,'Content-Type':'application/json'},body:JSON.stringify({action:'execution_state',workspace_id:args.workspace_id,project_id:args.project_id}),signal:controller.signal});const value=await response.json() as Reply;if(response.ok&&bearer===(typeof args.token==='function'?args.token():args.token))executionState=value;}catch{}finally{controllers.delete(controller);}
    if(closed||ticket!==refreshGeneration)return;
    const reviews=executionState?.reviews as {id:string;candidate_id:string;task_id:string;decision:string}[]|undefined;
    const selected=candidateSelect.value;
    candidateSelect.replaceChildren();
    for(const review of reviews??[])if(review.decision==='approved'){const option=el('option','',`${review.candidate_id} · review ${review.id}`);option.value=`${review.candidate_id}:${review.id}:${review.task_id}`;candidateSelect.append(option);}
    const preferred=args.candidate?.();candidateSelect.value=selected||`${preferred?.id??''}:${preferred?.review_id??''}`;
     if(!candidateSelect.value&&candidateSelect.options.length)candidateSelect.selectedIndex=0;
      previewIntegration.disabled=!candidateSelect.value;previewPatch.disabled=!candidateSelect.value;
      retention.replaceChildren(el('h3','','Retention inventory'),...Object.entries((inventory.capacity??{}) as Record<string,Reply>).map(([kind,value])=>field(kind,`${value.remaining} slots remaining · ${value.active} active / ${value.limit} · ${value.archived} archived · ${value.retained} retained`)),field('Cleanup plan',inventory.reason),field('Deletions',inventory.deletions));
    if(!busy)status.textContent='Workflow ready. Actions require explicit preview and confirmation.';
  }
  void refresh();
   return {refresh,dispose(){closed=true;clearAck();if(patchPollTimer)clearTimeout(patchPollTimer);cancel();args.container.replaceChildren();args.arrangementContainer?.replaceChildren();}};
}
