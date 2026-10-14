// In-memory subagent status board. Loopback-only POST /api/agent-status with a dedicated key.
// Nothing is written to disk except the key file (owner-only).
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { makeRedactor } from './grokbots-activity.mjs';

const TTL_MS = 30 * 60 * 1000, HISTORY = 20, MAX_AGENTS = 30, MAX_PARENTS = 100;
const STATES = new Set(['working', 'done', 'blocked']);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function createAgentStatus({ runtimeRoot }) {
  const keyFile = path.join(runtimeRoot, 'agent-status.key');
  let key;
  try { key = fs.readFileSync(keyFile, 'utf8').trim(); } catch {}
  if (!key || key.length < 32) { key = crypto.randomBytes(32).toString('hex'); fs.writeFileSync(keyFile, key + '\n', { mode: 0o600 }); }
  try { fs.chmodSync(keyFile, 0o600); } catch {}
  const keyBuf = Buffer.from(key);
  const redact = makeRedactor([key]);
  const boards = new Map(); // parent -> { agents: Map(agent -> {agent,status,state,ts,since}), history: [], at }

  const prune = () => {
    const now = Date.now();
    for (const [p, b] of boards) {
      for (const [a, s] of b.agents) if (now - s.ts > TTL_MS) b.agents.delete(a);
      b.history = b.history.filter(h => now - h.ts <= TTL_MS);
      if (!b.agents.size && !b.history.length) boards.delete(p);
    }
  };
  const clean = (v, n) => redact(String(v ?? '').replace(/[\u0000-\u001f\u007f]+/g, ' ').trim()).slice(0, n);

  function update({ parent, agent, status, state }) {
    if (!UUID.test(parent || '')) throw Object.assign(new Error('parent must be a bot uuid'), { status: 400 });
    const a = clean(agent, 64); const st = clean(status, 200);
    if (!a || !st) throw Object.assign(new Error('agent and status are required'), { status: 400 });
    const s = STATES.has(state) ? state : 'working';
    prune();
    let b = boards.get(parent.toLowerCase());
    if (!b) { if (boards.size >= MAX_PARENTS) throw Object.assign(new Error('too many parents'), { status: 429 }); b = { agents: new Map(), history: [] }; boards.set(parent.toLowerCase(), b); }
    const now = Date.now(); const prev = b.agents.get(a);
    if (!prev && b.agents.size >= MAX_AGENTS) { const oldest = [...b.agents.values()].sort((x, y) => x.ts - y.ts)[0]; b.agents.delete(oldest.agent); }
    b.agents.set(a, { agent: a, status: st, state: s, ts: now, since: prev && prev.state === 'working' ? prev.since : now });
    b.history.push({ agent: a, status: st, state: s, ts: now }); if (b.history.length > HISTORY) b.history.splice(0, b.history.length - HISTORY);
  }

  function read(parent) {
    prune();
    const b = boards.get(String(parent || '').toLowerCase());
    if (!b) return { agents: [], history: [] };
    return { agents: [...b.agents.values()].sort((x, y) => y.ts - x.ts), history: b.history.slice().reverse() };
  }

  async function handle(req, res) {
    const send = (code, obj) => { res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(obj)); };
    const ra = req.socket?.remoteAddress || '';
    if (!(ra === '127.0.0.1' || ra === '::1' || ra === '::ffff:127.0.0.1')) return send(403, { error: 'loopback only' });
    if (req.headers.origin) return send(403, { error: 'no browser callers' });
    if (req.method !== 'POST') return send(405, { error: 'POST only' });
    const got = Buffer.from(String(req.headers.authorization || '').replace(/^Bearer\s+/i, ''));
    if (got.length !== keyBuf.length || !crypto.timingSafeEqual(got, keyBuf)) return send(401, { error: 'unauthorized' });
    let raw = '';
    for await (const c of req) { raw += c; if (raw.length > 4096) return send(413, { error: 'too large' }); }
    try { update(JSON.parse(raw || '{}')); return send(200, { ok: true }); }
    catch (e) { return send(e.status || 400, { error: e.status ? e.message : 'bad json' }); }
  }
  setInterval(prune, 60_000).unref();
  return { handle, read };
}
