// Loopback-only POST /api/local-workers, authorized with the collab-board key (same trust as ~/bin/collab-board).
// Ops: create, list, get, cancel, review, tick. Polls the launcher every ORBIT_LOCAL_WORKERS_POLL_MS (default 3000).
import { readFileSync } from 'node:fs';
import { timingSafeEqual } from 'node:crypto';
import path from 'node:path';
import { createLocalWorkers, collabBoardClient } from './local-workers.mjs';

export function createLocalWorkersRoute({ runtimeRoot, port, env = process.env, log = () => {} }) {
  const node = env.ORBIT_LOCAL_WORKERS_NODE || 'brrrrrrrr';
  const lw = createLocalWorkers({
    runtimeDir: runtimeRoot, node,
    launcherUrl: env.ORBIT_LOCAL_WORKERS_URL || 'http://100.120.158.68:47821',
    tokenFile: env.ORBIT_LOCAL_WORKERS_TOKEN_FILE || path.join(runtimeRoot, 'local-workers', `${node}.token`),
    board: collabBoardClient({ runtimeDir: runtimeRoot, port }),
    maxConcurrent: Number(env.ORBIT_LOCAL_WORKERS_MAX || 1), log,
  });
  let busy = false;
  const tick = async () => { if (busy) return; busy = true; try { await lw.tick(); } catch (e) { log(`local-workers tick: ${e.message}`); } finally { busy = false; } };
  setTimeout(tick, 500); // restart recovery: reconcile before anything else
  const timer = setInterval(tick, Number(env.ORBIT_LOCAL_WORKERS_POLL_MS || 3000)); timer.unref?.();
  const view = (a) => a && (({ brief, history, ...r }) => ({ ...r, history: history.slice(-12) }))(a);
  const keyOk = (h) => {
    let key; try { key = Buffer.from(readFileSync(path.join(runtimeRoot, 'collab-board.key'), 'utf8').trim()); } catch { return false; }
    const got = Buffer.from(String(h || '').replace(/^Bearer /, ''));
    return got.length === key.length && timingSafeEqual(got, key);
  };
  async function handle(req, res) {
    const send = (c, o) => { res.writeHead(c, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(o)); };
    const ra = req.socket.remoteAddress || '';
    if (!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(ra)) return send(403, { error: 'loopback only' });
    if (req.method !== 'POST') return send(405, { error: 'POST only' });
    if (!keyOk(req.headers.authorization)) return send(401, { error: 'unauthorized' });
    let b = ''; for await (const c of req) { b += c; if (b.length > 200_000) return send(413, { error: 'too large' }); }
    try {
      b = JSON.parse(b || '{}');
      switch (b.op) {
        case 'create': return send(201, view(await lw.create({ taskId: b.task_id, boardEntry: b.board_entry || b.task_id, group: b.group, coordinator: b.coordinator || 'MR.INDIA', brief: b.brief, model: b.model })));
        case 'list': return send(200, { attempts: lw.list().map(view) });
        case 'get': return send(200, view(lw.get(b.attempt_id)) || { error: 'unknown' });
        case 'cancel': return send(202, view(await lw.cancel(b.attempt_id)));
        case 'review': return send(200, view(await lw.review(b.attempt_id, { accepted: b.accepted, note: b.note, by: b.by })));
        case 'tick': await tick(); return send(200, { ok: true });
        default: return send(400, { error: 'op must be create|list|get|cancel|review|tick' });
      }
    } catch (e) { return send(e.status || 400, { error: e.message }); }
  }
  return { handle, lw };
}
