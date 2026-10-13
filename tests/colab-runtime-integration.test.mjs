/** Integration tests against a fake colab CLI and the real VM-side helper.
 *  Each test reproduces a failure seen on a live training run:
 *  the local CLI can exit 0 or die while the remote process does something else.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createColabOrchestrator } from '../server/colab-orchestrator.mjs';

const token = 'orbit-colab-test-token-orbit-colab';
const python = '/usr/bin/python3';

function reply() {}

function writeFakeColab(dir, vm, statePath) {
  const bin = path.join(dir, 'colab');
  const source = `#!${process.execPath}
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const statePath = ${JSON.stringify(statePath)};
const python = ${JSON.stringify(python)};
function load() { return JSON.parse(fs.readFileSync(statePath, 'utf8')); }
function save(state) { fs.writeFileSync(statePath, JSON.stringify(state)); }
function vmPath(state, remote) {
  if (!remote.startsWith('/')) process.exit(2);
  return path.join(state.vm, remote.slice(1));
}
function rewrite(state, text) {
  return text.split(state.prefix).join(path.join(state.vm, 'content'));
}
const args = process.argv.slice(2);
const cmd = args[0];
const state = load();
state.calls.push({ cmd, args });
if (cmd === 'upload') {
  const dest = vmPath(state, args[4]);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(args[3], dest);
  save(state);
  process.stdout.write('uploaded\\n');
  process.exit(0);
}
if (cmd === 'download') {
  if (state.failDownloads > 0) {
    state.failDownloads -= 1;
    save(state);
    process.stderr.write('killed after 180s\\n');
    process.exit(1);
  }
  fs.copyFileSync(vmPath(state, args[3]), args[4]);
  save(state);
  process.stdout.write('downloaded\\n');
  process.exit(0);
}
if (cmd === 'restart-kernel') {
  state.kernelRestarts += 1;
  save(state);
  process.stdout.write('kernel restarted\\n');
  process.exit(0);
}
if (cmd === 'console') {
  const chunks = [];
  process.stdin.on('data', chunk => chunks.push(chunk));
  process.stdin.on('end', () => {
    const command = Buffer.concat(chunks).toString('utf8').trim();
    state.commands.push(command);
    if (command.includes(' tail ') && state.failTails > 0) {
      state.failTails -= 1;
      const pidFile = findPid(state.vm);
      if (pidFile) {
        const pid = Number(fs.readFileSync(pidFile, 'utf8'));
        try { process.kill(pid, 0); state.aliveDuringDrop = true; } catch { state.aliveDuringDrop = false; }
      }
      save(state);
      process.stderr.write('RuntimeError: Connection was lost\\n');
      process.exit(1);
    }
    save(state);
    const parts = rewrite(state, command).split(/\\s+/).filter(Boolean);
    if (parts[0] !== 'python3') {
      process.stderr.write('unexpected console command\\n');
      process.exit(1);
    }
    const pyArgs = parts.slice(1).map(arg => {
      if (arg.endsWith('.json') && fs.existsSync(arg)) {
        const body = rewrite(load(), fs.readFileSync(arg, 'utf8'));
        const copy = arg + '.local.json';
        fs.writeFileSync(copy, body);
        return copy;
      }
      return arg;
    });
    const result = spawnSync(python, pyArgs, { encoding: 'utf8' });
    if (result.stdout) process.stdout.write(result.stdout);
    if (result.stderr) process.stderr.write(result.stderr);
    process.exit(result.status === null ? 1 : result.status);
  });
} else {
  process.stderr.write('unexpected ' + cmd + '\\n');
  process.exit(1);
}
function findPid(dir) {
  if (!fs.existsSync(dir)) return '';
  for (const name of fs.readdirSync(dir)) {
    const full = path.join(dir, name);
    if (name === 'pid' && fs.statSync(full).isFile()) return full;
    if (fs.statSync(full).isDirectory()) {
      const found = findPid(full);
      if (found) return found;
    }
  }
  return '';
}
`;
  fs.writeFileSync(bin, source, { mode: 0o755 });
  fs.writeFileSync(statePath, JSON.stringify({
    vm, prefix: '/content', calls: [], commands: [], failTails: 0, failDownloads: 0, kernelRestarts: 0, aliveDuringDrop: null,
  }));
  return bin;
}

function harness(options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-colab-int-'));
  const vm = path.join(root, 'vm');
  const home = path.join(root, 'home');
  fs.mkdirSync(vm, { recursive: true });
  fs.mkdirSync(home, { recursive: true });
  const statePath = path.join(root, 'fake-state.json');
  const bin = writeFakeColab(root, vm, statePath);
  const colab = createColabOrchestrator({
    token, port: 4318, devOrigins: [], reply, bin, home, root,
    reconnectDelay: options.reconnectDelay ?? 30,
    chunkBytes: options.chunkBytes || 64 * 1024 * 1024,
  });
  return {
    root, vm, colab, statePath,
    state() { return JSON.parse(fs.readFileSync(statePath, 'utf8')); },
    patch(values) {
      const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
      Object.assign(state, values);
      fs.writeFileSync(statePath, JSON.stringify(state));
    },
  };
}

function stopPids(vm) {
  if (!fs.existsSync(vm)) return;
  const stack = [vm];
  while (stack.length) {
    const dir = stack.pop();
    for (const name of fs.readdirSync(dir)) {
      const full = path.join(dir, name);
      const stat = fs.statSync(full);
      if (stat.isDirectory()) stack.push(full);
      else if (name === 'pid') {
        const pid = Number(fs.readFileSync(full, 'utf8'));
        if (pid) { try { process.kill(pid, 'SIGTERM'); } catch { /* already exited */ } }
      }
    }
  }
}

async function waitJob(colab, id, ready, attempts = 100) {
  let job = null;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    job = (await colab.dispatch({ action: 'job', job_id: id })).job;
    if (ready(job)) return job;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  return job;
}

test('python helper is available for the Colab integration tests', () => {
  const result = spawnSync(python, ['-c', 'import os,sys; print(sys.version)']);
  assert.equal(result.status, 0);
});

test('a failing VM process is the job exit even when every colab CLI call exits 0', { timeout: 20000 }, async () => {
  const box = harness();
  const script = path.join(box.root, 'train.py');
  fs.writeFileSync(script, [
    'import sys',
    'print("ORBIT_PROGRESS {\\"stage\\":\\"train\\",\\"step\\":2,\\"total\\":5,\\"percent\\":40}", flush=True)',
    'print("hello-from-vm", flush=True)',
    'sys.exit(7)',
    '',
  ].join('\n'));
  try {
    const started = await box.colab.dispatch({ action: 'exec', session: 'trainer', file: script, label: 'remote seven' });
    const job = await waitJob(box.colab, started.job.id, item => item.state !== 'running');
    assert.equal(job.state, 'failed', JSON.stringify(job));
    assert.equal(job.exitCode, 7);
    assert.match(job.error, /Remote process exited 7/);
    assert.equal(job.label, 'remote seven');
    assert.equal(job.progress.stage, 'train');
    assert.equal(job.progress.percent, 40);
    assert.match(job.lastLine, /hello-from-vm/);
    assert.equal(typeof job.durationMs, 'number');
    assert.equal(job.durationMs >= 0, true);
    const state = box.state();
    assert.equal(state.calls.length > 0, true);
    assert.equal(state.calls.every(call => call.cmd !== 'exec'), true);
    const tail = await box.colab.dispatch({ action: 'tail', job_id: job.id, after: 0 });
    assert.match(tail.text, /hello-from-vm/);
    const offset = tail.text.indexOf('hello-from-vm');
    const rest = await box.colab.dispatch({ action: 'tail', job_id: job.id, after: offset });
    assert.equal(rest.text.startsWith('hello-from-vm'), true);
    assert.equal(rest.text.includes('ORBIT_PROGRESS'), false);
  } finally {
    stopPids(box.vm);
    box.colab.close();
    fs.rmSync(box.root, { recursive: true, force: true });
  }
});

test('printed traceback text does not override a real zero exit from the VM process', { timeout: 20000 }, async () => {
  const box = harness();
  const script = path.join(box.root, 'train.py');
  fs.writeFileSync(script, [
    'print("Traceback (most recent call last):", flush=True)',
    'print("RuntimeError: printed but not raised", flush=True)',
    '',
  ].join('\n'));
  try {
    const started = await box.colab.dispatch({ action: 'exec', session: 'trainer', file: script, label: 'clean exit' });
    const job = await waitJob(box.colab, started.job.id, item => item.state !== 'running');
    assert.equal(job.exitCode, 0, JSON.stringify(job));
    assert.equal(job.state, 'exited');
    assert.match(job.lastLine, /printed but not raised/);
  } finally {
    stopPids(box.vm);
    box.colab.close();
    fs.rmSync(box.root, { recursive: true, force: true });
  }
});

test('a dropped Colab connection leaves the VM process running and the log resumes from an offset', { timeout: 20000 }, async () => {
  const box = harness();
  box.patch({ failTails: 1 });
  const script = path.join(box.root, 'train.py');
  fs.writeFileSync(script, [
    'import sys, time',
    'print("before-drop", flush=True)',
    'time.sleep(1.2)',
    'print("after-drop", flush=True)',
    'sys.exit(7)',
    '',
  ].join('\n'));
  try {
    const started = await box.colab.dispatch({ action: 'exec', session: 'trainer', file: script, label: 'survive drop' });
    const job = await waitJob(box.colab, started.job.id, item => item.state !== 'running', 80);
    assert.equal(job.exitCode, 7, JSON.stringify({ job, state: box.state() }));
    assert.match(job.error, /Remote process exited 7/);
    assert.equal(box.state().aliveDuringDrop, true);
    const tail = await box.colab.dispatch({ action: 'tail', job_id: job.id, after: 0 });
    assert.match(tail.text, /before-drop/);
    assert.match(tail.text, /after-drop/);
    assert.match(tail.text, /Connection was lost/);
    const offset = tail.text.indexOf('after-drop');
    const rest = await box.colab.dispatch({ action: 'tail', job_id: job.id, after: offset });
    assert.equal(rest.text.startsWith('after-drop'), true);
    assert.equal(rest.text.includes('before-drop'), false);
  } finally {
    stopPids(box.vm);
    box.colab.close();
    fs.rmSync(box.root, { recursive: true, force: true });
  }
});

test('cancel kills the VM process, not only the local CLI', { timeout: 20000 }, async () => {
  const box = harness();
  const script = path.join(box.root, 'train.py');
  fs.writeFileSync(script, [
    'import time',
    'print("still-running", flush=True)',
    'time.sleep(60)',
    '',
  ].join('\n'));
  try {
    const started = await box.colab.dispatch({ action: 'exec', session: 'trainer', file: script, label: 'stop me' });
    const running = await waitJob(box.colab, started.job.id, item => item.remote && /still-running/.test(item.lastLine || ''));
    assert.match(running.lastLine, /still-running/);
    const pid = JSON.parse(fs.readFileSync(path.join(box.root, 'jobs', started.job.id, 'meta.json'), 'utf8')).remotePid;
    assert.equal(pid > 0, true);
    process.kill(pid, 0);
    const cancelled = await box.colab.dispatch({ action: 'cancel', job_id: started.job.id, confirm: true });
    assert.equal(cancelled.job.state, 'cancelled');
    let dead = false;
    for (let attempt = 0; attempt < 40; attempt += 1) {
      try { process.kill(pid, 0); }
      catch { dead = true; break; }
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    assert.equal(dead, true);
    assert.equal(box.state().kernelRestarts >= 1, true);
    assert.equal(box.state().commands.some(command => command.includes(' stop ')), true);
  } finally {
    stopPids(box.vm);
    box.colab.close();
    fs.rmSync(box.root, { recursive: true, force: true });
  }
});

test('a download killed the way the 3-minute timeout was resumes in chunks and matches sha256', { timeout: 20000 }, async () => {
  const box = harness({ chunkBytes: 4 });
  box.patch({ failDownloads: 1 });
  const remote = '/content/model.bin';
  const data = Buffer.from('abcdefgh');
  const dest = path.join(box.vm, 'content', 'model.bin');
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, data);
  try {
    const saved = await box.colab.dispatch({ action: 'download', session: 'trainer', remote });
    assert.equal(saved.bytes, data.length);
    assert.equal(saved.sha256, createHash('sha256').update(data).digest('hex'));
    const file = path.join(box.root, 'downloads', 'trainer', saved.file);
    assert.deepEqual(fs.readFileSync(file), data);
    const downloads = box.state().calls.filter(call => call.cmd === 'download');
    assert.equal(downloads.length >= 2, true);
    assert.equal(downloads.every(call => call.args[3] !== remote), true);
    assert.equal(downloads.every(call => String(call.args[3]).includes('/content/orbit-jobs/slice-')), true);
  } finally {
    stopPids(box.vm);
    box.colab.close();
    fs.rmSync(box.root, { recursive: true, force: true });
  }
});
