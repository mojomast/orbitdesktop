import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

const repo = path.resolve(fileURLToPath(new URL('..', import.meta.url)));

function freePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const assigned = probe.address().port;
      probe.close(error => error ? reject(error) : resolve(assigned));
    });
  });
}

test('the server process boots and /api/health answers', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'orbit-boot-'));
  const runtime = path.join(root, 'runtime');
  const home = path.join(root, 'home');
  await Promise.all([mkdir(runtime), mkdir(home)]);
  const port = await freePort();
  assert.ok(port >= 1024);
  const child = spawn(process.execPath, ['--experimental-strip-types', 'server/index.mjs'], {
    cwd: repo,
    env: {
      PATH: process.env.PATH,
      HOME: home,
      TMPDIR: os.tmpdir(),
      PORT: String(port),
      ORBIT_TOKEN: `orbit-boot-${process.pid}-token-with-32-characters`,
      ORBIT_RUNTIME_DIR: runtime,
      ORBIT_CWD: root,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let logs = '';
  child.stdout.on('data', chunk => { logs += chunk; });
  child.stderr.on('data', chunk => { logs += chunk; });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = new Promise(resolve => child.once('exit', resolve));
      child.kill('SIGTERM');
      await Promise.race([exited, delay(3000)]);
      if (child.exitCode === null && child.signalCode === null) {
        child.kill('SIGKILL');
        await exited;
      }
    }
    await rm(root, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${port}`;
  let health;
  for (let attempt = 0; attempt < 80; attempt++) {
    if (child.exitCode !== null) throw Error(logs || `Server exited ${child.exitCode} before /api/health`);
    try {
      const response = await fetch(base + '/api/health');
      if (response.ok) {
        health = await response.json();
        break;
      }
    } catch { /* still starting */ }
    await delay(50);
  }
  assert.ok(health, logs || 'Server did not answer /api/health');
  assert.equal(health.service, 'orbit');
  assert.equal(health.host, 'local');
  assert.equal(health.sessions, 0);
  assert.equal(logs.includes('reading \'add\''), false);
});
