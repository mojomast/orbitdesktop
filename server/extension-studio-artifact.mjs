import {createHash} from 'node:crypto';
export const hash=value=>createHash('sha256').update(value).digest('hex');
const escape=text=>text.replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
export function bundleDigest(files){
  const h=createHash('sha256');
  for(const name of Object.keys(files).sort()){
    const n=Buffer.from(name),b=Buffer.from(files[name]);
    for(const bytes of [n,b]){const length=Buffer.alloc(8);length.writeBigUInt64BE(BigInt(bytes.length));h.update(length);h.update(bytes);}
  }
  return h.digest('hex');
}
export function focusTimerArtifact(spec){
  return {
    'index.html':`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'none'; img-src 'none'; font-src 'none'; frame-src 'none'; worker-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'"><title>${escape(spec.title)}</title><link rel="stylesheet" href="style.css"><script src="timer.js" defer></script></head><body><main><p class="eyebrow">ORBIT / FOCUS</p><h1>${escape(spec.title)}</h1><output id="clock" aria-label="Time remaining"></output><p id="status" role="status">Ready</p><div><button id="start">Start</button><button id="reset">Reset</button></div><p class="note">Local timer. Closing or reloading resets the countdown.</p></main></body></html>`,
    'style.css':`:root{color-scheme:dark;font:16px system-ui,sans-serif;background:#10141c;color:#e8edf5;--accent:${spec.accent}}*{box-sizing:border-box}body{margin:0;padding:24px}main{max-width:480px;margin:auto}.eyebrow{color:var(--accent);font-size:.75rem;letter-spacing:.15em}h1{font-size:1.4rem;overflow-wrap:anywhere}output{display:block;font:clamp(2rem,12vw,5rem) ui-monospace,monospace;margin:20px 0}button{font:inherit;padding:12px 20px;margin:0 8px 8px 0;border:1px solid var(--accent);border-radius:8px;background:#202b3b;color:inherit}button:focus-visible{outline:3px solid var(--accent);outline-offset:3px}.note{font-size:.8rem;color:#b2bdd0}`,
    'timer.js':`'use strict';
let minutes=${spec.minutes};
try{const config=JSON.parse(decodeURIComponent(location.hash.replace(/^#orbit-config=/,'')));if(Number.isInteger(config.minutes)&&config.minutes>=1&&config.minutes<=180)minutes=config.minutes;}catch{}
let remaining=minutes*60,end=null;
const clock=document.getElementById('clock'),status=document.getElementById('status'),start=document.getElementById('start');
function render(){clock.textContent=String(Math.floor(remaining/60)).padStart(2,'0')+':'+String(remaining%60).padStart(2,'0');}
start.onclick=()=>{if(end!==null){remaining=Math.max(0,Math.ceil((end-Date.now())/1000));end=null;start.textContent='Resume';status.textContent='Paused';}else{if(remaining===0)remaining=minutes*60;end=Date.now()+remaining*1000;start.textContent='Pause';status.textContent='Focusing';}render();};
document.getElementById('reset').onclick=()=>{end=null;remaining=minutes*60;start.textContent='Start';status.textContent='Ready';render();};
setInterval(()=>{if(end===null)return;remaining=Math.max(0,Math.ceil((end-Date.now())/1000));if(remaining===0){end=null;start.textContent='Start';status.textContent='Complete';}render();},250);render();
`,
  };
}
