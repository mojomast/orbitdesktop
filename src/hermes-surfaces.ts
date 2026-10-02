import { el, button } from './dom';
import { workspaceId } from './workspace-sync';
import { requestOpenHostSurface } from './host-surfaces';
import { mountOutputLibrary } from './output-library';
function surface(title:string) {
 const d=el('dialog','hermes-tools-dialog');d.setAttribute('aria-label',title);d.style.width='min(1000px, 94vw)';
 d.append(el('h2','',title),button('Close',`Close ${title}`,()=>d.close()));d.addEventListener('close',()=>d.remove());document.body.append(d);d.showModal();return d;
}
// The shelf view (search/filter/type plus durable owner rename/pin/tags) lives in
// src/output-library.ts. These exports keep the persistent host-surface lifecycle
// and the owner shelf API stable for existing callers.
export function mountShelf(host:HTMLElement, token:()=>string, heading=true) {
 return mountOutputLibrary(host,token,heading);
}
export async function showShelf(token:()=>string) {
 const d=surface('Published apps and outputs');
 d.append(button('Open as window','Open Outputs as window',()=>{requestOpenHostSurface('outputs');d.close();}));
 const view=mountOutputLibrary(d,token,false);d.addEventListener('close',view.dispose,{once:true});await view.ready;
}
export async function showLive(token:()=>string,session:string,run:string,profileId:string,paneId:string,bindingSignal?:AbortSignal,bindingRevision=0) {
  const d=surface('Live Hermes activity');const note=el('p','','Connecting to Hermes event stream…');const log=el('div');d.append(note,log);const abort=new AbortController();d.addEventListener('close',()=>abort.abort());
  const closeForBinding = () => { abort.abort(); d.close(); };
  if(bindingSignal?.aborted) closeForBinding();
  else bindingSignal?.addEventListener('abort',closeForBinding,{once:true});
  d.addEventListener('close',()=>bindingSignal?.removeEventListener('abort',closeForBinding));
 try {
  const r=await fetch('/api/agent',{method:'POST',headers:{Authorization:`Bearer ${token()}`,'Content-Type':'application/json'},body:JSON.stringify({action:'events',workspace_id:workspaceId,pane_id:paneId,profile_id:profileId,session_id:session,run_id:run,expected_binding_revision:bindingRevision}),signal:abort.signal});if(!r.ok)throw Error((await r.json()).error);note.textContent='Live events. Closing this window does not stop the run. Chat status polling remains active.';
 const reader=r.body!.getReader();const decoder=new TextDecoder();let buffer='';
 while(d.open){const {value,done}=await reader.read();if(done)break;buffer+=decoder.decode(value,{stream:true}).replace(/\r\n/g,'\n');if(buffer.length>1000000)throw Error('Oversized event; use saved activity.');let pos;
 while((pos=buffer.indexOf('\n\n'))>=0){const block=buffer.slice(0,pos);buffer=buffer.slice(pos+2);const data=block.split('\n').filter(l=>l.startsWith('data:')).map(l=>l.slice(5).trim()).join('\n');if(!data)continue;
 const row=el('details');const event=block.split('\n').find(l=>l.startsWith('event:'))?.slice(6).trim()||'event';row.append(el('summary','',event),el('pre','',data.slice(0,12000)));log.append(row);while(log.childElementCount>150)log.firstElementChild?.remove();}
 }
 note.textContent='Stream ended. Check chat status or saved Tool activity; reconnecting does not guarantee replay.';
 }catch(e){if(d.open)note.textContent=`${e instanceof Error?e.message:'Stream disconnected'}. Chat status polling and saved Tool activity remain available.`;}finally{abort.abort();}
}
