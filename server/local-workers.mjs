// Orbit-side adapter for local workers running on Kyle's PC (pc-launcher/).
// Holds only the per-launcher scoped API token. Never sees the provider key or a
// Cua/spacesd host token. Board updates use the existing collab-board API
// server-side (the board key stays on this host).
import { mkdirSync, readFileSync, renameSync, writeFileSync, existsSync } from 'node:fs';
import { randomBytes, createHash } from 'node:crypto';
import path from 'node:path';
import http from 'node:http';
import https from 'node:https';

export const TERMINAL = new Set(['succeeded', 'failed', 'cancelled', 'superseded', 'not_started', 'accepted', 'rejected']);
// detailed state -> board column (todo|doing|review|done|blocked)
export const BOARD_COLUMN = {
  queued: 'todo', launcher_queued: 'todo', dispatching: 'doing', outcome_unknown: 'doing', starting: 'doing', running: 'doing', backoff: 'doing',
  disconnected: 'doing', cancel_requested: 'doing', succeeded: 'review', accepted: 'done', rejected: 'blocked',
  failed: 'blocked', cancelled: 'blocked', not_started: 'blocked',
};
const why = (e) => e?.cause?.code || e?.code || e?.cause?.name || e?.name || 'error';

// Keep-alive HTTP client for the launcher (plan B, LAUNCHER-DROPOUTS.md). The box reaches the PC over a
// relayed tailnet path (~90 ms RTT), so reusing one warm socket avoids a fresh connect every poll, and an
// explicit connect timeout (20 s) replaces the built-in 10 s one. Returns a fetch-like { status, ok, json() }.
const KA = { keepAlive: true, keepAliveMsecs: 30000, maxSockets: 16, maxFreeSockets: 4, timeout: 60000 };
const httpAgent = new http.Agent(KA); const httpsAgent = new https.Agent(KA);
export function keepAliveFetch({ connectTimeoutMs = 20000, maxBytes = Infinity } = {}) {
  return (url, { method = 'GET', headers = {}, body, signal, maxBytes: callMaxBytes } = {}) => new Promise((resolve, reject) => {
    const u = new URL(url); const tls = u.protocol === 'https:';
    const limit = Number(callMaxBytes ?? maxBytes);
    const h = body != null ? { ...headers, 'Content-Length': Buffer.byteLength(body) } : headers;
    const req = (tls ? https : http).request(u, { method, headers: h, agent: tls ? httpsAgent : httpAgent });
    let ct = null; let settled = false;
    const onAbort = () => req.destroy(Object.assign(new Error('This operation was aborted'), { name: 'AbortError' }));
    const finish = (fn, v) => { if (settled) return; settled = true; clearTimeout(ct); signal?.removeEventListener('abort', onAbort); fn(v); };
    if (signal) { if (signal.aborted) { onAbort(); } else signal.addEventListener('abort', onAbort, { once: true }); }
    req.on('socket', (sock) => {
      if (!sock.connecting) return; // reused keep-alive socket
      ct = setTimeout(() => req.destroy(Object.assign(new Error('connect timeout'), { code: 'UND_ERR_CONNECT_TIMEOUT' })), connectTimeoutMs);
      sock.once('connect', () => clearTimeout(ct));
    });
    req.on('error', (e) => finish(reject, e));
    req.on('response', (res) => {
      const chunks = []; let total = 0;
      res.on('data', (c) => {
        total += c.length;
        if (total > limit) {
          const err = Object.assign(new Error(`the launcher body exceeds ${limit} bytes`), { code: 'ERR_RESULT_TOO_LARGE' });
          res.destroy(); req.destroy(err); finish(reject, err); return;
        }
        chunks.push(c);
      });
      res.on('error', (e) => finish(reject, e));
      res.on('end', () => { if (settled) return; const text = Buffer.concat(chunks).toString('utf8');
        finish(resolve, { status: res.statusCode, ok: res.statusCode >= 200 && res.statusCode < 300, text: async () => text, json: async () => JSON.parse(text) }); });
    });
    req.end(body ?? undefined);
  });
}
// Board updates post as the system identity the collab board accepts in any group (see collab-board.mjs).
export const MAX_WORKERS = 10; // hard ceiling, matches the PC launcher
// Model tiers: 'simple' -> the launcher's pool of free OpenCode models (rotates on rate limits, then falls back to flash), 'standard' -> flash via OpenCode Go.
export const MODEL_TIERS = { simple: 'pool:free', standard: 'deepseek-v4.1-flash' };
export const BOARD_POSTER = 'local-workers';
const LAUNCHER_STATES = new Set(['queued', 'launcher_queued', 'starting', 'running', 'backoff', 'cancel_requested', 'succeeded', 'failed', 'cancelled']);

export function manifestHash(brief) {
  const keys = ['objective', 'deliverables', 'acceptance', 'project', 'branch', 'source_rev', 'assigned_files', 'workdir', 'commands', 'deps'];
  return createHash('sha256').update(JSON.stringify(keys.map((k) => [k, brief[k] ?? null]))).digest('hex');
}

export function createLocalWorkers({
  runtimeDir, launcherUrl, launcherToken, tokenFile, board, fetchImpl,
  maxConcurrent = 1, node = 'brrrrrrrr', timeoutMs = 30000, connectTimeoutMs = 20000, now = () => Date.now(), log = () => {},
  retries = 2, retryBaseMs = 400, disconnectFails = 3, disconnectMs = 45000, sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  artifactMaxBytes = 8 * 1024 * 1024,
} = {}) {
  fetchImpl = fetchImpl || keepAliveFetch({ connectTimeoutMs });
  const resultFetchMaxBytes = (Number(artifactMaxBytes) > 0 ? Number(artifactMaxBytes) : 8 * 1024 * 1024) + 64 * 1024;
  const dir = path.join(runtimeDir, 'local-workers');
  mkdirSync(dir, { recursive: true });
  const ledgerPath = path.join(dir, 'ledger.json');
  const baseCap = Math.max(1, Math.min(MAX_WORKERS, Number(maxConcurrent) || 1));
  const cpDir = path.join(runtimeDir, 'control-plane');
  const readCp = (f) => { try { return JSON.parse(readFileSync(path.join(cpDir, f), 'utf8')); } catch { return null; } };
  // Control-plane hooks (written by the control-plane connector). Re-read on every pump so changes apply without a restart.
  const paused = () => readCp('dispatch.json')?.paused === true;
  const effectiveCap = () => {
    const n = Number(readCp('concurrency.json')?.nodes?.[node]);
    return Number.isFinite(n) && n > 0 ? Math.max(1, Math.min(MAX_WORKERS, Math.floor(n))) : baseCap;
  };
  const token = () => launcherToken || readFileSync(tokenFile, 'utf8').trim();
  let ledger = existsSync(ledgerPath) ? JSON.parse(readFileSync(ledgerPath, 'utf8')) : { version: 1, attempts: {} };

  function persist() {
    const tmp = ledgerPath + '.tmp';
    writeFileSync(tmp, JSON.stringify(ledger, null, 1), { mode: 0o600 });
    renameSync(tmp, ledgerPath);
  }
  // GETs are idempotent: retry transport errors (not HTTP statuses) up to `retries` times with jittered
  // backoff, but never start a retry once `timeoutMs` has passed since the first try.
  async function call(method, p, body, opts) {
    const t0 = now();
    for (let i = 0; ; i++) {
      try { return await call1(method, p, body, opts); }
      catch (e) {
        if (e?.code === 'ERR_RESULT_TOO_LARGE' || method !== 'GET' || i >= retries || now() - t0 >= timeoutMs) throw e;
        await sleep(Math.round(retryBaseMs * 2 ** i * (0.5 + Math.random())));
      }
    }
  }
  async function call1(method, p, body, opts) {
    const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), timeoutMs);
    try {
      const r = await fetchImpl(launcherUrl.replace(/\/$/, '') + p, {
        method, signal: ctl.signal,
        headers: { Authorization: `Bearer ${token()}`, 'Content-Type': 'application/json' },
        body: body ? JSON.stringify(body) : undefined,
        maxBytes: opts?.maxBytes,
      });
      const j = await r.json().catch(() => ({}));
      return { status: r.status, body: j };
    } finally { clearTimeout(t); }
  }
  const active = () => Object.values(ledger.attempts).filter((a) => !TERMINAL.has(a.state) && a.state !== 'queued');
  const current = (taskId) => Object.values(ledger.attempts).filter((a) => a.task_id === taskId).sort((x, y) => y.generation - x.generation)[0];

  async function boardSync(a, note) {
    if (!board || !a.board_entry || a.superseded_by) return;
    const detail = `[local-worker ${a.attempt_id}] ${a.state}${a.detail ? ': ' + a.detail : ''}${note ? ' - ' + note : ''}`;
    try { await board.update({ group: a.group, entry: a.board_entry, status: BOARD_COLUMN[a.state] || 'doing', note: `${a.coordinator}: ${detail}`.slice(0, 500), by: BOARD_POSTER }); }
    catch (e) { log('board sync failed', e?.message); }
  }
  // Hysteresis: one failed poll is a blip, not a disconnect. Flip to `disconnected` only after
  // `disconnectFails` consecutive failures spanning at least `disconnectMs`.
  function noteFail(a, e) {
    a.fail_streak = (a.fail_streak || 0) + 1; a.first_fail_at = a.first_fail_at || now(); a.last_error = why(e);
    const down = a.fail_streak >= disconnectFails && now() - a.first_fail_at >= disconnectMs;
    if (!down) persist();
    return down;
  }
  function noteOk(a) {
    const had = a.fail_streak; a.fail_streak = 0; a.first_fail_at = null; a.last_ok_at = new Date(now()).toISOString();
    if (had) persist();
  }
  async function setState(a, state, detail, extra = {}) {
    if (ledger.attempts[a.attempt_id].superseded_by && state !== 'superseded') return a; // superseded attempts can't overwrite
    Object.assign(a, extra, { state, detail: detail ?? a.detail, updated_at: new Date(now()).toISOString() });
    a.history.push({ at: a.updated_at, state, detail: a.detail });
    persist(); await boardSync(a); return a;
  }

  async function create({ taskId, boardEntry, group, coordinator = 'MR.INDIA', brief, provider = 'opencode-go', model, tier }) {
    if (tier && !MODEL_TIERS[tier]) throw Object.assign(new Error(`unknown tier: ${tier} (simple|standard)`), { status: 400 });
    model = model || MODEL_TIERS[tier || 'standard'];
    if (!brief?.objective) throw new Error('brief.objective is required');
    const prev = current(taskId);
    const artifactCapability = randomBytes(32).toString('base64url');
    const a = {
      attempt_id: 'att_' + randomBytes(8).toString('hex'), task_id: taskId, board_entry: boardEntry || taskId, group, coordinator,
      capability_sha256: createHash('sha256').update(artifactCapability).digest('hex'),
      generation: (prev?.generation || 0) + 1, node, env_id: null, cua_run_id: null, opencode_session_id: null,
      workdir: brief.workdir || null, source_rev: brief.source_rev || null, input_manifest_sha256: manifestHash(brief),
      provider, model, tier: tier || null, brief: { ...brief, input_manifest_sha256: manifestHash(brief) }, state: 'queued', detail: 'waiting for a slot',
      created_at: new Date(now()).toISOString(), updated_at: null, dispatched_at: null, ended_at: null,
      event_cursor: 0, log_ref: null, artifact_refs: [], result: null, checks: [], review: null, history: [],
    };
    if (prev && !TERMINAL.has(prev.state)) {
      prev.superseded_by = a.attempt_id; await setState(prev, 'superseded', `replaced by ${a.attempt_id}`);
      call('POST', `/v1/attempts/${prev.attempt_id}/cancel`).catch(() => {});
    }
    ledger.attempts[a.attempt_id] = a; await setState(a, 'queued', 'waiting for a slot');
    Object.defineProperty(a, 'artifact_capability', { value: artifactCapability, enumerable: false, configurable: true });
    await pump(); return a;
  }

  async function dispatch(a) {
    await setState(a, 'dispatching', 'sending to launcher', { dispatched_at: new Date(now()).toISOString() }); // persisted BEFORE the call
    let r;
    try { r = await call('POST', '/v1/attempts', { attempt_id: a.attempt_id, brief: a.brief, model: a.model }); }
    catch (e) { return setState(a, 'outcome_unknown', `launcher did not confirm (${why(e)}); will reconcile, not re-send blindly`); }
    if (r.status === 200 || r.status === 201) return applyRemote(a, r.body);
    if (r.status >= 400 && r.status < 500) return setState(a, 'not_started', `launcher rejected: ${r.body.error || r.status}`, { ended_at: new Date(now()).toISOString() });
    return setState(a, 'outcome_unknown', `launcher answered ${r.status}`);
  }

  async function applyRemote(a, remote) {
    if (!remote || !LAUNCHER_STATES.has(remote.state)) return a;
    if (remote.state === 'queued') remote = { ...remote, state: 'launcher_queued', detail: `${remote.detail}${remote.queue_position ? ` (position ${remote.queue_position})` : ''}` };
    const extra = { cua_run_id: remote.run_id || a.cua_run_id, env_id: remote.sandbox || a.env_id };
    if (remote.model) extra.model_used = remote.model;
    if (remote.fallback) extra.fallback = remote.fallback;
    if (a.state === 'cancel_requested' && !['cancelled', 'succeeded', 'failed'].includes(remote.state)) return Object.assign(a, extra);
    if (TERMINAL.has(remote.state)) extra.ended_at = new Date(now()).toISOString();
    if (remote.state !== a.state || remote.detail !== a.detail) await setState(a, remote.state, remote.detail, extra); else Object.assign(a, extra);
    if (remote.state === 'succeeded' || remote.state === 'failed') await fetchResult(a);
    return a;
  }

  // Result manifests are private (0600) and replaced atomically; the artifact API pins their first-read hash.
  function saveResult(a, body) {
    const file = path.join(dir, `${a.attempt_id}.result.json`);
    const tmp = `${file}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(body, null, 1), { mode: 0o600 });
    renameSync(tmp, file);
    a.result = { ref: file, observed_files: (body.observed?.files || []).length, stop_reason: body.observed?.stop_reason };
    a.artifact_refs = (body.observed?.files || []).map((f) => ({ path: f.path, sha256: f.sha256, change: f.change, in_scope: f.in_assigned_scope }));
    a.checks = (body.checks || []).map((c) => ({ ...c, source: 'worker_claim' }));
    delete a.result_error;
    persist();
  }
  async function fetchResult(a) {
    try {
      const r = await call('GET', `/v1/attempts/${a.attempt_id}/result`, undefined, { maxBytes: resultFetchMaxBytes });
      if (r.status === 200) saveResult(a, r.body);
    } catch (e) {
      if (e?.code === 'ERR_RESULT_TOO_LARGE') { a.result_error = 'oversized'; persist(); }
    }
  }
  // Explicit refetch for the artifact API (e.g. Orbit restarted before the result was saved).
  async function refetchResult(id) {
    const a = ledger.attempts[id]; if (!a) return 'missing';
    let r;
    try { r = await call('GET', `/v1/attempts/${id}/result`, undefined, { maxBytes: resultFetchMaxBytes }); }
    catch (e) {
      if (e?.code === 'ERR_RESULT_TOO_LARGE') { a.result_error = 'oversized'; persist(); return 'oversized'; }
      return 'unreachable';
    }
    if (r.status !== 200 || !r.body || typeof r.body !== 'object') return 'missing';
    saveResult(a, r.body); return 'ok';
  }
  function pinArtifact(id, pin) {
    const a = ledger.attempts[id]; if (!a || a.artifact) return;
    a.artifact = { ...pin, first_read_at: new Date(now()).toISOString() }; persist();
  }

  async function poll(id) {
    const a = ledger.attempts[id]; if (!a || a.state === 'queued' || a.events_final || a.superseded_by) return a;
    if (TERMINAL.has(a.state) && !a.cua_run_id) return a;
    let r;
    try { r = await call('GET', `/v1/attempts/${id}/events?cursor=${a.event_cursor}`); }
    catch (e) {
      if (a.state === 'outcome_unknown' || a.state === 'dispatching') return a;
      if (!noteFail(a, e)) return a;
      if (a.state !== 'disconnected') await setState(a, 'disconnected', `launcher unreachable (${why(e)}); attempt keeps running on the PC`, { before_disconnect: a.state });
      return a;
    }
    noteOk(a);
    if (r.status === 404) {
      if (a.state === 'outcome_unknown' || a.state === 'dispatching') return setState(a, 'not_started', 'launcher has no record: never started (safe to retry)', { ended_at: new Date(now()).toISOString() });
      return setState(a, 'outcome_unknown', 'launcher lost the attempt record');
    }
    if (r.status !== 200) return a;
    const evs = r.body.events || [];
    if (evs.length) {
      a.event_cursor = r.body.cursor;
      a.log_ref = path.join(dir, `${id}.events.jsonl`);
      const rx = new Date(now()).toISOString(); // when the box received it (worker events may lack ts)
      writeFileSync(a.log_ref, evs.map((e) => JSON.stringify({ ...e, rx })).join('\n') + '\n', { flag: 'a' });
      const sess = evs.find((e) => e.kind === 'worker:session'); if (sess?.text) a.opencode_session_id = sess.text;
      persist();
    }
    if (TERMINAL.has(a.state) && (r.body.events || []).length === 0) { a.events_final = true; persist(); return a; }
    const st = await call('GET', `/v1/attempts/${id}`).catch(() => null);
    if (st?.status === 200) await applyRemote(a, st.body);
    if (TERMINAL.has(a.state)) return poll(id); // drain events emitted before the terminal state
    return a;
  }

  async function cancel(id) {
    const a = ledger.attempts[id]; if (!a || TERMINAL.has(a.state)) return a;
    if (a.state === 'queued') return setState(a, 'cancelled', 'cancelled before dispatch', { ended_at: new Date(now()).toISOString() });
    await setState(a, 'cancel_requested', 'waiting for the launcher to confirm');
    try { const r = await call('POST', `/v1/attempts/${id}/cancel`); if (r.status === 202 && r.body.state === 'cancelled') await setState(a, 'cancelled', r.body.detail, { ended_at: new Date(now()).toISOString() }); }
    catch { /* stays cancel_requested; reconcile re-sends */ }
    return a;
  }

  async function review(id, { accepted, note, by }) {
    const a = ledger.attempts[id]; if (a?.state !== 'succeeded') throw new Error('only succeeded attempts can be reviewed');
    a.review = { accepted: !!accepted, note: note || '', by: by || a.coordinator, at: new Date(now()).toISOString() };
    return setState(a, accepted ? 'accepted' : 'rejected', note || (accepted ? 'accepted by coordinator' : 'changes requested'));
  }

  // Push the control-plane cap to the launcher (POST /v1/config, launcher >= 0.1.5) only when it changes.
  let pushedCap = null;
  async function syncLauncherCap() {
    if (!readCp('concurrency.json')) return;
    const want = effectiveCap(); if (want === pushedCap) return;
    try { const r = await call('POST', '/v1/config', { max_concurrent: want }); if (r.status === 200) { pushedCap = want; log('launcher cap set', want); } else if (r.status === 404) pushedCap = want; }
    catch { /* retried next pump */ }
  }

  async function pump() {
    await syncLauncherCap();
    if (paused()) return; // running attempts keep polling; only new dispatch stops
    const cap = effectiveCap();
    const queued = Object.values(ledger.attempts).filter((a) => a.state === 'queued').sort((x, y) => x.created_at.localeCompare(y.created_at));
    for (const a of queued) { if (active().length >= cap) break; await dispatch(a); }
  }

  // Restart recovery: never re-dispatch; ask the launcher what it has.
  async function reconcile() {
    for (const a of Object.values(ledger.attempts)) {
      if (TERMINAL.has(a.state) || a.state === 'queued') continue;
      let r;
      try { r = await call('GET', `/v1/attempts/${a.attempt_id}`); }
      catch (e) { if (noteFail(a, e) && !['outcome_unknown', 'dispatching', 'disconnected'].includes(a.state)) await setState(a, 'disconnected', `launcher unreachable (${why(e)})`); continue; }
      noteOk(a);
      if (r.status === 404) {
        await setState(a, a.state === 'dispatching' || a.state === 'outcome_unknown' ? 'not_started' : 'outcome_unknown',
          'launcher has no record of this attempt', a.state === 'dispatching' || a.state === 'outcome_unknown' ? { ended_at: new Date(now()).toISOString() } : {});
        continue;
      }
      if (a.state === 'cancel_requested' && !TERMINAL.has(r.body.state)) { call('POST', `/v1/attempts/${a.attempt_id}/cancel`).catch(() => {}); continue; }
      if (a.state === 'disconnected' || a.state === 'outcome_unknown' || a.state === 'dispatching') a.state = r.body.state === a.state ? a.state : 'reconnecting';
      await applyRemote(a, r.body);
      await poll(a.attempt_id);
    }
    await pump();
  }

  async function tick() { for (const a of active()) await poll(a.attempt_id); await reconcile(); }

  // Move old terminal attempts out of the live ledger into archive-<time>.json (per-attempt files stay).
  function archive({ olderThanMs = 86400000, target = 400, exclude = [] } = {}) {
    const ex = new Set(exclude); const cut = now() - olderThanMs;
    const all = Object.values(ledger.attempts);
    const ts = (a) => Date.parse(a.ended_at || a.created_at) || 0;
    const cand = all.filter((a) => TERMINAL.has(a.state) && !ex.has(a.attempt_id) && ts(a) < cut).sort((x, y) => ts(x) - ts(y));
    const moved = cand.slice(0, Math.max(0, all.length - target));
    if (!moved.length) return { archived: 0, total: all.length, file: null };
    const stamp = new Date(now()).toISOString().replace(/[:.]/g, '-');
    const file = path.join(dir, `archive-${stamp}.json`);
    writeFileSync(file + '.tmp', JSON.stringify({ version: 1, archived_at: new Date(now()).toISOString(), attempts: Object.fromEntries(moved.map((a) => [a.attempt_id, a])) }, null, 1), { mode: 0o600 });
    renameSync(file + '.tmp', file);
    for (const a of moved) delete ledger.attempts[a.attempt_id];
    persist();
    return { archived: moved.length, total: Object.keys(ledger.attempts).length, file };
  }

  return {
    create, poll, cancel, review, reconcile, tick, pump, archive, refetchResult, pinArtifact,
    get: (id) => ledger.attempts[id], list: () => Object.values(ledger.attempts),
    get cap() { return effectiveCap(); }, get paused() { return paused(); },
    reload() { ledger = JSON.parse(readFileSync(ledgerPath, 'utf8')); },
  };
}

// Board client using the existing loopback collab-board API (key read server-side, never exported).
export function collabBoardClient({ runtimeDir, port = 4318, fetchImpl = globalThis.fetch }) {
  const key = () => readFileSync(path.join(runtimeDir, 'collab-board.key'), 'utf8').trim();
  async function post(body) {
    const r = await fetchImpl(`http://127.0.0.1:${port}/api/collab-board`, { method: 'POST', headers: { Authorization: `Bearer ${key()}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    if (!r.ok) throw new Error(`collab-board ${r.status}`); return r.json();
  }
  return {
    create: ({ group, title, spec, by }) => post({ group, op: 'new', title, spec, status: 'todo', by }),
    update: ({ group, entry, status, note, by }) => post({ group, op: 'update', entry, status, note, by }),
  };
}
