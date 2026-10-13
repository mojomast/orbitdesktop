import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

export const DEFAULT_SUBAGENT_LIMITS = { maxConcurrent: 3, maxDepth: 1 };
const AGENTS = ['hermes', 'grok'];

function clean(value, max) {
  return String(value || '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max);
}

export function relativeFile(value) {
  const name = clean(value, 120);
  if (!name || name.startsWith('/') || name.includes('\\')) return '';
  const parts = name.split('/');
  if (parts.some(part => !part || part === '.' || part === '..' || !/^[\w. -]{1,80}$/.test(part))) return '';
  return name;
}

export function projectedCost(effort, budget) {
  const turns = effort * budget.turns;
  const minutes = effort * budget.minutes;
  const turnLabel = turns === 1 ? 'turn' : 'turns';
  const minuteLabel = minutes === 1 ? 'minute' : 'minutes';
  return { turns, minutes, text: `Projected cost is ${turns} ${turnLabel} and ${minutes} ${minuteLabel}.` };
}

export function spanData({ name, spanId, parentSpanId = '', agent, status, startedAt, endedAt = 0, summary = '' }) {
  return {
    'gen_ai.operation.name': name,
    'gen_ai.agent.name': agent,
    'gen_ai.operation.status': status,
    spanId,
    parentSpanId,
    startedAt,
    endedAt,
    summary: summary || `${name} ${status}`,
  };
}

function parseBrief(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { error: 'spawn.brief must be an object with objective, deliverable, acceptance, tools, scope, budget, and returnFormat.' };
  const objective = clean(raw.objective, 1000);
  const deliverable = clean(raw.deliverable, 1000);
  const scope = clean(raw.scope, 1000);
  const returnFormat = clean(raw.returnFormat || raw.return, 500);
  if (!objective || !deliverable || !scope || !returnFormat) return { error: 'spawn.brief needs objective, deliverable, scope, and returnFormat (summary and artifact paths).' };
  if (!Array.isArray(raw.acceptance) || raw.acceptance.length < 1 || raw.acceptance.length > 8) return { error: 'spawn.brief.acceptance needs 1–8 criteria.' };
  const acceptance = raw.acceptance.map(item => clean(item, 500)).filter(Boolean);
  if (acceptance.length !== raw.acceptance.length) return { error: 'spawn.brief has an empty acceptance criterion.' };
  const tools = Array.isArray(raw.tools) ? raw.tools.map(item => clean(item, 40)).filter(Boolean).slice(0, 12) : [];
  const budget = raw.budget && typeof raw.budget === 'object' && !Array.isArray(raw.budget) ? raw.budget : {};
  const turns = Number(budget.turns);
  const minutes = Number(budget.minutes);
  if (!Number.isInteger(turns) || turns < 1 || turns > 20) return { error: 'spawn.brief.budget.turns must be an integer from 1 to 20.' };
  if (!Number.isInteger(minutes) || minutes < 1 || minutes > 30) return { error: 'spawn.brief.budget.minutes must be an integer from 1 to 30.' };
  return { brief: { objective, deliverable, acceptance, tools, scope, budget: { turns, minutes }, returnFormat } };
}

export function parseOrchestratorOp(raw) {
  const op = raw.op;
  if (op === 'status') {
    const text = clean(raw.text, 2000);
    if (!text) return { error: 'status needs text.' };
    return { op: { op, text } };
  }
  if (op === 'assign') {
    const taskId = clean(raw.taskId, 40);
    if (!/^t_[a-f0-9]{16}$/.test(taskId)) return { error: 'assign needs a taskId.' };
    if (!AGENTS.includes(raw.to)) return { error: 'assign.to must be hermes or grok.' };
    const reason = clean(raw.reason, 1000);
    if (!reason) return { error: 'assign needs a reason.' };
    return { op: { op, taskId, to: raw.to, reason } };
  }
  if (op === 'merge') {
    const taskId = clean(raw.taskId, 40);
    const subagentId = clean(raw.subagentId, 40);
    if (!/^t_[a-f0-9]{16}$/.test(taskId)) return { error: 'merge needs a taskId.' };
    if (!/^s_[a-f0-9]{16}$/.test(subagentId)) return { error: 'merge needs a subagentId.' };
    if (raw.push === true) return { error: 'Kyle approves a push separately. Drop push from merge.' };
    return { op: { op, taskId, subagentId } };
  }
  if (op !== 'spawn') return { error: `Unknown collab op "${clean(op, 40)}".` };
  const taskId = clean(raw.taskId, 40);
  if (!/^t_[a-f0-9]{16}$/.test(taskId)) return { error: 'spawn needs a taskId.' };
  const name = clean(raw.name, 60);
  if (!name) return { error: 'spawn needs a name.' };
  const effort = raw.effort === undefined ? 1 : Number(raw.effort);
  if (!Number.isInteger(effort) || effort < 1 || effort > 4) return { error: 'spawn.effort must be an integer from 1 to 4.' };
  const mode = raw.mode === 'handoff' ? 'handoff' : raw.mode === undefined || raw.mode === 'tool' ? 'tool' : '';
  if (!mode) return { error: 'spawn.mode must be tool or handoff.' };
  const audience = raw.audience === 'kyle' ? 'kyle' : '';
  if (mode === 'handoff' && audience !== 'kyle') return { error: 'A handoff is only for when Kyle should talk to that agent. Use mode tool so the worker returns a result.' };
  const files = [];
  if (Array.isArray(raw.files)) {
    if (raw.files.length > 16) return { error: 'spawn.files can list at most 16 paths.' };
    for (const item of raw.files) {
      const file = relativeFile(item);
      if (!file) return { error: 'spawn.files must be relative paths with no .. segments.' };
      files.push(file);
    }
  }
  const parsed = parseBrief(raw.brief);
  if (parsed.error) return parsed;
  return { op: { op, taskId, name, effort, mode, audience, files, brief: parsed.brief } };
}

export function admitSpawn({ limits, parent, active, effort, files, depth, objective, taskId, chain = [] }) {
  const maxConcurrent = limits?.maxConcurrent || DEFAULT_SUBAGENT_LIMITS.maxConcurrent;
  const maxDepth = limits?.maxDepth || DEFAULT_SUBAGENT_LIMITS.maxDepth;
  if (depth > maxDepth) return `Subagent depth ${depth} is above the cap of ${maxDepth}.`;
  const seen = new Set();
  for (const node of chain) {
    if (!node?.id || seen.has(node.id)) return 'That spawn loops back to an earlier subagent.';
    seen.add(node.id);
    if (node.taskId === taskId && node.brief?.objective === objective) return 'That spawn repeats a parent brief on the same task.';
  }
  const busy = (active || []).filter(item => item.parent === parent && ['running', 'pending-approval', 'waiting-for-kyle', 'ready-for-kyle'].includes(item.status));
  if (busy.length + effort > maxConcurrent) return `This agent can run ${maxConcurrent} subagents at once.`;
  if (files.length && effort > 1) return 'Split files across separate spawn ops so each coding subagent owns different files.';
  const claimed = new Set();
  for (const item of active || []) {
    if (!['running', 'pending-approval', 'waiting-for-kyle', 'ready-for-kyle', 'completed'].includes(item.status)) continue;
    if (item.status === 'completed' && item.merged) continue;
    for (const file of item.files || []) claimed.add(file);
    if (item.taskId === taskId && item.brief?.objective === objective && ['running', 'pending-approval', 'waiting-for-kyle'].includes(item.status)) {
      return 'That subagent is already running for this task.';
    }
  }
  for (const file of files) {
    if (claimed.has(file)) return `File ${file} already has a writer.`;
  }
  return '';
}

export function mergeBlocked(sub, subagents, tasks) {
  const task = (tasks || []).find(item => item.id === sub.taskId);
  const deps = new Set(task?.dependsOn || []);
  const earlier = (subagents || []).find(item => item.id !== sub.id && item.status === 'completed' && !item.merged && deps.has(item.taskId));
  if (earlier) return `Merge ${earlier.name} first.`;
  return '';
}

export function subagentPrompt({ goal, task, brief, worktree, isolated }) {
  return [
    'You are a Collab subagent. Return a structured result to your parent. This is not a handoff of the conversation.',
    `Project goal: ${goal}`,
    `Objective: ${brief.objective}`,
    `Deliverable: ${brief.deliverable}`,
    `Acceptance: ${brief.acceptance.join('; ')}`,
    `Allowed tools: ${brief.tools.join(', ') || '(none named)'}`,
    `Scope: ${brief.scope}`,
    `Budget: ${brief.budget.turns} turns, ${brief.budget.minutes} minutes.`,
    `Return format: ${brief.returnFormat}`,
    `Work directory: ${worktree || '(workspace)'}`,
    isolated ? 'This directory is your git worktree and branch. Stay inside it. Do not push.' : 'Stay inside this directory. Do not push.',
    `Task ${task.id}: ${task.title}`,
    `Spec: ${task.spec}`,
    'End with one ```collab JSON block that includes a submit op with summary and paths. paths are relative artifact files. A spawn op is allowed only when your brief asks for one nested worker.',
  ].join('\n');
}

export function gitEnv() {
  return {
    ...process.env,
    GIT_AUTHOR_NAME: 'Orbit',
    GIT_AUTHOR_EMAIL: 'orbit@collab.orbit',
    GIT_COMMITTER_NAME: 'Orbit',
    GIT_COMMITTER_EMAIL: 'orbit@collab.orbit',
  };
}

function git(cwd, args) {
  return spawnSync('git', args, { cwd, env: gitEnv(), encoding: 'utf8', timeout: 8000 });
}

export function addWorktree(workspace, id) {
  const branch = `collab/${id}`;
  const dir = path.join(path.dirname(workspace), 'worktrees', id);
  fs.mkdirSync(path.dirname(dir), { recursive: true });
  const head = git(workspace, ['rev-parse', '--verify', 'HEAD']);
  if (head.status !== 0) {
    const committed = git(workspace, ['commit', '--allow-empty', '-m', 'collab workspace']);
    if (committed.status !== 0) {
      fs.mkdirSync(dir, { recursive: true });
      return { worktree: dir, branch, isolated: false, note: 'Git could not create a worktree. The subagent has a subdirectory instead.' };
    }
  }
  const added = git(workspace, ['worktree', 'add', '-b', branch, dir, 'HEAD']);
  if (added.status !== 0) {
    fs.mkdirSync(dir, { recursive: true });
    return { worktree: dir, branch, isolated: false, note: clean(added.stderr || 'Worktree was not created.', 200) };
  }
  return { worktree: dir, branch, isolated: true, note: '' };
}

export function mergeBranch(workspace, branch) {
  const merged = git(workspace, ['merge', '--no-edit', branch]);
  if (merged.status === 0) return { merged: true, conflicts: [] };
  const listed = git(workspace, ['diff', '--name-only', '--diff-filter=U']);
  const conflicts = String(listed.stdout || '').split('\n').map(item => item.trim()).filter(Boolean);
  git(workspace, ['merge', '--abort']);
  return { merged: false, conflicts };
}

export function removeWorktree(workspace, sub) {
  if (!sub?.worktree) return;
  if (sub.isolated && workspace) {
    const removed = git(workspace, ['worktree', 'remove', '--force', sub.worktree]);
    if (removed.status === 0) return;
  }
  try { fs.rmSync(sub.worktree, { recursive: true, force: true }); } catch { /* already gone */ }
}

export function copyOwnedFiles(workspace, sub) {
  const root = path.resolve(workspace);
  const fromRoot = path.resolve(sub.worktree || '');
  if (!fromRoot || fromRoot === root) return [];
  const copied = [];
  for (const file of sub.files || []) {
    const source = path.resolve(fromRoot, file);
    const dest = path.resolve(root, file);
    if (source !== fromRoot && !source.startsWith(`${fromRoot}${path.sep}`)) continue;
    if (dest !== root && !dest.startsWith(`${root}${path.sep}`)) continue;
    if (!fs.existsSync(source) || !fs.statSync(source).isFile()) continue;
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(source, dest);
    copied.push(file);
  }
  return copied;
}
