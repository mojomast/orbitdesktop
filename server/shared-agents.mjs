import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createAgentGateways } from './agent-gateways.mjs';
import { providerLabel, GATEWAY_PROVIDERS } from './agent-providers.mjs';
const taskPattern = /^d_[a-z0-9]{8,32}$/;
/** Provider ids a bare @mention can name: Hermes plus every gateway provider. */
const PROVIDER_PARTICIPANTS = Object.freeze(['hermes', ...GATEWAY_PROVIDERS]);
/** Default members for the exported helpers; a live room passes its own list. */
const DEFAULT_PARTICIPANTS = Object.freeze(['hermes', 'grok']);
/** Display names. Owner and note are not agents. */
const labels = { owner: 'Kyle', note: 'Orbit', hermes: providerLabel('hermes') };
for (const provider of GATEWAY_PROVIDERS) labels[provider] = providerLabel(provider);
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

function others(speaker, participants = DEFAULT_PARTICIPANTS) {
  return participants.filter(participant => participant !== speaker);
}

function andList(names) {
  if (!names.length) return '';
  if (names.length === 1) return names[0];
  return `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`;
}

function commaList(names) {
  if (!names.length) return '';
  if (names.length === 1) return names[0];
  return `${names.slice(0, -1).join(', ')}, and ${names.at(-1)}`;
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
    agents: {},
    run: null,
    delegations: [],
  };
}

function transcriptTail(messages) {
  const lines = messages.filter(message => message.speaker !== 'note').slice(-30).map(message => `${labels[message.speaker] || 'Orbit'}: ${message.text}`).join('\n\n');
  return lines.slice(-12000);
}

function groupPreamble(speaker, partners) {
  const name = labels[speaker];
  const names = partners.map(participant => labels[participant] || 'Orbit');
  const group = commaList(names);
  const roster = andList(names);
  const mentions = partners.map(participant => `@${participant}`).join(', ');
  const targets = partners.join(' or ');
  return `You are ${name} in a shared chat with Kyle, ${group}. Kyle is the owner. Reply only as ${name}. Do not write lines for Kyle or ${roster}. Use plain text.

Stay quiet unless Kyle or ${roster} addressed you, or you genuinely have something useful to add. If you have nothing to add, reply with exactly (quiet).

Address ${roster} as ${mentions} when you want them to respond. Use @all to hand the floor to everyone else. Address Kyle as @kyle. The conversation stops when you do not hand the floor to someone.

To delegate a task, end your reply with one fenced block exactly like this:

\`\`\`delegate
target: ${targets}
task: what the agent should do
context: optional details
\`\`\`

Orbit gives that task to the named agent's gateway and posts the result back here and to you. Delegate only to ${roster}. A chain may be at most ${MAX_DEPTH} delegations deep, and this conversation keeps at most ${MAX_TASKS} delegated tasks. If a tool needs approval, use your normal tool-approval flow; the owner resolves it on the agent that is executing. A structured brief is optional. If you include objective, also include deliverable, acceptance, tools, scope, budget (turns 1–20 and minutes 1–30), and returnFormat (a summary and artifact paths).`;
}

function preamble(speaker, participants = DEFAULT_PARTICIPANTS) {
  const name = labels[speaker];
  const partners = others(speaker, participants);
  if (partners.length > 1) return groupPreamble(speaker, partners);
  const partner = labels[partners[0]] || 'Orbit';
  const target = partners[0] || 'hermes';
  return `You are ${name} in a three-way chat with Kyle and ${partner}. Kyle is the owner. Reply only as ${name}. Do not write lines for Kyle or ${partner}. Use plain text.

Stay quiet unless Kyle or ${partner} addressed you, or you genuinely have something useful to add. If you have nothing to add, reply with exactly (quiet).

Address ${partner} as @${target} when you want them to respond. Use @all to hand the floor to everyone else. Address Kyle as @kyle. The conversation stops when you do not hand the floor to someone.

To delegate a task to ${partner}, end your reply with one fenced block exactly like this:

\`\`\`delegate
target: ${target}
task: what ${partner} should do
context: optional details
\`\`\`

Orbit gives that task to ${partner} through that agent's gateway and posts the result back here and to you. Delegate only to ${partner}. A chain may be at most ${MAX_DEPTH} delegations deep, and this conversation keeps at most ${MAX_TASKS} delegated tasks. If a tool needs approval, use your normal tool-approval flow; the owner resolves it on the agent that is executing. A structured brief is optional. If you include objective, also include deliverable, acceptance, tools, scope, budget (turns 1–20 and minutes 1–30), and returnFormat (a summary and artifact paths).`;
}

/** @hermes, @grok, @pi, and @all by default. An email local-part does not count. */
export function mentionedAgents(text, participants = PROVIDER_PARTICIPANTS) {
  const list = Array.isArray(participants) && participants.length ? participants : PROVIDER_PARTICIPANTS;
  const found = { all: false };
  for (const participant of list) found[participant] = false;
  for (const match of String(text || '').matchAll(/(^|[^A-Za-z0-9_])@([A-Za-z0-9_]+)\b/g)) {
    const key = match[2].toLowerCase();
    if (key === 'all' || list.includes(key)) found[key] = true;
  }
  return found;
}

/** Who should answer a message from Kyle. */
export function routeAddressees(text, lastAddressed = '', participants = DEFAULT_PARTICIPANTS) {
  const list = Array.isArray(participants) && participants.length ? participants : DEFAULT_PARTICIPANTS;
  const found = mentionedAgents(text, list);
  const mentioned = list.filter(participant => found[participant]);
  if (found.all) return list.slice();
  if (mentioned.length) return mentioned;
  if (String(text || '').includes('?')) return list.slice();
  if (list.includes(lastAddressed)) return [lastAddressed];
  if (lastAddressed === 'all') return list.slice();
  return list.includes('hermes') ? ['hermes'] : [list[0]];
}

function handoffTargets(speaker, text, participants = DEFAULT_PARTICIPANTS) {
  const found = mentionedAgents(text, participants);
  if (found.all) return others(speaker, participants);
  return participants.filter(participant => found[participant] && participant !== speaker);
}

function isQuiet(text) {
  return /^\(?quiet\)?[.!]?\s*$/i.test(String(text || '').trim());
}

function normalizeUtterance(text) {
  return String(text || '').toLowerCase().replace(/\s+/g, ' ').trim().slice(0, 240);
}

function agentTurnsSinceOwner(messages, floorMark = 0, participants = DEFAULT_PARTICIPANTS) {
  const visible = messages.slice(Math.max(0, floorMark) || 0);
  let start = 0;
  for (let index = visible.length - 1; index >= 0; index -= 1) {
    if (visible[index].speaker === 'owner') { start = index + 1; break; }
  }
  return visible.slice(start).filter(message => participants.includes(message.speaker));
}

function agentFloorBlocked(state, participants = DEFAULT_PARTICIPANTS) {
  if (state.agentStreak >= MAX_AGENT_STREAK) return true;
  const recent = agentTurnsSinceOwner(state.messages, state.floorMark || 0, participants);
  const speakersNow = recent.slice(-4).map(message => message.speaker);
  if (speakersNow.length === 4 && speakersNow[0] !== speakersNow[1] && speakersNow[0] === speakersNow[2] && speakersNow[1] === speakersNow[3]) return true;
  const norms = recent.map(message => normalizeUtterance(message.text)).filter(text => text.length >= 24);
  return new Set(norms).size !== norms.length;
}

function promptFor(speaker, messages, participants = DEFAULT_PARTICIPANTS) {
  return `${preamble(speaker, participants)}

Recent transcript:
${transcriptTail(messages) || '(no messages yet)'}

Reply to the latest message.`;
}

function briefBlock(brief) {
  if (!brief) return '';
  return `
Objective: ${brief.objective}
Deliverable: ${brief.deliverable}
Acceptance: ${brief.acceptance.join('; ')}
Allowed tools: ${brief.tools.join(', ') || '(none named)'}
Scope: ${brief.scope}
Budget: ${brief.budget.turns} turns, ${brief.budget.minutes} minutes.
Return format: ${brief.returnFormat}
`;
}

function delegationPrompt(task, messages, participants = DEFAULT_PARTICIPANTS) {
  const onward = participants.filter(participant => participant !== task.to);
  const onwardNames = onward.map(participant => labels[participant] || 'Orbit');
  const partner = onward.length === 1 ? onwardNames[0] : (andList(onwardNames) || 'another agent');
  return `${preamble(task.to, participants)}

${labels[task.from]} delegated this task to you. Do the task and reply with the result. You may delegate onward to ${partner} only if the chain is still within ${MAX_DEPTH} steps.

Task:
${task.task}
${task.context ? `\nContext:\n${task.context}\n` : ''}${briefBlock(task.brief)}
Recent transcript:
${transcriptTail(messages) || '(no messages yet)'}`;
}

function returnPrompt(task, messages, participants = DEFAULT_PARTICIPANTS) {
  return `${preamble(task.from, participants)}

${labels[task.to]} finished a task you delegated.
Task: ${task.task}
Result: ${task.result || '(no text)'}

Continue the shared conversation. The result is already in the transcript. Do not repeat a delegate block unless you are delegating a new task within the depth limit.

Recent transcript:
${transcriptTail(messages) || '(no messages yet)'}`;
}

function normalizeTarget(value) {
  const text = String(value || '').trim().toLowerCase().replace(/^@/, '');
  if (text === 'hermes') return 'hermes';
  if (text === 'grok' || text === 'grok bot') return 'grok';
  if (text === 'pi' || text === 'pi agent') return 'pi';
  // Group rooms name members by handle; the room checks membership.
  return /^[a-z0-9_]{1,32}$/.test(text) && !['owner', 'kyle', 'all', 'note', 'orbit'].includes(text) ? text : '';
}

function cleanField(value, max) {
  return String(value || '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max);
}

const BRIEF_KEYS = ['objective', 'deliverable', 'acceptance', 'tools', 'scope', 'budget', 'returnformat', 'return'];

function asList(value) {
  if (Array.isArray(value)) return value.map(item => cleanField(item, 500)).filter(Boolean);
  return cleanField(value, 2000).split(',').map(item => item.trim()).filter(Boolean);
}

function parseBudget(value) {
  if (value && typeof value === 'object' && !Array.isArray(value)) return { turns: Number(value.turns), minutes: Number(value.minutes) };
  const text = String(value || '');
  const turns = /(\d+)\s*turns?/i.exec(text);
  const minutes = /(\d+)\s*(?:minutes?|min)\b/i.exec(text);
  return { turns: turns ? Number(turns[1]) : Number.NaN, minutes: minutes ? Number(minutes[1]) : Number.NaN };
}

/** Null when the block is a plain target/task. An error when a brief was started but is incomplete. */
function briefFrom(source) {
  if (!source || typeof source !== 'object') return null;
  const started = BRIEF_KEYS.some(key => {
    const value = source[key] ?? (key === 'returnformat' ? source.returnFormat : undefined);
    return value != null && value !== '';
  });
  if (!started) return null;
  for (const key of ['objective', 'deliverable', 'scope', 'returnFormat', 'return', 'returnformat']) {
    if (source[key] != null && typeof source[key] !== 'string') return { error: 'Delegate brief fields must be text.' };
  }
  const objective = cleanField(source.objective, 1000);
  const deliverable = cleanField(source.deliverable, 1000);
  const scope = cleanField(source.scope, 1000);
  const returnFormat = cleanField(source.returnFormat || source.return || source.returnformat, 500);
  const acceptance = asList(source.acceptance).slice(0, 8);
  const toolsProvided = Object.prototype.hasOwnProperty.call(source, 'tools');
  const tools = asList(source.tools).slice(0, 12);
  const budget = parseBudget(source.budget);
  if (!objective || !deliverable || !scope || !returnFormat || !acceptance.length || !toolsProvided) {
    return { error: 'A delegate brief needs objective, deliverable, acceptance, tools, scope, budget, and returnFormat.' };
  }
  if (!/summary/i.test(returnFormat) || !/path/i.test(returnFormat)) return { error: 'returnFormat must ask for a summary and artifact paths.' };
  if (!Number.isInteger(budget.turns) || budget.turns < 1 || budget.turns > 20 || !Number.isInteger(budget.minutes) || budget.minutes < 1 || budget.minutes > 30) {
    return { error: 'Delegate budget turns must be 1–20 and minutes 1–30.' };
  }
  return { brief: { objective, deliverable, acceptance, tools, scope, budget: { turns: budget.turns, minutes: budget.minutes }, returnFormat } };
}

/** First fenced delegate block in an agent reply. Null when the reply does not delegate. */
export function parseDelegate(text) {
  const match = String(text || '').match(/```delegate[^\n]*\n([\s\S]*?)```/i);
  if (!match) return null;
  const body = match[1].trim();
  let target = '';
  let task = '';
  let context = '';
  let briefSource = null;
  if (body.startsWith('{')) {
    try {
      const parsed = JSON.parse(body);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return { error: 'The delegate block must be a JSON object with target and task.' };
      if (parsed.task != null && typeof parsed.task !== 'string') return { error: 'The delegated task must be text.' };
      if (parsed.context != null && typeof parsed.context !== 'string') return { error: 'Delegation context must be text.' };
      target = parsed.target;
      task = parsed.task || '';
      context = parsed.context || '';
      briefSource = parsed;
    } catch {
      return { error: 'The delegate block is not valid JSON.' };
    }
  } else {
    const fields = {};
    let current = '';
    for (const line of body.split('\n')) {
      const headed = /^(target|task|context|objective|deliverable|acceptance|tools|scope|budget|returnFormat|return)\s*:\s*(.*)$/i.exec(line);
      if (headed) {
        current = headed[1].toLowerCase() === 'return' ? 'returnformat' : headed[1].toLowerCase();
        if ((current === 'acceptance' || current === 'tools') && fields[current]) fields[current] = `${fields[current]}, ${headed[2]}`;
        else fields[current] = headed[2];
      } else if (current) fields[current] += `\n${line}`;
    }
    target = fields.target || '';
    task = fields.task || '';
    context = fields.context || '';
    briefSource = fields;
  }
  const to = normalizeTarget(target);
  task = cleanField(task, 4000);
  context = cleanField(context, 4000);
  if (!to) return { error: 'Name the target agent by its @handle (for example hermes, grok, or pi).' };
  if (!task) return { error: 'A delegated task must be 1–4,000 characters.' };
  const brief = briefFrom(briefSource);
  if (brief?.error) return brief;
  return brief?.brief ? { to, task, context, brief: brief.brief } : { to, task, context };
}

function publicState(state, participants = DEFAULT_PARTICIPANTS) {
  return {
    participants: participants.slice(),
    messages: state.messages.map(message => ({ id: message.id, speaker: message.speaker, text: message.text, at: message.at, ...(message.error ? { error: true } : {}) })),
    paused: state.paused,
    hold: state.hold === true,
    running: state.run?.speaker || '',
    queued: (state.queue || []).map(item => item.speaker),
    activity: state.activity || '',
    ...(state.collabProject?.id ? { collabProject: { id: state.collabProject.id } } : {}),
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

function cleanDelegations(list, participants = DEFAULT_PARTICIPANTS) {
  if (!Array.isArray(list)) return [];
  const tasks = [];
  for (const raw of list) {
    if (!raw || typeof raw !== 'object' || !taskPattern.test(raw.id || '')) continue;
    if (!participants.includes(raw.from) || !participants.includes(raw.to)) continue;
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
    const keptBrief = briefFrom(raw.brief);
    if (keptBrief?.brief) tasks.at(-1).brief = keptBrief.brief;
  }
  return tasks.slice(-MAX_TASKS);
}

/**
 * `members` (optional): a group room with arbitrary members, each {id: @handle, label}. The handle is the
 * speaker id; `gateways` must then map handles to providers. `defaultResponder` ('all' or a handle) answers
 * Kyle's un-mentioned messages instead of the provider-room heuristic.
 */
export function createSharedAgents({ directory, fetchImpl = fetch, chats, grok, hermesProfile, gatewayProfile, grokProfile, now = () => Date.now(), turnTimeoutMs, advanceIntervalMs, gateways: providedGateways, openCollab, members, defaultResponder } = {}) {
  const turnTimeout = Number.isFinite(turnTimeoutMs) && turnTimeoutMs >= 1000 ? Math.floor(turnTimeoutMs) : sharedTurnTimeoutMs();
  const turnTimeoutMinutes = Math.max(1, Math.round(turnTimeout / 60000));
  const advanceEvery = Number.isFinite(advanceIntervalMs) && advanceIntervalMs >= 15 ? Math.floor(advanceIntervalMs) : DEFAULT_ADVANCE_INTERVAL_MS;
  // The room is Hermes plus every configured gateway provider. An older caller that
  // still passes a single `grok` chat keeps the original two-member room.
  const roomChats = chats instanceof Map ? chats : (grok ? new Map([['grok', grok]]) : null);
  const memberList = Array.isArray(members) ? members.filter(m => m && /^[a-z0-9_]{1,32}$/.test(m.id) && !['owner', 'note', 'all', 'kyle'].includes(m.id)) : null;
  if (memberList) for (const m of memberList) labels[m.id] = String(m.label || m.id).replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, 80);
  const speakers = memberList && memberList.length
    ? memberList.map(m => m.id)
    : ['hermes', ...((roomChats ? [...roomChats.keys()] : ['grok']).filter(id => id !== 'hermes'))];
  const routeOwner = text => {
    if (memberList && defaultResponder) {
      const found = mentionedAgents(text, speakers);
      if (!found.all && !speakers.some(id => found[id])) return defaultResponder === 'all' ? speakers.slice() : speakers.includes(defaultResponder) ? [defaultResponder] : speakers.slice();
    }
    return null;
  };
  const gateways = providedGateways || createAgentGateways({ fetchImpl, chats: roomChats, hermesProfile, gatewayProfile: gatewayProfile || grokProfile, now });
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const chains = new Map();

  function fileFor(key) {
    return path.join(directory, `${key}.json`);
  }

  function load(key) {
    try {
      const record = JSON.parse(fs.readFileSync(fileFor(key), 'utf8'));
      if (!record || !Array.isArray(record.messages)) return { ...blank(key), next: speakers[0] };
      if (!speakers.includes(record.next)) { if (!memberList) return blank(key); record.next = speakers[0]; }
      record.key = key;
      record.messages = record.messages.filter(message => message && labels[message.speaker] && typeof message.text === 'string').slice(-200);
      record.auto = record.auto === true;
      record.maxTurns = Number.isInteger(record.maxTurns) && record.maxTurns >= 1 && record.maxTurns <= 8 ? record.maxTurns : 4;
      record.turns = Number.isInteger(record.turns) && record.turns >= 0 ? record.turns : 0;
      record.paused = record.paused === true;
      record.hold = record.hold === true;
      record.agentStreak = Number.isInteger(record.agentStreak) && record.agentStreak >= 0 && record.agentStreak <= 100 ? record.agentStreak : 0;
      record.floorMark = Number.isInteger(record.floorMark) && record.floorMark >= 0 ? record.floorMark : 0;
      record.lastAddressed = [...speakers, 'all'].includes(record.lastAddressed) ? record.lastAddressed : '';
      record.queue = cleanQueue(record.queue, speakers);
      record.activity = typeof record.activity === 'string' ? record.activity.slice(0, 300) : '';
      record.hermesSession = /^orbit-[0-9a-f-]{36}$/.test(record.hermesSession || '') ? record.hermesSession : `orbit-${randomUUID()}`;
      const rawAgents = record.agents && typeof record.agents === 'object' && !Array.isArray(record.agents) ? record.agents : {};
      record.agents = {};
      for (const participant of speakers) {
        const agentId = typeof rawAgents[participant] === 'string' ? rawAgents[participant] : (participant === 'grok' && typeof record.grokAgentId === 'string' ? record.grokAgentId : '');
        if (agentId) record.agents[participant] = agentId;
      }
      record.run = record.run && speakers.includes(record.run.speaker) && typeof record.run.runId === 'string' ? record.run : null;
      if (record.run) {
        record.run.purpose = ['turn', 'delegation', 'return'].includes(record.run.purpose) ? record.run.purpose : 'turn';
        record.run.depth = Number.isInteger(record.run.depth) ? record.run.depth : 0;
        record.run.taskId = typeof record.run.taskId === 'string' ? record.run.taskId : '';
        record.run.chain = typeof record.run.chain === 'string' ? record.run.chain : '';
      }
      record.delegations = cleanDelegations(record.delegations, speakers);
      return record;
    } catch (error) {
      if (error.code !== 'ENOENT') throw fail('The shared transcript could not be read.');
      return { ...blank(key), next: speakers[0] };
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
      agents: state.agents,
      grokAgentId: (state.agents && state.agents.grok) || '',
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

  function cleanQueue(list, participants = DEFAULT_PARTICIPANTS) {
  if (!Array.isArray(list)) return [];
  const queue = [];
  for (const item of list) {
    const speaker = typeof item === 'string' ? item : item?.speaker;
    if (!participants.includes(speaker) || queue.some(entry => entry.speaker === speaker)) continue;
    queue.push({ speaker, fromOwner: item?.fromOwner === true });
  }
  return queue.slice(0, Math.max(2, participants.length));
}

function enqueue(state, targets, fromOwner, participants = DEFAULT_PARTICIPANTS) {
  for (const speaker of targets) {
    if (!participants.includes(speaker) || state.queue.some(entry => entry.speaker === speaker)) continue;
    state.queue.push({ speaker, fromOwner: fromOwner === true });
  }
}

function rememberAddress(state, text, participants = DEFAULT_PARTICIPANTS) {
  const found = mentionedAgents(text, participants);
  const mentioned = participants.filter(participant => found[participant]);
  if (found.all || mentioned.length > 1) state.lastAddressed = 'all';
  else if (mentioned.length === 1) state.lastAddressed = mentioned[0];
}

function findTask(state, id) {
    return state.delegations.find(task => task.id === id) || null;
  }

  function openTasks(state) {
    return state.delegations.filter(task => task.status === 'pending' || task.status === 'running');
  }

  async function begin(state, speaker, meta = {}) {
    const purpose = meta.purpose || 'turn';
    const prompt = meta.prompt || promptFor(speaker, state.messages, speakers);
    const instructions = `${preamble(speaker, speakers)} Delegate only with the \`\`\`delegate fence.`;
    try {
      const started = await gateways.startSpeaker({ speaker, prompt, instructions, hermesSession: state.hermesSession, grokAgentId: state.agents[speaker] || '' });
      if (started.agentId) state.agents[speaker] = started.agentId;
      state.run = {
        speaker,
        purpose,
        taskId: meta.taskId || '',
        depth: meta.depth || 0,
        chain: meta.chain || '',
        runId: started.runId,
        started: started.started,
        ...(started.nonce ? { nonce: started.nonce, baseline: started.baseline, agentId: started.agentId } : {}),
      };
      if (purpose === 'turn') state.next = others(speaker, speakers)[0] || speaker;
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
    return gateways.pollSpeaker(state.run);
  }

  async function stopProvider(state) {
    if (!state.run) return;
    const run = state.run;
    try { await gateways.stopSpeaker(run); }
    catch (error) {
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
      prompt: delegationPrompt(task, state.messages, speakers),
    });
  }

  async function startNextSpeaker(state) {
    if (state.run || state.paused || state.hold) return false;
    while (state.queue.length) {
      const next = state.queue[0];
      if (!next.fromOwner && agentFloorBlocked(state, speakers)) {
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
        prompt: returnPrompt(returning, state.messages, speakers),
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
      append(state, 'note', 'Delegation must target a different agent.');
      return false;
    }
    if (!speakers.includes(parsed.to)) {
      append(state, 'note', 'Delegation must target another agent in this room.');
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
      ...(parsed.brief ? { brief: parsed.brief } : {}),
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
      const handoff = handoffTargets(speaker, output, speakers);
      if (handoff.length) {
        rememberAddress(state, output, speakers);
        enqueue(state, handoff, false, speakers);
        if (agentFloorBlocked(state, speakers)) {
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
      const collabGoal = text.match(/^\/collab\s+(\S[\s\S]*)$/);
      if (text === '/collab' || text.startsWith('/collab ')) {
        let collabProject;
        append(state, 'owner', text);
        if (!collabGoal) append(state, 'note', 'Add a goal after /collab.', true);
        else if (!openCollab) append(state, 'note', 'Collab is not available on this Orbit server.', true);
        else {
          try {
            const project = await openCollab({ goal: collabGoal[1].trim().slice(0, 4000), workspaceId: body.workspace_id, paneId: body.pane_id });
            append(state, 'note', `Opened Collab project ${project.id}. The Collab app has the board.`);
            collabProject = { id: project.id };
          } catch (error) {
            append(state, 'note', error?.message || 'Collab did not open.', true);
          }
        }
        save(state);
        noteActivity(state);
        return collabProject ? { ...state, collabProject } : state;
      }
      append(state, 'owner', text);
      state.agentStreak = 0;
      state.floorMark = state.messages.length;
      state.hold = false;
      if (state.activity === HOLD_ACTIVITY) state.activity = '';
      rememberAddress(state, text, speakers);
      enqueue(state, routeOwner(text) || routeAddressees(text, state.lastAddressed, speakers), true, speakers);
      if (!state.run && !state.paused && !delegationBusy(state)) await startNextSpeaker(state);
      await advance(state);
    } else if (operation === 'speak') {
      if (!speakers.includes(body.speaker)) throw fail('Choose an agent in this room.', 400);
      if (state.run || delegationBusy(state)) throw fail('Wait for the current speaker, or press Stop.', 409);
      state.next = body.speaker;
      await begin(state, body.speaker);
      await advance(state);
    } else if (operation === 'settings') {
      if (body.auto !== undefined) state.auto = body.auto === true;
      if (body.next !== undefined) {
        if (!speakers.includes(body.next)) throw fail('Choose an agent in this room.', 400);
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
  const dispose = () => clearInterval(timer);

  function handle(reply, res, body) {
    const key = `${body.workspace_id || ''}.${body.pane_id || ''}`;
    return chain(key, () => operate(body)).then(state => reply(res, 200, publicState(state, speakers))).catch(error => {
      const status = Number.isInteger(error?.status) ? error.status : 502;
      let message = typeof error?.message === 'string' ? error.message : '';
      if (!message.trim() || message.length > 500) message = 'The shared conversation could not complete that request.';
      if (res.headersSent || res.writableEnded) { try { res.end(); } catch {} return; }
      try { return reply(res, status, { error: message }); }
      catch { try { res.end(); } catch {} }
    });
  }

  return { handle, dispose, speakers: () => speakers.slice() };
}
