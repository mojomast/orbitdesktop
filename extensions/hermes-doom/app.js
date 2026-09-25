const $=id=>document.getElementById(id);let session='',polling=false;
let selectedDecision=null;
function renderDecisions(events,paused){
 if(!events.length)return;
 const follow=$('followDecisions').checked;
 const d=(!follow&&events.find(e=>e.id===selectedDecision))||events[events.length-1];selectedDecision=d.id;
 const nodes=[['Observation',`HP ${d.health??'—'} · Ammo ${d.ammo??'—'}`], [d.requested?'Jev request':'Local policy',d.requested?`${d.ms} ms`:'Frozen policy'], [d.requested?'Validation / confidence':'Local action',d.requested?(d.confidence===null?'No accepted confidence':`${Math.round(d.confidence*100)}% confidence`):d.fallback], [d.source==='jev'?'Jev selected':'Local selected',d.action]];
 $('decisionGraph').replaceChildren(...nodes.map(([title,value],i)=>{const node=document.createElement('div');node.className='decisionNode '+(d.source==='jev'?'jevNode':'localNode');const label=document.createElement('strong');label.textContent=(i?'→ ':'')+title;const detail=document.createElement('span');detail.textContent=value;node.append(label,detail);return node;}));
 $('decisionDetail').textContent=`${paused?'PAUSED · ':''}Decision #${d.id} · ${d.reason}${d.requested&&d.source!=='jev'?' · fallback: '+d.fallback:''}`;
 const list=$('decisionHistory');const scroll=list.scrollTop;
 list.replaceChildren(...events.map(e=>{const b=document.createElement('button');b.className=e.id===d.id?'selectedDecision':'';b.textContent=`#${e.id} · ${e.source.toUpperCase()} · ${e.action}`;b.onclick=()=>{$('followDecisions').checked=false;selectedDecision=e.id;renderDecisions(events,paused);};return b;}));
 list.scrollTop=follow?list.scrollHeight:scroll;
}
async function api(path,data={}){const r=await fetch('/api/'+path,{method:'POST',headers:{'Content-Type':'application/json',...(session?{Authorization:'Bearer '+session}:{})},body:JSON.stringify(data)});const result=await r.json();if(!r.ok)throw Error(result.error||'Request failed');return result;}
async function action(fn){$('error').textContent='';try{await fn();}catch(e){$('error').textContent=e.message;}}
$('unlockButton').onclick=()=>action(async()=>{const token=$('token').value;$('token').value='';const result=await api('unlock',{token});session=result.session_token;$('unlock').hidden=true;$('arena').hidden=false;poll();});
for(const id of ['start','pause','restart','local'])$(id).onclick=()=>action(()=>api(id));
$('jev').onclick=()=>action(async()=>{if(!$('consent').checked)throw Error('Explicit consent is required');const key=$('key').value;const budget=Number($('budget').value);$('key').value='';$('consent').checked=false;await api('jev',{key,budget,consent:true});});
async function poll(){if(polling)return;polling=true;try{const s=await api('status');if(s.frame)$('screen').src='data:image/jpeg;base64,'+s.frame;renderDecisions(s.decisions||[],s.paused);const g=s.game;$('gameStatus').textContent=`${s.paused?'PAUSED':'LIVE'} · ${g.mode} · ${g.current_map||'E1M1'} · HP ${g.health??'—'} · Ammo ${g.selected_weapon_ammo??'—'} · Kills ${g.kills??0} · Episode ${g.episode} · Decision ${g.tick}`;$('metrics').textContent=JSON.stringify(s.jev,null,2);$('observation').textContent=JSON.stringify(g.observation||{},null,2);if(g.mode==='error')$('error').textContent=g.message;}catch(e){$('error').textContent=e.message;}finally{polling=false;setTimeout(poll,400);}}
