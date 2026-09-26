import {button, el} from './dom';

type Reply = Record<string, unknown>;
type Preview = {preview_id:string;preview_digest:string;expires_at:number};
export function mountWorkbenchWorkflow(args:{container:HTMLElement;token:string|(()=>string);workspace_id:string;project_id:string;candidate?:()=>{id:string;review_id:string}|null;onError?:(message:string)=>void}):{refresh():Promise<void>;dispose():void}{
  const status=el('p','','Workflow: loading…');status.setAttribute('role','status');
  const error=el('p');error.setAttribute('role','alert');
  const integration=el('section'),recipes=el('section'),retention=el('section');
  const candidateSelect=el('select');candidateSelect.setAttribute('aria-label','Approved candidate and review');
  const previewView=el('div'),recipeView=el('div');
  let integrationPreview:Preview|null=null,recipePreview:Preview|null=null,recipeName:'project_focus'|'investigate'|'implement'|'review'|'return'='project_focus';
  let integrationOperation='';
  let closed=false,busy=false,epoch=0;const controllers=new Set<AbortController>();
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
  function previewRecipe(recipe:'project_focus'|'investigate'|'implement'|'review'|'return'){
    void act('Recipe preview',{action:'recipe_preview',recipe},reply=>{
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
  candidateSelect.addEventListener('change',()=>{integrationPreview=null;confirmIntegration.disabled=true;previewView.replaceChildren();});
  integration.append(el('h3','','Private Git integration'),candidateSelect,previewIntegration,previewView,confirmIntegration);
  recipes.append(el('h3','','Workspace arrangements'),button('Preview Investigate','Preview Investigate arrangement',()=>previewRecipe('investigate')),button('Preview Implement','Preview Implement arrangement',()=>previewRecipe('implement')),button('Preview Review','Preview Review arrangement',()=>previewRecipe('review')),button('Preview return','Restore the previously saved window order',()=>previewRecipe('return')),recipeView,applyRecipe);
  retention.append(el('h3','','Retention inventory'));
  args.container.replaceChildren(el('h2','','Workflow'),status,error,integration,recipes,retention);
  async function refresh(){
    if(closed||busy)return;
    const ticket=++epoch;
    const [state,inventory]=await Promise.all([request({action:'integration_list'},ticket),request({action:'retention_plan'},ticket)]);
    if(!state||!inventory||closed||ticket!==epoch)return;
    const reviews=(await (async()=>{
      const controller=new AbortController();controllers.add(controller);
      try{const response=await fetch('/api/workbench/execution',{method:'POST',headers:{Authorization:`Bearer ${typeof args.token==='function'?args.token():args.token}`,'Content-Type':'application/json'},body:JSON.stringify({action:'execution_state',workspace_id:args.workspace_id,project_id:args.project_id}),signal:controller.signal});return response.ok?await response.json() as Reply:null;}catch{return null;}finally{controllers.delete(controller);}
    })())?.reviews as {id:string;candidate_id:string;decision:string}[]|undefined;
    if(closed||ticket!==epoch)return;
    const selected=candidateSelect.value;
    candidateSelect.replaceChildren();
    for(const review of reviews??[])if(review.decision==='approved'){const option=el('option','',`${review.candidate_id} · review ${review.id}`);option.value=`${review.candidate_id}:${review.id}`;candidateSelect.append(option);}
    const preferred=args.candidate?.();candidateSelect.value=selected||`${preferred?.id??''}:${preferred?.review_id??''}`;
    if(!candidateSelect.value&&candidateSelect.options.length)candidateSelect.selectedIndex=0;
    previewIntegration.disabled=!candidateSelect.value;
    retention.replaceChildren(el('h3','','Retention inventory'),field('Private record counts',inventory.counts),field('Private integration artifacts',state.integrations),field('Cleanup plan',inventory.reason),field('Deletions',inventory.deletions));
    status.textContent='Workflow ready. Actions require explicit preview and confirmation.';
  }
  void refresh();
  return {refresh,dispose(){closed=true;cancel();args.container.replaceChildren();}};
}
