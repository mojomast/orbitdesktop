import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { createOpenAICompatGateway, startOpenAICompatGateway } from '../server/openai-compat-gateway.mjs';

const SECRET = 'sk-orbit-openai-compat-test-0123456789';
const KEY_ENV = 'ORBIT_OPENAI_COMPAT_TEST_KEY';

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-openai-compat-'));
}

function startServer(handler) {
  const sockets = new Set();
  const server = http.createServer((req, res) => {
    handler(req, res).catch(error => {
      try {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: error?.message || 'test server failure' } }));
      } catch {}
    });
  });
  server.on('connection', socket => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({
        baseUrl: `http://127.0.0.1:${port}/v1`,
        origin: `http://127.0.0.1:${port}`,
        close: async () => {
          for (const socket of sockets) socket.destroy();
          await new Promise(done => server.close(done));
        },
      });
    });
  });
}

async function bodyOf(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
}

function json(res, status, payload) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(payload));
}

function sse(res, frame) {
  res.write(`data: ${JSON.stringify(frame)}\n\n`);
}

async function waitFor(check, { timeout = 6_000, interval = 20 } = {}) {
  const deadline = Date.now() + timeout;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > deadline) throw Error('timed out waiting for gateway state');
    await new Promise(resolve => setTimeout(resolve, interval));
  }
}

function gatewayFor(baseUrl, runtimeDir, overrides = {}) {
  return createOpenAICompatGateway({
    id: 'test-openai',
    label: 'Test OpenAI',
    baseUrl,
    model: 'test-model',
    apiKeyEnv: KEY_ENV,
    env: { [KEY_ENV]: SECRET },
    runtimeDir,
    ...overrides,
  });
}

test('base URLs must be plain http(s) origins without credentials', () => {
  const runtimeDir = tempDir();
  try {
    for (const baseUrl of ['ftp://127.0.0.1:1234/v1', 'not a url', 'http://user:pass@127.0.0.1:1234/v1', 'http://127.0.0.1:1234/v1?token=1']) {
      assert.throws(() => createOpenAICompatGateway({ baseUrl, runtimeDir, model: 'test-model' }), /base URL|http/i);
    }
    assert.throws(() => createOpenAICompatGateway({ runtimeDir }), /base URL|http/i);
  } finally {
    fs.rmSync(runtimeDir, { recursive: true, force: true });
  }
});

test('agents list, persist with 0600 files, and models are read from the endpoint', async t => {
  const runtimeDir = tempDir();
  let modelsAuthorization = '';
  const server = await startServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    if (url.pathname === '/v1/models') {
      modelsAuthorization = req.headers.authorization || '';
      return json(res, 200, { data: [{ id: 'alpha' }, { id: 'beta' }] });
    }
    return json(res, 404, { error: { message: 'not found' } });
  });
  t.after(async () => {
    await server.close();
    fs.rmSync(runtimeDir, { recursive: true, force: true });
  });

  const gateway = gatewayFor(server.baseUrl, runtimeDir);
  assert.deepEqual(await gateway.listModels(), ['alpha', 'beta']);
  assert.equal(modelsAuthorization, `Bearer ${SECRET}`);

  const created = await gateway.createAgent({ name: 'Test conversation' });
  assert.match(created.agent.id, /^[A-Za-z0-9_:-]{1,128}$/);
  assert.equal(created.agent.name, 'Test conversation');

  const listed = await gateway.listAgents();
  assert.equal(listed.length, 1);
  assert.equal(listed[0].id, created.agent.id);
  assert.equal(listed[0].isRunning, false);
  assert.equal(listed[0].isComposingMessage, false);
  assert.equal(typeof listed[0].updatedAt, 'number');

  const store = path.join(runtimeDir, 'agents.json');
  assert.equal(fs.statSync(store).mode & 0o777, 0o600);
  assert.equal(JSON.stringify(created).includes(SECRET), false);
  assert.equal(JSON.stringify(listed).includes(SECRET), false);

  const reopened = gatewayFor(server.baseUrl, runtimeDir);
  assert.equal((await reopened.listAgents())[0].id, created.agent.id);
  gateway.close();
  reopened.close();
});

test('sendPrompt streams an SSE reply into the transcript tail', async t => {
  const runtimeDir = tempDir();
  const requests = [];
  const server = await startServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    const body = await bodyOf(req);
    requests.push({ path: url.pathname, headers: req.headers, body });
    if (url.pathname !== '/v1/chat/completions') return json(res, 404, { error: { message: 'not found' } });
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
    sse(res, { choices: [{ delta: { content: 'Hello ' } }] });
    sse(res, { choices: [{ delta: { content: 'from the endpoint' } }] });
    res.write('data: [DONE]\n\n');
    res.end();
  });
  t.after(async () => {
    await server.close();
    fs.rmSync(runtimeDir, { recursive: true, force: true });
  });

  const gateway = gatewayFor(server.baseUrl, runtimeDir);
  t.after(() => gateway.close());
  const agentId = (await gateway.createAgent({ name: 'Streaming' })).agent.id;
  const sent = await gateway.sendPrompt({ agentId, prompt: 'hello there', clientNonce: 'nonce-stream' });
  assert.equal(sent.accepted, true);

  const entries = await waitFor(async () => {
    const tail = await gateway.getAgentTranscriptTail({ id: agentId, limit: 40 });
    return tail.entries.some(entry => entry.role === 'assistant' && entry.kind === 'message') ? tail.entries : null;
  });
  const user = entries.find(entry => entry.role === 'user');
  const assistant = entries.find(entry => entry.role === 'assistant');
  assert.equal(user.content, 'hello there');
  assert.equal(assistant.content, 'Hello from the endpoint');
  assert.ok(entries.every((entry, index) => index === 0 || entry.seq > entries[index - 1].seq));

  const acceptance = await gateway.promptAcceptanceStatus({ clientNonce: 'nonce-stream', agentId });
  assert.equal(acceptance.outcome, 'found');
  assert.equal(acceptance.record.status, 'accepted');

  assert.equal(requests.length, 1);
  assert.equal(requests[0].path, '/v1/chat/completions');
  assert.equal(requests[0].headers.authorization, `Bearer ${SECRET}`);
  assert.equal(requests[0].body.stream, true);
  assert.equal(requests[0].body.model, 'test-model');
  assert.equal(requests[0].body.messages.at(-1).content, 'hello there');

  const transcript = path.join(runtimeDir, `${agentId}.jsonl`);
  assert.equal(fs.statSync(transcript).mode & 0o777, 0o600);
  assert.equal(JSON.stringify({ sent, entries, acceptance }).includes(SECRET), false);
});

test('a stream-unsupported endpoint falls back to a non-streaming completion', async t => {
  const runtimeDir = tempDir();
  const requests = [];
  const server = await startServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    const body = await bodyOf(req);
    requests.push(body);
    if (url.pathname !== '/v1/chat/completions') return json(res, 404, { error: { message: 'not found' } });
    if (body.stream === true) return json(res, 400, { error: { message: 'streaming is not supported' } });
    return json(res, 200, { choices: [{ message: { role: 'assistant', content: 'Fallback reply' }, finish_reason: 'stop' }] });
  });
  t.after(async () => {
    await server.close();
    fs.rmSync(runtimeDir, { recursive: true, force: true });
  });

  const gateway = gatewayFor(server.baseUrl, runtimeDir);
  t.after(() => gateway.close());
  const agentId = (await gateway.createAgent({ name: 'Fallback' })).agent.id;
  await gateway.sendPrompt({ agentId, prompt: 'try a stream', clientNonce: 'nonce-fallback' });

  const { entries } = await gateway.getAgentTranscriptTail({ id: agentId, limit: 40 });
  const assistant = entries.find(entry => entry.role === 'assistant' && entry.kind === 'message');
  assert.ok(assistant, 'the fallback reply is recorded before sendPrompt returns');
  assert.equal(assistant.content, 'Fallback reply');
  assert.equal(requests.length, 2);
  assert.equal(requests[0].stream, true);
  assert.equal(requests[1].stream, false);
  assert.equal((await gateway.promptAcceptanceStatus({ clientNonce: 'nonce-fallback', agentId })).record.status, 'accepted');
});

test('interruptAgentRun aborts the active request and records a stop', async t => {
  const runtimeDir = tempDir();
  const server = await startServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    await bodyOf(req);
    if (url.pathname !== '/v1/chat/completions') return json(res, 404, { error: { message: 'not found' } });
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    sse(res, { choices: [{ delta: { content: 'Partial reply' } }] });
    const timer = setInterval(() => {
      try {
        res.write(': still working\n\n');
      } catch {}
    }, 25);
    res.on('close', () => clearInterval(timer));
    req.on('close', () => clearInterval(timer));
  });
  t.after(async () => {
    await server.close();
    fs.rmSync(runtimeDir, { recursive: true, force: true });
  });

  const gateway = gatewayFor(server.baseUrl, runtimeDir);
  t.after(() => gateway.close());
  const agentId = (await gateway.createAgent({ name: 'Interrupt' })).agent.id;
  await gateway.sendPrompt({ agentId, prompt: 'keep working', clientNonce: 'nonce-interrupt' });

  await waitFor(async () => (await gateway.listAgents()).find(agent => agent.id === agentId)?.isRunning === true);
  const stopped = await gateway.interruptAgentRun({ id: agentId });
  assert.equal(stopped.ok, true);

  const acceptance = await waitFor(async () => {
    const status = await gateway.promptAcceptanceStatus({ clientNonce: 'nonce-interrupt', agentId });
    return status.record?.status === 'cancelled' ? status : null;
  });
  assert.equal(acceptance.record.status, 'cancelled');

  const assistant = await waitFor(async () => {
    const { entries } = await gateway.getAgentTranscriptTail({ id: agentId, limit: 40 });
    return entries.find(entry => entry.role === 'assistant' && entry.kind === 'message') || null;
  });
  assert.match(assistant.content, /Partial reply/);
  assert.match(assistant.content, /stopped this turn/i);
  await waitFor(async () => (await gateway.listAgents()).find(agent => agent.id === agentId)?.isRunning === false);
});

test('the API key is never included in returned payloads or thrown errors', async t => {
  const runtimeDir = tempDir();
  const server = await startServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    const body = await bodyOf(req);
    if (url.pathname !== '/v1/chat/completions') return json(res, 404, { error: { message: 'not found' } });
    if (body.messages.at(-1).content === 'stream leak') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      sse(res, { error: { message: `upstream rejected ${SECRET}` } });
      res.end();
      return;
    }
    return json(res, 401, { error: { message: `Invalid API key ${SECRET}` } });
  });
  t.after(async () => {
    await server.close();
    fs.rmSync(runtimeDir, { recursive: true, force: true });
  });

  const gateway = gatewayFor(server.baseUrl, runtimeDir);
  t.after(() => gateway.close());
  const agentId = (await gateway.createAgent({ name: 'Leak check' })).agent.id;

  await assert.rejects(
    () => gateway.sendPrompt({ agentId, prompt: 'bad key', clientNonce: 'nonce-bad-key' }),
    error => {
      assert.equal(String(error.message).includes(SECRET), false);
      assert.match(String(error.message), /redacted|API key|rejected/i);
      return true;
    },
  );

  await gateway.sendPrompt({ agentId, prompt: 'stream leak', clientNonce: 'nonce-stream-leak' });
  const assistant = await waitFor(async () => {
    const { entries } = await gateway.getAgentTranscriptTail({ id: agentId, limit: 40 });
    return entries.find(entry => entry.role === 'assistant' && entry.kind === 'message') || null;
  });
  assert.equal(assistant.content.includes(SECRET), false);
  assert.match(assistant.content, /redacted/i);
  const visible = JSON.stringify({
    agents: await gateway.listAgents(),
    tail: await gateway.getAgentTranscriptTail({ id: agentId, limit: 40 }),
    acceptance: await gateway.promptAcceptanceStatus({ clientNonce: 'nonce-bad-key', agentId }),
  });
  assert.equal(visible.includes(SECRET), false);
});

test('a key file is read at call time and must be mode 0600', async t => {
  const runtimeDir = tempDir();
  const keyFile = path.join(runtimeDir, 'key');
  fs.writeFileSync(keyFile, `${SECRET}\n`, { mode: 0o600 });
  const seen = [];
  const server = await startServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    const body = await bodyOf(req);
    seen.push(req.headers.authorization || '');
    if (url.pathname !== '/v1/chat/completions') return json(res, 404, { error: { message: 'not found' } });
    return json(res, 200, { choices: [{ message: { role: 'assistant', content: 'key file reply' } }] });
  });
  t.after(async () => {
    await server.close();
    fs.rmSync(runtimeDir, { recursive: true, force: true });
  });

  const gateway = createOpenAICompatGateway({
    id: 'file-key',
    label: 'File key',
    baseUrl: server.baseUrl,
    model: 'test-model',
    apiKeyFile: keyFile,
    runtimeDir,
    env: {},
  });
  t.after(() => gateway.close());
  const agentId = (await gateway.createAgent({ name: 'File key' })).agent.id;
  await gateway.sendPrompt({ agentId, prompt: 'read the file key', clientNonce: 'nonce-file-key' });
  await waitFor(async () => (await gateway.getAgentTranscriptTail({ id: agentId, limit: 20 })).entries.some(entry => entry.role === 'assistant'));
  assert.equal(seen[0], `Bearer ${SECRET}`);
  assert.equal((await gateway.getAgentTranscriptTail({ id: agentId, limit: 20 })).entries.some(entry => JSON.stringify(entry).includes(SECRET)), false);

  fs.chmodSync(keyFile, 0o644);
  await assert.rejects(
    () => gateway.sendPrompt({ agentId, prompt: 'unsafe key file', clientNonce: 'nonce-unsafe-file' }),
    error => {
      assert.equal(String(error.message).includes(SECRET), false);
      assert.match(String(error.message), /0600|permission/i);
      return true;
    },
  );
  assert.equal(seen.length, 1);
});

test('a redirect is refused and never followed to another host', async t => {
  const runtimeDir = tempDir();
  let targetHits = 0;
  const target = await startServer(async (req, res) => {
    targetHits += 1;
    await bodyOf(req);
    return json(res, 200, { choices: [{ message: { content: 'should not happen' } }] });
  });
  const source = await startServer(async (req, res) => {
    await bodyOf(req);
    res.writeHead(302, { Location: `${target.origin}/v1/chat/completions` });
    res.end();
  });
  t.after(async () => {
    await source.close();
    await target.close();
    fs.rmSync(runtimeDir, { recursive: true, force: true });
  });

  const gateway = gatewayFor(source.baseUrl, runtimeDir);
  t.after(() => gateway.close());
  const agentId = (await gateway.createAgent({ name: 'Redirect' })).agent.id;
  await assert.rejects(
    () => gateway.sendPrompt({ agentId, prompt: 'do not follow', clientNonce: 'nonce-redirect' }),
    /redirect/i,
  );
  assert.equal(targetHits, 0);
});

test('the live event stream reports a created conversation and its turn', async t => {
  const runtimeDir = tempDir();
  const server = await startServer(async (req, res) => {
    await bodyOf(req);
    return json(res, 200, { choices: [{ message: { content: 'event reply' } }] });
  });
  t.after(async () => {
    await server.close();
    fs.rmSync(runtimeDir, { recursive: true, force: true });
  });

  const gateway = gatewayFor(server.baseUrl, runtimeDir);
  t.after(() => gateway.close());
  const frames = [];
  const res = {
    destroyed: false,
    writableEnded: false,
    writeHead() {},
    write(chunk) {
      frames.push(String(chunk));
      return true;
    },
    on() {},
    end() {
      this.writableEnded = true;
    },
  };
  gateway.events({ on() {} }, res);
  assert.match(frames.join(''), /connected/);

  const agentId = (await gateway.createAgent({ name: 'Events' })).agent.id;
  await gateway.sendPrompt({ agentId, prompt: 'send an event', clientNonce: 'nonce-events' });
  await waitFor(() => frames.join('').includes('"kind":"created"') && frames.join('').includes('"kind":"prompt"'));
  assert.equal(frames.join('').includes(SECRET), false);
  gateway.close();
  assert.equal(res.writableEnded, true);
});

test('a loopback HTTP gateway serves the command set and rejects a missing token', async t => {
  const runtimeDir = tempDir();
  const server = await startServer(async (req, res) => {
    await bodyOf(req);
    return json(res, 200, { choices: [{ message: { role: 'assistant', content: 'http reply' } }] });
  });
  const token = 'openai-compat-test-token-'.repeat(2);
  const started = await startOpenAICompatGateway({
    port: 0,
    host: '127.0.0.1',
    token,
    runtimeDir,
    baseUrl: server.baseUrl,
    model: 'test-model',
    env: { [KEY_ENV]: SECRET },
    apiKeyEnv: KEY_ENV,
    id: 'http-test',
    label: 'HTTP test',
  });
  t.after(async () => {
    await started.close();
    await server.close();
    fs.rmSync(runtimeDir, { recursive: true, force: true });
  });

  const call = async (name, body, auth = token) => {
    const response = await fetch(`${started.url}/api/${name}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(auth ? { Authorization: `Bearer ${auth}` } : {}) },
      body: JSON.stringify(body ?? {}),
    });
    const text = await response.text();
    return { status: response.status, body: text ? JSON.parse(text) : {} };
  };

  assert.equal((await call('listAgents', {}, '')).status, 401);
  const created = await call('createAgent', { name: 'HTTP conversation' });
  assert.equal(created.status, 200);
  const agentId = created.body.agent.id;
  const sent = await call('sendPrompt', { agentId, prompt: 'over http', clientNonce: 'nonce-http' });
  assert.equal(sent.status, 200);
  assert.equal(sent.body.accepted, true);
  const tail = await waitFor(async () => {
    const result = await call('getAgentTranscriptTail', { id: agentId, limit: 20 });
    return result.body.entries?.some(entry => entry.role === 'assistant') ? result.body.entries : null;
  });
  assert.equal(tail.find(entry => entry.role === 'assistant').content, 'http reply');
  assert.equal(JSON.stringify({ created, sent, tail }).includes(SECRET), false);
});
