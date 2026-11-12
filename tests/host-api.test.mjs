import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHostAudit } from '../server/host-audit.mjs';
import { createHostApi } from '../server/host-api.mjs';
import { createHostRecipes, BUNDLEBEES_WORKER_IMAGE } from '../server/host-recipes.mjs';

const SECRET_SENTINEL = 'ORBIT-TEST-PRIVATE-SENTINEL';
const CONFIG_SENTINEL = 'Host orbit-test-config-sentinel';
const TAILCAT_SENTINEL = 'tcABCDEFGHIJKLMNOPQRST';

function tempRuntime() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-host-api-'));
  return { root, cleanup() { fs.rmSync(root, { recursive: true, force: true }); } };
}

function host(overrides = {}) {
  return {
    id: 'build-01',
    label: 'Build box',
    address: '203.0.113.10',
    port: 22,
    user: 'orbit',
    tags: ['eu'],
    roles: ['worker', 'infra'],
    transport: {
      kind: 'direct',
      jumpHostId: null,
      tailcatAddrRef: 'ssh/tailcat/build-01',
      tailcatAddr: TAILCAT_SENTINEL,
      cloudflareHostname: null,
    },
    auth: { kind: 'orbit-key', keyId: 'orbit-default', privateKey: SECRET_SENTINEL, sshConfig: CONFIG_SENTINEL },
    hostKey: { fingerprints: ['SHA256:abc123'], pinnedAt: '2026-11-12T00:00:00Z', verifiedBy: 'bootstrap-fingerprint' },
    privilege: { sudo: 'scoped', docker: 'group', forcedCommand: false, terminal: false },
    permissions: { setup: 'deploy', pi: 'none', opencode: 'read', hermes: 'admin', bundlebees: 'deploy' },
    docker: { context: 'orbit-build-01' },
    status: { state: 'verified', lastSeen: '2026-11-12T00:00:00Z' },
    privateKey: SECRET_SENTINEL,
    sshConfig: CONFIG_SENTINEL,
    ...overrides,
  };
}

function makeHosts(records) {
  const map = new Map(records.map(record => [record.id, record]));
  return {
    map,
    async get(id) { return map.get(id) || null; },
    async list() { return [...map.values()]; },
    async update(id, patch) {
      const current = map.get(id);
      if (current) map.set(id, { ...current, ...patch });
      return map.get(id);
    },
  };
}

function makeExec(handler) {
  const calls = [];
  return {
    calls,
    async exec(hostId, argv, options) {
      calls.push({ hostId, argv, options });
      if (handler) return handler({ hostId, argv, options, calls });
      return { code: 0, stdout: '', stderr: '', durationMs: 1 };
    },
  };
}

function setup({ hosts = [host()], approve = true, exec = makeExec(), ...options } = {}) {
  const box = tempRuntime();
  const audit = createHostAudit({ runtimeDir: box.root, now: () => Date.parse('2026-11-12T00:00:00.000Z') });
  const approvals = {
    calls: [],
    approve,
    async request(input) {
      this.calls.push(input);
      return { id: `approval-${this.calls.length}`, approved: this.approve };
    },
  };
  const sshHosts = options.sshHosts || makeHosts(hosts);
  const api = createHostApi({
    sshHosts,
    audit,
    approvals,
    exec: exec.exec,
    now: () => Date.parse('2026-11-12T00:00:00.000Z'),
    ...options,
  });
  return { box, audit, approvals, sshHosts, exec, api, cleanup() { box.cleanup(); } };
}

test('permission matrix: none, read, deploy and admin are enforced per agent and host', async () => {
  const ctx = setup();
  try {
    await assert.rejects(ctx.api.hosts.run('build-01', ['uptime'], { agent: 'pi' }), error => error.code === 'permission_denied');
    assert.equal(ctx.exec.calls.length, 0);

    const read = await ctx.api.hosts.run('build-01', ['uptime'], { agent: 'opencode' });
    assert.equal(read.code, 0);
    await assert.rejects(
      ctx.api.hosts.run('build-01', ['docker', 'compose', '-p', 'orbit-worker', 'up', '-d'], { agent: 'opencode' }),
      error => error.code === 'permission_denied',
    );

    const deployed = await ctx.api.hosts.run('build-01', ['docker', 'compose', '-p', 'orbit-worker', 'up', '-d'], { agent: 'setup' });
    assert.equal(deployed.code, 0);
    await assert.rejects(
      ctx.api.hosts.run('build-01', ['rm', '-rf', '/opt/orbit/worker'], { agent: 'setup' }),
      error => error.code === 'permission_denied',
    );

    const admin = await ctx.api.hosts.run('build-01', ['id'], { agent: 'hermes' });
    assert.equal(admin.code, 0);
    assert.equal(ctx.exec.calls.length, 3);
  } finally {
    ctx.cleanup();
  }
});

test('defaults give the setup agent deploy and every other agent none', async () => {
  const ctx = setup({ hosts: [host({ permissions: undefined })] });
  try {
    const listed = await ctx.api.hosts.list({ agent: 'setup' });
    assert.equal(listed.hosts[0].permission, 'deploy');
    const other = await ctx.api.hosts.list({ agent: 'hermes' });
    assert.equal(other.hosts[0].permission, 'none');
    await assert.rejects(ctx.api.hosts.run('build-01', ['uptime'], { agent: 'hermes' }), error => error.code === 'permission_denied');
    await ctx.api.hosts.run('build-01', ['uptime'], { agent: 'setup' });
  } finally {
    ctx.cleanup();
  }
});

test('an injected permissions resolver can override host permissions', async () => {
  const ctx = setup({
    permissions: async ({ agent, hostId }) => (agent === 'pi' && hostId === 'build-01' ? 'read' : 'none'),
  });
  try {
    await ctx.api.hosts.run('build-01', ['uptime'], { agent: 'pi' });
    await assert.rejects(ctx.api.hosts.run('build-01', ['df'], { agent: 'hermes' }), error => error.code === 'permission_denied');
  } finally {
    ctx.cleanup();
  }
});

test('destructive argv pauses for an approval card with exact host, agent and argv and is refused when unapproved', async () => {
  const ctx = setup({ approve: false });
  try {
    await assert.rejects(
      ctx.api.hosts.run('build-01', ['rm', '-rf', '/opt/orbit/worker'], { agent: 'hermes' }),
      error => error.code === 'approval_refused',
    );
    assert.equal(ctx.exec.calls.length, 0);
    assert.equal(ctx.approvals.calls.length, 1);
    assert.equal(ctx.approvals.calls[0].hostId, 'build-01');
    assert.equal(ctx.approvals.calls[0].host, 'Build box');
    assert.equal(ctx.approvals.calls[0].agent, 'hermes');
    assert.deepEqual(ctx.approvals.calls[0].argv, ['rm', '-rf', '/opt/orbit/worker']);
    assert.equal(ctx.approvals.calls[0].reason, 'destructive');

    const audited = ctx.audit.read('build-01');
    assert.equal(audited.entries.at(-1).status, 'refused');
    assert.equal(audited.entries.at(-1).approvalId, 'approval-1');
  } finally {
    ctx.cleanup();
  }
});

test('approved destructive argv runs and the approval id reaches the audit log', async () => {
  const ctx = setup({ approve: true });
  try {
    const result = await ctx.api.hosts.run('build-01', ['docker', 'system', 'prune', '-af'], { agent: 'hermes' });
    assert.equal(result.approvalId, 'approval-1');
    assert.equal(ctx.exec.calls.length, 1);
    const read = ctx.audit.read('build-01');
    assert.equal(read.valid, true);
    assert.equal(read.entries.at(-1).approvalId, 'approval-1');
    assert.deepEqual(read.entries.at(-1).argv, ['docker', 'system', 'prune', '-af']);
  } finally {
    ctx.cleanup();
  }
});

test('key-changed and revoked hosts refuse every action before exec', async () => {
  for (const state of ['key-changed', 'revoked']) {
    const ctx = setup({ hosts: [host({ status: { state, lastSeen: '2026-11-12T00:00:00Z' } })] });
    try {
      await assert.rejects(ctx.api.hosts.run('build-01', ['uptime'], { agent: 'hermes' }), error => error.code === (state === 'key-changed' ? 'host_key_changed' : 'host_revoked'));
      await assert.rejects(ctx.api.hosts.put('build-01', '/opt/orbit/x', 'x', { agent: 'hermes' }), error => error.code === (state === 'key-changed' ? 'host_key_changed' : 'host_revoked'));
      await assert.rejects(ctx.api.hosts.deploy('build-01', 'bundlebees-worker', { action: 'install', agent: 'setup' }), error => error.code === (state === 'key-changed' ? 'host_key_changed' : 'host_revoked'));
      assert.equal(ctx.exec.calls.length, 0);
    } finally {
      ctx.cleanup();
    }
  }
});

test('agent-facing host views and results never contain private keys, ssh config text or tailcat addresses', async () => {
  const ctx = setup();
  try {
    const listed = JSON.stringify(await ctx.api.hosts.list({ agent: 'hermes' }));
    assert.equal(listed.includes(SECRET_SENTINEL), false);
    assert.equal(listed.includes(CONFIG_SENTINEL), false);
    assert.equal(listed.includes(TAILCAT_SENTINEL), false);
    assert.equal(listed.includes('ssh/tailcat/build-01'), false);
    assert.equal(listed.includes('privateKey'), false);
    assert.equal(listed.includes('sshConfig'), false);

    const result = JSON.stringify(await ctx.api.hosts.run('build-01', ['uptime'], { agent: 'hermes' }));
    assert.equal(result.includes(SECRET_SENTINEL), false);
    assert.equal(result.includes(TAILCAT_SENTINEL), false);
  } finally {
    ctx.cleanup();
  }
});

test('deploy-level put is limited to /opt/orbit and admin writes elsewhere require approval', async () => {
  const written = [];
  const ctx = setup({
    approve: false,
    sshHosts: {
      ...makeHosts([host()]),
      async put(hostId, file, content, options) { written.push({ hostId, file, content, options }); return { bytes: content.length }; },
    },
  });
  try {
    const ok = await ctx.api.hosts.put('build-01', '/opt/orbit/worker/compose.yaml', 'services: {}', { agent: 'setup', mode: 0o600 });
    assert.equal(ok.path, '/opt/orbit/worker/compose.yaml');
    assert.equal(written.length, 1);
    assert.equal(written[0].options.mode, 0o600);
    await assert.rejects(ctx.api.hosts.put('build-01', '/etc/passwd', 'x', { agent: 'setup' }), error => error.code === 'permission_denied');
    await assert.rejects(ctx.api.hosts.put('build-01', '/etc/passwd', 'x', { agent: 'hermes' }), error => error.code === 'approval_refused');

    const audited = ctx.audit.read('build-01');
    assert.equal(audited.valid, true);
    assert.equal(JSON.stringify(audited.entries).includes('services: {}'), false);
  } finally {
    ctx.cleanup();
  }
});

test('unknown hosts fail cleanly', async () => {
  const ctx = setup();
  try {
    await assert.rejects(ctx.api.hosts.run('missing', ['uptime'], { agent: 'hermes' }), error => error.code === 'not_found');
    await assert.rejects(ctx.api.hosts.deploy('missing', 'bundlebees-worker', { action: 'install' }), error => error.code === 'not_found');
  } finally {
    ctx.cleanup();
  }
});

test('forAgent binds the caller for every operation', async () => {
  const ctx = setup();
  try {
    const pi = ctx.api.forAgent('pi');
    await assert.rejects(pi.hosts.run('build-01', ['uptime']), error => error.code === 'permission_denied');
    const setupAgent = ctx.api.forAgent('setup');
    await setupAgent.hosts.run('build-01', ['docker', 'ps']);
  } finally {
    ctx.cleanup();
  }
});

function fakeRecipePlatform({ now = '2026-11-12T00:00:00Z' } = {}) {
  return ({ argv }) => {
    const command = argv.slice(0, 4).join(' ');
    if (argv[0] === 'uname') return { code: 0, stdout: 'x86_64\n', stderr: '', durationMs: 1 };
    if (argv[0] === 'docker' && argv[1] === '--version') return { code: 0, stdout: 'Docker version 27.1.1, build deadbeef\n', stderr: '', durationMs: 1 };
    if (argv[0] === 'df') return { code: 0, stdout: 'Filesystem 1024-blocks Used Available Capacity Mounted on\n/dev/vda1 10000000 1000000 9000000 10% /\n', stderr: '', durationMs: 1 };
    if (argv[0] === 'date') return { code: 0, stdout: `${Math.floor(Date.parse(now) / 1000)}\n`, stderr: '', durationMs: 1 };
    if (argv[0] === 'test') return { code: 1, stdout: '', stderr: '', durationMs: 1 };
    if (command.includes('compose')) return { code: 0, stdout: 'ok\n', stderr: '', durationMs: 1 };
    return { code: 0, stdout: '', stderr: '', durationMs: 1 };
  };
}

test('bundlebees-worker install preflights, issues a pairing code and writes compose/.env without the SSH key', async () => {
  const calls = [];
  const written = [];
  let pairingRequests = 0;
  const recipes = createHostRecipes({
    dockerMode: 'context',
    now: () => Date.parse('2026-11-12T00:00:00Z'),
    run: async (hostId, argv, options) => {
      calls.push({ hostId, argv, options });
      return fakeRecipePlatform()({ argv });
    },
    put: async (hostId, file, content, options) => {
      written.push({ hostId, file, content, options });
      return { bytes: content.length };
    },
    issuePairingCode: async input => {
      pairingRequests += 1;
      assert.equal(input.hostId, 'build-01');
      return 'PAIR-CODE-SENTINEL';
    },
    waitForPairing: async () => ({ paired: true }),
    revokeWorkerToken: async () => ({ revoked: true }),
  });

  const result = await recipes.deploy('build-01', 'bundlebees-worker', { action: 'install' });
  assert.equal(result.action, 'install');
  assert.equal(result.paired, true);
  assert.equal(pairingRequests, 1);
  assert.ok(calls.some(call => call.argv.join(' ').includes('uname')));
  assert.ok(calls.some(call => call.argv.join(' ').includes('docker --version')));
  assert.ok(calls.some(call => call.argv.join(' ').includes('df -Pk /')));
  assert.ok(calls.some(call => call.argv.join(' ').includes('date -u +%s')));
  assert.ok(calls.some(call => call.argv.join(' ') === 'docker --context orbit-build-01 compose -p orbit-worker pull'));
  assert.ok(calls.some(call => call.argv.join(' ') === 'docker --context orbit-build-01 compose -p orbit-worker up -d'));

  const compose = written.find(item => item.file === '/opt/orbit/worker/compose.yaml');
  const env = written.find(item => item.file === '/opt/orbit/worker/.env');
  assert.ok(compose);
  assert.ok(env);
  assert.ok(compose.content.includes(BUNDLEBEES_WORKER_IMAGE));
  assert.ok(env.content.includes('PAIR-CODE-SENTINEL'));
  assert.equal(env.content.includes(SECRET_SENTINEL), false);
  assert.equal(env.options.mode, 0o600);
  assert.equal(result.pairingCode, undefined);
  assert.equal(JSON.stringify(result).includes('PAIR-CODE-SENTINEL'), false);
});

test('bundlebees-worker upgrade pulls a pinned image and re-runs without issuing a new pairing code', async () => {
  const calls = [];
  let pairingRequests = 0;
  const recipes = createHostRecipes({
    dockerMode: 'context',
    now: () => Date.parse('2026-11-12T00:00:00Z'),
    run: async (hostId, argv) => { calls.push(argv); return fakeRecipePlatform()({ argv }); },
    put: async () => ({ bytes: 1 }),
    issuePairingCode: async () => { pairingRequests += 1; return 'PAIR'; },
    waitForPairing: async () => ({ paired: true }),
    revokeWorkerToken: async () => ({ revoked: true }),
  });
  const result = await recipes.deploy('build-01', 'bundlebees-worker', { action: 'upgrade' });
  assert.equal(result.action, 'upgrade');
  assert.equal(pairingRequests, 0);
  assert.ok(calls.some(argv => argv.join(' ') === 'docker --context orbit-build-01 compose -p orbit-worker pull'));
  assert.ok(calls.some(argv => argv.join(' ') === 'docker --context orbit-build-01 compose -p orbit-worker up -d'));
});

test('bundlebees-worker remove brings compose down, deletes the directory and revokes the worker token', async () => {
  const calls = [];
  let revoked = 0;
  const recipes = createHostRecipes({
    dockerMode: 'context',
    now: () => Date.parse('2026-11-12T00:00:00Z'),
    run: async (hostId, argv) => { calls.push(argv); return fakeRecipePlatform()({ argv }); },
    put: async () => ({ bytes: 1 }),
    issuePairingCode: async () => 'PAIR',
    waitForPairing: async () => ({ paired: true }),
    revokeWorkerToken: async input => { revoked += 1; assert.equal(input.hostId, 'build-01'); return { revoked: true }; },
  });
  const result = await recipes.deploy('build-01', 'bundlebees-worker', { action: 'remove' });
  assert.equal(result.action, 'remove');
  assert.equal(revoked, 1);
  assert.ok(calls.some(argv => argv.join(' ') === 'docker --context orbit-build-01 compose -p orbit-worker down'));
  assert.ok(calls.some(argv => argv.join(' ') === 'rm -rf /opt/orbit/worker'));
});

test('bundlebees-worker preflight fails cleanly on an unsupported architecture or old Docker', async () => {
  const recipes = createHostRecipes({
    dockerMode: 'context',
    run: async (hostId, argv) => {
      if (argv[0] === 'uname') return { code: 0, stdout: 'sparc64\n', stderr: '', durationMs: 1 };
      return { code: 0, stdout: '', stderr: '', durationMs: 1 };
    },
    put: async () => ({ bytes: 1 }),
    issuePairingCode: async () => 'PAIR',
    waitForPairing: async () => ({ paired: true }),
    revokeWorkerToken: async () => ({ revoked: true }),
  });
  await assert.rejects(recipes.deploy('build-01', 'bundlebees-worker', { action: 'install' }), error => error.code === 'preflight_failed');

  const old = createHostRecipes({
    dockerMode: 'context',
    run: async (hostId, argv) => {
      if (argv[0] === 'uname') return { code: 0, stdout: 'x86_64\n', stderr: '', durationMs: 1 };
      if (argv[0] === 'docker' && argv[1] === '--version') return { code: 0, stdout: 'Docker version 18.09.0, build x\n', stderr: '', durationMs: 1 };
      return { code: 0, stdout: '', stderr: '', durationMs: 1 };
    },
    put: async () => ({ bytes: 1 }),
    issuePairingCode: async () => 'PAIR',
    waitForPairing: async () => ({ paired: true }),
    revokeWorkerToken: async () => ({ revoked: true }),
  });
  await assert.rejects(old.deploy('build-01', 'bundlebees-worker', { action: 'install' }), error => error.code === 'preflight_failed');
});

test('hosts.deploy routes through the deploy permission and the injected recipe runner', async () => {
  const deployed = [];
  const ctx = setup({
    recipes: {
      async deploy(hostId, recipeId, params) {
        deployed.push({ hostId, recipeId, params });
        return { recipeId, action: params.action, paired: true };
      },
    },
  });
  try {
    await assert.rejects(ctx.api.hosts.deploy('build-01', 'bundlebees-worker', { action: 'install', agent: 'opencode' }), error => error.code === 'permission_denied');
    const result = await ctx.api.hosts.deploy('build-01', 'bundlebees-worker', { action: 'install', agent: 'setup' });
    assert.equal(result.paired, true);
    assert.equal(deployed.length, 1);
    assert.equal(deployed[0].hostId, 'build-01');
  } finally {
    ctx.cleanup();
  }
});

test('hosts.deploy with the real recipe audits install commands and refuses remove without approval', async () => {
  const auditRoot = tempRuntime();
  const audit = createHostAudit({ runtimeDir: auditRoot.root, now: () => Date.parse('2026-11-12T00:00:00Z') });
  const exec = makeExec(fakeRecipePlatform());
  const approvals = { calls: [], approve: false, async request(input) { this.calls.push(input); return { id: 'ap-1', approved: false }; } };
  const api = createHostApi({
    sshHosts: makeHosts([host()]),
    audit,
    approvals,
    exec: exec.exec,
    now: () => Date.parse('2026-11-12T00:00:00Z'),
    dockerMode: 'context',
    issuePairingCode: async () => 'PAIR',
    waitForPairing: async () => ({ paired: true }),
    revokeWorkerToken: async () => ({ revoked: true }),
  });
  try {
    const installed = await api.hosts.deploy('build-01', 'bundlebees-worker', { action: 'install', agent: 'setup' });
    assert.equal(installed.action, 'install');
    const read = audit.read('build-01');
    assert.equal(read.valid, true);
    assert.ok(read.entries.some(item => item.argv.includes('compose')));

    await assert.rejects(
      api.hosts.deploy('build-01', 'bundlebees-worker', { action: 'remove', agent: 'setup' }),
      error => error.code === 'approval_refused',
    );
    assert.ok(approvals.calls.some(input => input.argv.join(' ').includes('rm -rf /opt/orbit/worker')));
  } finally {
    auditRoot.cleanup();
  }
});

test('argv is validated and never shell-interpolated', async () => {
  const ctx = setup();
  try {
    for (const argv of [null, 'rm -rf /', ['uptime', 42], [], ['uptime', 'a\u0000b']]) {
      await assert.rejects(ctx.api.hosts.run('build-01', argv, { agent: 'hermes' }), error => error.code === 'invalid_request');
    }
    assert.equal(ctx.exec.calls.length, 0);
    await ctx.api.hosts.run('build-01', ['printf', 'a; rm -rf /'], { agent: 'hermes' });
    assert.deepEqual(ctx.exec.calls.at(-1).argv, ['printf', 'a; rm -rf /']);
  } finally {
    ctx.cleanup();
  }
});

test('writes outside /opt/orbit and sudo outside the allow-list require owner approval', async () => {
  const ctx = setup({ approve: false });
  try {
    for (const argv of [
      ['install', '-m', '600', '/tmp/unit', '/etc/systemd/system/orbit.service'],
      ['touch', '/etc/orbit-marker'],
      ['sudo', 'useradd', 'someone'],
    ]) {
      await assert.rejects(ctx.api.hosts.run('build-01', argv, { agent: 'hermes' }), error => error.code === 'approval_refused');
    }
    assert.equal(ctx.exec.calls.length, 0);
    assert.equal(ctx.approvals.calls.length, 3);
    assert.equal(ctx.approvals.calls[2].reason, 'destructive');
  } finally {
    ctx.cleanup();
  }
});
