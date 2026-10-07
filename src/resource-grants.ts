import {el} from './dom';
import {workspaceId,ensureWorkspaceSynced} from './workspace-sync';
import {featureCapabilities} from '../contracts/feature-capabilities.mjs';
import type {SearchSource} from './search-client';
type PermissionRequest={request_id:string;need:string;reason:string;verb:string|null;state:string;created_at:number;decided_at:number|null};
type Recipient={recipient_id:string;destination:string;expires_at:number;state:string;generation:number;grant:null|{source_ids:string[];verbs:string[]};operations?:{op_id:string;document_id:string;request_digest:string;outcome:string}[];permission_requests?:PermissionRequest[];remaining:{calls:number;read_bytes:number;documents:number;permission_requests?:number}};
type NormalRecipient={pane_id:string;profile_id:string;profile_label:string;session_id:string;binding_revision:number;destination:string;adapter_directory:string;hermes_profile:string};

// Reusable host-owned consent surface. No main renderer or generated frame bridge.
export function mountResourceGrants(host:HTMLElement,token:()=>string){
  const root=el('details'),summary=el('summary','','Delegate selected sources to Hermes');
  const notice=el('p','','Normal gateway delegation is unavailable until a pinned local profile adapter is configured. The dedicated adapter remains available below. Revocation stops future access; it cannot retract content already disclosed.');
  const choices=el('div'),records=el('div'),status=el('p'),config=el('pre');status.setAttribute('role','status');
  const destination=el('input');destination.maxLength=200;destination.placeholder='Model/provider destination configured for this dedicated process';destination.setAttribute('aria-label','Delegated disclosure destination');
  const recipientSelect=el('select');recipientSelect.setAttribute('aria-label','Resource recipient conversation');
  let normalRecipients:NormalRecipient[]=[];
  function selectedNormal(){return normalRecipients.find(r=>r.pane_id===recipientSelect.value);}
  recipientSelect.onchange=()=>{destination.hidden=!!selectedNormal();};
  const write=el('input');write.type='checkbox';const writeLabel=el('label','','Allow creating new editable documents and canvases (create only) ');writeLabel.append(write);
  const content=el('input');content.type='checkbox';const contentLabel=el('label','','Allow reading this workspace\u2019s document library (list/read) ');contentLabel.append(content);
  const revise=el('input');revise.type='checkbox';const reviseLabel=el('label','','Allow revision-bound edits to existing documents ');reviseLabel.append(revise);
  const ask=el('input');ask.type='checkbox';const askLabel=el('label','','Allow the agent to ask you for additional permission ');askLabel.append(ask);
  let disposed=false,busy=false,epoch=0,sourceKey='';const controller=new AbortController(),selected=new Set<string>();
  let historyAfter:string|undefined,nextHistory:string|null=null;
  async function request(action:string,fields:Record<string,unknown>={}){
    await ensureWorkspaceSynced();const credential=token(),workspace=workspaceId,version=epoch;
    if(!credential)throw Error('Unlock host access first');
    const response=await fetch('/api/resource-grants',{method:'POST',headers:{'Content-Type':'application/json',Authorization:`Bearer ${credential}`},body:JSON.stringify({action,workspace_id:workspace,...fields}),signal:controller.signal,cache:'no-store'});
    const data=await response.json();
    if(disposed||credential!==token()||workspace!==workspaceId||version!==epoch)throw Error('Host binding changed; refresh before continuing');
    if(!response.ok||data.ok!==true)throw Error(data.code??'unavailable');return data;
  }
  function button(label:string,fn:()=>Promise<void>){const b=el('button','',label);b.type='button';b.onclick=()=>{if(busy)return;busy=true;b.disabled=true;status.textContent='Working…';void fn().catch(e=>{if(!disposed)status.textContent=String(e.message??e);}).finally(()=>{busy=false;b.disabled=false;});};return b;}
  async function refresh(after?:string){
    const data=await request('list',after?{history_after:after}:{}),previous=recipientSelect.value;
    historyAfter=after;nextHistory=data.history?.next_after??null;
    normalRecipients=data.normal_recipients??[];recipientSelect.replaceChildren();
    for(const r of normalRecipients){const option=el('option','',`${r.profile_label} · ${r.session_id} · pane ${r.pane_id} → ${r.destination}`);option.value=r.pane_id;recipientSelect.append(option);}
    const local=el('option','','Dedicated local adapter (advanced)');local.value='';recipientSelect.append(local);
    if(previous&&normalRecipients.some(r=>r.pane_id===previous))recipientSelect.value=previous;
    destination.hidden=!!selectedNormal();
    notice.textContent=normalRecipients.length
      ? 'Select a real Normal conversation. Requires the configured pinned local gateway adapter. Consent applies only to its next accepted run, exact profile/session and current pane generation. Source content goes to the configured gateway and its model provider. Switching conversations, revocation, expiry and host restart prevent access; previously disclosed bytes cannot be retracted.'
      : 'Normal gateway delegation is unavailable until a pinned local profile adapter is configured. The dedicated adapter remains available below. Revocation stops future access; it cannot retract content already disclosed.';
    records.replaceChildren();
    for(const r of data.recipients as Recipient[]){
      const row=el('div');row.append(el('p','',`${r.recipient_id} · ${r.destination} · ${r.state} · expires ${new Date(r.expires_at).toLocaleString()} · ${r.grant?.source_ids.length??0} sources · ${r.remaining.calls} calls / ${r.remaining.read_bytes} read bytes remaining`));
      if(['granted','awaiting_grant','awaiting_next_normal_run'].includes(r.state))row.append(button('Revoke this recipient',async()=>{await request('revoke',{recipient_id:r.recipient_id});await refresh(historyAfter);status.textContent+=' Revoked. Previously disclosed bytes remain disclosed.';}));
      if(r.operations?.length){const receipts=el('details');receipts.append(el('summary','','Retained operation receipts'));for(const op of r.operations)receipts.append(el('p','',`${op.op_id} · ${op.outcome} · document ${op.document_id} · request ${op.request_digest}`));row.append(receipts);}
      const pending=(r.permission_requests??[]).filter(q=>q.state==='pending');
      if(r.permission_requests?.length){
        const requests=el('details');requests.append(el('summary','',`Permission requests (${pending.length} awaiting your decision)`));
        for(const q of r.permission_requests){
          const line=el('div');line.append(el('p','',`${q.need} · ${q.state}${q.verb?` · grants ${q.verb}`:' · no delegated verb for this capability'}`),el('p','',q.reason));
          // Approval widens verbs on this live grant only. A capability with no
          // delegated implementation is never offered as if it would be granted.
          if(q.state==='pending'&&q.verb&&['granted','awaiting_next_normal_run'].includes(r.state))
            line.append(button(`Approve ${q.need}`,async()=>{await request('approve_permission',{recipient_id:r.recipient_id,request_id:q.request_id,expected_generation:r.generation});await refresh(historyAfter);status.textContent+=' Approved. The agent can use this verb on its current run grant only.';}));
          if(q.state==='pending')line.append(button(`Deny ${q.need}`,async()=>{await request('deny_permission',{recipient_id:r.recipient_id,request_id:q.request_id,expected_generation:r.generation});await refresh(historyAfter);status.textContent+=' Denied.';}));
          requests.append(line);
        }
        row.append(requests);
      }
      records.append(row);
    }
    const capacity=data.capacity;
    status.textContent=`${data.recipients.length} resource recipients shown. ${capacity.active_channels}/${capacity.limit} active or closing channels (${capacity.closing_channels} finishing); ${capacity.available_slots} slots available. ${capacity.retained_records} retained records; ${data.history.shown} of ${data.history.total} historical records on this page. History does not consume live capacity. Grants last at most one hour and stop on host restart.`;
    moreHistory.hidden=!nextHistory;firstHistory.hidden=!historyAfter;
  }
  const create=button('Grant selected sources to selected recipient',async()=>{
    const normal=selectedNormal();
    if(!normal&&!destination.value.trim())throw Error('Name the actual configured model/provider destination');
    if(!selected.size&&!write.checked&&!content.checked&&!revise.checked&&!ask.checked)throw Error('Select sources or enable at least one capability');
    const prepared=normal?await request('prepare_normal',{pane_id:normal.pane_id,expected_binding_revision:normal.binding_revision}):await request('prepare',{destination:destination.value.trim()});
    config.textContent=normal?`Next accepted Normal run only. Gateway adapter setup: normal_resource_directory = ${normal.adapter_directory}; upstream Hermes profile = ${JSON.stringify(normal.hermes_profile)}. This setting is a directory locator, not a grant credential. No message was sent.`:`Dedicated local process only: resource_channel_file = ${prepared.channel_file}\nNever install this file in a shared gateway profile. No model request has been started.`;
    // Richer verbs are opt-in so a grant stays as narrow as the owner asked for.
    const extra=[...(content.checked?['list_documents','read_document']:[]),...(revise.checked?['revise_document']:[]),...(ask.checked?['request_permission']:[])];
    await request('grant',{recipient_id:prepared.recipient_id,source_ids:[...selected],verbs:[...(selected.size?['search','read_source']:[]),...(write.checked?['create_document']:[]),...extra]});
    await refresh();
  });
  const capability=featureCapabilities({audience:'owner'}).features.find(f=>f.feature_id==='knowledge-search')!;
  const moreHistory=button('Next retained history page',async()=>{if(nextHistory)await refresh(nextHistory);});moreHistory.hidden=true;
  const firstHistory=button('First retained history page',()=>refresh());firstHistory.hidden=true;
  root.append(summary,notice,el('p','',`Knowledge readiness: ${capability.readiness.detail}; content authority: ${capability.content.authority}. Availability is rechecked on every invocation.`),choices,recipientSelect,destination,writeLabel,contentLabel,reviseLabel,askLabel,create,button('Refresh delegated recipients',()=>refresh()),status,config,records,firstHistory,moreHistory);host.append(root);
  root.ontoggle=()=>{if(root.open&&!busy)void refresh().catch(e=>{if(!disposed)status.textContent=e.message;});};
  return {updateSources(sources:SearchSource[]){const key=JSON.stringify(sources.map(s=>[s.source_id,s.content_sha256]));if(key===sourceKey)return;sourceKey=key;epoch++;for(const id of selected)if(!sources.some(s=>s.source_id===id))selected.delete(id);choices.replaceChildren();for(const source of sources){const check=el('input');check.type='checkbox';check.checked=selected.has(source.source_id);check.onchange=()=>{if(check.checked)selected.add(source.source_id);else selected.delete(source.source_id);};const label=el('label','',`${source.title} · ${source.content_sha256.slice(0,12)} `);label.append(check);choices.append(label,el('br'));}},dispose(){disposed=true;epoch++;controller.abort();root.remove();}};
}
