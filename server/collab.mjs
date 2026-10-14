import fs from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createCollabStore, mintCollabId } from './collab-store.mjs';
import {
  DEFAULT_SUBAGENT_LIMITS, addWorktree, admitSpawn, copyOwnedFiles, mergeBlocked, mergeBranch, parseOrchestratorOp, projectedCost, removeWorktree, spanData, subagentPrompt,
} from './collab-orchestrator.mjs';

const AGENTS = ['hermes', 'grok', 'pi'];
const ROLES = ['planner', 'executor', 'reviewer', 'researcher'];
const SKILLS = ['terminal', 'tools', 'code', 'research', 'reasoning', 'writing'];
const RISKS = ['shell.write', 'net.post', 'git.push', 'email.send', 'delete'];
const ROLE_SKILLS = {
  planner: ['reasoning', 'writing', 'research'],
  executor: ['code', 'terminal', 'tools'],
  reviewer: ['reasoning', 'writing'],
  researcher: ['research', 'reasoning', 'writing'],
};
const LEASE_MS = 10 * 60 * 1000;
const DEFAULT_TURN_TIMEOUT_MS = 20 * 60 * 1000;
const DEFAULT_ADVANCE_INTERVAL_MS = 15 * 1000;
const labels = { hermes: 'Hermes', grok: 'Grok Bot', pi: 'Pi', kyle: 'Kyle', orbit: 'Orbit' };

const OPS = ['plan', 'replan', 'assign', 'spawn', 'merge', 'status', 'claim', 'artifact.put', 'handoff', 'submit', 'review', 'ask', 'decision', 'run-tests', 'workspace.sync', 'shell'];
const TEST_PREFIXES = [
  ['npm', 'test'],
  ['npm', 'run', 'test'],
  ['pnpm', 'test'],
  ['yarn', 'test'],
  ['pytest'],
  ['python', '-m', 'pytest'],
  ['python3', '-m', 'pytest'],
  ['node', '--test'],
];
const READONLY_PREFIXES = [
  ['pwd'],
  ['ls'],
  ['git', 'status'],
  ['git', 'diff'],
  ['git', 'log'],
  ...TEST_PREFIXES,
];

const INSTRUCTIONS = `You are working in Orbit Collab. Orbit owns the task board, the budget, and approvals. Propose every change by ending your reply with exactly one fenced collab block of strict JSON, for example:
\`\`\`collab
{"ops":[{"op":"claim","taskId":"t_example"},{"op":"artifact.put","name":"notes.md","kind":"note","content":"...","taskId":"t_example","baseVersion":0},{"op":"submit","taskId":"t_example","summary":"...","artifacts":[],"selfCheck":{}}]}
\`\`\`
Allowed ops are ${OPS.join(', ')}. A task reviewer must be the other agent, never the owner. Do not invent a second block.
artifact.put names may be relative paths such as src/app.js. kind is file, note, or test. baseVersion is the version you last read, or 0 for a new name. If Orbit says the version moved, read it again before writing.
run-tests runs one allowlisted command in the project workspace and stores the output as test-results.txt: npm test, npm run test, pnpm test, yarn test, pytest, python -m pytest, python3 -m pytest, or node --test. Extra arguments must be plain tokens.
shell runs in that same workspace. pwd, ls, git status, git diff, git log, and the run-tests commands run immediately when every extra argument is a plain token. Any other command needs risk "shell.write". Orbit then waits for Kyle and runs it with sh -c. That approval is the control; sh -c is not a sandbox. Output is stored as shell-output.txt. workspace.sync indexes text files written in the workspace after either agent's turn.
workspace.sync indexes files written in the workspace. Both agents can use artifact.put and shell.
The orchestrator may replan, assign, spawn, merge, and status. spawn defaults to mode tool: the worker returns a summary and artifact paths. mode handoff is only when Kyle should talk to that agent, and audience must be kyle. A spawn brief needs objective, deliverable, acceptance, tools, scope, budget {turns, minutes}, and returnFormat. effort is 1–4. effort above 1 waits until Kyle approves the projected cost. Do not push; Kyle approves a push separately.`;

function artifactName(value) {
  const name = clean(value, 120);
  if (!name || name.startsWith('/') || name.includes('\\')) return '';
  const parts = name.split('/');
  if (parts.some(part => !part || part === '.' || part === '..' || !/^[\w. -]{1,80}$/.test(part))) return '';
  return name;
}

export function parseTestCommand(command) {
  const parts = String(command || '').trim().split(/\s+/).filter(Boolean);
  const match = TEST_PREFIXES.find(prefix => prefix.length <= parts.length && prefix.every((part, index) => parts[index] === part));
  if (!match) return null;
  const extra = parts.slice(match.length);
  if (extra.some(arg => !/^[\w./:=@+-]{1,80}$/.test(arg) || arg.includes('..'))) return null;
  return parts;
}

function shellEnv() {
  const pick = (key, fallback = '') => (typeof process.env[key] === 'string' && process.env[key] ? process.env[key] : fallback);
  return {
    PATH: pick('PATH', '/usr/bin:/bin'),
    HOME: pick('HOME', '/tmp'),
    LANG: pick('LANG', 'C.UTF-8'),
    TMPDIR: pick('TMPDIR', '/tmp'),
    USER: pick('USER'),
    CI: '1',
  };
}

export function classifyShell(command) {
  const raw = String(command || '').replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 500);
  if (!raw) return null;
  const parts = raw.split(/\s+/).filter(Boolean);
  const match = READONLY_PREFIXES.find(prefix => prefix.length <= parts.length && prefix.every((part, index) => parts[index] === part));
  if (!match) return { mode: 'shell', command: raw };
  const extra = parts.slice(match.length);
  if (extra.some(arg => !/^[\w./:=@+-]{1,80}$/.test(arg) || arg.includes('..') || arg.startsWith('/'))) return { mode: 'shell', command: raw };
  return { mode: 'argv', command: parts.join(' '), parts };
}

function captureCommand(file, args, cwd, env) {
  return new Promise(resolve => {
    let output = '';
    let child;
    try {
      child = spawn(file, args, { cwd, env, timeout: 60000 });
    } catch (error) {
      resolve({ code: 127, output: error?.message || 'The command could not start.' });
      return;
    }
    const take = chunk => {
      if (output.length >= 20000) return;
      output += String(chunk);
      if (output.length > 20000) output = output.slice(0, 20000);
    };
    child.stdout?.on('data', take);
    child.stderr?.on('data', take);
    child.on('error', error => resolve({ code: 127, output: `${output}${error?.message || 'The command could not start.'}`.slice(0, 20000) }));
    child.on('close', code => resolve({ code: code ?? 1, output: output.trim() || '(no output)' }));
  });
}

function runAllowedTests(parts, cwd) {
  return captureCommand(parts[0], parts.slice(1), cwd, { ...process.env, CI: '1' });
}

function correctivePrompt(reason) {
  return `Your previous collab block was rejected: ${reason}\nAllowed ops: ${OPS.join(', ')}.\nReply with one corrected \`\`\`collab JSON block and no second block.`;
}

function fail(message, status = 502) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function clean(value, max) {
  return String(value || '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max);
}

function asSkills(list) {
  if (!Array.isArray(list)) return [];
  return [...new Set(list.map(skill => clean(skill, 40).toLowerCase()).filter(skill => SKILLS.includes(skill)))].slice(0, SKILLS.length);
}

function normalizeRole(value) {
  const role = clean(value, 40).toLowerCase();
  return ROLES.includes(role) ? role : '';
}

function gatewayAgentId(project, speaker) {
  const own = project?.gatewayAgents && typeof project.gatewayAgents[speaker] === 'string' ? project.gatewayAgents[speaker] : '';
  if (own) return own;
  const legacy = typeof project?.grokAgentId === 'string' ? project.grokAgentId : '';
  // Legacy projects kept one id; only reuse it for the provider whose id shape it has.
  if (speaker === 'grok') return /^pi_/.test(legacy) ? '' : legacy;
  if (speaker === 'pi') return /^pi_[a-f0-9]{16}$/.test(legacy) ? legacy : '';
  return '';
}

function normalizeAgent(value) {
  const name = clean(value, 40).toLowerCase();
  if (name === 'hermes') return AGENTS.includes('hermes') ? 'hermes' : '';
  if (name === 'grok' || name === 'grok bot') return AGENTS.includes('grok') ? 'grok' : '';
  if (name === 'pi') return AGENTS.includes('pi') ? 'pi' : '';
  return AGENTS.includes(name) ? name : '';
}

export function defaultCapabilities() {
  return {
    hermes: { skills: ['terminal', 'tools', 'code'] },
    grok: { skills: ['terminal', 'tools', 'code', 'research', 'reasoning', 'writing'] },
    pi: { skills: ['terminal', 'tools', 'code'] },
  };
}

export function chooseAgent(role, skillsHint, capabilities, avoid = '') {
  const skills = skillsHint?.length ? skillsHint : (ROLE_SKILLS[role] || ROLE_SKILLS.executor);
  let best = null;
  let bestScore = -1;
  for (const agent of AGENTS) {
    if (agent === avoid) continue;
    const have = new Set(capabilities?.[agent]?.skills || []);
    const overlap = skills.reduce((sum, skill) => sum + (have.has(skill) ? 1 : 0), 0);
    const bias = role === 'executor' ? (agent === 'hermes' ? 1 : 0) : (agent === 'grok' ? 1 : 0);
    const total = overlap * 10 + bias;
    if (total > bestScore) { bestScore = total; best = agent; }
  }
  return best || (avoid === 'hermes' ? 'grok' : 'hermes');
}

function parseOp(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { error: 'Each op must be an object.' };
  const op = raw.op;
  if (!OPS.includes(op)) return { error: `Unknown collab op "${clean(op, 40)}". Allowed ops: ${OPS.join(', ')}.` };
  if (op === 'plan') {
    if (!Array.isArray(raw.tasks) || raw.tasks.length < 1 || raw.tasks.length > 8) return { error: 'plan.tasks must contain 1–8 tasks.' };
    const tasks = [];
    for (const task of raw.tasks) {
      if (!task || typeof task !== 'object') return { error: 'Each planned task must be an object.' };
      const title = clean(task.title, 200);
      const spec = clean(task.spec, 4000);
      if (!title || !spec) return { error: 'Each planned task needs a title and a spec.' };
      if (!Array.isArray(task.acceptance) || task.acceptance.length < 1 || task.acceptance.length > 8) return { error: `Task "${title}" needs 1–8 acceptance criteria.` };
      const acceptance = task.acceptance.map(item => clean(item, 500)).filter(Boolean);
      if (acceptance.length !== task.acceptance.length) return { error: `Task "${title}" has an empty acceptance criterion.` };
      const role = normalizeRole(task.role);
      const owner = normalizeAgent(task.owner);
      const reviewer = normalizeAgent(task.reviewer);
      const dependsOn = Array.isArray(task.dependsOn) ? task.dependsOn.map(item => clean(item, 200)).filter(Boolean).slice(0, 8) : [];
      const skillsHint = asSkills(task.skillsHint);
      const risk = task.risk ? clean(task.risk, 40) : '';
      if (risk && !RISKS.includes(risk)) return { error: `Task "${title}" has an unknown risk class.` };
      tasks.push({ title, spec, acceptance, role, owner, reviewer, dependsOn, skillsHint, risk });
    }
    return { op: { op, tasks } };
  }
  if (op === 'claim' || op === 'submit' || op === 'handoff' || op === 'review' || op === 'ask') {
    const taskId = clean(raw.taskId, 40);
    if (!/^t_[a-f0-9]{16}$/.test(taskId)) return { error: `${op} needs a taskId.` };
    if (op === 'claim') return { op: { op, taskId } };
    if (op === 'handoff') {
      if (!AGENTS.includes(raw.to)) return { error: 'handoff.to must be one of the available Collab agents.' };
      const reason = clean(raw.reason, 1000);
      if (!reason) return { error: 'handoff needs a reason.' };
      return { op: { op, taskId, to: raw.to, reason } };
    }
    if (op === 'submit') {
      const summary = clean(raw.summary, 4000);
      if (!summary) return { error: 'submit needs a summary.' };
      const artifacts = Array.isArray(raw.artifacts) ? raw.artifacts.map(item => clean(item, 40)).filter(item => /^a_[a-f0-9]{16}$/.test(item)).slice(0, 8) : [];
      const paths = Array.isArray(raw.paths) ? raw.paths.map(item => clean(item, 120)).filter(Boolean).slice(0, 16) : [];
      const selfCheck = raw.selfCheck && typeof raw.selfCheck === 'object' && !Array.isArray(raw.selfCheck) ? raw.selfCheck : {};
      return { op: { op, taskId, summary, artifacts, paths, selfCheck } };
    }
    if (op === 'review') {
      if (!['approve', 'changes'].includes(raw.verdict)) return { error: 'review.verdict must be approve or changes.' };
      const notes = clean(raw.notes, 4000);
      const criteria = raw.criteria && typeof raw.criteria === 'object' && !Array.isArray(raw.criteria) ? raw.criteria : {};
      return { op: { op, taskId, verdict: raw.verdict, notes, criteria } };
    }
    const question = clean(raw.question, 2000);
    if (!question) return { error: 'ask needs a question.' };
    const to = raw.to === 'kyle' || AGENTS.includes(raw.to) ? raw.to : 'kyle';
    return { op: { op, taskId, question, to } };
  }
  if (op === 'shell') {
    const taskId = clean(raw.taskId, 40);
    if (!/^t_[a-f0-9]{16}$/.test(taskId)) return { error: 'shell needs a taskId.' };
    const classified = classifyShell(raw.command);
    if (!classified) return { error: 'shell needs a command.' };
    const risk = raw.risk ? clean(raw.risk, 40) : '';
    if (classified.mode === 'argv') {
      if (risk) return { error: 'A read-only shell command does not take a risk class. Drop risk, or mark a command outside pwd, ls, git status, git diff, git log, and the test commands with risk "shell.write".' };
      return { op: { op, taskId, command: classified.command, mode: 'argv', parts: classified.parts } };
    }
    if (risk && !RISKS.includes(risk)) return { error: 'shell has an unknown risk class.' };
    if (risk !== 'shell.write') return { error: 'That shell command is not read-only. Add risk "shell.write" so Kyle can approve it before Orbit runs it.' };
    return { op: { op, taskId, command: classified.command, mode: 'shell', risk: 'shell.write' } };
  }
  if (op === 'run-tests' || op === 'workspace.sync') {
    const taskId = clean(raw.taskId, 40);
    if (!/^t_[a-f0-9]{16}$/.test(taskId)) return { error: `${op} needs a taskId.` };
    if (op === 'workspace.sync') return { op: { op, taskId } };
    const command = clean(raw.command, 200) || 'npm test';
    if (!parseTestCommand(command)) return { error: 'run-tests accepts npm test, npm run test, pnpm test, yarn test, pytest, python -m pytest, python3 -m pytest, or node --test. Extra arguments must be plain tokens with no shell syntax.' };
    return { op: { op, taskId, command } };
  }
  if (op === 'replan') {
    const planned = parseOp({ op: 'plan', tasks: raw.tasks });
    if (planned.error) return { error: planned.error };
    return { op: { op: 'replan', tasks: planned.op.tasks } };
  }
  if (op === 'assign' || op === 'spawn' || op === 'merge' || op === 'status') return parseOrchestratorOp(raw);
  if (op === 'artifact.put') {
    const name = artifactName(raw.name);
    if (!name) return { error: 'artifact.put needs a relative file name such as notes.md or src/app.js. Names cannot contain .. or an absolute path.' };
    const kind = raw.kind === 'file' || raw.kind === 'note' || raw.kind === 'test' ? raw.kind : '';
    if (!kind) return { error: 'artifact.put kind must be file, note, or test.' };
    const content = typeof raw.content === 'string' ? raw.content.replace(/\u0000/g, '').slice(0, 100000) : '';
    if (!content.trim()) return { error: 'artifact.put needs content.' };
    const taskId = clean(raw.taskId, 40);
    if (!/^t_[a-f0-9]{16}$/.test(taskId)) return { error: 'artifact.put needs a taskId.' };
    if (!Number.isInteger(raw.baseVersion) || raw.baseVersion < 0 || raw.baseVersion > 1000) return { error: 'artifact.put needs an integer baseVersion. Use 0 for a new artifact, or the version you last read.' };
    const risk = raw.risk ? clean(raw.risk, 40) : '';
    if (risk && !RISKS.includes(risk)) return { error: 'artifact.put has an unknown risk class.' };
    return { op: { op, name, kind, content, taskId, baseVersion: raw.baseVersion, risk } };
  }
  const text = clean(raw.text, 2000);
  if (!text) return { error: 'decision needs text.' };
  return { op: { op, text } };
}

export function parseCollabBlock(text) {
  const fences = [...String(text || '').matchAll(/```collab[^\n]*\n([\s\S]*?)```/gi)];
  if (fences.length !== 1) return { ok: false, error: fences.length === 0 ? 'Reply with exactly one ```collab JSON block.' : 'Reply with one ```collab block, not several.' };
  let data;
  try { data = JSON.parse(fences[0][1].trim()); }
  catch { return { ok: false, error: 'The collab block must be strict JSON. Example: {"ops":[{"op":"decision","text":"notes"}]}.' }; }
  if (!data || typeof data !== 'object' || Array.isArray(data) || !Array.isArray(data.ops)) return { ok: false, error: 'The collab block must be an object with an ops array.' };
  if (data.ops.length < 1 || data.ops.length > 8) return { ok: false, error: 'A collab block needs 1–8 ops.' };
  const ops = [];
  for (const raw of data.ops) {
    const parsed = parseOp(raw);
    if (parsed.error) return { ok: false, error: parsed.error };
    ops.push(parsed.op);
  }
  return { ok: true, ops };
}

export function collabTurnTimeoutMs(env = process.env) {
  const raw = Number(env?.ORBIT_COLLAB_TURN_TIMEOUT_MS ?? env?.ORBIT_SHARED_TURN_TIMEOUT_MS);
  if (Number.isFinite(raw) && raw >= 1000 && raw <= 30 * 60 * 1000) return Math.floor(raw);
  return DEFAULT_TURN_TIMEOUT_MS;
}

function isProtocolMistake(message) {
  const text = String(message || '');
  return text.includes('exactly one ```collab')
    || text.includes('one ```collab block, not several')
    || text.includes('workspace.sync needs a taskId');
}

function riskSummary(speaker, op) {
  const who = labels[speaker] || speaker;
  const detail = clean(op?.command || op?.name || '', 600);
  return detail ? `${who} wants to use ${op.risk}: ${detail}` : `${who} wants to use ${op.risk}.`;
}

export function createCollab({ directory, gateways, now = () => Date.now(), advanceIntervalMs, turnTimeoutMs } = {}) {
  const store = createCollabStore(directory);
  const turnTimeout = Number.isFinite(turnTimeoutMs) && turnTimeoutMs >= 1000 ? Math.floor(turnTimeoutMs) : collabTurnTimeoutMs();
  const advanceEvery = Number.isFinite(advanceIntervalMs) && advanceIntervalMs >= 15 ? Math.floor(advanceIntervalMs) : DEFAULT_ADVANCE_INTERVAL_MS;
  const chains = new Map();
  const active = new Set();
  const turnMarks = [];
  const fileOwners = new Map();

  function event(bundle, type, extra = {}) {
    const record = {
      id: `e_${randomUUID().replaceAll('-', '').slice(0, 16)}`,
      at: now(),
      actor: extra.actor || 'orbit',
      type,
      taskId: extra.taskId || '',
      data: extra.data || {},
    };
    store.appendEvent(bundle.project.id, record);
    return record;
  }

  function taskById(bundle, id) {
    return bundle.tasks.find(task => task.id === id) || null;
  }

  function refreshArtifacts(bundle) {
    bundle.artifacts = store.listArtifactMetas(bundle.project.id);
  }

  function rewriteSummary(bundle) {
    const done = bundle.tasks.filter(task => task.status === 'completed').map(task => task.title);
    const decisions = bundle.project.memory.decisions.map(item => item.text);
    bundle.project.memory.summary = [
      `Goal: ${bundle.project.goal}`,
      done.length ? `Done: ${done.join('; ')}` : '',
      decisions.length ? `Decisions: ${decisions.join(' | ')}` : '',
    ].filter(Boolean).join('\n').slice(0, 1500);
    event(bundle, 'summary', { data: { summary: bundle.project.memory.summary } });
  }

  function other(agent) {
    return AGENTS.find(item => item !== agent) || agent;
  }

  function ensureRuns(project) {
    if (!project.runs || typeof project.runs !== 'object' || Array.isArray(project.runs)) project.runs = Object.fromEntries(AGENTS.map(agent => [agent, null]));
    if (project.run?.speaker && AGENTS.includes(project.run.speaker) && !project.runs[project.run.speaker]) project.runs[project.run.speaker] = project.run;
    delete project.run;
    for (const agent of AGENTS) if (!project.runs[agent]) project.runs[agent] = null;
    return project.runs;
  }

  function ensureOrchestration(project) {
    if (!project.capabilities || typeof project.capabilities !== 'object') project.capabilities = defaultCapabilities();
    for (const agent of AGENTS) if (!project.capabilities[agent]) project.capabilities[agent] = (defaultCapabilities()[agent] || { skills: ['terminal', 'tools', 'code'] });
    ensureRuns(project);
    if (!Array.isArray(project.subagents)) project.subagents = [];
    if (!Array.isArray(project.subagentRuns)) project.subagentRuns = [];
    const limits = project.subagentLimits && typeof project.subagentLimits === 'object' ? project.subagentLimits : {};
    const maxConcurrent = Number.isInteger(limits.maxConcurrent) && limits.maxConcurrent >= 1 && limits.maxConcurrent <= 4 ? limits.maxConcurrent : DEFAULT_SUBAGENT_LIMITS.maxConcurrent;
    const maxDepth = limits.maxDepth === 2 ? 2 : DEFAULT_SUBAGENT_LIMITS.maxDepth;
    project.subagentLimits = { maxConcurrent, maxDepth };
    if (!AGENTS.includes(project.orchestrator)) {
      project.orchestrator = chooseAgent('planner', [], project.capabilities || defaultCapabilities());
      project.orchestratorSource = 'auto';
    }
    if (project.orchestratorSource !== 'auto' && !AGENTS.includes(project.orchestratorSource)) project.orchestratorSource = 'auto';
    return project;
  }

  function subagentById(project, id) {
    return (project.subagents || []).find(item => item.id === id) || null;
  }

  function parentChain(project, parentSubagentId) {
    const chain = [];
    let cursor = parentSubagentId;
    const seen = new Set();
    while (cursor && !seen.has(cursor)) {
      seen.add(cursor);
      const node = subagentById(project, cursor);
      if (!node) break;
      chain.push(node);
      cursor = node.parentSubagentId;
    }
    return chain;
  }

  function busyTaskIds(project) {
    const runs = ensureRuns(project);
    return new Set(AGENTS.map(agent => runs[agent]?.taskId).filter(Boolean));
  }

  async function stopRuns(bundle) {
    const runs = ensureRuns(bundle.project);
    for (const agent of AGENTS) {
      const run = runs[agent];
      if (!run) continue;
      try { await gateways.stopSpeaker(run); }
      catch (error) { event(bundle, 'error', { actor: agent, data: { message: error?.message || 'Stop failed.' } }); }
      runs[agent] = null;
    }
    ensureOrchestration(bundle.project);
    for (const run of [...bundle.project.subagentRuns]) {
      try { await gateways.stopSpeaker(run); }
      catch (error) { event(bundle, 'error', { actor: run.speaker, data: { message: error?.message || 'Stop failed.' } }); }
    }
    bundle.project.subagentRuns = [];
    for (const sub of bundle.project.subagents) {
      if (!['running', 'pending-approval', 'waiting-for-kyle', 'ready-for-kyle'].includes(sub.status)) continue;
      sub.status = 'canceled';
      removeWorktree(bundle.project.workspace, sub);
      await archiveSubagent(bundle, sub);
      event(bundle, 'subagent.canceled', { actor: 'orbit', taskId: sub.taskId, data: { subagentId: sub.id, reason: 'The project stopped.' } });
    }
  }

  function describeActivity(bundle) {
    const runs = ensureRuns(bundle.project);
    const bits = AGENTS.filter(agent => runs[agent]).map(agent => {
      const run = runs[agent];
      const verb = run.kind === 'plan' ? 'drafting a plan' : run.kind === 'review' ? 'reviewing' : 'working';
      const title = run.taskId ? taskById(bundle, run.taskId)?.title : '';
      return title ? `${labels[agent]} is ${verb} on ${title}` : `${labels[agent]} is ${verb}`;
    });
    if (bits.length) bundle.project.activity = `${bits.join('; ')}.`;
  }

  function rememberTurn(projectId, speaker, taskId, kind) {
    let files = new Map();
    try { files = new Map(store.listWorkspaceFiles(projectId).map(file => [file.name, file.content])); } catch { files = new Map(); }
    turnMarks.push({ speaker, taskId: taskId || '', kind, wallStart: Date.now(), files });
    if (turnMarks.length > 40) turnMarks.shift();
  }

  function noteWrittenFiles(projectId, speaker, taskId, before) {
    for (const file of store.listWorkspaceFiles(projectId)) {
      if (before.get(file.name) === file.content) continue;
      fileOwners.set(`${projectId}\0${file.name}`, { actor: speaker, taskId: taskId || '', content: file.content });
    }
  }

  function fileCreator(bundle, file, caller, callerTaskId) {
    const noted = fileOwners.get(`${bundle.project.id}\0${file.name}`);
    if (noted && noted.content === file.content) return { actor: noted.actor, taskId: noted.taskId || callerTaskId || '' };
    const others = turnMarks.filter(mark => mark.speaker !== caller && mark.kind === 'work' && mark.files.get(file.name) !== file.content);
    if (others.length) {
      const pick = others[others.length - 1];
      return { actor: pick.speaker, taskId: pick.taskId || callerTaskId || '' };
    }
    return { actor: caller, taskId: callerTaskId || '' };
  }

  function syncWorkspace(bundle, taskId, by) {
    const files = store.listWorkspaceFiles(bundle.project.id);
    const added = [];
    for (const file of files) {
      const current = bundle.artifacts.find(item => item.name === file.name);
      const latest = current?.versions?.at(-1)?.v || 0;
      let previous = '';
      if (current) {
        try { previous = store.readArtifact(bundle.project.id, current.id, latest).content; } catch { previous = ''; }
      }
      if (current && previous === file.content) continue;
      const creator = fileCreator(bundle, file, by, taskId);
      const stored = store.putArtifact(bundle.project.id, {
        name: file.name, kind: 'file', content: file.content, by: creator.actor, taskId: creator.taskId || '', baseVersion: latest, note: 'Indexed from the workspace.',
      });
      refreshArtifacts(bundle);
      const ownerTask = creator.taskId ? taskById(bundle, creator.taskId) : null;
      if (ownerTask && !ownerTask.artifacts.includes(stored.meta.id)) ownerTask.artifacts.push(stored.meta.id);
      added.push(file.name);
    }
    if (added.length) event(bundle, 'workspace.sync', { actor: by, taskId: taskId || '', data: { files: added } });
    return added;
  }

  function assignTask(draft, capabilities) {
    const role = ROLES.includes(draft.role) ? draft.role : (draft.skillsHint?.some(skill => ['research', 'writing', 'reasoning'].includes(skill)) && !draft.skillsHint?.some(skill => ['code', 'terminal', 'tools'].includes(skill)) ? 'researcher' : 'executor');
    const owner = draft.owner || chooseAgent(role, draft.skillsHint, capabilities);
    if (draft.reviewer && draft.reviewer === owner) return { error: `Reviewer must be a different agent than the owner of "${draft.title}".` };
    const reviewer = draft.reviewer || other(owner);
    return { ...draft, role, owner, reviewer };
  }

  function depsReady(bundle, task) {
    return task.dependsOn.every(id => bundle.tasks.find(item => item.id === id)?.status === 'completed');
  }

  function packet(bundle, speaker, task) {
    const project = ensureOrchestration(bundle.project);
    const budget = project.budget;
    const wallMin = Math.max(1, Math.round(budget.maxWallMs / 60000));
    const spentMin = Math.max(0, Math.round((now() - project.createdAt) / 60000));
    const artifactExcerpt = (id) => {
      const meta = bundle.artifacts.find(item => item.id === id);
      if (!meta) return '';
      try {
        const version = meta.versions.at(-1)?.v;
        const stored = store.readArtifact(project.id, id, version);
        return `\n${meta.name}@v${stored.version}:\n${stored.content.slice(0, 2000)}`;
      } catch { return ''; }
    };
    const dependencyText = task ? task.dependsOn.map(id => {
      const dep = taskById(bundle, id);
      if (!dep) return '';
      const bits = dep.artifacts || [];
      return `- ${dep.title} (${dep.status})${bits.map(artifactExcerpt).join('')}`;
    }).filter(Boolean).join('\n') : '';
    const decisions = project.memory.decisions.slice(-12).map(item => `- ${labels[item.by] || item.by}: ${item.text}`).join('\n');
    const criteria = task ? task.acceptance.map(item => `- ${item}`).join('\n') : '';
    const turnRole = !task ? 'planner' : task.status === 'review' ? 'reviewer' : task.role;
    return `${INSTRUCTIONS}

Project goal: ${project.goal}
Definition of done:
${(project.definitionOfDone || []).map(item => `- ${item}`).join('\n') || '- The goal is met.'}
Summary:
${project.memory.summary || '(none yet)'}
Decisions:
${decisions || '(none yet)'}
Your role this turn: ${turnRole} as ${labels[speaker]}
Orchestrator: ${labels[project.orchestrator] || project.orchestrator}. ${speaker === project.orchestrator ? 'You are the orchestrator. Decompose, schedule, replan on failure, merge, and post status for Kyle. Workers are agents-as-tools unless Kyle should talk to them.' : 'The orchestrator schedules and merges. You still own only your task.'}
Subagents: at most ${project.subagentLimits?.maxConcurrent || 3} running per agent, depth cap ${project.subagentLimits?.maxDepth || 1}. A coding subagent gets its own worktree and disjoint files.
${(project.subagents || []).length ? `Current subagents:\n${project.subagents.map(item => `- ${item.id} ${item.name} (${item.status}) on ${item.taskId} files ${(item.files || []).join(', ') || 'none'}`).join('\n')}` : 'Current subagents: none.'}
Capabilities: ${AGENTS.map(agent => `${labels[agent] || agent} (${(project.capabilities?.[agent]?.skills || []).join(', ')})`).join('; ')}
Workspace directory: ${project.workspace || '(not ready)'}
Both agents can read and write that directory. Read-only shell commands run immediately. Other shell commands wait for Kyle when they include risk "shell.write". Orbit indexes workspace files after either agent's turn and when workspace.sync runs. Either agent can use artifact.put and run-tests there.
The other agent may be working on a different task at the same time. Write an artifact only at the baseVersion shown above; if it changed, the put is rejected and you must read the new version.
${task ? `Current task ${task.id}: ${task.title}
Owner: ${labels[task.owner]}. Reviewer: ${labels[task.reviewer]}. Status: ${task.status}.
Spec: ${task.spec}
Acceptance:
${criteria}
Reviewer notes: ${task.reviewNotes || '(none)'}
Existing artifacts:${(task.artifacts || []).map(artifactExcerpt).join('') || '\n(none)'}
Dependencies:
${dependencyText || '(none)'}` : `No tasks exist yet. Reply with one plan op.
Each task needs a title, a spec, and acceptance (1–8 testable strings).
role must be one of: planner, executor, reviewer, researcher. Any other role is ignored and Orbit chooses from skillsHint.
owner and reviewer must be hermes or grok (or pi when it is configured). The reviewer must not be the owner. Omit either one and Orbit assigns from skills.
skillsHint is an array of: terminal, tools, code, research, reasoning, writing.
dependsOn is an array of exact task titles from this same plan. A task waits until every title in dependsOn is completed. Use [] when the task can start immediately.`}
Budget: ${budget.spentTurns}/${budget.maxTurns} turns, ${spentMin}/${wallMin} minutes${budget.maxTokens ? `, ${budget.spentTokens}/${budget.maxTokens} tokens` : ''}.
Last error: ${task?.lastError || project.activity || '(none)'}`;
  }

  function budgetBlocked(bundle, { warn = true } = {}) {
    const budget = bundle.project.budget;
    const nextTurns = budget.spentTurns + 1;
    const wallOver = now() - bundle.project.createdAt >= budget.maxWallMs;
    const tokensOver = Number.isInteger(budget.maxTokens) && budget.maxTokens > 0 && budget.spentTokens >= budget.maxTokens;
    if (budget.spentTurns >= budget.maxTurns || wallOver || tokensOver) {
      if (bundle.project.activity !== 'Budget reached. Orbit paused this project.') {
        bundle.project.status = 'paused';
        bundle.project.activity = 'Budget reached. Orbit paused this project.';
        event(bundle, 'budget', { data: { level: 'pause', spentTurns: budget.spentTurns, maxTurns: budget.maxTurns } });
      } else bundle.project.status = 'paused';
      return true;
    }
    if (warn && !budget.warned && (nextTurns / budget.maxTurns >= 0.8 || (budget.maxTokens && budget.spentTokens / budget.maxTokens >= 0.8))) {
      budget.warned = true;
      bundle.project.activity = 'This project has used about 80% of its budget.';
      event(bundle, 'budget', { data: { level: 'warn', spentTurns: budget.spentTurns, maxTurns: budget.maxTurns } });
    }
    return false;
  }

  async function beginTurn(bundle, speaker, task, kind, { corrective = false, promptExtra = '' } = {}) {
    if (bundle.project.status !== 'active') return false;
    const runs = ensureRuns(bundle.project);
    if (runs[speaker]) return false;
    if (budgetBlocked(bundle)) return false;
    const project = bundle.project;
    const prompt = `${packet(bundle, speaker, task)}${promptExtra ? `\n\n${promptExtra}` : ''}`;
    rememberTurn(project.id, speaker, task?.id || '', kind);
    try {
      const started = await gateways.startSpeaker({
        speaker,
        prompt,
        instructions: INSTRUCTIONS,
        hermesSession: project.hermesSession,
        // One gateway agent per provider: Grok Bot ids are UUIDs, Pi ids are pi_<hex>. A single shared
        // field made each provider overwrite the other's agent and create a new one every turn.
        grokAgentId: gatewayAgentId(project, speaker),
        grokAgentName: 'Orbit collab',
      });
      if (started.agentId && speaker !== 'hermes') {
        project.gatewayAgents = { ...(project.gatewayAgents || {}), [speaker]: started.agentId };
        if (speaker === 'grok') project.grokAgentId = started.agentId;
      }
      project.budget.spentTurns += 1;
      if (started.tokens) project.budget.spentTokens += started.tokens;
      runs[speaker] = {
        speaker,
        taskId: task?.id || '',
        kind,
        corrective,
        runId: started.runId,
        started: started.started,
        ...(started.nonce ? { nonce: started.nonce, baseline: started.baseline, agentId: started.agentId } : {}),
      };
      describeActivity(bundle);
      event(bundle, 'turn.started', { actor: speaker, taskId: task?.id || '', data: { kind, runId: started.runId } });
      return true;
    } catch (error) {
      const message = error?.message || `${labels[speaker]} could not take a turn.`;
      event(bundle, 'error', { actor: speaker, taskId: task?.id || '', data: { message } });
      if (task) exhaust(bundle, task, message, kind);
      else {
        project.status = 'paused';
        project.activity = message;
      }
      return false;
    }
  }

  function exhaust(bundle, task, reason, kind = 'work') {
    task.lease = null;
    task.lastError = clean(reason, 500);
    if (kind === 'review') {
      task.reviewFailures = (task.reviewFailures || 0) + 1;
      if (task.reviewFailures >= 2) {
        task.status = 'failed';
        event(bundle, 'task.state', { taskId: task.id, data: { status: 'failed', reason: task.lastError, review: true } });
        bundle.project.activity = `${task.title} failed review. ${task.lastError}`;
        return;
      }
      task.status = 'review';
      event(bundle, 'task.state', { taskId: task.id, data: { status: 'review', reason: task.lastError, retry: true, review: true } });
      return;
    }
    task.attempts += 1;
    if (task.attempts === 1) {
      task.status = 'submitted';
      event(bundle, 'task.state', { taskId: task.id, data: { status: 'submitted', reason: task.lastError, retry: true } });
      return;
    }
    if (task.attempts === 2) {
      const next = other(task.owner);
      if (task.reviewer === next) task.reviewer = task.owner;
      task.owner = next;
      task.status = 'submitted';
      event(bundle, 'handoff', { actor: 'orbit', taskId: task.id, data: { to: next, reason: task.lastError } });
      return;
    }
    task.status = 'failed';
    event(bundle, 'task.state', { taskId: task.id, data: { status: 'failed', reason: task.lastError } });
    bundle.project.activity = `${task.title} failed. ${task.lastError}`;
  }

  function expireLeases(bundle) {
    for (const task of bundle.tasks) {
      if (task.status !== 'working' || !task.lease || busyTaskIds(bundle.project).has(task.id)) continue;
      if (now() <= task.lease.until) continue;
      exhaust(bundle, task, 'The task lease expired.', 'work');
    }
  }

  function blockOnFailedDeps(bundle) {
    for (const task of bundle.tasks) {
      if (!['submitted', 'working'].includes(task.status)) continue;
      const broken = task.dependsOn.some(id => taskById(bundle, id)?.status === 'failed');
      if (!broken) continue;
      task.status = 'failed';
      task.lastError = 'A dependency failed.';
      event(bundle, 'task.state', { taskId: task.id, data: { status: 'failed', reason: task.lastError } });
    }
  }

  async function scheduleNext(bundle, deferAgents = new Set()) {
    if (bundle.project.status !== 'active' || bundle.project.gate) return false;
    expireLeases(bundle);
    blockOnFailedDeps(bundle);
    const runs = ensureRuns(bundle.project);
    const busy = busyTaskIds(bundle.project);
    let started = false;
    for (const agent of AGENTS) {
      if (runs[agent]) continue;
      const review = bundle.tasks.find(task => task.status === 'review' && !task.protocolHold && task.reviewer === agent && depsReady(bundle, task) && !busy.has(task.id));
      const ready = bundle.tasks.find(task => task.status === 'submitted' && !task.protocolHold && task.owner === agent && depsReady(bundle, task) && !busy.has(task.id));
      const working = deferAgents.has(agent) ? null : bundle.tasks.find(task => task.status === 'working' && !task.protocolHold && task.owner === agent && task.lease && now() <= task.lease.until && depsReady(bundle, task) && !busy.has(task.id));
      const task = review || ready || working;
      if (!task) continue;
      const kind = task.status === 'review' ? 'review' : 'work';
      const speaker = task.status === 'review' ? task.reviewer : task.owner;
      if (await beginTurn(bundle, speaker, task, kind)) {
        started = true;
        if (task.id) busy.add(task.id);
      }
    }
    if (started || AGENTS.some(agent => runs[agent])) return started;
    const open = bundle.tasks.some(task => ['submitted', 'working', 'review', 'input-required'].includes(task.status));
    if (!open && bundle.tasks.some(task => task.status === 'completed') && !bundle.project.gate) {
      bundle.project.gate = { id: mintCollabId('g'), type: 'final', summary: 'Every task is finished. Accept the project, or reject it with notes.', taskId: '', op: null };
      event(bundle, 'approval.requested', { data: { type: 'final', summary: bundle.project.gate.summary } });
      bundle.project.activity = bundle.project.gate.summary;
    }
    return false;
  }

  function materializePlan(bundle, tasks) {
    if (bundle.tasks.some(task => !['canceled', 'failed'].includes(task.status))) return 'A plan is already on the board.';
    const assigned = [];
    for (const task of tasks) {
      const next = assignTask(task, bundle.project.capabilities);
      if (next.error) return next.error;
      assigned.push(next);
    }
    if (new Set(assigned.map(task => task.title)).size !== assigned.length) return 'Planned task titles must be unique.';
    const ids = new Map(assigned.map(task => [task.title, mintCollabId('t')]));
    for (const task of assigned) {
      for (const dep of task.dependsOn) {
        if (!ids.has(dep) && !taskById(bundle, dep)) return `Task "${task.title}" depends on unknown task "${dep}".`;
      }
    }
    for (const task of assigned) {
      const id = ids.get(task.title);
      const record = {
        id,
        title: task.title,
        spec: task.spec,
        acceptance: task.acceptance,
        dependsOn: task.dependsOn.map(dep => ids.get(dep) || dep),
        owner: task.owner,
        reviewer: task.reviewer,
        role: task.role,
        skillsHint: task.skillsHint,
        risk: task.risk || '',
        status: 'submitted',
        attempts: 0,
        reviewAttempts: 0,
        maxAttempts: 2,
        lease: null,
        artifacts: [],
        summary: '',
        reviewNotes: '',
        lastError: '',
        selfCheck: {},
        criteria: {},
        createdAt: now(),
      };
      bundle.tasks.push(record);
      event(bundle, 'task.created', { taskId: id, data: { title: record.title, owner: record.owner, reviewer: record.reviewer, role: record.role } });
    }
    bundle.project.gate = {
      id: mintCollabId('g'),
      type: 'plan',
      summary: `Approve the plan (${assigned.length} task${assigned.length === 1 ? '' : 's'}) before work starts.`,
      taskId: '',
      op: null,
    };
    event(bundle, 'approval.requested', { data: { type: 'plan', summary: bundle.project.gate.summary } });
    bundle.project.activity = bundle.project.gate.summary;
    rewriteSummary(bundle);
    return '';
  }

  function checkOps(bundle, speaker, ops) {
    ensureOrchestration(bundle.project);
    const open = bundle.tasks.filter(task => !['canceled', 'failed'].includes(task.status));
    for (const op of ops) {
      if (op.op === 'plan') {
        if (open.length) return 'A plan can only be proposed before live tasks exist.';
        continue;
      }
      if (op.op === 'decision') continue;
      if (op.op === 'status' || op.op === 'replan') {
        if (speaker !== bundle.project.orchestrator) return 'Only the orchestrator can do that.';
        continue;
      }
      if (op.op === 'assign' || op.op === 'merge' || op.op === 'spawn') {
        const task = taskById(bundle, op.taskId);
        if (!task) return 'That task is not on the board.';
        if (op.op === 'assign' || op.op === 'merge') {
          if (speaker !== bundle.project.orchestrator) return 'Only the orchestrator can do that.';
          if (op.op === 'assign' && ['completed', 'failed', 'canceled'].includes(task.status)) return 'That task is already finished.';
          if (op.op === 'assign' && busyTaskIds(bundle.project).has(task.id)) return 'That task is in a turn.';
          if (op.op === 'merge') {
            const sub = subagentById(bundle.project, op.subagentId);
            if (!sub || sub.taskId !== task.id) return 'That subagent is not on this task.';
            if (sub.status !== 'completed' || sub.merged) return 'Merge a completed subagent that is not merged yet.';
            const blocked = mergeBlocked(sub, bundle.project.subagents, bundle.tasks);
            if (blocked) return blocked;
          }
          continue;
        }
        if (speaker !== task.owner && speaker !== bundle.project.orchestrator) return 'Only the task owner or the orchestrator can spawn.';
        if (!['submitted', 'working', 'review'].includes(task.status)) return 'That task cannot take a subagent now.';
        const parentId = '';
        const chain = parentChain(bundle.project, parentId);
        const depth = chain.length + 1;
        const admission = admitSpawn({
          limits: bundle.project.subagentLimits,
          parent: speaker,
          active: bundle.project.subagents,
          effort: op.effort,
          files: op.files,
          depth,
          objective: op.brief.objective,
          taskId: task.id,
          chain,
        });
        if (admission) return admission;
        const remaining = bundle.project.budget.maxTurns - bundle.project.budget.spentTurns;
        const cost = projectedCost(op.effort, op.brief.budget);
        if (cost.turns > remaining) return `${cost.text} ${remaining} remain.`;
        continue;
      }
      const task = taskById(bundle, op.taskId);
      if (!task) return 'That task is not on the board.';
      if (op.op === 'review') {
        if (speaker !== task.reviewer) return 'Only the reviewer can review this task.';
        if (task.status !== 'review') return 'That task is not in review.';
        continue;
      }
      if (speaker !== task.owner && op.op !== 'ask') return 'Only the task owner can do that.';
      if (op.op === 'shell' && op.mode !== 'argv' && op.risk !== 'shell.write') return 'That shell command needs risk "shell.write" before Orbit will run it.';
      if (op.op === 'submit' && !['working', 'submitted'].includes(task.status)) return 'That task cannot be submitted from its current status.';
      if (op.op === 'artifact.put') {
        const names = ops.filter(item => item.op === 'artifact.put' && item.name === op.name);
        if (names.length > 1) return `Write ${op.name} once in this block. It can be written again after you read the new version.`;
        const current = bundle.artifacts.find(item => item.name === op.name);
        const latest = current?.versions?.at(-1)?.v || 0;
        if (!current && op.baseVersion !== 0) return `Artifact ${op.name} does not exist yet. Start at baseVersion 0.`;
        if (current && op.baseVersion !== latest) return `Artifact ${op.name} is at version ${latest}. Set baseVersion to ${latest} and include the latest text.`;
        const holder = AGENTS.map(agent => ensureRuns(bundle.project)[agent]).find(run => run && run.speaker !== speaker && run.taskId && run.taskId !== op.taskId);
        if (holder) {
          const peerTask = taskById(bundle, holder.taskId);
          const peerArtifacts = new Set(peerTask?.artifacts || []);
          if (current && peerArtifacts.has(current.id)) return `Artifact ${op.name} is in use by ${labels[holder.speaker]}. Wait for that turn to finish, then read version ${latest}.`;
        }
      }
      if (op.risk && bundle.project.policy.approve.includes(op.risk)) continue;
    }
    return '';
  }

  async function archiveSubagent(bundle, sub) {
    if (!sub || sub.provider !== 'grok' || !sub.agentId || sub.archived) return;
    if (typeof gateways.archiveSubagent !== 'function') return;
    try {
      const result = await gateways.archiveSubagent(sub);
      sub.archived = result?.archived === true;
      event(bundle, 'subagent.archived', { actor: sub.provider, taskId: sub.taskId, data: { subagentId: sub.id, archived: sub.archived, note: result?.note || '' } });
    } catch (error) {
      event(bundle, 'error', { actor: sub.provider, taskId: sub.taskId, data: { message: error?.message || 'Subagent archive failed.', subagentId: sub.id } });
    }
  }

  function dropSubagentRun(project, runId) {
    project.subagentRuns = (project.subagentRuns || []).filter(item => item.runId !== runId);
  }

  async function failSubagent(bundle, sub, message) {
    sub.attempts += 1;
    sub.lastError = clean(message, 500);
    dropSubagentRun(bundle.project, sub.runId);
    event(bundle, 'span', {
      actor: sub.provider, taskId: sub.taskId,
      data: spanData({ name: 'subagent', spanId: sub.spanId, parentSpanId: sub.parentSubagentId, agent: sub.provider, status: 'error', startedAt: sub.createdAt, endedAt: now(), summary: sub.lastError }),
    });
    if (sub.attempts < 2) {
      event(bundle, 'subagent.retry', { actor: 'orbit', taskId: sub.taskId, data: { subagentId: sub.id, reason: sub.lastError } });
      await startSubagentTurn(bundle, sub);
      return;
    }
    if (!sub.rerouted) {
      sub.status = 'failed';
      await archiveSubagent(bundle, sub);
      event(bundle, 'subagent.reroute', { actor: 'orbit', taskId: sub.taskId, data: { subagentId: sub.id, to: other(sub.provider), reason: sub.lastError } });
      const replacement = {
        ...sub,
        id: mintCollabId('s'),
        parent: other(sub.provider),
        provider: other(sub.provider),
        attempts: 0,
        rerouted: true,
        status: 'pending-approval',
        sessionId: '',
        agentId: '',
        archived: false,
        spentTurns: 0,
        spentTokens: 0,
        transcript: [],
        spanId: mintCollabId('span'),
        lastError: '',
        runId: '',
        result: null,
        merged: false,
        createdAt: now(),
      };
      const placed = addWorktree(bundle.project.workspace, replacement.id);
      replacement.branch = placed.branch;
      replacement.worktree = placed.worktree;
      replacement.isolated = placed.isolated;
      replacement.worktreeNote = placed.note;
      bundle.project.subagents.push(replacement);
      await startSubagentTurn(bundle, replacement);
      return;
    }
    sub.status = 'failed';
    await archiveSubagent(bundle, sub);
    bundle.project.activity = `Subagent ${sub.name} failed. ${sub.lastError}`;
    event(bundle, 'subagent.failed', { actor: 'orbit', taskId: sub.taskId, data: { subagentId: sub.id, reason: sub.lastError } });
  }

  async function startSubagentTurn(bundle, sub) {
    ensureOrchestration(bundle.project);
    if (budgetBlocked(bundle)) {
      sub.status = 'failed';
      sub.lastError = 'Project budget is spent.';
      event(bundle, 'subagent.failed', { actor: 'orbit', taskId: sub.taskId, data: { subagentId: sub.id, reason: sub.lastError } });
      return;
    }
    if (sub.spentTurns >= sub.brief.budget.turns) {
      await failSubagent(bundle, sub, 'Subagent turn budget is spent.');
      return;
    }
    const task = taskById(bundle, sub.taskId);
    const prompt = subagentPrompt({
      goal: bundle.project.goal,
      task: task || { id: sub.taskId, title: sub.name, spec: '' },
      brief: sub.brief,
      worktree: sub.worktree,
      isolated: sub.isolated,
    });
    sub.transcript = [...(sub.transcript || []), { role: 'user', text: prompt.slice(0, 4000) }];
    try {
      const started = await gateways.startSubagent({
        speaker: sub.provider,
        prompt,
        instructions: 'You are an Orbit Collab subagent. Reply with one collab block. Do not push.',
        name: sub.name,
        parentSession: sub.provider === 'hermes' ? bundle.project.hermesSession : '',
        worktree: sub.worktree,
        files: sub.files,
        hold: false,
      });
      sub.agentId = started.agentId || sub.agentId || '';
      sub.sessionId = started.sessionId || sub.sessionId || '';
      sub.strategy = started.strategy || '';
      sub.status = 'running';
      sub.runId = started.runId;
      sub.spentTurns += 1;
      bundle.project.budget.spentTurns += 1;
      if (started.tokens) {
        bundle.project.budget.spentTokens += started.tokens;
        sub.spentTokens += started.tokens;
      }
      bundle.project.subagentRuns.push({
        subagentId: sub.id,
        speaker: sub.provider,
        taskId: sub.taskId,
        kind: 'subagent',
        runId: started.runId,
        started: started.started || now(),
        timeoutMs: Math.min(30 * 60 * 1000, Math.max(1000, sub.brief.budget.minutes * 60 * 1000)),
        ...(started.nonce ? { nonce: started.nonce, baseline: started.baseline, agentId: started.agentId } : {}),
        ...(started.agentId ? { agentId: started.agentId } : {}),
      });
      event(bundle, 'span', {
        actor: sub.provider, taskId: sub.taskId,
        data: spanData({ name: 'subagent', spanId: sub.spanId, parentSpanId: sub.parentSubagentId, agent: `${sub.provider}:${sub.name}`, status: 'start', startedAt: now(), summary: sub.brief.objective }),
      });
      event(bundle, 'subagent.started', { actor: sub.provider, taskId: sub.taskId, data: { subagentId: sub.id, strategy: sub.strategy, worktree: sub.worktree, branch: sub.branch } });
    } catch (error) {
      await failSubagent(bundle, sub, error?.message || 'The subagent could not start.');
    }
  }

  async function openHeldSubagent(bundle, sub) {
    if (typeof gateways.startSubagent !== 'function') return;
    const started = await gateways.startSubagent({
      speaker: sub.provider,
      prompt: '',
      instructions: '',
      name: sub.name,
      parentSession: sub.provider === 'hermes' ? bundle.project.hermesSession : '',
      hold: true,
    });
    sub.agentId = started.agentId || '';
    sub.sessionId = started.sessionId || '';
    sub.strategy = started.strategy || '';
    sub.status = 'ready-for-kyle';
    event(bundle, 'subagent.ready', { actor: sub.provider, taskId: sub.taskId, data: { subagentId: sub.id, sessionId: sub.sessionId, agentId: sub.agentId } });
  }

  async function applySpawn(bundle, speaker, op, { parentSubagentId = '' } = {}) {
    ensureOrchestration(bundle.project);
    const task = taskById(bundle, op.taskId);
    if (!task) return 'That task is not on the board.';
    if (!['submitted', 'working', 'review'].includes(task.status)) return 'That task cannot take a subagent now.';
    const chain = parentChain(bundle.project, parentSubagentId);
    const depth = chain.length + 1;
    const admission = admitSpawn({
      limits: bundle.project.subagentLimits,
      parent: speaker,
      active: bundle.project.subagents,
      effort: op.effort,
      files: op.files,
      depth,
      objective: op.brief.objective,
      taskId: task.id,
      chain,
    });
    if (admission) return admission;
    const remaining = bundle.project.budget.maxTurns - bundle.project.budget.spentTurns;
    const cost = projectedCost(op.effort, op.brief.budget);
    if (cost.turns > remaining) return `${cost.text} ${remaining} remain.`;
    const created = [];
    for (let index = 0; index < op.effort; index += 1) {
      const record = {
        id: mintCollabId('s'),
        name: op.effort > 1 ? `${op.name} ${index + 1}` : op.name,
        parent: speaker,
        parentSubagentId,
        depth,
        taskId: task.id,
        status: 'pending-approval',
        mode: op.mode,
        audience: op.audience,
        provider: speaker,
        brief: op.brief,
        files: [...op.files],
        branch: '',
        worktree: '',
        isolated: false,
        worktreeNote: '',
        sessionId: '',
        agentId: '',
        strategy: '',
        result: null,
        attempts: 0,
        rerouted: false,
        merged: false,
        archived: false,
        spentTurns: 0,
        spentTokens: 0,
        transcript: [],
        spanId: mintCollabId('span'),
        lastError: '',
        createdAt: now(),
      };
      const placed = addWorktree(bundle.project.workspace, record.id);
      record.branch = placed.branch;
      record.worktree = placed.worktree;
      record.isolated = placed.isolated;
      record.worktreeNote = placed.note;
      bundle.project.subagents.push(record);
      created.push(record);
      event(bundle, 'subagent.spawned', { actor: speaker, taskId: task.id, data: { subagentId: record.id, name: record.name, effort: op.effort, mode: op.mode, files: record.files, projected: cost } });
    }
    if (op.mode === 'handoff' || op.effort > 1) {
      bundle.project.gate = {
        id: mintCollabId('g'),
        type: op.mode === 'handoff' ? 'handoff' : 'scale',
        summary: op.mode === 'handoff'
          ? `Kyle should talk to ${op.name} directly. ${cost.text}`
          : `Start ${op.effort} subagents for “${task.title}”? ${cost.text}`,
        taskId: task.id,
        op: { subagentIds: created.map(item => item.id) },
      };
      event(bundle, 'approval.requested', { actor: speaker, taskId: task.id, data: { type: bundle.project.gate.type, summary: bundle.project.gate.summary, projected: cost } });
      bundle.project.activity = bundle.project.gate.summary;
      return '';
    }
    await startSubagentTurn(bundle, created[0]);
    return '';
  }

  function materializeReplan(bundle, tasks) {
    const liveTitles = new Set(bundle.tasks.filter(task => !['canceled', 'failed'].includes(task.status)).map(task => task.title));
    const assigned = [];
    for (const task of tasks) {
      if (liveTitles.has(task.title)) return `Task "${task.title}" is already on the board.`;
      const next = assignTask(task, bundle.project.capabilities);
      if (next.error) return next.error;
      assigned.push(next);
    }
    if (new Set(assigned.map(task => task.title)).size !== assigned.length) return 'Planned task titles must be unique.';
    const ids = new Map(assigned.map(task => [task.title, mintCollabId('t')]));
    for (const task of assigned) {
      for (const dep of task.dependsOn) {
        const known = bundle.tasks.some(item => item.title === dep && !['canceled', 'failed'].includes(item.status));
        if (!ids.has(dep) && !known && !taskById(bundle, dep)) return `Task "${task.title}" depends on unknown task "${dep}".`;
      }
    }
    const titleToId = new Map(bundle.tasks.filter(task => !['canceled', 'failed'].includes(task.status)).map(task => [task.title, task.id]));
    for (const [title, id] of ids) titleToId.set(title, id);
    const created = [];
    for (const task of assigned) {
      const id = ids.get(task.title);
      const record = {
        id,
        title: task.title,
        spec: task.spec,
        acceptance: task.acceptance,
        dependsOn: task.dependsOn.map(dep => titleToId.get(dep) || dep),
        owner: task.owner,
        reviewer: task.reviewer,
        role: task.role,
        skillsHint: task.skillsHint,
        risk: task.risk || '',
        status: 'submitted',
        attempts: 0,
        reviewAttempts: 0,
        maxAttempts: 2,
        lease: null,
        artifacts: [],
        summary: '',
        reviewNotes: '',
        lastError: '',
        selfCheck: {},
        criteria: {},
        createdAt: now(),
      };
      bundle.tasks.push(record);
      created.push(id);
      event(bundle, 'task.created', { taskId: id, data: { title: record.title, owner: record.owner, reviewer: record.reviewer, role: record.role, replan: true } });
    }
    bundle.project.gate = {
      id: mintCollabId('g'),
      type: 'replan',
      summary: `Approve the revised plan (${created.length} new task${created.length === 1 ? '' : 's'}) before that work starts.`,
      taskId: '',
      op: { taskIds: created },
    };
    event(bundle, 'approval.requested', { data: { type: 'replan', summary: bundle.project.gate.summary } });
    bundle.project.activity = bundle.project.gate.summary;
    rewriteSummary(bundle);
    return '';
  }

  async function applyMerge(bundle, op) {
    const sub = subagentById(bundle.project, op.subagentId);
    if (!sub || sub.status !== 'completed' || sub.merged) return 'Merge a completed subagent that is not merged yet.';
    const blocked = mergeBlocked(sub, bundle.project.subagents, bundle.tasks);
    if (blocked) return blocked;
    const workspace = bundle.project.workspace;
    let outcome = { merged: true, conflicts: [] };
    if (sub.isolated && sub.branch) outcome = mergeBranch(workspace, sub.branch);
    else copyOwnedFiles(workspace, sub);
    if (!outcome.merged) {
      for (const file of outcome.conflicts) {
        const title = `Resolve ${file}`.slice(0, 200);
        if (bundle.tasks.some(task => task.title === title && !['canceled', 'failed', 'completed'].includes(task.status))) continue;
        const owner = bundle.project.orchestrator;
        const record = {
          id: mintCollabId('t'),
          title,
          spec: `Merge conflict in ${file} while merging ${sub.name}. One writer should produce a single version. Do not push until Kyle approves.`,
          acceptance: [`${file} has a single resolved version.`],
          dependsOn: [],
          owner,
          reviewer: other(owner),
          role: 'executor',
          skillsHint: ['code'],
          risk: '',
          status: 'submitted',
          attempts: 0,
          reviewAttempts: 0,
          maxAttempts: 2,
          lease: null,
          artifacts: [],
          summary: '',
          reviewNotes: '',
          lastError: '',
          selfCheck: {},
          criteria: {},
          createdAt: now(),
        };
        bundle.tasks.push(record);
        event(bundle, 'task.created', { taskId: record.id, data: { title, owner, reviewer: record.reviewer, role: 'executor', resolve: file } });
      }
      event(bundle, 'subagent.merge', { actor: bundle.project.orchestrator, taskId: sub.taskId, data: { subagentId: sub.id, conflicts: outcome.conflicts } });
      bundle.project.activity = `Merge conflict in ${outcome.conflicts.join(', ') || sub.name}. A resolve task is on the board.`;
      return '';
    }
    sub.merged = true;
    sub.status = 'merged';
    event(bundle, 'subagent.merged', { actor: bundle.project.orchestrator, taskId: sub.taskId, data: { subagentId: sub.id, branch: sub.branch, files: sub.files } });
    return '';
  }

  async function finishSubagent(bundle, sub, run, output, tokens) {
    dropSubagentRun(bundle.project, run.runId);
    if (tokens) {
      bundle.project.budget.spentTokens += tokens;
      sub.spentTokens += tokens;
    }
    sub.transcript = [...(sub.transcript || []), { role: 'assistant', text: String(output || '').slice(0, 4000) }];
    const parsed = parseCollabBlock(output);
    if (!parsed.ok) return failSubagent(bundle, sub, parsed.error);
    const submit = parsed.ops.find(item => item.op === 'submit');
    if (!submit?.summary) return failSubagent(bundle, sub, 'A subagent must submit a summary and artifact paths.');
    sub.result = { summary: submit.summary, paths: submit.paths || [], artifacts: submit.artifacts || [] };
    sub.status = 'completed';
    event(bundle, 'span', {
      actor: sub.provider, taskId: sub.taskId,
      data: spanData({ name: 'subagent', spanId: sub.spanId, parentSpanId: sub.parentSubagentId, agent: `${sub.provider}:${sub.name}`, status: 'ok', startedAt: sub.createdAt, endedAt: now(), summary: submit.summary.slice(0, 180) }),
    });
    event(bundle, 'subagent.completed', { actor: sub.provider, taskId: sub.taskId, data: { subagentId: sub.id, summary: submit.summary, paths: sub.result.paths } });
    await archiveSubagent(bundle, sub);
    for (const child of parsed.ops.filter(item => item.op === 'spawn')) {
      const problem = await applySpawn(bundle, sub.provider, child, { parentSubagentId: sub.id });
      if (problem) event(bundle, 'error', { actor: sub.provider, taskId: sub.taskId, data: { message: problem, subagentId: sub.id } });
    }
    return 'ok';
  }

  async function settleSubagent(bundle, run) {
    const sub = subagentById(bundle.project, run.subagentId);
    if (!sub) {
      dropSubagentRun(bundle.project, run.runId);
      return 'done';
    }
    const limit = Number(run.timeoutMs) || Math.min(turnTimeout, 30 * 60 * 1000);
    if (run.started && now() - run.started > limit) {
      try { await gateways.stopSpeaker(run); } catch { /* the failure still counts */ }
      await failSubagent(bundle, sub, `${sub.name} did not finish within ${Math.max(1, Math.round(limit / 60000))} minutes.`);
      return 'done';
    }
    let view;
    try { view = await gateways.pollSpeaker(run); }
    catch (error) {
      await failSubagent(bundle, sub, error.message || 'The subagent could not be reached.');
      return 'done';
    }
    if (view.status === 'running') return 'running';
    if (view.status === 'waiting_for_approval') {
      bundle.project.status = 'paused';
      bundle.project.activity = view.error || `${sub.name} is waiting for a tool approval.`;
      return 'waiting';
    }
    if (view.status === 'failed') {
      await failSubagent(bundle, sub, view.error || 'The subagent failed.');
      return 'done';
    }
    await finishSubagent(bundle, sub, run, view.output || '', view.tokens || 0);
    return 'done';
  }

  async function applyOps(bundle, speaker, ops) {
    for (const op of ops) {
      if (op.risk && bundle.project.policy.approve.includes(op.risk)) {
        const task = taskById(bundle, op.taskId);
        if (task) task.status = 'input-required';
        bundle.project.gate = { id: mintCollabId('g'), type: 'risk', summary: riskSummary(speaker, op), taskId: op.taskId || '', by: speaker, op };
        event(bundle, 'approval.requested', { actor: speaker, taskId: op.taskId || '', data: { type: 'risk', risk: op.risk, summary: bundle.project.gate.summary } });
        bundle.project.activity = bundle.project.gate.summary;
        return;
      }
      if (op.op === 'plan') {
        const error = materializePlan(bundle, op.tasks);
        if (error) throw fail(error, 400);
        continue;
      }
      if (op.op === 'decision') {
        bundle.project.memory.decisions.push({ id: mintCollabId('dec'), text: op.text, by: speaker, at: now() });
        bundle.project.memory.decisions = bundle.project.memory.decisions.slice(-40);
        event(bundle, 'decision', { actor: speaker, data: { text: op.text } });
        rewriteSummary(bundle);
        continue;
      }
      if (op.op === 'status') {
        bundle.project.activity = op.text;
        event(bundle, 'status', { actor: speaker, data: { text: op.text, summary: op.text } });
        continue;
      }
      if (op.op === 'replan') {
        const error = materializeReplan(bundle, op.tasks);
        if (error) throw fail(error, 400);
        continue;
      }
      if (op.op === 'spawn') {
        const error = await applySpawn(bundle, speaker, op);
        if (error) throw fail(error, 400);
        if (bundle.project.gate) return;
        continue;
      }
      if (op.op === 'assign') {
        const target = taskById(bundle, op.taskId);
        if (!target) throw fail('That task is not on the board.', 400);
        if (target.reviewer === op.to) target.reviewer = target.owner;
        target.owner = op.to;
        if (target.owner === target.reviewer) target.reviewer = other(target.owner);
        target.status = target.status === 'working' ? 'submitted' : target.status;
        target.lease = null;
        event(bundle, 'handoff', { actor: speaker, taskId: target.id, data: { to: op.to, reason: op.reason, assign: true } });
        continue;
      }
      if (op.op === 'merge') {
        const error = await applyMerge(bundle, op);
        if (error) throw fail(error, 400);
        continue;
      }
      const task = taskById(bundle, op.taskId);
      if (op.op === 'claim') {
        task.status = 'working';
        task.lease = { holder: speaker, until: now() + LEASE_MS };
        event(bundle, 'task.claimed', { actor: speaker, taskId: task.id, data: { until: task.lease.until } });
        continue;
      }
      if (op.op === 'artifact.put') {
        if (task.status === 'submitted') {
          task.status = 'working';
          task.lease = { holder: speaker, until: now() + LEASE_MS };
        }
        const stored = store.putArtifact(bundle.project.id, { name: op.name, kind: op.kind, content: op.content, by: speaker, taskId: task.id, baseVersion: op.baseVersion, note: task.title });
        refreshArtifacts(bundle);
        if (!task.artifacts.includes(stored.meta.id)) task.artifacts.push(stored.meta.id);
        event(bundle, 'artifact.put', { actor: speaker, taskId: task.id, data: { id: stored.meta.id, name: op.name, version: stored.version } });
        continue;
      }
      if (op.op === 'run-tests') {
        const parts = parseTestCommand(op.command);
        if (!parts) throw fail('run-tests accepts npm test, npm run test, pnpm test, yarn test, pytest, python -m pytest, python3 -m pytest, or node --test.', 400);
        const workspace = store.initWorkspace(bundle.project.id);
        const result = await runAllowedTests(parts, workspace);
        const content = `command: ${op.command}\nexit: ${result.code}\n\n${result.output}`;
        const current = bundle.artifacts.find(item => item.name === 'test-results.txt');
        const baseVersion = current?.versions?.at(-1)?.v || 0;
        const stored = store.putArtifact(bundle.project.id, {
          name: 'test-results.txt', kind: 'test', content, by: speaker, taskId: task.id, baseVersion, note: `exit ${result.code}`,
        });
        refreshArtifacts(bundle);
        if (!task.artifacts.includes(stored.meta.id)) task.artifacts.push(stored.meta.id);
        if (result.code !== 0) task.lastError = `Tests exited ${result.code}. Read test-results.txt.`;
        else if (task.lastError.startsWith('Tests exited')) task.lastError = '';
        event(bundle, 'test.ran', { actor: speaker, taskId: task.id, data: { command: op.command, exit: result.code, id: stored.meta.id, version: stored.version } });
        continue;
      }
      if (op.op === 'workspace.sync') {
        const files = syncWorkspace(bundle, task.id, speaker);
        if (!files.length) event(bundle, 'workspace.sync', { actor: speaker, taskId: task.id, data: { files: [] } });
        continue;
      }
      if (op.op === 'shell') {
        const workspace = store.initWorkspace(bundle.project.id);
        const before = new Map(store.listWorkspaceFiles(bundle.project.id).map(file => [file.name, file.content]));
        const result = op.mode === 'argv'
          ? await captureCommand(op.parts[0], op.parts.slice(1), workspace, shellEnv())
          : await captureCommand('sh', ['-c', op.command], workspace, shellEnv());
        const content = `command: ${op.command}\nexit: ${result.code}\n\n${result.output}`;
        const current = bundle.artifacts.find(item => item.name === 'shell-output.txt');
        const baseVersion = current?.versions?.at(-1)?.v || 0;
        const stored = store.putArtifact(bundle.project.id, {
          name: 'shell-output.txt', kind: 'note', content, by: speaker, taskId: task.id, baseVersion, note: `exit ${result.code}`,
        });
        refreshArtifacts(bundle);
        if (!task.artifacts.includes(stored.meta.id)) task.artifacts.push(stored.meta.id);
        if (result.code !== 0) task.lastError = `Shell exited ${result.code}. Read shell-output.txt.`;
        else if (task.lastError.startsWith('Shell exited')) task.lastError = '';
        event(bundle, 'shell.ran', { actor: speaker, taskId: task.id, data: { command: op.command, exit: result.code, id: stored.meta.id, version: stored.version } });
        noteWrittenFiles(bundle.project.id, speaker, task.id, before);
        try { syncWorkspace(bundle, task.id, speaker); }
        catch (error) {
          event(bundle, 'error', { actor: speaker, taskId: task.id, data: { message: error?.message || 'Workspace index failed.' } });
        }
        continue;
      }
      if (op.op === 'handoff') {
        if (task.reviewer === op.to) task.reviewer = task.owner;
        task.owner = op.to;
        task.status = 'submitted';
        task.lease = null;
        event(bundle, 'handoff', { actor: speaker, taskId: task.id, data: { to: op.to, reason: op.reason } });
        continue;
      }
      if (op.op === 'submit') {
        task.status = 'review';
        task.lease = null;
        task.summary = op.summary;
        task.selfCheck = op.selfCheck;
        event(bundle, 'task.state', { actor: speaker, taskId: task.id, data: { status: 'review', summary: op.summary } });
        continue;
      }
      if (op.op === 'ask') {
        task.status = 'input-required';
        task.lease = null;
        task.question = op.question;
        bundle.project.gate = { id: mintCollabId('g'), type: 'ask', summary: op.question, taskId: task.id, op: { to: op.to } };
        event(bundle, 'approval.requested', { actor: speaker, taskId: task.id, data: { type: 'ask', summary: op.question, to: op.to } });
        bundle.project.activity = op.question;
        return;
      }
      if (op.op === 'review') {
        task.reviewNotes = op.notes;
        task.criteria = op.criteria;
        if (op.verdict === 'approve') {
          task.status = 'completed';
          event(bundle, 'review', { actor: speaker, taskId: task.id, data: { verdict: 'approve', notes: op.notes, criteria: op.criteria } });
          commitAcceptedTask(bundle, task);
          rewriteSummary(bundle);
        } else {
          task.reviewAttempts += 1;
          event(bundle, 'review', { actor: speaker, taskId: task.id, data: { verdict: 'changes', notes: op.notes, criteria: op.criteria, reviewAttempts: task.reviewAttempts } });
          if (task.reviewAttempts >= task.maxAttempts) {
            task.status = 'failed';
            task.lastError = 'The reviewer asked for changes until the attempt limit.';
            event(bundle, 'task.state', { taskId: task.id, data: { status: 'failed', reason: task.lastError } });
          } else {
            task.status = 'working';
            task.lease = { holder: task.owner, until: now() + LEASE_MS };
            event(bundle, 'task.state', { taskId: task.id, data: { status: 'working', reason: op.notes } });
          }
        }
      }
    }
  }

  async function finishRun(bundle, run, output, tokens) {
    const speaker = run.speaker;
    const task = run.taskId ? taskById(bundle, run.taskId) : null;
    ensureRuns(bundle.project)[speaker] = null;
    if (tokens) bundle.project.budget.spentTokens += tokens;
    const reject = async message => {
      if (!run.corrective) {
        bundle.project.activity = message;
        await beginTurn(bundle, speaker, task, run.kind, { corrective: true, promptExtra: correctivePrompt(message) });
        return 'corrective';
      }
      event(bundle, 'error', { actor: speaker, taskId: run.taskId, data: { message } });
      if (task && run.kind === 'review') exhaust(bundle, task, message, 'review');
      else if (task && isProtocolMistake(message)) releaseProtocol(bundle, task, message);
      else if (task) exhaust(bundle, task, message, run.kind || 'work');
      else {
        bundle.project.status = 'paused';
        bundle.project.activity = message;
      }
      return 'invalid';
    };
    const parsed = parseCollabBlock(output);
    event(bundle, 'turn.finished', { actor: speaker, taskId: run.taskId, data: { ok: parsed.ok, runId: run.runId } });
    if (!parsed.ok) return reject(parsed.error);
    const problem = checkOps(bundle, speaker, parsed.ops);
    if (problem) return reject(problem);
    try { await applyOps(bundle, speaker, parsed.ops); }
    catch (error) {
      return reject(error?.message || 'That collab block could not be applied.');
    }
    try { syncWorkspace(bundle, run.taskId, speaker); }
    catch (error) {
      event(bundle, 'error', { actor: speaker, taskId: run.taskId, data: { message: error?.message || 'Workspace index failed.' } });
    }
    describeActivity(bundle);
    if (task && speaker === task.owner && task.status === 'working') return 'defer';
    return 'ok';
  }

  async function settleRun(bundle, run) {
    const started = Number(run.started) || 0;
    if (started && now() - started > turnTimeout) {
      try { await gateways.stopSpeaker(run); } catch { /* the transcript still records the timeout */ }
      const task = run.taskId ? taskById(bundle, run.taskId) : null;
      ensureRuns(bundle.project)[run.speaker] = null;
      const message = `${labels[run.speaker]} did not reply within ${Math.max(1, Math.round(turnTimeout / 60000))} minutes, so Orbit stopped that turn.`;
      event(bundle, 'error', { actor: run.speaker, taskId: run.taskId, data: { message } });
      if (task) exhaust(bundle, task, message, run.kind || 'work');
      else {
        bundle.project.status = 'paused';
        bundle.project.activity = message;
      }
      return 'done';
    }
    let view;
    try { view = await gateways.pollSpeaker(run); }
    catch (error) {
      const task = run.taskId ? taskById(bundle, run.taskId) : null;
      ensureRuns(bundle.project)[run.speaker] = null;
      if (task) exhaust(bundle, task, error.message, run.kind || 'work');
      else {
        bundle.project.status = 'paused';
        bundle.project.activity = error.message || 'That speaker could not be reached.';
      }
      return 'done';
    }
    if (view.status === 'running') return 'running';
    if (view.status === 'waiting_for_approval') {
      bundle.project.status = 'paused';
      bundle.project.activity = view.error || `${labels[run.speaker]} is waiting for a tool approval.`;
      return 'waiting';
    }
    if (view.status === 'failed') {
      const task = run.taskId ? taskById(bundle, run.taskId) : null;
      ensureRuns(bundle.project)[run.speaker] = null;
      if (task) exhaust(bundle, task, view.error || 'The speaker failed.', run.kind || 'work');
      else {
        bundle.project.status = 'paused';
        bundle.project.activity = view.error || 'The speaker failed.';
      }
      return 'done';
    }
    return finishRun(bundle, run, view.output || '', view.tokens || 0);
  }

  function releaseProtocol(bundle, task, message) {
    task.protocolHold = true;
    task.lease = null;
    task.lastError = clean(message, 500);
    if (task.status === 'working') task.status = 'submitted';
    event(bundle, 'task.state', { taskId: task.id, data: { status: task.status, reason: task.lastError, protocol: true, retry: true, attempts: task.attempts } });
  }

  function commitAcceptedTask(bundle, task) {
    const dir = store.initWorkspace(bundle.project.id);
    const agent = task.owner;
    const name = labels[agent] || agent;
    const email = `${agent}@collab.orbit`;
    const env = {
      ...process.env,
      GIT_AUTHOR_NAME: name,
      GIT_AUTHOR_EMAIL: email,
      GIT_COMMITTER_NAME: name,
      GIT_COMMITTER_EMAIL: email,
    };
    try {
      spawnSync('git', ['add', '-A'], { cwd: dir, env, timeout: 8000 });
      const pending = spawnSync('git', ['status', '--porcelain'], { cwd: dir, env, timeout: 8000, encoding: 'utf8' });
      if (!String(pending.stdout || '').trim()) return;
      const committed = spawnSync('git', ['commit', '-m', clean(task.title, 200) || 'Accepted task'], { cwd: dir, env, timeout: 8000, encoding: 'utf8' });
      if (committed.status !== 0) {
        event(bundle, 'error', { actor: agent, taskId: task.id, data: { message: clean(committed.stderr || committed.stdout || 'Workspace commit failed.', 300) } });
        return;
      }
      event(bundle, 'workspace.commit', { actor: agent, taskId: task.id, data: { message: task.title } });
    } catch (error) {
      event(bundle, 'error', { actor: agent, taskId: task.id, data: { message: error?.message || 'Workspace commit failed.' } });
    }
  }

  async function advance(bundle) {
    ensureOrchestration(bundle.project);
    for (const task of bundle.tasks) task.protocolHold = false;
    const defer = new Set();
    for (let step = 0; step < 12; step += 1) {
      const runs = ensureRuns(bundle.project);
      let waiting = false;
      let replaced = false;
      for (const agent of AGENTS) {
        const run = runs[agent];
        if (!run) continue;
        const outcome = await settleRun(bundle, run);
        if (outcome === 'waiting') waiting = true;
        if (outcome === 'defer') defer.add(agent);
        const next = ensureRuns(bundle.project)[agent];
        if (next && next.runId !== run.runId) replaced = true;
      }
      const seenSubagents = new Set(bundle.project.subagentRuns.map(item => item.runId));
      for (const run of [...bundle.project.subagentRuns]) {
        if (!seenSubagents.has(run.runId)) continue;
        if (!bundle.project.subagentRuns.some(item => item.runId === run.runId)) continue;
        const outcome = await settleSubagent(bundle, run);
        if (outcome === 'waiting') waiting = true;
      }
      if (bundle.project.subagentRuns.some(item => !seenSubagents.has(item.runId))) replaced = true;
      if (budgetBlocked(bundle, { warn: false }) && bundle.project.status === 'paused') return;
      if (waiting || bundle.project.gate) return;
      if (bundle.project.status !== 'active') return;
      const startedTurn = await scheduleNext(bundle, defer);
      if (!startedTurn && !replaced) return;
    }
  }

  function noteActive(bundle) {
    if (!bundle?.project) return;
    if (bundle.project.status === 'done' || bundle.project.status === 'archived') active.delete(bundle.project.id);
    else active.add(bundle.project.id);
  }

  async function createProject(body) {
    const goal = clean(body.goal, 4000);
    if (!goal) throw fail('Enter a goal for the Collab project.', 400);
    const maxTurns = Number.isInteger(body.max_turns) && body.max_turns >= 1 && body.max_turns <= 200 ? body.max_turns : 40;
    const maxWallMin = Number.isInteger(body.max_wall_min) && body.max_wall_min >= 1 && body.max_wall_min <= 1440 ? body.max_wall_min : 120;
    const maxTokens = Number.isInteger(body.max_tokens) && body.max_tokens >= 1000 && body.max_tokens <= 5000000 ? body.max_tokens : null;
    const definition = Array.isArray(body.definition_of_done) ? body.definition_of_done.map(item => clean(item, 300)).filter(Boolean).slice(0, 8) : [];
    const project = {
      id: mintCollabId('p'),
      title: clean(body.title, 80) || goal.slice(0, 80),
      goal,
      definitionOfDone: definition.length ? definition : [goal],
      status: 'active',
      workspaceId: body.workspaceId || body.workspace_id,
      paneId: body.paneId || body.pane_id || '',
      createdAt: now(),
      updatedAt: now(),
      capabilities: defaultCapabilities(),
      budget: { maxTurns, maxWallMs: maxWallMin * 60 * 1000, maxTokens, spentTurns: 0, spentTokens: 0, warned: false },
      policy: { approve: [...RISKS] },
      memory: { summary: '', decisions: [] },
      gate: null,
      runs: Object.fromEntries(AGENTS.map(agent => [agent, null])),
      orchestratorSource: AGENTS.includes(body.orchestrator) ? body.orchestrator : 'auto',
      orchestrator: AGENTS.includes(body.orchestrator) ? body.orchestrator : chooseAgent('planner', [], defaultCapabilities()),
      subagentLimits: { ...DEFAULT_SUBAGENT_LIMITS },
      subagents: [],
      subagentRuns: [],
      hermesSession: `orbit-${randomUUID()}`,
      grokAgentId: '',
      gatewayAgents: {},
      activity: 'Choosing who should draft the plan.',
      pausedReason: '',
    };
    const bundle = { project, tasks: [], artifacts: [] };
    project.workspace = store.initWorkspace(project.id);
    store.writeProject(project);
    event(bundle, 'project.created', { actor: 'kyle', data: { goal, workspace: project.workspace } });
    const planner = chooseAgent('planner', [], project.capabilities);
    await beginTurn(bundle, planner, null, 'plan');
    await advance(bundle);
    store.save(bundle);
    noteActive(bundle);
    return bundle;
  }

  async function resolveGate(bundle, choice, note) {
    const gate = bundle.project.gate;
    if (!gate) throw fail('Nothing is waiting for approval.', 409);
    if (bundle.project.status === 'paused' && !['plan', 'final', 'ask', 'risk', 'replan', 'scale', 'handoff'].includes(gate.type)) throw fail('Resume the project before resolving that gate.', 409);
    const text = clean(note, 2000);
    if (choice === 'approve' && gate.type === 'risk' && gate.op) {
      const taskId = gate.taskId;
      const op = { ...gate.op, risk: '' };
      const actor = AGENTS.includes(gate.by) ? gate.by : 'kyle';
      bundle.project.gate = null;
      await applyOps(bundle, actor, [op]);
      const task = taskById(bundle, taskId);
      if (task && task.status === 'input-required') {
        task.status = 'working';
        task.lease = { holder: task.owner, until: now() + LEASE_MS };
      }
      event(bundle, 'approval.resolved', { actor: 'kyle', taskId, data: { choice, type: 'risk' } });
      return;
    }
    bundle.project.gate = null;
    event(bundle, 'approval.resolved', { actor: 'kyle', taskId: gate.taskId, data: { choice, type: gate.type, note: text } });
    if (text) {
      bundle.project.memory.decisions.push({ id: mintCollabId('dec'), text, by: 'kyle', at: now() });
      rewriteSummary(bundle);
    }
    if (gate.type === 'plan') {
      if (choice === 'reject') {
        for (const task of bundle.tasks) if (task.status === 'submitted') task.status = 'canceled';
        bundle.project.activity = 'Plan rejected. Ask for a new plan from Collab, or edit the goal and start again.';
        bundle.project.status = 'paused';
      } else bundle.project.activity = 'Plan approved.';
      return;
    }
    if (gate.type === 'final') {
      if (choice === 'approve') {
        bundle.project.status = 'done';
        bundle.project.activity = 'Kyle accepted this project.';
      } else {
        bundle.project.status = 'paused';
        bundle.project.activity = 'Kyle rejected the final result.';
      }
      return;
    }
    if (gate.type === 'replan') {
      if (choice === 'reject') {
        for (const id of gate.op?.taskIds || []) {
          const task = taskById(bundle, id);
          if (task && task.status === 'submitted') task.status = 'canceled';
        }
        bundle.project.activity = 'Revised plan rejected.';
      } else bundle.project.activity = 'Revised plan approved.';
      return;
    }
    if (gate.type === 'scale' || gate.type === 'handoff') {
      const ids = gate.op?.subagentIds || [];
      if (choice === 'approve') {
        for (const id of ids) {
          const sub = subagentById(bundle.project, id);
          if (!sub || sub.status !== 'pending-approval') continue;
          if (gate.type === 'handoff') await openHeldSubagent(bundle, sub);
          else await startSubagentTurn(bundle, sub);
        }
        bundle.project.activity = gate.type === 'handoff' ? 'Kyle can talk to that subagent directly.' : 'Subagents started.';
      } else {
        for (const id of ids) {
          const sub = subagentById(bundle.project, id);
          if (!sub || sub.status !== 'pending-approval') continue;
          sub.status = 'canceled';
          removeWorktree(bundle.project.workspace, sub);
          event(bundle, 'subagent.canceled', { actor: 'kyle', taskId: sub.taskId, data: { subagentId: sub.id } });
        }
        bundle.project.activity = gate.type === 'handoff' ? 'Handoff canceled.' : 'Subagent batch canceled.';
      }
      return;
    }
    if (gate.type === 'ask' || gate.type === 'risk') {
      const task = taskById(bundle, gate.taskId);
      if (task && task.status === 'input-required') {
        task.status = choice === 'approve' || gate.type === 'ask' ? 'working' : 'working';
        task.lease = { holder: task.owner, until: now() + LEASE_MS };
        if (choice === 'reject' && gate.type === 'risk') task.lastError = 'Kyle rejected that risky operation.';
        if (text) task.reviewNotes = text;
      }
    }
  }

  function reassign(bundle, body) {
    const task = taskById(bundle, body.task_id);
    if (!task) throw fail('Unknown Collab task.', 404);
    if (busyTaskIds(bundle.project).has(task.id)) throw fail('That task is in a turn. Wait, or pause after it finishes.', 409);
    const owner = body.owner === undefined ? task.owner : body.owner;
    const reviewer = body.reviewer === undefined ? task.reviewer : body.reviewer;
    const role = body.role === undefined ? task.role : body.role;
    if (!AGENTS.includes(owner) || !AGENTS.includes(reviewer)) throw fail('Owner and reviewer must be Hermes or Grok Bot.', 400);
    if (owner === reviewer) throw fail('Reviewer must be a different agent than the owner.', 400);
    if (!ROLES.includes(role)) throw fail('Choose a planner, executor, reviewer, or researcher role.', 400);
    task.owner = owner;
    task.reviewer = reviewer;
    task.role = role;
    if (task.status === 'working') task.lease = { holder: owner, until: now() + LEASE_MS };
    event(bundle, 'handoff', { actor: 'kyle', taskId: task.id, data: { to: owner, reviewer, role, reason: 'Kyle reassigned the task.' } });
  }

  function updateCapabilities(bundle, body) {
    const next = body.capabilities;
    if (!next || typeof next !== 'object') throw fail('Send capabilities for the Collab agents.', 400);
    for (const agent of AGENTS) {
      const skills = asSkills(next[agent]?.skills);
      if (!skills.length) throw fail(`Give ${labels[agent]} at least one skill.`, 400);
      bundle.project.capabilities[agent] = { skills };
    }
    event(bundle, 'decision', { actor: 'kyle', data: { text: 'Updated agent capability profiles.' } });
  }

  async function operate(body) {
    const operation = body.operation || 'state';
    if (operation === 'list') {
      const projects = store.listProjects()
        .filter(project => project.workspaceId === body.workspace_id)
        .map(project => ({ id: project.id, title: project.title, goal: project.goal, status: project.status, updatedAt: project.updatedAt, gate: project.gate?.type || '' }));
      return { projects };
    }
    if (operation === 'create') {
      const bundle = await createProject(body);
      return publicState(bundle);
    }
    if (!body.project_id) throw fail('Choose a Collab project.', 400);
    const bundle = store.load(body.project_id);
    if (bundle.project.workspaceId !== body.workspace_id) throw fail('Unknown Collab project.', 404);
    ensureOrchestration(bundle.project);
    if (!bundle.project.workspace) bundle.project.workspace = store.initWorkspace(bundle.project.id);
    if (operation === 'state' || operation === 'advance') await advance(bundle);
    else if (operation === 'resolve') {
      if (!['approve', 'reject'].includes(body.choice)) throw fail('Approve or reject the waiting gate.', 400);
      await resolveGate(bundle, body.choice, body.note);
      if (bundle.project.status === 'active') await advance(bundle);
    }     else if (operation === 'reassign') reassign(bundle, body);
    else if (operation === 'capabilities') updateCapabilities(bundle, body);
    else if (operation === 'set_orchestrator') {
      const choice = body.orchestrator;
      if (choice !== 'auto' && !AGENTS.includes(choice)) throw fail('Orchestrator must be auto or one of the Collab agents.', 400);
      bundle.project.orchestratorSource = choice;
      bundle.project.orchestrator = choice === 'auto' ? chooseAgent('planner', [], bundle.project.capabilities) : choice;
      event(bundle, 'decision', { actor: 'kyle', data: { text: `Orchestrator is ${labels[bundle.project.orchestrator]}.` } });
    } else if (operation === 'subagent_limits') {
      const maxConcurrent = Number(body.max_concurrent);
      const maxDepth = Number(body.max_depth);
      if (!Number.isInteger(maxConcurrent) || maxConcurrent < 1 || maxConcurrent > 4) throw fail('Concurrent subagents must be from 1 to 4.', 400);
      if (maxDepth !== 1 && maxDepth !== 2) throw fail('Subagent depth must be 1 or 2.', 400);
      bundle.project.subagentLimits = { maxConcurrent, maxDepth };
      event(bundle, 'decision', { actor: 'kyle', data: { text: `Subagent limits are ${maxConcurrent} at once and depth ${maxDepth}.` } });
    } else if (operation === 'cancel_subagent') {
      const sub = subagentById(bundle.project, body.subagent_id);
      if (!sub) throw fail('Unknown subagent.', 404);
      const run = bundle.project.subagentRuns.find(item => item.subagentId === sub.id);
      if (run) {
        try { await gateways.stopSpeaker(run); } catch { /* cancellation still stands */ }
        dropSubagentRun(bundle.project, run.runId);
      }
      sub.status = 'canceled';
      removeWorktree(bundle.project.workspace, sub);
      await archiveSubagent(bundle, sub);
      event(bundle, 'subagent.canceled', { actor: 'kyle', taskId: sub.taskId, data: { subagentId: sub.id } });
      bundle.project.activity = `${sub.name} canceled.`;
    } else if (operation === 'subagent_transcript') {
      const sub = subagentById(bundle.project, body.subagent_id);
      if (!sub) throw fail('Unknown subagent.', 404);
      let messages = sub.transcript || [];
      if (typeof gateways.readSubagentTranscript === 'function') {
        try {
          const remote = await gateways.readSubagentTranscript(sub);
          if (remote?.messages?.length) messages = remote.messages.map(item => ({ role: item.role || 'assistant', text: item.text || '' }));
        } catch { /* the stored transcript remains readable */ }
      }
      store.save(bundle);
      noteActive(bundle);
      return { transcript: { id: sub.id, name: sub.name, status: sub.status, resumable: sub.status === 'ready-for-kyle' || sub.status === 'running', messages } };
    }
    else if (operation === 'pause') {
      bundle.project.status = 'paused';
      const running = AGENTS.filter(agent => ensureRuns(bundle.project)[agent]).map(agent => labels[agent]);
      bundle.project.activity = running.length ? `${running.join(' and ')} will finish this turn, then the project stays paused.` : 'Paused.';
    } else if (operation === 'resume' || operation === 'continue') {
      if (bundle.project.budget.spentTurns >= bundle.project.budget.maxTurns || now() - bundle.project.createdAt >= bundle.project.budget.maxWallMs) {
        throw fail('Budget reached. Raise the budget or accept the project as far as it got.', 409);
      }
      bundle.project.status = 'active';
      bundle.project.activity = '';
      await advance(bundle);
    } else if (operation === 'stop') {
      await stopRuns(bundle);
      bundle.project.status = 'paused';
      bundle.project.activity = 'Stopped.';
      event(bundle, 'task.state', { data: { status: 'paused', reason: 'Kyle stopped the project.' } });
    } else if (operation === 'archive') {
      await stopRuns(bundle);
      bundle.project.status = 'archived';
      bundle.project.activity = 'Archived.';
      event(bundle, 'project.archived', { actor: 'kyle', data: { goal: bundle.project.goal } });
    } else if (operation === 'delete') {
      await stopRuns(bundle);
      const id = bundle.project.id;
      store.removeProject(id);
      active.delete(id);
      return { deleted: true, id };
    } else if (operation === 'artifact') {
      const stored = store.readArtifact(bundle.project.id, body.artifact_id, Number.isInteger(body.version) ? body.version : 0);
      store.save(bundle);
      noteActive(bundle);
      return { artifact: publicArtifact(stored.meta), version: stored.version, content: stored.content };
    } else throw fail('Unknown collab operation.', 400);
    store.save(bundle);
    noteActive(bundle);
    return publicState(bundle);
  }

  function publicTask(task) {
    return {
      id: task.id,
      title: task.title,
      spec: task.spec,
      acceptance: task.acceptance,
      dependsOn: task.dependsOn,
      owner: task.owner,
      reviewer: task.reviewer,
      role: task.role,
      skillsHint: task.skillsHint,
      status: task.status,
      attempts: task.attempts,
      reviewAttempts: task.reviewAttempts,
      maxAttempts: task.maxAttempts,
      leaseUntil: task.lease?.until || 0,
      artifacts: task.artifacts,
      summary: task.summary,
      reviewNotes: task.reviewNotes,
      lastError: task.lastError,
    };
  }

  function publicArtifact(meta) {
    return {
      id: meta.id,
      name: meta.name,
      kind: meta.kind,
      taskId: meta.taskId || '',
      versions: (meta.versions || []).map(item => ({ v: item.v, by: item.by, at: item.at, note: item.note || '' })),
    };
  }

  function publicState(bundle) {
    const project = bundle.project;
    const runs = ensureRuns(project);
    const presence = AGENTS.filter(agent => runs[agent]).map(agent => ({
      agent,
      taskId: runs[agent].taskId || '',
      kind: runs[agent].kind || '',
      taskTitle: bundle.tasks.find(task => task.id === runs[agent].taskId)?.title || '',
    }));
    const events = store.readEvents(project.id).slice(-80).map(item => ({
      id: item.id, at: item.at, actor: item.actor, type: item.type, taskId: item.taskId || '', data: item.data || {},
    }));
    return {
      project: {
        id: project.id,
        title: project.title,
        goal: project.goal,
        definitionOfDone: project.definitionOfDone,
        status: project.status,
        activity: project.activity || '',
        capabilities: project.capabilities,
        budget: {
          maxTurns: project.budget.maxTurns,
          maxWallMin: Math.round(project.budget.maxWallMs / 60000),
          maxTokens: project.budget.maxTokens,
          spentTurns: project.budget.spentTurns,
          spentTokens: project.budget.spentTokens,
          warned: project.budget.warned === true,
        },
        summary: project.memory.summary || '',
        decisions: project.memory.decisions,
        orchestrator: project.orchestrator || '',
        orchestratorSource: project.orchestratorSource || 'auto',
        subagentLimits: project.subagentLimits || { ...DEFAULT_SUBAGENT_LIMITS },
        gate: project.gate ? { id: project.gate.id, type: project.gate.type, summary: project.gate.summary, taskId: project.gate.taskId || '' } : null,
      },
      subagents: (project.subagents || []).map(sub => ({
        id: sub.id,
        name: sub.name,
        parent: sub.parent,
        parentSubagentId: sub.parentSubagentId || '',
        depth: sub.depth || 1,
        taskId: sub.taskId,
        status: sub.status,
        mode: sub.mode || 'tool',
        provider: sub.provider,
        files: sub.files || [],
        branch: sub.branch || '',
        worktree: sub.worktree || '',
        strategy: sub.strategy || '',
        brief: sub.brief || null,
        result: sub.result || null,
        spentTurns: sub.spentTurns || 0,
        spentTokens: sub.spentTokens || 0,
        budgetTurns: sub.brief?.budget?.turns || 0,
        budgetMinutes: sub.brief?.budget?.minutes || 0,
        attempts: sub.attempts || 0,
        archived: sub.archived === true,
        lastError: sub.lastError || '',
        merged: sub.merged === true,
      })),
      tasks: bundle.tasks.map(task => {
        const view = publicTask(task);
        if (project.gate?.type === 'plan' && view.status === 'submitted') view.status = 'planned';
        return view;
      }),
      artifacts: bundle.artifacts.map(publicArtifact),
      events,
      workspace: project.workspace || '',
      running: presence.map(item => item.agent).join(','),
      presence,
    };
  }

  function chain(key, work) {
    const previous = chains.get(key) || Promise.resolve();
    const result = previous.catch(() => {}).then(work);
    chains.set(key, result);
    return result;
  }

  async function tick(id) {
    let bundle;
    try { bundle = store.load(id); }
    catch { active.delete(id); return; }
    ensureRuns(bundle.project);
    if (!bundle.project.workspace) bundle.project.workspace = store.initWorkspace(bundle.project.id);
    await advance(bundle);
    store.save(bundle);
    noteActive(bundle);
  }

  function scanActive() {
    for (const project of store.listProjects()) {
      if (project.status === 'active' || project.status === 'paused' || project.run || project.runs?.hermes || project.runs?.grok) active.add(project.id);
    }
  }
  scanActive();
  const timer = setInterval(() => {
    try { fs.readdirSync(directory); }
    catch { clearInterval(timer); return; }
    for (const id of [...active]) chain(id, () => tick(id)).catch(() => {});
  }, advanceEvery);
  timer.unref();

  function handle(reply, res, body) {
    const key = body.project_id || `workspace:${body.workspace_id || ''}`;
    return chain(key, () => operate(body)).then(state => reply(res, 200, state)).catch(error => {
      const status = Number.isInteger(error?.status) ? error.status : 502;
      let message = typeof error?.message === 'string' ? error.message : '';
      if (!message.trim() || message.length > 500) message = 'The Collab project could not complete that request.';
      if (res.headersSent || res.writableEnded) { try { res.end(); } catch {} return; }
      try { return reply(res, status, { error: message }); }
      catch { try { res.end(); } catch {} }
    });
  }

  return {
    handle,
    openFromRoom(args) {
      const key = `workspace:${args.workspaceId || ''}`;
      return chain(key, () => createProject({ ...args, workspace_id: args.workspaceId, pane_id: args.paneId })).then(bundle => ({ id: bundle.project.id, goal: bundle.project.goal }));
    },
  };
}
