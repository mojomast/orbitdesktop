'use strict';
const $=id=>document.getElementById(id);
const number=n=>Number.isFinite(n)?new Intl.NumberFormat().format(Math.round(n)):'—';
const percent=n=>Number.isFinite(n)?n.toFixed(1)+'%':'—';
const bytes=n=>{if(!Number.isFinite(n))return '—';const units=['B','KiB','MiB','GiB','TiB'];let i=0;while(n>=1024&&i<4){n/=1024;i++}return n.toFixed(i?1:0)+' '+units[i]};
const put=(id,value)=>{$(id).textContent=value};
let data=null, paused=false, failed=false, fetching=false;
function graph(id,key,max){
 const svg=$(id), history=data?.history||[], end=data?.updated_at||Date.now()/1000;
 svg.replaceChildren();const ns='http://www.w3.org/2000/svg';
 const values=history.filter(p=>Number.isFinite(p[key]));
 if(values.length<2){const text=document.createElementNS(ns,'text');text.setAttribute('x','8');text.setAttribute('y','55');text.textContent='Collecting history · no synthetic samples';svg.append(text);return}
 max=max||Math.max(...values.map(p=>p[key]),1);
 for(const y of [20,50,80]){const line=document.createElementNS(ns,'path');line.setAttribute('d',`M0 ${y}H600`);line.setAttribute('stroke','#ffffff0b');svg.append(line)}
 let path='',last=null;
 for(const p of history){if(!Number.isFinite(p[key])){last=null;continue}const x=600*(p.at-(end-3600))/3600, y=94-88*Math.min(1,p[key]/max);path+=(last&&p.at-last.at<=30?'L':'M')+`${x.toFixed(2)} ${y.toFixed(2)} `;last=p}
 const line=document.createElementNS(ns,'path');line.setAttribute('d',path);line.setAttribute('fill','none');line.setAttribute('stroke','currentColor');line.setAttribute('stroke-width','2');svg.append(line);
 const dot=document.createElementNS(ns,'circle'),p=values.at(-1);dot.setAttribute('cx',String(600*(p.at-(end-3600))/3600));dot.setAttribute('cy',String(94-88*Math.min(1,p[key]/max)));dot.setAttribute('r','3');dot.setAttribute('fill','currentColor');svg.append(dot);
}
function health(){
 const age=data?Math.max(0,Date.now()/1000-data.updated_at):null;
 const state=paused?'Paused':failed?'Disconnected':!data?'Connecting':age>35?'Stale':'Live';
 put('connection',state);$('connection').classList.toggle('warn',state!=='Live');
 put('updated',data?`Sample ${new Date(data.updated_at*1000).toLocaleTimeString()} · ${Math.floor(age)}s ago`:'Waiting for a real sample');
 const alerts=[];
 if(paused)alerts.push('Dashboard paused; numbers are frozen.');
 if(failed)alerts.push('Feed unavailable. Last received values are retained, not live.');
 if(!data)alerts.push('No sample available. Health is unknown.');
 else {
 if(age>35)alerts.push('Telemetry is stale. Check the collector timer.');
 for(const [key,value]of Object.entries(data.sources))if(value!=='ok')alerts.push(`${key} source unavailable.`);
 const h=data.host,w=data.workspace,j=data.jobs,s=data.service;
 if(h){if(h.cpu_percent>=90)alerts.push('CPU ≥90%.');if(h.memory_used/h.memory_total>=.9)alerts.push('Memory ≥90%.');if(h.disk_used/h.disk_total>=.85)alerts.push('Disk ≥85%.')}
 if(j){if(j.failing)alerts.push(`${j.failing} scheduled job(s) have recorded errors.`);if(j.overdue)alerts.push(`${j.overdue} scheduled run(s) overdue by more than 5 minutes.`)}
 if(s&&(!s.orbit_active||!s.http_ok))alerts.push('Orbit service or HTTP health check failed.');
 if(w&&(w.observed_revision<w.revision||w.browser_age_seconds===null||w.browser_age_seconds>30))alerts.push('Browser state acknowledgement is pending or old.');
 }
 put('alerts',alerts.length?alerts.join('  •  '):'No configured threshold breaches in the latest sample. Coverage limits apply.');
 document.querySelector('.alerts').classList.toggle('warning',alerts.length>0);
}
function renderUsage(){const u=data?.usage?.[$('scope').value];for(const k of ['input','output','cached','calls','tools','sessions']){const value=u?.[k];put(k,Number.isFinite(value)?new Intl.NumberFormat(undefined,{notation:'compact',maximumFractionDigits:1}).format(value):'—');$(k).title=number(value)}const total=u?u.input+u.output:null;put('tokens',number(total));$('inputbar').style.width=(total?100*u.input/total:0)+'%';$('outputbar').style.width=(total?100*u.output/total:0)+'%'}
function render(){
 const h=data.host||{},w=data.workspace||{},j=data.jobs||{},s=data.service;
 const mem=h.memory_total?100*h.memory_used/h.memory_total:null,disk=h.disk_total?100*h.disk_used/h.disk_total:null;
 put('cpu',percent(h.cpu_percent));put('memory',percent(mem));put('disk',percent(disk));
 for(const [key,val]of [['cpu',h.cpu_percent],['memory',mem],['disk',disk]]){const bar=$(key+'-bar');bar.value=val||0;bar.setAttribute('aria-valuetext',percent(val))}
 put('load',h.load?`${number(h.cores)} cores · load ${h.load.map(n=>n.toFixed(2)).join(' / ')}`:'Source unavailable');
 put('memory-detail',h.memory_total?`${bytes(h.memory_used)} / ${bytes(h.memory_total)}`:'—');
 put('disk-detail',h.disk_total?`${bytes(h.disk_free)} free · workspace filesystem`:'—');
 put('uptime',Number.isFinite(h.uptime_seconds)?`${Math.floor(h.uptime_seconds/86400)}d ${Math.floor(h.uptime_seconds%86400/3600)}h`:'—');
 put('swap',h.swap_total?`Swap ${bytes(h.swap_used)} / ${bytes(h.swap_total)}`:data.host?'No swap configured':'—');
 put('rx',Number.isFinite(h.rx_per_second)?bytes(h.rx_per_second)+'/s':'—');put('tx',Number.isFinite(h.tx_per_second)?bytes(h.tx_per_second)+'/s':'—');
 put('pressure',h.pressure?`CPU ${percent(h.pressure.cpu)} · RAM ${percent(h.pressure.memory)} · I/O ${percent(h.pressure.io)}`:'Unavailable');
 for(const k of ['enabled','failing','overdue'])put('jobs-'+k,number(j[k]));
 put('next-job',j.next_run_at?new Date(j.next_run_at*1000).toLocaleString():data.jobs?'No scheduled timestamp':'Unavailable');
 put('jobs-detail',data.jobs?`${j.total} jobs · ${j.disabled} disabled. Errors reflect saved records, not confirmed current failures.`:'Scheduler source unavailable.');
 put('service',s?s.orbit_active?'Running':'Not active':'Unavailable');put('http',s?s.http_ok?`${s.http_latency_ms.toFixed(1)} ms · OK`:'Failed':'Unavailable');
 put('ack',data.workspace?(w.browser_age_seconds===null?'Not observed':`${Math.floor(w.browser_age_seconds)}s ago`):'Unavailable');put('revision',data.workspace?`${w.observed_revision} / ${w.revision}`:'—');
 for(const k of ['windows','panes'])put(k,number(w[k]));put('plugins',data.workspace?`${w.enabled_plugins} / ${w.plugins}`:'—');
 for(const node of document.querySelectorAll('[data-source]')){const ok=data.sources[node.dataset.source]==='ok';node.classList.toggle('failed',!ok);node.title=ok?'Source collected successfully':'Source unavailable'}
 renderUsage();graph('cpu-chart','cpu',100);graph('memory-chart','memory',h.memory_total);graph('network-chart','rx');put('samples',`${data.history.length} / 360 samples · rolling hour`);health();$('export').disabled=false;
}
async function refresh(){
 if(fetching)return;fetching=true;$('refresh').disabled=true;
 try{const response=await fetch('/apps/orbit-observatory-data/snapshot.json?t='+Date.now(),{cache:'no-store',credentials:'omit',signal:AbortSignal.timeout(7000)});if(!response.ok)throw Error('HTTP');const incoming=await response.json();if(incoming.version!==1||!Number.isFinite(incoming.updated_at)||!incoming.sources||!Array.isArray(incoming.history))throw Error('Schema');data=incoming;failed=false;render()}
 catch{failed=true;health()}finally{fetching=false;$('refresh').disabled=paused}
}
$('scope').onchange=renderUsage;$('refresh').onclick=refresh;
$('pause').onclick=()=>{paused=!paused;put('pause',paused?'Resume':'Pause');$('pause').setAttribute('aria-pressed',String(paused));$('refresh').disabled=paused;if(!paused)refresh();health()};
$('export').disabled=true;$('export').onclick=()=>{if(!data)return;const url=URL.createObjectURL(new Blob([JSON.stringify(data,null,2)],{type:'application/json'}));const a=document.createElement('a');a.href=url;a.download='orbit-observatory.json';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000)};
for(const button of document.querySelectorAll('[data-filter]'))button.onclick=()=>{for(const b of document.querySelectorAll('[data-filter]')){b.classList.toggle('active',b===button);b.setAttribute('aria-pressed',String(b===button))}for(const panel of document.querySelectorAll('[data-section]'))panel.hidden=button.dataset.filter!=='all'&&panel.dataset.section!==button.dataset.filter};
refresh();setInterval(()=>{if(!paused&&!document.hidden)refresh()},10000);setInterval(health,1000);
