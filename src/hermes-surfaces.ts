import { el, button } from './dom';
import { workspaceId, ensureWorkspaceSynced } from './workspace-sync';
function surface(title:string) {
 const d=el('dialog','hermes-tools-dialog');d.setAttribute('aria-label',title);d.style.width='min(1000px, 94vw)';
 d.append(el('h2','',title),button('Close',`Close ${title}`,()=>d.close()));d.addEventListener('close',()=>d.remove());document.body.append(d);d.showModal();return d;
}
export async function showShelf(token:()=>string) {
 const d=surface('Published apps and outputs');const list=el('div');const note=el('p','','Only deliberately published app folders are indexed. Up to 300 files.');d.append(note,list);
 async function load(){try{
 await ensureWorkspaceSynced();const r=await fetch('/api/workspace',{method:'POST',headers:{Authorization:`Bearer ${token()}`,'Content-Type':'application/json'},body:JSON.stringify({action:'shelf',workspace_id:workspaceId})});const data=await r.json();if(!r.ok)throw Error(data.error);if(!d.open)return;list.replaceChildren();
 for(const item of data.items){list.append(button(item.title,`Open published ${item.title}`,()=>{const preview=surface(item.title);const frame=el('iframe');frame.title=item.title;frame.setAttribute('sandbox','allow-scripts allow-forms allow-downloads');frame.src=item.url;frame.style.cssText='width:100%;height:65vh;border:0;background:white';preview.append(frame);const link=el('a','','Download file');link.href=item.url;link.download='';preview.append(link);}));}
 if(!data.items.length)list.textContent='No published outputs yet.';
 }catch(e){note.textContent=e instanceof Error?e.message:'Shelf unavailable';}}
 d.append(button('Refresh','Refresh published outputs',()=>{void load();}));await load();
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
