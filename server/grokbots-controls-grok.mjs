// Grok Bot gateway controls for the Orbit "Grok Bots" app.
// Every command here is forwarded to the server for remote (temporal) bots by
// wrapGatewayApiWithServerAgentProxy in /opt/sand/sand-host/host-main.cjs (~L487400-487780),
// except updateAgent (local write + server identity push, ~L487910/L490970) and
// readMainAgentContext (remote returns only {isWorking}, ~L487425).
// Intentionally excluded: deleteAgents, submitSecret, resolveVirtualCardApproval, setHostSettings.
// ctx.gateway(command, body) is the app's server-side, token-bearing call; this module never touches the token.

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const AUTO_REVIEW = ['approved', 'denied', 'always'];
const LOCAL_TOOL = ['allow-once', 'deny', 'always', 'never'];
const REACTIONS = ['👍', '👎', '❤️', '😂', '🎉', '👀'];

function fail(message, status = 400) { const e = new Error(message); e.status = status; return e; }
const str = (v, name, max = 4000) => {
  if (typeof v !== 'string' || !v.trim()) throw fail(`${name} is required.`);
  if (v.length > max) throw fail(`${name} is too long.`);
  return v;
};
const optStr = (v, name, max = 200) => (v == null || v === '' ? undefined : str(v, name, max));
const bool = (v, name) => { if (typeof v !== 'boolean') throw fail(`${name} must be true or false.`); return v; };
const oneOf = (v, list, name) => { if (!list.includes(v)) throw fail(`${name} must be one of: ${list.join(', ')}.`); return v; };
const withSession = (body, args) => { const s = optStr(args?.sessionId, 'sessionId'); return s ? { ...body, sessionId: s } : body; };
const confirmed = args => { if (args?.confirmed !== true) throw fail('This action needs confirmation (args.confirmed: true).', 409); };

const CAPABILITIES = [
  { id: 'working', label: 'Working', kind: 'meter', risk: 'read', note: 'Run status only; the gateway exposes no context-usage meter for remote bots.' },
  { id: 'model', label: 'Model', kind: 'select', risk: 'none', disabled: true, supported: false, options: [], note: 'Not supported: the gateway has no per-bot model switch.' },
  { id: 'compact', label: 'Compact conversation', kind: 'action', risk: 'none', disabled: true, supported: false, note: 'Not supported: the gateway has no compaction command. Use New conversation.' },
  { id: 'widget.respond', label: 'Answer', kind: 'action', risk: 'medium', args: '{entryId, value, sessionId?}' },
  { id: 'widget.dismiss', label: 'Dismiss', kind: 'action', risk: 'low', args: '{entryId, sessionId?}' },
  { id: 'approval.autoReview', label: 'Approve / Deny command', kind: 'approval', risk: 'high', confirm: 'Run this blocked action for the bot?', options: AUTO_REVIEW.map(v => ({ value: v, label: { approved: 'Approve', denied: 'Deny', always: 'Always allow' }[v] })), args: '{entryId, requestId, resolution, approvedCommand?, sessionId?, confirmed}' },
  { id: 'approval.localTool', label: 'Allow / Deny computer access', kind: 'approval', risk: 'high', confirm: "Let the bot use this computer?", options: LOCAL_TOOL.map(v => ({ value: v, label: { 'allow-once': 'Allow once', deny: 'Deny', always: 'Always allow', never: 'Never allow' }[v] })), args: '{entryId, requestId, resolution, sessionId?, confirmed}' },
  { id: 'unread', label: 'Unread', kind: 'toggle', risk: 'low', args: '{isUnread: boolean}' },
  { id: 'hidden', label: 'Hide from list', kind: 'toggle', risk: 'low', args: '{isHidden: boolean}' },
  { id: 'rename', label: 'Rename', kind: 'text', risk: 'low', args: '{name, description?}', note: 'Saved locally, then synced to the server.' },
  { id: 'react', label: 'React', kind: 'action', risk: 'low', options: REACTIONS.map(e => ({ value: e, label: e })), args: '{entryId, emoji, sessionId?}' },
  { id: 'newConversation', label: 'New conversation', kind: 'action', risk: 'high', confirm: 'Start a fresh conversation? The current context is cleared.', args: '{sessionId?, confirmed}' },
  { id: 'undoLastTurn', label: 'Undo last turn', kind: 'action', risk: 'high', confirm: 'Roll back the last turn?', args: '{sessionId?, confirmed}' },
];

export function describe(_profile) { return CAPABILITIES.map(c => ({ ...c, ...(c.options ? { options: c.options.map(o => ({ ...o })) } : {}) })); }

// Pending cards from getAgentTranscriptTail entries (raw or {entry} wrapped).
export function extractPendingCards(entries) {
  const out = [];
  const list = Array.isArray(entries) ? entries : [];
  // Like the Grok Bot app: a question card is moot once the user has replied in chat after it.
  let lastUserMs = -1;
  for (const raw of list) { const u = raw?.entry && raw.kind == null ? raw.entry : raw; if (u?.kind === 'message' && u.role === 'user' && Number(u.timestampMs) > lastUserMs) lastUserMs = Number(u.timestampMs); }
  for (const raw of list) {
    const e = raw?.entry && raw.kind == null ? raw.entry : raw;
    if (!e || e.kind !== 'send-message' || !e.message || typeof e.id !== 'string') continue;
    const m = e.message;
    if (m.type === 'widget' && e.respondedValue == null && e.widgetDismissed !== true && !(Number(e.timestampMs) < lastUserMs)) {
      const w = m.widget || {};
      out.push({ type: 'widget', entryId: e.id, prompt: typeof w.prompt === 'string' ? w.prompt : 'Question', multiSelect: w.multiSelect === true,
        options: (Array.isArray(w.options) ? w.options : []).map(o => ({ label: String(o?.label ?? ''), value: String(o?.value ?? o?.label ?? ''), style: o?.style || 'default' })),
        controls: ['widget.respond', 'widget.dismiss'] });
    } else if (m.type === 'auto-review-approval' && m.approval?.status === 'pending') {
      const a = m.approval;
      out.push({ type: 'auto-review', entryId: e.id, requestId: a.requestId, summary: a.summary || '', command: typeof a.command === 'string' ? a.command : '', reason: a.reason || '', options: AUTO_REVIEW, control: 'approval.autoReview' });
    } else if (m.type === 'local-tool-permission' && m.ask?.status === 'pending') {
      const a = m.ask;
      out.push({ type: 'local-tool', entryId: e.id, requestId: a.requestId, action: a.action || '', target: typeof a.target === 'string' ? a.target : JSON.stringify(a.target ?? ''), command: typeof a.command === 'string' ? a.command : '', options: LOCAL_TOOL, control: 'approval.localTool' });
    }
  }
  return out;
}

export async function control(profile, { action, agent, args } = {}, ctx) {
  if (!ctx || typeof ctx.gateway !== 'function') throw fail('Gateway is not available.', 500);
  if (typeof agent !== 'string' || !UUID.test(agent)) throw fail('Invalid agent id.');
  const a = args && typeof args === 'object' ? args : {};
  const gw = (cmd, body) => ctx.gateway(cmd, body);
  switch (action) {
    case 'working': {
      const r = await gw('readMainAgentContext', { id: agent });
      return { working: r?.isWorking === true };
    }
    case 'model': case 'compact':
      throw fail(`${action === 'model' ? 'Model switching' : 'Compaction'} is not supported by the Grok Bot gateway.`, 501);
    case 'widget.respond': {
      const r = await gw('respondToWidget', withSession({ entryId: str(a.entryId, 'entryId', 200), value: str(a.value, 'value'), agentId: agent }, a));
      return { accepted: r?.accepted !== false };
    }
    case 'widget.dismiss': {
      const r = await gw('dismissWidget', withSession({ entryId: str(a.entryId, 'entryId', 200), agentId: agent }, a));
      return { accepted: r?.accepted !== false };
    }
    case 'approval.autoReview': {
      confirmed(a);
      const body = { entryId: str(a.entryId, 'entryId', 200), requestId: str(a.requestId, 'requestId', 200), resolution: oneOf(a.resolution, AUTO_REVIEW, 'resolution'), agentId: agent };
      const cmd = optStr(a.approvedCommand, 'approvedCommand', 20000); if (cmd && body.resolution !== 'denied') body.approvedCommand = cmd;
      await gw('resolveAutoReviewApproval', withSession(body, a));
      return { ok: true, resolution: body.resolution };
    }
    case 'approval.localTool': {
      confirmed(a);
      const body = { entryId: str(a.entryId, 'entryId', 200), requestId: str(a.requestId, 'requestId', 200), resolution: oneOf(a.resolution, LOCAL_TOOL, 'resolution'), agentId: agent };
      await gw('resolveLocalToolPermission', withSession(body, a));
      return { ok: true, resolution: body.resolution };
    }
    case 'unread': { const isUnread = bool(a.isUnread, 'isUnread'); await gw('setAgentUnread', { id: agent, isUnread }); return { ok: true, isUnread }; }
    case 'hidden': { const isHidden = bool(a.isHidden, 'isHidden'); await gw('setAgentHiddenFromSidebar', { id: agent, isHidden }); return { ok: true, isHidden }; }
    case 'rename': {
      const name = str(a.name, 'name', 120).trim();
      let description = a.description;
      if (typeof description !== 'string') {
        const rows = await gw('listAgents', {});
        const row = (Array.isArray(rows) ? rows : []).find(r => r?.id === agent);
        if (!row) throw fail('Agent not found.', 404);
        description = String(row.description || '');
      }
      if (description.length > 2000) throw fail('description is too long.');
      const r = await gw('updateAgent', { id: agent, profile: { name, description } });
      return { ok: true, name: r?.name ?? name };
    }
    case 'react': {
      await gw('reactToMessage', withSession({ entryId: str(a.entryId, 'entryId', 200), emoji: oneOf(a.emoji, REACTIONS, 'emoji'), agentId: agent }, a));
      return { ok: true };
    }
    case 'newConversation': { confirmed(a); await gw('startFreshConversation', withSession({ id: agent }, a)); return { ok: true }; }
    case 'undoLastTurn': { confirmed(a); await gw('rollBackConversation', withSession({ id: agent }, a)); return { ok: true }; }
    default: throw fail(`Unknown control: ${String(action).slice(0, 60)}`, 404);
  }
}
