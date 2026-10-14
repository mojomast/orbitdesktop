/**
 * Pi controls for the Grok Bots app.
 *
 * Talks to Orbit's loopback Pi gateway (profile.apiUrl + bearer profile.apiKey)
 * through its allowlisted pass-through routes: `piControl`, `piAnswerDialog`,
 * `piActivity`. One `session` is one Pi conversation id (`pi_<16 hex>`).
 * Shell commands, session deletion and session switching are deliberately absent.
 */

const SESSION = /^pi_[a-f0-9]{16}$/;
const THINKING = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
const QUEUE_MODES = ['all', 'one-at-a-time'];
const MAX_TEXT = 20_000;

/** Pi live event -> Activity panel label (gateway channels: run, message, tool, activity, approval, note). */
export const ACTIVITY_EVENTS = Object.freeze({
  agent_start: 'Running',
  turn_end: 'Turn finished',
  agent_settled: 'Idle',
  aborted: 'Stopped',
  thinking: 'Thinking…',
  text: 'Writing reply',
  'tool-call': 'Tool call',
  'tool-result': 'Tool result',
  queue_update: 'Queue changed',
  thinking_level_changed: 'Thinking level changed',
  session_info_changed: 'Renamed',
  compaction_start: 'Compacting…',
  compaction_end: 'Compacted',
  auto_retry_start: 'Retrying…',
  auto_retry_end: 'Retry finished',
  summarization_retry_scheduled: 'Summary retry scheduled',
  summarization_retry_attempt_start: 'Summary retry',
  summarization_retry_finished: 'Summary retry finished',
  extension_ui_request: 'Needs approval',
  extension_ui_answered: 'Approval answered',
  extension_ui_expired: 'Approval expired',
  exit: 'Pi process stopped',
});

const CAPABILITIES = Object.freeze([
  { id: 'context', label: 'Context window', kind: 'meter', risk: 'none' },
  { id: 'cost', label: 'Cost and tokens', kind: 'meter', risk: 'none' },
  { id: 'model', label: 'Model', kind: 'select', risk: 'low' },
  { id: 'thinking', label: 'Thinking level', kind: 'select', risk: 'low', options: THINKING },
  { id: 'compact', label: 'Compact context', kind: 'action', risk: 'medium', confirm: 'Summarise older turns to free context? Original entries are kept on disk.' },
  { id: 'auto-compaction', label: 'Auto-compaction', kind: 'toggle', risk: 'low' },
  { id: 'steer', label: 'Steer the running turn', kind: 'text', risk: 'low' },
  { id: 'follow-up', label: 'Queue a follow-up', kind: 'text', risk: 'low' },
  { id: 'clear-queue', label: 'Clear queued messages', kind: 'action', risk: 'low' },
  { id: 'steering-mode', label: 'Steering delivery', kind: 'select', risk: 'low', options: QUEUE_MODES },
  { id: 'follow-up-mode', label: 'Follow-up delivery', kind: 'select', risk: 'low', options: QUEUE_MODES },
  { id: 'rename', label: 'Rename session', kind: 'text', risk: 'low' },
  { id: 'fork', label: 'Fork from a message', kind: 'select', risk: 'low', confirm: 'Fork this conversation from the chosen message? The current branch is kept.' },
  { id: 'approvals', label: 'Extension approvals', kind: 'approval', risk: 'high' },
  { id: 'activity', label: 'Activity', kind: 'meter', risk: 'none' },
]);

function err(message, status = 400) {
  const error = new Error(message);
  error.status = status;
  return error;
}

export function describe(profile) {
  if (!profile || profile.provider !== 'pi') return [];
  return CAPABILITIES.map(cap => ({ ...cap, ...(cap.options ? { options: [...cap.options] } : {}) }));
}

async function call(profile, route, body, ctx = {}) {
  if (!profile?.apiUrl || !profile?.apiKey) throw err('The Pi gateway is not available.', 503);
  const doFetch = ctx.fetch || globalThis.fetch;
  let res;
  try {
    res = await doFetch(`${String(profile.apiUrl).replace(/\/+$/, '')}/api/${route}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${profile.apiKey}` },
      body: JSON.stringify(body),
      signal: ctx.signal || AbortSignal.timeout(ctx.timeoutMs || 90_000),
    });
  } catch (e) {
    throw err(`The Pi gateway did not answer: ${e instanceof Error ? e.message : 'unknown error'}`.slice(0, 300), 502);
  }
  let data = {};
  try { data = await res.json(); } catch {}
  if (!res.ok) throw err(typeof data?.error === 'string' ? data.error : `Pi gateway error ${res.status}`, res.status === 404 && /no .* command/.test(data?.error || '') ? 501 : res.status);
  return data;
}

const pi = (profile, session, command, fields, ctx) =>
  call(profile, 'piControl', { id: session, command, fields: fields || {} }, ctx).then(r => r.data);

function text(value, label, max = MAX_TEXT) {
  const s = typeof value === 'string' ? value.trim() : '';
  if (!s) throw err(`${label} is required.`);
  if (s.length > max) throw err(`${label} is too long.`);
  return s;
}

function modelView(m) {
  return m && { provider: m.provider, id: m.id, name: m.name || m.id, contextWindow: m.contextWindow ?? null, reasoning: m.reasoning === true, cost: m.cost || null };
}

export async function control(profile, { action, session, args = {} } = {}, ctx = {}) {
  if (!profile || profile.provider !== 'pi') throw err('This profile is not a Pi agent.', 400);
  if (!SESSION.test(String(session || ''))) throw err('A Pi session id is required.', 400);
  const a = args && typeof args === 'object' ? args : {};
  switch (action) {
    case 'state': {
      const s = await pi(profile, session, 'get_state', {}, ctx);
      return { model: modelView(s?.model), thinkingLevel: s?.thinkingLevel, isStreaming: !!s?.isStreaming, isCompacting: !!s?.isCompacting, steeringMode: s?.steeringMode, followUpMode: s?.followUpMode, sessionName: s?.sessionName ?? null, autoCompactionEnabled: !!s?.autoCompactionEnabled, messageCount: s?.messageCount ?? 0, pendingMessageCount: s?.pendingMessageCount ?? 0 };
    }
    case 'context':
    case 'cost':
    case 'stats': {
      const s = await pi(profile, session, 'get_session_stats', {}, ctx);
      return { context: s?.contextUsage || null, tokens: s?.tokens || null, cost: s?.cost ?? null, counts: { user: s?.userMessages ?? 0, assistant: s?.assistantMessages ?? 0, toolCalls: s?.toolCalls ?? 0, total: s?.totalMessages ?? 0 } };
    }
    case 'model': {
      if (a.provider === undefined && a.modelId === undefined) {
        const [list, state] = await Promise.all([pi(profile, session, 'get_available_models', {}, ctx), pi(profile, session, 'get_state', {}, ctx)]);
        const current = state?.model ? `${state.model.provider}/${state.model.id}` : null;
        return { current, options: (list?.models || []).map(m => ({ value: `${m.provider}/${m.id}`, ...modelView(m) })) };
      }
      const provider = text(a.provider, 'provider', 100);
      const modelId = text(a.modelId, 'modelId', 200);
      return { model: modelView(await pi(profile, session, 'set_model', { provider, modelId }, ctx)) };
    }
    case 'thinking': {
      if (a.level === undefined) {
        const [levels, state] = await Promise.all([pi(profile, session, 'get_available_thinking_levels', {}, ctx), pi(profile, session, 'get_state', {}, ctx)]);
        return { current: state?.thinkingLevel ?? null, options: levels?.levels || ['off'] };
      }
      if (!THINKING.includes(a.level)) throw err('Unknown thinking level.');
      await pi(profile, session, 'set_thinking_level', { level: a.level }, ctx);
      return { level: a.level };
    }
    case 'compact': {
      if (a.confirmed !== true) throw err('Compaction needs confirmation.', 428);
      const fields = {};
      if (typeof a.instructions === 'string' && a.instructions.trim()) fields.customInstructions = text(a.instructions, 'instructions', 4_000);
      const r = await pi(profile, session, 'compact', fields, { ...ctx, timeoutMs: ctx.timeoutMs || 300_000 });
      return { tokensBefore: r?.tokensBefore ?? null, estimatedTokensAfter: r?.estimatedTokensAfter ?? null, cost: r?.usage?.cost?.total ?? null };
    }
    case 'auto-compaction': {
      if (typeof a.enabled !== 'boolean') {
        const s = await pi(profile, session, 'get_state', {}, ctx);
        return { enabled: !!s?.autoCompactionEnabled };
      }
      await pi(profile, session, 'set_auto_compaction', { enabled: a.enabled }, ctx);
      return { enabled: a.enabled };
    }
    case 'steer':
    case 'follow-up': {
      const message = text(a.message, 'message');
      const s = await pi(profile, session, 'get_state', {}, ctx);
      if (!s?.isStreaming) throw err('Pi is idle; send a normal message instead.', 409);
      const r = await pi(profile, session, action === 'steer' ? 'steer' : 'follow_up', { message }, ctx);
      return { disposition: r?.disposition || 'queued' };
    }
    case 'clear-queue': {
      const r = await pi(profile, session, 'clear_queue', {}, ctx);
      return { steering: r?.steering || [], followUp: r?.followUp || [] };
    }
    case 'steering-mode':
    case 'follow-up-mode': {
      if (!QUEUE_MODES.includes(a.mode)) throw err('Mode must be all or one-at-a-time.');
      await pi(profile, session, action === 'steering-mode' ? 'set_steering_mode' : 'set_follow_up_mode', { mode: a.mode }, ctx);
      return { mode: a.mode };
    }
    case 'rename': {
      const name = text(a.name, 'name', 80);
      if (/[\u0000-\u001f\u007f]/.test(name)) throw err('Name has control characters.');
      await pi(profile, session, 'set_session_name', { name }, ctx);
      return { name };
    }
    case 'fork': {
      if (a.entryId === undefined) {
        const r = await pi(profile, session, 'get_fork_messages', {}, ctx);
        return { options: (r?.messages || []).map(m => ({ value: m.entryId, label: String(m.text || '').slice(0, 200) })) };
      }
      if (a.confirmed !== true) throw err('Forking needs confirmation.', 428);
      const entryId = text(a.entryId, 'entryId', 200);
      const r = await pi(profile, session, 'fork', { entryId }, ctx);
      return { cancelled: !!r?.cancelled, text: r?.text ?? null };
    }
    case 'approvals': {
      if (a.dialogId === undefined) {
        const r = await call(profile, 'piActivity', { id: session, after: Number(a.after) || 0 }, ctx);
        const answered = new Set(r.items.filter(i => i.kind === 'extension_ui_answered' || i.kind === 'extension_ui_expired').map(i => i.id));
        return { pending: r.items.filter(i => i.kind === 'extension_ui_request' && !answered.has(i.id) && i.expiresAt > Date.now()) };
      }
      const body = { id: session, dialogId: text(a.dialogId, 'dialogId', 200) };
      if (a.cancelled === true) body.cancelled = true;
      else if (typeof a.confirmed === 'boolean') body.confirmed = a.confirmed;
      else if (typeof a.value === 'string') body.value = a.value.slice(0, MAX_TEXT);
      else body.cancelled = true;
      return call(profile, 'piAnswerDialog', body, ctx);
    }
    case 'activity': {
      const r = await call(profile, 'piActivity', { id: session, after: Number(a.after) || 0 }, ctx);
      return { seq: r.seq, items: r.items.map(i => ({ ...i, label: ACTIVITY_EVENTS[i.kind] || i.kind })) };
    }
    default:
      throw err(`Unknown Pi control: ${String(action).slice(0, 40)}`, 404);
  }
}
