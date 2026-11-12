// Passive live-activity relay for gateway providers (Grok Bot).
// One read-only SSE subscription per gateway profile to GET /events (Bearer),
// normalised into per-agent activity (tool calls, steps, todos/progress,
// needs-input, working/done) with redacted previews. Never sends commands except
// the read-only GET /health. Subscription starts on first use and stops after
// a few idle minutes; reconnects with backoff.
const CHANNELS = 'transcript,agents,agent-upserted,todos,outline';
const MAX_ITEMS = 200;

export function makeRedactor(secrets = []) {
  const lits = secrets.filter(s => typeof s === 'string' && s.length >= 8);
  return value => {
    let t = String(value ?? '');
    for (const s of lits) t = t.split(s).join('[redacted]');
    return t
      .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [redacted]')
      .replace(/\b(sk|xai|ghp|gho|ghs|github_pat|glpat|xox[abpr]|AKIA|AIza)[-_A-Za-z0-9]{8,}/g, '[redacted]')
      .replace(/((?:api[_-]?key|token|secret|password|passwd|authorization|cookie|private[_-]?key)["']?\s*[:=]\s*["']?)[^\s"',;&]+/gi, '$1[redacted]')
      .replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(-----END [A-Z ]*PRIVATE KEY-----|$)/g, '[redacted key]')
      .replace(/\b[A-Za-z0-9+/_-]{40,}={0,2}/g, '[redacted]')
      .replace(/[\x00-\x08\x0b-\x1f\x7f]/g, ' ');
  };
}
const short = (s, n) => { s = String(s).replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n - 1) + '…' : s; };

function sandStep(raw) {
  if (typeof raw !== 'string' || !raw.includes('__sand_tool__')) return null;
  try { const p = JSON.parse(raw); return p && p.__sand_tool__ === true ? p : null; } catch { return null; }
}

export function createGatewayActivity({ profile, label = 'Grok Bot', extraSecrets = () => [] }) {
  const agents = new Map(); // id -> { items: [], keyIndex: Map, state, seq }
  let seq = 0, connected = false, lastError = '', lastUse = 0, abort = null, running = false, health = null, healthAt = 0, connectedAt = 0, eventsSeen = 0;
  const redactor = () => { const p = profile(); return makeRedactor([p?.apiKey, ...extraSecrets()]); };
  let red = redactor();

  function bucket(id) {
    let b = agents.get(id);
    if (!b) { b = { items: [], keys: new Map(), state: { running: false, awaiting: false, composing: false, since: 0, tool: null } }; agents.set(id, b); }
    return b;
  }
  function upsert(id, key, patch) {
    const b = bucket(id); seq += 1;
    let item = key ? b.keys.get(key) : null;
    if (item) Object.assign(item, patch, { seq });
    else { item = { key: key || `k${seq}`, ts: Date.now(), run: bucket(id).state.runKey || null, ...patch, seq }; b.items.push(item); if (key) b.keys.set(key, item); }
    while (b.items.length > MAX_ITEMS) { const old = b.items.shift(); b.keys.delete(old.key); }
    return item;
  }
  function setState(id, a) {
    if (!a || typeof a !== 'object') return;
    const b = bucket(id), s = b.state, now = Date.now();
    const runningNow = !!(a.isRunning || a.isRunningTurn || a.isComposingMessage);
    const awaiting = !!a.awaitingUserResponse;
    if (runningNow && !s.running) { s.since = now; s.runKey = `run-${now}`; upsert(id, `run-${now}`, { type: 'state', status: 'working', title: 'Working', detail: a.lastMessagePreview ? short(red(a.lastMessagePreview), 120) : '' }); s.runKey = `run-${now}`; }
    if (!runningNow && s.running) {
      const it = s.runKey && b.keys.get(s.runKey); if (it) Object.assign(it, { status: 'done', title: 'Done', durationMs: now - s.since }), (it.seq = ++seq);
      for (const t of b.items) if ((t.type === 'tool' || t.title === 'Thinking') && (t.status === 'pending' || t.status === 'running')) { t.status = 'done?'; t.durationMs = now - t.ts; t.seq = ++seq; }
      s.tool = null; s.runKey = null;
    }
    if (awaiting && !s.awaiting) upsert(id, `await-${now}`, { type: 'needs-input', status: 'waiting', title: 'Needs your input', detail: a.lastMessagePreview ? short(red(a.lastMessagePreview), 160) : '' });
    // Live tool/thinking activity from the server-agent overlay (currentActivity).
    const ca = runningNow && a.currentActivity && typeof a.currentActivity === 'object' ? a.currentActivity : null;
    const caKey = ca ? `ca-${String(ca.callId || '') || (ca.kind + ':' + (ca.tool || ''))}`.slice(0, 160) : null;
    if (s.caKey && s.caKey !== caKey) {
      const prev = b.keys.get(s.caKey);
      if (prev && prev.durationMs == null) { prev.status = prev.type === 'tool' ? 'done' : 'done'; prev.durationMs = now - prev.ts; prev.seq = ++seq; }
    }
    if (ca && caKey !== s.caKey) {
      const detail = short(red([ca.detail, ca.target].filter(x => typeof x === 'string' && x).join(' · ')), 140);
      if (ca.kind === 'thinking') upsert(id, caKey, { type: 'step', status: 'running', title: 'Thinking', detail: '', run: s.runKey || null });
      else upsert(id, caKey, { type: 'tool', status: 'running', title: String(ca.tool || 'tool').slice(0, 80), detail, run: s.runKey || null, callId: ca.callId ? String(ca.callId).slice(0, 80) : undefined });
    }
    s.caKey = caKey;
    s.tool = ca ? (ca.kind === 'thinking' ? 'thinking' : String(ca.tool || 'tool').slice(0, 80)) : null;
    s.subagent = !!(a.isRunning && !a.isRunningTurn && !a.isComposingMessage);
    s.running = runningNow; s.awaiting = awaiting; s.composing = !!a.isComposingMessage;
  }
  function onEntry(id, ev, e) {
    if (!e || typeof e !== 'object') return;
    const k = `e-${e.id || ''}`;
    if (e.kind === 'tool-call') {
      const st = String(e.status || 'pending');
      const existing = bucket(id).keys.get(k);
      const start = existing?.ts || Number(e.timestampMs) || Date.now();
      const item = upsert(id, k, { type: 'tool', title: String(e.name || 'tool').slice(0, 80), status: st, detail: e.summary ? short(red(e.summary), 140) : (existing?.detail || ''), ts: start, ...(st !== 'pending' ? { durationMs: Math.max(0, Date.now() - start) } : {}) });
      bucket(id).state.tool = st === 'pending' ? item.title : null;
      return;
    }
    if (e.kind === 'send-message') {
      const m = e.message || {};
      if (m.type === 'text') return upsert(id, k, { type: 'step', status: e.isStreaming ? 'streaming' : 'sent', title: e.isStreaming ? 'Writing reply' : 'Sent message', detail: short(red(m.content || ''), 140) });
      if (m.type === 'auto-review-approval' || /approval|permission/i.test(m.type || '')) { const a = m.approval || {}; return upsert(id, k, { type: 'needs-input', status: String(a.status || 'pending'), title: 'Approval: ' + short(red(a.summary || m.type), 80), detail: short(red(a.command || a.reason || ''), 160) }); }
      return upsert(id, k, { type: 'step', status: 'sent', title: `Sent ${String(m.type || 'message').slice(0, 40)}`, detail: '' });
    }
    if (e.kind === 'message') {
      if (e.role === 'user') return upsert(id, k, { type: 'step', status: 'received', title: 'New request', detail: short(red(String(e.content || '').split('\n\nWorkspace context:')[0]), 120) });
      return upsert(id, k, { type: 'step', status: e.isStreaming ? 'streaming' : 'done', title: e.isStreaming ? 'Writing reply' : 'Assistant message', detail: short(red(e.content || ''), 140) });
    }
    const step = sandStep(e.currentStep ?? e.args?.currentStep);
    if (step) return upsert(id, k, { type: 'tool', status: 'pending', title: String(step.tool || 'step'), detail: short(red([step.detail, step.target].filter(Boolean).map(x => typeof x === 'string' ? x : JSON.stringify(x)).join(' · ')), 140) });
    if (e.kind === 'notice' || e.kind === 'event') return upsert(id, k, { type: 'step', status: 'info', title: String(e.kind), detail: short(red(e.text || e.message || e.event?.type || ''), 120) });
    upsert(id, k, { type: 'step', status: ev || 'event', title: String(e.kind || 'entry').slice(0, 40), detail: '' });
  }
  function onEvent(evt) {
    eventsSeen += 1;
    const ch = evt?.channel, p = evt?.payload;
    if (!p || typeof p !== 'object') return;
    if (ch === 'agents') { for (const a of Array.isArray(p.agents) ? p.agents : []) if (a?.id) setState(a.id, a); return; }
    if (ch === 'agent-upserted') { const a = p.agent; if (a?.id) setState(a.id, a); return; }
    const id = p.agentId || p.activeAgentId;
    if (typeof id !== 'string') return;
    if (ch === 'transcript') {
      if (p.entry) onEntry(id, p.type, p.entry);
      for (const e of Array.isArray(p.entries) ? p.entries.slice(-20) : []) onEntry(id, p.type, e);
      return;
    }
    if (ch === 'todos') {
      const list = Array.isArray(p.todos) ? p.todos : Array.isArray(p.items) ? p.items : [];
      if (!list.length) return;
      const done = list.filter(t => /done|complete/i.test(t?.status || '')).length;
      const cur = list.find(t => /progress|active/i.test(t?.status || ''));
      return upsert(id, 'todos', { type: 'progress', status: `${done}/${list.length}`, title: `Progress ${done}/${list.length}`, detail: cur ? short(red(cur.content || cur.title || ''), 120) : '' });
    }
    if (ch === 'outline') {
      for (const it of Array.isArray(p.items) ? p.items.slice(-30) : []) if (it?.kind === 'tool-call') upsert(id, `o-${it.id}`, { type: 'tool', title: String(it.name || 'tool').slice(0, 80), status: String(it.status || ''), detail: it.summary ? short(red(it.summary), 140) : '' });
    }
  }

  async function loop() {
    let backoff = 1000;
    while (running) {
      const p = profile();
      if (!p?.apiUrl || !p.apiKey) { lastError = `${label} gateway not configured`; await new Promise(r => setTimeout(r, 10000).unref?.()); continue; }
      red = redactor();
      abort = new AbortController();
      try {
        const r = await fetch(`${p.apiUrl.replace(/\/$/, '')}/events?channels=${CHANNELS}`, { headers: { Authorization: `Bearer ${p.apiKey}`, Accept: 'text/event-stream' }, signal: abort.signal, redirect: 'error' });
        if (!r.ok || !r.body) throw Error(`HTTP ${r.status}`);
        connected = true; connectedAt = Date.now(); lastError = ''; backoff = 1000;
        const reader = r.body.getReader(), dec = new TextDecoder(); let buf = '';
        for (;;) {
          const { done, value } = await reader.read(); if (done) break;
          buf += dec.decode(value, { stream: true }).replace(/\r\n/g, '\n');
          if (buf.length > 8_000_000) buf = '';
          let i;
          while ((i = buf.indexOf('\n\n')) >= 0) {
            const block = buf.slice(0, i); buf = buf.slice(i + 2);
            const data = block.split('\n').filter(l => l.startsWith('data:')).map(l => l.slice(5).trimStart()).join('\n');
            if (!data) continue;
            try { onEvent(JSON.parse(data)); } catch {}
          }
          if (!running || Date.now() - lastUse > 5 * 60 * 1000) { running = false; break; }
        }
      } catch (e) { if (running) lastError = `activity stream: ${String(e?.message || e).slice(0, 80)}`; }
      connected = false;
      try { abort.abort(); } catch {}
      if (running) { await new Promise(r => setTimeout(r, backoff).unref?.()); backoff = Math.min(backoff * 2, 30000); }
    }
  }
  function touch() { lastUse = Date.now(); if (!running) { running = true; void loop(); } }

  async function gwHealth() {
    if (Date.now() - healthAt < 3000) return health;
    healthAt = Date.now();
    const p = profile(); if (!p?.apiUrl) return null;
    try { const r = await fetch(`${p.apiUrl.replace(/\/$/, '')}/health`, { headers: { Authorization: `Bearer ${p.apiKey}` }, signal: AbortSignal.timeout(3000) }); const j = await r.json(); health = { busy: !!j.isBusy, activeAgentId: typeof j.activeAgentId === 'string' ? j.activeAgentId : null, lastBusyAtMs: Number(j.lastBusyAtMs) || null }; }
    catch { health = null; }
    return health;
  }

  /** Read activity for one agent; `agentRow` (from listAgents) seeds state when the stream is new. */
  async function read(agentId, since = 0, agentRow = null) {
    touch();
    if (agentRow) setState(agentId, agentRow);
    const b = bucket(agentId);
    const h = await gwHealth();
    const s = b.state;
    return {
      stream: { connected, since: connectedAt || null, error: lastError || undefined, events: eventsSeen },
      health: h ? { busy: h.busy, active: h.activeAgentId === agentId, lastBusyAtMs: h.lastBusyAtMs } : null,
      state: { running: s.running, awaiting: s.awaiting, composing: s.composing, subagent: !!s.subagent, since: s.since || null, tool: s.tool, run: s.runKey || null },
      cursor: seq,
      items: b.items.filter(i => i.seq > (Number(since) || 0)).map(({ key, ts, type, status, title, detail, durationMs, run, seq: q }) => ({ key, ts, type, status, title, detail, durationMs, run, seq: q })),
    };
  }
  return { read, onEvent, close: () => { running = false; try { abort?.abort(); } catch {} } };
}
