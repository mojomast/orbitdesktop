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
const agentId = 'agent_orbit_001';

test('Grok Bot is selectable beside Hermes and uses the gateway token', async t => {
  const calls = [];
  const runtimeDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-grok-'));
  let port;
  let handler;
  const reply = (res, status, data) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(data)); };
  const workspaceRead = () => ({ state: { monitors: [{ layout: { type: 'pane', pane: { id: pane_id, kind: 'agent' } } }] } });
  const fetchImpl = async (url, options) => {
    calls.push({ url: String(url), options });
    const route = String(url);
    const json = (value, status = 200) => new Response(JSON.stringify(value), { status });
    if (route.startsWith('http://hermes.test')) {
      if (route.endsWith('/v1/runs')) return json({ run_id: 'run_hermes12345678', status: 'running', session_id: session });
      return json({ data: [] });
    }
    if (route.endsWith('/api/listAgents')) return json([{ id: agentId, name: 'Orbit chat', isRunning: false }]);
    if (route.endsWith('/api/createAgent')) return json({ agent: { id: agentId, name: 'Orbit chat' } });
    if (route.endsWith('/api/sendPrompt')) return json({ accepted: true });
    if (route.endsWith('/api/promptAcceptanceStatus')) return json({ outcome: 'found', record: { status: 'accepted' } });
    if (route.endsWith('/api/getAsyncTasks')) return json([]);
    if (route.endsWith('/api/getSubagents')) return json([]);
    if (route.endsWith('/api/getAgentTranscriptTail')) return json([{ kind: 'send-message', message: { type: 'text', content: 'hello from grok' } }]);
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
  assert.equal((await request({ ...scoped, action: 'steer', run_id: started.body.run_id, input: 'later' })).status, 409);
  const status = await request({ ...scoped, action: 'status', run_id: started.body.run_id });
  assert.equal(status.body.status, 'completed');
  assert.equal(status.body.output, 'hello from grok');
  assert.equal((await request({ ...scoped, action: 'jobs' })).status, 409);
  assert.deepEqual((await request({ ...scoped, action: 'capabilities' })).body, { features: { run_events_sse: false } });
  const hermes = await request({ action: 'start', input: 'hello hermes', profile_id: 'default' });
  assert.equal(hermes.status, 202);
  assert.equal(calls.at(-1).url, 'http://hermes.test/v1/runs');
  assert.equal(calls.at(-1).options.headers.Authorization, 'Bearer hermes-key');
});
