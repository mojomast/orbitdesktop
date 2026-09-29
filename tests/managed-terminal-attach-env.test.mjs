import test from 'node:test';
import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { promisify } from 'node:util';
import { mkdtemp, chmod, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';

// The attach-mode provider must run the tmux client with an explicit, credential-
// free environment. It must never inherit HERMES_PROFILES_JSON / HERMES_API_KEY /
// ORBIT_TOKEN from the server process, nor a nested TMUX address.
test('attach-mode tmux client exec environment excludes owner/agent credentials', async (t) => {
  const root = await mkdtemp('/tmp/opencode/attach-env-');
  await chmod(root, 0o700);
  const saved = {};
  for (const key of ['HERMES_PROFILES_JSON', 'HERMES_API_KEY', 'ORBIT_TOKEN', 'TMUX']) saved[key] = process.env[key];
  t.after(async () => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await rm(root, { recursive: true, force: true });
  });
  process.env.HERMES_PROFILES_JSON = 'attach-secret-profile';
  process.env.HERMES_API_KEY = 'attach-secret-key';
  process.env.ORBIT_TOKEN = 'attach-secret-token';
  process.env.TMUX = 'nested-server,1,0';

  const socket = 'attach-env-' + randomUUID().slice(0, 8);
  const original = childProcess.execFile;
  const captured = [];
  const instrumented = (...args) => original(...args);
  instrumented[promisify.custom] = async (file, args, options) => {
    captured.push({ args, env: options?.env ?? {} });
    throw Object.assign(new Error('no server'), { code: 1, stderr: `no server running on /nope/${socket}` });
  };
  let ManagedTerminalProvider;
  try {
    childProcess.execFile = instrumented;
    syncBuiltinESMExports();
    ({ ManagedTerminalProvider } = await import('../server/managed-terminal-provider.mjs?attach-env-test'));
  } finally {
    childProcess.execFile = original;
    syncBuiltinESMExports();
  }
  const ledger = { loaded: true, size: 0, load: async () => ledger, get: () => null, list: () => [], put: async () => {}, remove: async () => {} };
  const options = { mode: 'attach', socket, ledger, tmuxTmpDir: root };
  assert.throws(() => new ManagedTerminalProvider({ ...options, envAllowlist: { HERMES_PROFILES_JSON: 'x' } }),
    (error) => error.code === 'invalid_request', 'attach allowlist must reject credentials');
  const provider = new ManagedTerminalProvider(options);
  await provider.start();
  await provider.observeExact({ sessionName: `pane-${randomUUID()}` }).catch(() => null);
  assert.ok(captured.length >= 1, 'expected a real tmux exec attempt');
  for (const call of captured) {
    for (const key of ['HERMES_PROFILES_JSON', 'HERMES_API_KEY', 'ORBIT_TOKEN', 'TMUX']) {
      assert.equal(Object.hasOwn(call.env, key), false, `${key} must not reach the attach tmux client env`);
    }
    assert.equal(JSON.stringify(call.env).includes('attach-secret'), false, 'no credential value may reach the attach tmux client env');
    assert.equal(call.env.TMUX_TMPDIR, root);
    assert.equal(typeof call.env.PATH, 'string');
  }
});
