import {el} from './dom';
import {workspaceId,ensureWorkspaceSynced} from './workspace-sync';
import {featureCapabilities} from '../contracts/feature-capabilities.mjs';
import type {SearchSource} from './search-client';
type Recipient={recipient_id:string;destination:string;expires_at:number;state:string;generation:number;grant:null|{source_ids:string[];verbs:string[]};remaining:{calls:number;read_bytes:number;documents:number}};

// Reusable host-owned consent surface. No main renderer or generated frame bridge.
export function mountResourceGrants(host:HTMLElement,token:()=>string){
  const root=el('details'),summary=el('summary','','Delegate selected sources to a dedicated local Hermes run');
  const notice=el('p','','Normal gateway delegation is unavailable: Orbit has not integrated a verified per-run resource channel into Normal. This advanced channel is for a dedicated one-run local adapter only. Source bytes may be disclosed to the model destination you configure. Revocation stops future access; it cannot retract content already disclosed.');
  const choices=el('div'),records=el('div'),status=el('p'),config=el('pre');status.setAttribute('role','status');
  const destination=el('input');destination.maxLength=200;destination.placeholder='Model/provider destination configured for this dedicated process';destination.setAttribute('aria-label','Delegated disclosure destination');
  const write=el('input');write.type='checkbox';const writeLabel=el('label','','Allow creating new editable briefs (no library read/update) ');writeLabel.append(write);
  let disposed=false,busy=false,epoch=0,sourceKey='';const controller=new AbortController(),selected=new Set<string>();
  async function request(action:string,fields:Record<string,unknown>={}){
    await ensureWorkspaceSynced();const credential=token(),workspace=workspaceId,version=epoch;
    if(!credential)throw Error('Unlock host access first');
    const response=await fetch('/api/resource-grants',{method:'POST',headers:{'Content-Type':'application/json',Authorization:`Bearer ${credential}`},body:JSON.stringify({action,workspace_id:workspace,...fields}),signal:controller.signal,cache:'no-store'});
    const data=await response.json();
    if(disposed||credential!==token()||workspace!==workspaceId||version!==epoch)throw Error('Host binding changed; refresh before continuing');
    if(!response.ok||data.ok!==true)throw Error(data.code??'unavailable');return data;
  }
  function button(label:string,fn:()=>Promise<void>){const b=el('button','',label);b.type='button';b.onclick=()=>{if(busy)return;busy=true;b.disabled=true;status.textContent='Working…';void fn().catch(e=>{if(!disposed)status.textContent=String(e.message??e);}).finally(()=>{busy=false;b.disabled=false;});};return b;}
  async function refresh(){const data=await request('list');records.replaceChildren();for(const r of data.recipients as Recipient[]){const row=el('div');row.append(el('p','',`${r.recipient_id} · ${r.destination} · ${r.state} · expires ${new Date(r.expires_at).toLocaleString()} · ${r.grant?.source_ids.length??0} sources · ${r.remaining.calls} calls / ${r.remaining.read_bytes} read bytes remaining`));if(!['revoked','expired','channel_offline'].includes(r.state))row.append(button('Revoke this recipient',async()=>{await request('revoke',{recipient_id:r.recipient_id});await refresh();status.textContent='Revoked. Previously disclosed bytes remain disclosed.';}));records.append(row);}status.textContent=`${data.recipients.length} dedicated recipients. Grants last at most one hour and stop on host restart.`;}
  const create=button('Grant selected sources to new dedicated recipient',async()=>{
    if(!destination.value.trim())throw Error('Name the actual configured model/provider destination');
    if(!selected.size&&!write.checked)throw Error('Select sources or enable create-new-brief authority');
    const prepared=await request('prepare',{destination:destination.value.trim()});
    config.textContent=`Dedicated local process only: resource_channel_file = ${prepared.channel_file}\nNever install this file in a shared gateway profile. No model request has been started.`;
    await request('grant',{recipient_id:prepared.recipient_id,source_ids:[...selected],verbs:[...(selected.size?['search','read_source']:[]),...(write.checked?['create_document']:[])]});
    await refresh();
  });
  const capability=featureCapabilities({audience:'owner'}).features.find(f=>f.feature_id==='knowledge-search')!;
  root.append(summary,notice,el('p','',`Knowledge readiness: ${capability.readiness}; content authority: ${capability.content.authority}. Availability is rechecked on every invocation.`),choices,destination,writeLabel,create,button('Refresh delegated recipients',refresh),status,config,records);host.append(root);
  root.ontoggle=()=>{if(root.open&&!busy)void refresh().catch(e=>{if(!disposed)status.textContent=e.message;});};
  return {updateSources(sources:SearchSource[]){const key=JSON.stringify(sources.map(s=>[s.source_id,s.content_sha256]));if(key===sourceKey)return;sourceKey=key;epoch++;for(const id of selected)if(!sources.some(s=>s.source_id===id))selected.delete(id);choices.replaceChildren();for(const source of sources){const check=el('input');check.type='checkbox';check.checked=selected.has(source.source_id);check.onchange=()=>{if(check.checked)selected.add(source.source_id);else selected.delete(source.source_id);};const label=el('label','',`${source.title} · ${source.content_sha256.slice(0,12)} `);label.append(check);choices.append(label,el('br'));}},dispose(){disposed=true;epoch++;controller.abort();root.remove();}};
}
