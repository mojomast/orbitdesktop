import {openRailsShell} from './rails-shell';
import {reportTurns} from './hive-report-turn';
// @ts-expect-error The same release-owned admission rules run in both documents.
import {createStore} from '../apps/rizzstack-hive/store.js';

// Publish with scripts/plugin_publish.py. This exact registry-verified entry is
// the ONLY app eligible for the operator's per-document read grant.
const HIVE_ENTRY = '/apps/rizzstack-hive-20f0cdd6642cde82a6e6db34/index.html';
const PERIOD = 30_000;
const turns=reportTurns(PERIOD);
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$/;
const sharedOptions = {credentials:'omit', redirect:'error', cache:'no-store', referrerPolicy:'no-referrer'} as const;

async function json(response: Response, cap: number) {
  if (!response.headers.get('Content-Type')?.startsWith('application/json') ||
      Number(response.headers.get('Content-Length')) > cap || !response.body) throw Error();
  const reader = response.body.getReader(), decoder = new TextDecoder('utf-8',{fatal:true});
  let bytes = 0, text = '';
  try {
    for (;;) {
      const {value,done} = await reader.read();
      if (done) return JSON.parse(text + decoder.decode());
      bytes += value.byteLength;
      if (bytes > cap) throw Error();
      text += decoder.decode(value,{stream:true});
    }
  } finally { await reader.cancel().catch(()=>{}); }
}

type Status = 'connected'|'loading'|'unauthorized'|'unavailable'|'disconnected'|'conflict'|'out of order';
type Grant = {credential:string};

export function bindHiveHost(frame:HTMLIFrameElement, url:URL, token:()=>string, controls:HTMLElement,
  lifecycle:{revoked:boolean,clearDocument:()=>void,clock:{last:number}}) {
  if (url.origin !== location.origin || url.pathname !== HIVE_ENTRY || url.search ||
      (url.hash && url.hash !== '#orbit-config=%7B%7D')) return ()=>{};

  // A WindowProxy survives a navigation. Bind the first transferred port to the
  // initial reviewed document, never handshake a replacement, never reply via
  // Window.postMessage. This rendezvous ID carries no read authority. Do not
  // persist it in a pane URL/config, send it to the server or reuse across mounts.
  const nonce = crypto.randomUUID();
  frame.sandbox.value = 'allow-scripts';
  frame.src = location.origin + HIVE_ENTRY + '#orbit-hive-document=' + nonce;
  const bar = document.createElement('div'), read = document.createElement('button');
  read.type = 'button'; bar.setAttribute('aria-label','Orbit Hive read access');
  const reports=document.createElement('button'); reports.type='button';
  bar.append(read,reports); controls.before(bar);
  let port:MessagePort|undefined, grant:Grant|undefined, request:AbortController|undefined;
  let closeRails:(()=>void)|undefined, timer=0, lastConfirmed=-Infinity;
  let selectors = new Set<string>(), disposed=false, suspended=false, loads=0;
  type Row={kind:string,id:string,title:string};
  type PublicView={generatedAt:string,records:Row[]};
  let confirmed:PublicView|undefined, enrolled=false, lastReport=-Infinity, reportRequest:AbortController|undefined;
  const admission=createStore();let sequence=0, offered:{seq:number,v:PublicView,selectors:Set<string>}|undefined, reportTimer=0;
  const turn=Symbol();
  const valid = (g:Grant) => !disposed && frame.isConnected && grant === g && !!port && token() === g.credential;
  const status = (value:Status) => port?.postMessage({type:'status',value});
  function label() {
    read.disabled = !port || !token() || disposed || suspended;
    bar.hidden=suspended;
    read.textContent = grant ? 'Stop sharing Hive overview' : !token() ? 'Unlock Orbit to share Hive overview' : 'Share read-only overview with this Hive pane';
    reports.hidden=!grant || !confirmed; reports.disabled=!confirmed || !grant || disposed || suspended;
    reports.textContent=enrolled?'Stop sharing overview and evidence':'Share enrolled evidence with this pane';
  }
  function revoke(value:Status) {
    grant = undefined; request?.abort(); request=undefined; selectors.clear(); confirmed=undefined;enrolled=false;
    reportRequest?.abort();reportRequest=undefined;clearTimeout(reportTimer);turns.leave(turn);offered=undefined;
    clearTimeout(timer); closeRails?.(); closeRails=undefined; status(value); label();
  }
  function withdraw() {
    const exposed=!!grant;
    revoke('unauthorized');
    // Don't rely on each renderer cache, hidden tab, search field, ARIA live
    // region, or pending animation clearing its private text. Destroy the
    // granted document; the fresh mount has no grant and a new rendezvous.
    if(exposed && !disposed && frame.isConnected) lifecycle.clearDocument();
  }
  // Only the trusted owner control enrolls this exact document. At most one
  // bounded report read per cadence; never let a guest choose a source or path.
  async function evidence(g:Grant, v:PublicView) {
    if(!enrolled||!valid(g)||v!==confirmed||document.hidden||reportRequest)return;
    clearTimeout(reportTimer);
    const progress=(value:'waiting'|'busy'|'unavailable')=>port?.postMessage({type:'report-status',value});
    const now=performance.now(); const delay=now<lastReport+PERIOD?lastReport+PERIOD-now:turns.delay(turn,now);
    if(delay>0){progress('waiting');reportTimer=window.setTimeout(()=>void evidence(g,v),Math.ceil(delay));return;}
    lastReport=performance.now();
    const ctl=reportRequest=new AbortController();const deadline=setTimeout(()=>ctl.abort(),30000);
    const current=()=>enrolled&&valid(g)&&v===confirmed&&reportRequest===ctl;
    try {
      const r=await fetch('/api/rizzstack/hive/reports',{...sharedOptions,method:'GET',headers:{Authorization:'Bearer '+g.credential,Accept:'application/json'},signal:ctl.signal});
      if(!current())return;if(r.status===401||r.status===403){withdraw();return;}
      if(r.status===429){progress('busy');reportTimer=window.setTimeout(()=>void evidence(g,v),PERIOD+Math.ceil(Math.random()*1000));return;}
      if(!r.ok)throw Error();
      const packet=await json(r,200*1024);
      if(!current())return;
      if(!packet || packet.version!=='hive.reports/1'||Object.keys(packet).sort().join()!=='labels,queue,release,version')throw Error();
      // @ts-expect-error release-owned portable JS.
      const {validateQueue}=await import('../apps/rizzstack-hive/queue-provider.js');
      // @ts-expect-error release-owned portable JS.
      const {validateRelease}=await import('../apps/rizzstack-hive/release-provider.js');
      // @ts-expect-error release-owned portable JS.
      const {validateLabels,applyLabels}=await import('../apps/rizzstack-hive/public-labels.js');
      const titles:{kind:string,id:string,title:string}[]=[];
      if(packet.labels && validateLabels(packet.labels)) {
        const display=await applyLabels(v,packet.labels);
        for(const row of v.records){const alias=display.records.find((x:Row)=>x.kind===row.kind&&x.id===row.id)?.title;
          if(typeof alias==='string' && alias!==row.title && alias.length<=160)titles.push({kind:row.kind,id:row.id,title:alias});}
      }
      const msg={type:'reports',generatedAt:v.generatedAt,queue:packet.queue&&validateQueue(packet.queue)?packet.queue:null,
        release:packet.release&&validateRelease(packet.release)?packet.release:null,titles};
      if(JSON.stringify(msg).includes(g.credential))throw Error();if(current())port?.postMessage(msg);
    } catch {if(current())progress('unavailable');}
    finally{clearTimeout(deadline);ctl.abort();if(reportRequest===ctl)reportRequest=undefined;}
  }
  reports.onclick=e=>{if(!e.isTrusted||!grant||!confirmed||!valid(grant))return;if(enrolled){withdraw();return;}
    enrolled=true;label();void evidence(grant,confirmed);};
  async function refresh() {
    const g=grant;
    if (!g || !valid(g) || document.hidden || request) return;
    const delay=PERIOD-(performance.now()-lifecycle.clock.last);
    clearTimeout(timer);
    if (delay>0) {timer=window.setTimeout(refresh,Math.ceil(delay));return;}
    lifecycle.clock.last=performance.now();
    const controller = request = new AbortController();
    const deadline = setTimeout(()=>controller.abort(),10_000);
    const opts={...sharedOptions,signal:controller.signal};
    confirmed=undefined;offered=undefined;selectors.clear();reportRequest?.abort();reportRequest=undefined;clearTimeout(reportTimer);label();status('loading');
    try {
      // Recheck the in-memory owner session on the real Orbit auth route for
      // each read. The extension proxy below independently requires the owner
      // bearer, so a stale or revoked credential is refused there too.
      const auth=await fetch('/api/auth',{...opts,method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({token:g.credential})});
      if (!valid(g)) return;
      if (auth.status===401 || auth.status===403) {withdraw();return;}
      if (!auth.ok || (await json(auth,512))?.ok!==true) throw Error();
      if (!valid(g)) return;
      // Read through the owner-authenticated extension proxy. The server checks
      // the owner bearer and same-origin metadata, forwards only /snapshot to
      // the loopback collector, and injects the collector credential. A
      // same-origin GET needs an allowed Referer, so use origin rather than the
      // shared no-referrer policy for this owner-bearer request only.
      const response=await fetch('/api/ext/rizzstack-observatory/snapshot/snapshot',
        {...opts,referrerPolicy:'origin',method:'GET',headers:{Accept:'application/json',Authorization:`Bearer ${g.credential}`}});
      if (!valid(g)) return;
      if (response.status===401 || response.status===403) {withdraw();return;}
      if (!response.ok) throw Error();
      const snapshot=await json(response,2*1024*1024);
      if (!valid(g)) return;
      // Static, release-owned import; load the schema only for an approved
      // Hive read, never from an app/manifest URL or on ordinary Orbit startup.
      // @ts-expect-error The no-build JS adapter ships without TS declarations.
      const {projectLabelView}=await import('../apps/rizzstack-hive/public-labels.js');
      if (!valid(g)) return;
      const view=await projectLabelView(snapshot,{now:Date.now()});
      if (!valid(g)) return;
      const serialized=JSON.stringify(view);
      const bytes=new TextEncoder().encode(serialized);
      if (serialized.includes(g.credential) || bytes.length>512*1024) throw Error();
      // A demo round trip clears consent and private rows, not the document's
      // freshness boundary. Keep only a timestamp and SHA-256 in admission.
      const hash=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)),b=>b.toString(16).padStart(2,'0')).join('');
      if (!valid(g)) return;
      const next=new Set<string>();
      for (const row of view.attempts) if (ID.test(row.id)) next.add('attempt:'+row.id);
      for (const row of view.records) if (typeof row.jobId==='string' && ID.test(row.jobId)) next.add('job:'+row.jobId);
      const result=admission.hydrate({generatedAt:view.generatedAt,hash});
      if(result==='old'||admission.current.status==='conflict'){turns.leave(turn);status(result==='old'?'out of order':'conflict');return;}
      if(result!=='new'&&result!=='duplicate')throw Error();
      offered={seq:++sequence,v:view,selectors:next};
      port!.postMessage({type:'view',view}); status('connected');
      port!.postMessage({type:'admission',seq:sequence,generatedAt:view.generatedAt});
    } catch {
      if (valid(g)) {turns.leave(turn);selectors.clear();confirmed=undefined;label();status('unavailable');}
    } finally {
      controller.abort(); clearTimeout(deadline);
      if (request===controller) request=undefined;
      if (valid(g)) timer=window.setTimeout(refresh,PERIOD);
    }
  }
  function receive(event:MessageEvent) {
    if (disposed || port || !frame.isConnected || event.source!==frame.contentWindow || event.origin!=='null' ||
        event.data?.type!=='orbit-hive-ready' || event.data.document!==nonce || event.ports.length!==1) return;
    window.removeEventListener('message',receive);
    port=event.ports[0];
    port.onmessage=({data})=>{
      if (disposed || !frame.isConnected || !data || typeof data!=='object') return;
      if (data.type==='close') {dispose();return;}
      if (data.type==='suspend') {suspended=true;revoke('unauthorized');return;}
      if (data.type==='resume' && suspended) {suspended=false;label();status(token()?'disconnected':'unauthorized');return;}
      if (!grant || !valid(grant)) return;
      if(data.type==='accepted'&&Object.keys(data).length===3&&offered&&data.seq===offered.seq&&data.generatedAt===offered.v.generatedAt){
        selectors=offered.selectors;confirmed=offered.v;offered=undefined;lastConfirmed=performance.now();label();void evidence(grant,confirmed);return;
      }
      if (data.type==='refresh' && Object.keys(data).length===1) {void refresh();return;}
      if (data.type!=='rails' || Object.keys(data).length!==3 || closeRails ||
          (data.kind!=='attempt' && data.kind!=='job') || typeof data.id!=='string' || !ID.test(data.id) ||
          performance.now()-lastConfirmed>2*PERIOD || !selectors.has(data.kind+':'+data.id)) return;
      // This is navigation only. Existing trusted shell requires its own Inspect click.
      const g=grant;
      closeRails=openRailsShell(token,{kind:data.kind,id:data.id},()=>{
        closeRails=undefined;
        if(valid(g)) { port!.postMessage({type:'follow',signal:'idle',kind:data.kind,id:data.id});frame.focus(); port!.postMessage({type:'return-focus'}); }
      },signal=>{
        if(!valid(g)||document.hidden||!selectors.has(data.kind+':'+data.id))return;
        port!.postMessage({type:'follow',signal,kind:data.kind,id:data.id});
        if(signal==='invalidated'||signal==='gap')void refresh();
      });
    };
    port.onmessageerror=dispose;
    label();status(token() && !lifecycle.revoked?'disconnected':'unauthorized');
  }
  read.onclick = event => {
    if (!event.isTrusted || !port || !frame.isConnected || disposed || suspended) return;
    if (grant || !token()) {withdraw();return;}
    grant={credential:token()};label();void refresh();
  };
  const authChanged=()=>{withdraw();};
  const visibility=()=>{if(document.hidden)turns.leave(turn);else void refresh();};
  const loaded=()=>{if (++loads>1) dispose();};
  function dispose() {
    if(disposed)return;
    disposed=true;revoke('unauthorized');admission.reset();port?.close();port=undefined;
    frame.removeEventListener('load',loaded);window.removeEventListener('message',receive);
    window.removeEventListener('orbit-host-connected',authChanged);document.removeEventListener('visibilitychange',visibility);
    window.removeEventListener('pagehide',dispose);bar.remove();
  }
  label();frame.addEventListener('load',loaded);window.addEventListener('message',receive);
  window.addEventListener('pagehide',dispose);window.addEventListener('orbit-host-connected',authChanged);
  document.addEventListener('visibilitychange',visibility);return dispose;
}
