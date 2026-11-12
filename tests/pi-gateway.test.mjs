import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPiRpc } from '../server/pi-rpc.mjs';
import { startPiGateway } from '../server/pi-gateway.mjs';

const stub = fileURLToPath(new URL('./fixtures/pi-rpc-stub.mjs', import.meta.url));
const framing = fileURLToPath(new URL('./fixtures/pi-rpc-framing.mjs', import.meta.url));
const token = 'pi-gateway-token-'.repeat(3);
const agentPattern = /^pi_[a-f0-9]{16}$/;

function runtimeDirectory() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-pi-gateway-'));
}

async function waitFor(check, { timeout = 8_000, interval = 20 } = {}) {
  const deadline = Date.now() + timeout;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > deadline) throw Error('timed out waiting for Pi gateway state');
    await new Promise(resolve => setTimeout(resolve, interval));
  }
}

async function openGateway(t, { directory = runtimeDirectory(), binary = process.execPath, args = [stub], token: bearer = token } = {}) {
  const started = await startPiGateway({ token: bearer, directory, binary, args });
  t.after(async () => {
    await started.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  async function call(name, body, options = {}) {
    const response = await fetch(`${started.url}/api/${name}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${options.token || bearer}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body ?? {}),
    });
    const text = await response.text();
    let parsed;
    try {
      parsed = text ? JSON.parse(text) : {};
    } catch {
      parsed = { raw: text };
    }
    return { status: response.status, body: parsed };
  }
  return { ...started, call };
}

test('the Pi gateway refuses an unauthorized request and never echoes its token', async t => {
  const gateway = await openGateway(t);
  const denied = await gateway.call('listAgents', {}, { token: 'not-the-token-not-the-token-not-th' });
  assert.equal(denied.status, 401);
  assert.equal(JSON.stringify(denied.body).includes(token), false);
  const route = await fetch(`${gateway.url}/robots.txt`, { headers: { Authorization: `Bearer ${token}` } });
  assert.equal(route.status, 404);
});

test('a Pi conversation lists, prompts, records its transcript, and exposes tool activity', async t => {
  const gateway = await openGateway(t);
  const created = await gateway.call('createAgent', { name: 'Orbit chat', isIntroductionSuppressed: true });
  assert.equal(created.status, 200);
  const agentId = created.body.agent.id;
  assert.match(agentId, agentPattern);
  assert.equal(created.body.agent.name, 'Orbit chat');

  const listed = await gateway.call('listAgents', {});
  assert.equal(listed.status, 200);
  assert.deepEqual(listed.body.map(agent => agent.id), [agentId]);
  assert.equal(listed.body[0].isRunning, false);

  const sent = await gateway.call('sendPrompt', { prompt: 'build a timer app', agentId, clientNonce: 'nonce-1' });
  assert.equal(sent.status, 200);
  assert.equal(sent.body.accepted, true);

  const tail = await waitFor(async () => {
    const { body } = await gateway.call('getAgentTranscriptTail', { id: agentId, limit: 40 });
    return Array.isArray(body.entries) && body.entries.some(entry => entry.role === 'assistant' && entry.kind === 'message') ? body.entries : null;
  });
  const user = tail.find(entry => entry.role === 'user');
  const assistant = tail.find(entry => entry.role === 'assistant');
  assert.equal(user.content, 'build a timer app');
  assert.match(assistant.content, /^hello from pi: build a timer app/);
  assert.ok(tail.every(entry => Number.isInteger(entry.seq) && typeof entry.id === 'string'));
  assert.ok(tail.every((entry, index) => index === 0 || entry.seq > tail[index - 1].seq));

  const tools = tail.filter(entry => entry.kind === 'tool-call' || entry.kind === 'tool-result');
  assert.deepEqual(tools.map(entry => entry.kind), ['tool-call', 'tool-result']);
  assert.equal(tools[0].toolCall.name, 'read');
  assert.match(tools[0].toolCall.input, /README\.md/);
  assert.match(tools[1].output, /file body/);

  const acceptance = await gateway.call('promptAcceptanceStatus', { accountSlot: 'host', clientNonce: 'nonce-1', agentId });
  assert.equal(acceptance.body.outcome, 'found');
  assert.equal(acceptance.body.record.status, 'accepted');
  assert.equal((await gateway.call('promptAcceptanceStatus', { clientNonce: 'never-sent', agentId })).body.outcome, 'not-found');

  const outline = await gateway.call('getConversationOutline', { id: agentId });
  assert.equal(outline.status, 200);
  assert.equal(outline.body.items.length, 2);

  const servers = await gateway.call('listBoxMcpServers', {});
  assert.equal(servers.body.servers[0].serverIdentifier, 'pi-builtin');
  assert.deepEqual((await gateway.call('listAllAutomations', {})).body, []);
  assert.equal((await gateway.call('createAgentAutomation', {})).status, 404);
  assert.equal((await gateway.call('getAgentTranscriptTail', { id: 'pi_0000000000000000' })).status, 404);
  assert.equal((await gateway.call('getAgentTranscriptTail', { id: 'not-an-agent' })).status, 404);
});

test('a Pi provider failure is a rejected turn, not a plausible reply', async t => {
  const gateway = await openGateway(t);
  const agentId = (await gateway.call('createAgent', { name: 'Failing' })).body.agent.id;
  assert.equal((await gateway.call('sendPrompt', { prompt: '[FAIL] do the thing', agentId, clientNonce: 'nonce-fail' })).body.accepted, true);
  const rejected = await waitFor(async () => {
    const { body } = await gateway.call('promptAcceptanceStatus', { clientNonce: 'nonce-fail', agentId });
    return body.outcome === 'found' && body.record.status === 'rejected' ? body.record : null;
  });
  assert.match(rejected.error, /provider refused this request/);
  const { body } = await gateway.call('getAgentTranscriptTail', { id: agentId, limit: 20 });
  const assistant = body.entries.filter(entry => entry.kind === 'message' && entry.role === 'assistant');
  assert.equal(assistant.length, 1);
  assert.match(assistant[0].content, /Pi could not finish this turn/);
  assert.equal(assistant[0].content.includes('hello from pi'), false);
});

test('stopping a Pi turn aborts the run and records a stop notice', async t => {
  const gateway = await openGateway(t);
  const agentId = (await gateway.call('createAgent', { name: 'Slow' })).body.agent.id;
  await gateway.call('sendPrompt', { prompt: '[SLOW] keep going', agentId, clientNonce: 'nonce-slow' });
  const running = await waitFor(async () => {
    const { body } = await gateway.call('listAgents', {});
    return body.find(agent => agent.id === agentId && agent.isRunning === true) || null;
  });
  assert.equal(running.id, agentId);
  const stopped = await gateway.call('interruptAgentRun', { id: agentId });
  assert.equal(stopped.status, 200);
  assert.equal(stopped.body.ok, true);
  const settled = await waitFor(async () => {
    const { body } = await gateway.call('getAgentTranscriptTail', { id: agentId, limit: 20 });
    return body.entries.find(entry => entry.kind === 'message' && entry.role === 'assistant') || null;
  });
  assert.match(settled.content, /Pi stopped this turn|Pi could not finish/);
  const acceptance = await gateway.call('promptAcceptanceStatus', { clientNonce: 'nonce-slow', agentId });
  assert.equal(acceptance.body.record.status, 'cancelled');
});

test('a Pi extension dialog is cancelled so the turn cannot deadlock', async t => {
  const gateway = await openGateway(t);
  const agentId = (await gateway.call('createAgent', { name: 'Dialog' })).body.agent.id;
  await gateway.call('sendPrompt', { prompt: '[ASK] trust the folder', agentId, clientNonce: 'nonce-ask' });
  const entries = await waitFor(async () => {
    const { body } = await gateway.call('getAgentTranscriptTail', { id: agentId, limit: 30 });
    return body.entries.some(entry => entry.kind === 'message' && typeof entry.content === 'string' && entry.content.startsWith('hello from pi')) ? body.entries : null;
  });
  const cancelled = entries.find(entry => typeof entry.content === 'string' && entry.content.includes('no widget surface'));
  assert.ok(cancelled, 'the cancelled dialog is recorded');
  const reply = entries.find(entry => entry.kind === 'message' && entry.role === 'assistant' && entry.content.startsWith('hello from pi'));
  assert.ok(reply, 'the run continued after the dialog was cancelled');
});

test('Pi conversations and transcripts survive a gateway restart while run records do not', async t => {
  const directory = runtimeDirectory();
  const first = await startPiGateway({ token, directory, binary: process.execPath, args: [stub] });
  const agentId = (await (await fetch(`${first.url}/api/createAgent`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'Persisted' }),
  })).json()).agent.id;
  await fetch(`${first.url}/api/sendPrompt`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ prompt: 'remember this', agentId, clientNonce: 'nonce-persist' }),
  });
  let entries = [];
  await waitFor(async () => {
    const response = await fetch(`${first.url}/api/getAgentTranscriptTail`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: agentId, limit: 20 }),
    });
    entries = (await response.json()).entries || [];
    return entries.some(entry => entry.role === 'assistant');
  });
  await first.close();

  const second = await startPiGateway({ token, directory, binary: process.execPath, args: [stub] });
  t.after(async () => {
    await second.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  const listed = await (await fetch(`${second.url}/api/listAgents`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: '{}',
  })).json();
  assert.deepEqual(listed.map(agent => agent.id), [agentId]);
  assert.equal(listed[0].name, 'Persisted');
  const replayed = await (await fetch(`${second.url}/api/getAgentTranscriptTail`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: agentId, limit: 20 }),
  })).json();
  assert.equal(replayed.entries.length, entries.length);
  assert.match(replayed.entries.find(entry => entry.role === 'assistant').content, /^hello from pi/);
  assert.equal(fs.statSync(path.join(directory, 'agents.json')).mode & 0o077, 0);
  const acceptance = await (await fetch(`${second.url}/api/promptAcceptanceStatus`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ clientNonce: 'nonce-persist', agentId }),
  })).json();
  assert.equal(acceptance.outcome, 'not-found');
});

test('the live activity stream carries agent-scoped records and closes cleanly', async t => {
  const gateway = await openGateway(t);
  const agentId = (await gateway.call('createAgent', { name: 'Live' })).body.agent.id;
  const controller = new AbortController();
  const stream = await fetch(`${gateway.url}/events`, { headers: { Authorization: `Bearer ${token}`, Accept: 'text/event-stream' }, signal: controller.signal });
  assert.equal(stream.headers.get('content-type'), 'text/event-stream');
  const reader = stream.body.getReader();
  const decoder = new TextDecoder();
  let text = '';
  const reading = (async () => {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      text += decoder.decode(value, { stream: true });
      if (text.includes('"kind":"settled"')) break;
    }
  })();
  await new Promise(resolve => setTimeout(resolve, 50));
  await gateway.call('sendPrompt', { prompt: 'go live', agentId, clientNonce: 'nonce-live' });
  await reading;
  controller.abort();
  assert.match(text, /"channel":"note"/);
  assert.match(text, /"channel":"message"/);
  assert.match(text, /"channel":"tool"/);
  assert.ok(text.includes(`"agentId":"${agentId}"`));
  assert.equal(text.includes(token), false);
});

test('Pi RPC splits records on LF only and reports command failures', async t => {
  const rpc = createPiRpc({ binary: process.execPath, args: [framing], requestTimeoutMs: 5_000 });
  t.after(() => rpc.stop());
  const state = await rpc.request('get_state');
  assert.equal(state.text, 'before\u2028middle\u2029after');
  await assert.rejects(() => rpc.request('nonexistent_command'), /one job/);
});

test('a Pi RPC session that never answers rejects the command instead of hanging', async () => {
  const rpc = createPiRpc({ binary: process.execPath, args: ['-e', 'setTimeout(() => {}, 30_000)'], requestTimeoutMs: 200 });
  try {
    await assert.rejects(() => rpc.request('get_state'), /did not answer the command in time/);
  } finally {
    rpc.stop();
  }
});
