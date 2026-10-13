import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createAgentHandler } from '../server/agent.mjs';
import { parseDelegate, routeAddressees } from '../server/shared-agents.mjs';

const token = 'orbit-test-token-'.repeat(4);
const session = 'orbit-12345678-1234-4234-9234-123456789abc';
const workspace_id = '12345678-1234-4234-9234-123456789abc';
const pane_id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

function open(t, fetchImpl, runtimeDirectory, options = {}) {
  const dir = runtimeDirectory || fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-shared-'));
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
      if (!runtimeDirectory) fs.rmSync(dir, { recursive: true, force: true });
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

test('mentions choose who speaks, and a reply with no handoff ends the exchange', async t => {
  const calls = [];
  let hermesGets = 0;
  let sentGrok = false;
  const agents = [{ id: 'main_bot', name: 'Main Grok' }];
  const fetchImpl = async (url, options = {}) => {
    const route = String(url);
    const payload = options.body ? JSON.parse(options.body) : {};
    calls.push({ route, method: options.method || 'GET', payload });
    const json = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
    if (route === 'http://hermes.test/v1/runs' && options.method === 'POST') return json({ run_id: 'run_sharedhermes01', status: 'running' });
    if (route === 'http://hermes.test/v1/runs/run_sharedhermes01') {
      hermesGets += 1;
      return json(hermesGets < 3 ? { status: 'running', session_id: payload.session_id } : { status: 'completed', output: 'from hermes', session_id: 'ignored' });
    }
    if (route.endsWith('/api/listAgents')) return json(agents);
    if (route.endsWith('/api/createAgent')) {
      agents.push({ id: 'agent_shared_1', name: payload.name });
      return json({ agent: { id: 'agent_shared_1', name: payload.name } });
    }
    if (route.endsWith('/api/sendPrompt')) { sentGrok = true; return json({ accepted: true }); }
    if (route.endsWith('/api/promptAcceptanceStatus')) return json({ outcome: 'found', record: { status: 'accepted' } });
    if (route.endsWith('/api/getAgentTranscriptTail')) return json(sentGrok ? [{ seq: 2, id: 'g1', kind: 'send-message', message: { type: 'text', content: 'from grok' } }] : []);
    if (route.endsWith('/api/interruptAgentRun')) return json({ ok: true });
    return json({ error: 'missing' }, 404);
  };
  const { request } = await open(t, fetchImpl);
  const posted = await request({ action: 'shared_agents', operation: 'post', text: '@hermes hello from the owner' });
  assert.equal(posted.status, 200);
  assert.equal(posted.body.messages[0].speaker, 'owner');
  assert.equal(posted.body.running, 'hermes');
  const during = await request({ action: 'shared_agents', operation: 'post', text: '@grok hold this until Hermes finishes' });
  assert.equal(during.status, 200);
  assert.equal(during.body.running, 'hermes');
  assert.equal(during.body.messages.some(message => message.text.includes('hold this')), true);
  const busy = await request({ action: 'shared_agents', operation: 'speak', speaker: 'grok' });
  assert.equal(busy.status, 409);
  const hermesCall = calls.find(call => call.route === 'http://hermes.test/v1/runs' && call.method === 'POST');
  assert.match(hermesCall.payload.input, /Kyle/);
  assert.match(hermesCall.payload.input, /@grok/);
  assert.match(hermesCall.payload.input, /Kyle: @hermes hello from the owner/);
  assert.match(hermesCall.payload.instructions, /\(quiet\)/);
  assert.notEqual(hermesCall.payload.session_id, session);
  const finished = await request({ action: 'shared_agents', operation: 'state' });
  assert.equal(finished.status, 200);
  assert.equal(finished.body.messages.some(message => message.speaker === 'hermes' && message.text === 'from hermes'), true);
  assert.equal(finished.body.hold, false);
  assert.equal(finished.body.running === 'hermes', false);
  const prompts = calls.filter(call => call.route.endsWith('/api/sendPrompt'));
  assert.equal(prompts.length, 1);
  assert.equal(prompts[0].payload.agentId, 'agent_shared_1');
  assert.match(prompts[0].payload.prompt, /Hermes: from hermes/);
  assert.match(prompts[0].payload.prompt, /hold this until Hermes finishes/);
  assert.equal(calls.find(call => call.route.endsWith('/api/createAgent')).payload.name, 'Orbit shared chat');
  assert.equal(prompts.some(call => call.payload.agentId === 'main_bot'), false);
  const again = await request({ action: 'shared_agents', operation: 'speak', speaker: 'grok', grok_agent_id: 'main_bot' });
  assert.equal(again.status, 200);
  assert.equal(calls.filter(call => call.route.endsWith('/api/createAgent')).length, 1);
  assert.equal(calls.filter(call => call.route.endsWith('/api/sendPrompt')).at(-1).payload.agentId, 'agent_shared_1');
});

test('pause and stop keep the agents from taking another turn', async t => {
  let hermesGets = 0;
  const calls = [];
  const agents = [];
  const fetchImpl = async (url, options = {}) => {
    const route = String(url);
    const payload = options.body ? JSON.parse(options.body) : {};
    calls.push({ route, method: options.method || 'GET', payload });
    const json = value => new Response(JSON.stringify(value), { status: 200, headers: { 'content-type': 'application/json' } });
    if (route === 'http://hermes.test/v1/runs' && options.method === 'POST') return json({ run_id: 'run_sharedhermes01', status: 'running' });
    if (route === 'http://hermes.test/v1/runs/run_sharedhermes01/stop') return json({ status: 'stopping' });
    if (route === 'http://hermes.test/v1/runs/run_sharedhermes01') {
      hermesGets += 1;
      return json(hermesGets === 2 ? { status: 'completed', output: '@grok from hermes' } : { status: 'running' });
    }
    if (route.endsWith('/api/listAgents')) return json(agents);
    if (route.endsWith('/api/createAgent')) {
      agents.push({ id: 'agent_shared_pause', name: payload.name });
      return json({ agent: { id: 'agent_shared_pause', name: payload.name } });
    }
    if (route.endsWith('/api/sendPrompt')) return json({ accepted: true });
    if (route.endsWith('/api/promptAcceptanceStatus')) return json({ outcome: 'found', record: { status: 'pending' } });
    if (route.endsWith('/api/getAgentTranscriptTail')) return json([]);
    if (route.endsWith('/api/interruptAgentRun')) return json({ ok: true });
    return json([]);
  };
  const { request } = await open(t, fetchImpl);
  const posted = await request({ action: 'shared_agents', operation: 'post', text: '@hermes go' });
  assert.equal(posted.body.running, 'hermes');
  const paused = await request({ action: 'shared_agents', operation: 'pause' });
  assert.equal(paused.body.paused, true);
  const done = await request({ action: 'shared_agents', operation: 'state' });
  assert.equal(done.body.messages.some(message => message.speaker === 'hermes'), true);
  assert.equal(done.body.paused, true);
  assert.equal(calls.some(call => call.route.includes('1340')), false);
  const started = await request({ action: 'shared_agents', operation: 'continue' });
  assert.equal(started.body.running, 'grok');
  assert.equal(started.body.paused, false);
  assert.equal(calls.find(call => call.route.endsWith('/api/createAgent')).payload.name, 'Orbit shared chat');
  const stopped = await request({ action: 'shared_agents', operation: 'stop' });
  assert.equal(stopped.status, 200);
  assert.equal(stopped.body.running, '');
  assert.equal(stopped.body.paused, true);
  assert.match(stopped.body.messages.at(-1).text, /^Stopped\.$/);
  assert.equal(calls.some(call => call.route.endsWith('/api/interruptAgentRun')), true);
  const quiet = await request({ action: 'shared_agents', operation: 'state' });
  assert.equal(quiet.body.running, '');
  assert.equal(calls.filter(call => call.route === 'http://hermes.test/v1/runs' && call.method === 'POST').length, 1);
  assert.equal(calls.filter(call => call.route.endsWith('/api/sendPrompt')).length, 1);
  const manual = await request({ action: 'shared_agents', operation: 'speak', speaker: 'hermes' });
  assert.equal(manual.body.running, 'hermes');
  const cut = await request({ action: 'shared_agents', operation: 'stop' });
  assert.equal(cut.body.running, '');
  assert.equal(cut.body.paused, true);
  assert.equal(calls.some(call => call.route.endsWith('/stop')), true);
  const still = await request({ action: 'shared_agents', operation: 'state' });
  assert.equal(still.body.running, '');
  assert.equal(calls.filter(call => call.route === 'http://hermes.test/v1/runs' && call.method === 'POST').length, 2);
});

test('a provider failure is a transcript message and the shared transcript survives restart', async t => {
  const rejections = [];
  const onRejection = reason => { rejections.push(reason); };
  process.on('unhandledRejection', onRejection);
  t.after(() => process.off('unhandledRejection', onRejection));
  const fetchImpl = async (url, options = {}) => {
    const route = String(url);
    const json = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
    if (route.endsWith('/api/createAgent')) return json({ agent: { id: 'agent_shared_1', name: 'Orbit shared chat' } });
    if (route.endsWith('/api/sendPrompt')) return json({ error: 'unknown conversation id' }, 400);
    if (route.endsWith('/api/listAgents')) return json([]);
    if (route === 'http://hermes.test/v1/runs') return json({ run_id: 'run_sharedhermes01', status: 'completed', output: 'hermes ok' });
    if (route.includes('/v1/runs/')) return json({ status: 'completed', output: 'hermes ok' });
    return json({});
  };
  const first = await open(t, fetchImpl);
  const failed = await first.request({ action: 'shared_agents', operation: 'speak', speaker: 'grok' });
  assert.equal(failed.status, 200);
  assert.equal(failed.body.messages.at(-1).speaker, 'grok');
  assert.equal(failed.body.messages.at(-1).error, true);
  assert.match(failed.body.messages.at(-1).text, /unknown conversation id/);
  assert.equal(JSON.stringify(failed.body).includes('grok-token-secret'), false);
  const posted = await first.request({ action: 'shared_agents', operation: 'post', text: 'still here' });
  assert.equal(posted.body.messages.some(message => message.text === 'still here'), true);
  const file = fs.readdirSync(path.join(first.dir, 'shared-agents')).find(name => name.endsWith('.json'));
  const saved = fs.readFileSync(path.join(first.dir, 'shared-agents', file), 'utf8');
  assert.equal(saved.includes('grok-token-secret'), false);
  assert.equal(saved.includes('hermes-key'), false);
  assert.equal(fs.statSync(path.join(first.dir, 'shared-agents', file)).mode & 0o077, 0);
  const second = await open(t, fetchImpl, first.dir);
  const restored = await second.request({ action: 'shared_agents', operation: 'state' });
  assert.equal(restored.status, 200);
  assert.equal(restored.body.messages.some(message => message.text === 'still here'), true);
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(rejections.length, 0);
});

test('Kyle can address one agent, both, or whoever last had the floor', () => {
  assert.deepEqual(routeAddressees('@hermes check the logs'), ['hermes']);
  assert.deepEqual(routeAddressees('please ask @Grok to look'), ['grok']);
  assert.deepEqual(routeAddressees('@all thoughts?'), ['hermes', 'grok']);
  assert.deepEqual(routeAddressees('@hermes and @grok'), ['hermes', 'grok']);
  assert.deepEqual(routeAddressees('what should we do?'), ['hermes', 'grok']);
  assert.deepEqual(routeAddressees('ship it', 'grok'), ['grok']);
  assert.deepEqual(routeAddressees('ship it', 'all'), ['hermes', 'grok']);
  assert.deepEqual(routeAddressees('hello'), ['hermes']);
  assert.deepEqual(routeAddressees('mail me at foo@hermes.com', 'grok'), ['grok']);
});

test('parseDelegate reads a fence or JSON and rejects a malformed block', () => {
  assert.equal(parseDelegate('no fence here'), null);
  assert.deepEqual(parseDelegate('```delegate\ntarget: grok\ntask: Square 2\ncontext: show the work\n```'), {
    to: 'grok', task: 'Square 2', context: 'show the work',
  });
  assert.deepEqual(parseDelegate('```delegate\n{"target":"Grok Bot","task":"check logs","context":"today"}\n```'), {
    to: 'grok', task: 'check logs', context: 'today',
  });
  assert.equal(parseDelegate('```delegate\n{"target":"owner","task":"nope"}\n```').error.length > 0, true);
  assert.equal(parseDelegate('```delegate\n{not json}\n```').error.length > 0, true);
});

function grokAgents(calls, options = {}) {
  const agents = [{ id: 'main_bot', name: 'Main Grok' }];
  let acceptancePolls = 0;
  let sends = 0;
  const tail = [];
  return async (url, init = {}) => {
    const route = String(url);
    const payload = init.body ? JSON.parse(init.body) : {};
    calls.push({ route, method: init.method || 'GET', payload });
    const json = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
    if (route === 'http://hermes.test/v1/runs' && init.method === 'POST') {
      options.onHermesPost?.(payload);
      const id = options.hermesRunId?.(payload) || 'run_delegateherm01';
      return json({ run_id: id, status: 'running' });
    }
    if (route.startsWith('http://hermes.test/v1/runs/') && route.endsWith('/stop')) return json({ status: 'stopping' });
    if (route.startsWith('http://hermes.test/v1/runs/')) return json({ status: 'completed', output: options.hermesOutput?.(route) || 'hermes done' });
    if (route.endsWith('/api/listAgents')) return json(options.agents || agents);
    if (route.endsWith('/api/createAgent')) {
      agents.push({ id: 'agent_shared_1', name: payload.name });
      return json({ agent: { id: 'agent_shared_1', name: payload.name } });
    }
    if (route.endsWith('/api/sendPrompt')) {
      sends += 1;
      if (options.onGrokSend) options.onGrokSend(payload, sends);
      if (options.grokReply && !options.delayReply) tail.push({ seq: sends, id: `g${sends}`, kind: 'send-message', message: { type: 'text', content: options.grokReply(sends, payload) } });
      return json({ accepted: true });
    }
    if (route.endsWith('/api/promptAcceptanceStatus')) {
      acceptancePolls += 1;
      if (options.delayReply && options.grokReply && acceptancePolls >= 2 && tail.length < sends) {
        tail.push({ seq: sends, id: `g${sends}`, kind: 'send-message', message: { type: 'text', content: options.grokReply(sends) } });
      }
      return json(options.acceptance?.(acceptancePolls) || { outcome: 'found', record: { status: 'accepted' } });
    }
    if (route.endsWith('/api/getAgentTranscriptTail')) return json(tail.slice());
    if (route.endsWith('/api/interruptAgentRun')) return json({ ok: true });
    return json({ error: 'missing' }, 404);
  };
}

test('a delegate fence runs on Orbit shared chat and the result returns to Hermes', async t => {
  const calls = [];
  let hermesPosts = 0;
  const hermesOutputs = new Map();
  const fetchImpl = await grokAgents(calls, {
    hermesRunId() {
      hermesPosts += 1;
      const id = `run_delegateherm0${hermesPosts}`;
      hermesOutputs.set(id, hermesPosts === 1
        ? '```delegate\ntarget: grok\ntask: Square 2\ncontext: show the work\n```'
        : 'The square is 4.');
      return id;
    },
    hermesOutput(route) {
      const id = [...hermesOutputs.keys()].find(key => route.endsWith(`/${key}`));
      return hermesOutputs.get(id);
    },
    acceptance(poll) {
      return poll < 2 ? { outcome: 'found', record: { status: 'pending' } } : { outcome: 'found', record: { status: 'accepted' } };
    },
    delayReply: true,
    grokReply() { return '4'; },
  });
  const { request, dir } = await open(t, fetchImpl);
  const started = await request({ action: 'shared_agents', operation: 'speak', speaker: 'hermes' });
  assert.equal(started.status, 200);
  assert.equal(started.body.running, 'grok');
  assert.equal(started.body.delegations.length, 1);
  assert.equal(started.body.delegations[0].status, 'running');
  assert.equal(started.body.delegations[0].from, 'hermes');
  assert.equal(started.body.delegations[0].to, 'grok');
  assert.equal(started.body.delegations[0].depth, 1);
  assert.match(started.body.messages.at(-1).text, /Square 2/);
  const hermesCall = calls.find(call => call.route === 'http://hermes.test/v1/runs' && call.method === 'POST');
  assert.match(hermesCall.payload.input, /```delegate/);
  assert.match(hermesCall.payload.input, /target: grok/);
  assert.match(hermesCall.payload.instructions, /```delegate/);
  const prompt = calls.find(call => call.route.endsWith('/api/sendPrompt'));
  assert.equal(prompt.payload.agentId, 'agent_shared_1');
  assert.match(prompt.payload.prompt, /Square 2/);
  assert.match(prompt.payload.prompt, /show the work/);
  assert.match(prompt.payload.prompt, /```delegate/);
  assert.equal(calls.find(call => call.route.endsWith('/api/createAgent')).payload.name, 'Orbit shared chat');
  assert.equal(prompt.payload.agentId === 'main_bot', false);
  const finished = await request({ action: 'shared_agents', operation: 'state' });
  assert.equal(finished.status, 200);
  assert.equal(finished.body.delegations[0].status, 'done');
  assert.equal(finished.body.messages.some(message => message.speaker === 'grok' && message.text === '4'), true);
  const returned = calls.filter(call => call.route === 'http://hermes.test/v1/runs' && call.method === 'POST').at(-1);
  assert.match(returned.payload.input, /finished a task you delegated/);
  assert.match(returned.payload.input, /\n4\n|Result: 4/);
  assert.equal(finished.body.messages.some(message => message.speaker === 'hermes' && /square is 4/i.test(message.text)), true);
  const saved = fs.readFileSync(path.join(dir, 'shared-agents', fs.readdirSync(path.join(dir, 'shared-agents')).find(name => name.endsWith('.json'))), 'utf8');
  assert.equal(saved.includes('grok-token-secret'), false);
  assert.equal(saved.includes('hermes-key'), false);
});

test('delegation stops at depth 2, at 8 tasks, and when the owner cancels or the task times out', async t => {
  const calls = [];
  let hermesPosts = 0;
  const hermesOutputs = new Map();
  const fetchImpl = grokAgents(calls, {
    hermesRunId() {
      hermesPosts += 1;
      const id = `run_depthhermes0${hermesPosts}`;
      const output = hermesPosts === 1
        ? '```delegate\ntarget: grok\ntask: inspect logs\n```'
        : hermesPosts === 2
          ? '```delegate\ntarget: grok\ntask: again\n```'
          : 'owner update';
      hermesOutputs.set(id, output);
      return id;
    },
    hermesOutput(route) {
      const id = [...hermesOutputs.keys()].find(key => route.endsWith(`/${key}`));
      return hermesOutputs.get(id);
    },
    grokReply(send) {
      return send === 1 ? '```delegate\ntarget: hermes\ntask: check the logs\n```' : 'logs look fine';
    },
  });
  const depth = await open(t, fetchImpl);
  const spoken = await depth.request({ action: 'shared_agents', operation: 'speak', speaker: 'hermes' });
  assert.equal(spoken.status, 200);
  let body = spoken.body;
  for (let i = 0; i < 4 && !body.messages.some(message => message.text === 'owner update'); i += 1) {
    body = (await depth.request({ action: 'shared_agents', operation: 'state' })).body;
  }
  assert.equal(body.delegations.length, 2);
  assert.deepEqual(body.delegations.map(task => task.depth), [1, 2]);
  assert.equal(body.delegations.every(task => task.status === 'done'), true);
  assert.equal(body.messages.some(message => /depth of 2/.test(message.text)), true);
  assert.equal(calls.filter(call => call.route.endsWith('/api/sendPrompt')).length, 2);
  assert.equal(body.messages.some(message => message.text === 'logs look fine'), true);
  assert.equal(body.messages.some(message => message.text === 'owner update'), true);

  const cancelCalls = [];
  let cancelPosts = 0;
  const cancelFetch = grokAgents(cancelCalls, {
    hermesRunId() {
      cancelPosts += 1;
      return `run_cancelherm0${cancelPosts}`;
    },
    hermesOutput() { return '```delegate\ntarget: grok\ntask: hold this\n```'; },
    acceptance() { return { outcome: 'found', record: { status: 'pending' } }; },
  });
  const cancelling = await open(t, cancelFetch);
  const holding = await cancelling.request({ action: 'shared_agents', operation: 'speak', speaker: 'hermes' });
  assert.equal(holding.body.running, 'grok');
  assert.equal(holding.body.delegations[0].status, 'running');
  const cancelled = await cancelling.request({ action: 'shared_agents', operation: 'cancel_delegation', task_id: holding.body.delegations[0].id });
  assert.equal(cancelled.status, 200);
  assert.equal(cancelled.body.delegations[0].status, 'failed');
  assert.equal(cancelled.body.running, '');
  assert.match(cancelled.body.messages.at(-1).text, /Cancelled/);
  assert.equal(cancelCalls.some(call => call.route.endsWith('/api/interruptAgentRun')), true);

  let clock = 1_700_000_000_000;
  const timeoutCalls = [];
  let timeoutPosts = 0;
  const timeoutOutputs = new Map();
  const timeoutFetch = grokAgents(timeoutCalls, {
    hermesRunId() {
      timeoutPosts += 1;
      const id = `run_timehermes0${timeoutPosts}`;
      timeoutOutputs.set(id, timeoutPosts === 1 ? '```delegate\ntarget: grok\ntask: wait\n```' : 'noted the timeout');
      return id;
    },
    hermesOutput(route) {
      const id = [...timeoutOutputs.keys()].find(key => route.endsWith(`/${key}`));
      return timeoutOutputs.get(id);
    },
    acceptance() { return { outcome: 'found', record: { status: 'pending' } }; },
  });
  const timing = await open(t, timeoutFetch, undefined, { grokOptions: { now: () => clock } });
  const waiting = await timing.request({ action: 'shared_agents', operation: 'speak', speaker: 'hermes' });
  assert.equal(waiting.body.delegations[0].status, 'running');
  clock += (3 * 60 * 1000) + 1;
  const timed = await timing.request({ action: 'shared_agents', operation: 'state' });
  assert.equal(timed.body.delegations[0].status, 'failed');
  assert.equal(timed.body.messages.some(message => /timed out/.test(message.text)), true);
  assert.equal(timeoutCalls.some(call => call.route.endsWith('/api/interruptAgentRun')), true);

  const capCalls = [];
  let capPosts = 0;
  const capFetch = grokAgents(capCalls, {
    hermesRunId() {
      capPosts += 1;
      return `run_caphermes0${capPosts}`;
    },
    hermesOutput() { return '```delegate\n{"target":"grok","task":"one more","context":"extra"}\n```'; },
  });
  const capped = await open(t, capFetch);
  await capped.request({ action: 'shared_agents', operation: 'state' });
  const recordPath = path.join(capped.dir, 'shared-agents', `${workspace_id}.${pane_id}.json`);
  const seeded = JSON.parse(fs.readFileSync(recordPath, 'utf8'));
  seeded.delegations = Array.from({ length: 8 }, (_, index) => {
    const id = `d_cap${String(index).padStart(5, '0')}`;
    return { id, from: 'hermes', to: 'grok', task: `seed ${index}`, context: '', depth: 1, chain: id, status: 'done', result: 'seeded', waitingOn: '', needsReturn: false, deadline: 0 };
  });
  fs.writeFileSync(recordPath, JSON.stringify(seeded));
  const refused = await capped.request({ action: 'shared_agents', operation: 'speak', speaker: 'hermes' });
  assert.equal(refused.status, 200);
  assert.equal(refused.body.delegations.length, 8);
  assert.equal(refused.body.messages.some(message => /already has 8 delegated tasks/.test(message.text)), true);
  assert.equal(capCalls.some(call => call.route.endsWith('/api/sendPrompt')), false);
});

test('a delegated task stays running while the executing agent waits for approval', async t => {
  const calls = [];
  let posts = 0;
  const fetchImpl = grokAgents(calls, {
    hermesRunId() {
      posts += 1;
      return `run_approvalher0${posts}`;
    },
    hermesOutput() { return '```delegate\ntarget: grok\ntask: list the directory\n```'; },
    agents: [{ id: 'agent_shared_1', name: 'Orbit shared chat', awaitingUserResponse: { command: 'ls' } }],
    acceptance() { return { outcome: 'found', record: { status: 'accepted' } }; },
  });
  const { request } = await open(t, fetchImpl);
  const waiting = await request({ action: 'shared_agents', operation: 'speak', speaker: 'hermes' });
  assert.equal(waiting.status, 200);
  assert.equal(waiting.body.running, 'grok');
  assert.equal(waiting.body.delegations[0].status, 'running');
  assert.match(waiting.body.activity, /approval/);
  assert.equal(calls.some(call => call.route.endsWith('/api/interruptAgentRun')), false);
  assert.equal(calls.some(call => call.route.endsWith('/stop')), false);
});

test('a quiet reply stays out of the transcript and does not hand off the floor', async t => {
  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    const route = String(url);
    calls.push(route);
    const json = value => new Response(JSON.stringify(value), { status: 200, headers: { 'content-type': 'application/json' } });
    if (route === 'http://hermes.test/v1/runs' && options.method === 'POST') return json({ run_id: 'run_quiethermes01', status: 'running' });
    if (route.includes('/v1/runs/')) return json({ status: 'completed', output: '(quiet)' });
    return json({});
  };
  const { request } = await open(t, fetchImpl);
  const posted = await request({ action: 'shared_agents', operation: 'post', text: '@hermes anything to add?' });
  assert.equal(posted.status, 200);
  assert.equal(posted.body.running, '');
  assert.deepEqual(posted.body.messages.map(message => message.speaker), ['owner']);
  assert.equal(calls.some(route => route.includes('1340')), false);
});

test('a ping-pong handoff pauses without a turn counter, and continue lets it proceed', async t => {
  const calls = [];
  let hermesPosts = 0;
  let grokSends = 0;
  const fetchImpl = async (url, options = {}) => {
    const route = String(url);
    const payload = options.body ? JSON.parse(options.body) : {};
    calls.push({ route, method: options.method || 'GET' });
    const json = value => new Response(JSON.stringify(value), { status: 200, headers: { 'content-type': 'application/json' } });
    if (route === 'http://hermes.test/v1/runs' && options.method === 'POST') {
      hermesPosts += 1;
      return json({ run_id: `run_loophemres0${hermesPosts}`, status: 'running' });
    }
    if (route.startsWith('http://hermes.test/v1/runs/')) return json({ status: 'completed', output: '@grok your turn' });
    if (route.endsWith('/api/listAgents')) return json([]);
    if (route.endsWith('/api/createAgent')) return json({ agent: { id: 'agent_shared_1', name: payload.name } });
    if (route.endsWith('/api/sendPrompt')) { grokSends += 1; return json({ accepted: true }); }
    if (route.endsWith('/api/promptAcceptanceStatus')) return json({ outcome: 'found', record: { status: 'accepted' } });
    if (route.endsWith('/api/getAgentTranscriptTail')) return json(grokSends ? [{ seq: grokSends, id: `g${grokSends}`, kind: 'send-message', message: { type: 'text', content: '@hermes your turn' } }] : []);
    return json({});
  };
  const room = await open(t, fetchImpl);
  const held = await room.request({ action: 'shared_agents', operation: 'post', text: '@hermes start' });
  assert.equal(held.status, 200);
  assert.equal(held.body.hold, true);
  assert.equal(held.body.running, '');
  assert.equal(hermesPosts, 2);
  assert.equal(grokSends, 2);
  assert.equal(held.body.messages.some(message => /\d+ of \d+|turn limit|Paused after/.test(message.text)), false);
  assert.equal(Object.hasOwn(held.body, 'max_turns'), false);
  const postsBefore = hermesPosts;
  const resumed = await room.request({ action: 'shared_agents', operation: 'continue' });
  assert.equal(resumed.status, 200);
  assert.equal(hermesPosts > postsBefore, true);

  const capped = await open(t, async () => new Response(JSON.stringify({}), { status: 200, headers: { 'content-type': 'application/json' } }));
  await capped.request({ action: 'shared_agents', operation: 'state' });
  const recordPath = path.join(capped.dir, 'shared-agents', `${workspace_id}.${pane_id}.json`);
  const seeded = JSON.parse(fs.readFileSync(recordPath, 'utf8'));
  seeded.agentStreak = 20;
  seeded.queue = [{ speaker: 'grok', fromOwner: false }];
  fs.writeFileSync(recordPath, JSON.stringify(seeded));
  const paused = await capped.request({ action: 'shared_agents', operation: 'state' });
  assert.equal(paused.body.hold, true);
  assert.equal(paused.body.running, '');
  assert.match(paused.body.activity, /Continue when you want/);
  assert.equal(/\b20\b/.test(paused.body.activity), false);
});
