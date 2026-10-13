import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

const runPattern = /^run_[a-zA-Z0-9_-]{8,100}$/;
const taskPattern = /^d_[a-z0-9]{8,32}$/;
const speakers = ['hermes', 'grok'];
const labels = { owner: 'Owner', hermes: 'Hermes', grok: 'Grok Bot', note: 'Orbit' };
const MAX_DEPTH = 2;
const MAX_TASKS = 8;
const DELEGATION_TIMEOUT_MS = 3 * 60 * 1000;

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
  return `You are ${name}, speaking in a shared Orbit conversation with the owner and ${partner}. Reply only as ${name}. Do not write lines for the owner or ${partner}. Use plain text.

To delegate a task to ${partner}, end your reply with one fenced block exactly like this:

\`\`\`delegate
target: ${target}
task: what ${partner} should do
context: optional details
\`\`\`

Orbit gives that task to ${partner} through that agent's gateway and posts the result back here and to you. Delegate only to ${partner}. A chain may be at most ${MAX_DEPTH} delegations deep, and this conversation keeps at most ${MAX_TASKS} delegated tasks. If a tool needs approval, use your normal tool-approval flow; the owner resolves it on the agent that is executing.`;
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
    next: state.next,
    auto: state.auto,
    max_turns: state.maxTurns,
    turns: state.turns,
    paused: state.paused,
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

export function createSharedAgents({ directory, fetchImpl = fetch, grok, hermesProfile, grokProfile, now = () => Date.now() }) {
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
    if (!run || run.purpose !== 'delegation') return false;
    const task = findTask(state, run.taskId);
    if (!task || task.status !== 'running' || !task.deadline || now() <= task.deadline) return false;
    await stopProvider(state);
    state.run = null;
    state.activity = '';
    failTask(task, 'This delegated task timed out.', state);
    append(state, task.to, 'This delegated task timed out.', true);
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

  async function startQueued(state) {
    if (state.run) return false;
    expirePending(state);
    if (state.paused) return false;
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
    return false;
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
      state.turns += 1;
      if (delegated) continue;
      if (!state.auto || state.paused || state.turns >= state.maxTurns) {
        if (state.auto && !state.paused && state.turns >= state.maxTurns) {
          state.paused = true;
          append(state, 'note', `Paused after ${state.maxTurns} agent replies. Post a message, choose who speaks next, or press Resume.`);
        }
        return;
      }
      await begin(state, state.next);
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
      append(state, 'owner', body.text.trim());
      state.turns = 0;
      if (!state.run && state.auto && !state.paused && !delegationBusy(state)) await begin(state, state.next);
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
    } else if (operation === 'resume') {
      state.paused = false;
      state.turns = 0;
      if (!state.run && state.auto && !delegationBusy(state)) await begin(state, state.next);
      await advance(state);
    } else if (operation === 'stop') {
      await stopRun(state);
      state.paused = true;
      append(state, 'note', 'Stopped. Auto-alternate stays paused until you press Resume.');
    } else if (operation === 'cancel_delegation') {
      if (typeof body.task_id !== 'string' || !taskPattern.test(body.task_id)) throw fail('Choose a delegated task to cancel.', 400);
      await cancelDelegation(state, body.task_id);
      append(state, 'note', 'Cancelled a delegated task.');
    } else throw fail('Unknown shared-agents operation.', 400);
    save(state);
    return state;
  }

  function handle(reply, res, body) {
    const key = `${body.workspace_id || ''}.${body.pane_id || ''}`;
    const previous = chains.get(key) || Promise.resolve();
    const result = previous.catch(() => {}).then(() => operate(body));
    chains.set(key, result);
    return result.then(state => reply(res, 200, publicState(state))).catch(error => {
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
