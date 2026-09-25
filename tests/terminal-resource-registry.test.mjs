import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';
import { TerminalResourceRegistry, TerminalResourceRegistryError } from '../server/terminal-resource-registry.mjs';

const exec = promisify(execFile);
const sessionName = `pane-${randomUUID()}`;
const identity = (overrides = {}) => ({
  serverEpoch: 's'.repeat(32), sessionId: '$0', paneId: '%0', shellInstance: 'h'.repeat(32), ...overrides,
});
const deferred = () => {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
const registry = (adapter, options = {}) => new TerminalResourceRegistry({
  ownerId: 'owner', workspaceId: 'workspace', providerId: `provider-${randomUUID()}`,
  adapter, ...options,
});
const errorCode = (code) => (error) => error instanceof TerminalResourceRegistryError &&
  error.code === code && error.message === `Terminal resource registry: ${code}`;

test('exact existing resource survives layout moves and detach; foreign and malformed bindings never reach provider', async () => {
  let calls = 0;
  const adapter = { async inspectExact({ sessionName: target }) {
    calls++;
    assert.equal(target, sessionName);
    return identity();
  } };
  const gate = registry(adapter);
  const binding = await gate.register({ sessionName });
  assert.ok(Object.isFrozen(binding));
  assert.match(binding.registryEpoch, /^[a-f0-9]{64}$/);
  assert.match(binding.bindingToken, /^[a-f0-9]{64}$/);
  // Placement is deliberately not an input: moving/splitting/detaching a viewer
  // cannot change the identity of the continuing provider resource.
  // Neither window placement nor client attachment participates in this API.
  assert.equal(await gate.lookup(binding), binding);
  assert.equal(await gate.lookup(binding), binding);
  assert.equal(calls, 3);
  for (const changed of [
    { workspaceId: 'foreign' }, { ownerId: 'foreign' }, { providerId: 'foreign' },
    { registryEpoch: 'f'.repeat(64) }, { bindingToken: 'f'.repeat(64) },
    { sessionName: `pane-${randomUUID()}` }, { shellInstance: 'x'.repeat(32) },
    { paneId: '%9' },
  ]) assert.equal(await gate.lookup({ ...binding, ...changed }), null);
  assert.equal(calls, 3, 'foreign or forged bindings must be rejected before inspection');
  for (const malformed of [
    { ...binding, extra: 'x' }, { ...binding, sessionName: '../foreign' },
    { ...binding, registryEpoch: 'short' },
    Object.defineProperty({ ...binding }, 'sessionName', { get() { throw Error('getter must not run'); } }),
  ]) await assert.rejects(gate.lookup(malformed), errorCode('invalid_request'));
  assert.equal(calls, 3);
  assert.equal(gate.unregister(binding), true);
  assert.equal(await gate.lookup(binding), null);
  assert.equal(calls, 3);
});

test('missing, changed session, pane respawn and server restart invalidate bindings without implicit replacement', async () => {
  let current = null;
  let calls = 0;
  const gate = registry({ async inspectExact() { calls++; return current; } });
  await assert.rejects(gate.register({ sessionName }), errorCode('unavailable'));
  assert.equal(calls, 1);
  current = identity();
  const first = await gate.register({ sessionName });
  current = null;
  assert.equal(await gate.lookup(first), null);
  current = identity();
  assert.equal(await gate.lookup(first), null, 'a missing session cannot silently rebind');
  const recreated = await gate.register({ sessionName });
  assert.notEqual(recreated.bindingToken, first.bindingToken);
  current = identity({ shellInstance: 'n'.repeat(32) });
  assert.equal(await gate.lookup(recreated), null, 'same pane ID with respawned shell is distinct');
  const respawned = await gate.register({ sessionName });
  current = identity({ serverEpoch: 'r'.repeat(32), sessionId: '$0', paneId: '%0', shellInstance: 'n'.repeat(32) });
  assert.equal(await gate.lookup(respawned), null, 'server epoch fences reused tmux counters');
  const restarted = await gate.register({ sessionName });
  gate.invalidate();
  assert.notEqual(gate.registryEpoch, restarted.registryEpoch);
  assert.equal(await gate.lookup(restarted), null);
  const newRegistry = registry({ async inspectExact() { return current; } }, { providerId: restarted.providerId });
  assert.equal(await newRegistry.lookup(restarted), null, 'registry restart has a new epoch');
  assert.equal(newRegistry.unregister(restarted), false);
});

test('concurrent registrations reserve before inspection, including across registrars', async () => {
  const pending = deferred();
  const entered = deferred();
  let calls = 0;
  const adapter = { inspectExact() { calls++; entered.resolve(); return pending.promise; } };
  const providerId = `provider-${randomUUID()}`;
  const a = registry(adapter, { providerId });
  const b = registry(adapter, { providerId });
  const first = a.register({ sessionName });
  await entered.promise;
  await assert.rejects(a.register({ sessionName }), errorCode('conflict'));
  await assert.rejects(b.register({ sessionName }), errorCode('conflict'));
  assert.equal(calls, 1);
  pending.resolve(identity());
  const binding = await first;
  assert.equal(a.revoke(binding), true);
  const replacement = await b.register({ sessionName });
  assert.notEqual(binding.registryEpoch, replacement.registryEpoch);
  assert.equal(b.unregister(replacement), true);
});

test('late lookup and registration cannot undo unregister or invalidate', async () => {
  const queued = [];
  const entered = deferred();
  const gate = registry({ inspectExact() {
    const next = deferred();
    queued.push(next);
    entered.resolve();
    return next.promise;
  } });
  const registration = gate.register({ sessionName });
  await entered.promise;
  gate.invalidate();
  queued.shift().resolve(identity());
  await assert.rejects(registration, errorCode('unavailable'));
  const next = gate.register({ sessionName });
  await Promise.resolve();
  queued.shift().resolve(identity());
  const binding = await next;
  const pendingLookup = gate.lookup(binding);
  await Promise.resolve();
  assert.equal(gate.unregister(binding), true);
  queued.shift().resolve(identity());
  assert.equal(await pendingLookup, null);
  assert.equal(await gate.lookup(binding), null);
  const pendingRegistration = gate.register({ sessionName });
  await Promise.resolve();
  gate.invalidate();
  queued.shift().resolve(identity());
  await assert.rejects(pendingRegistration, errorCode('unavailable'));
});

test('bounded timeout, held capacity, provider failures and malformed identity have fixed categories', async () => {
  const stalled = deferred();
  let observedSignal;
  const gate = registry({ inspectExact({ signal }) { observedSignal = signal; return stalled.promise; } },
    { timeoutMs: 25, maxConcurrent: 1 });
  await assert.rejects(gate.register({ sessionName }), errorCode('timeout'));
  assert.equal(observedSignal.aborted, true);
  await assert.rejects(gate.register({ sessionName }), errorCode('busy'));
  stalled.resolve(identity());
  // Let the ignored-abort adapter settle and release its capacity slot.
  await new Promise((resolve) => setImmediate(resolve));
  const broken = registry({ inspectExact() { throw Error('private provider detail'); } });
  await assert.rejects(broken.register({ sessionName }), errorCode('provider_error'));
  const malformed = registry({ inspectExact() { return { ...identity(), shellInstance: 'pid-42' }; } });
  await assert.rejects(malformed.register({ sessionName }), errorCode('provider_error'));
  for (const options of [{ timeoutMs: 5001 }, { maxConcurrent: 17 }, { timeoutMs: 0 }]) {
    assert.throws(() => registry({ inspectExact() {} }, options), errorCode('invalid_request'));
  }
});

test('real private tmux remains unavailable without trusted incarnation tokens; missing lookup never creates', async (t) => {
  try { await exec('/usr/bin/tmux', ['-V'], { timeout: 1000 }); } catch { t.skip('tmux unavailable'); return; }
  const root = await mkdtemp('/tmp/opencode/orbit-terminal-registry-');
  const socket = `orbit-registry-${randomUUID()}`;
  const env = { PATH: '/usr/bin:/bin', HOME: root, XDG_CONFIG_HOME: root, TMUX_TMPDIR: root,
    SHELL: '/bin/bash', LC_ALL: 'C', TERM: 'xterm-256color' };
  const run = (...args) => exec('/usr/bin/tmux', ['-L', socket, '-f', '/dev/null', ...args],
    { cwd: root, env, timeout: 2000, maxBuffer: 4096 });
  t.after(async () => {
    try { await run('kill-server'); } catch { /* this private socket may already be gone */ }
    await rm(root, { recursive: true, force: true });
  });
  let probes = 0;
  const gate = registry({ async inspectExact({ sessionName: target }) {
    probes++;
    try {
      // This side-effect-free probe is deliberately insufficient: tmux's PID,
      // timestamps and local numeric IDs are not server/shell lifetime tokens.
      await run('display-message', '-p', '-t', `=${target}:0.0`, '#{session_name}|#{session_id}|#{pane_id}|#{pid}');
    } catch { /* absent target is unavailable */ }
    return null;
  } });
  await assert.rejects(gate.register({ sessionName }), errorCode('unavailable'));
  assert.equal(probes, 1);
  const socketDir = path.join(root, `tmux-${process.getuid()}`);
  assert.deepEqual(await readdir(socketDir), [], 'no missing lookup can create a server or shell');
  await run('new-session', '-d', '-s', sessionName, '/bin/bash --noprofile --norc');
  await assert.rejects(gate.register({ sessionName }), errorCode('unavailable'));
  await run('has-session', '-t', `=${sessionName}`);
  assert.equal(probes, 2);
});
