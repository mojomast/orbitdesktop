import {el,button} from './dom';
import {copyPasswordButton} from './connection-passwords';
export async function showSharedBrowser(_api:(body:Record<string,unknown>)=>Promise<any>){
 window.dispatchEvent(new Event('orbit-open-shared-browser'));
}
export function mountSharedBrowser(host:HTMLElement,token:()=>string,paneId:string){
 let disposed=false;const abort=new AbortController();
 host.style.cssText='display:flex;flex-direction:column;min-height:0;height:100%';
 const note=el('p','','Connect host to load shared Chromium.');note.style.margin='4px';
 const frame=el('iframe');frame.title='Shared Chromium desktop';frame.referrerPolicy='no-referrer';frame.style.cssText='flex:1;min-height:0;width:100%;border:0';
 const connect=button('Connect viewer','Connect shared Chromium viewer',()=>{void load();});
 host.replaceChildren(note,copyPasswordButton('chromium',token),connect,frame);
 async function load(){
  if(!token()||disposed)return;connect.disabled=true;
  try{const r=await fetch('/api/agent',{method:'POST',headers:{'Content-Type':'application/json',Authorization:`Bearer ${token()}`},body:JSON.stringify({action:'shared_browser_connection',session_id:`orbit-${paneId}`}),signal:abort.signal});const data=await r.json();if(!r.ok)throw Error(data.error||'Connection failed');if(disposed)return;note.textContent='Shared with Hermes · Closing this window leaves Chromium running';frame.src=data.url;connect.hidden=true;}
  catch(e){if(!disposed)note.textContent=String(e);}finally{connect.disabled=false;}
 }
 const onConnect=()=>{if(!frame.getAttribute('src'))void load();};window.addEventListener('orbit-host-connected',onConnect);void load();
 return ()=>{disposed=true;abort.abort();window.removeEventListener('orbit-host-connected',onConnect);};
}
