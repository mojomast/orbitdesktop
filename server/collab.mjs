import fs from 'node:fs';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createCollabStore, mintCollabId } from './collab-store.mjs';

const AGENTS = ['hermes', 'grok'];
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
const DEFAULT_TURN_TIMEOUT_MS = 3 * 60 * 1000;
const DEFAULT_ADVANCE_INTERVAL_MS = 15 * 1000;
const labels = { hermes: 'Hermes', grok: 'Grok Bot', kyle: 'Kyle', orbit: 'Orbit' };

const OPS = ['plan', 'claim', 'artifact.put', 'handoff', 'submit', 'review', 'ask', 'decision', 'run-tests', 'workspace.sync'];
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

const INSTRUCTIONS = `You are working in Orbit Collab. Orbit owns the task board, the budget, and approvals. Propose every change by ending your reply with exactly one fenced collab block of strict JSON, for example:
\`\`\`collab
{"ops":[{"op":"claim","taskId":"t_example"},{"op":"artifact.put","name":"notes.md","kind":"note","content":"...","taskId":"t_example","baseVersion":0},{"op":"submit","taskId":"t_example","summary":"...","artifacts":[],"selfCheck":{}}]}
\`\`\`
Allowed ops are ${OPS.join(', ')}. A task reviewer must be the other agent, never the owner. Do not invent a second block.
artifact.put names may be relative paths such as src/app.js. kind is file, note, or test. baseVersion is the version you last read, or 0 for a new name. If Orbit says the version moved, read it again before writing.
run-tests runs one allowlisted command in the project workspace and stores the output as test-results.txt: npm test, npm run test, pnpm test, yarn test, pytest, python -m pytest, python3 -m pytest, or node --test. Extra arguments must be plain tokens.
workspace.sync indexes files written in the workspace, including files Hermes created with the terminal. Grok Bot reads and writes through artifact.put.`;

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
  if (extra.some(arg => !/^[\w./:=@-]{1,80}$/.test(arg))) return null;
  return parts;
}

function runAllowedTests(parts, cwd) {
  return new Promise(resolve => {
    let output = '';
    let child;
    try {
      child = spawn(parts[0], parts.slice(1), { cwd, env: { ...process.env, CI: '1' }, timeout: 60000 });
    } catch (error) {
      resolve({ code: 127, output: error?.message || 'The test command could not start.' });
      return;
    }
    const take = chunk => {
      if (output.length >= 20000) return;
      output += String(chunk);
      if (output.length > 20000) output = output.slice(0, 20000);
    };
    child.stdout?.on('data', take);
    child.stderr?.on('data', take);
    child.on('error', error => resolve({ code: 127, output: `${output}${error?.message || 'The test command could not start.'}`.slice(0, 20000) }));
    child.on('close', code => resolve({ code: code ?? 1, output: output.trim() || '(no output)' }));
  });
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

function normalizeAgent(value) {
  const name = clean(value, 40).toLowerCase();
  if (name === 'hermes') return 'hermes';
  if (name === 'grok' || name === 'grok bot') return 'grok';
  return '';
}

export function defaultCapabilities() {
  return {
    hermes: { skills: ['terminal', 'tools', 'code'] },
    grok: { skills: ['research', 'reasoning', 'writing'] },
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
      if (!AGENTS.includes(raw.to)) return { error: 'handoff.to must be hermes or grok.' };
      const reason = clean(raw.reason, 1000);
      if (!reason) return { error: 'handoff needs a reason.' };
      return { op: { op, taskId, to: raw.to, reason } };
    }
    if (op === 'submit') {
      const summary = clean(raw.summary, 4000);
      if (!summary) return { error: 'submit needs a summary.' };
      const artifacts = Array.isArray(raw.artifacts) ? raw.artifacts.map(item => clean(item, 40)).filter(item => /^a_[a-f0-9]{16}$/.test(item)).slice(0, 8) : [];
      const selfCheck = raw.selfCheck && typeof raw.selfCheck === 'object' && !Array.isArray(raw.selfCheck) ? raw.selfCheck : {};
      return { op: { op, taskId, summary, artifacts, selfCheck } };
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
  if (op === 'run-tests' || op === 'workspace.sync') {
    const taskId = clean(raw.taskId, 40);
    if (!/^t_[a-f0-9]{16}$/.test(taskId)) return { error: `${op} needs a taskId.` };
    if (op === 'workspace.sync') return { op: { op, taskId } };
    const command = clean(raw.command, 200) || 'npm test';
    if (!parseTestCommand(command)) return { error: 'run-tests accepts npm test, npm run test, pnpm test, yarn test, pytest, python -m pytest, python3 -m pytest, or node --test. Extra arguments must be plain tokens with no shell syntax.' };
    return { op: { op, taskId, command } };
  }
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

function collabTurnTimeoutMs(env = process.env) {
  const raw = Number(env?.ORBIT_COLLAB_TURN_TIMEOUT_MS ?? env?.ORBIT_SHARED_TURN_TIMEOUT_MS);
  if (Number.isFinite(raw) && raw >= 1000 && raw <= 30 * 60 * 1000) return Math.floor(raw);
  return DEFAULT_TURN_TIMEOUT_MS;
}

export function createCollab({ directory, gateways, now = () => Date.now(), advanceIntervalMs, turnTimeoutMs } = {}) {
  const store = createCollabStore(directory);
  const turnTimeout = Number.isFinite(turnTimeoutMs) && turnTimeoutMs >= 1000 ? Math.floor(turnTimeoutMs) : collabTurnTimeoutMs();
  const advanceEvery = Number.isFinite(advanceIntervalMs) && advanceIntervalMs >= 15 ? Math.floor(advanceIntervalMs) : DEFAULT_ADVANCE_INTERVAL_MS;
  const chains = new Map();
  const active = new Set();

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
    return agent === 'hermes' ? 'grok' : 'hermes';
  }

  function ensureRuns(project) {
    if (!project.runs || typeof project.runs !== 'object' || Array.isArray(project.runs)) project.runs = { hermes: null, grok: null };
    if (project.run?.speaker && AGENTS.includes(project.run.speaker) && !project.runs[project.run.speaker]) project.runs[project.run.speaker] = project.run;
    delete project.run;
    for (const agent of AGENTS) if (!project.runs[agent]) project.runs[agent] = null;
    return project.runs;
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
      const stored = store.putArtifact(bundle.project.id, {
        name: file.name, kind: 'file', content: file.content, by, taskId: taskId || '', baseVersion: latest, note: 'Indexed from the workspace.',
      });
      refreshArtifacts(bundle);
      if (taskId) {
        const task = taskById(bundle, taskId);
        if (task && !task.artifacts.includes(stored.meta.id)) task.artifacts.push(stored.meta.id);
      }
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
    const project = bundle.project;
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
Capabilities: Hermes (${project.capabilities.hermes.skills.join(', ')}); Grok Bot (${project.capabilities.grok.skills.join(', ')})
Workspace directory: ${project.workspace || '(not ready)'}
Hermes can read and write that directory with the terminal. Orbit indexes those files as artifacts after a Hermes turn and when workspace.sync runs. Grok Bot reads and writes through artifact.put. Either agent can run-tests there.
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
owner and reviewer must be hermes or grok. Hermes and Grok Bot are accepted names for those ids. The reviewer must not be the owner. Omit either one and Orbit assigns from skills.
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
    try {
      const started = await gateways.startSpeaker({
        speaker,
        prompt,
        instructions: INSTRUCTIONS,
        hermesSession: project.hermesSession,
        grokAgentId: project.grokAgentId,
        grokAgentName: 'Orbit collab',
      });
      if (started.agentId) project.grokAgentId = started.agentId;
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
      if (task) exhaust(bundle, task, message);
      else {
        project.status = 'paused';
        project.activity = message;
      }
      return false;
    }
  }

  function exhaust(bundle, task, reason) {
    task.attempts += 1;
    task.lease = null;
    task.lastError = clean(reason, 500);
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
      exhaust(bundle, task, 'The task lease expired.');
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
      const review = bundle.tasks.find(task => task.status === 'review' && task.reviewer === agent && depsReady(bundle, task) && !busy.has(task.id));
      const ready = bundle.tasks.find(task => task.status === 'submitted' && task.owner === agent && depsReady(bundle, task) && !busy.has(task.id));
      const working = deferAgents.has(agent) ? null : bundle.tasks.find(task => task.status === 'working' && task.owner === agent && task.lease && now() <= task.lease.until && depsReady(bundle, task) && !busy.has(task.id));
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
    const open = bundle.tasks.filter(task => !['canceled', 'failed'].includes(task.status));
    for (const op of ops) {
      if (op.op === 'plan') {
        if (open.length) return 'A plan can only be proposed before live tasks exist.';
        continue;
      }
      if (op.op === 'decision') continue;
      const task = taskById(bundle, op.taskId);
      if (!task) return 'That task is not on the board.';
      if (op.op === 'review') {
        if (speaker !== task.reviewer) return 'Only the reviewer can review this task.';
        if (task.status !== 'review') return 'That task is not in review.';
        continue;
      }
      if (speaker !== task.owner && op.op !== 'ask') return 'Only the task owner can do that.';
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

  async function applyOps(bundle, speaker, ops) {
    for (const op of ops) {
      if (op.risk && bundle.project.policy.approve.includes(op.risk)) {
        const task = taskById(bundle, op.taskId);
        if (task) task.status = 'input-required';
        bundle.project.gate = { id: mintCollabId('g'), type: 'risk', summary: `${labels[speaker]} wants to use ${op.risk}.`, taskId: op.taskId || '', op };
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
      if (task) exhaust(bundle, task, message);
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
    if (speaker === 'hermes') {
      try { syncWorkspace(bundle, run.taskId, 'hermes'); }
      catch (error) {
        event(bundle, 'error', { actor: 'hermes', taskId: run.taskId, data: { message: error?.message || 'Workspace index failed.' } });
      }
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
      if (task) exhaust(bundle, task, message);
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
      if (task) exhaust(bundle, task, error.message);
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
      if (task) exhaust(bundle, task, view.error || 'The speaker failed.');
      else {
        bundle.project.status = 'paused';
        bundle.project.activity = view.error || 'The speaker failed.';
      }
      return 'done';
    }
    return finishRun(bundle, run, view.output || '', view.tokens || 0);
  }

  async function advance(bundle) {
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
      runs: { hermes: null, grok: null },
      hermesSession: `orbit-${randomUUID()}`,
      grokAgentId: '',
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
    if (bundle.project.status === 'paused' && gate.type !== 'plan' && gate.type !== 'final' && gate.type !== 'ask' && gate.type !== 'risk') throw fail('Resume the project before resolving that gate.', 409);
    const text = clean(note, 2000);
    if (choice === 'approve' && gate.type === 'risk' && gate.op) {
      const taskId = gate.taskId;
      const op = { ...gate.op, risk: '' };
      bundle.project.gate = null;
      await applyOps(bundle, 'kyle', [op]);
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
    if (!next || typeof next !== 'object') throw fail('Send capabilities for Hermes and Grok Bot.', 400);
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
    ensureRuns(bundle.project);
    if (!bundle.project.workspace) bundle.project.workspace = store.initWorkspace(bundle.project.id);
    if (operation === 'state' || operation === 'advance') await advance(bundle);
    else if (operation === 'resolve') {
      if (!['approve', 'reject'].includes(body.choice)) throw fail('Approve or reject the waiting gate.', 400);
      await resolveGate(bundle, body.choice, body.note);
      if (bundle.project.status === 'active') await advance(bundle);
    } else if (operation === 'reassign') reassign(bundle, body);
    else if (operation === 'capabilities') updateCapabilities(bundle, body);
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
        gate: project.gate ? { id: project.gate.id, type: project.gate.type, summary: project.gate.summary, taskId: project.gate.taskId || '' } : null,
      },
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
