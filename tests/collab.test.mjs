import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createAgentHandler } from '../server/agent.mjs';
import { chooseAgent, defaultCapabilities, parseCollabBlock } from '../server/collab.mjs';

const token = 'orbit-test-token-'.repeat(4);
const session = 'orbit-12345678-1234-4234-9234-123456789abc';
const workspace_id = '12345678-1234-4234-9234-123456789abc';
const pane_id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

function block(ops) {
  return `\`\`\`collab\n${JSON.stringify({ ops })}\n\`\`\``;
}

function taskIdFrom(prompt) {
  return String(prompt || '').match(/Current task (t_[a-f0-9]{16})/)?.[1] || '';
}

function workBlock(prompt, { risk = '', name = '', content = '' } = {}) {
  const id = taskIdFrom(prompt);
  const ops = [
    { op: 'claim', taskId: id },
    { op: 'artifact.put', name: name || `${id}.md`, kind: 'note', content: content || `notes for ${id}`, taskId: id, baseVersion: 0, ...(risk ? { risk } : {}) },
  ];
  if (!risk) ops.push({ op: 'submit', taskId: id, summary: `finished ${id}`, artifacts: [], selfCheck: {} });
  return block(ops);
}

function reviewBlock(prompt, verdict = 'approve', notes = 'looks good') {
  const id = taskIdFrom(prompt);
  return block([{ op: 'review', taskId: id, verdict, notes, criteria: { done: verdict === 'approve' ? 'pass' : 'fail' } }]);
}

function open(t, fetchImpl, options = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-collab-'));
  let port;
  let handler;
  const reply = (res, status, data) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(data)); };
  const workspaceRead = () => ({ state: { monitors: [{ layout: { type: 'pane', pane: { id: pane_id, kind: 'agent' } } }] } });
  const server = http.createServer((req, res) => (handler ||= createAgentHandler({
    token, port, devOrigins: [], reply, runtimeDirectory: dir, workspaceRead,
    apiUrl: 'http://hermes.test', apiKey: 'hermes-key',
    additionalProfiles: [{ id: 'grok', label: 'Grok Bot', provider: 'grok', apiUrl: 'http://127.0.0.1:1340', apiKey: 'grok-token-secret' }],
    fetchImpl, grokOptions: options.grokOptions || {},
  }))(req, res));
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => {
    port = server.address().port;
    const origin = `http://127.0.0.1:${port}`;
    t.after(async () => {
      await new Promise(done => server.close(done));
      fs.rmSync(dir, { recursive: true, force: true });
    });
    resolve({
      dir,
      async request(body) {
        const response = await fetch(origin + '/api/agent', {
          method: 'POST',
          headers: { Origin: origin, Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ workspace_id, pane_id, session_id: session, profile_id: 'default', ...body }),
        });
        return { status: response.status, body: await response.json() };
      },
    });
  }));
}

function scripted(replies) {
  const calls = [];
  const agents = [{ id: 'main_bot', name: 'Main Grok' }];
  let hermesPosts = 0;
  let grokSends = 0;
  const hermesOutput = new Map();
  const tail = [];
  const fetchImpl = async (url, init = {}) => {
    const route = String(url);
    const payload = init.body ? JSON.parse(init.body) : {};
    calls.push({ route, method: init.method || 'GET', payload });
    const json = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
    if (route === 'http://hermes.test/v1/runs' && init.method === 'POST') {
      hermesPosts += 1;
      const id = `run_collab${String(hermesPosts).padStart(4, '0')}`;
      hermesOutput.set(id, replies.hermes?.(payload.input, hermesPosts) || '```collab\n{"ops":[]}\n```');
      return json({ run_id: id, status: 'running' });
    }
    if (route.startsWith('http://hermes.test/v1/runs/') && route.endsWith('/stop')) return json({ status: 'stopping' });
    if (route.startsWith('http://hermes.test/v1/runs/')) {
      const id = route.split('/').at(-1);
      return json({ status: 'completed', output: hermesOutput.get(id) || '', usage: { total_tokens: 20 } });
    }
    if (route.endsWith('/api/listAgents')) return json(agents);
    if (route.endsWith('/api/createAgent')) {
      const id = payload.name === 'Orbit collab' ? 'agent_collab_1' : 'agent_shared_1';
      agents.push({ id, name: payload.name });
      return json({ agent: { id, name: payload.name } });
    }
    if (route.endsWith('/api/sendPrompt')) {
      grokSends += 1;
      tail.push({ seq: grokSends, id: `g${grokSends}`, kind: 'send-message', message: { type: 'text', content: replies.grok?.(payload.prompt, grokSends) || '```collab\n{"ops":[]}\n```' } });
      return json({ accepted: true });
    }
    if (route.endsWith('/api/promptAcceptanceStatus')) return json({ outcome: 'found', record: { status: 'accepted' } });
    if (route.endsWith('/api/getAgentTranscriptTail')) return json(tail.slice());
    if (route.endsWith('/api/interruptAgentRun')) return json({ ok: true });
    return json({ error: 'missing' }, 404);
  };
  return { fetchImpl, calls, agents };
}

const plan = block([{
  op: 'plan',
  tasks: [
    { title: 'Research the notes', spec: 'Find the facts', acceptance: ['Sources are listed'], role: 'researcher', skillsHint: ['research', 'writing'] },
    { title: 'Implement the change', spec: 'Edit the code and run it', acceptance: ['Tests pass'], role: 'executor', skillsHint: ['code', 'terminal'], dependsOn: ['Research the notes'] },
  ],
}]);

test('parseCollabBlock accepts one strict block and rejects a malformed reply', () => {
  assert.equal(parseCollabBlock('no block').ok, false);
  assert.equal(parseCollabBlock('```collab\n{not json}\n```').ok, false);
  assert.equal(parseCollabBlock('```collab\n{"ops":[]}\n```').ok, false);
  assert.match(parseCollabBlock('```collab\n{"ops":[{"op":"nope"}]}\n```').error, /Unknown collab op/);
  const two = `${block([{ op: 'decision', text: 'one' }])}\n${block([{ op: 'decision', text: 'two' }])}`;
  assert.match(parseCollabBlock(two).error, /one ```collab block/);
  const parsed = parseCollabBlock(block([{ op: 'decision', text: 'Ship the notes.' }]));
  assert.equal(parsed.ok, true);
  assert.equal(parsed.ops[0].text, 'Ship the notes.');
});

test('chooseAgent uses capability profiles and keeps the reviewer off the owner', () => {
  const caps = defaultCapabilities();
  assert.equal(chooseAgent('executor', ['code', 'terminal'], caps), 'hermes');
  assert.equal(chooseAgent('researcher', ['research', 'writing'], caps), 'grok');
  const swapped = { hermes: { skills: ['research', 'writing'] }, grok: { skills: ['code', 'terminal', 'tools'] } };
  assert.equal(chooseAgent('executor', ['code'], swapped), 'grok');
  assert.equal(chooseAgent('planner', [], swapped), 'hermes');
});

test('a project plans from capabilities, gates on Kyle, then reviews across agents', async t => {
  const { fetchImpl, calls } = scripted({
    grok(prompt) {
      if (prompt.includes('No tasks exist yet')) return plan;
      if (prompt.includes('reviewer as')) return reviewBlock(prompt);
      return workBlock(prompt);
    },
    hermes(prompt) {
      if (prompt.includes('reviewer as')) return reviewBlock(prompt);
      return workBlock(prompt);
    },
  });
  const room = await open(t, fetchImpl);
  const created = await room.request({ action: 'collab', operation: 'create', goal: 'Publish the release notes' });
  assert.equal(created.status, 200);
  assert.equal(created.body.project.gate.type, 'plan');
  assert.equal(created.body.tasks.find(task => task.title === 'Research the notes').owner, 'grok');
  assert.equal(created.body.tasks.find(task => task.title === 'Research the notes').reviewer, 'hermes');
  assert.equal(created.body.tasks.find(task => task.title === 'Implement the change').owner, 'hermes');
  assert.equal(created.body.tasks.find(task => task.title === 'Implement the change').reviewer, 'grok');
  assert.equal(created.body.tasks.find(task => /Implement/.test(task.title)).dependsOn.length, 1);
  assert.equal(calls.some(call => call.route.endsWith('/api/createAgent') && call.payload.name === 'Orbit collab'), true);
  assert.equal(calls.some(call => call.payload?.agentId === 'main_bot'), false);

  const project_id = created.body.project.id;
  let body = (await room.request({ action: 'collab', operation: 'resolve', project_id, choice: 'approve' })).body;
  for (let i = 0; i < 4 && body.project.gate?.type !== 'final'; i += 1) {
    body = (await room.request({ action: 'collab', operation: 'state', project_id })).body;
  }
  assert.equal(body.project.gate.type, 'final');
  assert.equal(body.tasks.every(task => task.status === 'completed'), true);
  assert.equal(body.artifacts.length, 2);
  const prompts = calls.filter(call => call.route === 'http://hermes.test/v1/runs' && call.method === 'POST').map(call => call.payload.input);
  const researchReview = prompts.findIndex(prompt => prompt.includes('Research the notes') && prompt.includes('reviewer as'));
  const implementWork = prompts.findIndex(prompt => prompt.includes('Implement the change') && prompt.includes('executor as'));
  assert.equal(researchReview >= 0 && implementWork > researchReview, true);
  const stored = await room.request({ action: 'collab', operation: 'artifact', project_id, artifact_id: body.artifacts[0].id });
  assert.match(stored.body.content, /notes for t_/);
  const accepted = await room.request({ action: 'collab', operation: 'resolve', project_id, choice: 'approve' });
  assert.equal(accepted.body.project.status, 'done');
});

test('a bad collab block gets one corrective retry', async t => {
  const { fetchImpl, calls } = scripted({
    grok(_prompt, send) {
      if (send === 1) return 'sure, I will just chat';
      return block([{ op: 'plan', tasks: [{ title: 'Build', spec: 'Make it', acceptance: ['It runs'], owner: 'hermes', reviewer: 'grok', role: 'executor' }] }]);
    },
  });
  const room = await open(t, fetchImpl);
  const created = await room.request({ action: 'collab', operation: 'create', goal: 'Build the widget' });
  assert.equal(created.status, 200);
  assert.equal(created.body.tasks.length, 1);
  assert.equal(created.body.tasks[0].reviewer, 'grok');
  assert.notEqual(created.body.tasks[0].reviewer, created.body.tasks[0].owner);
  assert.equal(calls.filter(call => call.route.endsWith('/api/sendPrompt')).length, 2);
});

test('an explicit reviewer who is also the owner is rejected once and then corrected', async t => {
  const { fetchImpl, calls } = scripted({
    grok(_prompt, send) {
      if (send === 1) return block([{ op: 'plan', tasks: [{ title: 'Build', spec: 'Make it', acceptance: ['It runs'], owner: 'hermes', reviewer: 'hermes', role: 'executor' }] }]);
      return block([{ op: 'plan', tasks: [{ title: 'Build', spec: 'Make it', acceptance: ['It runs'], owner: 'hermes', reviewer: 'grok', role: 'executor' }] }]);
    },
  });
  const room = await open(t, fetchImpl);
  const created = await room.request({ action: 'collab', operation: 'create', goal: 'Build the widget' });
  assert.equal(created.status, 200);
  assert.equal(created.body.tasks[0].owner, 'hermes');
  assert.equal(created.body.tasks[0].reviewer, 'grok');
  assert.equal(calls.filter(call => call.route.endsWith('/api/sendPrompt')).length, 2);
});

test('review changes fail the task at maxAttempts', async t => {
  const { fetchImpl } = scripted({
    grok(prompt) {
      if (prompt.includes('No tasks exist yet')) return block([{ op: 'plan', tasks: [{ title: 'Draft', spec: 'Write it', acceptance: ['Clear'], owner: 'hermes', reviewer: 'grok', role: 'executor', skillsHint: ['code'] }] }]);
      return reviewBlock(prompt, 'changes', 'needs another pass');
    },
    hermes(prompt) {
      if (prompt.includes('Status: working')) return block([{ op: 'submit', taskId: taskIdFrom(prompt), summary: 'revised', artifacts: [], selfCheck: {} }]);
      return workBlock(prompt);
    },
  });
  const room = await open(t, fetchImpl);
  const created = await room.request({ action: 'collab', operation: 'create', goal: 'Draft the page' });
  const project_id = created.body.project.id;
  let body = (await room.request({ action: 'collab', operation: 'resolve', project_id, choice: 'approve' })).body;
  for (let i = 0; i < 4 && !body.tasks.some(task => task.status === 'failed'); i += 1) {
    body = (await room.request({ action: 'collab', operation: 'state', project_id })).body;
  }
  assert.equal(body.tasks[0].status, 'failed');
  assert.equal(body.tasks[0].reviewAttempts >= body.tasks[0].maxAttempts, true);
  assert.equal(body.events.some(item => item.type === 'review' && item.data.verdict === 'changes'), true);
});

test('the turn budget warns and then pauses before another agent starts', async t => {
  const { fetchImpl, calls } = scripted({
    grok: () => block([{ op: 'plan', tasks: [{ title: 'Draft', spec: 'Write it', acceptance: ['Clear'], owner: 'hermes', reviewer: 'grok', role: 'executor' }] }]),
    hermes: prompt => workBlock(prompt),
  });
  const room = await open(t, fetchImpl);
  const created = await room.request({ action: 'collab', operation: 'create', goal: 'A short project', max_turns: 2 });
  assert.equal(created.body.project.status, 'active');
  const project_id = created.body.project.id;
  const resolved = await room.request({ action: 'collab', operation: 'resolve', project_id, choice: 'approve' });
  assert.equal(resolved.body.project.status, 'paused');
  assert.match(resolved.body.project.activity, /Budget reached/);
  assert.equal(resolved.body.tasks[0].status, 'review');
  assert.equal(resolved.body.events.some(item => item.type === 'budget' && item.data.level === 'warn'), true);
  assert.equal(resolved.body.events.some(item => item.type === 'budget' && item.data.level === 'pause'), true);
  assert.equal(calls.filter(call => call.route.endsWith('/api/sendPrompt')).length, 1);
});

test('an expired task lease retries the owner', async t => {
  let clock = 1_700_000_000_000;
  const { fetchImpl, calls } = scripted({
    grok: () => block([{ op: 'plan', tasks: [{ title: 'Draft', spec: 'Write it', acceptance: ['Clear'], owner: 'hermes', reviewer: 'grok', role: 'executor' }] }]),
    hermes: prompt => block([{ op: 'claim', taskId: taskIdFrom(prompt) }]),
  });
  const room = await open(t, fetchImpl, { grokOptions: { now: () => clock } });
  const created = await room.request({ action: 'collab', operation: 'create', goal: 'Hold the lease' });
  const project_id = created.body.project.id;
  const claimed = await room.request({ action: 'collab', operation: 'resolve', project_id, choice: 'approve' });
  assert.equal(claimed.body.tasks[0].status, 'working');
  assert.equal(claimed.body.running, '');
  const posts = calls.filter(call => call.route === 'http://hermes.test/v1/runs' && call.method === 'POST').length;
  clock += (10 * 60 * 1000) + 1;
  const expired = await room.request({ action: 'collab', operation: 'state', project_id });
  assert.equal(expired.body.tasks[0].attempts >= 1, true);
  assert.match(expired.body.tasks[0].lastError, /lease expired/);
  assert.equal(calls.filter(call => call.route === 'http://hermes.test/v1/runs' && call.method === 'POST').length > posts, true);
});

test('Kyle can reassign a task, and a risky write waits for approval', async t => {
  const { fetchImpl } = scripted({
    grok(prompt) {
      if (prompt.includes('No tasks exist yet')) return block([{ op: 'plan', tasks: [{ title: 'Draft', spec: 'Write it', acceptance: ['Clear'], owner: 'hermes', reviewer: 'grok', role: 'executor' }] }]);
      return reviewBlock(prompt);
    },
    hermes(prompt, count) {
      if (count === 1) return workBlock(prompt, { risk: 'delete', name: 'danger.md' });
      return workBlock(prompt, { name: 'safe.md' });
    },
  });
  const room = await open(t, fetchImpl);
  const created = await room.request({ action: 'collab', operation: 'create', goal: 'Be careful' });
  const project_id = created.body.project.id;
  const same = await room.request({ action: 'collab', operation: 'reassign', project_id, task_id: created.body.tasks[0].id, owner: 'grok', reviewer: 'grok', role: 'executor' });
  assert.equal(same.status, 400);
  assert.match(same.body.error, /Reviewer must be a different agent/);
  const moved = await room.request({ action: 'collab', operation: 'reassign', project_id, task_id: created.body.tasks[0].id, owner: 'grok', reviewer: 'hermes', role: 'researcher' });
  assert.equal(moved.status, 200);
  assert.equal(moved.body.tasks[0].owner, 'grok');
  assert.equal(moved.body.tasks[0].role, 'researcher');
  const back = await room.request({ action: 'collab', operation: 'reassign', project_id, task_id: created.body.tasks[0].id, owner: 'hermes', reviewer: 'grok', role: 'executor' });
  assert.equal(back.status, 200);
  const gated = await room.request({ action: 'collab', operation: 'resolve', project_id, choice: 'approve' });
  assert.equal(gated.body.project.gate.type, 'risk');
  assert.equal(gated.body.artifacts.length, 0);
  const allowed = await room.request({ action: 'collab', operation: 'resolve', project_id, choice: 'approve' });
  assert.equal(allowed.body.artifacts.some(item => item.name === 'danger.md'), true);
});

test('wall-clock budget pauses an otherwise idle project', async t => {
  let clock = 1_700_000_000_000;
  const { fetchImpl } = scripted({
    grok: () => block([{ op: 'plan', tasks: [{ title: 'Draft', spec: 'Write it', acceptance: ['Clear'], role: 'executor', skillsHint: ['code'] }] }]),
  });
  const room = await open(t, fetchImpl, { grokOptions: { now: () => clock } });
  const created = await room.request({ action: 'collab', operation: 'create', goal: 'Wait', max_wall_min: 1 });
  clock += 60 * 1000 + 1;
  const paused = await room.request({ action: 'collab', operation: 'state', project_id: created.body.project.id });
  assert.equal(paused.body.project.status, 'paused');
  assert.match(paused.body.project.activity, /Budget reached/);
});

test('a plan accepts display names and unknown roles, lists the vocabulary, and waits on dependsOn titles', async t => {
  const { fetchImpl, calls } = scripted({
    grok: () => block([{
      op: 'plan',
      tasks: [
        { title: 'Research the notes', spec: 'Find the facts', acceptance: ['Sources are listed'], role: 'Writer', owner: 'Grok Bot', skillsHint: ['Research', 'writing'] },
        { title: 'Implement the change', spec: 'Edit the code', acceptance: ['Tests pass'], role: 'Planner', owner: 'Hermes', reviewer: 'Grok Bot', skillsHint: ['code'], dependsOn: ['Research the notes'] },
      ],
    }]),
  });
  const room = await open(t, fetchImpl);
  const created = await room.request({ action: 'collab', operation: 'create', goal: 'Ship the notes' });
  assert.equal(created.status, 200);
  const research = created.body.tasks.find(task => task.title === 'Research the notes');
  const implement = created.body.tasks.find(task => task.title === 'Implement the change');
  assert.equal(research.owner, 'grok');
  assert.equal(research.role, 'researcher');
  assert.equal(research.reviewer, 'hermes');
  assert.equal(research.status, 'planned');
  assert.equal(implement.owner, 'hermes');
  assert.equal(implement.reviewer, 'grok');
  assert.equal(implement.role, 'planner');
  assert.deepEqual(implement.dependsOn, [research.id]);
  const prompt = calls.find(call => call.route.endsWith('/api/sendPrompt')).payload.prompt;
  assert.match(prompt, /planner, executor, reviewer, researcher/);
  assert.match(prompt, /hermes or grok/);
  assert.match(prompt, /terminal, tools, code, research, reasoning, writing/);
  assert.match(prompt, /dependsOn is an array of exact task titles/);
  assert.match(prompt, /No tasks exist yet/);
});

test('a reviewer receives the current task artifact text', async t => {
  const marker = `ALPHA-REVIEW-BODY${'x'.repeat(2500)}OMEGA-TAIL`;
  const { fetchImpl, calls } = scripted({
    grok(prompt) {
      if (prompt.includes('No tasks exist yet')) return block([{ op: 'plan', tasks: [{ title: 'Draft', spec: 'Write it', acceptance: ['Clear'], owner: 'hermes', reviewer: 'grok', role: 'executor' }] }]);
      return reviewBlock(prompt);
    },
    hermes: prompt => workBlock(prompt, { content: marker }),
  });
  const room = await open(t, fetchImpl);
  const created = await room.request({ action: 'collab', operation: 'create', goal: 'Read the file' });
  await room.request({ action: 'collab', operation: 'resolve', project_id: created.body.project.id, choice: 'approve' });
  const review = calls.filter(call => call.route.endsWith('/api/sendPrompt')).map(call => call.payload.prompt).find(prompt => prompt.includes('reviewer as'));
  assert.match(review, /ALPHA-REVIEW-BODY/);
  assert.equal(review.includes('OMEGA-TAIL'), false);
});

test('archive keeps a project out of scheduling and delete removes it', async t => {
  const { fetchImpl } = scripted({
    grok: () => block([{ op: 'plan', tasks: [{ title: 'Draft', spec: 'Write it', acceptance: ['Clear'], role: 'executor', skillsHint: ['code'] }] }]),
  });
  const room = await open(t, fetchImpl);
  const created = await room.request({ action: 'collab', operation: 'create', goal: 'Keep or drop' });
  const project_id = created.body.project.id;
  const archived = await room.request({ action: 'collab', operation: 'archive', project_id });
  assert.equal(archived.status, 200);
  assert.equal(archived.body.project.status, 'archived');
  assert.equal(archived.body.running, '');
  const listed = await room.request({ action: 'collab', operation: 'list' });
  assert.equal(listed.body.projects[0].status, 'archived');
  const removed = await room.request({ action: 'collab', operation: 'delete', project_id });
  assert.equal(removed.status, 200);
  assert.equal(removed.body.deleted, true);
  const after = await room.request({ action: 'collab', operation: 'list' });
  assert.equal(after.body.projects.length, 0);
  const missing = await room.request({ action: 'collab', operation: 'state', project_id });
  assert.equal(missing.status, 404);
});

test('/collab in the shared room opens a project', async t => {
  const { fetchImpl } = scripted({
    grok: () => block([{ op: 'plan', tasks: [{ title: 'Draft', spec: 'Write it', acceptance: ['Clear'], role: 'researcher', skillsHint: ['writing'] }] }]),
  });
  const room = await open(t, fetchImpl);
  const posted = await room.request({ action: 'shared_agents', operation: 'post', text: '/collab Write the changelog' });
  assert.equal(posted.status, 200);
  assert.match(posted.body.messages.at(-1).text, /Opened Collab project p_[a-f0-9]{16}/);
  assert.equal(posted.body.collabProject.id, listedId(posted.body.messages.at(-1).text));
  assert.equal(posted.body.running, '');
  const bare = await room.request({ action: 'shared_agents', operation: 'post', text: '/collab' });
  assert.match(bare.body.messages.at(-1).text, /Add a goal after \/collab/);
  const listed = await room.request({ action: 'collab', operation: 'list' });
  assert.equal(listed.body.projects.length, 1);
  assert.equal(listed.body.projects[0].goal, 'Write the changelog');
});

function listedId(text) {
  return String(text || '').match(/p_[a-f0-9]{16}/)?.[0] || '';
}

test('collab blocks name the mistake and the allowed ops', () => {
  const unknown = parseCollabBlock(block([{ op: 'launch' }]));
  assert.equal(unknown.ok, false);
  assert.match(unknown.error, /Allowed ops: .*run-tests/);
  const shell = parseCollabBlock(block([{ op: 'run-tests', taskId: 't_0123456789abcdef', command: 'bash -c echo' }]));
  assert.equal(shell.ok, false);
  assert.match(shell.error, /plain tokens/);
});

test('independent tasks start together and a stale artifact write is rejected', async t => {
  const parallel = block([{
    op: 'plan',
    tasks: [
      { title: 'Write the notes', spec: 'Draft notes', acceptance: ['Notes exist'], role: 'researcher', owner: 'grok', reviewer: 'hermes', skillsHint: ['writing'] },
      { title: 'Write the code', spec: 'Draft code', acceptance: ['Code exists'], role: 'executor', owner: 'hermes', reviewer: 'grok', skillsHint: ['code', 'terminal'] },
    ],
  }]);
  const sameFile = (prompt, name) => {
    const id = taskIdFrom(prompt);
    return block([
      { op: 'claim', taskId: id },
      { op: 'artifact.put', name, kind: 'note', content: `from ${id}`, taskId: id, baseVersion: 0 },
      { op: 'submit', taskId: id, summary: `finished ${id}`, artifacts: [], selfCheck: {} },
    ]);
  };
  const script = scripted({
    hermes: input => (input.includes('previous collab block was rejected') ? reviewBlock(input) : input.includes('Write the code') ? sameFile(input, 'shared.md') : reviewBlock(input)),
    grok: prompt => (prompt.includes('No tasks exist yet') ? parallel : prompt.includes('previous collab block was rejected') ? block([{ op: 'decision', text: 'Read the new version before writing shared.md again.' }]) : prompt.includes('Write the notes') ? sameFile(prompt, 'shared.md') : reviewBlock(prompt)),
  });
  const room = await open(t, script.fetchImpl);
  const created = await room.request({ action: 'collab', operation: 'create', goal: 'Write notes and code together' });
  assert.equal(created.status, 200);
  assert.ok(String(created.body.workspace || '').endsWith(`${path.sep}workspace`));
  assert.equal(fs.existsSync(path.join(created.body.workspace, '.git')), true);
  const before = script.calls.length;
  const resolved = await room.request({ action: 'collab', operation: 'resolve', project_id: created.body.project.id, choice: 'approve' });
  assert.equal(resolved.status, 200);
  const slice = script.calls.slice(before);
  const hermesStart = slice.findIndex(call => call.route === 'http://hermes.test/v1/runs' && call.method === 'POST');
  const grokStart = slice.findIndex(call => call.route.endsWith('/api/sendPrompt'));
  const hermesPoll = slice.findIndex(call => /^http:\/\/hermes\.test\/v1\/runs\/run_/.test(call.route) && !call.route.endsWith('/stop'));
  assert.ok(hermesStart >= 0 && grokStart >= 0 && hermesPoll >= 0);
  assert.ok(grokStart < hermesPoll, 'Grok should start before Hermes is polled');
  const prompts = script.calls.filter(call => call.route.endsWith('/api/sendPrompt')).map(call => call.payload.prompt);
  assert.ok(prompts.some(prompt => prompt.includes('shared.md is at version')));
  const shared = resolved.body.artifacts.find(item => item.name === 'shared.md');
  assert.ok(shared);
  assert.equal(shared.versions.at(-1).v, 1);
});

test('run-tests stores an artifact and indexes a workspace file', async t => {
  const plan = block([{
    op: 'plan',
    tasks: [{ title: 'Prove addition', spec: 'Add a test and run it', acceptance: ['The test command exits 0'], role: 'executor', owner: 'hermes', reviewer: 'grok', skillsHint: ['code', 'terminal'] }],
  }]);
  const script = scripted({
    hermes: input => {
      if (input.includes('previous collab block was rejected')) return block([{ op: 'decision', text: 'Corrected.' }]);
      const id = taskIdFrom(input);
      if (!id) return block([{ op: 'decision', text: 'Waiting.' }]);
      return block([
        { op: 'claim', taskId: id },
        { op: 'artifact.put', name: 'test/add.test.mjs', kind: 'file', content: "import test from 'node:test';\nimport assert from 'node:assert/strict';\ntest('adds', () => assert.equal(1 + 1, 2));\n", taskId: id, baseVersion: 0 },
        { op: 'run-tests', taskId: id, command: 'node --test test/add.test.mjs' },
        { op: 'workspace.sync', taskId: id },
        { op: 'submit', taskId: id, summary: 'Addition test passed', artifacts: [], selfCheck: { tests: 'pass' } },
      ]);
    },
    grok: prompt => (prompt.includes('No tasks exist yet') ? plan : reviewBlock(prompt)),
  });
  const room = await open(t, script.fetchImpl);
  const created = await room.request({ action: 'collab', operation: 'create', goal: 'Prove addition' });
  fs.writeFileSync(path.join(created.body.workspace, 'FROM-TERMINAL.txt'), 'indexed from the workspace\n', { mode: 0o600 });
  const resolved = await room.request({ action: 'collab', operation: 'resolve', project_id: created.body.project.id, choice: 'approve' });
  assert.equal(resolved.status, 200, JSON.stringify(resolved.body.error || resolved.body.project?.activity || ''));
  const results = resolved.body.artifacts.find(item => item.name === 'test-results.txt');
  const terminal = resolved.body.artifacts.find(item => item.name === 'FROM-TERMINAL.txt');
  assert.ok(results);
  assert.ok(terminal);
  const read = await room.request({ action: 'collab', operation: 'artifact', project_id: created.body.project.id, artifact_id: results.id });
  assert.match(read.body.content, /exit: 0/);
  assert.equal(fs.existsSync(path.join(created.body.workspace, 'test', 'add.test.mjs')), true);
});
