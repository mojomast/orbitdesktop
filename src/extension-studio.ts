import {el,button} from './dom';
import {workspaceId,ensureWorkspaceSynced} from './workspace-sync';
import './extension-studio.css';

// Trusted owner UI. The preview receives no token, channel, data or host bridge.
export function showExtensionStudio(token:()=>string){
  const dialog=el('dialog','hermes-tools-dialog extension-studio');dialog.setAttribute('aria-label','Extension Studio');
  const status=el('p','studio-status');status.setAttribute('role','status');
  const form=el('div','studio-form'),history=el('div','studio-history'),detail=el('section','studio-detail');
  let busy=false,closed=false,epoch=0,selected:any=null,report:any=null,proposal:any=null,held=false,loaded=false;
  const retryKey=`orbit.studio.pending.${workspaceId}`;
  let pending:Record<string,unknown>|null=null;
  try{pending=JSON.parse(localStorage.getItem(retryKey)||'null');}catch{}
  const retry=button('Retry exact request','Retry exact Studio request',()=>{if(pending)void perform(pending);});
  const forget=button('Dismiss retry','Dismiss Studio retry',()=>{if(window.confirm('An earlier request may have succeeded. Keep the same draft/proposal identifiers to investigate before creating another. Dismiss this saved retry?')){pending=null;localStorage.removeItem(retryKey);controls();}});
  const inputs:Record<string,HTMLInputElement>={};
  for(const [key,label,value,type] of [['id','Plugin ID','focus-timer','text'],['title','Public widget title','Focus timer','text'],['version','Release version','1.0.0','text'],['minutes','Default minutes','25','number'],['accent','Accent color','#b5f268','color']]){
    const wrap=el('label','',label),input=el('input');input.type=type;input.value=value;input.setAttribute('aria-label',label);
    if(key==='minutes'){input.min='1';input.max='180';}inputs[key]=input;wrap.append(input);form.append(wrap);
  }
  async function api(body:Record<string,unknown>){
    const response=await fetch('/api/extension-studio',{method:'POST',headers:{Authorization:`Bearer ${token()}`,'Content-Type':'application/json'},body:JSON.stringify({workspace_id:workspaceId,...body}),signal:AbortSignal.timeout(35000)});
    const data=await response.json();if(!response.ok)throw Object.assign(Error(data.code||'Studio unavailable'),{known:response.status<500&&!['outcome_unknown','submission_unknown'].includes(data.code)});return data;
  }
  function controls(){
    generate.disabled=busy||held||!!pending;check.disabled=busy||held||!selected||selected.revoked||!!pending;
    review.disabled=busy||held||!report||!loaded||!!pending;install.disabled=busy||held||!proposal||!loaded||!!pending;
    revoke.disabled=busy||!selected||selected.revoked||!!pending;
    retry.hidden=!pending;retry.disabled=busy;forget.hidden=!pending;forget.disabled=busy;
    for(const input of Object.values(inputs))input.disabled=busy||!!pending;
    history.querySelectorAll('button').forEach(item=>{item.disabled=busy||!!pending;});
  }
  function clearPreview(){epoch++;detail.replaceChildren();report=null;proposal=null;loaded=false;controls();}
  function describeDraft(){
    if(!selected)return;
    detail.append(el('h3','',selected.manifest.title),el('p','',`Draft ${selected.id} · ${selected.profile}`),el('code','studio-digest',selected.artifact_digest),el('p','','Permissions: no host access, network, storage or model calls. Title and artifact are public static assets. Countdown state is memory-only.'));
  }
  async function refresh(){
    const data=await api({action:'list'});if(closed)return;
    held=data.recovery_policy?.held===true;history.replaceChildren();
    for(const d of data.drafts){
      const item=button(`${d.spec.title} · ${d.spec.version}${d.revoked?' · revoked':''}`,`Open Studio draft ${d.id}`,()=>{if(busy||pending)return;clearPreview();selected=d;describeDraft();controls();});
      item.disabled=busy||!!pending;history.append(item);
    }
    if(held||(selected&&data.drafts.find((d:any)=>d.id===selected.id)?.revoked)){
      if(selected)selected.revoked=!!data.drafts.find((d:any)=>d.id===selected.id)?.revoked;
      if(detail.querySelector('iframe'))clearPreview();
      report=null;proposal=null;loaded=false;
      status.textContent=held?'Recovery hold: optional previews and installs are disabled.': 'This release is revoked. Choose another draft.';
    }
    controls();
  }
  async function perform(body:Record<string,unknown>){
    if(busy)return;busy=true;
    const durable=['draft','preview','install','revoke'].includes(String(body.action));
    if(durable){pending=body;localStorage.setItem(retryKey,JSON.stringify(body));}controls();
    try{
      const data=await api(body);if(closed)return;
      if(durable){pending=null;localStorage.removeItem(retryKey);}
      if(body.action==='draft'){clearPreview();selected=data.draft;describeDraft();status.textContent='Draft generated locally. Run checks, then inspect its exact bundle.';}
      if(body.action==='check'){
        clearPreview();report=data.report;describeDraft();
        detail.append(el('p','',`Structural checks: ${report.passed?'PASS':'FAIL'}. Runtime behavior is not certified by these checks.`));
        const source=el('details');source.append(el('summary','','Review exact source files'));
        for(const [name,bytes] of Object.entries(data.files)){source.append(el('h4','',name),el('pre','',String(bytes)));}detail.append(source);
        const frame=el('iframe','studio-preview');frame.title='Exact focus timer preview';frame.setAttribute('sandbox','allow-scripts');frame.referrerPolicy='no-referrer';
        const generation=epoch;frame.addEventListener('load',()=>{if(closed||generation!==epoch)return;loaded=true;status.textContent='Preview document loaded. Inspect Start, Pause and Reset before preparing the install review.';controls();});
        frame.src=selected.manifest.entry+'#orbit-config='+encodeURIComponent(JSON.stringify(data.preview_config));detail.append(frame);
      }
      if(body.action==='preview'){
        proposal=data.proposal;
        detail.querySelector('.studio-review')?.remove();const panel=el('section','studio-review');
        panel.append(el('h3','','Exact install review'),el('p','',proposal.summary),el('p','',`Workspace revision ${proposal.base_revision} · expires ${new Date(proposal.expires_at).toLocaleTimeString()}`),el('code','studio-digest',proposal.preview_digest));
        panel.append(el('p','','Retained public configuration:'),el('pre','',JSON.stringify(proposal.preview_config,null,2)));
        const frame=detail.querySelector('iframe');if(frame){const url=selected.manifest.entry+'#orbit-config='+encodeURIComponent(JSON.stringify(proposal.preview_config));if(frame.getAttribute('src')!==url){loaded=false;frame.src=url;}}
        if(proposal.previous_manifest)panel.append(el('p','',`Previous pin: ${proposal.previous_manifest.entry}`));
        detail.append(panel);status.textContent='Review prepared. Install commits this exact artifact and layout; intervening edits cause refusal.';
      }
      if(body.action==='install'){proposal=null;status.textContent=`Installed exact artifact at workspace revision ${data.revision}${data.replayed?' (recovered receipt)':''}. Workspace sync will open it; install receipt is not browser acknowledgement.`;}
      if(body.action==='revoke'){clearPreview();if(selected)selected.revoked=true;describeDraft();status.textContent='Release revoked and its registered window disabled. Layout undo cannot re-enable it.';}
      await refresh();
    }catch(error){
      if((error as any).known&&durable){pending=null;localStorage.removeItem(retryKey);}
      status.textContent=`${String(error)}${pending?'. Outcome unknown: retry the exact saved request.':'. Refresh and prepare a new review after a stale or expired refusal.'}`;
    }finally{busy=false;controls();}
  }
  const generate=button('Generate draft','Generate focus timer draft',()=>void perform({action:'draft',operation_id:crypto.randomUUID(),spec:{id:inputs.id.value,title:inputs.title.value,version:inputs.version.value,minutes:Number(inputs.minutes.value),accent:inputs.accent.value}}));
  const check=button('Check and preview','Check exact Studio draft',()=>void perform({action:'check',draft_id:selected.id}));
  const review=button('Prepare install review','Prepare exact Studio install review',()=>void perform({action:'preview',draft_id:selected.id,operation_id:crypto.randomUUID()}));
  const install=button('Install reviewed artifact','Install exact reviewed Studio artifact',()=>{if(proposal&&window.confirm('Install the exact reviewed artifact and layout change? Existing configuration is retained on release changes.'))void perform({action:'install',proposal_id:proposal.id,artifact_digest:proposal.artifact_digest,preview_digest:proposal.preview_digest,operation_id:crypto.randomUUID(),confirm:true});});
  const revoke=button('Revoke release','Revoke Studio release',()=>{if(window.confirm('Permanently revoke this release in this workspace and disable its registered window?'))void (async()=>{try{const data=await api({action:'list'});await perform({action:'revoke',draft_id:selected.id,operation_id:crypto.randomUUID(),base_revision:data.revision,confirm:true});}catch(error){status.textContent=String(error);}})();});
  const actions=el('div','studio-actions');actions.append(generate,check,review,install,revoke,retry,forget);
  dialog.append(button('Close','Close Extension Studio',()=>dialog.close()),el('h2','','Extension Studio · Focus timer'),el('p','','Describe → Draft → Preview → Check → Review → Install. This first profile uses a finite local template, not AI generation. Choose an earlier retained draft and prepare a new review to roll back code while retaining later configuration.'),form,actions,status,el('h3','','Retained drafts and releases'),history,detail);
  const poll=window.setInterval(()=>{if(!busy&&!closed)void refresh().catch(()=>{clearPreview();status.textContent='Authorization refresh unavailable; preview detached.';});},2000);
  dialog.addEventListener('close',()=>{closed=true;epoch++;window.clearInterval(poll);dialog.remove();});
  document.body.append(dialog);dialog.showModal();controls();
  void ensureWorkspaceSynced().then(refresh).catch(error=>{status.textContent=String(error);});
}
