const $ = id => document.getElementById(id);
const defaults = {theme:'nebula',layout:'stacked',scale:'normal',refresh:2,rows:5,grouping:'apps',activity:true,resources:true,cores:true,processes:true,hermes:true,opencode:true,trends:true,period:'all',scope:'profile',collapsed:false,border:true};
const choices = {theme:['nebula','graphite','mint','paper','glass'],layout:['stacked','columns','compact'],scale:['small','normal','large'],refresh:[2,5,10],rows:[3,5,8],grouping:['apps','processes'],period:['all','24h','7d','30d'],scope:['profile','orbit']};
let prefs={...defaults},data,paused=false,timer,fetching=false,lastHost=0,lastRate=0;
const history={cpu:[],tokens:[]};
function validate(raw){const result={...defaults};for(const key of Object.keys(defaults)){if(choices[key]?.includes(raw[key]) || typeof defaults[key]==='boolean' && typeof raw[key]==='boolean')result[key]=raw[key];}return result;}
try{prefs=validate(JSON.parse(localStorage.getItem('orbit-pulse-v1')||'{}'));}catch{}
function save(){try{localStorage.setItem('orbit-pulse-v1',JSON.stringify(prefs));$('saved').textContent='Preferences saved on this browser.';}catch{$('saved').textContent='Browser storage unavailable; changes last for this view only.';}}
const fmt=n=>typeof n==='number'&&Number.isFinite(n)?new Intl.NumberFormat(undefined,{maximumFractionDigits:1}).format(n):'—';
const compact=n=>typeof n==='number'?new Intl.NumberFormat(undefined,{notation:'compact',maximumFractionDigits:1}).format(n):'—';
const bytes=n=>typeof n==='number'?(n>=1073741824?(n/1073741824).toFixed(1)+' GiB':(n/1048576).toFixed(0)+' MiB'):'—';
const age=stamp=>typeof stamp==='number'?Math.max(0,Date.now()/1000-stamp):Infinity;
const pct=n=>typeof n==='number'?fmt(n)+'%':'—';
function text(id,value){$(id).textContent=value;}
function applyPrefs(){
 document.body.dataset.border=String(prefs.border);
 $('border-toggle').textContent=prefs.border?'Hide border':'Show border';
 $('border-toggle').setAttribute('aria-pressed',String(!prefs.border));
 $('border-toggle').onclick=()=>{prefs.border=!prefs.border;save();applyPrefs();};
 document.body.dataset.theme=prefs.theme;document.body.dataset.layout=prefs.layout;document.body.dataset.scale=prefs.scale;
 document.body.classList.toggle('collapsed',prefs.collapsed);$('collapse').textContent=prefs.collapsed?'+':'−';$('collapse').setAttribute('aria-expanded',String(!prefs.collapsed));$('collapse').setAttribute('aria-label',prefs.collapsed?'Expand telemetry':'Collapse telemetry');
 for(const [key,id] of Object.entries({theme:'theme',layout:'layout',scale:'scale',refresh:'refresh-rate',rows:'rows',grouping:'grouping',period:'period',scope:'scope'}))$(id).value=String(prefs[key]);
 for(const key of ['activity','resources','processes'])$(key).hidden=!prefs[key];
 $('core-section').hidden=!prefs.cores;$('tokens').hidden=!prefs.hermes&&!prefs.opencode;$('hermes-tokens').hidden=!prefs.hermes;$('opencode-tokens').hidden=!prefs.opencode;
 document.querySelector('.token-grids').style.gridTemplateColumns=prefs.hermes&&prefs.opencode?'':'1fr';
 document.querySelectorAll('.chart').forEach(e=>e.hidden=!prefs.trends);
 for(const input of $('toggles').querySelectorAll('input'))input.checked=prefs[input.dataset.key];
 clearInterval(timer);timer=setInterval(refresh,prefs.refresh*1000);render();
}
for(const [key,label] of Object.entries({activity:'Request activity',resources:'Host resources',cores:'Per-core load',processes:'Top consumers',hermes:'Hermes tokens',opencode:'OpenCode tokens',trends:'Trend lines'})){
 const l=document.createElement('label'),i=document.createElement('input');i.type='checkbox';i.dataset.key=key;i.onchange=()=>{prefs[key]=i.checked;save();applyPrefs();};l.append(i,document.createTextNode(' '+label));$('toggles').append(l);
}
for(const [key,id] of Object.entries({theme:'theme',layout:'layout',scale:'scale',refresh:'refresh-rate',rows:'rows',grouping:'grouping',period:'period',scope:'scope'}))$(id).onchange=()=>{if(key==='scope'){history.tokens=[];lastRate=0;}prefs[key]=['refresh','rows'].includes(key)?Number($(id).value):$(id).value;save();applyPrefs();};
$('settings-toggle').onclick=()=>{prefs.collapsed=false;$('settings').hidden=!$('settings').hidden;$('settings-toggle').setAttribute('aria-expanded',String(!$('settings').hidden));applyPrefs();};
$('collapse').onclick=()=>{prefs.collapsed=!prefs.collapsed;save();applyPrefs();};
$('reset').onclick=()=>{prefs={...defaults};save();applyPrefs();};
$('pause').onclick=()=>{paused=!paused;$('pause').textContent=paused?'▶':'Ⅱ';$('pause').setAttribute('aria-label',paused?'Resume telemetry updates':'Pause telemetry updates');if(!paused)refresh();else text('status','Paused');};
function chart(id,values,max){const usable=values.filter(n=>typeof n==='number');const top=max||Math.max(1,...usable);const height=id==='cpu-chart'?30:38;$(id).querySelector('polyline').setAttribute('points',values.map((n,i)=>`${i*500/Math.max(1,values.length-1)},${height-2-(n||0)/top*(height-4)}`).join(' '));}
function push(array,value){array.push(value);if(array.length>60)array.shift();}
function processes(id,rows,key){$(id).replaceChildren(...(rows||[]).slice(0,prefs.rows).map(p=>{const row=document.createElement('div');row.className='consumer-card';const name=document.createElement('span');name.className='process-name';name.textContent=p.name;name.title=p.name;const pid=document.createElement('small');pid.textContent=p.count!==undefined?p.count+' processes':'PID '+p.pid;name.append(pid);const value=document.createElement('strong');value.textContent=key==='rss'?bytes(p.rss):pct(p.cpu_percent);row.append(name,value);return row;}));}
function paintTokens(d,prefix){
 const totalId=prefix?'oc-total':'total', valuesId=prefix?'opencode-values':'hermes-values',modelsId=prefix?'oc-models':'models';
 if(!d||d.available===false){text(totalId,'—');text(valuesId,'Counters unavailable');$(modelsId).replaceChildren();return;}
 const total=m=>(m.input||0)+(m.output||0)+(prefix?(m.cached||0)+(m.cache_write||0):0);
 text(totalId,compact(total(d)));$(totalId).title=fmt(total(d))+' recorded tokens';
 $(valuesId).replaceChildren(...[['Input',d.input],['Output',d.output],['Cache reads',d.cached],[prefix?'Cache writes':'API calls',prefix?d.cache_write:d.calls]].map(([label,value])=>{const node=document.createElement('div'),l=document.createElement('label'),v=document.createElement('b');l.textContent=label;v.textContent=compact(value);v.title=fmt(value);node.append(l,v);return node;}));
 $(modelsId).replaceChildren(...(d.models||[]).map(m=>{const card=document.createElement('article');card.className='model-card';const name=document.createElement('strong');name.className='model-name';name.textContent=m.model;const provider=document.createElement('small');provider.className='model-provider';provider.textContent=m.provider||'Provider not recorded';const sum=document.createElement('div');sum.className='model-total';sum.textContent=compact(total(m))+' tokens';sum.title=fmt(total(m))+' recorded tokens';const metrics=document.createElement('div');metrics.className='model-metrics';for(const [label,value] of [['Input',m.input],['Output',m.output],['Cache reads',m.cached],...(prefix?[['Cache writes',m.cache_write]]:[]),['Reasoning',m.reasoning]]){const item=document.createElement('div'),l=document.createElement('span'),v=document.createElement('b');l.textContent=label;v.textContent=compact(value);v.title=fmt(value);item.append(l,v);metrics.append(item);}card.append(name,provider,sum,metrics);return card;}));
}
function render(){
 if(!data)return;
 const h=data.host||{},g=data.gateway||{},u=data.usage||{},r=data.rates||{};
 const staleHost=age(h.updated_at)>12,staleGateway=age(g.updated_at)>15,staleUsage=age(u.updated_at)>60;
 text('host-age',staleHost?'Host sample stale / unavailable':'Linux host · '+Math.floor(age(h.updated_at))+'s ago');
 text('inflight',!staleGateway&&g.available?fmt(g.in_flight):'—');
 const oc=data.opencode_activity||{}, ocLive=oc.available&&age(oc.updated_at)<15;
 text('oc-active',ocLive?fmt(oc.possibly_active):'—');
 text('oc-tps',!staleUsage?fmt(r.scopes?.opencode?.output_per_second):'—');
 text('oc-input-rate',!staleUsage?compact(r.scopes?.opencode?.input_per_second):'—');
 text('oc-activity-note',ocLive?`${fmt(oc.recent_sessions)} recently updated sessions · latest 100 V2 sessions · live HTTP count unavailable`:'OpenCode activity unavailable / stale');
 $('active-routes').replaceChildren(...(ocLive?oc.routes||[]:[]).map(route=>{const e=document.createElement('div');e.className='model';e.textContent=route.provider+' / '+route.model;const s=document.createElement('small');s.textContent=(route.endpoint||'Endpoint unavailable')+` · ${route.possibly_active} active candidates · ${route.recent_sessions} recent · ${Math.floor(age(route.last_updated)/60)}m since saved update`;e.append(s);return e;}));
 const rate=r.scopes?.[prefs.scope];text('tps',!staleUsage?fmt(rate?.output_per_second):'—');text('input-rate',!staleUsage?compact(rate?.input_per_second):'—');
 text('rate-note',staleUsage?'Token feed stale / unavailable; rate withheld.':r.window_seconds>0?`Hermes ${prefs.scope==='orbit'?'Orbit chats':'all profiles'} · ${fmt(r.window_seconds)}s recorded-rate window · counter age ${Math.floor(age(u.updated_at))}s`:'Warming up: waiting for two saved-counter samples.');
 if(!staleHost){
  text('cpu',pct(h.cpu_percent));text('ram',bytes(h.memory_used));text('ram-caption','of '+bytes(h.memory_total)+' RAM');text('load',fmt(h.load?.[0]));
  $('ram-bar').style.width=(h.memory_total?100*h.memory_used/h.memory_total:0)+'%';text('memory-detail',bytes(h.memory_available)+' available');text('swap','Swap '+bytes(h.swap_used)+' / '+bytes(h.swap_total));text('loads','Load averages · 1m '+fmt(h.load?.[0])+' / 5m '+fmt(h.load?.[1])+' / 15m '+fmt(h.load?.[2]));
  $('cores').replaceChildren(...(h.cores||[]).map(c=>{const e=document.createElement('div');e.className='core'+(c.percent>80?' hot':'');e.textContent='CPU '+c.id;const b=document.createElement('b');b.textContent=pct(c.percent);const i=document.createElement('i');i.style.width=(c.percent||0)+'%';e.append(b,i);return e;}));
  processes('top-cpu',prefs.grouping==='apps'?h.top_apps_cpu:h.top_cpu,'cpu_percent');processes('top-memory',prefs.grouping==='apps'?h.top_apps_memory:h.top_memory,'rss');text('process-count',fmt(h.process_count)+' processes'+(h.unreadable_processes?' · '+h.unreadable_processes+' unreadable':''));
 }else{for(const id of ['cpu','ram','load','memory-detail','swap','loads'])text(id,'—');$('ram-bar').style.width='0%';$('cores').replaceChildren();$('top-cpu').replaceChildren();$('top-memory').replaceChildren();text('process-count','Unavailable');}
 const selected=prefs.period==='all'?u:u.periods?.[prefs.period];paintTokens(selected?.[prefs.scope],false);paintTokens(selected?.opencode,true);
 text('period-note',prefs.period==='all'?'Lifetime saved totals.':'Lifetime totals of sessions started in this rolling period—not exact usage during the period.');text('usage-age',(staleUsage?'STALE / UNAVAILABLE · ':'')+'Saved counters, not billing data · '+(Number.isFinite(age(u.updated_at))?Math.floor(age(u.updated_at))+'s old':'no sample')+' · refreshed every 15s');
 if(h.updated_at!==lastHost&&!staleHost){lastHost=h.updated_at;push(history.cpu,h.cpu_percent);}
 if(r.updated_at!==lastRate&&!staleUsage){lastRate=r.updated_at;push(history.tokens,rate?.output_per_second);}
 chart('cpu-chart',history.cpu,100);chart('token-chart',history.tokens);
 document.body.classList.toggle('offline',staleHost||staleGateway||staleUsage);text('status',paused?'Paused':staleHost||staleGateway||staleUsage?'Partial / stale':'Live · '+prefs.refresh+'s');
}
async function refresh(){
 if(paused||fetching||document.hidden)return;fetching=true;
 try{const res=await fetch('./api/metrics',{cache:'no-store',signal:AbortSignal.timeout(8000)});if(!res.ok)throw Error();data=await res.json();render();}
 catch{for(const id of ['oc-active','oc-tps','oc-input-rate'])text(id,'—');$('active-routes').replaceChildren();text('oc-activity-note','Connection unavailable');if(data)render();for(const id of ['oc-active','oc-tps','oc-input-rate'])text(id,'—');$('active-routes').replaceChildren();document.body.classList.add('offline');text('status','Disconnected');for(const id of ['inflight','tps','input-rate','cpu','ram','load','memory-detail','swap','loads'])text(id,'—');for(const id of ['cores','top-cpu','top-memory'])$(id).replaceChildren();$('ram-bar').style.width='0%';text('host-age','Connection unavailable');text('process-count','Unavailable');text('usage-age','Connection unavailable · these saved totals may be stale.');text('rate-note','Connection unavailable. Live values withheld; saved totals may be stale.');}
 finally{fetching=false;}
}
document.addEventListener('visibilitychange',()=>{if(!document.hidden)refresh();});
applyPrefs();refresh();
