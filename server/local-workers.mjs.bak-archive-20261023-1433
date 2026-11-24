// Orbit-side adapter for local workers running on Kyle's PC (pc-launcher/).
// Holds only the per-launcher scoped API token. Never sees the provider key or a
// Cua/spacesd host token. Board updates use the existing collab-board API
// server-side (the board key stays on this host).
import { mkdirSync, readFileSync, renameSync, writeFileSync, existsSync } from 'node:fs';
import { randomBytes, createHash } from 'node:crypto';
import path from 'node:path';

export const TERMINAL = new Set(['succeeded', 'failed', 'cancelled', 'superseded', 'not_started', 'accepted', 'rejected']);
// detailed state -> board column (todo|doing|review|done|blocked)
export const BOARD_COLUMN = {
  queued: 'todo', launcher_queued: 'todo', dispatching: 'doing', outcome_unknown: 'doing', starting: 'doing', running: 'doing', backoff: 'doing',
  disconnected: 'doing', cancel_requested: 'doing', succeeded: 'review', accepted: 'done', rejected: 'blocked',
  failed: 'blocked', cancelled: 'blocked', not_started: 'blocked',
};
const why = (e) => e?.cause?.code || e?.cause?.name || e?.name || 'error';
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
  runtimeDir, launcherUrl, launcherToken, tokenFile, board, fetchImpl = globalThis.fetch,
  maxConcurrent = 1, node = 'brrrrrrrr', timeoutMs = 15000, now = () => Date.now(), log = () => {},
} = {}) {
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
  async function call(method, p, body) {
    const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), timeoutMs);
    try {
      const r = await fetchImpl(launcherUrl.replace(/\/$/, '') + p, {
        method, signal: ctl.signal,
        headers: { Authorization: `Bearer ${token()}`, 'Content-Type': 'application/json' },
        body: body ? JSON.stringify(body) : undefined,
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
    const a = {
      attempt_id: 'att_' + randomBytes(8).toString('hex'), task_id: taskId, board_entry: boardEntry || taskId, group, coordinator,
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

  async function fetchResult(a) {
    try {
      const r = await call('GET', `/v1/attempts/${a.attempt_id}/result`);
      if (r.status !== 200) return;
      const file = path.join(dir, `${a.attempt_id}.result.json`);
      writeFileSync(file, JSON.stringify(r.body, null, 1));
      a.result = { ref: file, observed_files: (r.body.observed?.files || []).length, stop_reason: r.body.observed?.stop_reason };
      a.artifact_refs = (r.body.observed?.files || []).map((f) => ({ path: f.path, sha256: f.sha256, change: f.change, in_scope: f.in_assigned_scope }));
      a.checks = (r.body.checks || []).map((c) => ({ ...c, source: 'worker_claim' }));
      persist();
    } catch { /* retried on next poll */ }
  }

  async function poll(id) {
    const a = ledger.attempts[id]; if (!a || a.state === 'queued' || a.events_final || a.superseded_by) return a;
    if (TERMINAL.has(a.state) && !a.cua_run_id) return a;
    let r;
    try { r = await call('GET', `/v1/attempts/${id}/events?cursor=${a.event_cursor}`); }
    catch (e) {
      if (a.state === 'outcome_unknown' || a.state === 'dispatching') return a;
      if (a.state !== 'disconnected') await setState(a, 'disconnected', `launcher unreachable (${why(e)}); attempt keeps running on the PC`, { before_disconnect: a.state });
      return a;
    }
    if (r.status === 404) {
      if (a.state === 'outcome_unknown' || a.state === 'dispatching') return setState(a, 'not_started', 'launcher has no record: never started (safe to retry)', { ended_at: new Date(now()).toISOString() });
      return setState(a, 'outcome_unknown', 'launcher lost the attempt record');
    }
    if (r.status !== 200) return a;
    const evs = r.body.events || [];
    if (evs.length) {
      a.event_cursor = r.body.cursor;
      a.log_ref = path.join(dir, `${id}.events.jsonl`);
      writeFileSync(a.log_ref, evs.map((e) => JSON.stringify(e)).join('\n') + '\n', { flag: 'a' });
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
      catch (e) { if (!['outcome_unknown', 'dispatching', 'disconnected'].includes(a.state)) await setState(a, 'disconnected', `launcher unreachable (${why(e)})`); continue; }
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

  return {
    create, poll, cancel, review, reconcile, tick, pump,
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
