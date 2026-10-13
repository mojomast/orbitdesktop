import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

export const SUBAGENT_PREFIX = 'Orbit collab sub: ';
export const MAX_PARALLEL = 4;
export const MAX_PER_AGENT = 3;
export const SPAN_NAMES = ['invoke_agent', 'execute_tool', 'chat'];
const WRITE_TOOLS = new Set(['code', 'terminal', 'tools', 'shell', 'write', 'files']);
const BRIEF_TOOLS = ['read', 'research', 'code', 'terminal', 'tools', 'shell', 'write', 'files', 'web'];
const EFFORT_CAP = { trivial: 0, moderate: 2, complex: MAX_PARALLEL };

function clean(value, max) {
  return String(value || '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max);
}

export function effortCap(effort) {
  return Object.prototype.hasOwnProperty.call(EFFORT_CAP, effort) ? EFFORT_CAP[effort] : EFFORT_CAP.moderate;
}

export function subagentName(objective) {
  const text = clean(objective, 58).replace(/\s+/g, ' ');
  return `${SUBAGENT_PREFIX}${text || 'task'}`.slice(0, 80);
}

export function isCodingBrief(brief) {
  return (brief?.allowedTools || []).some(tool => WRITE_TOOLS.has(tool));
}

export function parseScope(raw) {
  if (!Array.isArray(raw)) return { error: 'spawn brief needs a scope array of relative files. Use [] for a read-only subagent.' };
  if (raw.length > 16) return { error: 'spawn brief scope can list at most 16 files.' };
  const scope = [];
  for (const item of raw) {
    const name = clean(item, 120);
    if (!name || name.startsWith('/') || name.includes('\\')) return { error: 'spawn brief scope files must be relative paths.' };
    const parts = name.split('/');
    if (parts.some(part => !part || part === '.' || part === '..' || !/^[\w. -]{1,80}$/.test(part))) return { error: `spawn brief scope path "${name}" is not a plain relative file.` };
    scope.push(name);
  }
  return { scope };
}

export function parseBrief(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { error: 'spawn needs a brief object with objective, deliverable, acceptance, allowedTools, scope, budget, and returnFormat.' };
  const objective = clean(raw.objective, 2000);
  const deliverable = clean(raw.deliverable, 1000);
  if (!objective || !deliverable) return { error: 'spawn brief needs an objective and a deliverable.' };
  if (!Array.isArray(raw.acceptance) || raw.acceptance.length < 1 || raw.acceptance.length > 8) return { error: 'spawn brief needs 1–8 acceptance criteria.' };
  const acceptance = raw.acceptance.map(item => clean(item, 500)).filter(Boolean);
  if (acceptance.length !== raw.acceptance.length) return { error: 'spawn brief has an empty acceptance criterion.' };
  if (!Array.isArray(raw.allowedTools) || raw.allowedTools.length < 1 || raw.allowedTools.length > BRIEF_TOOLS.length) return { error: `spawn brief needs allowedTools. Use any of: ${BRIEF_TOOLS.join(', ')}.` };
  const allowedTools = [];
  for (const tool of raw.allowedTools) {
    const name = clean(tool, 40).toLowerCase();
    if (!BRIEF_TOOLS.includes(name)) return { error: `spawn brief tool "${name}" is unknown. Allowed tools: ${BRIEF_TOOLS.join(', ')}.` };
    if (!allowedTools.includes(name)) allowedTools.push(name);
  }
  const scopeResult = parseScope(raw.scope);
  if (scopeResult.error) return scopeResult;
  const budget = parseBudget(raw.budget);
  if (budget.error) return budget;
  const returnFormat = clean(raw.returnFormat, 40);
  if (returnFormat !== 'summary+paths') return { error: 'spawn brief returnFormat must be "summary+paths" so the worker returns a summary and artifact paths.' };
  const brief = { objective, deliverable, acceptance, allowedTools, scope: scopeResult.scope, budget: budget.budget, returnFormat };
  if (isCodingBrief(brief) && !brief.scope.length) return { error: 'A coding subagent needs a disjoint file scope. List the files it may write.' };
  return { brief };
}

function parseBudget(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { error: 'spawn brief needs a budget with turns, tokens, and minutes.' };
  const { turns, tokens, minutes } = raw;
  if (!Number.isInteger(turns) || turns < 1 || turns > 40) return { error: 'spawn brief budget.turns must be an integer from 1 to 40.' };
  if (!Number.isInteger(tokens) || tokens < 100 || tokens > 2_000_000) return { error: 'spawn brief budget.tokens must be an integer from 100 to 2000000.' };
  if (!Number.isInteger(minutes) || minutes < 1 || minutes > 30) return { error: 'spawn brief budget.minutes must be an integer from 1 to 30.' };
  return { budget: { turns, tokens, minutes } };
}

export function projectedTokens(briefs) {
  return (briefs || []).reduce((sum, brief) => sum + (Number(brief?.budget?.tokens) || 0), 0);
}

export function noteLoop(recent, signature) {
  const next = [...(Array.isArray(recent) ? recent : []), signature].slice(-8);
  const last4 = next.slice(-4);
  const pingpong = last4.length === 4 && last4[0] !== last4[1] && last4[0] === last4[2] && last4[1] === last4[3];
  const repeats = next.slice(-6).filter(item => item === signature).length >= 3;
  return { recent: next, blocked: pingpong || repeats };
}

export function scopesOverlap(left, right) {
  const a = Array.isArray(left) ? left : [];
  const b = Array.isArray(right) ? right : [];
  for (const file of a) {
    if (b.includes(file)) return true;
  }
  return false;
}

export function inScope(scope, name) {
  if (!scope?.length) return true;
  return scope.some(file => name === file || name.startsWith(`${file}/`));
}

export function orderSubs(subs) {
  const byId = new Map((subs || []).map(sub => [sub.id, sub]));
  const seen = new Set();
  const out = [];
  const visit = (sub, stack) => {
    if (!sub || seen.has(sub.id)) return;
    if (stack.has(sub.id)) return;
    stack.add(sub.id);
    for (const dep of sub.dependsOn || []) visit(byId.get(dep), stack);
    stack.delete(sub.id);
    seen.add(sub.id);
    out.push(sub);
  };
  for (const sub of subs || []) visit(sub, new Set());
  return out;
}

export function spanFields({ span, actor, model, tokens = 0, usd = 0, ms = 0, status = '', worktree = '', branch = '', runId = '', subagentId = '', summary = '' }) {
  const name = SPAN_NAMES.includes(span) ? span : 'invoke_agent';
  const trace = {
    runId: runId || '',
    tokens: tokens || 0,
    usd: usd || 0,
    ms: ms || 0,
    span: name,
    'gen_ai.operation.name': name,
    'gen_ai.agent.name': actor || '',
    'gen_ai.request.model': model || actor || '',
  };
  return {
    trace,
    data: {
      ...trace,
      status,
      worktree,
      branch,
      subagentId,
      summary: summary || `${name} · ${actor || 'orbit'} · ${tokens || 0} tokens · ${ms || 0} ms`,
    },
  };
}

function git(args, cwd, env = process.env) {
  return spawnSync('git', args, { cwd, env, timeout: 15000, encoding: 'utf8' });
}

function gitEnv(agent) {
  const name = agent === 'grok' ? 'Grok Bot' : agent === 'hermes' ? 'Hermes' : 'Orbit';
  const email = `${agent || 'orbit'}@collab.orbit`;
  return {
    ...process.env,
    GIT_AUTHOR_NAME: name,
    GIT_AUTHOR_EMAIL: email,
    GIT_COMMITTER_NAME: name,
    GIT_COMMITTER_EMAIL: email,
  };
}

export function ensureHead(workspace) {
  const head = git(['rev-parse', '--verify', 'HEAD'], workspace);
  if (head.status === 0) return '';
  const made = git(['commit', '--allow-empty', '-m', 'Collab workspace'], workspace, gitEnv('orbit'));
  if (made.status !== 0) return clean(made.stderr || made.stdout || 'The workspace has no commit to branch from.', 300);
  return '';
}

export function addWorktree(workspace, id) {
  const ready = ensureHead(workspace);
  if (ready) return { error: ready };
  const branch = `orbit/${id}`;
  const relative = path.join('.orbit', 'worktrees', id);
  const abs = path.join(workspace, relative);
  fs.mkdirSync(path.dirname(abs), { recursive: true, mode: 0o700 });
  const added = git(['worktree', 'add', '-q', '-b', branch, abs], workspace);
  if (added.status !== 0) return { error: clean(added.stderr || added.stdout || 'Could not add a worktree.', 300) };
  return { worktree: abs, branch, relative };
}

export function commitWorktree(dir, message, agent) {
  const env = gitEnv(agent);
  git(['add', '-A'], dir, env);
  const pending = git(['status', '--porcelain'], dir, env);
  if (!String(pending.stdout || '').trim()) return { committed: false };
  const committed = git(['commit', '-q', '-m', clean(message, 200) || 'Subagent result'], dir, env);
  if (committed.status !== 0) return { error: clean(committed.stderr || committed.stdout || 'Could not commit the worktree.', 300) };
  return { committed: true };
}

export function rebaseWorktree(workspace, worktree) {
  const base = git(['rev-parse', '--abbrev-ref', 'HEAD'], workspace);
  const baseBranch = String(base.stdout || '').trim();
  const rebase = git(['rebase', '--quiet', baseBranch || 'HEAD'], worktree);
  if (rebase.status !== 0) {
    git(['rebase', '--abort'], worktree);
    return { conflict: true, output: clean(`${rebase.stdout || ''}\n${rebase.stderr || ''}`, 2000) };
  }
  return { ok: true, baseBranch };
}

export function mergeBranch(workspace, branch, message, agent) {
  const env = gitEnv(agent);
  const ff = git(['merge', '--ff-only', branch], workspace, env);
  if (ff.status === 0) return { merged: true, mode: 'ff' };
  git(['merge', '--abort'], workspace, env);
  const squash = git(['merge', '--squash', branch], workspace, env);
  if (squash.status !== 0) {
    git(['merge', '--abort'], workspace, env);
    return { conflict: true, output: clean(`${squash.stdout || ''}\n${squash.stderr || ''}`, 2000) };
  }
  const committed = git(['commit', '-q', '-m', clean(message, 200) || `Merge ${branch}`], workspace, env);
  if (committed.status !== 0) return { error: clean(committed.stderr || committed.stdout || 'Could not squash-merge that branch.', 300) };
  return { merged: true, mode: 'squash' };
}

export function removeWorktree(workspace, abs) {
  if (!abs) return;
  git(['worktree', 'remove', '--force', abs], workspace);
  git(['worktree', 'prune'], workspace);
}

export function pushWorkspace(workspace) {
  const pushed = git(['push'], workspace);
  if (pushed.status !== 0) return { error: clean(pushed.stderr || pushed.stdout || 'git push failed.', 300) };
  return { pushed: true };
}
