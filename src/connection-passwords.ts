import {el,button} from './dom';
export function copyPasswordButton(service:'chromium'|'xpra', token:()=>string) {
 const label=service==='chromium'?'Copy Chromium password':'Copy Xpra password';
 const b=button(label,label,()=>{
  if(!token()){b.textContent='Unlock host first';return;}
  b.disabled=true;
  const secret=fetch('/api/agent',{method:'POST',cache:'no-store',headers:{'Content-Type':'application/json',Authorization:`Bearer ${token()}`},body:JSON.stringify({action:'connection_password',service,session_id:`orbit-${crypto.randomUUID()}`})}).then(async r=>{if(!r.ok)throw Error('Unavailable');const d=await r.json();if(typeof d.password!=='string')throw Error('Unavailable');return d.password as string;});
  // Start clipboard access in the click gesture, including browsers requiring transient activation.
  const task=typeof ClipboardItem!=='undefined'?navigator.clipboard.write([new ClipboardItem({'text/plain':secret.then(s=>new Blob([s],{type:'text/plain'}))})]):secret.then(s=>navigator.clipboard.writeText(s));
  void secret.catch(()=>{});
  void task.then(()=>{b.textContent='Copied';},()=>{b.textContent='Copy failed — unlock host / allow clipboard';}).finally(()=>{b.disabled=false;});
 });return b;
}
export function showConnectionPasswords(token:()=>string){
 const d=el('dialog','hermes-tools-dialog');d.setAttribute('aria-label','Connection passwords');
 d.append(el('h2','','Connection passwords'),el('p','','Copy a login password without displaying it. Clipboard history and other apps may retain copied passwords.'),copyPasswordButton('chromium',token),copyPasswordButton('xpra',token),button('Close','Close connection passwords',()=>d.close()));
 d.addEventListener('close',()=>d.remove());document.body.append(d);d.showModal();
}
