import { tokenMatches } from './security.mjs';
import { JoinError, ownerOps, openWorkerJoinStore } from './worker-join-store.mjs';

const peers = new Set(['127.0.0.1','::1','::ffff:127.0.0.1']);
export function createWorkerJoinRoute({ runtimeRoot, port, env, now, peerOnly = false }) {
  let store;
  const hosts = new Set([`127.0.0.1:${port}`,`[::1]:${port}`]);
  async function handle(req,res) {
    const send = (status, body) => {
      res.writeHead(status, { 'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff' });
      res.end(JSON.stringify(body));
    };
    const h = req.headers;
    if (!peerOnly && !env.ORBIT_TOKEN) return send(503,{ error:'owner_unconfigured' });
    if (!['127.0.0.1','::1'].includes(env.ORBIT_HOST || '127.0.0.1') || !peers.has(req.socket.remoteAddress) || !peers.has(req.socket.localAddress) ||
        !hosts.has(h.host) || env.ORBIT_PUBLIC_ORIGIN || Object.keys(h).some(k => k === 'forwarded' || k.startsWith('x-forwarded-'))) return send(403,{ error:'direct_loopback_required' });
    if (req.url !== '/api/local-workers') return send(404,{ error:'not_found' });
    if (req.method !== 'POST') return send(405,{ error:'post_required' });
    if (h['content-type']?.split(';')[0].trim() !== 'application/json') return send(415,{ error:'json_required' });
    const origin = `${req.socket.encrypted ? 'https' : 'http'}://${h.host}`;
    if (h.origin !== undefined && h.origin !== origin) return send(403,{ error:'origin_denied' });
    try {
      const chunks = []; let size = 0;
      for await (const chunk of req) {
        size += chunk.length;
        if (size > 4096) return send(413,{ error:'body_too_large' });
        chunks.push(chunk);
      }
      let b;
      try { b = JSON.parse(new TextDecoder('utf-8',{ fatal: true }).decode(Buffer.concat(chunks))); } catch { return send(400,{ error:'invalid_json' }); }
      const bearer = /^Bearer ([^\s]+)$/.exec(h.authorization ?? '')?.[1];
      const owner = ownerOps.has(b?.op);
      if (peerOnly && owner) return send(403,{ error:'owner_required' });
      if (owner && !(h.origin === origin && env.ORBIT_TOKEN && tokenMatches(bearer,env.ORBIT_TOKEN))) return send(403,{ error:'owner_required' });
      if (!owner && h.origin !== undefined) return send(403,{ error:'worker_client_required' });
      store ??= openWorkerJoinStore(runtimeRoot,now);
      return send(200,{ protocol:'orbit.worker-join/1', ...store.dispatch(b,bearer,owner,origin) });
    } catch (err) {
      return err instanceof JoinError ? send(err.status,{ error:err.code }) : send(503,{ error:'registry_unavailable' });
    }
  }
  return { handle, close: () => { store?.close(); store = undefined; } };
}
