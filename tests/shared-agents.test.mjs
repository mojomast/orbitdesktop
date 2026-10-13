import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createAgentHandler } from '../server/agent.mjs';

const token = 'orbit-test-token-'.repeat(4);
const session = 'orbit-12345678-1234-4234-9234-123456789abc';
const workspace_id = '12345678-1234-4234-9234-123456789abc';
const pane_id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

function open(t, fetchImpl, runtimeDirectory) {
  const dir = runtimeDirectory || fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-shared-'));
  let port;
  let handler;
  const reply = (res, status, data) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(data)); };
  const workspaceRead = () => ({ state: { monitors: [{ layout: { type: 'pane', pane: { id: pane_id, kind: 'agent' } } }] } });
  const server = http.createServer((req, res) => (handler ||= createAgentHandler({
    token, port, devOrigins: [], reply, runtimeDirectory: dir, workspaceRead,
    apiUrl: 'http://hermes.test', apiKey: 'hermes-key',
    additionalProfiles: [{ id: 'grok', label: 'Grok Bot', provider: 'grok', apiUrl: 'http://127.0.0.1:1340', apiKey: 'grok-token-secret' }],
    fetchImpl,
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

test('Hermes and Grok Bot alternate in one transcript and stop at the turn limit', async t => {
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
      return json(hermesGets < 2 ? { status: 'running', session_id: payload.session_id } : { status: 'completed', output: 'from hermes', session_id: 'ignored' });
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
  const configured = await request({ action: 'shared_agents', operation: 'settings', auto: true, max_turns: 2, next: 'hermes' });
  assert.equal(configured.status, 200);
  assert.equal(configured.body.auto, true);
  const posted = await request({ action: 'shared_agents', operation: 'post', text: 'hello from the owner' });
  assert.equal(posted.status, 200);
  assert.equal(posted.body.messages[0].speaker, 'owner');
  assert.equal(posted.body.messages[0].text, 'hello from the owner');
  assert.equal(posted.body.running, 'hermes');
  const busy = await request({ action: 'shared_agents', operation: 'speak', speaker: 'grok' });
  assert.equal(busy.status, 409);
  const hermesCall = calls.find(call => call.route === 'http://hermes.test/v1/runs' && call.method === 'POST');
  assert.match(hermesCall.payload.input, /Grok Bot/);
  assert.match(hermesCall.payload.input, /Owner: hello from the owner/);
  assert.notEqual(hermesCall.payload.session_id, session);
  const finished = await request({ action: 'shared_agents', operation: 'state' });
  assert.equal(finished.status, 200);
  assert.deepEqual(finished.body.messages.map(message => message.speaker), ['owner', 'hermes', 'grok', 'note']);
  assert.equal(finished.body.messages[1].text, 'from hermes');
  assert.equal(finished.body.messages[2].text, 'from grok');
  assert.equal(finished.body.paused, true);
  assert.match(finished.body.messages.at(-1).text, /Paused after 2/);
  const prompts = calls.filter(call => call.route.endsWith('/api/sendPrompt'));
  assert.equal(prompts.length, 1);
  assert.equal(prompts[0].payload.agentId, 'agent_shared_1');
  assert.match(prompts[0].payload.prompt, /Hermes: from hermes/);
  assert.equal(calls.filter(call => call.route.endsWith('/api/createAgent')).length, 1);
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
      return json(hermesGets === 2 ? { status: 'completed', output: 'from hermes' } : { status: 'running' });
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
  await request({ action: 'shared_agents', operation: 'settings', auto: true, max_turns: 4, next: 'hermes' });
  const posted = await request({ action: 'shared_agents', operation: 'post', text: 'go' });
  assert.equal(posted.body.running, 'hermes');
  const paused = await request({ action: 'shared_agents', operation: 'pause' });
  assert.equal(paused.body.paused, true);
  const done = await request({ action: 'shared_agents', operation: 'state' });
  assert.equal(done.body.messages.some(message => message.speaker === 'hermes'), true);
  assert.equal(done.body.paused, true);
  assert.equal(calls.some(call => call.route.includes('1340')), false);
  const started = await request({ action: 'shared_agents', operation: 'resume' });
  assert.equal(started.body.running, 'grok');
  assert.equal(started.body.paused, false);
  assert.equal(calls.find(call => call.route.endsWith('/api/createAgent')).payload.name, 'Orbit shared chat');
  const stopped = await request({ action: 'shared_agents', operation: 'stop' });
  assert.equal(stopped.status, 200);
  assert.equal(stopped.body.running, '');
  assert.equal(stopped.body.paused, true);
  assert.match(stopped.body.messages.at(-1).text, /Stopped/);
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
