import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createAgentHandler } from '../server/agent.mjs';
import { createWorkspaceService } from '../server/workspace.mjs';
import { initial } from '../src/model.ts';

const token = 'orbit-test-token-'.repeat(4);
const session = 'orbit-12345678-1234-4234-9234-123456789abc';
const workspace_id = '12345678-1234-4234-9234-123456789abc';
const pane_id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const agentId = 'agent_orbit_001';

test('Grok Bot is selectable beside Hermes and uses the gateway token', async t => {
  const calls = [];
  const runtimeDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-grok-'));
  let port;
  let handler;
  let prompted = false;
  const reply = (res, status, data) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(data)); };
  const workspaceRead = () => ({ state: { monitors: [{ layout: { type: 'pane', pane: { id: pane_id, kind: 'agent' } } }] } });
  const fetchImpl = async (url, options) => {
    calls.push({ url: String(url), options });
    const route = String(url);
    const json = (value, status = 200) => new Response(JSON.stringify(value), { status });
    if (route.startsWith('http://hermes.test')) {
      if (route.endsWith('/v1/runs')) return json({ run_id: 'run_hermes12345678', status: 'running', session_id: session });
      if (route.includes('/api/jobs')) return json({ jobs: [{ id: 'hermes-job', name: 'Hermes job' }] });
      return json({ data: [] });
    }
    if (route.endsWith('/api/listAgents')) return json([{ id: agentId, name: 'Orbit chat', isRunning: true, isComposingMessage: true }]);
    if (route.endsWith('/api/createAgent')) return json({ agent: { id: agentId, name: 'Orbit chat' } });
    if (route.endsWith('/api/sendPrompt')) { prompted = true; return json({ accepted: true }); }
    if (route.endsWith('/api/promptAcceptanceStatus')) return json({ outcome: 'not-found' });
    if (route.endsWith('/api/getAgentTranscriptTail')) return json(prompted ? [{ seq: 2, id: 'reply-1', kind: 'send-message', message: { type: 'text', content: 'hello from grok' } }] : []);
    if (route.endsWith('/api/listAllAutomations')) return json([]);
    if (route.endsWith('/api/interruptAgentRun')) return json({ ok: true });
    return json({ error: 'missing' }, 404);
  };
  const server = http.createServer((req, res) => (handler ||= createAgentHandler({
    token, port, devOrigins: [], reply, runtimeDirectory, workspaceRead,
    apiUrl: 'http://hermes.test', apiKey: 'hermes-key',
    additionalProfiles: [{ id: 'grok', label: 'Grok Bot', provider: 'grok', apiUrl: 'http://127.0.0.1:1340', apiKey: 'grok-token-secret', model: 'grok-4' }],
    fetchImpl,
  }))(req, res));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  port = server.address().port;
  t.after(async () => { await new Promise(resolve => server.close(resolve)); fs.rmSync(runtimeDirectory, { recursive: true, force: true }); });
  const origin = `http://127.0.0.1:${port}`;
  async function request(body) {
    const response = await fetch(origin + '/api/agent', {
      method: 'POST',
      headers: { Origin: origin, Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ session_id: session, ...body }),
    });
    return { status: response.status, body: await response.json() };
  }
  const base = { workspace_id, pane_id, session_id: session };
  const profiles = await request({ ...base, action: 'profiles' });
  assert.deepEqual(profiles.body.profiles, [{ id: 'default', label: 'Default' }, { id: 'grok', label: 'Grok Bot', provider: 'grok' }]);
  assert.equal(JSON.stringify(profiles.body).includes('grok-token-secret'), false);
  assert.equal((await request({ ...base, action: 'shared_chat', initial: { session, messages: [] } })).status, 200);
  const selected = await request({ ...base, action: 'select_session', target_profile_id: 'grok', expected_binding_revision: 0 });
  assert.equal(selected.status, 200);
  assert.equal(selected.body.state.profile_id, 'grok');
  assert.equal(selected.body.state.session, agentId);
  const listed = await request({ ...base, action: 'sessions', target_profile_id: 'grok' });
  assert.deepEqual(listed.body.sessions, [{ id: agentId, title: 'Orbit chat', updated_at: '' }]);
  const scoped = { ...base, profile_id: 'grok', session_id: agentId, expected_binding_revision: 1 };
  const started = await request({ ...scoped, action: 'start', input: 'hello grok' });
  assert.equal(started.status, 202);
  assert.match(started.body.run_id, /^run_[a-zA-Z0-9_-]{8,100}$/);
  const sent = calls.find(call => call.url.endsWith('/api/sendPrompt'));
  assert.equal(sent.options.headers.Authorization, 'Bearer grok-token-secret');
  assert.equal(JSON.parse(sent.options.body).agentId, agentId);
  assert.equal(calls.some(call => call.url.includes('hermes.test') && call.url.includes('sendPrompt')), false);
  const steered = await request({ ...scoped, action: 'steer', run_id: started.body.run_id, input: 'look at the tests' });
  assert.equal(steered.status, 200);
  assert.deepEqual(steered.body, { accepted: true });
  const followUp = calls.filter(call => call.url.endsWith('/api/sendPrompt')).at(-1);
  assert.equal(JSON.parse(followUp.options.body).prompt, 'look at the tests');
  assert.equal(JSON.parse(followUp.options.body).agentId, agentId);
  const status = await request({ ...scoped, action: 'status', run_id: started.body.run_id });
  assert.equal(status.body.status, 'completed');
  assert.equal(status.body.output, 'hello from grok');
  const acceptance = calls.find(call => call.url.endsWith('/api/promptAcceptanceStatus'));
  const acceptanceBody = JSON.parse(acceptance.options.body);
  assert.equal(acceptanceBody.agentId, agentId);
  assert.equal(acceptanceBody.accountSlot, 'host');
  assert.equal(acceptanceBody.clientNonce, JSON.parse(sent.options.body).clientNonce);
  assert.notEqual(acceptanceBody.clientNonce, JSON.parse(followUp.options.body).clientNonce);
  const jobs = await request({ ...scoped, action: 'jobs' });
  assert.equal(jobs.status, 200);
  assert.deepEqual(jobs.body.jobs, []);
  assert.equal(calls.some(call => call.url.includes('hermes.test') && call.url.includes('/api/jobs')), false);
  assert.deepEqual((await request({ ...scoped, action: 'capabilities' })).body, { features: { run_events_sse: true } });
  assert.equal((await request({ ...scoped, action: 'build_queue', operation: 'list' })).status, 409);
  const hermesJobs = await request({ action: 'jobs', profile_id: 'default' });
  assert.equal(hermesJobs.status, 200);
  assert.equal(hermesJobs.body.jobs[0].id, 'hermes-job');
  assert.equal(calls.at(-1).url, 'http://hermes.test/api/jobs?include_disabled=true');
  const hermes = await request({ action: 'start', input: 'hello hermes', profile_id: 'default' });
  assert.equal(hermes.status, 202);
  assert.equal(calls.at(-1).url, 'http://hermes.test/v1/runs');
  assert.equal(calls.at(-1).options.headers.Authorization, 'Bearer hermes-key');
});

test('a rejected Grok Bot sendPrompt is a chat error and the server keeps serving Hermes', async t => {
  const rejections = [];
  const onRejection = reason => { rejections.push(reason); };
  process.on('unhandledRejection', onRejection);
  const gateway = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => {
      if (req.url === '/api/createAgent') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ agent: { id: agentId, name: 'Orbit chat' } }));
        return;
      }
      if (req.url === '/api/sendPrompt') {
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'unknown conversation id' }));
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('[]');
    });
  });
  const hermesGateway = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => {
      if (req.url === '/v1/runs') {
        res.writeHead(202, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ run_id: 'run_hermes12345678', status: 'running', session_id: session }));
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ data: [] }));
    });
  });
  await new Promise(resolve => gateway.listen(0, '127.0.0.1', resolve));
  await new Promise(resolve => hermesGateway.listen(0, '127.0.0.1', resolve));
  const runtimeDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-grok-reject-'));
  let port;
  let handler;
  const reply = (res, status, data) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(data)); };
  const workspaceRead = () => ({ state: { monitors: [{ layout: { type: 'pane', pane: { id: pane_id, kind: 'agent' } } }] } });
  const server = http.createServer((req, res) => (handler ||= createAgentHandler({
    token, port, devOrigins: [], reply, runtimeDirectory, workspaceRead,
    apiUrl: `http://127.0.0.1:${hermesGateway.address().port}`, apiKey: 'hermes-key',
    additionalProfiles: [{ id: 'grok', label: 'Grok Bot', provider: 'grok', apiUrl: `http://127.0.0.1:${gateway.address().port}`, apiKey: 'grok-token-secret' }],
  }))(req, res));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  port = server.address().port;
  t.after(async () => {
    process.off('unhandledRejection', onRejection);
    await new Promise(resolve => server.close(resolve));
    await new Promise(resolve => gateway.close(resolve));
    await new Promise(resolve => hermesGateway.close(resolve));
    fs.rmSync(runtimeDirectory, { recursive: true, force: true });
  });
  const origin = `http://127.0.0.1:${port}`;
  async function request(body) {
    const response = await fetch(origin + '/api/agent', {
      method: 'POST',
      headers: { Origin: origin, Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ session_id: session, ...body }),
    });
    return { status: response.status, body: await response.json() };
  }
  const base = { workspace_id, pane_id, session_id: session };
  assert.equal((await request({ ...base, action: 'shared_chat', initial: { session, messages: [] } })).status, 200);
  const selected = await request({ ...base, action: 'select_session', target_profile_id: 'grok', expected_binding_revision: 0 });
  assert.equal(selected.status, 200);
  const rejected = await request({ ...base, profile_id: 'grok', session_id: agentId, expected_binding_revision: 1, action: 'start', input: 'hello missing bot' });
  assert.equal(rejected.status, 400);
  assert.match(rejected.body.error, /unknown conversation id/);
  assert.equal(JSON.stringify(rejected.body).includes('grok-token-secret'), false);
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(rejections.length, 0);
  const still = await request({ action: 'start', input: 'hermes still running', profile_id: 'default' });
  assert.equal(still.status, 202);
  assert.equal(still.body.run_id, 'run_hermes12345678');
});

const json = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
const grokProfile = { id: 'grok', label: 'Grok Bot', provider: 'grok', apiUrl: 'http://127.0.0.1:1340', apiKey: 'grok-token-secret', model: 'grok-4' };

async function openOrbit(t, { fetchImpl, runtimeDirectory, grokOptions, workspaceContext, cleanup = !runtimeDirectory } = {}) {
  const dir = runtimeDirectory || fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-grok-'));
  let port;
  let handler;
  const reply = (res, status, data) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(data)); };
  const workspaceRead = () => ({ state: { monitors: [{ layout: { type: 'pane', pane: { id: pane_id, kind: 'agent' } } }] } });
  const server = http.createServer((req, res) => (handler ||= createAgentHandler({
    token, port, devOrigins: [], reply, runtimeDirectory: dir, workspaceRead,
    ...(workspaceContext ? { workspaceContext } : {}),
    apiUrl: 'http://hermes.test', apiKey: 'hermes-key',
    additionalProfiles: [grokProfile],
    fetchImpl, grokOptions,
  }))(req, res));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  port = server.address().port;
  const origin = `http://127.0.0.1:${port}`;
  async function request(body, { raw = false } = {}) {
    const response = await fetch(origin + '/api/agent', {
      method: 'POST',
      headers: { Origin: origin, Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ session_id: session, ...body }),
    });
    if (raw) return response;
    const text = await response.text();
    let parsed;
    try { parsed = JSON.parse(text); } catch { parsed = { raw: text }; }
    return { status: response.status, body: parsed };
  }
  t.after(async () => {
    await new Promise(resolve => server.close(resolve));
    if (cleanup) fs.rmSync(dir, { recursive: true, force: true });
  });
  return { request, dir };
}

async function bindGrok(request) {
  const base = { workspace_id, pane_id, session_id: session };
  assert.equal((await request({ ...base, action: 'shared_chat', initial: { session, messages: [] } })).status, 200);
  const selected = await request({ ...base, action: 'select_session', target_profile_id: 'grok', expected_binding_revision: 0 });
  assert.equal(selected.status, 200, JSON.stringify(selected.body));
  return { ...base, profile_id: 'grok', session_id: selected.body.state.session, expected_binding_revision: selected.body.state.binding_revision };
}

test('not-found acceptance stays running through the grace period, then a later reply completes a busy bot', async t => {
  let clock = 50_000;
  let tail = [{ kind: 'message', role: 'assistant', content: 'partial', streaming: true }];
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url: String(url), body: options?.body });
    const route = String(url);
    if (route.endsWith('/api/listAgents')) return json([{ id: agentId, name: 'Orbit chat', isRunning: true }]);
    if (route.endsWith('/api/createAgent')) return json({ agent: { id: agentId, name: 'Orbit chat' } });
    if (route.endsWith('/api/sendPrompt')) return json({ accepted: true });
    if (route.endsWith('/api/promptAcceptanceStatus')) return json({ outcome: 'not-found' });
    if (route.endsWith('/api/getAgentTranscriptTail')) return json(tail);
    return json({ error: 'missing' }, 404);
  };
  const { request } = await openOrbit(t, { fetchImpl, grokOptions: { now: () => clock, acceptanceGraceMs: 1000, runTimeoutMs: 60_000 } });
  const scoped = await bindGrok(request);
  const started = await request({ ...scoped, action: 'start', input: 'wait for the reply' });
  assert.equal(started.status, 202);
  const early = await request({ ...scoped, action: 'status', run_id: started.body.run_id });
  assert.equal(early.body.status, 'running');
  const acceptance = calls.find(call => call.url.endsWith('/api/promptAcceptanceStatus'));
  assert.equal(JSON.parse(acceptance.body).agentId, agentId);
  clock = 52_000;
  const waiting = await request({ ...scoped, action: 'status', run_id: started.body.run_id });
  assert.equal(waiting.body.status, 'running');
  tail = [...tail, { seq: 4, kind: 'message', role: 'assistant', content: 'finished later', streaming: false }];
  const done = await request({ ...scoped, action: 'status', run_id: started.body.run_id });
  assert.equal(done.body.status, 'completed');
  assert.equal(done.body.output, 'finished later');
});

test('an idle bot with no new reply times out instead of staying on not-found', async t => {
  let clock = 10_000;
  const fetchImpl = async url => {
    const route = String(url);
    if (route.endsWith('/api/listAgents')) return json([{ id: agentId, name: 'Orbit chat', isRunning: false }]);
    if (route.endsWith('/api/createAgent')) return json({ agent: { id: agentId, name: 'Orbit chat' } });
    if (route.endsWith('/api/sendPrompt')) return json({ accepted: true });
    if (route.endsWith('/api/promptAcceptanceStatus')) return json({ outcome: 'not-found' });
    if (route.endsWith('/api/getAgentTranscriptTail')) return json([]);
    return json({ error: 'missing' }, 404);
  };
  const { request } = await openOrbit(t, { fetchImpl, grokOptions: { now: () => clock, acceptanceGraceMs: 1000, runTimeoutMs: 5000 } });
  const scoped = await bindGrok(request);
  const started = await request({ ...scoped, action: 'start', input: 'nothing comes back' });
  assert.equal(started.status, 202);
  assert.equal((await request({ ...scoped, action: 'status', run_id: started.body.run_id })).body.status, 'running');
  clock = 12_000;
  const idle = await request({ ...scoped, action: 'status', run_id: started.body.run_id });
  assert.equal(idle.body.status, 'running');
  clock = 16_000;
  const timedOut = await request({ ...scoped, action: 'status', run_id: started.body.run_id });
  assert.equal(timedOut.body.status, 'interrupted');
  assert.match(timedOut.body.error, /time limit/);
  const bound = await request({ workspace_id, pane_id, session_id: session, action: 'shared_chat' });
  assert.equal(bound.body.state.run, undefined);
});

test('a restarted Orbit process resumes a persisted Grok run and drops an orphaned pane run', async t => {
  let release = false;
  const fetchImpl = async url => {
    const route = String(url);
    if (route.endsWith('/api/listAgents')) return json([{ id: agentId, name: 'Orbit chat', isRunning: true }]);
    if (route.endsWith('/api/createAgent')) return json({ agent: { id: agentId, name: 'Orbit chat' } });
    if (route.endsWith('/api/sendPrompt')) return json({ accepted: true });
    if (route.endsWith('/api/promptAcceptanceStatus')) return json({ outcome: 'not-found' });
    if (route.endsWith('/api/getAgentTranscriptTail')) return json(release ? [{ seq: 3, kind: 'send-message', message: { type: 'text', content: 'kept across restart' } }] : []);
    return json({ error: 'missing' }, 404);
  };
  const first = await openOrbit(t, { fetchImpl, cleanup: false });
  const scoped = await bindGrok(first.request);
  const started = await first.request({ ...scoped, action: 'start', input: 'remember this' });
  assert.equal(started.status, 202);
  const runFile = path.join(first.dir, 'grok-runs', `${started.body.run_id}.json`);
  const saved = JSON.parse(fs.readFileSync(runFile, 'utf8'));
  assert.equal(saved.agentId, agentId);
  assert.equal(JSON.stringify(saved).includes('grok-token-secret'), false);
  assert.equal(fs.statSync(runFile).mode & 0o077, 0);
  release = true;
  const second = await openOrbit(t, { fetchImpl, runtimeDirectory: first.dir, cleanup: false });
  const resumed = await second.request({ ...scoped, action: 'status', run_id: started.body.run_id });
  assert.equal(resumed.body.status, 'completed');
  assert.equal(resumed.body.output, 'kept across restart');
  const again = await first.request({ ...scoped, action: 'start', input: 'orphan me' });
  assert.equal(again.status, 202);
  fs.rmSync(path.join(first.dir, 'grok-runs'), { recursive: true, force: true });
  const third = await openOrbit(t, {
    fetchImpl: async () => { throw Error('orphan status must not call the gateway'); },
    runtimeDirectory: first.dir,
    cleanup: true,
  });
  const orphan = await third.request({ ...scoped, action: 'status', run_id: again.body.run_id });
  assert.equal(orphan.status, 200);
  assert.equal(orphan.body.status, 'interrupted');
  assert.match(orphan.body.error, /no longer tracked/);
  const bound = await third.request({ workspace_id, pane_id, session_id: session, action: 'shared_chat' });
  assert.equal(bound.body.state.run, undefined);
});

test('New conversation reuses an empty Orbit chat and otherwise uses the requested name', async t => {
  const created = [];
  let emptyTail = [];
  const fetchImpl = async (url, options) => {
    const route = String(url);
    const payload = options?.body ? JSON.parse(options.body) : {};
    if (route.endsWith('/api/listAgents')) return json([{ id: 'agent_empty_1', name: 'Orbit chat', isRunning: false }]);
    if (route.endsWith('/api/getAgentTranscriptTail')) return json(payload.id === 'agent_empty_1' ? emptyTail : []);
    if (route.endsWith('/api/createAgent')) {
      created.push(payload);
      return json({ agent: { id: `agent_new_${created.length}`, name: payload.name } });
    }
    return json({ error: 'missing' }, 404);
  };
  const { request } = await openOrbit(t, { fetchImpl });
  const base = { workspace_id, pane_id, session_id: session };
  assert.equal((await request({ ...base, action: 'shared_chat', initial: { session, messages: [] } })).status, 200);
  const first = await request({ ...base, action: 'select_session', target_profile_id: 'grok', expected_binding_revision: 0 });
  assert.equal(first.status, 200);
  assert.equal(first.body.state.session, 'agent_empty_1');
  assert.equal(created.length, 0);
  const second = await request({ ...base, action: 'select_session', target_profile_id: 'grok', session_id: 'agent_empty_1', profile_id: 'grok', expected_binding_revision: 1 });
  assert.equal(second.status, 200);
  assert.equal(second.body.state.session, 'agent_empty_1');
  assert.equal(created.length, 0);
  const named = await request({ ...base, action: 'select_session', target_profile_id: 'grok', session_id: 'agent_empty_1', profile_id: 'grok', expected_binding_revision: 2, conversation_name: 'Ship notes' });
  assert.equal(named.status, 200);
  assert.equal(named.body.state.session, 'agent_new_1');
  assert.equal(created[0].name, 'Ship notes');
  assert.equal(created[0].isIntroductionSuppressed, true);
  emptyTail = [{ kind: 'message', role: 'user', content: 'already used' }];
  const fresh = await request({ ...base, action: 'select_session', target_profile_id: 'grok', session_id: 'agent_new_1', profile_id: 'grok', expected_binding_revision: 3, conversation_name: '   ' });
  assert.equal(fresh.status, 200);
  assert.equal(fresh.body.state.session, 'agent_new_2');
  assert.equal(created.at(-1).name, 'Orbit chat');
  const invalid = await request({ ...base, action: 'select_session', target_profile_id: 'grok', session_id: 'agent_new_2', profile_id: 'grok', expected_binding_revision: 4, conversation_name: 'bad\nname' });
  assert.equal(invalid.status, 400);
  assert.equal(created.length, 2);
});

test('Grok jobs, catalog, approvals, activity, and events stay on the Grok gateway', async t => {
  const rejections = [];
  const onRejection = reason => { rejections.push(reason); };
  process.on('unhandledRejection', onRejection);
  t.after(() => process.off('unhandledRejection', onRejection));
  const calls = [];
  let tail = [];
  let failJobs = false;
  const fetchImpl = async (url, options) => {
    const route = String(url);
    calls.push(route);
    const payload = options?.body ? JSON.parse(options.body) : {};
    calls.push(JSON.stringify({ route, payload }));
    if (route.startsWith('http://hermes.test')) return json({ jobs: [{ id: 'hermes-job', name: 'Hermes only' }] });
    if (route.endsWith('/api/listAgents')) return json([{ id: agentId, name: 'Orbit chat', isRunning: true, awaitingUserResponse: { command: 'rm -rf /tmp/demo', reason: 'destructive' } }]);
    if (route.endsWith('/api/createAgent')) return json({ agent: { id: agentId, name: 'Orbit chat' } });
    if (route.endsWith('/api/sendPrompt')) return json({ accepted: true });
    if (route.endsWith('/api/promptAcceptanceStatus')) return json({ outcome: 'found', record: { status: 'accepted', agentId } });
    if (route.endsWith('/api/getAgentTranscriptTail')) return json(tail);
    if (route.endsWith('/api/listAllAutomations')) {
      if (failJobs) throw Error('socket hang up');
      return json([{ agentId, automation: { id: 'daily-1', name: 'Daily', enabled: true, schedule: '0 9 * * *', prompt: 'secret prompt' } }]);
    }
    if (route.endsWith('/api/setAgentAutomationEnabled')) return json({ ok: true, ...payload });
    if (route.endsWith('/api/skillsCatalog')) return json([{ name: 'search', description: 'Find files', source: 'bundled' }]);
    if (route.endsWith('/api/listBoxMcpServers')) return json({ error: 'no catalog' }, 404);
    if (route.endsWith('/api/getConversationOutline')) return json({ items: [{ kind: 'tool-call', name: 'search', id: 'c1', input: '{"q":1}' }, { kind: 'tool-result', name: 'search', toolCallId: 'c1', output: 'found' }] });
    if (route.endsWith('/api/resolveLocalToolPermission')) return json({ ok: true });
    if (route.endsWith('/api/dismissWidget')) return json({ ok: true });
    if (route.endsWith('/api/createAgentAutomation')) return json({ automation: { id: 'made-1', name: payload.spec?.name || 'made' } });
    if (route.endsWith('/events')) {
      assert.equal(options.headers.Authorization, 'Bearer grok-token-secret');
      const stream = new TextEncoder().encode([
        `data: {"channel":"tool","payload":{"agentId":"someone-else","name":"hidden"}}\n\n`,
        `data: {"channel":"tool","payload":{"agentId":"${agentId}","name":"search"}}\n\n`,
        'data: {"channel":"note","payload":{"text":"no owner"}}\n\n',
      ].join(''));
      return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } });
    }
    return json({ error: 'missing' }, 404);
  };
  const { request } = await openOrbit(t, { fetchImpl });
  const scoped = await bindGrok(request);
  const started = await request({ ...scoped, action: 'start', input: 'need approval' });
  assert.equal(started.status, 202);
  const waiting = await request({ ...scoped, action: 'status', run_id: started.body.run_id });
  assert.equal(waiting.body.status, 'waiting_for_approval');
  assert.equal(waiting.body.approvals[0].command, 'rm -rf /tmp/demo');
  assert.equal(waiting.body.approvals[0].reason, 'destructive');
  const allowed = await request({ ...scoped, action: 'approval', run_id: started.body.run_id, choice: 'once' });
  assert.equal(allowed.status, 200);
  assert.equal(allowed.body.resolved, true);
  const permission = calls.find(call => call.includes('/api/resolveLocalToolPermission') && call.startsWith('{'));
  assert.equal(JSON.parse(permission).payload.id, agentId);
  assert.equal(JSON.parse(permission).payload.choice, 'once');
  tail = [{ id: 'w1', kind: 'widget', command: 'rm', reason: 'destructive' }];
  const denied = await request({ ...scoped, action: 'approval', run_id: started.body.run_id, choice: 'deny' });
  assert.equal(denied.status, 200);
  const dismissed = calls.find(call => call.includes('/api/dismissWidget') && call.startsWith('{'));
  assert.equal(JSON.parse(dismissed).payload.entryId, 'w1');
  const jobs = await request({ ...scoped, action: 'jobs' });
  assert.equal(jobs.status, 200);
  assert.equal(jobs.body.jobs[0].id, 'daily-1');
  assert.equal(JSON.stringify(jobs.body).includes('secret prompt'), false);
  assert.equal(calls.some(call => call.includes('hermes.test')), false);
  const paused = await request({ ...scoped, action: 'job_control', job_id: 'daily-1', operation: 'pause', confirm: true });
  assert.equal(paused.status, 200);
  const pauseCall = calls.find(call => call.includes('/api/setAgentAutomationEnabled') && call.startsWith('{'));
  assert.deepEqual(JSON.parse(pauseCall).payload, { id: agentId, automationId: 'daily-1', isEnabled: false });
  const loaded = await request({ ...scoped, action: 'automation', operation: 'get', job_id: 'daily-1' });
  assert.equal(loaded.body.job.prompt, 'secret prompt');
  assert.deepEqual(loaded.body.job.skills, []);
  const blockedDeliver = await request({ ...scoped, action: 'automation', operation: 'create', confirm: true, fields: { name: 'Daily', prompt: 'Check', schedule: '0 9 * * *', deliver: 'email', skills: [] } });
  assert.equal(blockedDeliver.status, 409);
  assert.match(blockedDeliver.body.error, /delivery/);
  assert.equal(calls.some(call => call.includes('/api/createAgentAutomation')), false);
  const skilled = await request({ ...scoped, action: 'automation', operation: 'create', confirm: true, fields: { name: 'Daily', prompt: 'Check', schedule: '0 9 * * *', deliver: 'local', skills: ['web'] } });
  assert.equal(skilled.status, 200);
  const skillSpec = calls.find(call => call.includes('/api/createAgentAutomation') && call.startsWith('{'));
  assert.match(JSON.parse(skillSpec).payload.spec.prompt, /Apply these skills: web\.\n\nCheck/);
  assert.deepEqual(skilled.body.job.skills, []);
  const made = await request({ ...scoped, action: 'automation', operation: 'create', confirm: true, fields: { name: 'Daily', prompt: 'Check', schedule: '0 9 * * *', deliver: 'local', skills: [] } });
  assert.equal(made.status, 200);
  assert.equal(made.body.job.id, 'made-1');
  const spec = calls.filter(call => call.includes('/api/createAgentAutomation') && call.startsWith('{')).at(-1);
  assert.equal(JSON.parse(spec).payload.spec.prompt, 'Check');
  assert.deepEqual(JSON.parse(spec).payload.spec.trigger, { type: 'cron', schedule: '0 9 * * *' });
  const skills = await request({ ...scoped, action: 'catalog', kind: 'skills' });
  assert.equal(skills.body.items[0].category, 'bundled');
  const toolsets = await request({ ...scoped, action: 'catalog', kind: 'toolsets' });
  assert.equal(toolsets.status, 409);
  assert.match(toolsets.body.error, /does not advertise this catalog/);
  const activity = await request({ ...scoped, action: 'activity' });
  assert.equal(activity.body.activity[0].kind, 'call');
  assert.equal(activity.body.activity[1].kind, 'result');
  assert.equal(calls.some(call => call.includes('/api/sessions/')), false);
  const stream = await request({ ...scoped, action: 'events', run_id: started.body.run_id }, { raw: true });
  assert.equal(stream.headers.get('content-type'), 'text/event-stream');
  const live = await stream.text();
  assert.match(live, /event: tool/);
  assert.match(live, /event: tool\.started/);
  assert.match(live, /"tool":"search"/);
  assert.match(live, /search/);
  assert.match(live, /no owner/);
  assert.equal(live.includes('hidden'), false);
  assert.equal(live.includes('someone-else'), false);
  const hermesJobs = await request({ action: 'jobs', profile_id: 'default' });
  assert.equal(hermesJobs.body.jobs[0].id, 'hermes-job');
  assert.match(calls.at(-1), /hermes\.test\/api\/jobs/);
  failJobs = true;
  const broken = await request({ ...scoped, action: 'jobs' });
  assert.equal(broken.status, 502);
  assert.match(broken.body.error, /Grok Bot/);
  assert.equal(/Hermes/.test(broken.body.error), false);
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(rejections.length, 0);
});

test('Grok agent chat prompt includes workspace_control.py and publish', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-grok-workspace-'));
  let service;
  const wsReply = (res, status, data) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(data)); };
  const wsServer = http.createServer((req, res) => service.handle(req, res, req.url === '/control'));
  await new Promise(resolve => wsServer.listen(0, '127.0.0.1', resolve));
  const wsPort = wsServer.address().port;
  service = createWorkspaceService({ token, port: wsPort, devOrigins: [], root, reply: wsReply });
  t.after(async () => {
    await new Promise(resolve => wsServer.close(resolve));
    service.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  const wsOrigin = `http://127.0.0.1:${wsPort}`;
  const synced = await fetch(wsOrigin + '/workspace', {
    method: 'POST',
    headers: { Origin: wsOrigin, Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ workspace_id, action: 'sync', state: initial() }),
  });
  assert.equal(synced.status, 200);
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url: String(url), body: options?.body });
    const route = String(url);
    if (route.endsWith('/api/listAgents')) return json([{ id: agentId, name: 'Orbit chat', isRunning: true }]);
    if (route.endsWith('/api/createAgent')) return json({ agent: { id: agentId, name: 'Orbit chat' } });
    if (route.endsWith('/api/sendPrompt')) return json({ accepted: true });
    if (route.endsWith('/api/promptAcceptanceStatus')) return json({ outcome: 'not-found' });
    if (route.endsWith('/api/getAgentTranscriptTail')) return json([]);
    return json({ error: 'missing' }, 404);
  };
  const first = await openOrbit(t, { fetchImpl, workspaceContext: service.context, cleanup: false });
  const scoped = await bindGrok(first.request);
  const started = await first.request({ ...scoped, action: 'start', input: 'build a timer app' });
  assert.equal(started.status, 202);
  const sent = calls.find(call => call.url.endsWith('/api/sendPrompt'));
  const prompt = JSON.parse(sent.body).prompt;
  const operator = service.context.parts(workspace_id).operator;
  assert.match(prompt, /workspace_control\.py/);
  assert.match(prompt, /publish/);
  assert.ok(prompt.includes(operator.trim()));
  assert.match(prompt, /build a timer app/);
  assert.match(prompt, /AGENT_GUIDE\.md/);
  assert.equal(prompt.includes('# Hermes workspace operator guide'), false);
  const steered = await first.request({ ...scoped, action: 'steer', run_id: started.body.run_id, input: 'look at the tests' });
  assert.equal(steered.status, 200);
  const followUp = calls.filter(call => call.url.endsWith('/api/sendPrompt')).at(-1);
  assert.equal(JSON.parse(followUp.body).prompt, 'look at the tests');
  calls.length = 0;
  const restarted = await openOrbit(t, { fetchImpl, runtimeDirectory: first.dir, workspaceContext: service.context, cleanup: true });
  const again = await restarted.request({ ...scoped, action: 'steer', run_id: started.body.run_id, input: 'publish the app' });
  assert.equal(again.status, 200);
  const recovered = JSON.parse(calls.find(call => call.url.endsWith('/api/sendPrompt')).body).prompt;
  assert.match(recovered, /publish the app/);
  assert.match(recovered, /workspace_control\.py/);
  assert.match(recovered, /publish/);
});

test('Grok Bot conversation pages slice listAgents instead of stopping at the first page', async t => {
  const agents = Array.from({ length: 101 }, (_, index) => ({ id: `agent_${String(index).padStart(3, '0')}`, name: `Bot ${index}`, updatedAt: 1_700_000_000_000 + index }));
  const runtimeDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-grok-page-'));
  let port;
  let handler;
  const reply = (res, status, data) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(data)); };
  const workspaceRead = () => ({ state: { monitors: [] } });
  const fetchImpl = async (url) => {
    if (String(url).endsWith('/api/listAgents')) return new Response(JSON.stringify(agents), { status: 200 });
    return new Response('[]', { status: 200, headers: { 'content-type': 'application/json' } });
  };
  const server = http.createServer((req, res) => (handler ||= createAgentHandler({
    token, port, devOrigins: [], reply, runtimeDirectory, workspaceRead,
    apiUrl: 'http://hermes.test', apiKey: 'hermes-key',
    additionalProfiles: [{ id: 'grok', label: 'Grok Bot', provider: 'grok', apiUrl: 'http://127.0.0.1:1340', apiKey: 'grok-token-secret' }],
    fetchImpl,
  }))(req, res));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  port = server.address().port;
  t.after(async () => { await new Promise(resolve => server.close(resolve)); fs.rmSync(runtimeDirectory, { recursive: true, force: true }); });
  const origin = `http://127.0.0.1:${port}`;
  async function library(offset) {
    const response = await fetch(origin + '/api/agent', {
      method: 'POST',
      headers: { Origin: origin, Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'conversation_library', workspace_id, profile_id: 'grok', offset }),
    });
    return { status: response.status, body: await response.json() };
  }
  const first = await library(0);
  assert.equal(first.status, 200);
  assert.equal(first.body.conversations.length, 100);
  assert.equal(first.body.has_more, true);
  assert.equal(first.body.conversations[0].session_id, 'agent_000');
  const second = await library(100);
  assert.equal(second.status, 200);
  assert.equal(second.body.conversations.length, 1);
  assert.equal(second.body.conversations[0].session_id, 'agent_100');
  assert.equal(second.body.has_more, false);
});
