// Loopback-only POST /api/local-workers, authorized with the collab-board key (same trust as ~/bin/collab-board).
// Ops: create, list, get, cancel, review, tick, archive, artifact (coordinator-only patch read; see local-worker-artifact.mjs). Polls the launcher every ORBIT_LOCAL_WORKERS_POLL_MS (default 3000).
import { readFileSync } from 'node:fs';
import { timingSafeEqual } from 'node:crypto';
import path from 'node:path';
import { createLocalWorkers, collabBoardClient } from './local-workers.mjs';
import { workerArtifact, DEFAULT_MAX_BYTES } from './local-worker-artifact.mjs';
import { createWorkerJoinRoute } from './worker-join-route.mjs';

export function createLocalWorkersRoute({ runtimeRoot, port, env = process.env, log = () => {} }) {
  // Mutually exclusive mode on the existing mount. No launcher, timer, board
  // credential, executable brief or attempt ledger in this mode.
  if (env.ORBIT_WORKER_JOIN_ONLY === '1') return createWorkerJoinRoute({ runtimeRoot, port, env });
  const node = env.ORBIT_LOCAL_WORKERS_NODE || 'local-worker';
  const artifactMax = Number(env.ORBIT_WORKER_ARTIFACT_MAX_BYTES) > 0 ? Number(env.ORBIT_WORKER_ARTIFACT_MAX_BYTES) : DEFAULT_MAX_BYTES;
  const lw = createLocalWorkers({
    runtimeDir: runtimeRoot, node,
    launcherUrl: env.ORBIT_LOCAL_WORKERS_URL || 'http://127.0.0.1:47821',
    tokenFile: env.ORBIT_LOCAL_WORKERS_TOKEN_FILE || path.join(runtimeRoot, 'local-workers', `${node}.token`),
    board: collabBoardClient({ runtimeDir: runtimeRoot, port }),
    maxConcurrent: Number(env.ORBIT_LOCAL_WORKERS_MAX || 1), artifactMaxBytes: artifactMax, log,
  });
  let busy = false;
  // Warn-only by default; exactly '1' makes a missing risk tier/preflight blocking.
  const requirePreflight = env.ORBIT_LOCAL_WORKERS_REQUIRE_PREFLIGHT === '1';
  let ungatedCreates = 0;
  const tick = async () => { if (busy) return; busy = true; try { await lw.tick(); } catch (e) { log(`local-workers tick: ${e.message}`); } finally { busy = false; } };
  setTimeout(tick, 500); // restart recovery: reconcile before anything else
  const timer = setInterval(tick, Number(env.ORBIT_LOCAL_WORKERS_POLL_MS || 3000)); timer.unref?.();
  // Public view: no brief, no box paths (result/log refs), never a patch. Patches come only from op 'artifact'.
  const view = (a) => a && (({ brief, history, log_ref, result, capability_sha256, ...r }) => ({ ...r, history: history.slice(-12), log_available: !!log_ref,
    result: result ? (({ ref, ...rest }) => ({ ...rest, available: true }))(result) : null }))(a);
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
        case 'create': {
          // Reasons come from brief shape only; brief contents are never logged.
          const brief = b.brief && typeof b.brief === 'object' ? b.brief : undefined;
          const reasons = [];
          if (!(typeof brief?.risk?.tier === 'string' && brief.risk.tier.length > 0)) reasons.push('no_risk_tier');
          if (!(brief?.preflight && typeof brief.preflight === 'object' && brief.preflight.ok === true)) reasons.push('no_preflight');
          if (reasons.length) ungatedCreates += 1;
          if (requirePreflight && reasons.length) return send(422, { code: 'preflight_required', error: 'local worker create requires risk tier and passing preflight', fix: 'set brief.risk.tier to a non-empty string and brief.preflight to an object with ok true', ungated_reasons: reasons });
          const a = await lw.create({ taskId: b.task_id, boardEntry: b.board_entry || b.task_id, group: b.group, coordinator: b.coordinator || 'MR.INDIA', brief: b.brief, model: b.model, tier: b.tier });
          if (reasons.length) { a.ungated = true; a.ungated_reasons = reasons; }
          return send(201, { ...view(a), artifact_capability: a.artifact_capability });
        }
        case 'list': return send(200, { attempts: lw.list().map(view), cap: lw.cap, paused: lw.paused, ungated_creates: ungatedCreates });
        case 'get': return send(200, view(lw.get(b.attempt_id)) || { error: 'unknown' });
        case 'cancel': return send(202, view(await lw.cancel(b.attempt_id)));
        case 'review': return send(200, view(await lw.review(b.attempt_id, { accepted: b.accepted, note: b.note, by: b.by })));
        case 'archive': return send(200, lw.archive({ olderThanMs: b.older_than_ms ?? 86400000, target: b.target ?? 400, exclude: Array.isArray(b.exclude) ? b.exclude : [] }));
        case 'tick': await tick(); return send(200, { ok: true });
        case 'artifact': { const [code, out] = await workerArtifact(lw, path.join(runtimeRoot, 'local-workers'), b, { maxBytes: artifactMax, log }); return send(code, out); }
        default: return send(400, { error: 'op must be create|list|get|cancel|review|tick|archive|artifact' });
      }
    } catch (e) { return send(e.status || 400, { error: e.message, ...(e.code && typeof e.code === 'string' && !e.code.startsWith('ERR_') ? { code: e.code } : {}), ...(e.extra || {}) }); }
  }
  return { handle, lw };
}
