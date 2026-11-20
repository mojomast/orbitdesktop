// Trusted Orbit host for the reviewed Rizzstack Observatory pane. The pane is a
// sandboxed catalog app and never holds a credential: it asks over a private
// MessagePort and this host reads the collector snapshot through the
// owner-authenticated extension proxy, then hands back only the JSON document.
// This replaces the removed unauthenticated /obs-snapshot route.

// Publish with scripts/plugin_publish.py (--id rizzstack-observatory --version
// 1.0.0 --title 'Rizzstack Observatory'). Only this exact content-addressed
// entry is served snapshots; any other app, version or URL gets nothing.
export const OBSERVATORY_ENTRY = '/apps/rizzstack-observatory-82a1fbc7be1b52534be87969/index.html';
export const OBSERVATORY_SNAPSHOT = '/api/ext/rizzstack-observatory/snapshot/snapshot';
const CAP = 8 * 1024 * 1024, MIN_INTERVAL = 5_000, DEADLINE = 20_000;

async function json(response: Response, cap: number) {
  if (!response.headers.get('Content-Type')?.startsWith('application/json') ||
      Number(response.headers.get('Content-Length')) > cap || !response.body) throw Error();
  const reader = response.body.getReader(), decoder = new TextDecoder('utf-8', {fatal: true});
  let bytes = 0, text = '';
  try {
    for (;;) {
      const {value, done} = await reader.read();
      if (done) return JSON.parse(text + decoder.decode());
      bytes += value.byteLength;
      if (bytes > cap) throw Error();
      text += decoder.decode(value, {stream: true});
    }
  } finally { await reader.cancel().catch(() => {}); }
}

type Reply = {ok: true, snapshot: unknown} | {ok: false, status: 'unauthorized'|'unavailable'|'busy'};

export function bindObservatoryHost(frame: HTMLIFrameElement, url: URL, token: () => string) {
  if (url.origin !== location.origin || url.pathname !== OBSERVATORY_ENTRY) return () => {};
  // Same rendezvous rule as the Hive host: bind the first port offered by the
  // initial reviewed document only; the nonce carries no read authority.
  const nonce = crypto.randomUUID();
  frame.sandbox.value = 'allow-scripts';
  frame.src = location.origin + OBSERVATORY_ENTRY + '#orbit-observatory-document=' + nonce;
  let port: MessagePort | undefined, disposed = false, busy = false, last = -Infinity;
  const reply = (id: number, body: Reply) => { if (!disposed) port?.postMessage({type: 'snapshot', id, ...body}); };

  async function read(id: number) {
    const credential = token();
    if (!credential) return reply(id, {ok: false, status: 'unauthorized'});
    const now = performance.now();
    if (busy || now - last < MIN_INTERVAL) return reply(id, {ok: false, status: 'busy'});
    busy = true; last = now;
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(), DEADLINE);
    try {
      // The server checks the owner bearer and same-origin metadata and injects
      // the collector credential; a same-origin GET needs an allowed Referer.
      const response = await fetch(OBSERVATORY_SNAPSHOT, {credentials: 'omit', redirect: 'error', cache: 'no-store',
        referrerPolicy: 'origin', method: 'GET', signal: controller.signal,
        headers: {Accept: 'application/json', Authorization: `Bearer ${credential}`}});
      if (disposed || token() !== credential) return;
      if (response.status === 401 || response.status === 403) return reply(id, {ok: false, status: 'unauthorized'});
      if (!response.ok) return reply(id, {ok: false, status: 'unavailable'});
      const snapshot = await json(response, CAP);
      if (disposed || token() !== credential) return;
      if (JSON.stringify(snapshot).includes(credential)) return reply(id, {ok: false, status: 'unavailable'});
      reply(id, {ok: true, snapshot});
    } catch { reply(id, {ok: false, status: 'unavailable'}); }
    finally { clearTimeout(timer); busy = false; }
  }

  const receive = (event: MessageEvent) => {
    if (port || disposed || !frame.isConnected || event.source !== frame.contentWindow || event.origin !== 'null' ||
        event.data?.type !== 'orbit-observatory-ready' || event.data.document !== nonce || event.ports.length !== 1) return;
    port = event.ports[0];
    port.onmessage = ({data}) => {
      if (data?.type === 'snapshot-request' && Number.isSafeInteger(data.id)) void read(data.id);
    };
  };
  window.addEventListener('message', receive);
  return () => { disposed = true; window.removeEventListener('message', receive); port?.close(); port = undefined; };
}
