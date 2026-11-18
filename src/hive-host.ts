import {openRailsShell} from './rails-shell';

// Publish with scripts/plugin_publish.py. This exact registry-verified entry is
// the ONLY app eligible for the operator's per-document read grant.
const HIVE_ENTRY = '/apps/rizzstack-hive-cd585d57c7d75e82006c804a/index.html';
const PERIOD = 30_000;
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

type Status = 'connected'|'loading'|'unauthorized'|'unavailable'|'disconnected';
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
  bar.append(read); controls.before(bar);
  let port:MessagePort|undefined, grant:Grant|undefined, request:AbortController|undefined;
  let closeRails:(()=>void)|undefined, timer=0, lastConfirmed=-Infinity;
  let selectors = new Set<string>(), disposed=false, suspended=false, loads=0;
  const valid = (g:Grant) => !disposed && frame.isConnected && grant === g && !!port && token() === g.credential;
  const status = (value:Status) => port?.postMessage({type:'status',value});
  function label() {
    read.disabled = !port || !token() || disposed || suspended;
    bar.hidden=suspended;
    read.textContent = grant ? 'Stop sharing Hive overview' : !token() ? 'Unlock Orbit to share Hive overview' : 'Share read-only overview with this Hive pane';
  }
  function revoke(value:Status) {
    grant = undefined; request?.abort(); request=undefined; selectors.clear();
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
    status('loading');
    try {
      // Legacy snapshot proxy does not validate an owner bearer. Recheck the
      // in-memory owner session on the real Orbit auth route for *each* read.
      const auth=await fetch('/api/auth',{...opts,method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({token:g.credential})});
      if (!valid(g)) return;
      if (auth.status===401 || auth.status===403) {withdraw();return;}
      if (!auth.ok || (await json(auth,512))?.ok!==true) throw Error();
      if (!valid(g)) return;
      // Orbit strips /obs-snapshot. Workflow collector.py accepts /snapshot;
      // /snapshot.json is not a route in the qualified collector.
      const response=await fetch('/obs-snapshot/snapshot',{...opts,method:'GET',headers:{Accept:'application/json'}});
      if (!valid(g)) return;
      if (response.status===401 || response.status===403) {withdraw();return;}
      if (!response.ok) throw Error();
      const snapshot=await json(response,2*1024*1024);
      if (!valid(g)) return;
      // Static, release-owned import; load the schema only for an approved
      // Hive read, never from an app/manifest URL or on ordinary Orbit startup.
      // @ts-expect-error The no-build JS adapter ships without TS declarations.
      const {project}=await import('../apps/rizzstack-hive/snapshot-adapter.js');
      if (!valid(g)) return;
      const view=project(snapshot,{now:Date.now()});
      const serialized=JSON.stringify(view);
      if (serialized.includes(g.credential) || new TextEncoder().encode(serialized).length>512*1024) throw Error();
      const next=new Set<string>();
      for (const row of view.attempts) if (ID.test(row.id)) next.add('attempt:'+row.id);
      for (const row of view.records) if (typeof row.jobId==='string' && ID.test(row.jobId)) next.add('job:'+row.jobId);
      selectors=next; lastConfirmed=performance.now();
      port!.postMessage({type:'view',view}); status('connected');
    } catch {
      if (valid(g)) {selectors.clear();status('unavailable');}
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
      if (data.type==='refresh' && Object.keys(data).length===1) {void refresh();return;}
      if (data.type!=='rails' || Object.keys(data).length!==3 || closeRails ||
          (data.kind!=='attempt' && data.kind!=='job') || typeof data.id!=='string' || !ID.test(data.id) ||
          performance.now()-lastConfirmed>2*PERIOD || !selectors.has(data.kind+':'+data.id)) return;
      // This is navigation only. Existing trusted shell requires its own Inspect click.
      const g=grant;
      closeRails=openRailsShell(token,{kind:data.kind,id:data.id},()=>{
        closeRails=undefined;
        if(valid(g)) { frame.focus(); port!.postMessage({type:'return-focus'}); }
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
  const visibility=()=>{if(!document.hidden) void refresh();};
  const loaded=()=>{if (++loads>1) dispose();};
  function dispose() {
    if(disposed)return;
    disposed=true;revoke('unauthorized');port?.close();port=undefined;
    frame.removeEventListener('load',loaded);window.removeEventListener('message',receive);
    window.removeEventListener('orbit-host-connected',authChanged);document.removeEventListener('visibilitychange',visibility);
    window.removeEventListener('pagehide',dispose);bar.remove();
  }
  label();frame.addEventListener('load',loaded);window.addEventListener('message',receive);
  window.addEventListener('pagehide',dispose);window.addEventListener('orbit-host-connected',authChanged);
  document.addEventListener('visibilitychange',visibility);return dispose;
}
