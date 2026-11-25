// A single reviewed document, one port, no credential. Switching to a demo
// releases the grant. Returning to Host reuses only the document channel and
// requires a new click in Orbit. Navigation destroys both.
const pairing = /^#orbit-hive-document=([a-f\d-]{36})$/.exec(location.hash)?.[1];
const unavailable = {openRails:()=>false,refresh:()=>{},close:()=>{}};
let port, callbacks, watchdog, pending=null, confirmedAt=null, phase='waiting', focusPending=false, expired=false;
const object=v=>!!v && typeof v==='object' && !Array.isArray(v);
const keys=(v,names)=>object(v) && Object.keys(v).length===names.length && names.every(k=>Object.hasOwn(v,k));
// Transport envelope/shape checks. Full snapshot validation, redaction, scope
// membership and the byte ceiling remain on the trusted side of this port.
const VIEW_KEYS=['generatedAt','health','metrics','sections','attempts','stations','attention','records'];
const count=n=>n===null||(Number.isSafeInteger(n)&&n>=0);
const text=(s,max)=>typeof s==='string'&&s.length<=max;
const usageRow=r=>keys(r,['role','status','requests','input','output','thinking','total'])&&text(r.role,16)&&text(r.status,32)&&
  ['requests','input','output','thinking','total'].every(k=>count(r[k]));
const modelRow=m=>keys(m,['model','provider','requests','input','output','thinking','total'])&&text(m.model,128)&&text(m.provider,64)&&
  ['requests','input','output','thinking','total'].every(k=>count(m[k]));
// Optional additive bee block. Absent on older producers; null when the
// snapshot carries none of its fields.
const beeShape=b=>b===null||(keys(b,['stale','status','attempts','patch','split','models'])&&
  typeof b.stale==='boolean'&&text(b.status,32)&&count(b.attempts)&&
  keys(b.patch,['value','numerator','denominator','basis','rule','scope','cost'])&&
  (b.patch.value===null||(Number.isFinite(b.patch.value)&&b.patch.value>=0))&&count(b.patch.numerator)&&count(b.patch.denominator)&&
  ['basis','rule','scope','cost'].every(k=>text(b.patch[k],300))&&
  Array.isArray(b.split)&&b.split.length<=4&&b.split.every(usageRow)&&
  Array.isArray(b.models)&&b.models.length<=24&&b.models.every(modelRow));
function viewShape(v) {
  return (keys(v,VIEW_KEYS)||keys(v,[...VIEW_KEYS,'beeTokens'])) &&
    typeof v.generatedAt==='string' && Number.isFinite(Date.parse(v.generatedAt)) && ['live','stale','degraded','unavailable'].includes(v.health) &&
    keys(v.metrics,['active','available','capacity','eligible','cost','costCoverage']) &&
    (!Object.hasOwn(v,'beeTokens')||beeShape(v.beeTokens)) &&
    [['sections',10,10],['stations',8,8],['attempts',0,100],['attention',0,50],['records',0,200]].every(([key,min,max])=>
      Array.isArray(v[key]) && v[key].length>=min && v[key].length<=max && v[key].every(r=>object(r) && typeof r.id==='string'));
}

function arm(ms) {
  clearTimeout(watchdog);
  watchdog=setTimeout(()=>{const state=phase==='waiting'?'unavailable':'disconnected';phase='waiting';pending=null;focusPending=false;callbacks?.onStatus(state);},ms);
}
function start() {
  // Ordinary plugin CSP allows network. Tighten the reviewed document before
  // offering a port/accepting any private view, independently of the manifest.
  const csp=document.createElement('meta');csp.httpEquiv='Content-Security-Policy';
  csp.content="default-src 'none'; connect-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; form-action 'none'; base-uri 'none'";
  document.head.prepend(csp);
  const {port1,port2}=new MessageChannel();port=port1;
  port.onmessage=({data})=>{
    if (!callbacks || !object(data)) return;
    if (data.type==='status' && keys(data,['type','value']) && ['connected','unauthorized','unavailable','disconnected','loading','conflict','out of order'].includes(data.value)) {
      if (data.value==='connected' && phase!=='projected') return;
      // Both halves must match the same ordered read. Do not expose a pending
      // projection, or acknowledge a read the store rejected as old/conflicting.
      const result=data.value==='connected'?callbacks.onView(pending):null;
      confirmedAt=data.value==='connected' && (result==='new'||result==='duplicate')?pending.generatedAt:null;
      pending=null;
      phase=data.value!=='connected'||result==='new'||result==='duplicate'?data.value:
        result==='conflict'?'conflict':result==='old'?'out of order':'unavailable';
      if(!['connected','loading'].includes(phase)) focusPending=false;
      clearTimeout(watchdog);if(phase==='connected' || phase==='loading') arm(65_000);
      callbacks.onStatus(phase);
    } else if (data.type==='view' && phase==='loading' && keys(data,['type','view']) && viewShape(data.view)) {
      pending=data.view;phase='projected';arm(65_000);
    } else if (phase==='connected' && confirmedAt && data.type==='admission' && keys(data,['type','seq','generatedAt']) && data.generatedAt===confirmedAt && Number.isSafeInteger(data.seq)&&data.seq>0){
      port.postMessage({type:'accepted',seq:data.seq,generatedAt:confirmedAt});
    } else if(phase==='connected' && data.type==='report-status'&&keys(data,['type','value'])&&['busy','waiting','unavailable'].includes(data.value))callbacks.onReportStatus?.(data.value);
    else if (phase==='connected' && confirmedAt && data.type==='reports' && keys(data,['type','generatedAt','queue','release','titles']) &&
      data.generatedAt===confirmedAt && Array.isArray(data.titles) && data.titles.length<=200 && data.titles.every(r=>keys(r,['kind','id','title'])&&typeof r.id==='string'&&typeof r.kind==='string'&&typeof r.title==='string'&&r.title.length<=160)) {
      callbacks.onReports?.(data);
    } else if (data.type==='follow' && keys(data,['type','signal','kind','id']) && ['connected','loading','projected'].includes(phase) &&
      ['attempt','job'].includes(data.kind) && typeof data.id==='string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$/.test(data.id) &&
      ['following','invalidated','reconnecting','gap','idle'].includes(data.signal))callbacks.onFollow?.(data);
    else if (data.type==='return-focus' && keys(data,['type']) && focusPending) {focusPending=false;callbacks.onReturnFocus();}
  };
  const dispose=()=>{
    expired=true;pending=null;phase='waiting';focusPending=false;clearTimeout(watchdog);callbacks?.onStatus('unauthorized');callbacks=null;
    port.postMessage({type:'close'});port.close();
  };
  port.onmessageerror=dispose;
  addEventListener('pagehide',dispose,{once:true});
  parent.postMessage({type:'orbit-hive-ready',document:pairing},new URL(import.meta.url).origin,[port2]);
}

export function connectHost(client) {
  if (!pairing || expired || self===parent || callbacks) {client.onStatus('unavailable');return unavailable;}
  callbacks=client;phase='waiting';focusPending=false;client.onStatus('loading');arm(5_000);
  if (!port) start();else port.postMessage({type:'resume'});
  return {
    openRails(kind,id) {
      if (callbacks!==client || phase!=='connected' || !['attempt','job'].includes(kind) || typeof id!=='string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$/.test(id)) return false;
      focusPending=true;port.postMessage({type:'rails',kind,id});return true;
    },
    refresh(){if(callbacks===client)port.postMessage({type:'refresh'});},
    close(){if(callbacks!==client)return;pending=null;callbacks=null;phase='waiting';focusPending=false;clearTimeout(watchdog);port.postMessage({type:'suspend'});}
  };
}
