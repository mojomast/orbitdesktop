import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createAgentGateways } from '../server/agent-gateways.mjs';
import { admitSpawn, gitEnv, mergeBranch, parseOrchestratorOp, projectedCost } from '../server/collab-orchestrator.mjs';
import { createCollab, parseCollabBlock } from '../server/collab.mjs';

const workspace_id = '12345678-1234-4234-9234-123456789abc';

function block(ops) {
  return `\`\`\`collab\n${JSON.stringify({ ops })}\n\`\`\``;
}

function brief(extra = {}) {
  return {
    objective: 'Write the notes',
    deliverable: 'notes.md',
    acceptance: ['The file exists'],
    tools: ['read', 'edit'],
    scope: 'notes.md only',
    budget: { turns: 2, minutes: 10 },
    returnFormat: 'summary and artifact paths',
    ...extra,
  };
}

function taskIdFrom(prompt) {
  return String(prompt || '').match(/(?:Current task |Task )(t_[a-f0-9]{16})/)?.[1] || '';
}

test('spawn brief, effort cost, and admission follow the orchestrator rules', () => {
  const missing = parseOrchestratorOp({ op: 'spawn', taskId: 't_0123456789abcdef', name: 'notes', brief: { objective: 'x' } });
  assert.match(missing.error, /objective, deliverable, scope, and returnFormat/);
  const handoff = parseOrchestratorOp({ op: 'spawn', taskId: 't_0123456789abcdef', name: 'notes', mode: 'handoff', brief: brief() });
  assert.match(handoff.error, /Kyle should talk/);
  const parsed = parseOrchestratorOp({ op: 'spawn', taskId: 't_0123456789abcdef', name: 'notes', effort: 3, files: [], brief: brief() });
  assert.equal(parsed.op.mode, 'tool');
  assert.equal(projectedCost(parsed.op.effort, parsed.op.brief.budget).text, 'Projected cost is 6 turns and 30 minutes.');
  const pushed = parseCollabBlock(block([{ op: 'merge', taskId: 't_0123456789abcdef', subagentId: 's_0123456789abcdef', push: true }]));
  assert.match(pushed.error, /Kyle approves a push separately/);
  const limits = { maxConcurrent: 3, maxDepth: 1 };
  assert.match(admitSpawn({ limits, parent: 'hermes', active: [], effort: 4, files: [], depth: 1, objective: 'Write the notes', taskId: 't_1', chain: [] }), /3 subagents/);
  assert.match(admitSpawn({ limits, parent: 'hermes', active: [], effort: 2, files: ['a.js'], depth: 1, objective: 'Write the notes', taskId: 't_1', chain: [] }), /Split files/);
  assert.match(admitSpawn({ limits, parent: 'hermes', active: [], effort: 1, files: [], depth: 2, objective: 'Write the notes', taskId: 't_1', chain: [] }), /depth 2/);
  assert.match(admitSpawn({
    limits, parent: 'hermes', active: [], effort: 1, files: [], depth: 1, objective: 'Write the notes', taskId: 't_1',
    chain: [{ id: 's_parent', taskId: 't_1', brief: { objective: 'Write the notes' } }],
  }), /repeats a parent brief/);
  assert.equal(admitSpawn({
    limits: { maxConcurrent: 4, maxDepth: 2 }, parent: 'grok', active: [], effort: 4, files: [], depth: 1, objective: 'Research', taskId: 't_1', chain: [],
  }), '');
});

test('a merge conflict is reported and the branch is not pushed', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-merge-'));
  const env = gitEnv();
  const git = (args, cwd = root) => spawnSync('git', args, { cwd, env, encoding: 'utf8' });
  git(['init', '-q']);
  git(['commit', '--allow-empty', '-m', 'base']);
  git(['checkout', '-q', '-b', 'left']);
  fs.writeFileSync(path.join(root, 'c.txt'), 'left\n');
  git(['add', 'c.txt']);
  git(['commit', '-q', '-m', 'left']);
  git(['checkout', '-q', '-b', 'right', 'HEAD~1']);
  fs.writeFileSync(path.join(root, 'c.txt'), 'right\n');
  git(['add', 'c.txt']);
  git(['commit', '-q', '-m', 'right']);
  git(['checkout', '-q', 'left']);
  const outcome = mergeBranch(root, 'right');
  assert.equal(outcome.merged, false);
  assert.deepEqual(outcome.conflicts, ['c.txt']);
  const pushes = git(['log', '--all', '--grep', 'push']);
  assert.equal(String(pushes.stdout || '').includes('push'), false);
  fs.rmSync(root, { recursive: true, force: true });
});

test('Hermes delegate_task is used when exposed, otherwise a new session; Grok subagents are separate agents', async () => {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    const route = String(url);
    calls.push({ route, method: init.method || 'GET', body: init.body ? JSON.parse(init.body) : null });
    const json = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
    if (route.endsWith('/v1/delegate_task')) return json({ error: 'missing' }, calls.filter(item => item.route.endsWith('/v1/delegate_task')).length === 1 ? 501 : 200);
    if (route.endsWith('/v1/runs') && init.method === 'POST') return json({ run_id: 'run_subagent01', status: 'running' });
    return json({ error: 'missing' }, 404);
  };
  let delegated = false;
  const fetchSwitch = async (url, init) => {
    if (String(url).endsWith('/v1/delegate_task') && delegated) return new Response(JSON.stringify({ run_id: 'run_delegate01', session_id: 'orbit-parent' }), { status: 200, headers: { 'content-type': 'application/json' } });
    return fetchImpl(url, init);
  };
  const grok = {
    async ensureSharedAgent(_profile, _id, name) { calls.push({ name }); return 'agent_sub_1'; },
    async startSharedPrompt() { return { nonce: 'nonce-1', baseline: { maxSeq: 0 }, started: 5, agentId: 'agent_sub_1' }; },
    async archiveSharedAgent(_profile, id) { calls.push({ archived: id }); return { archived: true }; },
    async previewSession() { return { messages: [{ role: 'assistant', text: 'done' }] }; },
  };
  const gateways = createAgentGateways({
    fetchImpl: fetchSwitch,
    grok,
    hermesProfile: () => ({ apiUrl: 'http://hermes.test', apiKey: 'k' }),
    grokProfile: () => ({ apiUrl: 'http://grok.test', apiKey: 'k' }),
  });
  const fallback = await gateways.startSubagent({ speaker: 'hermes', prompt: 'work', instructions: 'be brief', name: 'notes', parentSession: 'orbit-parent' });
  assert.equal(fallback.strategy, 'session');
  assert.match(fallback.sessionId, /^orbit-sub-/);
  assert.equal(calls.some(item => item.route === 'http://hermes.test/v1/runs' && item.body.session_id.startsWith('orbit-sub-')), true);
  delegated = true;
  const native = await gateways.startSubagent({ speaker: 'hermes', prompt: 'work', instructions: 'be brief', name: 'notes', parentSession: 'orbit-parent' });
  assert.equal(native.strategy, 'delegate_task');
  assert.equal(native.runId, 'run_delegate01');
  const grokRun = await gateways.startSubagent({ speaker: 'grok', prompt: 'work', instructions: 'be brief', name: 'changelog' });
  assert.equal(grokRun.strategy, 'agent');
  assert.equal(calls.some(item => item.name === 'Orbit collab sub: changelog'), true);
  const archived = await gateways.archiveSubagent({ provider: 'grok', agentId: 'agent_sub_1' });
  assert.equal(archived.archived, true);
});

function harness() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-orch-'));
  const pending = new Map();
  const archived = [];
  const clock = 1_700_000_000_000;
  let seq = 0;
  const outputs = [];
  const gateways = {
    async startSpeaker({ speaker, prompt }) {
      seq += 1;
      const runId = `run_${String(seq).padStart(8, '0')}`;
      pending.set(runId, { speaker, prompt });
      return { runId, started: clock };
    },
    async pollSpeaker(run) {
      if (String(run.runId).startsWith('run_sub')) {
        const prompt = pending.get(run.runId)?.prompt || '';
        const taskId = taskIdFrom(prompt);
        const nested = prompt.includes('NEST');
        const ops = [{ op: 'submit', taskId, summary: 'Subagent wrote the file.', paths: ['c.txt'], artifacts: [], selfCheck: {} }];
        if (nested) ops.push({ op: 'spawn', taskId, name: 'child', effort: 1, mode: 'tool', brief: brief({ objective: 'Write the notes' }), files: [] });
        return { status: 'completed', output: block(ops), tokens: 4 };
      }
      const item = pending.get(run.runId);
      const reply = outputs.shift();
      if (!reply) return { status: 'completed', output: block([{ op: 'decision', text: 'Waiting.' }]), tokens: 1 };
      return { status: 'completed', output: typeof reply === 'function' ? reply(item?.prompt || '', item?.speaker) : reply, tokens: 6 };
    },
    async stopSpeaker() {},
    async startSubagent(spec) {
      seq += 1;
      const runId = `run_sub${String(seq).padStart(6, '0')}`;
      pending.set(runId, { speaker: spec.speaker, prompt: spec.prompt });
      if (spec.worktree && spec.files?.length) {
        const env = gitEnv();
        const marker = spec.files[0];
        fs.writeFileSync(path.join(spec.worktree, marker), `${marker}\n`);
        fs.writeFileSync(path.join(spec.worktree, 'c.txt'), `${spec.name}\n`);
        spawnSync('git', ['add', marker, 'c.txt'], { cwd: spec.worktree, env });
        spawnSync('git', ['commit', '-q', '-m', spec.name], { cwd: spec.worktree, env });
      }
      return {
        strategy: spec.speaker === 'grok' ? 'agent' : 'session',
        speaker: spec.speaker,
        runId,
        started: clock,
        agentId: spec.speaker === 'grok' ? `agent_sub_${seq}` : '',
        sessionId: spec.speaker === 'hermes' ? `orbit-sub-${seq}` : '',
      };
    },
    async archiveSubagent(sub) {
      archived.push(sub.agentId);
      return { archived: true };
    },
    async readSubagentTranscript(sub) {
      return { messages: sub.transcript || [] };
    },
  };
  const collab = createCollab({ directory: dir, gateways, now: () => clock, advanceIntervalMs: 60_000 });
  async function call(body) {
    let captured;
    const res = { headersSent: false, writableEnded: false, end() {} };
    await collab.handle((response, status, data) => { captured = { status, data }; }, res, { workspace_id, ...body });
    return captured;
  }
  return { dir, outputs, archived, call };
}

const plan = (owner = 'grok') => block([{
  op: 'plan',
  tasks: [{ title: 'Write the notes', spec: 'Create the notes', acceptance: ['Notes exist'], role: 'executor', owner, reviewer: owner === 'grok' ? 'hermes' : 'grok' }],
}]);

test('an orchestrator spawns tool-mode subagents, shows projected cost, and merges without pushing', async () => {
  const room = harness();
  room.outputs.push(plan('grok'));
  const created = await room.call({ operation: 'create', goal: 'Write the notes', orchestrator: 'grok' });
  assert.equal(created.status, 200, JSON.stringify(created.data));
  assert.equal(created.data.project.orchestrator, 'grok');
  const project_id = created.data.project.id;
  room.outputs.push((prompt) => {
    const id = taskIdFrom(prompt);
    return block([
      { op: 'spawn', taskId: id, name: 'left', effort: 1, mode: 'tool', files: ['a.txt'], brief: brief() },
      { op: 'spawn', taskId: id, name: 'right', effort: 1, mode: 'tool', files: ['b.txt'], brief: brief({ objective: 'Write the other notes' }) },
    ]);
  });
  room.outputs.push((prompt) => {
    const id = taskIdFrom(prompt);
    const stateHint = prompt;
    const ids = [...stateHint.matchAll(/s_[a-f0-9]{16}/g)].map(item => item[0]);
    return block([
      { op: 'merge', taskId: id, subagentId: ids[0] || 's_0123456789abcdef' },
      { op: 'merge', taskId: id, subagentId: ids[1] || 's_0123456789abcdef' },
      { op: 'status', text: 'Merged the notes. Kyle still approves any push.' },
      { op: 'submit', taskId: id, summary: 'Notes are ready', artifacts: [], selfCheck: {} },
    ]);
  });
  room.outputs.push((prompt) => block([{ op: 'review', taskId: taskIdFrom(prompt), verdict: 'approve', notes: 'ok', criteria: {} }]));
  const approved = await room.call({ operation: 'resolve', project_id, choice: 'approve' });
  assert.equal(approved.status, 200, JSON.stringify(approved.data.error || approved.data.project?.activity || approved.data));
  const subs = approved.data.subagents || [];
  assert.equal(subs.length >= 2, true);
  assert.equal(subs.filter(item => item.archived).length, subs.filter(item => item.provider === 'grok' && ['completed', 'merged', 'failed'].includes(item.status)).length);
  assert.equal(room.archived.length >= 1, true);
  const resolve = approved.data.tasks.find(task => task.title === 'Resolve c.txt');
  assert.ok(resolve);
  assert.match(approved.data.events.map(item => item.type).join(' '), /span/);
  assert.equal(approved.data.events.some(item => JSON.stringify(item.data).includes('git push')), false);
  fs.rmSync(room.dir, { recursive: true, force: true });
});

test('effort above one waits for Kyle, and a nested spawn stops at the depth cap', async () => {
  const room = harness();
  room.outputs.push(plan('hermes'));
  const created = await room.call({ operation: 'create', goal: 'Scale the work', orchestrator: 'hermes' });
  const project_id = created.data.project.id;
  room.outputs.push((prompt) => block([{
    op: 'spawn', taskId: taskIdFrom(prompt), name: 'batch', effort: 3, mode: 'tool', brief: brief({ objective: 'Survey' }), files: [],
  }]));
  const scaled = await room.call({ operation: 'resolve', project_id, choice: 'approve' });
  assert.equal(scaled.data.project.gate?.type, 'scale', JSON.stringify(scaled.data.error || scaled.data.project?.activity || scaled.data.events?.slice(-4)));
  assert.match(scaled.data.project.gate.summary, /Projected cost is 6 turns and 30 minutes/);
  assert.equal(scaled.data.subagents.every(item => item.status === 'pending-approval'), true);
  const canceledId = scaled.data.subagents[0].id;
  const canceled = await room.call({ operation: 'cancel_subagent', project_id, subagent_id: canceledId });
  assert.equal(canceled.data.subagents.find(item => item.id === canceledId).status, 'canceled');
  room.outputs.push((prompt) => block([{ op: 'submit', taskId: taskIdFrom(prompt), summary: 'batch started', artifacts: [], selfCheck: {} }]));
  room.outputs.push((prompt) => block([{ op: 'review', taskId: taskIdFrom(prompt), verdict: 'approve', notes: 'ok', criteria: {} }]));
  const started = await room.call({ operation: 'resolve', project_id, choice: 'approve' });
  assert.equal(started.status, 200, JSON.stringify(started.data.error || started.data.project?.activity || ''));
  const live = started.data.subagents.filter(item => item.id !== canceledId);
  assert.equal(live.every(item => item.status === 'completed' || item.status === 'merged'), true);
  const limits = await room.call({ operation: 'subagent_limits', project_id, max_concurrent: 4, max_depth: 1 });
  assert.equal(limits.data.project.subagentLimits.maxConcurrent, 4);
  const transcript = await room.call({ operation: 'subagent_transcript', project_id, subagent_id: live[0].id });
  assert.equal(transcript.data.transcript.id, live[0].id);
  assert.equal(transcript.data.transcript.messages.some(item => String(item.text).includes('Subagent wrote') || String(item.text).includes('collab')), true);

  const nested = harness();
  nested.outputs.push(plan('hermes'));
  const nestedProject = await nested.call({ operation: 'create', goal: 'NEST the work', orchestrator: 'hermes' });
  const nestedId = nestedProject.data.project.id;
  nested.outputs.push((prompt) => block([{ op: 'spawn', taskId: taskIdFrom(prompt), name: 'parent worker', effort: 1, mode: 'tool', brief: brief(), files: [] }]));
  nested.outputs.push((prompt) => block([{ op: 'decision', text: 'parent still owns the task' }]));
  const ran = await nested.call({ operation: 'resolve', project_id: nestedId, choice: 'approve' });
  assert.equal(ran.status, 200, JSON.stringify(ran.data.error || ran.data.project?.activity || ''));
  assert.equal(ran.data.subagents.length, 1);
  assert.match(JSON.stringify(ran.data.events), /depth 1 is above the cap|above the cap of 1/);
  fs.rmSync(room.dir, { recursive: true, force: true });
  fs.rmSync(nested.dir, { recursive: true, force: true });
});
