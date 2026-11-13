import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { mkdtemp, mkdir, rm, cp, writeFile, symlink } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { createAgentRegistry, builtinAgentDefinitions } from '../server/agent-registry.mjs';
import { configureAgentProviders, providerLabel, providerMark, providerState } from '../server/agent-providers.mjs';

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

function configuredAgents(value) {
  if (!value || typeof value !== 'object') return [];
  const list = Array.isArray(value.agents) ? value.agents
    : Array.isArray(value.providers) ? value.providers
      : Array.isArray(value.configured) ? value.configured
        : [];
  return list.filter(agent => agent && agent.configured === true);
}

test('Orbit boots with zero agents configured and serves the workspace', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'orbit-zero-agents-'));
  const app = path.join(root, 'app');
  const runtime = path.join(root, 'runtime');
  const home = path.join(root, 'home');
  const cwd = path.join(root, 'cwd');
  const bin = path.join(root, 'bin');
  await Promise.all([mkdir(app), mkdir(runtime), mkdir(home), mkdir(cwd), mkdir(bin)]);
  for (const name of ['server', 'src', 'contracts', 'scripts', 'public', 'docs', 'apps']) {
    await cp(path.join(repo, name), path.join(app, name), { recursive: true });
  }
  for (const name of ['index.html', 'package.json', 'package-lock.json', 'tsconfig.json', 'vite.config.js']) {
    await cp(path.join(repo, name), path.join(app, name));
  }
  await symlink(path.join(repo, 'node_modules'), path.join(app, 'node_modules'), 'dir');
  await mkdir(path.join(app, 'dist'));
  await writeFile(path.join(app, 'dist', 'index.html'), '<!doctype html><html><head><title>Orbit</title></head><body><main>Orbit workspace</main></body></html>\n');

  const port = await freePort();
  const token = `orbit-zero-agents-${process.pid}-${'x'.repeat(24)}`;
  const child = spawn(process.execPath, ['--experimental-strip-types', 'server/index.mjs'], {
    cwd: app,
    // No agent credentials or discovery hints. PATH points at an empty directory
    // so a host-installed Pi harness is not discovered either.
    env: {
      PATH: bin,
      HOME: home,
      TMPDIR: os.tmpdir(),
      PORT: String(port),
      ORBIT_TOKEN: token,
      ORBIT_RUNTIME_DIR: runtime,
      ORBIT_CWD: cwd,
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
      await Promise.race([exited, delay(4000)]);
      if (child.exitCode === null && child.signalCode === null) {
        child.kill('SIGKILL');
        await exited;
      }
    }
    await rm(root, { recursive: true, force: true });
  });

  const base = `http://127.0.0.1:${port}`;
  let health;
  for (let attempt = 0; attempt < 160; attempt++) {
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

  const page = await fetch(base + '/');
  assert.equal(page.status, 200);
  assert.match(page.headers.get('content-type') || '', /text\/html/);
  assert.match(await page.text(), /Orbit/);

  // The health response may already carry an agent summary. If a dedicated agents
  // route is present, inspect it too. Both are expected to report the zero state.
  const surfaces = [health];
  const agentsResponse = await fetch(base + '/api/agents', {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (agentsResponse.status !== 404) {
    assert.equal(agentsResponse.status, 200);
    surfaces.push(await agentsResponse.json());
  }
  for (const surface of surfaces) {
    assert.equal(configuredAgents(surface).length, 0);
  }
  if (surfaces.length > 1 || Object.hasOwn(health, 'agents') || Object.hasOwn(health, 'providers')) {
    const text = JSON.stringify(surfaces).toLowerCase();
    assert.match(text, /no-agents-configured|no agents configured|unconfigured|not configured/);
  }

  // The registry contract itself has a clear zero state and never invents Hermes.
  const registry = createAgentRegistry({ builtins: builtinAgentDefinitions({ discovered: {} }), config: [] });
  assert.equal(registry.list().filter(agent => agent.configured).length, 0);
  assert.equal(registry.describe('hermes').state, 'unconfigured');
  assert.equal(registry.summary().state, 'no-agents-configured');
  configureAgentProviders({ builtins: builtinAgentDefinitions({ discovered: {} }), config: [] });
  assert.equal(providerLabel('anything-else'), 'Unconfigured adapter');
  assert.equal(providerMark('anything-else'), '?');
  assert.equal(providerState('anything-else'), 'unconfigured');

  assert.equal(/\n\s+at\s+.*:\d+:\d+/.test(logs), false, logs);
  assert.equal(/UnhandledPromiseRejection|TypeError:|ReferenceError:/.test(logs), false, logs);
  assert.equal(/Hermes is not configured|fall(?:ing)? back to Hermes|default(?:ing)? to Hermes/i.test(logs), false, logs);
});
