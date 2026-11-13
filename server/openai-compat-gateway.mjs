import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';

const AGENT_ID = /^[A-Za-z0-9_:-]{1,128}$/;
const CONFIG_ID = /^[A-Za-z0-9_-]{1,64}$/;
const NAME_PATTERN = /^[^\u0000-\u001f\u007f]{1,80}$/;
const ENV_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
const MAX_PROMPT_CHARS = 100_000;
const MAX_ENTRY_CHARS = 200_000;
const MAX_BODY_BYTES = 1_048_576;
const MAX_MEMORY_ENTRIES = 600;
const TAIL_LIMIT = 80;
const HEARTBEAT_MS = 25_000;
const MAX_RUNS = 400;
const SECRET_MARK = '[redacted]';
const STREAM_FALLBACK_STATUSES = new Set([400, 404, 405, 415, 422, 501]);

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
        reject(fail('The gateway request body is too large.', 413));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', () => reject(fail('The gateway could not read the request body.', 400)));
  });
}

function normalizeBaseUrl(value) {
  if (typeof value !== 'string' || !value.trim()) {
    throw Error('The OpenAI-compatible gateway needs an http(s) base URL.');
  }
  let url;
  try {
    url = new URL(value.trim());
  } catch {
    throw Error('The OpenAI-compatible gateway needs a valid http(s) base URL.');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw Error('The OpenAI-compatible gateway base URL must use http or https.');
  }
  if (url.username || url.password) {
    throw Error('The OpenAI-compatible gateway base URL must not contain credentials.');
  }
  if (url.search || url.hash) {
    throw Error('The OpenAI-compatible gateway base URL must not contain a query or fragment.');
  }
  const pathname = url.pathname.replace(/\/+$/, '');
  return `${url.origin}${pathname === '/' ? '' : pathname}`;
}

function textOfContent(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map(part => {
      if (typeof part === 'string') return part;
      if (part && typeof part.text === 'string' && (part.type === 'text' || part.type === undefined)) return part.text;
      return '';
    })
    .join('');
}

function completionText(data) {
  const choice = Array.isArray(data?.choices) ? data.choices[0] : null;
  const fromMessage = textOfContent(choice?.message?.content);
  if (fromMessage) return fromMessage;
  return typeof choice?.text === 'string' ? choice.text : '';
}

function scrubText(value, key) {
  let text = typeof value === 'string' ? value : '';
  if (key) text = text.split(key).join(SECRET_MARK);
  return text.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim().slice(0, 1_000);
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function tokenMatches(value, expected) {
  if (typeof value !== 'string' || value.length > 256) return false;
  const a = Buffer.from(value);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

function safeToken(value) {
  return typeof value === 'string' && value.length > 0 ? value : '';
}

export function createOpenAICompatGateway({
  id = 'openai-compat',
  label = 'OpenAI-compatible',
  baseUrl,
  model,
  apiKeyEnv,
  apiKeyFile,
  fetchImpl = fetch,
  runtimeDir,
  now = () => Date.now(),
  env = process.env,
  token = '',
  requestTimeoutMs = 5 * 60 * 1000,
  log = () => {},
} = {}) {
  const endpoint = normalizeBaseUrl(baseUrl);
  if (typeof runtimeDir !== 'string' || !runtimeDir.trim()) {
    throw Error('The OpenAI-compatible gateway needs a runtime directory.');
  }
  if (typeof id !== 'string' || !CONFIG_ID.test(id)) {
    throw Error('The OpenAI-compatible gateway id must contain only letters, digits, "_" or "-".');
  }
  if (apiKeyEnv !== undefined && (typeof apiKeyEnv !== 'string' || !ENV_PATTERN.test(apiKeyEnv))) {
    throw Error('The OpenAI-compatible gateway apiKeyEnv must be an environment variable name.');
  }
  if (apiKeyFile !== undefined && (typeof apiKeyFile !== 'string' || !path.isAbsolute(apiKeyFile))) {
    throw Error('The OpenAI-compatible gateway apiKeyFile must be an absolute path.');
  }
  if (model !== undefined && (typeof model !== 'string' || !model.trim() || model.length > 200)) {
    throw Error('The OpenAI-compatible gateway model must be a short non-empty string.');
  }
  const configuredLabel = typeof label === 'string' && label.trim() ? label.trim().slice(0, 200) : 'OpenAI-compatible';
  const configuredModel = typeof model === 'string' ? model.trim() : '';
  const configuredEnv = typeof apiKeyEnv === 'string' ? apiKeyEnv : '';
  const configuredKeyFile = typeof apiKeyFile === 'string' ? apiKeyFile : '';
  const bearerToken = safeToken(token);
  const directory = path.resolve(runtimeDir);
  const storeFile = path.join(directory, 'agents.json');
  const agents = new Map();
  const transcripts = new Map();
  const runs = new Map();
  const activeByAgent = new Map();
  const subscribers = new Set();
  const listeners = new Set();
  let disposed = false;

  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });

  function transcriptFile(agentId) {
    return path.join(directory, `${agentId}.jsonl`);
  }

  function loadStore() {
    let parsed;
    try {
      const stat = fs.statSync(storeFile);
      if (stat.isFile()) {
        try {
          fs.chmodSync(storeFile, 0o600);
        } catch {}
        parsed = JSON.parse(fs.readFileSync(storeFile, 'utf8'));
      }
    } catch {
      return;
    }
    for (const row of Array.isArray(parsed?.agents) ? parsed.agents : []) {
      if (!row || typeof row !== 'object') continue;
      const agentId = String(row.id || '');
      if (!AGENT_ID.test(agentId) || agents.has(agentId)) continue;
      const name = String(row.name || '');
      if (!NAME_PATTERN.test(name)) continue;
      agents.set(agentId, {
        id: agentId,
        name,
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
        createdAt: agent.createdAt,
        updatedAt: agent.updatedAt,
      }));
    try {
      const temp = `${storeFile}.${process.pid}.tmp`;
      fs.writeFileSync(temp, JSON.stringify({ version: 1, agents: rows }), { mode: 0o600 });
      fs.renameSync(temp, storeFile);
      try {
        fs.chmodSync(storeFile, 0o600);
      } catch {}
    } catch (error) {
      log(`OpenAI-compatible gateway could not persist its conversation store: ${error instanceof Error ? error.message : 'unknown error'}`);
    }
  }

  function transcriptOf(agentId) {
    const known = transcripts.get(agentId);
    if (known) return known;
    const entries = [];
    const file = transcriptFile(agentId);
    try {
      const stat = fs.statSync(file);
      if (stat.isFile()) {
        try {
          fs.chmodSync(file, 0o600);
        } catch {}
        for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
          if (!line.trim()) continue;
          try {
            const entry = JSON.parse(line);
            if (entry && typeof entry === 'object') entries.push(entry);
          } catch {}
        }
      }
    } catch {}
    const record = {
      entries,
      nextSeq: entries.reduce((max, entry) => Math.max(max, Number(entry.seq) || 0), 0) + 1,
      appends: 0,
    };
    transcripts.set(agentId, record);
    return record;
  }

  function rewriteTranscript(agentId, record) {
    try {
      const file = transcriptFile(agentId);
      const temp = `${file}.${process.pid}.tmp`;
      const text = record.entries.map(entry => `${JSON.stringify(entry)}\n`).join('');
      fs.writeFileSync(temp, text, { mode: 0o600 });
      fs.renameSync(temp, file);
    } catch (error) {
      log(`OpenAI-compatible gateway could not rewrite a transcript: ${error instanceof Error ? error.message : 'unknown error'}`);
    }
  }

  function appendEntry(agentId, entry) {
    const record = transcriptOf(agentId);
    const full = {
      seq: record.nextSeq++,
      id: `e_${randomBytes(6).toString('hex')}`,
      at: new Date(now()).toISOString(),
      ...entry,
    };
    if (typeof full.content === 'string') full.content = full.content.slice(0, MAX_ENTRY_CHARS);
    record.entries.push(full);
    if (record.entries.length > MAX_MEMORY_ENTRIES) record.entries.splice(0, record.entries.length - MAX_MEMORY_ENTRIES);
    record.appends = (record.appends || 0) + 1;
    try {
      if (record.appends % 500 === 0) rewriteTranscript(agentId, record);
      else fs.appendFileSync(transcriptFile(agentId), `${JSON.stringify(full)}\n`, { mode: 0o600 });
    } catch (error) {
      log(`OpenAI-compatible gateway could not append to a transcript: ${error instanceof Error ? error.message : 'unknown error'}`);
    }
    return full;
  }

  function publish(channel, payload) {
    const frame = { channel, payload };
    for (const listener of [...listeners]) {
      try {
        listener(frame);
      } catch {}
    }
    if (!subscribers.size) return;
    const text = `data: ${JSON.stringify(frame)}\n\n`;
    for (const subscriber of [...subscribers]) {
      try {
        if (subscriber.res.destroyed || subscriber.res.writableEnded) continue;
        subscriber.res.write(text);
      } catch {}
    }
  }

  function resolveApiKey() {
    let envKey = '';
    if (configuredEnv) {
      const value = env?.[configuredEnv];
      envKey = typeof value === 'string' ? value.trim() : '';
    }
    if (envKey) return envKey;
    if (configuredKeyFile) {
      let stat;
      try {
        stat = fs.lstatSync(configuredKeyFile);
      } catch {
        throw fail('The API key file could not be read.', 409);
      }
      if (!stat.isFile() || stat.isSymbolicLink()) {
        throw fail('The API key file must be a regular file.', 409);
      }
      if ((stat.mode & 0o077) !== 0) {
        throw fail('The API key file must have 0600 permissions.', 409);
      }
      if (stat.size > 16_384) {
        throw fail('The API key file is too large for a key.', 409);
      }
      let text;
      try {
        text = fs.readFileSync(configuredKeyFile, 'utf8').trim();
      } catch {
        throw fail('The API key file could not be read.', 409);
      }
      if (!text) throw fail('The API key file is empty.', 409);
      return text;
    }
    if (configuredEnv) throw fail(`The API key environment variable ${configuredEnv} is not set.`, 409);
    return '';
  }

  function timeoutSignal() {
    return typeof AbortSignal?.timeout === 'function' ? AbortSignal.timeout(requestTimeoutMs) : undefined;
  }

  function combineSignals(controller) {
    const timeout = timeoutSignal();
    if (!timeout) return { signal: controller.signal, timeout: null };
    if (typeof AbortSignal.any === 'function') return { signal: AbortSignal.any([controller.signal, timeout]), timeout };
    return { signal: controller.signal, timeout };
  }

  async function request(url, { method = 'GET', key = '', body, signal } = {}) {
    const headers = { Accept: body === undefined ? 'application/json' : 'application/json' };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (key) headers.Authorization = `Bearer ${key}`;
    let response;
    try {
      response = await fetchImpl(url, {
        method,
        headers,
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        ...(signal ? { signal } : {}),
        redirect: 'manual',
      });
    } catch (error) {
      if (error?.status) throw error;
      if (error?.name === 'AbortError' || error?.name === 'TimeoutError') {
        throw fail(`${configuredLabel} did not finish in time.`, 504);
      }
      throw fail(`${configuredLabel} could not reach the configured endpoint.`, 502);
    }
    if (response.status >= 300 && response.status < 400) {
      try {
        await response.body?.cancel?.();
      } catch {}
      throw fail(`${configuredLabel} refused to follow a redirect.`, 502);
    }
    return response;
  }

  async function responseText(response, limit = 65_536) {
    try {
      const text = await response.text();
      return typeof text === 'string' ? text.slice(0, limit) : '';
    } catch {
      try {
        await response.body?.cancel?.();
      } catch {}
      return '';
    }
  }

  async function parseJsonResponse(response, key) {
    const text = await responseText(response, 2_000_000);
    if (!text) return null;
    try {
      return JSON.parse(text);
    } catch {
      throw fail(`${configuredLabel} returned invalid JSON. ${scrubText(text, key)}`.trim(), 502);
    }
  }

  async function upstreamFailure(response, key) {
    const text = await responseText(response);
    let detail = '';
    try {
      const parsed = JSON.parse(text);
      const candidate = parsed?.error?.message ?? parsed?.error ?? parsed?.message;
      if (typeof candidate === 'string') detail = candidate;
      else if (candidate !== undefined) detail = JSON.stringify(candidate);
    } catch {
      detail = text;
    }
    detail = scrubText(detail, key);
    const error = fail(`${configuredLabel} rejected the request.${detail ? ` ${detail}` : ''}`, 502);
    error.upstreamStatus = Number(response.status) || 0;
    return error;
  }

  async function listModelsWithKey(key) {
    const signal = timeoutSignal();
    const response = await request(`${endpoint}/models`, { key, signal });
    if (!response.ok) {
      try {
        await response.body?.cancel?.();
      } catch {}
      throw fail(`${configuredLabel} could not list models (HTTP ${response.status || 502}).`, 502);
    }
    const data = await parseJsonResponse(response, key);
    const rows = Array.isArray(data) ? data : Array.isArray(data?.data) ? data.data : [];
    return rows
      .map(row => (typeof row === 'string' ? row : row?.id))
      .filter(value => typeof value === 'string' && value.trim())
      .map(value => value.trim().slice(0, 200));
  }

  async function listModels() {
    return listModelsWithKey(resolveApiKey());
  }

  async function selectedModel(key) {
    if (configuredModel) return configuredModel;
    const models = await listModelsWithKey(key);
    if (!models.length) throw fail(`${configuredLabel} has no model configured and its endpoint lists no models.`, 409);
    return models[0];
  }

  function historyFor(agentId, prompt) {
    const entries = transcriptOf(agentId).entries
      .filter(entry => entry.kind === 'message' && (entry.role === 'user' || entry.role === 'assistant') && typeof entry.content === 'string' && entry.content.trim())
      .slice(-40);
    return [...entries.map(entry => ({ role: entry.role, content: entry.content })), { role: 'user', content: prompt }];
  }

  function markStarted(run) {
    if (run.started) return;
    run.started = true;
    run.startedAt = now();
    run.start.resolve();
  }

  function touch(agent) {
    agent.updatedAt = now();
    persistStore();
  }

  function finishAccepted(run, agent, text) {
    markStarted(run);
    const content = text.trim() || `${configuredLabel} finished this turn without a text reply.`;
    appendEntry(agent.id, { kind: 'message', role: 'assistant', content });
    run.status = 'accepted';
    run.error = '';
    run.key = '';
    run.partial = '';
    if (activeByAgent.get(agent.id) === run) activeByAgent.delete(agent.id);
    touch(agent);
    publish('message', { agentId: agent.id, kind: 'message', role: 'assistant', text: content.slice(-4_000) });
    publish('run', { agentId: agent.id, kind: 'settled', text: content.slice(-4_000) });
  }

  function finishRejected(run, agent, error) {
    const status = Number.isInteger(error?.status) ? error.status : 502;
    const message = scrubText(`${configuredLabel} could not finish this turn: ${error instanceof Error ? error.message : 'unknown error'}`, run.key);
    appendEntry(agent.id, { kind: 'message', role: 'assistant', content: message });
    run.status = 'rejected';
    run.error = message;
    run.key = '';
    run.partial = '';
    if (activeByAgent.get(agent.id) === run) activeByAgent.delete(agent.id);
    touch(agent);
    publish('run', { agentId: agent.id, kind: 'failed', text: message.slice(-4_000) });
    if (!run.started) {
      run.started = true;
      run.start.reject(fail(message, status));
    }
  }

  function finishCancelled(run, agent) {
    const partial = run.partial.trim();
    const content = partial ? `${partial}\n\n${configuredLabel} stopped this turn.` : `${configuredLabel} stopped this turn.`;
    appendEntry(agent.id, { kind: 'message', role: 'assistant', content });
    run.status = 'cancelled';
    run.error = '';
    run.key = '';
    run.partial = '';
    if (activeByAgent.get(agent.id) === run) activeByAgent.delete(agent.id);
    touch(agent);
    publish('run', { agentId: agent.id, kind: 'aborted', text: content.slice(-4_000) });
    if (!run.started) {
      run.started = true;
      run.start.resolve();
    }
  }

  function processSseData(data, run, state) {
    const trimmed = data.trim();
    if (!trimmed) return;
    if (trimmed === '[DONE]') {
      state.sawData = true;
      state.done = true;
      return;
    }
    let event;
    try {
      event = JSON.parse(trimmed);
    } catch {
      return;
    }
    state.sawData = true;
    if (event?.error) {
      const reason = event.error?.message ?? event.error;
      throw fail(`${configuredLabel} reported an error: ${scrubText(typeof reason === 'string' ? reason : JSON.stringify(reason), run.key)}`, 502);
    }
    const choice = Array.isArray(event?.choices) ? event.choices[0] : null;
    const piece = textOfContent(choice?.delta?.content);
    if (!piece) return;
    state.text += piece;
    run.partial = state.text;
    publish('message', { agentId: run.agentId, kind: 'message', role: 'assistant', streaming: true, text: piece.slice(0, 4_000) });
  }

  async function consumeSse(response, run, state) {
    if (!response.body || typeof response.body.getReader !== 'function') {
      throw fail(`${configuredLabel} returned an unreadable stream.`, 502);
    }
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let newline;
        while ((newline = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, newline).replace(/\r$/, '');
          buffer = buffer.slice(newline + 1);
          if (line.startsWith('data:')) processSseData(line.slice(5), run, state);
        }
      }
      buffer += decoder.decode();
      if (buffer.trim()) {
        const line = buffer.replace(/\r$/, '');
        if (line.startsWith('data:')) processSseData(line.slice(5), run, state);
      }
    } finally {
      try {
        reader.releaseLock?.();
      } catch {}
    }
  }

  async function streamCompletion(run, messages, modelName, key) {
    const { signal } = combineSignals(run.controller);
    const response = await request(`${endpoint}/chat/completions`, {
      method: 'POST',
      key,
      signal,
      body: { model: modelName, messages, stream: true },
    });
    if (!response.ok) {
      const error = await upstreamFailure(response, key);
      error.fallback = STREAM_FALLBACK_STATUSES.has(Number(response.status));
      throw error;
    }
    const contentType = String(response.headers?.get?.('content-type') || '');
    if (!/text\/event-stream/i.test(contentType)) {
      const data = await parseJsonResponse(response, key);
      markStarted(run);
      return { kind: 'json', text: completionText(data) };
    }
    markStarted(run);
    const state = { text: '', sawData: false, done: false };
    await consumeSse(response, run, state);
    return { kind: 'sse', ...state };
  }

  async function nonStreamCompletion(run, messages, modelName, key) {
    const { signal } = combineSignals(run.controller);
    const response = await request(`${endpoint}/chat/completions`, {
      method: 'POST',
      key,
      signal,
      body: { model: modelName, messages, stream: false },
    });
    if (!response.ok) throw await upstreamFailure(response, key);
    const data = await parseJsonResponse(response, key);
    markStarted(run);
    return { text: completionText(data) };
  }

  async function executeRun(run, agent, messages) {
    try {
      const key = resolveApiKey();
      run.key = key;
      const modelName = await selectedModel(key);
      let text = '';
      try {
        const streamed = await streamCompletion(run, messages, modelName, key);
        if (streamed.kind === 'sse' && !streamed.sawData) {
          text = (await nonStreamCompletion(run, messages, modelName, key)).text;
        } else {
          text = streamed.text;
        }
      } catch (error) {
        if (error?.fallback) text = (await nonStreamCompletion(run, messages, modelName, key)).text;
        else throw error;
      }
      if (run.status === 'cancelled' || run.controller.signal.aborted) finishCancelled(run, agent);
      else finishAccepted(run, agent, text);
    } catch (error) {
      if (run.status === 'cancelled' || run.controller.signal.aborted) finishCancelled(run, agent);
      else finishRejected(run, agent, error);
    }
  }

  function createAgent(input) {
    const raw = typeof input === 'string' ? input : input?.name;
    let name = 'Orbit chat';
    if (typeof raw === 'string' && raw.trim()) {
      const candidate = raw.trim();
      if (!NAME_PATTERN.test(candidate)) throw fail('A conversation name must be 1-80 characters with no control characters.', 400);
      name = candidate;
    }
    const agentId = `oai_${randomBytes(8).toString('hex')}`;
    const agent = { id: agentId, name, createdAt: now(), updatedAt: now() };
    agents.set(agentId, agent);
    persistStore();
    publish('note', { agentId, kind: 'created', text: `${configuredLabel} conversation ${name} created.` });
    return { agent: { id: agentId, name } };
  }

  function agentById(value) {
    const agentId = typeof value === 'string' ? value : value?.id;
    const agent = agents.get(String(agentId || ''));
    if (!agent) throw fail(`${configuredLabel} does not have that conversation.`, 404);
    return agent;
  }

  async function sendPrompt(input, promptArg, nonceArg) {
    const wire = typeof input === 'string' ? { agentId: input, prompt: promptArg, clientNonce: nonceArg } : (input || {});
    const agent = agentById(wire.agentId);
    const prompt = typeof wire.prompt === 'string' ? wire.prompt : '';
    if (!prompt.trim() || prompt.length > MAX_PROMPT_CHARS) {
      throw fail(`An ${configuredLabel} prompt must be 1-${MAX_PROMPT_CHARS} characters.`, 400);
    }
    if (activeByAgent.has(agent.id)) throw fail(`${configuredLabel} is already working in this conversation.`, 409);
    const nonce = typeof wire.clientNonce === 'string' && wire.clientNonce.trim()
      ? wire.clientNonce.trim().slice(0, 100)
      : randomUUID();
    const messages = historyFor(agent.id, prompt);
    appendEntry(agent.id, { kind: 'message', role: 'user', content: prompt });
    const run = {
      nonce,
      agentId: agent.id,
      status: 'pending',
      controller: new AbortController(),
      start: deferred(),
      started: false,
      startedAt: now(),
      error: '',
      key: '',
      partial: '',
    };
    runs.set(nonce, run);
    if (runs.size > MAX_RUNS) {
      const oldest = [...runs.values()].sort((a, b) => a.startedAt - b.startedAt)[0];
      if (oldest && oldest.nonce !== nonce) runs.delete(oldest.nonce);
    }
    activeByAgent.set(agent.id, run);
    touch(agent);
    publish('run', { agentId: agent.id, kind: 'prompt', nonce });
    void executeRun(run, agent, messages);
    await run.start.promise;
    return { accepted: true, nonce };
  }

  function interruptAgentRun(input) {
    const agent = agentById(input);
    const run = activeByAgent.get(agent.id);
    if (!run) return { ok: true, note: 'This conversation is not running.' };
    run.status = 'cancelled';
    try {
      run.controller.abort();
    } catch {}
    publish('run', { agentId: agent.id, kind: 'aborted' });
    return { ok: true };
  }

  function getAgentTranscriptTail(input, limitArg) {
    const wire = input && typeof input === 'object' ? input : { id: input, limit: limitArg };
    const agent = agentById(wire.id);
    const requested = Number(wire.limit);
    const size = Number.isSafeInteger(requested) && requested > 0 ? Math.min(requested, MAX_MEMORY_ENTRIES) : TAIL_LIMIT;
    return { entries: transcriptOf(agent.id).entries.slice(-size) };
  }

  function promptAcceptanceStatus(input) {
    const wire = input && typeof input === 'object' ? input : {};
    const nonce = typeof wire.clientNonce === 'string' ? wire.clientNonce : '';
    const run = runs.get(nonce);
    if (!run) return { outcome: 'not-found' };
    if (typeof wire.agentId === 'string' && wire.agentId && wire.agentId !== run.agentId) return { outcome: 'not-found' };
    return { outcome: 'found', record: { status: run.status, agentId: run.agentId, ...(run.error ? { error: run.error } : {}) } };
  }

  function listAgents() {
    return [...agents.values()]
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .map(agent => ({
        id: agent.id,
        name: agent.name,
        isRunning: activeByAgent.has(agent.id),
        isComposingMessage: false,
        updatedAt: agent.updatedAt,
        awaitingUserResponse: null,
      }));
  }

  function archiveAgent(input) {
    const agentId = typeof input === 'string' ? input : input?.id;
    const agent = agents.get(String(agentId || ''));
    if (!agent) return { archived: false, note: `${configuredLabel} has no conversation with that id.` };
    const active = activeByAgent.get(agent.id);
    if (active) {
      active.status = 'cancelled';
      try {
        active.controller.abort();
      } catch {}
      activeByAgent.delete(agent.id);
    }
    agents.delete(agent.id);
    transcripts.delete(agent.id);
    try {
      fs.rmSync(transcriptFile(agent.id), { force: true });
    } catch {}
    persistStore();
    return { archived: true };
  }

  function capabilities() {
    return {
      streaming: true,
      nonStreamingFallback: true,
      models: true,
      transcripts: true,
      interrupt: true,
      approvals: false,
      tools: false,
      skills: false,
      automations: false,
      collab: true,
      buildQueue: false,
      projectWorkbench: false,
    };
  }

  function describe() {
    return {
      provider: 'openai-compat',
      id,
      label: configuredLabel,
      model: configuredModel || null,
      hasKey: Boolean(configuredEnv || configuredKeyFile),
      conversations: agents.size,
    };
  }

  function events(req, res) {
    if (typeof req === 'function') {
      listeners.add(req);
      return () => listeners.delete(req);
    }
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-store',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write(`data: ${JSON.stringify({ channel: 'note', payload: { kind: 'connected', text: `${configuredLabel} live activity connected.` } })}\n\n`);
    const subscriber = { res, done: null };
    const heartbeat = setInterval(() => {
      try {
        if (!res.destroyed && !res.writableEnded) res.write(': keep-alive\n\n');
      } catch {}
    }, HEARTBEAT_MS);
    heartbeat.unref?.();
    subscriber.done = () => {
      clearInterval(heartbeat);
      subscribers.delete(subscriber);
    };
    subscribers.add(subscriber);
    req.on?.('close', subscriber.done);
    res.on?.('close', subscriber.done);
    return subscriber.done;
  }

  async function dispatch(name, wire) {
    switch (name) {
      case 'listAgents':
        return listAgents();
      case 'createAgent':
        return createAgent(wire);
      case 'sendPrompt':
        return sendPrompt(wire);
      case 'getAgentTranscriptTail':
        return getAgentTranscriptTail(wire);
      case 'promptAcceptanceStatus':
        return promptAcceptanceStatus(wire);
      case 'interruptAgentRun':
        return interruptAgentRun(wire);
      case 'getConversationOutline':
        agentById(wire.id);
        return { items: [] };
      case 'listModels':
        return { models: await listModels() };
      case 'capabilities':
        return capabilities();
      case 'listBoxMcpServers':
        return { servers: [] };
      case 'listAllAutomations':
        return [];
      case 'archiveAgent':
        return archiveAgent(wire);
      default:
        throw fail(`The OpenAI-compatible gateway has no ${String(name).slice(0, 40)} command.`, 404);
    }
  }

  async function handle(req, res) {
    if (disposed) return json(res, 503, { error: 'The OpenAI-compatible gateway is stopped.' });
    if (bearerToken) {
      const header = typeof req.headers.authorization === 'string' ? req.headers.authorization : '';
      const provided = header.startsWith('Bearer ') ? header.slice(7) : '';
      if (!tokenMatches(provided, bearerToken)) return json(res, 401, { error: 'The gateway request is not authorized.' });
    }
    const url = new URL(typeof req.url === 'string' ? req.url : '/', 'http://127.0.0.1');
    if (req.method === 'GET' && url.pathname === '/events') return events(req, res);
    if (req.method !== 'POST' || !url.pathname.startsWith('/api/')) {
      return json(res, 404, { error: 'The OpenAI-compatible gateway does not serve that route.' });
    }
    const name = url.pathname.slice('/api/'.length);
    if (!/^[A-Za-z]{1,40}$/.test(name)) return json(res, 404, { error: 'The OpenAI-compatible gateway does not serve that command.' });
    let body;
    try {
      const text = await readBody(req);
      body = text ? JSON.parse(text) : {};
    } catch (error) {
      if (error?.status === 413) return json(res, 413, { error: error.message });
      return json(res, 400, { error: 'The gateway needs a JSON body.' });
    }
    try {
      return json(res, 200, (await dispatch(name, body)) ?? {});
    } catch (error) {
      const status = Number.isInteger(error?.status) ? error.status : 502;
      const message = scrubText(error instanceof Error && error.message.trim() ? error.message : 'The gateway could not complete that request.', '');
      return json(res, status, { error: message });
    }
  }

  function close() {
    disposed = true;
    for (const run of [...activeByAgent.values()]) {
      run.status = 'cancelled';
      try {
        run.controller.abort();
      } catch {}
    }
    for (const subscriber of [...subscribers]) {
      subscriber.done?.();
      try {
        if (!subscriber.res.writableEnded) subscriber.res.end();
      } catch {}
    }
    subscribers.clear();
    listeners.clear();
  }

  loadStore();

  return {
    id,
    label: configuredLabel,
    model: configuredModel || null,
    baseUrl: endpoint,
    handle,
    events,
    listAgents,
    createAgent,
    sendPrompt,
    getAgentTranscriptTail,
    promptAcceptanceStatus,
    interruptAgentRun,
    getConversationOutline: wire => {
      agentById(wire?.id);
      return { items: [] };
    },
    listModels,
    capabilities,
    archiveAgent,
    describe,
    agentCount() {
      return agents.size;
    },
    close,
  };
}

export async function startOpenAICompatGateway({ port = 0, host = '127.0.0.1', token, ...options } = {}) {
  if (host !== '127.0.0.1' && host !== '::1' && host !== 'localhost') {
    throw Error('The OpenAI-compatible gateway only binds to loopback.');
  }
  const gateway = createOpenAICompatGateway({ ...options, token });
  const server = http.createServer((req, res) => {
    gateway.handle(req, res).catch(() => {
      try {
        if (!res.headersSent) res.writeHead(502, { 'Content-Type': 'application/json' });
        if (!res.writableEnded) res.end(JSON.stringify({ error: 'The gateway could not complete that request.' }));
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
    token: safeToken(token),
    gateway,
    async close() {
      gateway.close();
      await new Promise(resolve => server.close(resolve));
    },
  };
}
