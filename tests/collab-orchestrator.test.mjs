import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createAgentHandler } from '../server/agent.mjs';
import { parseCollabBlock } from '../server/collab.mjs';
import { noteLoop, parseBrief } from '../server/collab-orchestrator.mjs';

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

function brief(extra = {}) {
  return {
    objective: 'Write the notes file',
    deliverable: 'notes.txt',
    acceptance: ['notes.txt exists'],
    allowedTools: ['code', 'terminal'],
    scope: ['notes.txt'],
    budget: { turns: 4, tokens: 4000, minutes: 5 },
    returnFormat: 'summary+paths',
    ...extra,
  };
}

function open(t, fetchImpl, options = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-collab-orch-'));
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
  const subRuns = new Set();
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
      const id = `run_orch${String(hermesPosts).padStart(4, '0')}`;
      if (String(payload.input || '').includes('You are a Collab subagent')) subRuns.add(id);
      hermesOutput.set(id, replies.hermes?.(payload.input, hermesPosts) || '```collab\n{"ops":[]}\n```');
      return json({ run_id: id, status: 'running' });
    }
    if (route.startsWith('http://hermes.test/v1/runs/') && route.endsWith('/stop')) return json({ status: 'stopping' });
    if (route.startsWith('http://hermes.test/v1/runs/')) {
      const id = route.split('/').at(-1);
      const status = replies.hermesStatus?.(payload, hermesPosts, id, subRuns) || 'completed';
      if (status === 'running') return json({ status: 'running' });
      if (status === 'error') return json({ error: 'down' }, 500);
      return json({ status: 'completed', output: hermesOutput.get(id) || '', usage: { total_tokens: 20 } });
    }
    if (route.endsWith('/api/listAgents')) return json(agents);
    if (route.endsWith('/api/createAgent')) {
      const name = payload.name;
      const id = name === 'Orbit collab' ? 'agent_collab_1' : String(name).startsWith('Orbit collab sub:') ? `agent_sub_${agents.length}` : 'agent_shared_1';
      agents.push({ id, name });
      return json({ agent: { id, name } });
    }
    if (route.endsWith('/api/archiveAgent')) return json({ ok: true });
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
  return { fetchImpl, calls, agents, subRuns };
}

function plan(extra = {}, taskExtra = {}) {
  return block([{
    op: 'plan',
    orchestrator: 'grok',
    effort: 'complex',
    ...extra,
    tasks: [{
      title: 'Write the notes',
      spec: 'Create notes.txt',
      acceptance: ['The file exists'],
      owner: 'hermes',
      reviewer: 'grok',
      role: 'executor',
      skillsHint: ['code', 'terminal'],
      ...taskExtra,
    }],
  }]);
}

test('a spawn brief requires every field and summary+paths', () => {
  const id = 't_0123456789abcdef';
  assert.match(parseCollabBlock(block([{ op: 'spawn', taskId: id, brief: { objective: 'x' } }])).error, /objective and a deliverable/);
  assert.match(parseCollabBlock(block([{ op: 'spawn', taskId: id, brief: { ...brief(), acceptance: [] } }])).error, /acceptance/);
  assert.match(parseCollabBlock(block([{ op: 'spawn', taskId: id, brief: { ...brief(), allowedTools: ['rm'] } }])).error, /unknown/);
  assert.match(parseCollabBlock(block([{ op: 'spawn', taskId: id, brief: { ...brief(), scope: ['../secret'] } }])).error, /relative/);
  assert.match(parseCollabBlock(block([{ op: 'spawn', taskId: id, brief: { ...brief(), budget: { turns: 1, tokens: 100 } } }])).error, /minutes/);
  assert.match(parseCollabBlock(block([{ op: 'spawn', taskId: id, brief: { ...brief(), budget: { turns: 1, tokens: 100, minutes: 31 } } }])).error, /30/);
  assert.match(parseCollabBlock(block([{ op: 'spawn', taskId: id, brief: { ...brief(), returnFormat: 'text' } }])).error, /summary\+paths/);
  assert.match(parseCollabBlock(block([{ op: 'spawn', taskId: id, brief: { ...brief(), scope: [] } }])).error, /disjoint file scope/);
  assert.equal(parseCollabBlock(block([{ op: 'spawn', taskId: id, brief: brief() }])).ok, true);
  assert.equal(parseBrief(brief()).brief.returnFormat, 'summary+paths');
  const loop = ['a', 'b', 'a', 'b'].reduce((state, item) => noteLoop(state.recent, item), { recent: [] });
  assert.equal(loop.blocked, true);
});

test('trivial work cannot spawn, and parallel caps are 2, 4, and 3 per agent', async t => {
  const { fetchImpl, calls } = scripted({
    grok: prompt => (prompt.includes('No tasks exist yet') ? plan({ effort: 'trivial' }) : block([{ op: 'status', summary: 'Standing by.' }])),
    hermes: prompt => (prompt.includes('previous collab block was rejected')
      ? block([{ op: 'decision', text: 'No subagent for this trivial task.' }])
      : block([{ op: 'spawn', taskId: taskIdFrom(prompt), brief: brief() }])),
  });
  const room = await open(t, fetchImpl);
  const created = await room.request({ action: 'collab', operation: 'create', goal: 'Keep it small' });
  const project_id = created.body.project.id;
  assert.equal(created.body.project.orchestrator, 'grok');
  const trivial = await room.request({ action: 'collab', operation: 'resolve', project_id, choice: 'approve' });
  assert.equal(trivial.body.subagents.length, 0);
  assert.match(calls.map(call => call.payload?.input || '').join('\n'), /trivial/);

  const moderate = scripted({
    grok: prompt => (prompt.includes('No tasks exist yet') ? plan({ effort: 'moderate' }) : block([{ op: 'status', summary: 'Standing by.' }])),
    hermes: prompt => (prompt.includes('previous collab block was rejected')
      ? block([{ op: 'decision', text: 'Too many subagents.' }])
      : block([
        { op: 'spawn', taskId: taskIdFrom(prompt), name: 'a', brief: brief({ scope: ['a.txt'], objective: 'Write a' }) },
        { op: 'spawn', taskId: taskIdFrom(prompt), name: 'b', brief: brief({ scope: ['b.txt'], objective: 'Write b' }) },
        { op: 'spawn', taskId: taskIdFrom(prompt), name: 'c', brief: brief({ scope: ['c.txt'], objective: 'Write c' }) },
      ])),
  });
  const room2 = await open(t, moderate.fetchImpl);
  const second = await room2.request({ action: 'collab', operation: 'create', goal: 'Three is too many' });
  const capped = await room2.request({ action: 'collab', operation: 'resolve', project_id: second.body.project.id, choice: 'approve' });
  assert.equal(capped.body.subagents.length, 0);
  assert.match(moderate.calls.map(call => call.payload?.input || '').join('\n'), /allows 2/);

  const crowded = scripted({
    grok: prompt => (prompt.includes('No tasks exist yet') ? plan({ effort: 'complex' }) : block([{ op: 'status', summary: 'Standing by.' }])),
    hermes: prompt => (prompt.includes('previous collab block was rejected')
      ? block([{ op: 'decision', text: 'Too many from one agent.' }])
      : block(['a', 'b', 'c', 'd'].map(name => ({ op: 'spawn', taskId: taskIdFrom(prompt), name, agent: 'hermes', brief: brief({ scope: [`${name}.txt`], objective: `Write ${name}` }) })))),
  });
  const room3 = await open(t, crowded.fetchImpl);
  const third = await room3.request({ action: 'collab', operation: 'create', goal: 'Four Hermes workers' });
  const limited = await room3.request({ action: 'collab', operation: 'resolve', project_id: third.body.project.id, choice: 'approve' });
  assert.equal(limited.body.subagents.length, 0);
  assert.match(crowded.calls.map(call => call.payload?.input || '').join('\n'), /3 subagents from Hermes/);
});

test('a fan-out shows projected tokens before the subagents start', async t => {
  const { fetchImpl } = scripted({
    grok: prompt => (prompt.includes('No tasks exist yet') ? plan() : block([{ op: 'status', summary: 'Standing by.' }])),
    hermes: (() => {
      let spawned = false;
      return prompt => {
      if (prompt.includes('You are a Collab subagent')) return block([{ op: 'status', summary: 'Done', artifactPaths: [] }]);
      if (spawned || prompt.includes('previous collab block was rejected')) return block([{ op: 'decision', text: 'Corrected.' }]);
      spawned = true;
      const id = taskIdFrom(prompt);
      return block([
        { op: 'spawn', taskId: id, name: 'a', brief: brief({ scope: ['a.txt'], objective: 'Write a', budget: { turns: 2, tokens: 1500, minutes: 5 } }) },
        { op: 'spawn', taskId: id, name: 'b', brief: brief({ scope: ['b.txt'], objective: 'Write b', budget: { turns: 2, tokens: 2500, minutes: 5 } }) },
      ]);
      };
    })(),
  });
  const room = await open(t, fetchImpl);
  const created = await room.request({ action: 'collab', operation: 'create', goal: 'Fan out' });
  const project_id = created.body.project.id;
  const gated = await room.request({ action: 'collab', operation: 'resolve', project_id, choice: 'approve' });
  assert.equal(gated.body.project.gate.type, 'fanout');
  assert.match(gated.body.project.gate.summary, /4000 tokens/);
  assert.equal(gated.body.subagents.length, 0);
  const started = await room.request({ action: 'collab', operation: 'resolve', project_id, choice: 'approve' });
  assert.equal(started.body.subagents.length, 2);
  assert.equal(started.body.subagents.every(sub => sub.status === 'completed'), true);
  for (const sub of started.body.subagents) {
    assert.equal(fs.existsSync(path.join(created.body.workspace, '.orbit', 'worktrees', sub.id)), true);
  }
});

test('Hermes subagents get a new session and Grok subagents are archived agents', async t => {
  const { fetchImpl, calls } = scripted({
    grok(prompt) {
      if (prompt.includes('No tasks exist yet')) return plan({ effort: 'moderate' });
      if (prompt.includes('You are a Collab subagent')) return block([{ op: 'status', summary: 'Research notes', artifactPaths: [] }]);
      return block([{ op: 'status', summary: 'Recorded the result.' }]);
    },
    hermes: (() => {
      let spawned = false;
      return prompt => {
        if (spawned || prompt.includes('previous collab block was rejected')) return block([{ op: 'decision', text: 'Corrected.' }]);
        spawned = true;
        return block([{
          op: 'spawn', taskId: taskIdFrom(prompt), agent: 'grok',
          brief: brief({ allowedTools: ['research', 'read'], scope: [], objective: 'Read the notes' }),
        }]);
      };
    })(),
  });
  const room = await open(t, fetchImpl);
  const created = await room.request({ action: 'collab', operation: 'create', goal: 'Research aside' });
  const project_id = created.body.project.id;
  const done = await room.request({ action: 'collab', operation: 'resolve', project_id, choice: 'approve' });
  assert.equal(done.status, 200, JSON.stringify(done.body.error || done.body.project?.activity || ''));
  assert.equal(done.body.subagents.length, 1);
  assert.equal(done.body.subagents[0].status, 'completed');
  assert.match(done.body.subagents[0].name, /^Orbit collab sub: /);
  assert.equal(done.body.subagents[0].summary, 'Research notes');
  assert.equal(done.body.tasks[0].reviewer, 'grok');
  assert.notEqual(done.body.tasks[0].status, 'completed');
  const createdAgents = calls.filter(call => call.route.endsWith('/api/createAgent'));
  assert.equal(createdAgents.some(call => call.payload.name === 'Orbit collab'), true);
  assert.equal(createdAgents.some(call => String(call.payload.name).startsWith('Orbit collab sub:')), true);
  assert.equal(calls.some(call => call.payload?.agentId === 'main_bot'), false);
  assert.equal(calls.some(call => call.route.endsWith('/api/archiveAgent') && call.payload.id.startsWith('agent_sub_')), true);
  const sessions = calls.filter(call => call.route === 'http://hermes.test/v1/runs' && call.method === 'POST').map(call => call.payload.session_id);
  assert.equal(sessions.some(id => String(id).startsWith('orbit-sub-')), false);
  assert.equal(new Set(sessions).size, 1);
});

test('a coding subagent gets a worktree, and merge rebases before Kyle can push', async t => {
  let spawned = false;
  const { fetchImpl } = scripted({
    grok(prompt) {
      if (prompt.includes('No tasks exist yet')) return plan({ effort: 'moderate' });
      if (prompt.includes('Subagent results')) return block([{ op: 'merge', taskId: taskIdFrom(prompt), push: true }]);
      return block([{ op: 'status', summary: 'Standing by.' }]);
    },
    hermes(prompt) {
      if (prompt.includes('You are a Collab subagent')) {
        const worktree = prompt.match(/Worktree: (\S+)/)?.[1];
        fs.writeFileSync(path.join(worktree, 'notes.txt'), 'from-sub\n');
        return block([{ op: 'status', summary: 'Wrote notes.txt', artifactPaths: ['notes.txt'] }]);
      }
      if (spawned || prompt.includes('previous collab block was rejected')) return block([{ op: 'decision', text: `Waiting on the merge ${prompt.length}.` }]);
      spawned = true;
      return block([{ op: 'spawn', taskId: taskIdFrom(prompt), brief: brief() }]);
    },
  });
  const room = await open(t, fetchImpl);
  const created = await room.request({ action: 'collab', operation: 'create', goal: 'Write notes in a worktree' });
  const project_id = created.body.project.id;
  const merged = await room.request({ action: 'collab', operation: 'resolve', project_id, choice: 'approve' });
  assert.equal(merged.status, 200, JSON.stringify(merged.body.error || merged.body.project?.activity || ''));
  assert.equal(merged.body.subagents[0].status, 'completed');
  assert.match(merged.body.subagents[0].branch, /^orbit\/s_[a-f0-9]{16}$/);
  assert.equal(merged.body.subagents[0].merged, true);
  assert.equal(fs.readFileSync(path.join(created.body.workspace, 'notes.txt'), 'utf8'), 'from-sub\n');
  assert.equal(fs.existsSync(path.join(created.body.workspace, '.orbit', 'worktrees', merged.body.subagents[0].id)), false);
  assert.equal(merged.body.project.gate.type, 'risk');
  assert.match(merged.body.project.gate.summary, /git\.push/);
  assert.equal(merged.body.events.some(item => item.type === 'git.push'), false);
  assert.equal(merged.body.tasks[0].owner, 'hermes');
  assert.equal(merged.body.tasks[0].reviewer, 'grok');
  const pushed = await room.request({ action: 'collab', operation: 'resolve', project_id, choice: 'approve' });
  assert.equal(pushed.body.events.some(item => item.type === 'git.push'), true);
  assert.equal(pushed.body.events.some(item => item.type === 'approval.resolved' && item.data.type === 'risk'), true);
});

test('overlapping coding scopes are rejected and a rebase conflict becomes a resolve task', async t => {
  const overlap = scripted({
    grok: prompt => (prompt.includes('No tasks exist yet') ? plan() : block([{ op: 'status', summary: 'Standing by.' }])),
    hermes: prompt => (prompt.includes('previous collab block was rejected')
      ? block([{ op: 'decision', text: 'Those files overlap.' }])
      : block([
        { op: 'spawn', taskId: taskIdFrom(prompt), name: 'a', brief: brief({ scope: ['notes.txt'], objective: 'Write a' }) },
        { op: 'spawn', taskId: taskIdFrom(prompt), name: 'b', brief: brief({ scope: ['notes.txt'], objective: 'Write b' }) },
      ])),
  });
  const room = await open(t, overlap.fetchImpl);
  const created = await room.request({ action: 'collab', operation: 'create', goal: 'Do not share a file' });
  const rejected = await room.request({ action: 'collab', operation: 'resolve', project_id: created.body.project.id, choice: 'approve' });
  assert.equal(rejected.body.subagents.length, 0);
  assert.match(overlap.calls.map(call => call.payload?.input || '').join('\n'), /disjoint files/);

  const conflicted = scripted({
    grok(prompt) {
      if (prompt.includes('No tasks exist yet')) return plan({ effort: 'moderate' });
      if (prompt.includes('Subagent results')) return block([{ op: 'merge', taskId: taskIdFrom(prompt) }]);
      return block([{ op: 'status', summary: 'Standing by.' }]);
    },
    hermes: (() => {
      let spawned = false;
      return prompt => {
        if (prompt.includes('You are a Collab subagent')) {
          const worktree = prompt.match(/Worktree: (\S+)/)?.[1];
          const workspace = prompt.match(/Workspace directory: (\S+)/)?.[1];
          fs.writeFileSync(path.join(worktree, 'notes.txt'), 'from-sub\n');
          fs.writeFileSync(path.join(workspace, 'notes.txt'), 'from-main\n');
          spawnSync('git', ['add', 'notes.txt'], { cwd: workspace });
          spawnSync('git', ['commit', '-m', 'main edit'], { cwd: workspace });
          return block([{ op: 'status', summary: 'Wrote notes.txt', artifactPaths: ['notes.txt'] }]);
        }
        if (spawned || prompt.includes('previous collab block was rejected')) return block([{ op: 'decision', text: 'Waiting.' }]);
        spawned = true;
        return block([{ op: 'spawn', taskId: taskIdFrom(prompt), brief: brief() }]);
      };
    })(),
  });
  const room2 = await open(t, conflicted.fetchImpl);
  const second = await room2.request({ action: 'collab', operation: 'create', goal: 'Conflict on purpose' });
  const body = await room2.request({ action: 'collab', operation: 'resolve', project_id: second.body.project.id, choice: 'approve' });
  assert.equal(body.status, 200, JSON.stringify(body.body.error || body.body.project?.activity || ''));
  const resolve = body.body.tasks.find(task => task.kind === 'resolve');
  assert.ok(resolve, JSON.stringify(body.body.tasks.map(task => task.title)));
  assert.notEqual(resolve.owner, resolve.reviewer);
  assert.match(resolve.title, /Resolve orbit\/s_/);
});

test('depth defaults to 1 and can be raised to 2', async t => {
  const shallow = scripted({
    grok: prompt => (prompt.includes('No tasks exist yet') ? plan({ effort: 'moderate' }) : block([{ op: 'status', summary: 'Standing by.' }])),
    hermes: (() => {
      let spawned = false;
      return prompt => {
        const id = taskIdFrom(prompt);
        if (prompt.includes('You are a Collab subagent')) {
          if (prompt.includes('previous collab block was rejected')) return block([{ op: 'status', summary: 'Stopped at the depth cap', artifactPaths: [] }]);
          return block([{ op: 'spawn', taskId: id, agent: 'hermes', brief: brief({ allowedTools: ['research', 'read'], scope: [], objective: 'Read more' }) }]);
        }
        if (spawned) return block([{ op: 'decision', text: 'Waiting.' }]);
        spawned = true;
        return block([{ op: 'spawn', taskId: id, agent: 'hermes', brief: brief({ allowedTools: ['research', 'read'], scope: [], objective: 'Read the notes' }) }]);
      };
    })(),
  });
  const room = await open(t, shallow.fetchImpl);
  const created = await room.request({ action: 'collab', operation: 'create', goal: 'Stay shallow' });
  const body = await room.request({ action: 'collab', operation: 'resolve', project_id: created.body.project.id, choice: 'approve' });
  assert.equal(body.body.subagents.length, 1);
  assert.equal(body.body.project.maxDepth, 1);
  assert.match(shallow.calls.map(call => call.payload?.input || call.payload?.prompt || '').join('\n'), /Subagents stop at depth 1/);

  let child = false;
  const deeper = scripted({
    grok: prompt => (prompt.includes('No tasks exist yet') ? plan({ effort: 'complex', maxDepth: 2 }) : block([{ op: 'status', summary: 'Standing by.' }])),
    hermes: (() => {
      let spawned = false;
      return prompt => {
        const id = taskIdFrom(prompt);
        if (prompt.includes('You are a Collab subagent')) {
          if (!child) {
            child = true;
            return block([
              { op: 'spawn', taskId: id, agent: 'hermes', brief: brief({ allowedTools: ['research', 'read'], scope: [], objective: 'Read more' }) },
              { op: 'status', summary: 'Spawned a reader', artifactPaths: [] },
            ]);
          }
          return block([{ op: 'status', summary: 'Read it', artifactPaths: [] }]);
        }
        if (spawned) return block([{ op: 'decision', text: 'Waiting.' }]);
        spawned = true;
        return block([{ op: 'spawn', taskId: id, agent: 'hermes', brief: brief({ allowedTools: ['research', 'read'], scope: [], objective: 'Read the notes' }) }]);
      };
    })(),
  });
  const room2 = await open(t, deeper.fetchImpl);
  const second = await room2.request({ action: 'collab', operation: 'create', goal: 'One level deeper' });
  const nested = await room2.request({ action: 'collab', operation: 'resolve', project_id: second.body.project.id, choice: 'approve' });
  assert.equal(nested.body.project.maxDepth, 2);
  assert.equal(nested.body.subagents.length, 2);
  assert.equal(nested.body.subagents.some(sub => sub.depth === 2 && sub.status === 'completed'), true);
});

test('a subagent timeout retries, then a gateway failure reroutes and a second failure notifies Kyle', async t => {
  let clock = 1_700_000_000_000;
  const slow = scripted({
    grok: prompt => (prompt.includes('No tasks exist yet') ? plan({ effort: 'moderate' }) : block([{ op: 'status', summary: 'Standing by.' }])),
    hermes: prompt => (prompt.includes('You are a Collab subagent')
      ? block([{ op: 'status', summary: 'Still going', artifactPaths: [] }])
      : block([{ op: 'spawn', taskId: taskIdFrom(prompt), brief: brief({ budget: { turns: 4, tokens: 4000, minutes: 1 } }) }])),
    hermesStatus: (_payload, _posts, id, subRuns) => (subRuns.has(id) ? 'running' : 'completed'),
  });
  const room = await open(t, slow.fetchImpl, { grokOptions: { now: () => clock } });
  const created = await room.request({ action: 'collab', operation: 'create', goal: 'Wait on a subagent' });
  const project_id = created.body.project.id;
  const running = await room.request({ action: 'collab', operation: 'resolve', project_id, choice: 'approve' });
  assert.equal(running.body.subagents[0].status, 'running');
  clock += 60 * 1000 + 1;
  const retried = await room.request({ action: 'collab', operation: 'state', project_id });
  assert.equal(retried.body.events.some(item => item.type === 'subagent.retry'), true);
  assert.match(retried.body.subagents[0].lastError, /1 minute/);

  const failing = scripted({
    grok(prompt) {
      if (prompt.includes('No tasks exist yet')) return plan({ effort: 'moderate' });
      if (prompt.includes('You are a Collab subagent')) return 'nope';
      return block([{ op: 'status', summary: 'Noted the failure.' }]);
    },
    hermes: (() => {
      let spawned = false;
      return prompt => {
        if (prompt.includes('You are a Collab subagent') || spawned) return block([{ op: 'decision', text: 'Waiting.' }]);
        spawned = true;
        return block([{ op: 'spawn', taskId: taskIdFrom(prompt), agent: 'hermes', brief: brief({ allowedTools: ['research', 'read'], scope: [], objective: 'Read the notes' }) }]);
      };
    })(),
    hermesStatus: (_payload, _posts, id, subRuns) => (subRuns.has(id) ? 'error' : 'completed'),
  });
  const room2 = await open(t, failing.fetchImpl);
  const second = await room2.request({ action: 'collab', operation: 'create', goal: 'Route around a failure' });
  const failed = await room2.request({ action: 'collab', operation: 'resolve', project_id: second.body.project.id, choice: 'approve' });
  assert.equal(failed.status, 200, JSON.stringify(failed.body.error || failed.body.project?.activity || ''));
  assert.equal(failed.body.subagents[0].status, 'failed');
  assert.equal(failed.body.events.some(item => item.type === 'subagent.reroute' && item.data.to === 'grok'), true);
  assert.equal(failed.body.events.some(item => item.type === 'subagent.failed' && item.data.notify === true), true);
  assert.match(failed.body.project.activity, /failed/);
});

test('repeated actions stop the project, and spans use GenAI names', async t => {
  const { fetchImpl } = scripted({
    grok: () => plan({ effort: 'moderate' }),
    hermes: () => block([{ op: 'decision', text: 'Same notes again and again here' }]),
  });
  const room = await open(t, fetchImpl);
  const created = await room.request({ action: 'collab', operation: 'create', goal: 'Do not spin' });
  assert.equal(created.body.events.some(item => item.type === 'span' && item.data.span === 'invoke_agent' && item.data['gen_ai.operation.name'] === 'invoke_agent'), true);
  const paused = await room.request({ action: 'collab', operation: 'resolve', project_id: created.body.project.id, choice: 'approve' });
  assert.equal(paused.body.project.status, 'paused');
  assert.match(paused.body.project.activity, /without progress/);
  assert.equal(paused.body.events.some(item => item.data?.loop === true && item.data?.notify === true), true);
  assert.equal(paused.body.events.some(item => item.type === 'span' && item.data.span === 'chat'), true);

  const room2 = await open(t, scripted({
    grok: () => plan({ effort: 'moderate' }, { maxTurns: 1 }),
    hermes: prompt => block([{ op: 'claim', taskId: taskIdFrom(prompt) }]),
  }).fetchImpl);
  const budgeted = await room2.request({ action: 'collab', operation: 'create', goal: 'One turn only' });
  const spent = await room2.request({ action: 'collab', operation: 'resolve', project_id: budgeted.body.project.id, choice: 'approve' });
  assert.equal(spent.body.tasks[0].status, 'working');
  const failed = await room2.request({ action: 'collab', operation: 'state', project_id: budgeted.body.project.id });
  assert.equal(failed.body.tasks[0].status, 'failed');
  assert.match(failed.body.tasks[0].lastError, /turn budget/);
  assert.equal(failed.body.events.some(item => item.type === 'task.state' && item.data.notify === true && item.data.status === 'failed'), true);

  const set = await room.request({ action: 'collab', operation: 'orchestrator', project_id: created.body.project.id, agent: 'hermes', effort: 'trivial', max_depth: 2 });
  assert.equal(set.body.project.orchestrator, 'hermes');
  assert.equal(set.body.project.effort, 'trivial');
  assert.equal(set.body.project.maxDepth, 2);
});
