const $=id=>document.getElementById(id);
const fmt=n=>new Intl.NumberFormat().format(n||0);
const hermes=document.createElement('section');
for(const node of [...document.body.children]) if(node.tagName!=='SCRIPT') hermes.append(node);
document.body.prepend(hermes);
const oc=hermes.cloneNode(true);
for(const node of oc.querySelectorAll('[id]')) node.id='oc-'+node.id;
oc.querySelector('header').textContent='OPENCODE / TOKENS';
oc.querySelector('footer').innerHTML='<button id="oc-refresh" aria-label="Refresh OpenCode usage">↻ Refresh</button><span id="oc-status">Connecting…</span><br><span id="oc-sessions">—</span> · host account · all projects<br>Includes cache reads/writes; reasoning is part of output.<br>Saved session counters; not live billing.';
oc.querySelector('main > div:last-child .label').textContent='Cache writes';
oc.querySelector('main > div:nth-child(3) .label').textContent='Cache reads';
document.body.append(oc);
const periods=[['all','All time'],['24h','Last 24 hours'],['7d','Last 7 days'],['30d','Last 30 days']];
for(const [section,prefix] of [[hermes,''],[oc,'oc-']]){
 const controls=document.createElement('div');controls.className='usage-controls';
 const scope=prefix?document.createElement('span'):$('scope');
 if(prefix){scope.textContent='All projects';scope.className='scope-label';}
 const period=document.createElement('select');period.id=prefix+'period';period.setAttribute('aria-label',(prefix?'OpenCode':'Hermes')+' reporting period');
 for(const [value,label] of periods)period.add(new Option(label,value));
 try{period.value=localStorage.getItem('token-period-'+prefix)||'all';}catch{}
 if(!period.value)period.value='all';
 period.onchange=()=>{try{localStorage.setItem('token-period-'+prefix,period.value);}catch{}render();};
 controls.append(scope,period);section.querySelector('header').append(controls);
 const note=document.createElement('div');note.className='label period-note';section.querySelector('footer').append(note);
}
for(const [section,prefix] of [[hermes,''],[oc,'oc-']]){
 const details=document.createElement('details');
 const summary=document.createElement('summary');summary.textContent='Tokens by model';details.append(summary);
 const rows=document.createElement('div');rows.id=prefix+'models';rows.className='models';details.append(rows);
 const note=document.createElement('p');note.className='label';note.textContent=prefix?'Saved session model/provider; migrated sessions counted once. Model switches within a session cannot be separated.':'Attributed to saved session model; model switches within a session cannot be separated.';details.append(note);
 section.insertBefore(details,section.querySelector('footer'));
}
let data;
function paint(d,prefix){
 const id=k=>$(prefix+k);
 if(!d || d.available===false){for(const k of ['total','input','output','cached','calls','sessions'])id(k).textContent='—';id('status').textContent='OpenCode usage unavailable';id('models').replaceChildren();return;}
 const totalOf=m=>(m.input||0)+(m.output||0)+(prefix?(m.cached||0)+(m.cache_write||0):0);
 const total=totalOf(d);id('total').textContent=fmt(total);
 for(const k of ['input','output','cached','calls'])id(k).textContent=fmt(d[prefix&&k==='calls'?'cache_write':k]);
 id('inbar').style.width=(total?100*(total-d.output)/total:0)+'%';id('outbar').style.width=(total?100*d.output/total:0)+'%';
 id('sessions').textContent=fmt(d.sessions)+' sessions';
 const age=Math.max(0,Math.floor(Date.now()/1000-data.updated_at));
 id('status').textContent=age>60?'Stale · '+age+'s old':'Updated '+new Date(data.updated_at*1000).toLocaleTimeString();id('status').style.color=age>60?'#ffc878':'#65dfd0';
 id('models').replaceChildren(...(d.models||[]).map(m=>{
  const row=document.createElement('div');row.className='model';row.textContent=m.model+(m.provider?' · '+m.provider:'')+' — '+fmt(totalOf(m));
  const stats=document.createElement('span');stats.textContent='In '+fmt(m.input)+' · Out '+fmt(m.output)+' · Cache read '+fmt(m.cached)+(prefix?' · Cache write '+fmt(m.cache_write):'')+' · Reasoning '+fmt(m.reasoning);row.append(stats);return row;
 }));
 if(!d.models?.length)id('models').textContent='No recorded usage.';
}
function render(){if(!data)return;for(const [section,prefix] of [[hermes,''],[oc,'oc-']]){const period=$(prefix+'period').value;const selected=period==='all'?data:data.periods?.[period];paint(selected?.[prefix?'opencode':$('scope').value],prefix);section.querySelector('section > .label').textContent='RECORDED TOKENS · '+periods.find(p=>p[0]===period)[1].toUpperCase();section.querySelector('.period-note').textContent=period==='all'?'':'Lifetime totals of sessions started in this rolling period; not exact usage within the period.';}}
async function refresh(){try{const r=await fetch('./usage.json?t='+Date.now(),{cache:'no-store',credentials:'omit'});if(!r.ok)throw Error();data=await r.json();render();}catch{for(const prefix of ['','oc-']){$(prefix+'status').textContent='Usage unavailable · retrying';$(prefix+'status').style.color='#ffc878';}}}
$('scope').onchange=render;$('refresh').onclick=refresh;$('oc-refresh').onclick=refresh;refresh();setInterval(refresh,15000);
