// Scoped backend for the sandboxed "Agents" (Grok Bots) Orbit app.
//
// Provider registry: the agent list is driven by the same profile catalog that
// Orbit's agent-chat provider dropdown uses (`/api/agent` action `profiles`,
// i.e. createAgentHandler's `configuration`). Every catalog profile is mapped to
// an adapter by provider id:
//   - gateway providers (grok, pi, … see agent-providers.mjs) → "gateway" adapter
//     (listAgents / getAgentTranscriptTail / sendPrompt / interruptAgentRun)
//   - hermes and unknown providers → "sessions" adapter (Hermes API server:
//     /api/sessions, /api/sessions/:id/messages, /v1/runs)
// A new provider added to Orbit's catalog appears automatically; a provider with a
// different wire protocol only needs registerProviderAdapter(provider, adapter).
//
// Auth: random capability in the runtime dir, handed to the app through the pane
// URL fragment (never in published files). Requests must come from the opaque app
// origin ("null"). Credentials never leave the server; errors are redacted.
import fs from 'node:fs';
import path from 'node:path';
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { createGatewayActivity, makeRedactor } from './grokbots-activity.mjs';
import * as hermesControls from './grokbots-controls-hermes.mjs';
import * as piControls from './grokbots-controls-pi.mjs';
import * as grokControls from './grokbots-controls-grok.mjs';
import { createGroups } from './grokbots-groups.mjs';

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const SAFE = /^[A-Za-z0-9_:-]{1,128}$/;
const RUN = /^[A-Za-z0-9_.:-]{1,128}$/;
let gatewayProviders = ['grok', 'pi'];
try { const m = await import('./agent-providers.mjs'); if (Array.isArray(m.GATEWAY_PROVIDERS)) gatewayProviders = [...m.GATEWAY_PROVIDERS]; } catch {}
const LABELS = { hermes: 'Hermes', grok: 'Grok Bot', pi: 'Pi' };

const fail = (message, status = 502) => Object.assign(Error(message), { status });
// Full-length redaction for JSON payloads (redact() below also trims to 300 chars for error text).
function redactFull(s, secret) { let t = String(s ?? ''); if (secret && secret.length >= 8) t = t.split(secret).join('[redacted]'); return t.replace(/Bearer\s+[A-Za-z0-9._~+\/=-]+/gi, 'Bearer [redacted]'); }
function redact(s, secret) { let t = String(s || ''); if (secret) t = t.split(secret).join('[redacted]'); return t.replace(/Bearer\s+\S+/gi, 'Bearer [redacted]').replace(/[\x00-\x08\x0b-\x1f\x7f]/g, ' ').trim().slice(0, 300); }
function reason(text, secret) {
  let d = '';
  try { const j = JSON.parse(text); const e = j?.error ?? j?.message ?? j?.detail ?? j?.reason; d = typeof e === 'string' ? e : typeof e?.message === 'string' ? e.message : e ? JSON.stringify(e) : ''; if (j?.code && typeof j.code === 'string' && !d.includes(j.code)) d = `${d} (${j.code})`.trim(); }
  catch { d = /<html/i.test(text) ? '' : text; }
  return redact(d, secret);
}

export function loadGrokBotsKey(runtimeRoot) {
  const file = path.join(runtimeRoot, 'grokbots-app.key');
  try { const k = fs.readFileSync(file, 'utf8').trim(); if (k.length >= 32) return k; } catch {}
  const k = randomBytes(32).toString('base64url');
  fs.writeFileSync(file, k + '\n', { mode: 0o600 });
  return k;
}

async function http(profile, route, { method, body, label, headers }) {
  let r;
  try {
    r = await fetch(`${profile.apiUrl.replace(/\/$/, '')}${route}`, { method: method || (body === undefined ? 'GET' : 'POST'), redirect: 'error', signal: AbortSignal.timeout(20000),
      headers: { Authorization: `Bearer ${profile.apiKey}`, 'Content-Type': 'application/json', 'x-sand-request-id': randomUUID(), ...(headers || {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  } catch { throw fail(`Cannot reach ${label}.`); }
  const text = (await r.text()).slice(0, 4 * 1024 * 1024);
  if (!r.ok) { const d = reason(text, profile.apiKey); throw fail(`${label} refused the request (HTTP ${r.status})${d ? `: ${d}` : '.'}`, [400, 404, 409, 429].includes(r.status) ? r.status : 502); }
  try { return text ? JSON.parse(text) : null; } catch { throw fail(`${label} returned invalid JSON.`); }
}

// ---- gateway adapter (Grok Bot, Pi, future gateway providers) -------------
function entryText(e) {
  if (e.kind === 'send-message' && e.message?.type === 'text' && typeof e.message.content === 'string') return { role: 'assistant', content: e.message.content };
  if ((e.kind === 'message' || e.kind == null) && (e.role === 'user' || e.role === 'assistant') && typeof e.content === 'string') return { role: e.role, content: e.content };
  return null;
}
// Gateway agent ids: Grok Bot uses UUIDs, the Pi gateway uses pi_<16 hex> (server/pi-gateway.mjs AGENT_ID).
const GW_ID = { test: v => UUID.test(v) || /^pi_[a-f0-9]{16}$/.test(v) };
const gatewayAdapter = {
  kind: 'gateway',
  async agents(p, label) {
    const rows = await http(p, '/api/listAgents', { body: {}, label });
    return (Array.isArray(rows) ? rows : []).filter(a => a && GW_ID.test(a.id)).map(a => ({
      id: a.id, name: String(a.name || a.title || 'Untitled').slice(0, 120), description: String(a.description || '').slice(0, 300),
      avatar: typeof a.avatarDataUrl === 'string' && a.avatarDataUrl.length < 200000 && a.avatarDataUrl.startsWith('data:image/') ? a.avatarDataUrl : null,
      color: typeof a.avatarColor === 'string' ? a.avatarColor.slice(0, 32) : null, updatedAt: Number(a.lastActivityAt || a.updatedAt) || 0,
      running: !!(a.isRunning || a.isRunningTurn || a.isComposingMessage), awaiting: !!a.awaitingUserResponse, unread: Number(a.unreadCount) || 0,
      preview: String(a.lastMessagePreview || '').slice(0, 200), sessions: false,
    }));
  },
  async history(p, label, { agent, before }) {
    if (!GW_ID.test(agent || '')) throw fail('Invalid agent id.', 400);
    // Pi's tail has no paging and tool entries dominate it, so ask for a larger window there.
    const req = { id: agent, limit: /^pi_/.test(agent) ? 400 : 60 }; if (Number.isSafeInteger(before) && before > 0) req.beforeSeq = before;
    const tail = await http(p, '/api/getAgentTranscriptTail', { body: req, label });
    const messages = []; let streaming = null;
    for (const raw of Array.isArray(tail?.entries) ? tail.entries : []) {
      const e = raw?.entry && raw.kind == null ? raw.entry : raw; if (!e || typeof e !== 'object') continue;
      if (e.isStreaming === true || e.streaming === true) { const c = e.kind === 'send-message' ? e.message?.content : e.content; if (typeof c === 'string' && c.trim()) streaming = c.slice(0, 60000); continue; }
      const m = entryText(e); if (!m || !m.content.trim()) continue;
      messages.push({ id: String(e.id || e.seq || ''), ts: Number(e.timestampMs) || Date.parse(e.at || '') || 0, role: m.role, content: m.content.slice(0, 60000) });
    }
    let cards = [];
    if (p.provider === 'grok') { try { cards = grokControls.extractPendingCards(tail?.entries).map(c => JSON.parse(redactFull(JSON.stringify(c), p.apiKey))); } catch { cards = []; } }
    return { messages, streaming, cards, before: Number.isSafeInteger(tail?.nextBeforeSeq) ? tail.nextBeforeSeq : null };
  },
  async send(p, label, { agent, prompt }) {
    if (!GW_ID.test(agent || '')) throw fail('Invalid agent id.', 400);
    const r = await http(p, '/api/sendPrompt', { body: { prompt, agentId: agent, clientNonce: randomUUID() }, label });
    if (!r || r.accepted !== true) throw fail(`${label} did not accept the message${r?.reason ? `: ${redact(r.reason, p.apiKey)}` : '.'}`);
    return { accepted: true };
  },
  async stop(p, label, { agent }) { if (!GW_ID.test(agent || '')) throw fail('Invalid agent id.', 400); await http(p, '/api/interruptAgentRun', { body: { id: agent }, label }); return { ok: true }; },
  async activity(p, label, { agent, since }, ctx) {
    if (!GW_ID.test(agent || '')) throw fail('Invalid agent id.', 400);
    let feed = activityFeeds.get(p.id);
    if (!feed) { feed = createGatewayActivity({ profile: () => ctx.profile(p.id), label, extraSecrets: ctx.secrets }); activityFeeds.set(p.id, feed); }
    // Seed state from the roster (read-only listAgents, cached) so a run already in progress shows up.
    const cache = rosterCache.get(p.id);
    let rows = cache && Date.now() - cache.at < 1800 ? cache.rows : null;
    if (!rows) { try { rows = await http(p, '/api/listAgents', { body: {}, label }); rosterCache.set(p.id, { at: Date.now(), rows }); } catch { rows = []; } }
    const row = (Array.isArray(rows) ? rows : []).find(a => a?.id === agent) || null;
    const out = await feed.read(agent, since, row);
    out.subagents = ctx.agentStatus ? ctx.agentStatus.read(agent) : { agents: [], history: [] };
    return out;
  },
};
const activityFeeds = new Map();
const rosterCache = new Map();

// ---- sessions adapter (Hermes API server and Hermes-compatible providers) --
const ts = v => { const n = Number(v); return Number.isFinite(n) ? (n < 1e11 ? n * 1000 : n) : (Date.parse(v) || 0); };
async function hermesMessages(p, label, session, limit, offset) {
  const page = await http(p, `/api/sessions/${encodeURIComponent(session)}/messages?limit=${limit}&offset=${offset}&order=latest`, { label });
  const rows = Array.isArray(page?.data) ? page.data : [];
  return { rows, has_more: page?.has_more === true || rows.length >= limit };
}
const sessionsAdapter = {
  kind: 'sessions',
  async agents(p, label) { return [{ id: p.id, name: label, description: 'Profile · pick or start a conversation', avatar: null, color: null, updatedAt: 0, running: false, awaiting: false, unread: 0, preview: '', sessions: true }]; },
  async sessions(p, label, { offset }) {
    const off = Number.isSafeInteger(offset) && offset > 0 ? offset : 0;
    const page = await http(p, `/api/sessions?limit=50&offset=${off}`, { label });
    const rows = Array.isArray(page?.data) ? page.data : [];
    return { sessions: rows.filter(s => s && SAFE.test(s.id) && !s.archived && !s.hidden).map(s => ({ id: s.id, title: String(s.title || s.preview || s.id).slice(0, 200), preview: String(s.preview || '').slice(0, 200), source: String(s.source || '').slice(0, 40), messages: Number(s.message_count) || 0, updatedAt: ts(s.last_active ?? s.updated_at ?? s.started_at) })),
      next: page?.has_more === true || rows.length >= 50 ? off + rows.length : null };
  },
  async history(p, label, { session, before }) {
    if (!SAFE.test(session || '')) throw fail('Invalid session id.', 400);
    let off = Number.isSafeInteger(before) && before > 0 ? before : 0;
    // Hermes interim replies are assistant rows that ALSO carry tool_calls; dropping those hid all but the final reply.
    const keep = m => m && ['user', 'assistant'].includes(m.role) && m.display_kind !== 'hidden' && typeof (m.content ?? m.text) === 'string' && String(m.content ?? m.text).trim();
    // Tool-heavy sessions: keep paging (bounded) until enough chat text is found.
    let rows = [], more = false;
    for (let i = 0; i < 6; i++) {
      let page;
      try { page = await hermesMessages(p, label, session, 100, off); } catch (e) { if (e.status === 404 && !rows.length) return { messages: [], streaming: null, before: null }; throw e; }
      rows = rows.concat(page.rows); off += page.rows.length; more = page.has_more && page.rows.length > 0;
      if (!more || rows.filter(keep).length >= 30) break;
    }
    const messages = rows.filter(keep)
      .map(m => ({ id: String(m.id ?? ''), ts: ts(m.timestamp ?? m.created_at), role: m.role, content: String(m.content ?? m.text).slice(0, 60000), _n: Number(m.id) || 0 }))
      .sort((a, b) => a._n - b._n || a.ts - b.ts).map(({ _n, ...m }) => m);
    const page = { has_more: more, rows: [] };
    return { messages, streaming: null, before: page.has_more ? off : null };
  },
  async send(p, label, { session, prompt, nonce }) {
    const creating = !session;
    const sid = creating ? `orbit-${randomUUID()}` : session;
    if (!SAFE.test(sid)) throw fail('Invalid session id.', 400);
    // No conversation_history: with a session_id Hermes loads the session itself, including tool turns and
    // compression rotation. Idempotency-Key (client nonce) makes a retry after a lost response safe.
    const key = typeof nonce === 'string' && /^[A-Za-z0-9_-]{8,100}$/.test(nonce) ? nonce : randomUUID();
    const data = await http(p, '/v1/runs', { body: { input: prompt, session_id: sid }, label, headers: { 'Idempotency-Key': `orbit-${key}` } });
    if (!RUN.test(String(data?.run_id || ''))) throw fail(`${label} did not return a run id.`);
    return { accepted: true, session: sid, run: data.run_id, created: creating, replayed: data.replayed === true };
  },
  async run(p, label, { run, session }) {
    if (!RUN.test(run || '')) throw fail('Invalid run id.', 400);
    const r = await http(p, `/v1/runs/${encodeURIComponent(run)}`, { label });
    // Hermes may rotate a long session to a compression continuation id; follow it rather than failing.
    const runSession = typeof r?.session_id === 'string' && SAFE.test(r.session_id) ? r.session_id : null;
    const le = r?.last_event; const lastEvent = le ? redact(typeof le === 'string' ? le : (le.event || le.type || le.name || '') + (le.tool ? ` ${le.tool}` : le.tool_name ? ` ${le.tool_name}` : ''), p.apiKey).slice(0, 120) : '';
    return { lastEvent, session: runSession, status: String(r?.status || 'unknown'), output: typeof r?.output === 'string' ? r.output.slice(0, 60000) : '', error: r?.error ? redact(typeof r.error === 'string' ? r.error : r.error.message || JSON.stringify(r.error), p.apiKey) : '' };
  },
  async stop(p, label, { run }) { if (!RUN.test(run || '')) throw fail('Invalid run id.', 400); await http(p, `/v1/runs/${encodeURIComponent(run)}/stop`, { body: {}, label }); return { ok: true }; },
};

const adapters = new Map();
for (const id of gatewayProviders) adapters.set(id, gatewayAdapter);
adapters.set('hermes', sessionsAdapter);
/** Extension point: map a provider id (catalog profile.provider) to an adapter. */
export function registerProviderAdapter(provider, adapter) { adapters.set(provider, adapter); }
const adapterFor = provider => adapters.get(provider) || sessionsAdapter; // Orbit treats unknown providers as Hermes-compatible

export function createGrokBotsApp({ runtimeRoot, catalog, agentStatus, chats }) {
  const keyBuf = Buffer.from(loadGrokBotsKey(runtimeRoot));
  const cors = { 'Access-Control-Allow-Origin': 'null', 'Access-Control-Allow-Headers': 'Authorization, Content-Type', 'Access-Control-Allow-Methods': 'POST, OPTIONS', 'Access-Control-Max-Age': '600', Vary: 'Origin', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' };
  const send = (res, status, data) => { res.writeHead(status, { ...cors, 'Content-Type': 'application/json' }); res.end(JSON.stringify(data)); };

  function profiles() {
    const c = catalog(); const list = Array.isArray(c?.list) ? c.list : [];
    return list.map(item => { const p = c.get(item.id); const provider = typeof p?.provider === 'string' ? p.provider : 'hermes';
      return p?.apiUrl && p?.apiKey ? { p, provider, adapter: adapterFor(provider), label: String(item.label || LABELS[provider] || provider).slice(0, 120), providerLabel: LABELS[provider] || provider } : null; }).filter(Boolean);
  }
  const keyText = keyBuf.toString();
  let groupsApi = null;
  const groupsFor = () => groupsApi || (groupsApi = createGroups({ runtimeRoot, catalog, chats: () => (typeof chats === 'function' ? chats() : null) || new Map(), profiles }));
  const rosterFor = async id => { const f = profiles().find(x => x.p.id === id); if (!f || f.adapter.kind !== 'gateway') return []; return f.adapter.agents(f.p, f.label); };
  const ctx = { profile: id => profiles().find(x => x.p.id === id)?.p || null, secrets: () => [keyText], agentStatus };
  function resolve(id) { const f = profiles().find(x => x.p.id === id); if (!f) throw fail('Unknown provider profile.', 404); return f; }

  async function agents() {
    return { groups: await Promise.all(profiles().map(async x => {
      const base = { profile: x.p.id, provider: x.provider, providerLabel: x.providerLabel, label: x.label, kind: x.adapter.kind };
      try { return { ...base, agents: await x.adapter.agents(x.p, x.label) }; } catch (e) { return { ...base, agents: [], error: e.message }; }
    })) };
  }

  async function handle(req, res) {
    if (req.method === 'OPTIONS') { res.writeHead(204, cors); return res.end(); }
    if (req.method !== 'POST') return send(res, 405, { error: 'Method not allowed' });
    if (req.headers.origin !== undefined && req.headers.origin !== 'null') return send(res, 403, { error: 'Origin rejected' });
    const given = Buffer.from(String(req.headers.authorization || '').replace(/^Bearer\s+/i, ''));
    if (given.length !== keyBuf.length || !timingSafeEqual(given, keyBuf)) return send(res, 401, { error: 'Missing or invalid app key. Reopen the pane from Orbit.' });
    let raw = '';
    for await (const part of req) { raw += part; if (raw.length > 64000) { send(res, 413, { error: 'Too large' }); return req.destroy(); } }
    let b; try { b = JSON.parse(raw || '{}'); } catch { return send(res, 400, { error: 'Invalid JSON' }); }
    try {
      if (b.action === 'agents') return send(res, 200, await agents());
      if (b.action === 'groups') return send(res, 200, JSON.parse(redactFull(JSON.stringify(await groupsFor().handle(b, rosterFor)), '')));
      const x = resolve(b.profile);
      if (b.action === 'describe' || b.action === 'controls') {
        // Provider control modules: Grok gateway, Pi gateway, and Hermes(-compatible) sessions profiles.
        const mod = x.provider === 'grok' ? grokControls : x.provider === 'pi' ? piControls : x.adapter.kind === 'sessions' ? hermesControls : null;
        if (!mod) return send(res, 200, b.action === 'describe' ? { provider: x.provider, controls: [] } : { error: 'No controls for this provider.' });
        const pp = { ...x.p, provider: x.provider };
        if (b.action === 'describe') return send(res, 200, { provider: x.provider, controls: mod.describe(pp), ...(mod === piControls ? { activityEvents: piControls.ACTIVITY_EVENTS } : {}) });
        const action = typeof b.control === 'string' ? b.control.slice(0, 60) : '';
        const args = b.args && typeof b.args === 'object' && !Array.isArray(b.args) ? b.args : {};
        const red = v => redact(String(v ?? ''), x.p.apiKey);
        const cctx = mod === grokControls ? { gateway: (cmd, body) => http(x.p, `/api/${cmd}`, { body: body || {}, label: x.label }) }
          : mod === hermesControls ? { fetchHermes: (path, o = {}) => http(x.p, path, { method: o.method, body: o.body, label: x.label }), redact: red }
          : {};
        const target = mod === grokControls ? { agent: b.agent } : mod === piControls ? { session: b.agent } : { session: b.session, run: b.run };
        const out = await mod.control(pp, { action, ...target, args }, cctx);
        return send(res, 200, JSON.parse(redactFull(JSON.stringify(out ?? {}), x.p.apiKey)));
      }
      const fn = { sessions: x.adapter.sessions, history: x.adapter.history, send: x.adapter.send, run: x.adapter.run, stop: x.adapter.stop, activity: x.adapter.activity }[b.action];
      if (!fn) return send(res, 400, { error: `Action not supported for ${x.providerLabel}.` });
      if (b.action === 'send') { const t = typeof b.prompt === 'string' ? b.prompt.trim() : ''; if (!t || t.length > 20000) throw fail('Message must be 1–20000 characters.', 400); b.prompt = t; }
      return send(res, 200, await fn(x.p, x.label, b, ctx));
    } catch (e) { return send(res, e.status || 502, { error: String(e.message || 'Failed').slice(0, 400) }); }
  }
  return { handle };
}
