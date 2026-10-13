import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

const runPattern = /^run_[a-zA-Z0-9_-]{8,100}$/;
const taskPattern = /^d_[a-z0-9]{8,32}$/;
const speakers = ['hermes', 'grok'];
const labels = { owner: 'Kyle', hermes: 'Hermes', grok: 'Grok Bot', note: 'Orbit' };
const MAX_DEPTH = 2;
const MAX_TASKS = 8;
const MAX_AGENT_STREAK = 20;
const DELEGATION_TIMEOUT_MS = 3 * 60 * 1000;
const DEFAULT_TURN_TIMEOUT_MS = 3 * 60 * 1000;
const DEFAULT_ADVANCE_INTERVAL_MS = 15 * 1000;
const HOLD_ACTIVITY = 'Paused. Continue when you want the agents to keep going.';

/** Shared-room turn limit. `ORBIT_SHARED_TURN_TIMEOUT_MS` overrides the 3 minute default. */
export function sharedTurnTimeoutMs(env = process.env) {
  const raw = Number(env?.ORBIT_SHARED_TURN_TIMEOUT_MS);
  if (Number.isFinite(raw) && raw >= 1000 && raw <= 30 * 60 * 1000) return Math.floor(raw);
  return DEFAULT_TURN_TIMEOUT_MS;
}

function fail(message, status = 502) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function other(speaker) {
  return speaker === 'hermes' ? 'grok' : 'hermes';
}

function paneKey(body) {
  if (!/^[a-f0-9-]{36}$/.test(body.workspace_id || '') || !/^[a-f0-9-]{36}$/.test(body.pane_id || '')) throw fail('Open shared agents from an agent pane.', 400);
  return `${body.workspace_id}.${body.pane_id}`;
}

function blank(key) {
  return {
    key,
    messages: [],
    next: 'hermes',
    auto: false,
    maxTurns: 4,
    turns: 0,
    paused: false,
    hold: false,
    agentStreak: 0,
    floorMark: 0,
    lastAddressed: '',
    queue: [],
    activity: '',
    hermesSession: `orbit-${randomUUID()}`,
    grokAgentId: '',
    run: null,
    delegations: [],
  };
}

function transcriptTail(messages) {
  const lines = messages.filter(message => message.speaker !== 'note').slice(-30).map(message => `${labels[message.speaker] || 'Orbit'}: ${message.text}`).join('\n\n');
  return lines.slice(-12000);
}

function preamble(speaker) {
  const name = labels[speaker];
  const partner = labels[other(speaker)];
  const target = other(speaker);
  return `You are ${name} in a three-way chat with Kyle and ${partner}. Kyle is the owner. Reply only as ${name}. Do not write lines for Kyle or ${partner}. Use plain text.

Stay quiet unless Kyle or ${partner} addressed you, or you genuinely have something useful to add. If you have nothing to add, reply with exactly (quiet).

Address ${partner} as @${target} when you want them to respond. Use @all to hand the floor to everyone else. Address Kyle as @kyle. The conversation stops when you do not hand the floor to someone.

To delegate a task to ${partner}, end your reply with one fenced block exactly like this:

\`\`\`delegate
target: ${target}
task: what ${partner} should do
context: optional details
\`\`\`

Orbit gives that task to ${partner} through that agent's gateway and posts the result back here and to you. Delegate only to ${partner}. A chain may be at most ${MAX_DEPTH} delegations deep, and this conversation keeps at most ${MAX_TASKS} delegated tasks. If a tool needs approval, use your normal tool-approval flow; the owner resolves it on the agent that is executing.`;
}

/** @hermes, @grok, and @all. An email local-part does not count. */
export function mentionedAgents(text) {
  const found = { hermes: false, grok: false, all: false };
  for (const match of String(text || '').matchAll(/(^|[^A-Za-z0-9_])@(hermes|grok|all)\b/gi)) found[match[2].toLowerCase()] = true;
  return found;
}

/** Who should answer a message from Kyle. */
export function routeAddressees(text, lastAddressed = '') {
  const found = mentionedAgents(text);
  if (found.all || (found.hermes && found.grok)) return ['hermes', 'grok'];
  if (found.hermes) return ['hermes'];
  if (found.grok) return ['grok'];
  if (String(text || '').includes('?')) return ['hermes', 'grok'];
  if (lastAddressed === 'hermes' || lastAddressed === 'grok') return [lastAddressed];
  if (lastAddressed === 'all') return ['hermes', 'grok'];
  return ['hermes'];
}

function handoffTargets(speaker, text) {
  const found = mentionedAgents(text);
  if (found.all) return [other(speaker)];
  return ['hermes', 'grok'].filter(target => found[target] && target !== speaker);
}

function isQuiet(text) {
  return /^\(?quiet\)?[.!]?\s*$/i.test(String(text || '').trim());
}

function normalizeUtterance(text) {
  return String(text || '').toLowerCase().replace(/\s+/g, ' ').trim().slice(0, 240);
}

function agentTurnsSinceOwner(messages, floorMark = 0) {
  const visible = messages.slice(Math.max(0, floorMark) || 0);
  let start = 0;
  for (let index = visible.length - 1; index >= 0; index -= 1) {
    if (visible[index].speaker === 'owner') { start = index + 1; break; }
  }
  return visible.slice(start).filter(message => message.speaker === 'hermes' || message.speaker === 'grok');
}

function agentFloorBlocked(state) {
  if (state.agentStreak >= MAX_AGENT_STREAK) return true;
  const recent = agentTurnsSinceOwner(state.messages, state.floorMark || 0);
  const speakersNow = recent.slice(-4).map(message => message.speaker);
  if (speakersNow.length === 4 && speakersNow[0] !== speakersNow[1] && speakersNow[0] === speakersNow[2] && speakersNow[1] === speakersNow[3]) return true;
  const norms = recent.map(message => normalizeUtterance(message.text)).filter(text => text.length >= 24);
  return new Set(norms).size !== norms.length;
}

function promptFor(speaker, messages) {
  return `${preamble(speaker)}

Recent transcript:
${transcriptTail(messages) || '(no messages yet)'}

Reply to the latest message.`;
}

function delegationPrompt(task, messages) {
  const partner = labels[other(task.to)];
  return `${preamble(task.to)}

${labels[task.from]} delegated this task to you. Do the task and reply with the result. You may delegate onward to ${partner} only if the chain is still within ${MAX_DEPTH} steps.

Task:
${task.task}
${task.context ? `\nContext:\n${task.context}\n` : ''}
Recent transcript:
${transcriptTail(messages) || '(no messages yet)'}`;
}

function returnPrompt(task, messages) {
  return `${preamble(task.from)}

${labels[task.to]} finished a task you delegated.
Task: ${task.task}
Result: ${task.result || '(no text)'}

Continue the shared conversation. The result is already in the transcript. Do not repeat a delegate block unless you are delegating a new task within the depth limit.

Recent transcript:
${transcriptTail(messages) || '(no messages yet)'}`;
}

function normalizeTarget(value) {
  const text = String(value || '').trim().toLowerCase();
  if (text === 'hermes') return 'hermes';
  if (text === 'grok' || text === 'grok bot') return 'grok';
  return '';
}

function cleanField(value, max) {
  return String(value || '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max);
}

/** First fenced delegate block in an agent reply. Null when the reply does not delegate. */
export function parseDelegate(text) {
  const match = String(text || '').match(/```delegate[^\n]*\n([\s\S]*?)```/i);
  if (!match) return null;
  const body = match[1].trim();
  let target = '';
  let task = '';
  let context = '';
  if (body.startsWith('{')) {
    try {
      const parsed = JSON.parse(body);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return { error: 'The delegate block must be a JSON object with target and task.' };
      if (parsed.task != null && typeof parsed.task !== 'string') return { error: 'The delegated task must be text.' };
      if (parsed.context != null && typeof parsed.context !== 'string') return { error: 'Delegation context must be text.' };
      target = parsed.target;
      task = parsed.task || '';
      context = parsed.context || '';
    } catch {
      return { error: 'The delegate block is not valid JSON.' };
    }
  } else {
    const fields = {};
    let current = '';
    for (const line of body.split('\n')) {
      const headed = /^(target|task|context)\s*:\s*(.*)$/i.exec(line);
      if (headed) {
        current = headed[1].toLowerCase();
        fields[current] = headed[2];
      } else if (current) fields[current] += `\n${line}`;
    }
    target = fields.target || '';
    task = fields.task || '';
    context = fields.context || '';
  }
  const to = normalizeTarget(target);
  task = cleanField(task, 4000);
  context = cleanField(context, 4000);
  if (!to) return { error: 'Name the other agent as target hermes or grok.' };
  if (!task) return { error: 'A delegated task must be 1–4,000 characters.' };
  return { to, task, context };
}

function publicState(state) {
  return {
    messages: state.messages.map(message => ({ id: message.id, speaker: message.speaker, text: message.text, at: message.at, ...(message.error ? { error: true } : {}) })),
    paused: state.paused,
    hold: state.hold === true,
    running: state.run?.speaker || '',
    activity: state.activity || '',
    delegations: state.delegations.map(task => ({
      id: task.id,
      from: task.from,
      to: task.to,
      task: task.task,
      depth: task.depth,
      status: task.status,
    })),
  };
}

function cleanDelegations(list) {
  if (!Array.isArray(list)) return [];
  const tasks = [];
  for (const raw of list) {
    if (!raw || typeof raw !== 'object' || !taskPattern.test(raw.id || '')) continue;
    if (!speakers.includes(raw.from) || !speakers.includes(raw.to)) continue;
    if (!['pending', 'running', 'done', 'failed'].includes(raw.status)) continue;
    const depth = Number.isInteger(raw.depth) && raw.depth >= 1 && raw.depth <= MAX_DEPTH ? raw.depth : 1;
    tasks.push({
      id: raw.id,
      from: raw.from,
      to: raw.to,
      task: cleanField(raw.task, 4000),
      context: cleanField(raw.context, 4000),
      depth,
      chain: typeof raw.chain === 'string' && taskPattern.test(raw.chain) ? raw.chain : raw.id,
      status: raw.status,
      result: cleanField(raw.result, 4000),
      waitingOn: taskPattern.test(raw.waitingOn || '') ? raw.waitingOn : '',
      needsReturn: raw.needsReturn === true,
      deadline: Number.isFinite(raw.deadline) ? raw.deadline : 0,
    });
  }
  return tasks.slice(-MAX_TASKS);
}

export function createSharedAgents({ directory, fetchImpl = fetch, grok, hermesProfile, grokProfile, now = () => Date.now(), turnTimeoutMs, advanceIntervalMs } = {}) {
  const turnTimeout = Number.isFinite(turnTimeoutMs) && turnTimeoutMs >= 1000 ? Math.floor(turnTimeoutMs) : sharedTurnTimeoutMs();
  const turnTimeoutMinutes = Math.max(1, Math.round(turnTimeout / 60000));
  const advanceEvery = Number.isFinite(advanceIntervalMs) && advanceIntervalMs >= 15 ? Math.floor(advanceIntervalMs) : DEFAULT_ADVANCE_INTERVAL_MS;
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const chains = new Map();

  function fileFor(key) {
    return path.join(directory, `${key}.json`);
  }

  function load(key) {
    try {
      const record = JSON.parse(fs.readFileSync(fileFor(key), 'utf8'));
      if (!record || !Array.isArray(record.messages) || !speakers.includes(record.next)) return blank(key);
      record.key = key;
      record.messages = record.messages.filter(message => message && labels[message.speaker] && typeof message.text === 'string').slice(-200);
      record.auto = record.auto === true;
      record.maxTurns = Number.isInteger(record.maxTurns) && record.maxTurns >= 1 && record.maxTurns <= 8 ? record.maxTurns : 4;
      record.turns = Number.isInteger(record.turns) && record.turns >= 0 ? record.turns : 0;
      record.paused = record.paused === true;
      record.hold = record.hold === true;
      record.agentStreak = Number.isInteger(record.agentStreak) && record.agentStreak >= 0 && record.agentStreak <= 100 ? record.agentStreak : 0;
      record.floorMark = Number.isInteger(record.floorMark) && record.floorMark >= 0 ? record.floorMark : 0;
      record.lastAddressed = ['hermes', 'grok', 'all'].includes(record.lastAddressed) ? record.lastAddressed : '';
      record.queue = cleanQueue(record.queue);
      record.activity = typeof record.activity === 'string' ? record.activity.slice(0, 300) : '';
      record.hermesSession = /^orbit-[0-9a-f-]{36}$/.test(record.hermesSession || '') ? record.hermesSession : `orbit-${randomUUID()}`;
      record.grokAgentId = typeof record.grokAgentId === 'string' ? record.grokAgentId : '';
      record.run = record.run && speakers.includes(record.run.speaker) && typeof record.run.runId === 'string' ? record.run : null;
      if (record.run) {
        record.run.purpose = ['turn', 'delegation', 'return'].includes(record.run.purpose) ? record.run.purpose : 'turn';
        record.run.depth = Number.isInteger(record.run.depth) ? record.run.depth : 0;
        record.run.taskId = typeof record.run.taskId === 'string' ? record.run.taskId : '';
        record.run.chain = typeof record.run.chain === 'string' ? record.run.chain : '';
      }
      record.delegations = cleanDelegations(record.delegations);
      return record;
    } catch (error) {
      if (error.code !== 'ENOENT') throw fail('The shared transcript could not be read.');
      return blank(key);
    }
  }

  function save(state) {
    const dest = fileFor(state.key);
    const temp = `${dest}.${process.pid}.tmp`;
    const record = {
      messages: state.messages.slice(-200),
      next: state.next,
      auto: state.auto,
      maxTurns: state.maxTurns,
      turns: state.turns,
      paused: state.paused,
      hold: state.hold === true,
      agentStreak: state.agentStreak || 0,
      floorMark: state.floorMark || 0,
      lastAddressed: state.lastAddressed || '',
      queue: state.queue || [],
      activity: state.activity || '',
      hermesSession: state.hermesSession,
      grokAgentId: state.grokAgentId || '',
      run: state.run,
      delegations: state.delegations.slice(-MAX_TASKS),
    };
    fs.writeFileSync(temp, JSON.stringify(record), { mode: 0o600 });
    fs.renameSync(temp, dest);
  }

  function append(state, speaker, text, error = false) {
    const clean = String(text || '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, 16000);
    if (!clean) return;
    state.messages.push({ id: `m_${randomUUID().replaceAll('-', '')}`, speaker, text: clean, at: new Date(now()).toISOString(), ...(error ? { error: true } : {}) });
    state.messages = state.messages.slice(-200);
  }

  function cleanQueue(list) {
  if (!Array.isArray(list)) return [];
  const queue = [];
  for (const item of list) {
    const speaker = typeof item === 'string' ? item : item?.speaker;
    if (!speakers.includes(speaker) || queue.some(entry => entry.speaker === speaker)) continue;
    queue.push({ speaker, fromOwner: item?.fromOwner === true });
  }
  return queue.slice(0, 2);
}

function enqueue(state, targets, fromOwner) {
  for (const speaker of targets) {
    if (!speakers.includes(speaker) || state.queue.some(entry => entry.speaker === speaker)) continue;
    state.queue.push({ speaker, fromOwner: fromOwner === true });
  }
}

function rememberAddress(state, text) {
  const found = mentionedAgents(text);
  if (found.all || (found.hermes && found.grok)) state.lastAddressed = 'all';
  else if (found.hermes) state.lastAddressed = 'hermes';
  else if (found.grok) state.lastAddressed = 'grok';
}

function findTask(state, id) {
    return state.delegations.find(task => task.id === id) || null;
  }

  function openTasks(state) {
    return state.delegations.filter(task => task.status === 'pending' || task.status === 'running');
  }

  async function hermes(profile, route, body) {
    let response;
    try {
      response = await fetchImpl(`${profile.apiUrl.replace(/\/$/, '')}${route}`, {
        method: body === undefined ? 'GET' : 'POST',
        headers: { Authorization: `Bearer ${profile.apiKey}`, 'Content-Type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(20000),
        redirect: 'error',
      });
      const text = typeof response?.text === 'function' ? await response.text() : '';
      if (!response || response.ok !== true) throw fail(response?.status === 404 ? 'Hermes can no longer find that run.' : 'Hermes could not complete the shared turn.', response?.status >= 500 ? 502 : (response?.status || 502));
      if (!text) return null;
      try { return JSON.parse(text); }
      catch { throw fail('Hermes returned invalid JSON.'); }
    } catch (error) {
      try { await response?.body?.cancel?.(); } catch {}
      if (error?.status) throw error;
      throw fail('Cannot reach Hermes right now.');
    }
  }

  function hermesView(run) {
    const status = run?.status;
    if (status === 'waiting_for_approval') return { status, error: 'Hermes is waiting for a tool approval. Resolve it in the Hermes chat, or cancel the delegated task.' };
    if (status === 'completed') return { status, output: String(run.output || 'Hermes finished without a text reply.').slice(0, 16000) };
    if (['failed', 'cancelled', 'interrupted'].includes(status)) return { status: 'failed', error: status === 'failed' ? 'Hermes reported a failure.' : `Hermes ${status} this turn.` };
    return { status: 'running' };
  }

  async function begin(state, speaker, meta = {}) {
    const purpose = meta.purpose || 'turn';
    const prompt = meta.prompt || promptFor(speaker, state.messages);
    const instructions = `${preamble(speaker)} Delegate only with the \`\`\`delegate fence.`;
    try {
      if (speaker === 'hermes') {
        const profile = hermesProfile();
        if (!profile?.apiUrl || !profile.apiKey) throw fail('Hermes is not configured on this Orbit server.', 409);
        const data = await hermes(profile, '/v1/runs', { input: prompt, session_id: state.hermesSession, instructions, conversation_history: [] });
        if (!runPattern.test(data?.run_id || '')) throw fail('Hermes did not return a usable run.');
        state.run = { speaker, purpose, taskId: meta.taskId || '', depth: meta.depth || 0, chain: meta.chain || '', runId: data.run_id, started: now() };
      } else {
        const profile = grokProfile();
        if (!profile?.apiUrl || !profile.apiKey) throw fail('Grok Bot is not configured on this Orbit server.', 409);
        state.grokAgentId = await grok.ensureSharedAgent(profile, state.grokAgentId);
        const started = await grok.startSharedPrompt(profile, state.grokAgentId, prompt);
        state.run = { speaker, purpose, taskId: meta.taskId || '', depth: meta.depth || 0, chain: meta.chain || '', runId: `run_${randomUUID().replaceAll('-', '')}`, started: started.started, nonce: started.nonce, baseline: started.baseline, agentId: state.grokAgentId };
      }
      if (purpose === 'turn') state.next = other(speaker);
      state.activity = purpose === 'delegation'
        ? `${labels[speaker]} is working on a delegated task.`
        : purpose === 'return'
          ? `${labels[speaker]} is continuing after a delegated result.`
          : `${labels[speaker]} is replying.`;
    } catch (error) {
      state.run = null;
      state.activity = '';
      const message = error?.message || `${labels[speaker]} could not take a turn.`;
      if (purpose === 'delegation' && meta.task && (meta.task.status === 'pending' || meta.task.status === 'running')) {
        meta.task.status = 'failed';
        meta.task.result = cleanField(message, 4000);
        meta.task.needsReturn = !state.paused;
      } else state.paused = true;
      append(state, speaker, message, true);
    }
  }

  async function poll(state) {
    if (!state.run) return { status: 'idle' };
    if (state.run.speaker === 'hermes') {
      const profile = hermesProfile();
      if (!profile) return { status: 'failed', error: 'Hermes is not configured on this Orbit server.' };
      return hermesView(await hermes(profile, `/v1/runs/${state.run.runId}`));
    }
    const profile = grokProfile();
    if (!profile) return { status: 'failed', error: 'Grok Bot is not configured on this Orbit server.' };
    return grok.pollSharedPrompt(profile, state.run);
  }

  async function stopProvider(state) {
    if (!state.run) return;
    const run = state.run;
    try {
      if (run.speaker === 'hermes') {
        const profile = hermesProfile();
        if (profile) await hermes(profile, `/v1/runs/${run.runId}/stop`, {});
      } else {
        const profile = grokProfile();
        if (profile && run.agentId) await grok.stopSharedPrompt(profile, run.agentId);
      }
    } catch (error) {
      append(state, run.speaker, error?.message || 'Stop request failed.', true);
    }
  }

  function failTask(task, result, state) {
    task.status = 'failed';
    task.waitingOn = '';
    task.result = cleanField(result, 4000);
    task.needsReturn = !state.paused;
  }

  async function expireRunning(state) {
    const run = state.run;
    if (!run) return false;
    if (run.purpose === 'delegation') {
      const task = findTask(state, run.taskId);
      if (!task || task.status !== 'running' || !task.deadline || now() <= task.deadline) return false;
      await stopProvider(state);
      state.run = null;
      state.activity = '';
      failTask(task, 'This delegated task timed out.', state);
      append(state, task.to, 'This delegated task timed out.', true);
      return true;
    }
    const started = Number(run.started) || 0;
    if (!started || now() - started <= turnTimeout) return false;
    await stopProvider(state);
    state.run = null;
    state.activity = '';
    append(state, run.speaker, `${labels[run.speaker]} did not reply within ${turnTimeoutMinutes} minute${turnTimeoutMinutes === 1 ? '' : 's'}, so Orbit stopped that turn.`, true);
    return true;
  }

  function expirePending(state) {
    for (const task of state.delegations) {
      if (task.status !== 'pending' || !task.deadline || now() <= task.deadline) continue;
      failTask(task, 'This delegated task timed out before it started.', state);
      append(state, 'note', `${labels[task.from]} delegated to ${labels[task.to]}, but it timed out before it started.`, true);
    }
  }

  async function startTask(state, task) {
    task.status = 'running';
    await begin(state, task.to, {
      purpose: 'delegation',
      taskId: task.id,
      depth: task.depth,
      chain: task.chain,
      task,
      prompt: delegationPrompt(task, state.messages),
    });
  }

  async function startNextSpeaker(state) {
    if (state.run || state.paused || state.hold) return false;
    while (state.queue.length) {
      const next = state.queue[0];
      if (!next.fromOwner && agentFloorBlocked(state)) {
        state.hold = true;
        state.activity = HOLD_ACTIVITY;
        return false;
      }
      state.queue.shift();
      await begin(state, next.speaker);
      return Boolean(state.run);
    }
    return false;
  }

  async function startQueued(state) {
    if (state.run) return false;
    expirePending(state);
    if (state.paused || state.hold) return false;
    const pending = state.delegations.find(task => task.status === 'pending');
    if (pending) {
      await startTask(state, pending);
      return true;
    }
    const returning = state.delegations.find(task => task.needsReturn && (task.status === 'done' || task.status === 'failed'));
    if (returning) {
      returning.needsReturn = false;
      await begin(state, returning.from, {
        purpose: 'return',
        taskId: returning.id,
        depth: returning.depth,
        chain: returning.chain,
        prompt: returnPrompt(returning, state.messages),
      });
      return true;
    }
    return startNextSpeaker(state);
  }

  async function acceptDelegate(state, speaker, output, run) {
    const parsed = parseDelegate(output);
    if (!parsed) return false;
    if (parsed.error) {
      append(state, 'note', parsed.error);
      return false;
    }
    if (parsed.to === speaker) {
      append(state, 'note', 'Delegation must target the other agent.');
      return false;
    }
    const depth = (run.depth || 0) + 1;
    if (depth > MAX_DEPTH) {
      append(state, 'note', `Delegation stopped at a depth of ${MAX_DEPTH} so the agents do not ping-pong.`);
      return false;
    }
    if (state.delegations.length >= MAX_TASKS) {
      append(state, 'note', `Delegation stopped because this conversation already has ${MAX_TASKS} delegated tasks.`);
      return false;
    }
    const open = openTasks(state);
    const chain = run.chain || '';
    if (open.length && !(chain && open.every(task => task.chain === chain))) {
      append(state, 'note', 'A delegated task is already open. Wait for it, or cancel it, before starting another.');
      return false;
    }
    const id = `d_${randomUUID().replaceAll('-', '').slice(0, 16)}`;
    const task = {
      id,
      from: speaker,
      to: parsed.to,
      task: parsed.task,
      context: parsed.context,
      depth,
      chain: chain || id,
      status: 'pending',
      result: '',
      waitingOn: '',
      needsReturn: false,
      deadline: now() + DELEGATION_TIMEOUT_MS,
    };
    state.delegations.push(task);
    if (!state.paused && !state.run) await startTask(state, task);
    return true;
  }

  function settleParent(state, childId, output) {
    const parent = state.delegations.find(task => task.waitingOn === childId && task.status === 'running');
    if (!parent) return;
    parent.status = 'done';
    parent.waitingOn = '';
    parent.result = cleanField(output, 4000);
    parent.needsReturn = !state.paused;
  }

  async function advance(state) {
    for (let step = 0; step < 4; step += 1) {
      if (!state.run) {
        const started = await startQueued(state);
        if (!state.run) {
          if (!started) return;
          continue;
        }
      }
      if (await expireRunning(state)) continue;
      if (!state.run) continue;
      let view;
      try { view = await poll(state); }
      catch (error) {
        const run = state.run;
        state.run = null;
        state.activity = '';
        const message = error?.message || 'That speaker could not be reached.';
        append(state, run.speaker, message, true);
        if (run.purpose === 'delegation') {
          const task = findTask(state, run.taskId);
          if (task && task.status === 'running') failTask(task, message, state);
          continue;
        }
        state.paused = true;
        return;
      }
      if (view.status === 'running') return;
      if (view.status === 'waiting_for_approval') {
        state.activity = view.error || `${labels[state.run.speaker]} is waiting for a tool approval. Resolve it on that agent, or cancel the delegated task.`;
        if ((state.run.purpose || 'turn') !== 'delegation') state.paused = true;
        return;
      }
      const run = state.run;
      const speaker = run.speaker;
      const purpose = run.purpose || 'turn';
      state.run = null;
      const failed = view.status !== 'completed';
      const output = failed
        ? (view.error || `${labels[speaker]} could not finish this turn.`)
        : (view.output || `${labels[speaker]} finished without a text reply.`);
      append(state, speaker, output, failed);
      state.activity = '';
      if (failed) {
        if (purpose === 'delegation') {
          const task = findTask(state, run.taskId);
          if (task && task.status === 'running') failTask(task, output, state);
          continue;
        }
        state.paused = true;
        return;
      }
      const delegated = await acceptDelegate(state, speaker, output, run);
      if (purpose === 'delegation') {
        const task = findTask(state, run.taskId);
        const child = state.delegations.at(-1);
        if (delegated && task && child && child.id !== task.id && (child.status === 'pending' || child.status === 'running')) task.waitingOn = child.id;
        else if (task && task.status === 'running') {
          task.status = 'done';
          task.result = cleanField(output, 4000);
          task.needsReturn = !state.paused;
        }
        continue;
      }
      if (purpose === 'return') {
        if (!delegated) settleParent(state, run.taskId, output);
        continue;
      }
      if (isQuiet(output)) {
        state.messages.pop();
        continue;
      }
      state.agentStreak += 1;
      if (delegated) continue;
      const handoff = handoffTargets(speaker, output);
      if (handoff.length) {
        rememberAddress(state, output);
        enqueue(state, handoff, false);
        if (agentFloorBlocked(state)) {
          state.hold = true;
          state.activity = HOLD_ACTIVITY;
        }
      }
      continue;
    }
  }

  async function stopRun(state) {
    const run = state.run;
    if (!run) return;
    if (run.purpose === 'delegation') {
      const task = findTask(state, run.taskId);
      if (task && task.status === 'running') {
        task.status = 'failed';
        task.needsReturn = false;
        task.waitingOn = '';
        task.result = 'Cancelled.';
      }
    }
    await stopProvider(state);
    state.run = null;
    state.activity = '';
  }

  async function cancelDelegation(state, id, seen = new Set()) {
    if (seen.has(id)) return;
    seen.add(id);
    const task = findTask(state, id);
    if (!task) throw fail('That delegated task was not found.', 400);
    if (task.status !== 'pending' && task.status !== 'running') throw fail('That delegated task is already finished.', 409);
    if (task.waitingOn) {
      const child = findTask(state, task.waitingOn);
      if (child && (child.status === 'pending' || child.status === 'running')) await cancelDelegation(state, child.id, seen);
    }
    if (state.run && state.run.taskId === task.id) {
      await stopProvider(state);
      state.run = null;
      state.activity = '';
    }
    task.status = 'failed';
    task.needsReturn = false;
    task.waitingOn = '';
    task.result = 'Cancelled by the owner.';
  }

  function delegationBusy(state) {
    return state.delegations.some(task => task.status === 'pending' || task.status === 'running' || task.needsReturn);
  }

  async function operate(body) {
    const key = paneKey(body);
    const state = load(key);
    const operation = body.operation || 'state';
    if (operation === 'state') {
      await advance(state);
    } else if (operation === 'post') {
      if (typeof body.text !== 'string' || !body.text.trim() || body.text.length > 16000) throw fail('Enter a message of 1–16,000 characters.', 400);
      const text = body.text.trim();
      append(state, 'owner', text);
      state.agentStreak = 0;
      state.floorMark = state.messages.length;
      state.hold = false;
      if (state.activity === HOLD_ACTIVITY) state.activity = '';
      rememberAddress(state, text);
      enqueue(state, routeAddressees(text, state.lastAddressed), true);
      if (!state.run && !state.paused && !delegationBusy(state)) await startNextSpeaker(state);
      await advance(state);
    } else if (operation === 'speak') {
      if (!speakers.includes(body.speaker)) throw fail('Choose Hermes or Grok Bot.', 400);
      if (state.run || delegationBusy(state)) throw fail('Wait for the current speaker, or press Stop.', 409);
      state.next = body.speaker;
      await begin(state, body.speaker);
      await advance(state);
    } else if (operation === 'settings') {
      if (body.auto !== undefined) state.auto = body.auto === true;
      if (body.next !== undefined) {
        if (!speakers.includes(body.next)) throw fail('Choose Hermes or Grok Bot.', 400);
        state.next = body.next;
      }
      if (body.max_turns !== undefined) {
        if (!Number.isInteger(body.max_turns) || body.max_turns < 1 || body.max_turns > 8) throw fail('The turn limit must be from 1 to 8.', 400);
        state.maxTurns = body.max_turns;
      }
    } else if (operation === 'pause') {
      state.paused = true;
      state.activity = state.run ? `${labels[state.run.speaker]} will finish this reply, then the exchange stays paused.` : 'Paused.';
    } else if (operation === 'resume' || operation === 'continue') {
      state.paused = false;
      state.hold = false;
      state.agentStreak = 0;
      state.floorMark = state.messages.length;
      if (state.activity === HOLD_ACTIVITY) state.activity = '';
      await advance(state);
    } else if (operation === 'stop') {
      await stopRun(state);
      state.paused = true;
      state.hold = false;
      state.queue = [];
      append(state, 'note', 'Stopped.');
    } else if (operation === 'cancel_delegation') {
      if (typeof body.task_id !== 'string' || !taskPattern.test(body.task_id)) throw fail('Choose a delegated task to cancel.', 400);
      await cancelDelegation(state, body.task_id);
      append(state, 'note', 'Cancelled a delegated task.');
    } else throw fail('Unknown shared-agents operation.', 400);
    save(state);
    noteActivity(state);
    return state;
  }

  function noteActivity(state) {
    if (state?.run) active.add(state.key);
    else if (state?.key) active.delete(state.key);
  }

  function chain(key, work) {
    const previous = chains.get(key) || Promise.resolve();
    const result = previous.catch(() => {}).then(work);
    chains.set(key, result);
    return result;
  }

  function scanActive() {
    let names;
    try { names = fs.readdirSync(directory); }
    catch { return; }
    for (const name of names) {
      if (!name.endsWith('.json')) continue;
      try {
        const record = JSON.parse(fs.readFileSync(path.join(directory, name), 'utf8'));
        if (record?.run) active.add(name.slice(0, -'.json'.length));
      } catch {}
    }
  }

  async function tickOne(key) {
    if (!fs.existsSync(fileFor(key))) {
      active.delete(key);
      return;
    }
    const state = load(key);
    await advance(state);
    save(state);
    noteActivity(state);
  }

  const active = new Set();
  scanActive();
  const timer = setInterval(() => {
    try { fs.readdirSync(directory); }
    catch { clearInterval(timer); return; }
    for (const key of [...active]) chain(key, () => tickOne(key)).catch(() => {});
  }, advanceEvery);
  timer.unref();

  function handle(reply, res, body) {
    const key = `${body.workspace_id || ''}.${body.pane_id || ''}`;
    return chain(key, () => operate(body)).then(state => reply(res, 200, publicState(state))).catch(error => {
      const status = Number.isInteger(error?.status) ? error.status : 502;
      let message = typeof error?.message === 'string' ? error.message : '';
      if (!message.trim() || message.length > 500) message = 'The shared conversation could not complete that request.';
      if (res.headersSent || res.writableEnded) { try { res.end(); } catch {} return; }
      try { return reply(res, status, { error: message }); }
      catch { try { res.end(); } catch {} }
    });
  }

  return { handle };
}
