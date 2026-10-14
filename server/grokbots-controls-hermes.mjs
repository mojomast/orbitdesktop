// Hermes controls for the Orbit "Grok Bots" app.
//
// CONTRACT (for the integrator)
//   describe(profile) -> [{id,label,kind,risk,confirm?,confirm2?,options?,needs}]
//     kind: 'meter'|'select'|'action'|'toggle'|'text'|'approval'; risk: 'none'|'low'|'medium'|'high'.
//     needs: 'session' | 'run' (which id the UI must pass).
//   control(profile, {action, session, run, args}, ctx) -> JSON, or throws Error with .status.
//     ctx.fetchHermes(path, {method, body}) -> parsed JSON from the gateway (:8642, key server-side).
//     ctx.redact(string) -> string. Optional ctx.fetchImpl / ctx.WebSocket for tests.
//   Actions that change state require args.confirm === true where describe() says confirm;
//   approval choice 'always' additionally requires args.confirmAlways === true.
//   Compact may rotate the session: result.session_id is the id to follow from now on.
//
// TRANSPORTS
//   Gateway REST (always): sessions, model lock, runs/approval/steer, usage fields.
//   Dashboard JSON-RPC over ws://<dashboard>/api/ws (optional): session.usage, session.compress,
//   config.set reasoning. Used only if a dashboard credential is configured server-side:
//   profile.dashboardUrl (default http://127.0.0.1:9119) and profile.dashboardToken or env
//   HERMES_DASHBOARD_TOKEN (a dashboard session access token, sent as ?token=). This dashboard is
//   gated (OAuth login), so a ticket cannot be minted without a login session; without the
//   credential the meter falls back to gateway usage fields + /api/model/info (public), and
//   Compact/reasoning report {applied:false, reason}. Credentials are never returned or logged.
//
// EXCLUDED on purpose: delete, memory reset, skill/hub install, global config writes.
import WebSocketLib from 'ws';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const ID = /^[A-Za-z0-9_.:-]{1,160}$/;
const EFFORTS = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
const fail = (message, status = 400) => Object.assign(new Error(message), { status });
const num = v => (Number.isFinite(Number(v)) && Number(v) >= 0 ? Math.floor(Number(v)) : 0);
const level = r => (r >= 0.8 ? 'hot' : r >= 0.6 ? 'warn' : 'ok');
const enc = encodeURIComponent;
function needId(v, what) { if (typeof v !== 'string' || !ID.test(v)) throw fail(`Invalid ${what} id.`); return v; }
function needConfirm(args, what) { if (args?.confirm !== true) throw fail(`Confirm ${what} first.`, 428); }
function str(v, max) { return typeof v === 'string' ? v.trim().slice(0, max) : ''; }

export function describe(profile = {}) {
  const ws = dashboardAvailable(profile);
  return [
    { id: 'context_meter', label: 'Context', kind: 'meter', risk: 'none', needs: 'session', source: ws ? 'rpc' : 'estimate' },
    { id: 'usage', label: 'Cost & usage', kind: 'meter', risk: 'none', needs: 'session' },
    { id: 'model_options', label: 'Available models', kind: 'select', risk: 'none' },
    { id: 'set_model', label: 'Model (this session)', kind: 'select', risk: 'low', needs: 'session', options: 'model_options' },
    { id: 'reasoning', label: 'Reasoning effort', kind: 'select', risk: 'low', needs: 'session', options: EFFORTS, applies: ws ? 'session' : 'next_session_or_run' },
    { id: 'compact', label: 'Compact', kind: 'action', risk: 'medium', confirm: true, needs: 'session', args: ['focus'], available: ws },
    { id: 'rename', label: 'Rename', kind: 'text', risk: 'low', needs: 'session' },
    { id: 'pin', label: 'Pin', kind: 'toggle', risk: 'low', needs: 'session' },
    { id: 'archive', label: 'Archive', kind: 'toggle', risk: 'low', needs: 'session' },
    { id: 'fork', label: 'Fork', kind: 'action', risk: 'low', needs: 'session', args: ['title'] },
    { id: 'steer', label: 'Steer run', kind: 'text', risk: 'low', needs: 'run' },
    { id: 'approval', label: 'Approve tool', kind: 'approval', risk: 'high', needs: 'run',
      options: ['once', 'session', 'deny', 'always'], confirm2: ['always'] },
  ];
}

// ---- dashboard RPC (optional) ---------------------------------------------------------
// Basic-auth dashboard login (plugins/dashboard_auth/basic): POST /auth/password-login -> session cookies,
// then POST /api/auth/ws-ticket -> single-use 30 s ticket for ?ticket= on the WS upgrade. Credentials are
// read server-side from ~/.hermes/.env (HERMES_DASHBOARD_BASIC_AUTH_USERNAME/_PASSWORD), never returned or logged.
function basicCreds() {
  try {
    const env = {};
    for (const line of fs.readFileSync(path.join(os.homedir(), '.hermes', '.env'), 'utf8').split('\n')) {
      const m = /^\s*(HERMES_DASHBOARD_BASIC_AUTH_(?:USERNAME|PASSWORD))\s*=\s*(.*)$/.exec(line);
      if (m) env[m[1]] = m[2].trim().replace(/^(['"])(.*)\1$/, '$2');
    }
    const u = process.env.HERMES_DASHBOARD_BASIC_AUTH_USERNAME || env.HERMES_DASHBOARD_BASIC_AUTH_USERNAME;
    const p = process.env.HERMES_DASHBOARD_BASIC_AUTH_PASSWORD || env.HERMES_DASHBOARD_BASIC_AUTH_PASSWORD;
    return u && p ? { username: u, password: p } : null;
  } catch { return null; }
}
const cookieJar = new Map(); // dashboardUrl -> cookie header
async function dashLogin(base, f) {
  const c = basicCreds(); if (!c) return null;
  const r = await f(base + '/auth/password-login', { method: 'POST', redirect: 'manual', signal: AbortSignal.timeout(10000),
    headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ provider: 'basic', username: c.username, password: c.password }) });
  try { await r.text(); } catch {}
  if (!r.ok) { cookieJar.delete(base); throw fail(`Hermes dashboard login failed (HTTP ${r.status}).`, 502); }
  const set = typeof r.headers.getSetCookie === 'function' ? r.headers.getSetCookie() : [r.headers.get('set-cookie') || ''];
  const cookie = set.map(v => String(v).split(';')[0]).filter(v => v.includes('=')).join('; ');
  if (!cookie) throw fail('Hermes dashboard login returned no session.', 502);
  cookieJar.set(base, cookie); return cookie;
}
async function wsTicket(profile, ctx) {
  const base = dashboardUrl(profile); const f = ctx?.fetchImpl || fetch;
  for (let attempt = 0; attempt < 2; attempt++) {
    const cookie = cookieJar.get(base) || await dashLogin(base, f);
    if (!cookie) return null;
    const r = await f(base + '/api/auth/ws-ticket', { method: 'POST', redirect: 'manual', signal: AbortSignal.timeout(10000), headers: { 'Content-Type': 'application/json', Cookie: cookie }, body: '{}' });
    if (r.status === 401 || r.status === 403) { try { await r.text(); } catch {} cookieJar.delete(base); continue; } // session expired: re-login once
    if (!r.ok) { try { await r.text(); } catch {} throw fail(`Hermes dashboard refused a ticket (HTTP ${r.status}).`, 502); }
    const j = await r.json().catch(() => ({}));
    if (typeof j?.ticket === 'string' && j.ticket) return j.ticket;
    throw fail('Hermes dashboard returned no ticket.', 502);
  }
  throw fail('Hermes dashboard login expired.', 502);
}
function dashboardAvailable(profile) { return !!dashboardToken(profile) || !!basicCreds(); }
function dashboardToken(profile) { return str(profile?.dashboardToken, 4096) || str(process.env.HERMES_DASHBOARD_TOKEN, 4096); }
function dashboardUrl(profile) { return (str(profile?.dashboardUrl, 300) || 'http://127.0.0.1:9119').replace(/\/$/, ''); }

async function rpc(profile, ctx, calls) {
  // HERMES_DASHBOARD_TOKEN / profile.dashboardToken stays an override; otherwise log in and mint a ticket.
  const token = dashboardToken(profile);
  const ticket = token ? null : await wsTicket(profile, ctx);
  if (!token && !ticket) return null;
  const WS = ctx?.WebSocket || WebSocketLib;
  const url = dashboardUrl(profile).replace(/^http/, 'ws') + '/api/ws?' + (token ? 'token=' + enc(token) : 'ticket=' + enc(ticket));
  return await new Promise((resolve, reject) => {
    const ws = new WS(url, { handshakeTimeout: 8000 });
    const pend = new Map(); let n = 0;
    const timer = setTimeout(() => { try { ws.terminate?.() ?? ws.close(); } catch {} reject(fail('Hermes dashboard timed out.', 504)); }, 60000);
    const done = (fn, v) => { clearTimeout(timer); try { ws.close(); } catch {} fn(v); };
    const call = (method, params) => new Promise((res, rej) => { const id = ++n; pend.set(id, { res, rej }); ws.send(JSON.stringify({ jsonrpc: '2.0', id, method, params })); });
    ws.on('message', d => { let j; try { j = JSON.parse(String(d)); } catch { return; } const p = j && pend.get(j.id); if (!p) return; pend.delete(j.id);
      j.error ? p.rej(fail(`Hermes: ${ctx.redact(String(j.error.message || 'RPC error')).slice(0, 200)}`, 502)) : p.res(j.result); });
    ws.on('error', () => done(reject, fail('Cannot reach the Hermes dashboard.', 502)));
    ws.on('unexpected-response', (_q, res) => done(reject, fail(`Hermes dashboard refused the connection (HTTP ${res.statusCode}).`, 502)));
    ws.on('open', () => { calls(call).then(v => done(resolve, v), e => done(reject, e)); });
  });
}
// Bind a stored session id to a live runtime id, then run fn(call, runtimeId).
async function withLive(profile, ctx, session, fn) {
  return rpc(profile, ctx, async call => {
    const info = await call('session.resume', { session_id: session });
    const live = str(info?.session_id, 200) || session;
    return fn(call, live, info);
  });
}

// ---- helpers ------------------------------------------------------------------------
async function getSession(ctx, session) { const r = await ctx.fetchHermes(`/api/sessions/${enc(session)}`, { method: 'GET' }); return r?.session || r || {}; }
async function modelInfo(profile, ctx) {
  try {
    const f = ctx?.fetchImpl || fetch;
    const r = await f(dashboardUrl(profile) + '/api/model/info', { redirect: 'error', signal: AbortSignal.timeout(5000) });
    if (r.ok) return await r.json();
  } catch {}
  return null;
}
function usageOf(s) {
  return { input_tokens: num(s.input_tokens), output_tokens: num(s.output_tokens), cache_read_tokens: num(s.cache_read_tokens),
    cache_write_tokens: num(s.cache_write_tokens), reasoning_tokens: num(s.reasoning_tokens), tool_calls: num(s.tool_call_count),
    api_calls: num(s.api_call_count), messages: num(s.message_count),
    cost_usd: s.actual_cost_usd ?? s.estimated_cost_usd ?? null, cost_kind: s.actual_cost_usd != null ? 'actual' : 'estimated', model: str(s.model, 120) };
}

// ---- control ------------------------------------------------------------------------
export async function control(profile, { action, session, run, args = {} } = {}, ctx) {
  if (!ctx || typeof ctx.fetchHermes !== 'function') throw fail('Hermes controls are not wired.', 500);
  if (typeof ctx.redact !== 'function') ctx = { ...ctx, redact: s => String(s) };
  args = args && typeof args === 'object' ? args : {};
  switch (action) {
    case 'context_meter': {
      needId(session, 'session');
      if (dashboardAvailable(profile)) {
        try {
          const u = await withLive(profile, ctx, session, (call, live) => call('session.usage', { session_id: live }));
          const used = num(u?.context_used), window = num(u?.context_max);
          if (window) return { used, window, ratio: used / window, level: level(used / window), estimated: !!u.context_estimated, compressions: num(u.compressions), source: 'rpc' };
        } catch { /* fall back below */ }
      }
      const [s, info] = await Promise.all([getSession(ctx, session), modelInfo(profile, ctx)]);
      const window = num(info?.effective_context_length) || num(info?.capabilities?.context_window) || 128000;
      // No live context figure over REST: average prompt per API call approximates the current window fill.
      const calls = num(s.api_call_count);
      const used = calls ? Math.min(window, Math.round((num(s.input_tokens) + num(s.cache_read_tokens)) / calls)) : 0;
      return { used, window, ratio: used / window, level: level(used / window), estimated: true, source: 'usage-average', model: str(s.model || info?.model, 120) };
    }
    case 'usage': { needId(session, 'session'); return usageOf(await getSession(ctx, session)); }
    case 'model_options': {
      const r = await ctx.fetchHermes('/api/model/options', { method: 'GET' });
      const providers = (Array.isArray(r?.providers) ? r.providers : []).filter(p => p.authenticated || p.is_current || (p.models || []).length)
        .map(p => ({ provider: str(p.slug, 80), label: str(p.name, 80), current: !!p.is_current,
          models: (p.models || []).slice(0, 200).map(m => (typeof m === 'string' ? m : str(m?.id || m?.slug || m?.name, 160))).filter(Boolean) }));
      return { current: { model: str(r?.model || r?.current_model, 160), provider: str(r?.provider || r?.current_provider, 80) }, providers };
    }
    case 'set_model': {
      needId(session, 'session');
      const model = str(args.model, 160), provider = str(args.provider, 80);
      if (!model) throw fail('Pick a model.');
      const r = await ctx.fetchHermes(`/api/sessions/${enc(session)}/model`, { method: 'POST', body: { model, ...(provider ? { provider } : {}) } });
      return { ok: true, session_id: session, runtime: r?.runtime || null };
    }
    case 'reasoning': {
      needId(session, 'session');
      const effort = str(args.effort, 16).toLowerCase();
      if (!EFFORTS.includes(effort)) throw fail('Invalid reasoning effort.');
      if (dashboardAvailable(profile)) {
        await withLive(profile, ctx, session, (call, live) => call('config.set', { key: 'reasoning', value: effort, session_id: live }));
        return { applied: true, scope: 'session', effort };
      }
      return { applied: false, effort, model_options: { reasoning_effort: effort },
        reason: 'No dashboard credential: send model_options with the next session create/chat.' };
    }
    case 'compact': {
      needId(session, 'session'); needConfirm(args, 'compact');
      const focus = str(args.focus, 500);
      if (!dashboardAvailable(profile)) return { applied: false, reason: 'Compact needs the Hermes dashboard RPC (no credential configured). Hermes still auto-compacts at its threshold.' };
      const r = await withLive(profile, ctx, session, (call, live) => call('session.compress', { session_id: live, ...(focus ? { focus_topic: focus } : {}) }));
      const next = str(r?.info?.session_key || r?.info?.stored_session_id || r?.info?.session_id, 200) || session;
      return { applied: r?.status === 'compressed', status: str(r?.status, 20) || (r?.lock_held ? 'busy' : 'unknown'),
        previous_session_id: session, session_id: next, before_tokens: num(r?.before_tokens), after_tokens: num(r?.after_tokens),
        before_messages: num(r?.before_messages), after_messages: num(r?.after_messages), message: str(r?.message, 300) };
    }
    case 'rename': {
      needId(session, 'session');
      const title = str(args.title, 200);
      await ctx.fetchHermes(`/api/sessions/${enc(session)}`, { method: 'PATCH', body: { title } });
      return { ok: true, title };
    }
    case 'pin': case 'archive': {
      needId(session, 'session');
      if (typeof args.value !== 'boolean') throw fail('value must be true or false.');
      const flag = action === 'pin' ? 'pinned' : 'archived';
      await ctx.fetchHermes(`/api/sessions/${enc(session)}`, { method: 'PATCH', body: { [flag]: args.value } });
      return { ok: true, [flag]: args.value };
    }
    case 'fork': {
      needId(session, 'session');
      const title = str(args.title, 200);
      const r = await ctx.fetchHermes(`/api/sessions/${enc(session)}/fork`, { method: 'POST', body: title ? { title } : {} });
      const s = r?.session || r || {};
      return { ok: true, session_id: str(s.id || s.session_id, 200), title: str(s.title, 200) };
    }
    case 'steer': {
      needId(run, 'run');
      const input = str(args.text, 4000);
      if (!input) throw fail('Type guidance first.');
      const r = await ctx.fetchHermes(`/v1/runs/${enc(run)}/steer`, { method: 'POST', body: { input } });
      return { ok: true, status: str(r?.status, 40) };
    }
    case 'approval': {
      needId(run, 'run');
      const choice = str(args.choice, 16).toLowerCase();
      if (!['once', 'session', 'deny', 'always'].includes(choice)) throw fail('Invalid approval choice.');
      if (choice === 'always' && !(args.confirm === true && args.confirmAlways === true)) throw fail('Always-allow needs a second confirmation.', 428);
      const body = { choice };
      if (args.request_id != null) body.request_id = str(String(args.request_id), 200);
      const r = await ctx.fetchHermes(`/v1/runs/${enc(run)}/approval`, { method: 'POST', body });
      return { ok: true, choice, status: str(r?.status, 40) };
    }
    default: throw fail('Unknown control.', 404);
  }
}
