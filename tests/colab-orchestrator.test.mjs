import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { EventEmitter } from 'node:events';
import {
  COST_WARNING, acceleratorArgs, catalogFromHelp, colabEnvironment, collapseTerminal,
  parseNvidiaSmi, parseSessions, parseUsage, planCommand, redactSecrets, runtimeById,
} from '../server/colab-plan.mjs';
import { createColabOrchestrator } from '../server/colab-orchestrator.mjs';

const token = 'orbit-colab-test-token-orbit-colab';
const HELP = `
--gpu
  GPU accelerator variant. Supported: T4, L4, G4, H100, A100, B200.
--tpu
  TPU accelerator variant. Supported: v5e1, v6e1.
`;

function reply(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

function child() {
  const proc = new EventEmitter();
  proc.stdout = new EventEmitter();
  proc.stderr = new EventEmitter();
  proc.stdin = { writable: true, ended: undefined, chunks: '', end(data) { this.ended = data; }, write(data) { this.chunks += data; } };
  proc.kill = () => { proc.killed = true; setImmediate(() => proc.emit('close', null, 'SIGTERM')); };
  proc.pid = 4242;
  return proc;
}

function scripted(scripts) {
  const calls = [];
  const procs = [];
  function spawn(bin, args, options) {
    const proc = child();
    const script = scripts[calls.length] || scripts.at(-1);
    calls.push({ bin, args, options });
    procs.push(proc);
    setImmediate(() => {
      if (script.out) proc.stdout.emit('data', Buffer.from(script.out));
      if (script.err) proc.stderr.emit('data', Buffer.from(script.err));
      if (script.hang) return;
      proc.emit('close', script.code ?? 0, null);
    });
    return proc;
  }
  return { spawn, calls, procs };
}

async function listen(handler) {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    void Promise.resolve(handler(req, res, url)).catch(error => {
      if (!res.headersSent) reply(res, 500, { error: error.message });
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  return {
    port, server,
    async stop() { await new Promise(resolve => server.close(resolve)); },
  };
}

function service(spawn, port) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-colab-'));
  const colab = createColabOrchestrator({
    token, port, devOrigins: [], reply, spawn, bin: '/opt/colab-test/colab', home: '/home/tester', root,
  });
  return { colab, root };
}

async function post(port, body, headers = {}) {
  const response = await fetch(`http://127.0.0.1:${port}/api/colab-runtime`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, Origin: `http://127.0.0.1:${port}`, Host: `127.0.0.1:${port}`, 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() };
}

test('documented and discovered runtimes cover CPU, GPUs, TPUs, and high memory', () => {
  const fallback = catalogFromHelp('no accelerators here');
  assert.equal(fallback.discovered, false);
  assert.deepEqual(fallback.runtimes.map(runtime => runtime.id), ['cpu', 'T4', 'L4', 'A100', 'H100', 'G4', 'v5e1', 'v6e1']);
  const live = catalogFromHelp(HELP);
  assert.equal(live.discovered, true);
  assert.ok(live.runtimes.some(runtime => runtime.id === 'B200' && runtime.kind === 'gpu'));
  assert.equal(acceleratorArgs(runtimeById(live.runtimes, 'cpu'), false).length, 0);
  assert.deepEqual(acceleratorArgs(runtimeById(live.runtimes, 'G4'), true), ['--gpu', 'G4', '--high-mem']);
  assert.deepEqual(acceleratorArgs(runtimeById(live.runtimes, 'v6e1'), false), ['--tpu', 'v6e1']);
  assert.throws(() => acceleratorArgs(runtimeById(live.runtimes, 'L4'), true), /high-mem/);
});

test('command plans are argv arrays and refuse unconfirmed cost or stop', () => {
  const catalog = catalogFromHelp(HELP).runtimes;
  assert.throws(() => planCommand({ action: 'create', session: 'trainer', accelerator: 'G4' }, catalog), /Confirmation/);
  assert.throws(() => planCommand({ action: 'stop', session: 'trainer' }, catalog), /Confirmation/);
  const created = planCommand({ action: 'create', session: 'trainer', accelerator: 'A100', high_mem: true, confirm_cost: true }, catalog);
  assert.deepEqual(created.args, ['new', '-s', 'trainer', '--gpu', 'A100', '--high-mem']);
  const exec = planCommand({ action: 'exec', session: 'trainer', file: '/work/train.py', timeout: 3600 }, catalog);
  assert.deepEqual(exec.args, ['exec', '-s', 'trainer', '-f', '/work/train.py', '--timeout', '3600']);
  assert.equal(exec.background, true);
  const run = planCommand({ action: 'run', file: '/work/train.py', accelerator: 'cpu', confirm_cost: true, script_args: ['--epochs', '1'] }, catalog);
  assert.deepEqual(run.args.slice(0, 3), ['run', '--timeout', '3600']);
  assert.equal(run.args.at(-3), '/work/train.py');
  assert.deepEqual(run.args.slice(-2), ['--epochs', '1']);
  assert.equal(typeof created.args, 'object');
  assert.equal(Array.isArray(created.args), true);
});

test('usage, sessions, GPU csv, carriage returns, and secrets parse without keeping tokens', () => {
  const usage = parseUsage('Current balance: 42.50 compute units\nUsage rate: 3.25/hr\nActive assignments: 1\n');
  assert.equal(usage.balance, 42.5);
  assert.equal(usage.ratePerHour, 3.25);
  assert.equal(usage.assignments, 1);
  const sessions = parseSessions('[trainer] abc123 | Hardware: G4 | Shape: STANDARD | Variant: GPU | Status: BUSY (exec)\n[?] orphan | Hardware: T4 | Shape: HIGH_RAM | Variant: GPU\n');
  assert.equal(sessions.sessions[0].name, 'trainer');
  assert.equal(sessions.sessions[0].hardware, 'G4');
  assert.equal(sessions.sessions[0].status, 'BUSY (exec)');
  assert.equal(sessions.sessions[1].orphan, true);
  assert.equal(JSON.stringify(sessions.sessions).includes('abc123'), false);
  const bar = collapseTerminal('  0%|          | 0/3\r 50%|#####     | 1/3\r100%|##########| 3/3\n');
  assert.equal(bar.trim(), '100%|##########| 3/3');
  assert.deepEqual(parseNvidiaSmi('\u001b[32mNVIDIA RTX PRO 6000, 77, 1024, 97887, 61\u001b[0m\n'), [{
    name: 'NVIDIA RTX PRO 6000', utilization: 77, memoryUsedMiB: 1024, memoryTotalMiB: 97887, temperature: 61,
  }]);
  const leaked = redactSecrets('token ya29.SECRETVALUE and https://host/cb?access_token=hide-me');
  assert.equal(leaked.includes('SECRETVALUE'), false);
  assert.equal(leaked.includes('hide-me'), false);
});

test('child environment keeps HOME and drops ORBIT_TOKEN', () => {
  const previous = process.env.ORBIT_TOKEN;
  process.env.ORBIT_TOKEN = token;
  try {
    const env = colabEnvironment('/home/box/.local/bin/colab', '/home/box');
    assert.equal(env.HOME, '/home/box');
    assert.equal(env.ORBIT_TOKEN, undefined);
    assert.equal(Object.hasOwn(env, 'ORBIT_TOKEN'), false);
    assert.match(env.PATH, /^\/home\/box\/\.local\/bin:/);
  } finally {
    if (previous === undefined) delete process.env.ORBIT_TOKEN;
    else process.env.ORBIT_TOKEN = previous;
  }
});

test('create, exec stream, replay, and image copy use the mocked CLI', async () => {
  const image = path.join(os.tmpdir(), `orbit-plot-${process.pid}.png`);
  fs.writeFileSync(image, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  const scripts = scripted([
    { out: '[colab] Session READY.\n' },
    { out: `epoch 1\r epoch 2\n[Image saved to: ${image}]\n`, hang: true },
  ]);
  const server = await listen((req, res, url) => colab.handle(req, res, url));
  const { colab, root } = service(scripts.spawn, server.port);
  try {
    const denied = await post(server.port, { action: 'usage' }, { Authorization: 'Bearer nope' });
    assert.equal(denied.status, 401);
    const unconfirmed = await post(server.port, { action: 'create', session: 'trainer', accelerator: 'G4' });
    assert.equal(unconfirmed.status, 400);
    const created = await post(server.port, { action: 'create', session: 'trainer', accelerator: 'G4', confirm_cost: true });
    assert.equal(created.status, 200);
    assert.match(created.body.output, /READY/);
    assert.equal(created.body.warning, COST_WARNING);
    assert.deepEqual(scripts.calls[0].args, ['new', '-s', 'trainer', '--gpu', 'G4']);
    assert.equal(scripts.calls[0].options.shell, false);
    assert.equal(scripts.calls[0].options.env.ORBIT_TOKEN, undefined);
    assert.equal(scripts.calls[0].options.env.HOME, '/home/tester');

    const script = path.join(root, 'train.py');
    fs.writeFileSync(script, 'print(1)\n');
    const started = await post(server.port, { action: 'exec', session: 'trainer', file: script, timeout: 120 });
    assert.equal(started.status, 200);
    const jobId = started.body.job.id;
    await new Promise(resolve => setTimeout(resolve, 30));
    const tail = await post(server.port, { action: 'tail', job_id: jobId, after: 0 });
    assert.match(tail.body.text, /epoch 1\r epoch 2/);
    assert.match(tail.body.plain, /epoch 2/);
    assert.equal(tail.body.job.state, 'running');
    const stream = await fetch(`http://127.0.0.1:${server.port}/api/colab-runtime/stream?job=${jobId}&after=0`, {
      headers: { Authorization: `Bearer ${token}`, Origin: `http://127.0.0.1:${server.port}`, Host: `127.0.0.1:${server.port}` },
    });
    assert.equal(stream.headers.get('content-type').includes('text/event-stream'), true);
    const reader = stream.body.getReader();
    const first = await reader.read();
    assert.match(Buffer.from(first.value).toString('utf8'), /epoch 1/);
    await reader.cancel();
    const rich = tail.body.rich.length ? tail.body : (await post(server.port, { action: 'job', job_id: jobId })).body.job;
    const artifacts = fs.readdirSync(path.join(root, 'jobs', jobId, 'artifacts'));
    assert.equal(artifacts.some(name => name.endsWith('.png')), true);
    assert.equal(rich.rich?.length || (await post(server.port, { action: 'job', job_id: jobId })).body.job.rich.length, 1);
    scripts.procs[1].emit('close', 0, null);
    await new Promise(resolve => setTimeout(resolve, 30));
    const done = await post(server.port, { action: 'job', job_id: jobId });
    assert.equal(done.body.job.state, 'exited');
    const secret = await post(server.port, { action: 'upload', session: 'trainer', local_path: path.join('/home/tester/.config/colab-cli', 'token.json'), remote: '/content/token.json' });
    assert.equal(secret.status, 400);
  } finally {
    colab.close();
    await server.stop();
    fs.rmSync(image, { force: true });
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('training run confirms cost, then creates, uploads, and executes in order', async () => {
  const scripts = scripted([
    { out: '[colab] Session READY.\n' },
    { out: '[colab] Uploaded data\n' },
    { out: 'Installation Complete (via uv)!\n' },
    { out: 'train ok\n' },
  ]);
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-colab-train-'));
  const server = await listen((req, res, url) => colab.handle(req, res, url));
  const colab = createColabOrchestrator({
    token, port: server.port, devOrigins: [], reply, spawn: scripts.spawn, bin: '/opt/colab-test/colab', home: '/home/tester', root: rootDir,
  });
  const script = path.join(rootDir, 'train.py');
  const data = path.join(rootDir, 'data.jsonl');
  fs.writeFileSync(script, 'print("train")\n');
  fs.writeFileSync(data, '{}\n');
  try {
    const started = await post(server.port, {
      action: 'train', session: 'qwen', accelerator: 'T4', confirm_cost: true, timeout: 90,
      uploads: [{ local: data, remote: '/content/data.jsonl' }], packages: ['torch'], script,
    });
    assert.equal(started.status, 200);
    for (let attempt = 0; attempt < 50; attempt += 1) {
      const job = await post(server.port, { action: 'job', job_id: started.body.job.id });
      if (job.body.job.state !== 'running') break;
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    assert.deepEqual(scripts.calls.map(call => call.args[0]), ['new', 'upload', 'install', 'exec']);
    assert.deepEqual(scripts.calls[0].args, ['new', '-s', 'qwen', '--gpu', 'T4']);
    assert.equal(scripts.calls[2].args.includes('torch'), true);
    assert.equal(scripts.calls[3].args.includes('--timeout'), true);
    assert.equal(scripts.calls.every(call => call.options.shell === false), true);
  } finally {
    colab.close();
    await server.stop();
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});
