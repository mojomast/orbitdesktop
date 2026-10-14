import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomBytes, randomUUID } from 'node:crypto';
import { createPiRpc } from './pi-rpc.mjs';
import { tokenMatches } from './security.mjs';

/**
 * Pi agent gateway.
 *
 * Orbit reaches a gateway provider over loopback with the same command set the
 * Grok Bot host gateway answers: `listAgents`, `createAgent`,
 * `getAgentTranscriptTail`, `sendPrompt`, `promptAcceptanceStatus`,
 * `interruptAgentRun`, `getConversationOutline`, and `GET /events`. This gateway
 * implements that subset on top of a Pi RPC child process per conversation.
 *
 * An Orbit conversation is a Pi session: the agent id is also the Pi session id,
 * so a session survives a gateway restart and Pi keeps its own transcript. The
 * gateway keeps the Orbit-facing transcript (user prompt, assistant text, tool
 * activity) as one bounded JSONL file per conversation; Pi never has to be asked
 * to replay history.
 *
 * Honest limits: Pi runs its own built-in tools with its own permission settings,
 * so this gateway reports no approval inbox. Extension dialogs are cancelled
 * because Orbit has no widget surface for them. Automations and the skills
 * catalog are not part of the Pi harness and answer 404.
 */

const AGENT_ID = /^pi_[a-f0-9]{16}$/;
const SESSION_ID = /^[A-Za-z0-9._-]{1,64}$/;
const NAME_PATTERN = /^[^\u0000-\u001f\u007f]{1,80}$/;
const TOOL_NAME = /^[A-Za-z0-9_.:-]{1,100}$/;
const MAX_PROMPT_CHARS = 100_000;
const MAX_ENTRY_CHARS = 200_000;
const MAX_BODY_BYTES = 1_048_576;
const TAIL_LIMIT = 80;
const MAX_MEMORY_ENTRIES = 600;
const KEEP_FILE_LINES = 2_000;
const TRIM_EVERY_APPENDS = 500;
const HEARTBEAT_MS = 25_000;
const SWEEP_MS = 60_000;

const ACTIVITY_RING = 200;
/** Pi RPC commands Orbit may forward, with the fields each may carry. No bash, delete, or switch_session. */
const CONTROL_COMMANDS = Object.freeze({
  get_state: [],
  get_session_stats: [],
  get_available_models: [],
  set_model: ['provider', 'modelId'],
  get_available_thinking_levels: [],
  set_thinking_level: ['level'],
  compact: ['customInstructions'],
  set_auto_compaction: ['enabled'],
  steer: ['message'],
  follow_up: ['message'],
  clear_queue: [],
  set_steering_mode: ['mode'],
  set_follow_up_mode: ['mode'],
  set_session_name: ['name'],
  get_fork_messages: [],
  fork: ['entryId'],
});

function fail(message, status = 502) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function json(res, status, data) {
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(JSON.stringify(data ?? {}));
}

function readBody(req, limit = MAX_BODY_BYTES) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', chunk => {
      size += chunk.length;
      if (size > limit) {
        reject(fail('Pi gateway request body is too large.', 413));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', () => reject(fail('Pi gateway could not read the request body.', 400)));
  });
}

/** Assistant text from a Pi message: a string body or the text blocks of a content list. */
function assistantText(message) {
  const content = message?.content;
  if (typeof content === 'string') return content.trim();
  if (!Array.isArray(content)) return '';
  return content
    .filter(block => block && block.type === 'text' && typeof block.text === 'string')
    .map(block => block.text)
    .join('')
    .trim();
}

/** Text of a tool result payload, bounded and never a raw object dump. */
function toolText(result) {
  if (typeof result === 'string') return result.slice(0, 8_000);
  const content = result?.content;
  if (Array.isArray(content)) {
    return content
      .filter(block => block && block.type === 'text' && typeof block.text === 'string')
      .map(block => block.text)
      .join('\n')
      .slice(0, 8_000);
  }
  if (typeof result?.text === 'string') return result.text.slice(0, 8_000);
  return '';
}

export function createPiGateway({
  binary = 'pi',
  directory,
  token,
  args = [],
  cwd,
  env = process.env,
  spawnImpl,
  now = () => Date.now(),
  idleMs = 15 * 60 * 1000,
  requestTimeoutMs = 60_000,
  log = () => {},
  /** Hold Pi extension dialogs this long for an Orbit answer before cancelling. 0 keeps the old auto-cancel. */
  dialogHoldMs = Math.max(0, Math.min(Number(process.env.PI_DIALOG_HOLD_MS) || 0, 600_000)),
} = {}) {
  if (typeof token !== 'string' || token.length < 32 || token.length > 256) {
    throw Error('The Pi gateway needs a bearer token of 32 to 256 characters.');
  }
  if (!directory) throw Error('The Pi gateway needs a runtime directory.');
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const sessionDirectory = path.join(directory, 'sessions');
  fs.mkdirSync(sessionDirectory, { recursive: true, mode: 0o700 });
  const storeFile = path.join(directory, 'agents.json');

  /** agent id -> {id, name, sessionId, createdAt, updatedAt} */
  const agents = new Map();
  /** agent id -> {entries, nextSeq, appends} */
  const transcripts = new Map();
  /** agent id -> live Pi session */
  const sessions = new Map();
  /** client nonce -> {nonce, agentId, status, startedAt, error} */
  const runs = new Map();
  const subscribers = new Set();
  let disposed = false;
  /** dialog id -> {agentId, method, timer} while an extension dialog waits for an Orbit answer */
  const pendingDialogs = new Map();
  /** agent id -> recent activity records (ring) for clients that poll instead of streaming */
  const activity = new Map();

  function transcriptFile(id) {
    return path.join(directory, `${id}.jsonl`);
  }

  function loadStore() {
    let parsed;
    try {
      parsed = JSON.parse(fs.readFileSync(storeFile, 'utf8'));
    } catch {
      return;
    }
    for (const row of Array.isArray(parsed?.agents) ? parsed.agents : []) {
      if (!row || typeof row !== 'object') continue;
      const id = String(row.id || '');
      if (!AGENT_ID.test(id) || agents.has(id)) continue;
      const name = String(row.name || '');
      if (!NAME_PATTERN.test(name)) continue;
      const sessionId = SESSION_ID.test(String(row.sessionId || '')) ? String(row.sessionId) : id;
      agents.set(id, {
        id,
        name,
        sessionId,
        createdAt: Number(row.createdAt) || now(),
        updatedAt: Number(row.updatedAt) || now(),
      });
    }
  }

  function persistStore() {
    const rows = [...agents.values()]
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .slice(0, 200)
      .map(agent => ({
        id: agent.id,
        name: agent.name,
        sessionId: agent.sessionId,
        createdAt: agent.createdAt,
        updatedAt: agent.updatedAt,
      }));
    try {
      const temp = `${storeFile}.${process.pid}.tmp`;
      fs.writeFileSync(temp, JSON.stringify({ version: 1, agents: rows }), { mode: 0o600 });
      fs.renameSync(temp, storeFile);
    } catch (error) {
      log(`Pi gateway could not persist its conversation store: ${error instanceof Error ? error.message : 'unknown error'}`);
    }
  }

  function transcriptOf(id) {
    const known = transcripts.get(id);
    if (known) return known;
    const entries = [];
    try {
      for (const line of fs.readFileSync(transcriptFile(id), 'utf8').split('\n')) {
        if (!line.trim()) continue;
        try {
          const entry = JSON.parse(line);
          if (entry && typeof entry === 'object') entries.push(entry);
        } catch {
          /* A partial trailing line after a crash must not drop the rest. */
        }
      }
    } catch {}
    const record = {
      entries,
      nextSeq: entries.reduce((max, entry) => Math.max(max, Number(entry.seq) || 0), 0) + 1,
      appends: 0,
    };
    transcripts.set(id, record);
    return record;
  }

  function writeEntryFile(id, record) {
    try {
      const text = record.entries.map(entry => `${JSON.stringify(entry)}\n`).join('');
      const temp = `${transcriptFile(id)}.${process.pid}.tmp`;
      fs.writeFileSync(temp, text, { mode: 0o600 });
      fs.renameSync(temp, transcriptFile(id));
    } catch (error) {
      log(`Pi gateway could not rewrite a transcript: ${error instanceof Error ? error.message : 'unknown error'}`);
    }
  }

  function appendEntry(id, entry) {
    const record = transcriptOf(id);
    const full = { seq: record.nextSeq++, id: `e_${randomBytes(6).toString('hex')}`, at: new Date(now()).toISOString(), ...entry };
    if (typeof full.content === 'string') full.content = full.content.slice(0, MAX_ENTRY_CHARS);
    record.entries.push(full);
    if (record.entries.length > MAX_MEMORY_ENTRIES) record.entries.splice(0, record.entries.length - MAX_MEMORY_ENTRIES);
    record.appends += 1;
    try {
      if (record.appends % TRIM_EVERY_APPENDS === 0) writeEntryFile(id, record);
      else fs.appendFileSync(transcriptFile(id), `${JSON.stringify(full)}\n`, { mode: 0o600 });
    } catch (error) {
      log(`Pi gateway could not append to a transcript: ${error instanceof Error ? error.message : 'unknown error'}`);
    }
    return full;
  }

  function publish(channel, payload) {
    if (!subscribers.size) return;
    const frame = `data: ${JSON.stringify({ channel, payload })}\n\n`;
    for (const res of subscribers) {
      try {
        if (res.destroyed || res.writableEnded) continue;
        res.write(frame);
      } catch {
        /* A closed live view is not an error. */
      }
    }
  }

  function rememberRun(nonce, agentId) {
    const record = { nonce, agentId, status: 'pending', dispatched: false, startedAt: now(), error: '' };
    runs.set(nonce, record);
    if (runs.size > 400) {
      const oldest = [...runs.values()].sort((a, b) => a.startedAt - b.startedAt)[0];
      if (oldest) runs.delete(oldest.nonce);
    }
    return record;
  }

  function finishRuns(agentId, status, error) {
    for (const run of runs.values()) {
      if (run.agentId !== agentId || run.status !== 'pending') continue;
      run.status = status;
      run.error = error;
    }
  }

  function recordToolEvent(agentId, event) {
    appendEntry(agentId, {
      kind: event.kind,
      name: event.name,
      ...(event.toolCallId ? { toolCallId: event.toolCallId } : {}),
      ...(event.kind === 'tool-call' ? { toolCall: { name: event.name, input: event.input } } : {}),
      ...(event.kind === 'tool-result' ? { output: event.output, isError: event.isError === true } : {}),
    });
    publish('tool', {
      agentId,
      kind: event.kind,
      name: event.name,
      id: event.toolCallId || '',
      ...(event.kind === 'tool-call' ? { input: event.input } : { output: event.output, ...(event.isError ? { error: true } : {}) }),
    });
  }

  /** Pi extension dialogs have no Orbit widget surface, so they are cancelled. */
  function handleExtensionUi(agentId, session, record) {
    const method = String(record.method || '');
    const dialog = ['select', 'confirm', 'input', 'editor'].includes(method);
    if (dialog && dialogHoldMs > 0 && typeof record.id === 'string' && record.id) {
      const id = record.id.slice(0, 200);
      const timer = setTimeout(() => {
        if (!pendingDialogs.delete(id)) return;
        try {
          session.rpc.send({ type: 'extension_ui_response', id, cancelled: true });
        } catch {}
        publish('note', { agentId, kind: 'extension_ui_expired', id, method });
      }, dialogHoldMs);
      timer.unref?.();
      pendingDialogs.set(id, { agentId, method, timer });
      const options = Array.isArray(record.options) ? record.options.slice(0, 50).map(option => String(option).slice(0, 200)) : undefined;
      const detail = { agentId, kind: 'extension_ui_request', id, method, title: String(record.title || '').slice(0, 400), text: String(record.message || '').slice(0, 2_000), ...(options ? { options } : {}), expiresAt: now() + dialogHoldMs };
      remember(agentId, detail);
      publish('approval', detail);
      return;
    }
    if (dialog) {
      try {
        session.rpc.send({ type: 'extension_ui_response', id: record.id, cancelled: true });
      } catch {
        /* A stopped session cannot answer; the extension resolves on its own timeout. */
      }
      appendEntry(agentId, { kind: 'message', role: 'assistant', content: `A Pi extension asked for input (${method}) and Orbit has no widget surface for it, so it was cancelled.` });
    }
    publish('note', { agentId, kind: 'extension_ui', method, text: String(record.title || record.message || '').slice(0, 400) });
  }

  /** Keep a short per-conversation activity ring so a polling client can catch up. */
  function remember(agentId, payload) {
    let ring = activity.get(agentId);
    if (!ring) activity.set(agentId, (ring = { items: [], seq: 0 }));
    ring.items.push({ seq: ++ring.seq, at: now(), ...payload });
    if (ring.items.length > ACTIVITY_RING) ring.items.splice(0, ring.items.length - ACTIVITY_RING);
  }

  /** Content-light forwarding of Pi state events the Activity panel maps (never prompt text). */
  function forwardActivity(agentId, type, record) {
    let payload = null;
    switch (type) {
      case 'agent_settled': payload = { aborted: record.aborted === true }; break;
      case 'thinking_level_changed': payload = { level: String(record.level || '') }; break;
      case 'session_info_changed': payload = { name: typeof record.name === 'string' ? record.name.slice(0, 200) : null }; break;
      case 'queue_update': payload = { steering: Array.isArray(record.steering) ? record.steering.length : 0, followUp: Array.isArray(record.followUp) ? record.followUp.length : 0 }; break;
      case 'compaction_start': payload = { reason: String(record.reason || '') }; break;
      case 'compaction_end': payload = { reason: String(record.reason || ''), aborted: record.aborted === true, willRetry: record.willRetry === true, ...(record.result ? { tokensBefore: Number(record.result.tokensBefore) || 0, estimatedTokensAfter: Number(record.result.estimatedTokensAfter) || 0 } : {}), ...(record.errorMessage ? { error: String(record.errorMessage).slice(0, 400) } : {}) }; break;
      case 'auto_retry_start': payload = { attempt: Number(record.attempt) || 0, maxAttempts: Number(record.maxAttempts) || 0, delayMs: Number(record.delayMs) || 0, error: String(record.errorMessage || '').slice(0, 400) }; break;
      case 'auto_retry_end': payload = { success: record.success === true, attempt: Number(record.attempt) || 0, ...(record.finalError ? { error: String(record.finalError).slice(0, 400) } : {}) }; break;
      case 'summarization_retry_scheduled': case 'summarization_retry_attempt_start': case 'summarization_retry_finished':
        payload = { source: String(record.source || ''), attempt: Number(record.attempt) || 0 }; break;
      case 'turn_end': payload = {}; break;
      default: return;
    }
    const detail = { agentId, kind: type, ...payload };
    remember(agentId, detail);
    publish('activity', detail);
  }

  function onPiEvent(agentId, record) {
    const session = sessions.get(agentId);
    if (!session || !record || typeof record !== 'object') return;
    session.lastUsedAt = now();
    const type = typeof record.type === 'string' ? record.type : '';
    forwardActivity(agentId, type, record);
    if (type === 'message_update' && record.assistantMessageEvent?.type === 'thinking_start') {
      publish('activity', { agentId, kind: 'thinking' });
    }
    if (type === 'extension_ui_request') {
      handleExtensionUi(agentId, session, record);
      return;
    }
    if (type === 'agent_start') {
      session.streaming = true;
      session.settled = false;
      session.buffer = '';
      session.lastError = '';
      publish('run', { agentId, kind: 'agent_start' });
      return;
    }
    if (type === 'message_update') {
      const update = record.assistantMessageEvent;
      if (update?.type === 'text_delta' && typeof update.delta === 'string') {
        session.buffer += update.delta;
        publish('message', { agentId, kind: 'text', text: session.buffer.slice(-4_000) });
      }
      return;
    }
    if (type === 'message_end') {
      if (record.message?.role === 'assistant') {
        const text = assistantText(record.message);
        if (text) session.buffer = text;
      }
      return;
    }
    if (type === 'tool_execution_start') {
      recordToolEvent(agentId, {
        kind: 'tool-call',
        name: TOOL_NAME.test(String(record.toolName || '')) ? record.toolName : 'tool',
        toolCallId: String(record.toolCallId || '').slice(0, 100),
        input: JSON.stringify(record.args ?? {}).slice(0, 4_000),
      });
      return;
    }
    if (type === 'tool_execution_end') {
      recordToolEvent(agentId, {
        kind: 'tool-result',
        name: TOOL_NAME.test(String(record.toolName || '')) ? record.toolName : 'tool',
        toolCallId: String(record.toolCallId || '').slice(0, 100),
        output: toolText(record.result),
        isError: record.isError === true,
      });
      return;
    }
    if (type === 'auto_retry_end' && record.success === false) {
      session.lastError = String(record.finalError || 'Pi retried the turn and kept failing.').slice(0, 400);
      return;
    }
    if (type === 'compaction_end' && record.errorMessage) {
      session.lastError = String(record.errorMessage).slice(0, 400);
      return;
    }
    if (type === 'extension_error') {
      session.lastError = String(record.error || 'A Pi extension failed.').slice(0, 400);
      return;
    }
    if (type === 'agent_settled') {
      // One turn settles once. A repeated settle for the same run would otherwise
      // append a second, misleading "no text reply" entry to the conversation.
      if (session.settled) return;
      session.settled = true;
      const aborted = record.aborted === true;
      session.streaming = false;
      const text = session.buffer.trim();
      const error = session.lastError;
      session.buffer = '';
      session.lastError = '';
      if (text) {
        appendEntry(agentId, { kind: 'message', role: 'assistant', content: text });
        finishRuns(agentId, aborted ? 'cancelled' : 'accepted', '');
      } else if (error) {
        appendEntry(agentId, { kind: 'message', role: 'assistant', content: `Pi could not finish this turn: ${error}` });
        finishRuns(agentId, 'rejected', error);
      } else {
        appendEntry(agentId, {
          kind: 'message',
          role: 'assistant',
          content: aborted ? 'Pi stopped this turn before it produced a reply.' : 'Pi finished this turn without a text reply.',
        });
        finishRuns(agentId, aborted ? 'cancelled' : 'accepted', '');
      }
      publish('run', { agentId, kind: aborted ? 'aborted' : 'settled', text: text.slice(-4_000) });
    }
  }

  function onPiExit(agentId, detail) {
    const session = sessions.get(agentId);
    if (!session) return;
    sessions.delete(agentId);
    session.streaming = false;
    const note = detail?.diagnostics ? ` Pi said: ${String(detail.diagnostics).slice(0, 400)}` : '';
    publish('note', { agentId, kind: 'exit', text: `The Pi process for this conversation stopped.${note}` });
  }

  function spawnArgs(agent) {
    return [...args, '--mode', 'rpc', '--session-dir', sessionDirectory, '--session-id', agent.sessionId, '--name', agent.name];
  }

  async function ensureSession(agent) {
    const existing = sessions.get(agent.id);
    if (existing?.rpc.alive) {
      existing.lastUsedAt = now();
      return existing;
    }
    const session = {
      agentId: agent.id,
      rpc: null,
      streaming: false,
      settled: true,
      buffer: '',
      lastError: '',
      startedAt: now(),
      lastUsedAt: now(),
    };
    session.rpc = createPiRpc({
      binary,
      args: spawnArgs(agent),
      ...(cwd ? { cwd } : {}),
      env,
      ...(spawnImpl ? { spawnImpl } : {}),
      requestTimeoutMs,
      onEvent: record => onPiEvent(agent.id, record),
      onExit: detail => onPiExit(agent.id, detail),
      log,
    });
    sessions.set(agent.id, session);
    let state;
    try {
      state = await session.rpc.request('get_state');
    } catch (error) {
      sessions.delete(agent.id);
      try {
        session.rpc.stop();
      } catch {}
      throw fail(`Pi did not start for this conversation. ${error instanceof Error ? error.message : 'Unknown failure.'}`.slice(0, 400), 502);
    }
    const reported = String(state?.sessionId || '');
    if (SESSION_ID.test(reported) && reported !== agent.sessionId) {
      agent.sessionId = reported;
      persistStore();
    }
    publish('note', {
      agentId: agent.id,
      kind: 'ready',
      text: `Pi is ready in this conversation.`,
      model: typeof state?.model?.id === 'string' ? state.model.id : '',
    });
    return session;
  }

  function touch(agent) {
    agent.updatedAt = now();
    persistStore();
  }

  function createAgent(name) {
    const id = `pi_${randomBytes(8).toString('hex')}`;
    const agent = { id, name, sessionId: id, createdAt: now(), updatedAt: now() };
    agents.set(id, agent);
    persistStore();
    publish('note', { agentId: id, kind: 'created', text: `Pi conversation ${name} created.` });
    return agent;
  }

  async function sendPrompt(agent, prompt, nonce) {
    if (typeof prompt !== 'string' || !prompt.trim() || prompt.length > MAX_PROMPT_CHARS) {
      throw fail(`A Pi prompt must be 1–${MAX_PROMPT_CHARS} characters.`, 400);
    }
    appendEntry(agent.id, { kind: 'message', role: 'user', content: prompt });
    const session = await ensureSession(agent);
    rememberRun(nonce, agent.id);
    touch(agent);
    const fields = session.streaming ? { message: prompt, streamingBehavior: 'steer' } : { message: prompt };
    try {
      await session.rpc.request('prompt', fields);
    } catch (error) {
      const text = error instanceof Error ? error.message.slice(0, 400) : 'Pi rejected the prompt.';
      const run = runs.get(nonce);
      if (run) {
        run.status = 'rejected';
        run.error = text;
      }
      throw fail(`Pi did not accept the message. ${text}`, error?.code === 'PI_TIMEOUT' ? 504 : 502);
    }
    // A dispatched prompt stays pending until the turn settles, aborts, or fails,
    // so `interruptAgentRun` can still mark that same run cancelled.
    const run = runs.get(nonce);
    if (run) run.dispatched = true;
    publish('run', { agentId: agent.id, kind: 'prompt', nonce });
    return { accepted: true, nonce };
  }

  async function interrupt(agent) {
    const session = sessions.get(agent.id);
    if (!session?.rpc.alive) return { ok: true, note: 'This conversation has no running Pi process.' };
    try {
      await session.rpc.request('abort');
    } catch (error) {
      throw fail(`Pi did not stop: ${error instanceof Error ? error.message.slice(0, 200) : 'unknown error'}`, 502);
    }
    finishRuns(agent.id, 'cancelled', '');
    session.streaming = false;
    session.buffer = '';
    publish('run', { agentId: agent.id, kind: 'aborted' });
    return { ok: true };
  }

  function stopSession(id, reason) {
    const session = sessions.get(id);
    if (!session) return;
    sessions.delete(id);
    try {
      session.rpc.stop(fail(reason || 'Pi session stopped.', 'PI_STOPPED'));
    } catch {}
  }

  function sweep() {
    const cutoff = now() - idleMs;
    for (const [id, session] of sessions) {
      if (session.streaming || session.lastUsedAt > cutoff) continue;
      stopSession(id, 'This Pi session was idle and has been released. The conversation is kept.');
    }
  }

  function listAgents() {
    return [...agents.values()]
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .map(agent => ({
        id: agent.id,
        name: agent.name,
        isRunning: sessions.get(agent.id)?.streaming === true,
        isComposingMessage: false,
        updatedAt: agent.updatedAt,
        awaitingUserResponse: null,
      }));
  }

  function transcriptTail(id, limit) {
    const record = transcriptOf(id);
    const size = Number.isSafeInteger(limit) && limit > 0 ? Math.min(limit, MAX_MEMORY_ENTRIES) : TAIL_LIMIT;
    return { entries: record.entries.slice(-size) };
  }

  function outline(id) {
    const entries = transcriptOf(id).entries
      .filter(entry => entry.kind === 'tool-call' || entry.kind === 'tool-result')
      .slice(-200);
    return { items: entries };
  }

  async function command(agentId, body) {
    const agent = agents.get(agentId);
    if (!agent) throw fail('Pi does not have that conversation.', 404);
    return agent;
  }

  /**
   * Send one allowlisted Pi RPC command to this conversation's process (started if
   * idle; starting sends no prompt). Each entry lists the fields it may carry.
   */
  async function piControl(agent, name, rawFields) {
    const allowed = CONTROL_COMMANDS[name];
    if (!allowed) throw fail(`Pi control ${name.slice(0, 40)} is not allowed.`, 400);
    const input = rawFields && typeof rawFields === 'object' && !Array.isArray(rawFields) ? rawFields : {};
    const fields = {};
    for (const key of allowed) if (input[key] !== undefined) fields[key] = input[key];
    const session = await ensureSession(agent);
    try {
      const data = await session.rpc.request(name, fields);
      return { data: data ?? null };
    } catch (error) {
      throw fail(error instanceof Error ? error.message.slice(0, 400) : 'Pi rejected the command.', error?.code === 'PI_TIMEOUT' ? 504 : 409);
    }
  }

  function answerDialog(agentId, wire) {
    const id = String(wire.dialogId || '');
    const pending = pendingDialogs.get(id);
    if (!pending || pending.agentId !== agentId) throw fail('That Pi dialog is no longer waiting.', 410);
    const session = sessions.get(agentId);
    if (!session?.rpc.alive) throw fail('This conversation has no running Pi process.', 409);
    const reply = { type: 'extension_ui_response', id };
    if (wire.cancelled === true) reply.cancelled = true;
    else if (pending.method === 'confirm') reply.confirmed = wire.confirmed === true;
    else if (typeof wire.value === 'string') reply.value = wire.value.slice(0, 20_000);
    else reply.cancelled = true;
    pendingDialogs.delete(id);
    clearTimeout(pending.timer);
    session.rpc.send(reply);
    remember(agentId, { agentId, kind: 'extension_ui_answered', id, method: pending.method });
    return { answered: true };
  }

  async function dispatch(name, body) {
    const wire = body && typeof body === 'object' && !Array.isArray(body) ? body : {};
    switch (name) {
      case 'listAgents':
        return listAgents();
      case 'createAgent': {
        const raw = typeof wire.name === 'string' ? wire.name.trim() : '';
        const name = raw && NAME_PATTERN.test(raw) ? raw : 'Orbit chat';
        const agent = createAgent(name);
        return { agent: { id: agent.id, name: agent.name } };
      }
      case 'getAgentTranscriptTail': {
        await command(String(wire.id || ''), wire);
        return transcriptTail(String(wire.id), Number(wire.limit));
      }
      case 'getConversationOutline': {
        await command(String(wire.id || ''), wire);
        return outline(String(wire.id));
      }
      case 'sendPrompt': {
        const agent = await command(String(wire.agentId || ''), wire);
        const nonce = typeof wire.clientNonce === 'string' && wire.clientNonce.trim() ? wire.clientNonce.trim().slice(0, 100) : randomUUID();
        return sendPrompt(agent, wire.prompt, nonce);
      }
      case 'promptAcceptanceStatus': {
        const nonce = typeof wire.clientNonce === 'string' ? wire.clientNonce : '';
        const run = runs.get(nonce);
        if (!run) return { outcome: 'not-found' };
        if (typeof wire.agentId === 'string' && wire.agentId && wire.agentId !== run.agentId) return { outcome: 'not-found' };
        const status = run.status === 'pending' && run.dispatched ? 'accepted' : run.status;
        return { outcome: 'found', record: { status, agentId: run.agentId, ...(run.error ? { error: run.error } : {}) } };
      }
      case 'interruptAgentRun': {
        const agent = await command(String(wire.id || ''), wire);
        return interrupt(agent);
      }
      case 'archiveAgent': {
        const id = String(wire.id || '');
        const agent = agents.get(id);
        if (!agent) return { archived: false, note: 'Pi has no conversation with that id.' };
        stopSession(id, 'This Pi conversation was archived.');
        agents.delete(id);
        persistStore();
        return { archived: true };
      }
      case 'piControl': {
        const agent = await command(String(wire.id || ''), wire);
        return piControl(agent, String(wire.command || ''), wire.fields);
      }
      case 'piAnswerDialog': {
        await command(String(wire.id || ''), wire);
        return answerDialog(String(wire.id), wire);
      }
      case 'piActivity': {
        await command(String(wire.id || ''), wire);
        const ring = activity.get(String(wire.id));
        const after = Number(wire.after) || 0;
        return { items: ring ? ring.items.filter(item => item.seq > after) : [], seq: ring?.seq || 0 };
      }
      case 'listBoxMcpServers':
        return {
          servers: [
            { serverIdentifier: 'pi-builtin', status: 'connected', statusDetail: 'read, bash, edit, write' },
          ],
        };
      case 'listAllAutomations':
        return [];
      default:
        throw fail(`The Pi gateway has no ${String(name).slice(0, 40)} command.`, 404);
    }
  }

  function events(req, res) {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-store',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write(`data: ${JSON.stringify({ channel: 'note', payload: { kind: 'connected', text: 'Pi live activity connected.' } })}\n\n`);
    subscribers.add(res);
    const heartbeat = setInterval(() => {
      try {
        if (!res.destroyed && !res.writableEnded) res.write(': keep-alive\n\n');
      } catch {}
    }, HEARTBEAT_MS);
    heartbeat.unref?.();
    const done = () => {
      clearInterval(heartbeat);
      subscribers.delete(res);
    };
    req.on('close', done);
    res.on('close', done);
  }

  async function handle(req, res) {
    if (disposed) return json(res, 503, { error: 'The Pi gateway is stopped.' });
    const header = typeof req.headers.authorization === 'string' ? req.headers.authorization : '';
    const provided = header.startsWith('Bearer ') ? header.slice(7) : '';
    if (!tokenMatches(provided, token)) return json(res, 401, { error: 'The Pi gateway request is not authorized.' });
    const url = new URL(typeof req.url === 'string' ? req.url : '/', 'http://127.0.0.1');
    if (req.method === 'GET' && url.pathname === '/events') return events(req, res);
    if (req.method !== 'POST' || !url.pathname.startsWith('/api/')) {
      return json(res, 404, { error: 'The Pi gateway does not serve that route.' });
    }
    const name = url.pathname.slice('/api/'.length);
    if (!/^[A-Za-z]{1,40}$/.test(name)) return json(res, 404, { error: 'The Pi gateway does not serve that command.' });
    let body;
    try {
      const text = await readBody(req);
      body = text ? JSON.parse(text) : {};
    } catch (error) {
      if (error?.status === 413) return json(res, 413, { error: error.message });
      return json(res, 400, { error: 'The Pi gateway needs a JSON body.' });
    }
    try {
      const data = await dispatch(name, body);
      return json(res, 200, data ?? {});
    } catch (error) {
      const status = Number.isInteger(error?.status) ? error.status : 502;
      const message = typeof error?.message === 'string' && error.message.trim() ? error.message.slice(0, 500) : 'The Pi gateway could not complete that request.';
      return json(res, status, { error: message });
    }
  }

  function close() {
    disposed = true;
    for (const id of [...sessions.keys()]) stopSession(id, 'The Pi gateway stopped.');
    for (const res of subscribers) {
      try {
        if (!res.writableEnded) res.end();
      } catch {}
    }
    subscribers.clear();
  }

  loadStore();
  const sweeper = setInterval(sweep, SWEEP_MS);
  sweeper.unref?.();

  return {
    handle,
    close() {
      clearInterval(sweeper);
      close();
    },
    /** Content-free state for logs and tests: never a prompt or a token. */
    describe() {
      return {
        provider: 'pi',
        binary,
        conversations: [...agents.values()].map(agent => ({ id: agent.id, name: agent.name, live: sessions.has(agent.id) })),
      };
    },
    agentCount() {
      return agents.size;
    },
  };
}

/** Start the gateway on a loopback port. The caller owns the token. */
export async function startPiGateway({ port = 0, host = '127.0.0.1', token, ...options } = {}) {
  if (host !== '127.0.0.1' && host !== '::1' && host !== 'localhost') throw Error('The Pi gateway only binds to loopback.');
  const gateway = createPiGateway({ token, ...options });
  const server = http.createServer((req, res) => {
    gateway.handle(req, res).catch(() => {
      try {
        if (!res.headersSent) res.writeHead(502, { 'Content-Type': 'application/json' });
        if (!res.writableEnded) res.end(JSON.stringify({ error: 'The Pi gateway could not complete that request.' }));
      } catch {}
    });
  });
  server.keepAliveTimeout = 65_000;
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, resolve);
  });
  const address = server.address();
  const boundPort = typeof address === 'object' && address ? address.port : port;
  return {
    port: boundPort,
    url: `http://${host}:${boundPort}`,
    token,
    gateway,
    async close() {
      gateway.close();
      await new Promise(resolve => server.close(resolve));
    },
  };
}

/** Standalone host: `node server/pi-gateway.mjs --port 0 --directory DIR --token-file FILE`. */
async function main() {
  const argv = process.argv.slice(2);
  const flag = name => {
    const index = argv.indexOf(name);
    return index >= 0 ? argv[index + 1] : undefined;
  };
  const port = Number(flag('--port') || 0);
  const directory = flag('--directory');
  const tokenFile = flag('--token-file');
  if (!directory) throw Error('The Pi gateway needs --directory.');
  const token = tokenFile ? fs.readFileSync(tokenFile, 'utf8').trim() : process.env.PI_GATEWAY_TOKEN;
  const started = await startPiGateway({
    port: Number.isInteger(port) && port >= 0 ? port : 0,
    token,
    directory,
    ...(flag('--binary') ? { binary: flag('--binary') } : {}),
    ...(flag('--cwd') ? { cwd: flag('--cwd') } : {}),
  });
  process.stdout.write(`${JSON.stringify({ url: started.url, port: started.port })}\n`);
  const shutdown = () => {
    started.close().then(() => process.exit(0));
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  main().catch(error => {
    process.stderr.write(`Pi gateway failed to start: ${error instanceof Error ? error.message : 'unknown error'}\n`);
    process.exit(1);
  });
}
