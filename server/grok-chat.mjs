import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { validSessionId, sanitizeHistory } from './agent-profiles.mjs';
import { summarizeTranscript } from './agent-session-controls.mjs';

const runPattern = /^run_[a-zA-Z0-9_-]{8,100}$/;
const jobPattern = /^[a-zA-Z0-9_-]{1,100}$/;
const automationFields = ['name', 'prompt', 'schedule', 'deliver', 'skills'];

function fail(message, status = 502) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function unwrap(raw) {
  if (raw && typeof raw === 'object' && raw.kind == null && raw.entry && typeof raw.entry === 'object') return raw.entry;
  return raw;
}

function entriesOf(payload) {
  if (Array.isArray(payload)) return payload;
  if (Array.isArray(payload?.entries)) return payload.entries;
  if (Array.isArray(payload?.items)) return payload.items;
  return [];
}

function entrySeq(raw) {
  const entry = unwrap(raw);
  const seq = Number(raw?.seq ?? entry?.seq);
  return Number.isFinite(seq) ? seq : null;
}

function entryId(raw) {
  const entry = unwrap(raw);
  const id = raw?.id ?? entry?.id;
  return typeof id === 'string' ? id : '';
}

function fingerprint(raw) {
  const id = entryId(raw);
  if (id) return `id:${id}`;
  const seq = entrySeq(raw);
  if (seq != null) return `seq:${seq}`;
  const entry = unwrap(raw);
  const content = typeof entry?.content === 'string' ? entry.content.slice(0, 200) : '';
  const message = typeof entry?.message?.content === 'string' ? entry.message.content.slice(0, 200) : '';
  return `fp:${entry?.kind ?? ''}:${entry?.role ?? ''}:${content}:${message}`;
}

function baselineFrom(entries) {
  const list = Array.isArray(entries) ? entries : [];
  let maxSeq = 0;
  const ids = [];
  for (const raw of list) {
    const seq = entrySeq(raw);
    if (seq != null && seq > maxSeq) maxSeq = seq;
    const id = entryId(raw);
    if (id) ids.push(id);
  }
  return { maxSeq, ids, count: list.length, fingerprints: list.map(fingerprint) };
}

function replyText(entry) {
  if (!entry || typeof entry !== 'object' || entry.streaming === true) return '';
  if (entry.kind === 'send-message' && entry.message?.type === 'text' && typeof entry.message.content === 'string' && entry.message.content.trim()) return entry.message.content;
  if ((entry.kind === 'message' || entry.kind == null) && entry.role === 'assistant' && typeof entry.content === 'string' && entry.content.trim()) return entry.content;
  return '';
}

function repliesAfter(entries, baseline) {
  const list = Array.isArray(entries) ? entries : [];
  const known = new Set(baseline?.fingerprints || []);
  const knownIds = new Set(baseline?.ids || []);
  const maxSeq = Number(baseline?.maxSeq) || 0;
  const texts = [];
  for (const raw of list) {
    const seq = entrySeq(raw);
    const id = entryId(raw);
    let isNew = false;
    if (maxSeq > 0 && seq != null) isNew = seq > maxSeq;
    else if (id) isNew = !knownIds.has(id);
    else isNew = !known.has(fingerprint(raw));
    if (!isNew) continue;
    const text = replyText(unwrap(raw));
    if (text) texts.push(text);
  }
  return texts.at(-1) || '';
}

function historyFromEntries(entries) {
  const data = [];
  if (!Array.isArray(entries)) return { data };
  for (const raw of entries) {
    const entry = unwrap(raw);
    if (!entry || typeof entry !== 'object' || entry.streaming === true) continue;
    let role;
    let content;
    if (entry.kind === 'send-message' && entry.message?.type === 'text' && typeof entry.message.content === 'string') {
      role = 'assistant';
      content = entry.message.content;
    } else if ((entry.kind === 'message' || entry.kind == null) && (entry.role === 'user' || entry.role === 'assistant') && typeof entry.content === 'string') {
      role = entry.role;
      content = entry.content;
    } else continue;
    if (!content.trim()) continue;
    data.push({ role, content });
  }
  return { data };
}

function gatewayDetail(text, token) {
  let detail = '';
  if (text && text.length <= 2_000_000) {
    try {
      const parsed = JSON.parse(text);
      detail = typeof parsed?.error === 'string' ? parsed.error : typeof parsed?.message === 'string' ? parsed.message : '';
    } catch {
      detail = text;
    }
  }
  if (token) detail = detail.split(token).join('');
  return detail.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, 180);
}

function conversationName(value) {
  if (value == null || value === '') return '';
  if (typeof value !== 'string') throw fail('Conversation name must be 1–80 characters.', 400);
  const name = value.trim();
  if (!name) return '';
  if (name.length > 80 || /[\u0000-\u001f\u007f]/.test(name)) throw fail('Conversation name must be 1–80 characters.', 400);
  return name;
}

function isAwaiting(agent) {
  const value = agent?.awaitingUserResponse;
  return value != null && value !== false;
}

function approvalFrom(agent, entries) {
  let pending = null;
  for (const raw of Array.isArray(entries) ? entries : []) {
    const entry = unwrap(raw);
    if (!entry || typeof entry !== 'object') continue;
    const kind = String(entry.kind || '');
    if (!/widget|permission|approval/i.test(kind)) continue;
    pending = {
      command: String(entry.command || entry.title || entry.name || entry.message?.content || 'Tool execution requires approval').slice(0, 4000),
      reason: String(entry.reason || entry.detail || entry.message?.reason || '').slice(0, 1000),
      entryId: entryId(raw),
      kind,
    };
  }
  const awaiting = agent?.awaitingUserResponse;
  if (!pending && !isAwaiting(agent)) return null;
  if (!pending) {
    const command = awaiting && typeof awaiting === 'object'
      ? String(awaiting.command || awaiting.tool || awaiting.name || 'Tool execution requires approval')
      : 'Tool execution requires approval';
    const reason = awaiting && typeof awaiting === 'object'
      ? String(awaiting.reason || awaiting.detail || '')
      : typeof awaiting === 'string' ? awaiting : '';
    pending = { command: command.slice(0, 4000), reason: reason.slice(0, 1000), entryId: '', kind: '' };
  }
  return pending;
}

function automationRows(payload) {
  const list = Array.isArray(payload) ? payload : Array.isArray(payload?.automations) ? payload.automations : Array.isArray(payload?.items) ? payload.items : [];
  return list.map(row => {
    const automation = row?.automation && typeof row.automation === 'object' ? row.automation : row;
    const agentId = typeof row?.agentId === 'string' ? row.agentId : typeof automation?.agentId === 'string' ? automation.agentId : '';
    return { agentId, automation };
  }).filter(row => row.automation && typeof row.automation === 'object' && typeof row.automation.id === 'string');
}

function publicJob(row) {
  const automation = row.automation;
  if (!jobPattern.test(automation.id)) return null;
  const enabled = automation.enabled !== false && automation.isEnabled !== false;
  const paused = automation.paused === true || automation.isEnabled === false || automation.enabled === false;
  const schedule = automation.schedule ?? automation.trigger?.schedule ?? automation.trigger?.cron ?? '';
  const scheduleText = typeof schedule === 'string' ? schedule : JSON.stringify(schedule);
  const job = {
    id: automation.id,
    name: String(automation.name || automation.id).slice(0, 1000),
    enabled,
    paused,
    state: String(automation.state || automation.status || (enabled ? 'active' : 'paused')).slice(0, 1000),
    schedule: scheduleText.slice(0, 1000),
    schedule_display: String(automation.scheduleDisplay || automation.schedule_display || scheduleText).slice(0, 1000),
  };
  for (const [key, value] of [['next_run_at', automation.nextRunAt ?? automation.next_run_at], ['last_run_at', automation.lastRunAt ?? automation.last_run_at], ['last_status', automation.lastStatus ?? automation.last_status]]) {
    if (value !== undefined && value !== null && value !== '') job[key] = String(value).slice(0, 1000);
  }
  return job;
}

function jobRecord(row) {
  const job = publicJob(row);
  if (!job) return null;
  const schedule = row.automation.schedule ?? row.automation.trigger?.schedule ?? '';
  return {
    ...job,
    prompt: String(row.automation.prompt || row.automation.task || '').slice(0, 16000),
    deliver: 'local',
    skills: [],
    schedule: typeof schedule === 'string' ? schedule.slice(0, 500) : job.schedule,
  };
}

function skillPreface(skills) {
  const names = (Array.isArray(skills) ? skills : []).map(skill => String(skill).trim()).filter(Boolean);
  return names.length ? `Apply these skills: ${names.join(', ')}.\n\n` : '';
}

function automationSpec(data) {
  const schedule = data.schedule.trim();
  return { name: data.name.trim(), prompt: `${skillPreface(data.skills)}${data.prompt}`, schedule, trigger: { type: 'cron', schedule } };
}

function validateAutomation(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data) || Object.keys(data).some(key => !automationFields.includes(key))) throw fail('Unsupported automation fields', 400);
  for (const key of ['name', 'prompt', 'schedule', 'deliver']) if (typeof data[key] !== 'string' || data[key].length > (key === 'prompt' ? 16000 : 500)) throw fail(`Invalid ${key}`, 400);
  if (!data.name.trim() || !data.schedule.trim() || !data.prompt.trim()) throw fail('Name, schedule and prompt required', 400);
  if (!Array.isArray(data.skills) || data.skills.length > 20 || data.skills.some(skill => typeof skill !== 'string' || !skill.trim() || skill.length > 100)) throw fail('Invalid skills', 400);
  if (skillPreface(data.skills).length + data.prompt.length > 16000) throw fail('Invalid prompt', 400);
  if (data.deliver.trim() && data.deliver.trim() !== 'local') throw fail('Grok Bot automations have no delivery target. Leave delivery as local.', 409);
}

function toolFeedPayload(channel, payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;
  const call = payload.toolCall && typeof payload.toolCall === 'object' ? payload.toolCall : payload;
  const name = typeof call.name === 'string' ? call.name : (typeof call.toolName === 'string' ? call.toolName : (typeof call.tool === 'string' ? call.tool : ''));
  if (!/^[a-zA-Z0-9_.:-]{1,100}$/.test(name)) return null;
  const hint = `${channel} ${payload.kind || ''} ${payload.type || ''}`.toLowerCase();
  if (!/tool/.test(hint) && !payload.toolCall && typeof call.toolName !== 'string') return null;
  const failed = /fail|error/.test(hint) || payload.error === true;
  const completed = !failed && (/result|complete|done/.test(hint) || payload.output !== undefined || payload.result !== undefined);
  const event = failed ? 'tool.failed' : (completed ? 'tool.completed' : 'tool.started');
  return { event, tool: name, timestamp: Date.now() / 1000, ...(failed ? { error: true } : {}) };
}

/** Read or cancel every gateway body so a rejection cannot surface later as an unhandled error. */
async function drain(response) {
  try {
    if (!response || typeof response.text !== 'function') return '';
    const text = await response.text();
    if (text.length > 2_000_000) throw fail('Grok Bot response exceeds the bounded JSON limit.');
    return text;
  } catch (error) {
    try { await response?.body?.cancel?.(); } catch {}
    if (error?.status) throw error;
    throw fail('Grok Bot could not complete the request.');
  }
}

export function createGrokChat({ fetchImpl = fetch, runtimeDirectory, now = () => Date.now(), acceptanceGraceMs = 8000, runTimeoutMs = 10 * 60 * 1000 } = {}) {
  const runs = new Map();
  const operatorDelivered = new Set();
  const directory = runtimeDirectory ? path.join(runtimeDirectory, 'grok-runs') : '';

  function loadRuns() {
    if (!directory) return;
    let names = [];
    try { names = fs.readdirSync(directory); } catch { return; }
    const loaded = [];
    for (const name of names) {
      if (!name.endsWith('.json')) continue;
      try {
        const record = JSON.parse(fs.readFileSync(path.join(directory, name), 'utf8'));
        if (!record || !runPattern.test(record.runId) || !validSessionId(record.agentId) || typeof record.nonce !== 'string' || typeof record.profileId !== 'string') continue;
        record.baseline = record.baseline && typeof record.baseline === 'object' ? record.baseline : baselineFrom([]);
        record.started = Number(record.started) || 0;
        loaded.push(record);
      } catch { /* A corrupt run file must not block the rest of the chat. */ }
    }
    for (const record of loaded.sort((a, b) => b.started - a.started).slice(0, 200)) runs.set(record.runId, record);
  }
  loadRuns();

  function persist(run) {
    if (!directory) return;
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    const dest = path.join(directory, `${run.runId}.json`);
    const temp = `${dest}.${process.pid}.tmp`;
    const record = { runId: run.runId, nonce: run.nonce, agentId: run.agentId, profileId: run.profileId, status: run.status || 'running', started: run.started, baseline: run.baseline };
    fs.writeFileSync(temp, JSON.stringify(record), { mode: 0o600 });
    fs.renameSync(temp, dest);
  }

  function forget(runId) {
    runs.delete(runId);
    if (!directory) return;
    try { fs.rmSync(path.join(directory, `${runId}.json`)); } catch {}
  }

  function remember(run) {
    runs.set(run.runId, run);
    persist(run);
    if (runs.size <= 200) return;
    const oldest = [...runs.values()].sort((a, b) => a.started - b.started)[0];
    if (oldest && oldest.runId !== run.runId) forget(oldest.runId);
  }

  async function command(profile, name, body) {
    let response;
    try {
      response = await fetchImpl(`${profile.apiUrl}/api/${name}`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${profile.apiKey}`,
          'Content-Type': 'application/json',
          'x-sand-request-id': randomUUID(),
        },
        body: JSON.stringify(body ?? {}),
        signal: AbortSignal.timeout(15000),
        redirect: 'error',
      });
      const text = await drain(response);
      if (!response || response.ok !== true) {
        const status = Number.isInteger(response?.status) && response.status >= 400 && response.status < 600 ? response.status : 502;
        const detail = gatewayDetail(text, profile.apiKey);
        const message = status === 404
          ? (detail ? `Grok Bot could not find that conversation. ${detail}` : 'Grok Bot could not find that conversation.')
          : (detail ? `Grok Bot could not complete the request. ${detail}` : 'Grok Bot could not complete the request.');
        throw fail(message, status >= 500 ? 502 : status);
      }
      if (!text) return null;
      try { return JSON.parse(text); }
      catch { throw fail('Grok Bot returned invalid JSON.'); }
    } catch (error) {
      if (error?.status) throw error;
      throw fail('Cannot reach Grok Bot right now. The turn may still be running; check status before sending again.');
    }
  }

  async function guard(reply, res, work) {
    try {
      return await work();
    } catch (error) {
      const status = Number.isInteger(error?.status) ? error.status : 502;
      let message = typeof error?.message === 'string' ? error.message : '';
      if (!message.trim() || message.length > 500) message = 'Grok Bot could not complete the request.';
      if (res.headersSent || res.writableEnded) { try { res.end(); } catch {} return; }
      try { return reply(res, status, { error: message }); }
      catch { try { res.end(); } catch {} }
    }
  }

  async function createConversation(profile, name) {
    const reusable = name ? null : await findReusable(profile);
    if (reusable) return { id: reusable.id, title: String(reusable.name || 'Orbit chat').slice(0, 100) };
    const created = await command(profile, 'createAgent', { name: name || 'Orbit chat', description: '', isIntroductionSuppressed: true });
    const id = created?.agent?.id;
    if (!validSessionId(id)) throw fail('Grok Bot did not return a usable conversation id.');
    return { id, title: typeof created.agent.name === 'string' ? created.agent.name.slice(0, 100) : (name || 'Orbit chat') };
  }

  async function readTranscript(profile, agentId) {
    if (!validSessionId(agentId)) throw fail('Invalid Grok Bot conversation.', 400);
    const tail = await command(profile, 'getAgentTranscriptTail', { id: agentId, limit: 80 });
    return sanitizeHistory(historyFromEntries(entriesOf(tail)));
  }

  async function probe(profile) {
    try { await command(profile, 'listAgents', {}); }
    catch { return { ok: false, tools: false }; }
    let tools = false;
    try {
      const servers = await command(profile, 'listBoxMcpServers', {});
      const list = Array.isArray(servers) ? servers : Array.isArray(servers?.servers) ? servers.servers : [];
      tools = list.length > 0;
    } catch { tools = false; }
    return { ok: true, tools };
  }

  async function sessionPage(profile, offset = 0) {
    const agents = await command(profile, 'listAgents', {});
    const rows = (Array.isArray(agents) ? agents : []).filter(agent => agent && validSessionId(agent.id));
    const start = Number.isSafeInteger(offset) && offset > 0 ? offset : 0;
    const page = rows.slice(start, start + 100);
    return {
      data: page.map(agent => ({
        id: agent.id,
        title: String(agent.name || agent.id).slice(0, 200),
        updated_at: Number.isFinite(agent.updatedAt) ? new Date(agent.updatedAt).toISOString().slice(0, 100) : '',
      })),
      has_more: start + page.length < rows.length,
    };
  }

  async function findReusable(profile) {
    const agents = await command(profile, 'listAgents', {});
    const rows = (Array.isArray(agents) ? agents : []).filter(agent => agent && agent.name === 'Orbit chat' && !agent.isRunning && !agent.isComposingMessage && validSessionId(agent.id));
    for (const agent of rows.slice(0, 8)) {
      try {
        const tail = await command(profile, 'getAgentTranscriptTail', { id: agent.id, limit: 40 });
        if (!historyFromEntries(entriesOf(tail)).data.length) return agent;
      } catch (error) { if (error.status !== 404) throw error; }
    }
    return null;
  }

  async function selectSession(reply, res, scope) {
    return guard(reply, res, () => selectSessionBody(reply, res, scope));
  }

  async function selectSessionBody(reply, res, { body, target, revision, profileId, shared, validatePane, conversations }) {
    const creating = body.target_session_id === undefined || body.target_session_id === null;
    let targetId = creating ? null : body.target_session_id;
    if (!creating && !validSessionId(targetId)) return reply(res, 400, { error: 'Invalid Grok Bot conversation.' });
    if (!creating && (shared.locks.has(`session:${target.id}:${targetId}`) || shared.hasActive(target.id, targetId, body.workspace_id, body.pane_id))) return reply(res, 409, { error: 'This conversation is already running.' });
    const name = creating ? conversationName(body.conversation_name) : '';
    let title;
    let messages = [];
    if (creating) {
      let created;
      try { created = await createConversation(target, name); }
      catch (error) { if (error.status) return reply(res, error.status, { error: error.message }); throw error; }
      targetId = created.id;
      title = created.title;
    } else {
      let found;
      for (let pageOffset = 0; pageOffset <= 10000; pageOffset += 100) {
        const page = await sessionPage(target, pageOffset);
        found = page.data.find(item => item.id === targetId);
        if (found || !page.has_more) break;
      }
      if (!found) return reply(res, 404, { error: 'Grok Bot conversation not found.' });
      title = found.title.slice(0, 100);
      try {
        const tail = await command(target, 'getAgentTranscriptTail', { id: targetId, limit: 80 });
        messages = sanitizeHistory(historyFromEntries(entriesOf(tail)));
      } catch (error) { if (error.status !== 404) throw error; }
    }
    if (shared.locks.has(`session:${target.id}:${targetId}`) || shared.hasActive(target.id, targetId, body.workspace_id, body.pane_id)) return reply(res, 409, { error: 'This conversation is already running.' });
    validatePane(body);
    const current = shared.read(body.workspace_id, body.pane_id);
    if (!current || current.binding_revision !== revision || current.session !== body.session_id || current.profile_id !== profileId || current.run) return reply(res, 409, { error: 'Conversation changed or is still running.' });
    const display = conversations.read({ workspace_id: body.workspace_id, profile_id: target.id, session_id: targetId });
    const state = shared.write(body.workspace_id, body.pane_id, { session: targetId, profile_id: target.id, binding_revision: revision + 1, messages, title: display.title || title, history_unstarted: creating });
    return reply(res, 200, { state });
  }

  async function transcriptEntries(profile, agentId) {
    try {
      const tail = await command(profile, 'getAgentTranscriptTail', { id: agentId, limit: 80 });
      return entriesOf(tail);
    } catch (error) {
      if (error.status !== 404) throw error;
      return [];
    }
  }

  async function transcriptBaseline(profile, agentId) {
    return baselineFrom(await transcriptEntries(profile, agentId));
  }

  function sessionKey(profile, agentId) {
    return `${profile.id}:${agentId}`;
  }

  function historyHasOperator(entries) {
    return historyFromEntries(entries).data.some(row => typeof row.content === 'string' && row.content.includes('Orbit workspace operator block'));
  }

  function workspaceUnavailable() {
    return fail('Workspace has not synced yet. Wait for workspace connection and retry.', 409);
  }

  function grokWorkspaceText(raw) {
    if (raw && typeof raw === 'object' && typeof raw.operator === 'string') {
      const guidePath = typeof raw.guidePath === 'string' && raw.guidePath ? raw.guidePath : 'docs/AGENT_GUIDE.md';
      return `${raw.operator}Read ${guidePath} from disk for the full workspace operator guide before changing the workspace. That guide is not inlined in this prompt.\n`;
    }
    const text = String(raw ?? '');
    if (!text.trim()) return '';
    const marker = '\nOrbit workspace operator block\n';
    const at = text.indexOf(marker);
    if (at >= 0) {
      const guideAt = text.indexOf('\nOrbit workspace operating instructions:\n', at);
      const operator = guideAt > at ? text.slice(at, guideAt) : text.slice(at);
      const guidePath = 'docs/AGENT_GUIDE.md';
      return `${operator}Read ${guidePath} from disk for the full workspace operator guide before changing the workspace. That guide is not inlined in this prompt.\n`;
    }
    const legacy = text.lastIndexOf('\nRepository: ');
    if (legacy >= 0) return `${text.slice(legacy)}\nRead docs/AGENT_GUIDE.md from disk for the full workspace operator guide before changing the workspace. That guide is not inlined in this prompt.\n`;
    return text;
  }

  function readWorkspaceContext(workspaceContext, workspaceId) {
    try {
      const raw = typeof workspaceContext.parts === 'function' ? workspaceContext.parts(workspaceId) : workspaceContext(workspaceId);
      return grokWorkspaceText(raw);
    } catch {
      throw workspaceUnavailable();
    }
  }

  async function promptWithOperator(profile, agentId, input, workspaceContext, workspaceId, entries) {
    const text = input.trim();
    if (!workspaceId || typeof workspaceContext !== 'function') return { prompt: text, attached: false };
    const key = sessionKey(profile, agentId);
    if (operatorDelivered.has(key)) return { prompt: text, attached: false };
    const prior = entries || await transcriptEntries(profile, agentId);
    if (historyHasOperator(prior)) {
      operatorDelivered.add(key);
      return { prompt: text, attached: false };
    }
    const context = readWorkspaceContext(workspaceContext, workspaceId);
    if (!context) return { prompt: text, attached: false };
    return { prompt: `${text}\n\nWorkspace context:\n${context}`, attached: true };
  }

  async function turn(reply, res, scope) {
    return guard(reply, res, () => turnBody(reply, res, scope));
  }

  async function turnBody(reply, res, { body, profile, shared, workspaceContext, executionGate }) {
    if (typeof body.input !== 'string' || !body.input.trim() || body.input.length > 100000) return reply(res, 400, { error: 'Enter a message of 1–100,000 characters.' });
    if (!validSessionId(body.session_id)) return reply(res, 400, { error: 'Invalid Grok Bot conversation.' });
    if (executionGate && ((typeof executionGate.busy === 'function' && executionGate.busy('agent')) || executionGate.status?.().job)) return reply(res, 409, { error: 'The shared execution lane is busy or unresolved. Wait for active work or reconcile an unknown outcome before starting a new chat turn.' });
    const entries = await transcriptEntries(profile, body.session_id);
    let composed;
    try { composed = await promptWithOperator(profile, body.session_id, body.input, workspaceContext, body.workspace_id, entries); }
    catch (error) {
      if (error.status === 409) return reply(res, 409, { error: 'Workspace has not synced yet. Wait for workspace connection and retry.' });
      throw error;
    }
    const linked = body.pane_id ? shared.read(body.workspace_id, body.pane_id) : null;
    const preamble = typeof linked?.orbit_preamble === 'string' ? linked.orbit_preamble.trim().slice(0, 16000) : '';
    let prompt = composed.prompt;
    if (preamble) prompt = `${preamble}\n\n${prompt}`;
    prompt = prompt.slice(0, 100000);
    const baseline = baselineFrom(entries);
    const nonce = randomUUID();
    const runId = `run_${randomUUID().replaceAll('-', '')}`;
    const accepted = await command(profile, 'sendPrompt', { prompt, agentId: body.session_id, clientNonce: nonce });
    if (composed.attached && accepted?.accepted === true) operatorDelivered.add(sessionKey(profile, body.session_id));
    if (!accepted || accepted.accepted !== true) {
      const detail = gatewayDetail(JSON.stringify({ error: typeof accepted?.error === 'string' ? accepted.error : typeof accepted?.message === 'string' ? accepted.message : '' }), profile.apiKey);
      return reply(res, 502, { error: detail ? `Grok Bot did not accept the message. ${detail}` : 'Grok Bot did not accept the message.' });
    }
    remember({ runId, nonce, agentId: body.session_id, profileId: profile.id, status: 'running', started: now(), baseline });
    if (body.pane_id) {
      const current = shared.read(body.workspace_id, body.pane_id);
      if (current) shared.write(body.workspace_id, body.pane_id, { ...current, orbit_preamble: undefined, run: runId, messages: [...(current.messages || []), { role: 'user', text: body.input.trim() }].slice(-100) });
    }
    return reply(res, 202, { run_id: runId, status: 'running' });
  }

  async function inspect(profile, run) {
    const agents = await command(profile, 'listAgents', {});
    const agent = Array.isArray(agents) ? agents.find(item => item && item.id === run.agentId) : null;
    let acceptance = null;
    try {
      acceptance = await command(profile, 'promptAcceptanceStatus', { accountSlot: 'host', clientNonce: run.nonce, agentId: run.agentId });
    } catch (error) { if (error.status !== 404) throw error; }
    let entries = [];
    try {
      const tail = await command(profile, 'getAgentTranscriptTail', { id: run.agentId, limit: 80 });
      entries = entriesOf(tail);
    } catch (error) { if (error.status !== 404) throw error; }
    const output = repliesAfter(entries, run.baseline).slice(0, 16000);
    const rejected = acceptance?.outcome === 'found' && acceptance.record?.status === 'rejected';
    if (rejected && !output) return { status: 'failed', output: '', approvals: [], error: 'Grok Bot rejected the message.' };
    if (output) return { status: 'completed', output, approvals: [] };
    const age = now() - run.started;
    if (age >= runTimeoutMs) return { status: 'interrupted', output: '', approvals: [], error: 'Grok Bot did not finish this turn before the time limit.' };
    const pendingAcceptance = acceptance?.outcome === 'found' && acceptance.record?.status === 'pending';
    const acceptanceMissing = !acceptance || acceptance.outcome === 'not-found' || acceptance.outcome === 'unknown-durability';
    if (pendingAcceptance || (acceptanceMissing && age < acceptanceGraceMs)) return { status: 'running', output: '', approvals: [] };
    const approval = approvalFrom(agent, entries);
    if (approval) return { status: 'waiting_for_approval', output: '', approvals: [{ command: approval.command, reason: approval.reason }], approval };
    return { status: 'running', output: '', approvals: [] };
  }

  function finishPane(shared, body, profile, runId, output) {
    if (!body.pane_id) return;
    const current = shared.read(body.workspace_id, body.pane_id);
    if (current?.run === runId && current.session === body.session_id && current.profile_id === profile.id) {
      shared.write(body.workspace_id, body.pane_id, { ...current, run: undefined, messages: [...current.messages, { role: 'assistant', text: output || 'Run completed.' }].slice(-100) });
    }
  }

  function endRun(shared, body, profile, runId, output) {
    finishPane(shared, body, profile, runId, output);
    forget(runId);
  }

  async function resolveApproval(profile, run, choice) {
    const agents = await command(profile, 'listAgents', {});
    const agent = Array.isArray(agents) ? agents.find(item => item && item.id === run.agentId) : null;
    let entries = [];
    try {
      const tail = await command(profile, 'getAgentTranscriptTail', { id: run.agentId, limit: 80 });
      entries = entriesOf(tail);
    } catch (error) { if (error.status !== 404) throw error; }
    const pending = approvalFrom(agent, entries);
    const agentId = run.agentId;
    if (choice === 'once') {
      if (pending?.entryId && String(pending.kind || '').includes('widget')) {
        await command(profile, 'respondToWidget', { entryId: pending.entryId, agentId, value: { decision: 'allow', choice: 'once' } });
        return;
      }
      try {
        await command(profile, 'resolveLocalToolPermission', { id: agentId, decision: 'allow', choice: 'once' });
      } catch (error) {
        if (error.status !== 404) throw error;
        if (pending?.entryId) await command(profile, 'respondToWidget', { entryId: pending.entryId, agentId, value: { decision: 'allow', choice: 'once' } });
        else await command(profile, 'resolveAutoReviewApproval', { id: agentId, decision: 'allow', choice: 'once' });
      }
      return;
    }
    if (pending?.entryId) {
      try {
        await command(profile, 'dismissWidget', { entryId: pending.entryId, agentId });
        return;
      } catch (error) { if (error.status !== 404) throw error; }
    }
    try {
      await command(profile, 'resolveLocalToolPermission', { id: agentId, decision: 'deny', choice: 'deny' });
    } catch (error) {
      if (error.status !== 404) throw error;
      await command(profile, 'resolveAutoReviewApproval', { id: agentId, decision: 'deny', choice: 'deny' });
    }
  }

  async function control(reply, res, scope) {
    return guard(reply, res, () => controlBody(reply, res, scope));
  }

  async function controlBody(reply, res, { body, profile, shared, workspaceContext }) {
    if (!runPattern.test(body.run_id || '')) return reply(res, 400, { error: 'Invalid run.' });
    const run = runs.get(body.run_id);
    if (!run || run.agentId !== body.session_id || run.profileId !== profile.id) {
      if (body.action === 'status' && body.pane_id) {
        const current = shared.read(body.workspace_id, body.pane_id);
        if (current?.run === body.run_id && current.session === body.session_id && current.profile_id === profile.id) {
          const note = 'This run is no longer tracked. Send the message again if you still need a reply.';
          shared.write(body.workspace_id, body.pane_id, { ...current, run: undefined, messages: [...(current.messages || []), { role: 'assistant', text: note }].slice(-100) });
          return reply(res, 200, { run_id: body.run_id, status: 'interrupted', output: '', approvals: [], error: note });
        }
      }
      return reply(res, 404, { error: 'Run not found in this Orbit conversation.' });
    }
    if (body.action === 'steer') {
      if (typeof body.input !== 'string' || !body.input.trim() || body.input.length > 100000) return reply(res, 400, { error: 'Guidance must contain 1–100,000 characters.' });
      let composed;
      try { composed = await promptWithOperator(profile, run.agentId, body.input, workspaceContext, body.workspace_id); }
      catch (error) {
        if (error.status === 409) return reply(res, 409, { error: 'Workspace has not synced yet. Wait for workspace connection and retry.' });
        throw error;
      }
      const accepted = await command(profile, 'sendPrompt', { prompt: composed.prompt, agentId: run.agentId, clientNonce: randomUUID() });
      if (composed.attached && accepted?.accepted === true) operatorDelivered.add(sessionKey(profile, run.agentId));
      if (!accepted || accepted.accepted !== true) return reply(res, 502, { error: 'Grok Bot did not accept the follow-up prompt.' });
      return reply(res, 200, { accepted: true });
    }
    if (body.action === 'approval') {
      if (!['once', 'deny'].includes(body.choice)) return reply(res, 400, { error: 'Only allow-once or deny is supported.' });
      await resolveApproval(profile, run, body.choice);
      return reply(res, 200, { status: 'running', resolved: true });
    }
    if (body.action === 'stop') {
      await command(profile, 'interruptAgentRun', { id: run.agentId });
      endRun(shared, body, profile, body.run_id, 'Run cancelled.');
      return reply(res, 200, { status: 'stopping' });
    }
    const view = await inspect(profile, run);
    if (view.status === 'running' || view.status === 'waiting_for_approval') {
      return reply(res, 200, { run_id: body.run_id, status: view.status, output: '', approvals: view.approvals || [] });
    }
    const paneText = view.status === 'completed' ? view.output : (view.error || `Run ${view.status}.`);
    endRun(shared, body, profile, body.run_id, paneText);
    return reply(res, 200, { run_id: body.run_id, status: view.status, output: view.output || '', approvals: [], ...(view.error ? { error: view.error } : {}) });
  }

  async function findAutomation(profile, jobId) {
    const rows = automationRows(await command(profile, 'listAllAutomations', {}));
    return rows.find(row => row.automation.id === jobId) || null;
  }

  async function surface(reply, res, scope) {
    return guard(reply, res, () => surfaceBody(reply, res, scope));
  }

  async function surfaceBody(reply, res, { body, profile }) {
    if (body.action === 'capabilities') return reply(res, 200, { features: { run_events_sse: true } });
    if (body.action === 'jobs') {
      const jobs = automationRows(await command(profile, 'listAllAutomations', {})).map(publicJob).filter(Boolean).slice(0, 200);
      return reply(res, 200, { jobs });
    }
    if (body.action === 'job_control') {
      if (!['pause', 'resume'].includes(body.operation) || typeof body.job_id !== 'string' || !jobPattern.test(body.job_id) || body.confirm !== true) return reply(res, 400, { error: 'Confirm a valid pause or resume operation.' });
      const found = await findAutomation(profile, body.job_id);
      if (!found) return reply(res, 404, { error: 'Grok Bot could not find that automation.' });
      await command(profile, 'setAgentAutomationEnabled', { id: found.agentId, automationId: body.job_id, isEnabled: body.operation === 'resume' });
      return reply(res, 200, { accepted: true, operation: body.operation });
    }
    if (body.action === 'automation') return reply(res, 200, await automationAction(profile, body));
    if (body.action === 'catalog') return reply(res, 200, await catalog(profile, body));
    if (body.action === 'activity') return reply(res, 200, await activity(profile, body));
    return reply(res, 409, { error: 'This Hermes tool is not available for the Grok Bot provider.' });
  }

  async function automationAction(profile, body) {
    const operation = body.operation;
    if (!['get', 'create', 'update', 'delete', 'run'].includes(operation)) throw fail('Unknown automation operation', 400);
    const id = body.job_id;
    if (operation !== 'create' && (typeof id !== 'string' || !jobPattern.test(id))) throw fail('Invalid job ID', 400);
    if (operation !== 'get' && body.confirm !== true) throw fail('Explicit confirmation required', 400);
    if (operation === 'get') {
      const found = await findAutomation(profile, id);
      if (!found) throw fail('Grok Bot could not find that automation.', 404);
      return { job: jobRecord(found) };
    }
    if (operation === 'delete' || operation === 'run') {
      const found = await findAutomation(profile, id);
      if (!found) throw fail('Grok Bot could not find that automation.', 404);
      await command(profile, operation === 'delete' ? 'deleteAgentAutomation' : 'runAgentAutomationNow', { id: found.agentId, automationId: id });
      return { accepted: true };
    }
    validateAutomation(body.fields);
    if (operation === 'create') {
      if (!validSessionId(body.session_id)) throw fail('Invalid Grok Bot conversation.', 400);
      const created = await command(profile, 'createAgentAutomation', { id: body.session_id, spec: automationSpec(body.fields) });
      const automation = created?.automation || created;
      const createdId = typeof automation?.id === 'string' ? automation.id : '';
      if (!jobPattern.test(createdId)) throw fail('Grok Bot did not return a usable automation id.');
      return { job: jobRecord({ agentId: body.session_id, automation: { ...automationSpec(body.fields), ...automation, id: createdId } }) };
    }
    const found = await findAutomation(profile, id);
    if (!found) throw fail('Grok Bot could not find that automation.', 404);
    const updated = await command(profile, 'updateAgentAutomation', { id: found.agentId, automationId: id, spec: automationSpec(body.fields) });
    const automation = updated?.automation || { ...found.automation, ...automationSpec(body.fields), id };
    return { job: jobRecord({ agentId: found.agentId, automation }) };
  }

  async function catalog(profile, body) {
    if (!['skills', 'toolsets'].includes(body.kind)) throw fail('Invalid catalog.', 400);
    let payload;
    try {
      payload = await command(profile, body.kind === 'skills' ? 'skillsCatalog' : 'listBoxMcpServers', {});
    } catch (error) {
      if (error.status === 404) throw fail('Grok Bot does not advertise this catalog.', 409);
      throw error;
    }
    if (body.kind === 'skills') {
      const rows = Array.isArray(payload) ? payload : Array.isArray(payload?.skills) ? payload.skills : [];
      const items = rows.slice(0, 500).map(item => ({
        name: String(item?.name || '').slice(0, 2000),
        description: String(item?.description || '').slice(0, 2000),
        category: String(item?.category || item?.source || item?.publisher || '').slice(0, 2000),
      })).filter(item => item.name);
      return { items };
    }
    const servers = Array.isArray(payload?.servers) ? payload.servers : Array.isArray(payload) ? payload : [];
    const items = servers.slice(0, 500).map(server => ({
      name: String(server?.serverIdentifier || server?.name || '').slice(0, 2000),
      description: String(server?.statusDetail || server?.status || '').slice(0, 2000),
      enabled: server?.status === 'connected',
      configured: server?.status !== 'error',
      tools: [],
    })).filter(item => item.name);
    return { items };
  }

  function pushActivity(activity, item) {
    if (activity.length >= 100) return;
    activity.push({
      kind: item.kind,
      name: String(item.name || (item.kind === 'result' ? 'Tool result' : 'tool')).slice(0, 100),
      id: String(item.id || '').slice(0, 150),
      detail: String(item.detail || '').slice(0, item.kind === 'result' ? 8000 : 4000),
    });
  }

  async function activity(profile, body) {
    if (!validSessionId(body.session_id)) throw fail('Invalid Grok Bot conversation.', 400);
    let items = [];
    try {
      const outline = await command(profile, 'getConversationOutline', { id: body.session_id });
      items = entriesOf(outline);
    } catch (error) {
      if (error.status !== 404) throw error;
      try {
        const tail = await command(profile, 'getAgentTranscriptTail', { id: body.session_id, limit: 80 });
        items = entriesOf(tail);
      } catch (inner) { if (inner.status !== 404) throw inner; }
    }
    const activityRows = [];
    for (const raw of items) {
      const entry = unwrap(raw);
      if (!entry || typeof entry !== 'object') continue;
      const kind = String(entry.kind || '');
      if (kind === 'tool-call' || kind === 'tool_call' || entry.toolCall) {
        const call = entry.toolCall || entry;
        const detail = typeof call.input === 'string' ? call.input : JSON.stringify(call.input || call.arguments || call.detail || {});
        pushActivity(activityRows, { kind: 'call', name: call.name || call.toolName, id: call.id || entryId(raw), detail });
      } else if (kind === 'tool-result' || kind === 'tool_result' || entry.role === 'tool') {
        pushActivity(activityRows, { kind: 'result', name: entry.name, id: entry.toolCallId || entry.tool_call_id || entryId(raw), detail: entry.output || entry.content || entry.detail || '' });
      }
      if (activityRows.length >= 100) break;
    }
    return { activity: activityRows, note: 'Tool history from this Grok Bot conversation. Active tools may still be running. Results are truncated.' };
  }

  async function events(reply, res, { body, profile, shared }) {
    return guard(reply, res, async () => {
      if (!runPattern.test(body.run_id || '')) return reply(res, 400, { error: 'Invalid run.' });
      const run = runs.get(body.run_id);
      let agentId = run && run.profileId === profile.id && run.agentId === body.session_id ? run.agentId : '';
      if (!agentId && body.pane_id && shared) {
        const current = shared.read(body.workspace_id, body.pane_id);
        if (current?.run === body.run_id && current.session === body.session_id && current.profile_id === profile.id) agentId = body.session_id;
      }
      if (!agentId) return reply(res, 404, { error: 'Run not found in this Orbit conversation.' });
      const abort = new AbortController();
      res.on('close', () => abort.abort());
      let response;
      try {
        response = await fetchImpl(`${profile.apiUrl.replace(/\/$/, '')}/events`, {
          headers: { Authorization: `Bearer ${profile.apiKey}`, Accept: 'text/event-stream', 'x-sand-request-id': randomUUID() },
          signal: abort.signal,
          redirect: 'error',
        });
      } catch {
        return reply(res, 502, { error: 'Grok Bot activity stream is unavailable. Status polling still works.' });
      }
      if (!response || response.ok !== true) {
        await drain(response);
        return reply(res, 502, { error: 'Grok Bot activity stream is unavailable. Status polling still works.' });
      }
      const reader = response.body?.getReader?.();
      if (!reader) {
        try { await response.body?.cancel?.(); } catch {}
        return reply(res, 502, { error: 'Grok Bot activity stream is unavailable. Status polling still works.' });
      }
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', 'X-Accel-Buffering': 'no' });
      const decoder = new TextDecoder();
      let buffer = '';
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, '\n');
          if (buffer.length > 1_000_000) break;
          let split;
          while ((split = buffer.indexOf('\n\n')) >= 0) {
            const block = buffer.slice(0, split);
            buffer = buffer.slice(split + 2);
            const data = block.split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5).trim()).join('\n');
            if (!data) continue;
            let parsed;
            try { parsed = JSON.parse(data); } catch { parsed = { channel: 'message', payload: data.slice(0, 12000) }; }
            const payload = parsed?.payload ?? parsed;
            if (payload && typeof payload === 'object' && typeof payload.agentId === 'string' && payload.agentId !== agentId) continue;
            const channel = String(parsed?.channel || parsed?.event || 'message').replace(/[\r\n]/g, '').slice(0, 80) || 'message';
            const writeEvent = async (eventName, data) => {
              const encoded = JSON.stringify(data).slice(0, 12000);
              const name = String(eventName).replace(/[\r\n]/g, '').slice(0, 80) || 'message';
              if (!res.write(`event: ${name}\ndata: ${encoded}\n\n`)) {
                await new Promise(resolve => { res.once('drain', resolve); res.once('close', resolve); });
              }
            };
            await writeEvent(channel, payload);
            const toolEvent = toolFeedPayload(channel, payload);
            if (toolEvent && !res.destroyed && !res.writableEnded) await writeEvent(toolEvent.event, toolEvent);
            if (res.destroyed || res.writableEnded) break;
          }
          if (res.destroyed || res.writableEnded) break;
        }
      } catch {
        /* The browser closing the live view aborts the gateway stream. */
      } finally {
        try { await reader.cancel(); } catch {}
        try { if (!res.writableEnded) res.end(); } catch {}
      }
    });
  }

  const sharedAgentName = 'Orbit shared chat';

  async function ensureSharedAgent(profile, currentId, agentName = sharedAgentName) {
    const name = typeof agentName === 'string' && agentName.trim() ? agentName.trim().slice(0, 80) : sharedAgentName;
    if (validSessionId(currentId)) {
      try {
        const agents = await command(profile, 'listAgents', {});
        const found = (Array.isArray(agents) ? agents : []).find(agent => agent && agent.id === currentId && agent.name === name);
        if (found) return found.id;
      } catch (error) { if (error.status !== 404) throw error; }
    }
    const created = await command(profile, 'createAgent', {
      name,
      description: name === sharedAgentName
        ? 'Shared Orbit pane. Not the owner’s main Grok Bot conversation.'
        : 'Orbit Collab agent. Not the owner’s main Grok Bot conversation.',
      isIntroductionSuppressed: true,
    });
    const id = created?.agent?.id;
    if (!validSessionId(id)) throw fail('Grok Bot did not return a usable shared conversation id.');
    return id;
  }

  async function startSharedPrompt(profile, agentId, prompt) {
    const baseline = await transcriptBaseline(profile, agentId);
    const nonce = randomUUID();
    const accepted = await command(profile, 'sendPrompt', { prompt, agentId, clientNonce: nonce });
    if (!accepted || accepted.accepted !== true) throw fail('Grok Bot did not accept the shared message.');
    return { nonce, baseline, started: now(), agentId };
  }

  async function pollSharedPrompt(profile, run, timeoutMs = 3 * 60 * 1000) {
    let acceptance = null;
    try {
      acceptance = await command(profile, 'promptAcceptanceStatus', { accountSlot: 'host', clientNonce: run.nonce, agentId: run.agentId });
    } catch (error) { if (error.status !== 404) throw error; }
    let entries = [];
    try {
      const tail = await command(profile, 'getAgentTranscriptTail', { id: run.agentId, limit: 80 });
      entries = entriesOf(tail);
    } catch (error) { if (error.status !== 404) throw error; }
    const output = repliesAfter(entries, run.baseline).slice(0, 16000);
    if (acceptance?.outcome === 'found' && acceptance.record?.status === 'rejected' && !output) return { status: 'failed', output: '', error: 'Grok Bot rejected the shared message.' };
    if (output) return { status: 'completed', output };
    const age = now() - (Number(run.started) || 0);
    if (age >= timeoutMs) return { status: 'failed', output: '', error: 'Grok Bot did not reply before the shared-turn time limit.' };
    let agents = [];
    try { agents = await command(profile, 'listAgents', {}); } catch (error) { if (error.status !== 404) throw error; }
    const agent = Array.isArray(agents) ? agents.find(item => item && item.id === run.agentId) : null;
    const pending = acceptance?.outcome === 'found' && acceptance.record?.status === 'pending';
    const missing = !acceptance || acceptance.outcome === 'not-found' || acceptance.outcome === 'unknown-durability';
    if (pending || (missing && age < acceptanceGraceMs)) return { status: 'running', output: '' };
    if (approvalFrom(agent, entries)) return { status: 'waiting_for_approval', output: '', error: 'Grok Bot is waiting for a tool approval. Stop this turn or resolve it from a Grok Bot chat.' };
    return { status: 'running', output: '' };
  }

  async function stopSharedPrompt(profile, agentId) {
    await command(profile, 'interruptAgentRun', { id: agentId });
  }

  async function archiveSharedAgent(profile, agentId) {
    if (!validSessionId(agentId)) throw fail('Grok Bot subagent id is not usable.', 400);
    try {
      await command(profile, 'archiveAgent', { id: agentId });
      return { archived: true };
    } catch (error) {
      if (error.status === 404) return { archived: false, note: 'Grok Bot has no archive for this subagent.' };
      throw error;
    }
  }

  async function previewSession(profile, sessionId) {
    try {
      const tail = await command(profile, 'getAgentTranscriptTail', { id: sessionId, limit: 80 });
      return { messages: sanitizeHistory(historyFromEntries(entriesOf(tail))), resumable: true };
    } catch (error) {
      if (error.status === 404) return { messages: [], resumable: false, note: 'This Grok Bot conversation cannot be resumed from here.' };
      throw error;
    }
  }

  async function compactSession(reply, res, scope) {
    return guard(reply, res, () => compactBody(reply, res, scope));
  }

  async function forkSession(reply, res, scope) {
    return guard(reply, res, () => forkBody(reply, res, scope));
  }

  async function forkBody(reply, res, { body, target, revision, profileId, shared, conversations, seed, summary, sourceSession, cross }) {
    const current = shared.read(body.workspace_id, body.pane_id);
    if (!current || current.binding_revision !== revision || current.session !== body.session_id || current.profile_id !== profileId || current.run) return reply(res, 409, { error: 'Conversation changed or is still running.' });
    const created = await command(target, 'createAgent', {
      name: `Fork ${String(sourceSession).slice(-12)}`.slice(0, 80),
      description: String(summary || '').slice(0, 500),
      isIntroductionSuppressed: true,
    });
    const targetId = created?.agent?.id;
    if (!validSessionId(targetId)) return reply(res, 502, { error: 'Grok Bot did not return a usable conversation id.' });
    const nonce = randomUUID();
    const runId = `run_${randomUUID().replaceAll('-', '')}`;
    const accepted = await command(target, 'sendPrompt', { prompt: String(seed || '').slice(0, 16000), agentId: targetId, clientNonce: nonce });
    if (!accepted || accepted.accepted !== true) return reply(res, 502, { error: 'Grok Bot did not accept the forked summary.' });
    remember({ runId, nonce, agentId: targetId, profileId: target.id, status: 'running', started: now(), baseline: baselineFrom([]) });
    const title = `Fork of ${String(sourceSession).slice(-12)}`.slice(0, 100);
    try { conversations.write({ workspace_id: body.workspace_id, profile_id: target.id, session_id: targetId }, 0, { title }); } catch { /* the pane title still shows the fork */ }
    const state = shared.write(body.workspace_id, body.pane_id, {
      session: targetId,
      profile_id: target.id,
      binding_revision: revision + 1,
      run: runId,
      title,
      messages: [{ role: 'assistant', text: `${cross ? 'Forked across providers' : 'Forked'} into a new Grok Bot agent. Previous session ${sourceSession} stays in history.\n\n${summary}` }],
    });
    return reply(res, 200, {
      state,
      strategy: cross ? 'cross-provider-fork' : 'fork',
      previous_session_id: sourceSession,
      session_id: targetId,
      summary,
      note: `Grok Bot is continuing in ${targetId}. The original session stays in history.`,
    });
  }

  async function compactBody(reply, res, { body, target, revision, profileId, shared, conversations }) {
    if (body.confirm !== true) return reply(res, 400, { error: 'Confirm compact before starting a fresh Grok Bot agent.' });
    const current = shared.read(body.workspace_id, body.pane_id);
    if (!current || current.binding_revision !== revision || current.session !== body.session_id || current.profile_id !== profileId || current.run) return reply(res, 409, { error: 'Conversation changed or is still running.' });
    let entries = [];
    try {
      const tail = await command(target, 'getAgentTranscriptTail', { id: body.session_id, limit: 80 });
      entries = entriesOf(tail);
    } catch (error) { if (error.status !== 404) throw error; }
    const history = sanitizeHistory(historyFromEntries(entries));
    const summary = summarizeTranscript(history.map(item => ({ role: item.role, text: item.text })));
    const previous = body.session_id;
    const created = await command(target, 'createAgent', {
      name: `Compact ${String(previous).slice(-12)}`.slice(0, 80),
      description: summary.slice(0, 500),
      isIntroductionSuppressed: true,
    });
    const targetId = created?.agent?.id;
    if (!validSessionId(targetId)) return reply(res, 502, { error: 'Grok Bot did not return a usable conversation id.' });
    const nonce = randomUUID();
    const runId = `run_${randomUUID().replaceAll('-', '')}`;
    const seed = `This conversation continues compacted session ${previous}.\n\n${summary}\n\nContinue from this summary.`;
    const accepted = await command(target, 'sendPrompt', { prompt: seed.slice(0, 16000), agentId: targetId, clientNonce: nonce });
    if (!accepted || accepted.accepted !== true) return reply(res, 502, { error: 'Grok Bot did not accept the compact summary.' });
    remember({ runId, nonce, agentId: targetId, profileId: target.id, status: 'running', started: now(), baseline: baselineFrom([]) });
    const title = `Continued from ${String(previous).slice(-12)}`.slice(0, 100);
    try { conversations.write({ workspace_id: body.workspace_id, profile_id: target.id, session_id: targetId }, 0, { title }); } catch { /* display title is also on the pane */ }
    const state = shared.write(body.workspace_id, body.pane_id, {
      session: targetId,
      profile_id: target.id,
      binding_revision: revision + 1,
      run: runId,
      title,
      messages: [{ role: 'assistant', text: `Compacted into a new Grok Bot agent. Previous session ${previous} stays in history.\n\n${summary}` }],
    });
    return reply(res, 200, {
      state,
      strategy: 'grok-fresh-agent',
      previous_session_id: previous,
      session_id: targetId,
      summary,
      note: `Grok Bot is continuing in ${targetId}. The previous session remains in history.`,
    });
  }

  return { sessionPage, selectSession, turn, control, surface, events, ensureSharedAgent, startSharedPrompt, pollSharedPrompt, stopSharedPrompt, archiveSharedAgent, compactSession, forkSession, previewSession, createConversation, readTranscript, probe };
}
