import { randomUUID } from 'node:crypto';
import { validSessionId, sanitizeHistory } from './agent-profiles.mjs';

const runPattern = /^run_[a-zA-Z0-9_-]{8,100}$/;

function fail(message, status = 502) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function lastAssistant(entries) {
  if (!Array.isArray(entries)) return '';
  for (let i = entries.length - 1; i >= 0; i--) {
    const raw = entries[i];
    const entry = raw && typeof raw === 'object' && raw.kind == null && raw.entry ? raw.entry : raw;
    if (!entry || typeof entry !== 'object' || entry.streaming === true) continue;
    if (entry.kind === 'send-message' && entry.message && entry.message.type === 'text' && typeof entry.message.content === 'string' && entry.message.content.trim()) return entry.message.content;
    if ((entry.kind === 'message' || entry.kind == null) && entry.role === 'assistant' && typeof entry.content === 'string' && entry.content.trim()) return entry.content;
  }
  return '';
}

function historyFromEntries(entries) {
  const data = [];
  if (!Array.isArray(entries)) return { data };
  for (const raw of entries) {
    const entry = raw && typeof raw === 'object' && raw.kind == null && raw.entry ? raw.entry : raw;
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

export function createGrokChat({ fetchImpl = fetch } = {}) {
  const runs = new Map();

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

  async function sessionPage(profile, offset = 0) {
    if (offset > 0) return { data: [], has_more: false };
    const agents = await command(profile, 'listAgents', {});
    const rows = (Array.isArray(agents) ? agents : []).filter(agent => agent && validSessionId(agent.id));
    return {
      data: rows.slice(0, 100).map(agent => ({
        id: agent.id,
        title: String(agent.name || agent.id).slice(0, 200),
        updated_at: Number.isFinite(agent.updatedAt) ? new Date(agent.updatedAt).toISOString().slice(0, 100) : '',
      })),
      has_more: rows.length > 100,
    };
  }

  function remember(runId, run) {
    runs.set(runId, run);
    if (runs.size > 200) {
      const oldest = [...runs.entries()].sort((a, b) => a[1].started - b[1].started)[0];
      if (oldest) runs.delete(oldest[0]);
    }
  }

  async function selectSession(reply, res, scope) {
    return guard(reply, res, () => selectSessionBody(reply, res, scope));
  }

  async function selectSessionBody(reply, res, { body, target, revision, profileId, shared, validatePane, conversations }) {
    const creating = body.target_session_id === undefined || body.target_session_id === null;
    let targetId = creating ? null : body.target_session_id;
    if (!creating && !validSessionId(targetId)) return reply(res, 400, { error: 'Invalid Grok Bot conversation.' });
    if (!creating && (shared.locks.has(`session:${target.id}:${targetId}`) || shared.hasActive(target.id, targetId, body.workspace_id, body.pane_id))) return reply(res, 409, { error: 'This conversation is already running.' });
    let title;
    let messages = [];
    if (creating) {
      const created = await command(target, 'createAgent', { name: 'Orbit chat', description: '', isIntroductionSuppressed: true });
      targetId = created?.agent?.id;
      if (!validSessionId(targetId)) return reply(res, 502, { error: 'Grok Bot did not return a usable conversation id.' });
      title = typeof created.agent.name === 'string' ? created.agent.name.slice(0, 100) : 'Orbit chat';
    } else {
      const page = await sessionPage(target, 0);
      const found = page.data.find(item => item.id === targetId);
      if (!found) return reply(res, 404, { error: 'Grok Bot conversation not found.' });
      title = found.title.slice(0, 100);
      try {
        const tail = await command(target, 'getAgentTranscriptTail', { id: targetId, limit: 80 });
        const entries = Array.isArray(tail) ? tail : tail?.entries;
        messages = sanitizeHistory(historyFromEntries(entries));
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

  async function turn(reply, res, scope) {
    return guard(reply, res, () => turnBody(reply, res, scope));
  }

  async function turnBody(reply, res, { body, profile, shared, workspaceContext, executionGate }) {
    if (typeof body.input !== 'string' || !body.input.trim() || body.input.length > 100000) return reply(res, 400, { error: 'Enter a message of 1–100,000 characters.' });
    if (!validSessionId(body.session_id)) return reply(res, 400, { error: 'Invalid Grok Bot conversation.' });
    if (executionGate && ((typeof executionGate.busy === 'function' && executionGate.busy('agent')) || executionGate.status?.().job)) return reply(res, 409, { error: 'The shared execution lane is busy or unresolved. Wait for active work or reconcile an unknown outcome before starting a new chat turn.' });
    let context = '';
    if (body.workspace_id && workspaceContext) {
      try { context = String(workspaceContext(body.workspace_id) || '').slice(0, 8000); }
      catch { return reply(res, 409, { error: 'Workspace has not synced yet. Wait for workspace connection and retry.' }); }
    }
    const prompt = context ? `${body.input.trim()}\n\nWorkspace context:\n${context}` : body.input.trim();
    const nonce = randomUUID();
    const runId = `run_${randomUUID().replaceAll('-', '')}`;
    const accepted = await command(profile, 'sendPrompt', { prompt, agentId: body.session_id, clientNonce: nonce });
    if (!accepted || accepted.accepted !== true) {
      const detail = gatewayDetail(JSON.stringify({ error: typeof accepted?.error === 'string' ? accepted.error : typeof accepted?.message === 'string' ? accepted.message : '' }), profile.apiKey);
      return reply(res, 502, { error: detail ? `Grok Bot did not accept the message. ${detail}` : 'Grok Bot did not accept the message.' });
    }
    remember(runId, { nonce, agentId: body.session_id, profileId: profile.id, status: 'running', started: Date.now(), seenBusy: false });
    if (body.pane_id) {
      const current = shared.read(body.workspace_id, body.pane_id);
      if (current) shared.write(body.workspace_id, body.pane_id, { ...current, run: runId, messages: [...(current.messages || []), { role: 'user', text: body.input.trim() }].slice(-100) });
    }
    return reply(res, 202, { run_id: runId, status: 'running' });
  }

  async function transcript(profile, agentId) {
    const tail = await command(profile, 'getAgentTranscriptTail', { id: agentId, limit: 80 });
    const entries = Array.isArray(tail) ? tail : tail?.entries;
    return lastAssistant(entries).slice(0, 16000);
  }

  async function inspect(profile, run) {
    const agents = await command(profile, 'listAgents', {});
    const agent = Array.isArray(agents) ? agents.find(item => item && item.id === run.agentId) : null;
    let acceptance = null;
    try { acceptance = await command(profile, 'promptAcceptanceStatus', { accountSlot: 'host', clientNonce: run.nonce }); }
    catch (error) { if (error.status !== 404) throw error; }
    const busy = Boolean(agent && (agent.isRunning || agent.isComposingMessage));
    if (busy) run.seenBusy = true;
    let tasks = [];
    let subs = [];
    try {
      const value = await command(profile, 'getAsyncTasks', { id: run.agentId });
      tasks = Array.isArray(value) ? value : [];
    } catch (error) { if (error.status !== 404) throw error; }
    try {
      const value = await command(profile, 'getSubagents', { id: run.agentId });
      subs = Array.isArray(value) ? value.filter(item => item && (item.isRunning || item.status === 'running')) : [];
    } catch (error) { if (error.status !== 404) throw error; }
    if (acceptance?.outcome === 'found' && acceptance.record?.status === 'rejected') return { status: 'failed', output: '' };
    const acceptanceBlocking = acceptance && (acceptance.outcome === 'not-found' || (acceptance.outcome === 'found' && acceptance.record?.status === 'pending'));
    if (busy || tasks.length || subs.length || acceptanceBlocking) return { status: 'running', output: '' };
    if (!acceptance && !run.seenBusy && Date.now() - run.started < 8000) return { status: 'running', output: '' };
    const output = await transcript(profile, run.agentId);
    return { status: 'completed', output: output || (agent?.awaitingUserResponse ? 'Grok Bot is waiting for a reply.' : '') };
  }

  function finishPane(shared, body, profile, runId, output) {
    if (!body.pane_id) return;
    const current = shared.read(body.workspace_id, body.pane_id);
    if (current?.run === runId && current.session === body.session_id && current.profile_id === profile.id) {
      shared.write(body.workspace_id, body.pane_id, { ...current, run: undefined, messages: [...current.messages, { role: 'assistant', text: output || 'Run completed.' }].slice(-100) });
    }
  }

  async function control(reply, res, scope) {
    return guard(reply, res, () => controlBody(reply, res, scope));
  }

  async function controlBody(reply, res, { body, profile, shared }) {
    if (!runPattern.test(body.run_id || '')) return reply(res, 400, { error: 'Invalid run.' });
    const run = runs.get(body.run_id);
    if (!run || run.agentId !== body.session_id || run.profileId !== profile.id) return reply(res, 404, { error: 'Run not found in this Orbit conversation.' });
    if (body.action === 'steer') return reply(res, 409, { error: 'Grok Bot does not accept mid-run guidance. Wait for this turn to finish, or stop it, then send a new message.' });
    if (body.action === 'approval') return reply(res, 409, { error: 'Answer Grok Bot from the composer. This provider does not use Hermes tool approvals.' });
    if (body.action === 'stop') {
      await command(profile, 'interruptAgentRun', { id: run.agentId });
      run.status = 'cancelled';
      finishPane(shared, body, profile, body.run_id, 'Run cancelled.');
      runs.delete(body.run_id);
      return reply(res, 200, { status: 'stopping' });
    }
    const view = await inspect(profile, run);
    if (view.status === 'running') return reply(res, 200, { run_id: body.run_id, status: 'running', output: '', approvals: [] });
    if (view.status === 'failed') {
      finishPane(shared, body, profile, body.run_id, 'Grok Bot rejected the message.');
      runs.delete(body.run_id);
      return reply(res, 200, { run_id: body.run_id, status: 'failed', output: '', error: 'Grok Bot rejected the message.' });
    }
    finishPane(shared, body, profile, body.run_id, view.output);
    runs.delete(body.run_id);
    return reply(res, 200, { run_id: body.run_id, status: 'completed', output: view.output, approvals: [] });
  }

  return { sessionPage, selectSession, turn, control };
}
