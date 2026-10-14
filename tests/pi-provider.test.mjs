import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createAgentHandler } from '../server/agent.mjs';
import { createWorkspaceService } from '../server/workspace.mjs';
import { startPiGateway } from '../server/pi-gateway.mjs';
import { initial } from '../src/model.ts';

/**
 * The full chain: Orbit's agent handler -> loopback Pi gateway -> Pi RPC child.
 *
 * The child is the recorded stub, so this runs without a model credential. The
 * workspace context is a real workspace service, which is what proves a Pi turn
 * carries the same operator block a Grok Bot turn gets.
 */

const stub = fileURLToPath(new URL('./fixtures/pi-rpc-stub.mjs', import.meta.url));
const token = 'orbit-test-token-'.repeat(4);
const session = 'orbit-12345678-1234-4234-9234-123456789abc';
const workspace_id = '12345678-1234-4234-9234-123456789abc';
const pane_id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const gatewayToken = 'pi-provider-token-'.repeat(3);

async function openOrbit(t, { runRoot, workspaceContext } = {}) {
  const runtimeDirectory = runRoot || fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-pi-provider-'));
  const gatewayDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-pi-gateway-'));
  const gateway = await startPiGateway({ token: gatewayToken, directory: gatewayDirectory, binary: process.execPath, args: [stub] });
  let handler;
  let port;
  const reply = (res, status, data) => {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(data));
  };
  const workspaceRead = () => ({ state: { monitors: [{ layout: { type: 'pane', pane: { id: pane_id, kind: 'agent' } } }] } });
  const server = http.createServer((req, res) =>
    (handler ||= createAgentHandler({
      token,
      port,
      devOrigins: [],
      reply,
      runtimeDirectory,
      workspaceRead,
      ...(workspaceContext ? { workspaceContext } : {}),
      apiUrl: 'http://hermes.test',
      apiKey: 'hermes-key',
      additionalProfiles: [{ id: 'pi', label: 'Pi', provider: 'pi', apiUrl: gateway.url, apiKey: gatewayToken }],
    }))(req, res));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  port = server.address().port;
  t.after(async () => {
    await new Promise(resolve => server.close(resolve));
    await gateway.close();
    fs.rmSync(gatewayDirectory, { recursive: true, force: true });
    fs.rmSync(runtimeDirectory, { recursive: true, force: true });
  });
  const origin = `http://127.0.0.1:${port}`;
  async function request(body, options = {}) {
    const response = await fetch(`${origin}/api/agent`, {
      method: 'POST',
      headers: { Origin: origin, Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ session_id: session, ...body }),
    });
    if (options.raw) return response;
    return { status: response.status, body: await response.json() };
  }
  return { request, directory: runtimeDirectory, gateway };
}

async function waitFor(check, { timeout = 8_000, interval = 25 } = {}) {
  const deadline = Date.now() + timeout;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > deadline) throw Error('timed out waiting for the Pi turn to finish');
    await new Promise(resolve => setTimeout(resolve, interval));
  }
}

/** Bind the pane to a fresh Pi conversation and return the scoped request base. */
async function bindPi(request, conversationName) {
  const base = { workspace_id, pane_id, session_id: session };
  assert.equal((await request({ ...base, action: 'shared_chat', initial: { session, messages: [] } })).status, 200);
  const selected = await request({
    ...base,
    action: 'select_session',
    target_profile_id: 'pi',
    expected_binding_revision: 0,
    ...(conversationName ? { conversation_name: conversationName } : {}),
  });
  assert.equal(selected.status, 200, JSON.stringify(selected.body));
  assert.equal(selected.body.state.profile_id, 'pi');
  return {
    ...base,
    profile_id: 'pi',
    session_id: selected.body.state.session,
    expected_binding_revision: selected.body.state.binding_revision,
  };
}

test('Pi is selectable beside Hermes and Grok Bot and answers through its own gateway', async t => {
  const { request, gateway } = await openOrbit(t);
  const profiles = await request({ action: 'profiles' });
  assert.equal(profiles.status, 200);
  assert.deepEqual(profiles.body.profiles, [{ id: 'default', label: 'Default' }, { id: 'pi', label: 'Pi', provider: 'pi' }]);
  assert.equal(JSON.stringify(profiles.body).includes(gatewayToken), false);

  const menu = await request({ action: 'provider_menu', workspace_id, pane_id });
  assert.equal(menu.status, 200);
  const entry = menu.body.providers.find(row => row.id === 'pi');
  assert.equal(entry.provider, 'pi');
  assert.equal(entry.health, 'up');
  assert.equal(entry.tools, true);
  assert.equal(entry.gateway, 'Pi');

  const scoped = await bindPi(request);
  const listed = await request({ ...scoped, action: 'sessions', target_profile_id: 'pi' });
  assert.equal(listed.status, 200);
  assert.equal(listed.body.sessions.length, 1);
  assert.equal(listed.body.sessions[0].title, 'Orbit chat');

  const started = await request({ ...scoped, action: 'start', input: 'hello pi' });
  assert.equal(started.status, 202);
  assert.match(started.body.run_id, /^run_[a-zA-Z0-9_-]{8,100}$/);

  // Guidance goes to the gateway as another prompt on the same Pi session.
  const steered = await request({ ...scoped, action: 'steer', run_id: started.body.run_id, input: 'look at the tests' });
  assert.equal(steered.status, 200);
  assert.equal(steered.body.accepted, true);

  const done = await waitFor(async () => {
    const status = await request({ ...scoped, action: 'status', run_id: started.body.run_id });
    return status.body.status === 'completed' ? status.body : null;
  });
  assert.match(done.output, /^hello from pi: /);
  const prompts = await waitFor(async () => {
    const tail = await (await fetch(`${gateway.url}/api/getAgentTranscriptTail`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${gatewayToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: scoped.session_id, limit: 20 }),
    })).json();
    const user = (tail.entries || []).filter(entry => entry.kind === 'message' && entry.role === 'user').map(entry => entry.content);
    return user.length >= 2 ? user : null;
  });
  assert.deepEqual(prompts, ['hello pi', 'look at the tests']);

  const activity = await request({ ...scoped, action: 'activity' });
  assert.equal(activity.status, 200);
  assert.equal(activity.body.activity[0].kind, 'call');
  assert.equal(activity.body.activity[0].name, 'read');
  assert.equal(activity.body.activity[1].kind, 'result');

  const jobs = await request({ ...scoped, action: 'jobs' });
  assert.equal(jobs.status, 200);
  assert.deepEqual(jobs.body.jobs, []);
  assert.equal((await request({ ...scoped, action: 'build_queue', operation: 'list' })).status, 409);
  assert.deepEqual((await request({ ...scoped, action: 'capabilities' })).body, { features: { run_events_sse: true } });

  const catalogue = await request({ ...scoped, action: 'catalog', kind: 'toolsets' });
  assert.equal(catalogue.status, 200);
  assert.equal(catalogue.body.items[0].name, 'pi-builtin');
  assert.equal((await request({ ...scoped, action: 'catalog', kind: 'skills' })).status, 409);

  const conversation = await request({ ...scoped, action: 'shared_chat' });
  assert.equal(conversation.body.state.profile_id, 'pi');
});

test('a Pi turn carries the workspace operator block and never inlines the guide', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-pi-workspace-'));
  let service;
  const wsReply = (res, status, data) => {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(data));
  };
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
  const synced = await fetch(`${wsOrigin}/workspace`, {
    method: 'POST',
    headers: { Origin: wsOrigin, Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ workspace_id, action: 'sync', state: initial() }),
  });
  assert.equal(synced.status, 200);

  const { request, gateway } = await openOrbit(t, { workspaceContext: service.context });
  const scoped = await bindPi(request);
  const started = await request({ ...scoped, action: 'start', input: 'build a timer app' });
  assert.equal(started.status, 202);
  // The pane records what Kyle typed; the gateway records the prompt Pi received.
  const entries = await waitFor(async () => {
    const tail = await (await fetch(`${gateway.url}/api/getAgentTranscriptTail`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${gatewayToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: scoped.session_id, limit: 20 }),
    })).json();
    const user = (tail.entries || []).find(entry => entry.kind === 'message' && entry.role === 'user');
    return user ? user.content : null;
  });
  const operator = service.context.parts(workspace_id).operator;
  assert.match(entries, /workspace_control\.py/);
  assert.match(entries, /publish/);
  assert.ok(entries.includes(operator.trim()));
  assert.match(entries, /build a timer app/);
  assert.match(entries, /AGENT_GUIDE\.md/);
  assert.equal(entries.includes('# Hermes workspace operator guide'), false);
});

test('a Pi conversation name is honoured and a stop ends the turn honestly', async t => {
  const { request } = await openOrbit(t);
  const scoped = await bindPi(request, 'Ship notes');
  const listed = await request({ ...scoped, action: 'sessions', target_profile_id: 'pi' });
  assert.equal(listed.body.sessions[0].title, 'Ship notes');
  const started = await request({ ...scoped, action: 'start', input: '[SLOW] think forever' });
  assert.equal(started.status, 202);
  const stopped = await request({ ...scoped, action: 'stop', run_id: started.body.run_id });
  assert.equal(stopped.status, 200);
  assert.equal(stopped.body.status, 'stopping');
  const conversation = await request({ ...scoped, action: 'shared_chat' });
  const last = conversation.body.state.messages.at(-1);
  assert.equal(last.role, 'assistant');
  assert.match(last.text, /Run cancelled/);
});

test('a Pi provider failure never becomes a plausible reply', async t => {
  const { request, gateway } = await openOrbit(t);
  const scoped = await bindPi(request);
  const started = await request({ ...scoped, action: 'start', input: '[FAIL] do the impossible' });
  assert.equal(started.status, 202);
  const turned = await waitFor(async () => {
    const status = await request({ ...scoped, action: 'status', run_id: started.body.run_id });
    return status.body.status === 'running' ? null : status.body;
  });
  // The gateway records the harness failure as Pi's own message, so the pane shows
  // the reason instead of an empty turn. What it must never do is invent a reply.
  assert.match(turned.output, /Pi could not finish this turn/);
  assert.match(turned.output, /provider refused this request/);
  assert.equal(/hello from pi/.test(turned.output), false);
  const tail = await (await fetch(`${gateway.url}/api/getAgentTranscriptTail`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${gatewayToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: scoped.session_id, limit: 20 }),
  })).json();
  const assistant = tail.entries.filter(entry => entry.kind === 'message' && entry.role === 'assistant');
  assert.equal(assistant.length, 1);
  assert.match(assistant[0].content, /could not finish/);
});
