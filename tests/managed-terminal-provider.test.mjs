import assert from 'node:assert/strict';
import childProcess, { execFile, spawn } from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readdir, readFile, rm, stat, writeFile, chmod, symlink } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';
import { ManagedTerminalProvider, ManagedTerminalProviderError } from '../server/managed-terminal-provider.mjs';
import { TerminalResourceRegistry, TerminalResourceRegistryError } from '../server/terminal-resource-registry.mjs';

const exec = promisify(execFile);
const tmux = '/usr/bin/tmux';
const format = '#{session_name}|#{session_id}|#{pane_id}|#{pid}|#{pane_pid}|#{@orbit_managed_epoch}|#{@orbit_managed_shell}|#{@orbit_managed_session_epoch}';
const token = /^[a-f0-9]{64}$/;
const providerError = (code) => (error) => error instanceof ManagedTerminalProviderError &&
  error.code === code && error.message === `Managed terminal provider: ${code}`;
const registryError = (code) => (error) => error instanceof TerminalResourceRegistryError &&
  error.code === code && error.message === `Terminal resource registry: ${code}`;

test('attach startup needs no fresh directory or server and rejects destructive lifecycle calls', async t => {
  const f = await fixture(t);
  const { ManagedTerminalIdentityLedger } = await import('../server/managed-terminal-ledger.mjs');
  const ledger = new ManagedTerminalIdentityLedger({ directory: f.root });
  const p = await ManagedTerminalProvider.create({ mode: 'attach', socket: f.socket, tmuxTmpDir: f.root, ledger });
  assert.equal(ledger.loaded, true);
  assert.deepEqual((await readdir(f.root)).sort(), ['identity-ledger.json', 'identity-ledger.json.initialized']);
  await assert.rejects(p.createSession({ sessionName: 'forbidden' }), providerError('unavailable'));
  await assert.rejects(p.closeSession({ sessionName: 'forbidden' }), providerError('unavailable'));
  await p.dispose();
  assert.deepEqual((await readdir(f.root)).sort(), ['identity-ledger.json', 'identity-ledger.json.initialized']);
});

async function fixture(t, label = 'managed') {
  const root = await mkdtemp('/tmp/opencode/orbit-managed-');
  const socket = `${label}-${randomUUID()}`;
  const env = { PATH: '/usr/bin:/bin', HOME: root, XDG_CONFIG_HOME: root,
    TMUX_TMPDIR: root, SHELL: '/bin/bash', LC_ALL: 'C', TERM: 'xterm-256color' };
  const run = (...args) => exec(tmux, ['-L', socket, '-f', '/dev/null', ...args],
    { cwd: root, env, timeout: 5000, maxBuffer: 65536 });
  t.after(async () => {
    try { await run('kill-server'); } catch { /* only this disposable socket */ }
    await rm(root, { recursive: true, force: true });
  });
  return { root, socket, env, run, socketPath: path.join(root, `tmux-${process.getuid()}`, socket) };
}

function provider(f, options = {}) {
  return new ManagedTerminalProvider({ directory: f.root, socket: f.socket, shell: '/bin/bash',
    cwd: f.root, timeoutMs: 1000, maxConcurrent: 8, maxOutputBytes: 4096, ...options });
}

function registry(adapter, providerId = `provider-${randomUUID()}`) {
  return new TerminalResourceRegistry({ ownerId: 'owner', workspaceId: 'workspace', providerId, adapter });
}

async function raw(f, name) {
  const { stdout } = await f.run('display-message', '-p', '-t', `=${name}:0.0`, format);
  const fields = stdout.trim().split('|');
  assert.equal(fields.length, 8, `unexpected real tmux fields: ${stdout}`);
  const [sessionName, sessionId, paneId, serverPid, shellPid, epoch, shell, sessionEpoch] = fields;
  assert.equal(sessionName, name);
  assert.match(sessionId, /^\$\d+$/);
  assert.match(paneId, /^%\d+$/);
  assert.match(serverPid, /^\d+$/);
  assert.match(shellPid, /^\d+$/);
  return { sessionName, sessionId, paneId, serverPid, shellPid, epoch, shell, sessionEpoch };
}

function matchesRaw(issued, observed) {
  assert.equal(issued.sessionName, observed.sessionName);
  assert.equal(issued.sessionId, observed.sessionId);
  assert.equal(issued.paneId, observed.paneId);
  assert.equal(issued.serverEpoch, observed.epoch);
  assert.equal(issued.serverEpoch, observed.sessionEpoch);
  assert.equal(issued.shellInstance, observed.shell);
}

async function exists(filename) {
  try { await stat(filename); return true; } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

async function attachThenDetach(t, f, name) {
  const child = spawn(tmux, ['-L', f.socket, '-f', '/dev/null', '-C', 'attach-session', '-t', `=${name}`],
    { cwd: f.root, env: f.env, stdio: ['pipe', 'pipe', 'pipe'] });
  t.after(() => { if (child.exitCode === null) child.kill(); });
  let output = '';
  let stderr = '';
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  const closed = new Promise((resolve) => child.once('close', resolve));
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => { cleanup(); reject(new Error(`control-mode attach timed out: ${stderr}`)); }, 5000);
      const cleanup = () => { clearTimeout(timer); child.stdout.off('data', onData); child.off('close', onClose); child.off('error', onError); };
      const onData = (chunk) => { output += chunk; if (output.includes('%session-changed ')) { cleanup(); resolve(); } };
      const onClose = (code) => { cleanup(); reject(new Error(`control-mode attach exited ${code}: ${stderr}`)); };
      const onError = (error) => { cleanup(); reject(error); };
      child.stdout.on('data', onData);
      child.once('close', onClose);
      child.once('error', onError);
    });
    assert.notEqual((await f.run('list-clients', '-t', `=${name}`)).stdout.trim(), '');
    await f.run('detach-client', '-s', `=${name}`);
    let timer;
    try {
      await Promise.race([closed, new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('control-mode detach timed out')), 5000);
      })]);
    } finally { clearTimeout(timer); }
    assert.equal((await f.run('list-clients', '-t', `=${name}`)).stdout.trim(), '');
  } finally { if (child.exitCode === null) child.kill(); }
}

test.before(async () => { await exec(tmux, ['-V'], { timeout: 1000 }); });

test('startup refuses non-private, non-fresh and symlinked directories', async t => {
  const f = await fixture(t);
  await chmod(f.root, 0o755);
  await assert.rejects(provider(f).start(), providerError('invalid_request'));
  await chmod(f.root, 0o700);
  await writeFile(path.join(f.root, 'unrelated-owner-data'), 'keep');
  await assert.rejects(provider(f).start(), providerError('conflict'));
  assert.equal(await exists(f.socketPath), false);
  const link = f.root + '-link';
  await symlink(f.root, link);
  t.after(() => rm(link, { force: true }));
  await assert.rejects(provider(f, { directory: link }).start(), providerError('invalid_request'));
});

test('unknown inspection and registration leave the fresh namespace without a tmux server', async (t) => {
  const f = await fixture(t);
  const p = await ManagedTerminalProvider.create({ directory: f.root, socket: f.socket });
  t.after(() => p.dispose());
  assert.equal(p.started, true);
  assert.equal(p.socket, f.socket);
  assert.equal(p.serverEpoch, null);
  assert.equal(await p.inspectExact({ sessionName: 'never-created' }), null);
  await assert.rejects(registry(p).register({ sessionName: 'never-created' }), registryError('unavailable'));
  assert.equal(await exists(f.socketPath), false);
  if (await exists(path.dirname(f.socketPath))) {
    assert.deepEqual(await readdir(path.dirname(f.socketPath)), [], 'tmux may create its empty socket directory');
  }
  assert.ok((await readdir(f.root)).includes('managed-provider.lock'));
});

test('managed sessions link exact frozen identities to independent registry bindings', async (t) => {
  const f = await fixture(t);
  const p = await ManagedTerminalProvider.create({ directory: f.root, socket: f.socket });
  t.after(() => p.dispose());
  const a = await p.createSession({ sessionName: 'alpha' });
  assert.ok(Object.isFrozen(a));
  assert.match(a.serverEpoch, token);
  assert.match(a.shellInstance, token);
  matchesRaw(a, await raw(f, 'alpha'));
  const inspected = await p.inspectExact({ sessionName: 'alpha' });
  assert.deepEqual(Object.keys(inspected).sort(), ['paneId', 'serverEpoch', 'sessionId', 'shellInstance']);
  assert.ok(Object.isFrozen(inspected));
  assert.deepEqual(inspected, { serverEpoch: a.serverEpoch, sessionId: a.sessionId,
    paneId: a.paneId, shellInstance: a.shellInstance });
  const gate = registry(p);
  const first = await gate.register({ sessionName: 'alpha' });
  assert.ok(Object.isFrozen(first));
  assert.equal(await gate.lookup(first), first);
  assert.equal(await gate.lookup(first), first);
  const b = await p.createSession({ sessionName: 'beta' });
  matchesRaw(b, await raw(f, 'beta'));
  const second = await gate.register({ sessionName: 'beta' });
  assert.equal(gate.unregister(first), true);
  assert.equal(await gate.lookup(first), null);
  matchesRaw(a, await raw(f, 'alpha'));
  assert.equal(await gate.lookup(second), second);
  assert.equal(await p.closeSession({ sessionName: 'beta' }), true);
  await assert.rejects(f.run('has-session', '-t', '=beta'), { code: 1 });
  assert.equal(await gate.lookup(second), null);
});

test('real control-mode detach and layout changes preserve the original shell binding', async (t) => {
  const f = await fixture(t);
  const p = await ManagedTerminalProvider.create({ directory: f.root, socket: f.socket });
  t.after(() => p.dispose());
  const original = await p.createSession({ sessionName: 'continuity' });
  const gate = registry(p);
  const binding = await gate.register({ sessionName: 'continuity' });
  const before = await raw(f, 'continuity');
  await attachThenDetach(t, f, 'continuity');
  await f.run('split-window', '-d', '-t', '=continuity:0.0', '/bin/bash');
  await f.run('select-layout', '-t', '=continuity:0', 'even-horizontal');
  await f.run('resize-pane', '-t', before.paneId, '-x', '40');
  const after = await raw(f, 'continuity');
  assert.equal(after.shellPid, before.shellPid);
  matchesRaw(original, after);
  assert.equal(await gate.lookup(binding), binding);
});

test('same-name recreation with a live sentinel permanently invalidates the old binding', async (t) => {
  const f = await fixture(t);
  const p = await ManagedTerminalProvider.create({ directory: f.root, socket: f.socket });
  t.after(() => p.dispose());
  const first = await p.createSession({ sessionName: 'target' });
  await p.createSession({ sessionName: 'sentinel' });
  const gate = registry(p);
  const old = await gate.register({ sessionName: 'target' });
  const before = await raw(f, 'target');
  await f.run('kill-session', '-t', '=target');
  await f.run('has-session', '-t', '=sentinel');
  await assert.rejects(f.run('has-session', '-t', '=target'), { code: 1 });
  assert.equal(await gate.lookup(old), null);
  const next = await p.createSession({ sessionName: 'target' });
  const after = await raw(f, 'target');
  matchesRaw(next, after);
  assert.equal(after.serverPid, before.serverPid);
  assert.notEqual(after.sessionId, before.sessionId);
  assert.notEqual(after.paneId, before.paneId);
  assert.notEqual(next.shellInstance, first.shellInstance);
  assert.equal(await gate.lookup(old), null);
  const current = await gate.register({ sessionName: 'target' });
  assert.equal(await gate.lookup(current), current);
});

test('real server restart rotates epoch even though tmux counters return to zero', async (t) => {
  const f = await fixture(t);
  const p = await ManagedTerminalProvider.create({ directory: f.root, socket: f.socket });
  t.after(() => p.dispose());
  const first = await p.createSession({ sessionName: 'restart' });
  const gate = registry(p);
  const old = await gate.register({ sessionName: 'restart' });
  const before = await raw(f, 'restart');
  assert.equal(before.sessionId, '$0');
  assert.equal(before.paneId, '%0');
  await f.run('kill-server');
  await assert.rejects(f.run('list-sessions'), { code: 1 });
  assert.equal(await gate.lookup(old), null);
  const next = await p.createSession({ sessionName: 'restart' });
  const after = await raw(f, 'restart');
  matchesRaw(next, after);
  assert.equal(after.sessionId, '$0');
  assert.equal(after.paneId, '%0');
  assert.notEqual(after.serverPid, before.serverPid);
  assert.notEqual(next.serverEpoch, first.serverEpoch);
  assert.equal(await gate.lookup(old), null);
  const current = await gate.register({ sessionName: 'restart' });
  assert.equal(await gate.lookup(current), current);
});

test('respawn-pane retains pane ID and options but replaces the shell and cannot be adopted', async (t) => {
  const f = await fixture(t);
  const p = await ManagedTerminalProvider.create({ directory: f.root, socket: f.socket });
  t.after(() => p.dispose());
  const first = await p.createSession({ sessionName: 'respawn' });
  const gate = registry(p);
  const old = await gate.register({ sessionName: 'respawn' });
  const before = await raw(f, 'respawn');
  await f.run('respawn-pane', '-k', '-t', before.paneId, '/bin/bash');
  const after = await raw(f, 'respawn');
  assert.equal(after.paneId, before.paneId);
  assert.notEqual(after.shellPid, before.shellPid);
  assert.equal(after.shell, before.shell, 'tmux options alone are not incarnation proof');
  assert.equal(after.epoch, before.epoch);
  assert.equal(await gate.lookup(old), null);
  await assert.rejects(gate.register({ sessionName: 'respawn' }), registryError('unavailable'));
  await f.run('kill-session', '-t', '=respawn');
  await p.createSession({ sessionName: 'sentinel' });
  const replacement = await p.createSession({ sessionName: 'respawn' });
  matchesRaw(replacement, await raw(f, 'respawn'));
  assert.notEqual(replacement.shellInstance, first.shellInstance);
  const current = await gate.register({ sessionName: 'respawn' });
  assert.equal(await gate.lookup(current), current);
});

test('missing, attacker-replaced shell and missing global epoch each fail closed', async (t) => {
  const f = await fixture(t);
  const p = await ManagedTerminalProvider.create({ directory: f.root, socket: f.socket });
  t.after(() => p.dispose());
  const gate = registry(p);
  for (const [name, args, check] of [
    ['missing-shell', ['set-option', '-u', '-t', '=missing-shell:', '@orbit_managed_shell'], (r) => assert.equal(r.shell, '')],
    ['attacker-shell', ['set-option', '-t', '=attacker-shell:', '@orbit_managed_shell', 'a'.repeat(64)], (r) => assert.equal(r.shell, 'a'.repeat(64))],
    ['missing-epoch', ['set-option', '-gu', '@orbit_managed_epoch'], (r) => assert.equal(r.epoch, '')],
  ]) {
    const issued = await p.createSession({ sessionName: name });
    const binding = await gate.register({ sessionName: name });
    const before = await raw(f, name);
    matchesRaw(issued, before);
    await f.run(...args);
    const after = await raw(f, name);
    assert.equal(after.shellPid, before.shellPid);
    check(after);
    assert.equal(await gate.lookup(binding), null);
  }
});

test('forged metadata on an externally created session cannot enter the trusted ledger', async (t) => {
  const f = await fixture(t);
  const p = await ManagedTerminalProvider.create({ directory: f.root, socket: f.socket });
  t.after(() => p.dispose());
  const managed = await p.createSession({ sessionName: 'owned' });
  await f.run('new-session', '-d', '-s', 'forged', '/bin/bash');
  await f.run('set-option', '-t', '=forged:', '@orbit_managed_shell', 'b'.repeat(64));
  await f.run('set-option', '-t', '=forged:', '@orbit_managed_session_epoch', managed.serverEpoch);
  const observed = await raw(f, 'forged');
  assert.equal(observed.epoch, managed.serverEpoch);
  assert.equal(observed.shell, 'b'.repeat(64));
  assert.equal(observed.sessionEpoch, managed.serverEpoch);
  assert.equal(await p.inspectExact({ sessionName: 'forged' }), null);
  await assert.rejects(registry(p).register({ sessionName: 'forged' }), registryError('unavailable'));
  matchesRaw(managed, await raw(f, 'owned'));
});

test('foreign socket is never adopted or killed; external sessions on owned socket stay unavailable', async (t) => {
  const foreign = await fixture(t, 'foreign');
  await foreign.run('new-session', '-d', '-s', 'foreign', '/bin/bash');
  const foreignBefore = await raw(foreign, 'foreign');
  const f = await fixture(t);
  const p = await ManagedTerminalProvider.create({ directory: f.root, socket: f.socket });
  await f.run('new-session', '-d', '-s', 'outsider', '/bin/bash');
  const outsider = await raw(f, 'outsider');
  await assert.rejects(p.createSession({ sessionName: 'owned' }), providerError('conflict'));
  assert.equal(await p.inspectExact({ sessionName: 'outsider' }), null);
  await p.dispose();
  assert.deepEqual(await raw(f, 'outsider'), outsider, 'disposal cannot kill a server it did not create');
  assert.deepEqual(await raw(foreign, 'foreign'), foreignBefore);
});

test('failed startup does not kill an unmarked server that wins the absent-server race', async t => {
  const f = await fixture(t, 'startup-race');
  const original = childProcess.execFile;
  let injected = false;
  // Instrument a fresh module instance only. All non-racing calls still run
  // real tmux; the independent client wins immediately before new-session.
  const instrumented = (...args) => original(...args);
  instrumented[promisify.custom] = async (file, args, options) => {
    if (!injected && file === tmux && args.includes(f.socket) && args.includes('new-session')) {
      injected = true;
      await f.run('new-session', '-d', '-s', 'foreign-winner', '/bin/bash');
      throw Object.assign(new Error('injected creation failure'), { code: 1, stderr: 'creation failed\n' });
    }
    return exec(file, args, options);
  };
  let p;
  try {
    childProcess.execFile = instrumented;
    syncBuiltinESMExports();
    const isolated = await import('../server/managed-terminal-provider.mjs?startup-race-test');
    p = await isolated.ManagedTerminalProvider.create({ directory: f.root, socket: f.socket });
  } finally {
    childProcess.execFile = original;
    syncBuiltinESMExports();
  }
  t.after(() => p.dispose());
  await assert.rejects(p.createSession({ sessionName: 'ours' }), error => error.code === 'provider_error');
  assert.equal(injected, true);
  await f.run('has-session', '-t', '=foreign-winner');
  await p.dispose();
  await f.run('has-session', '-t', '=foreign-winner');
});

test('namespace lock and cross-registry reservation reject competing owners', async (t) => {
  const f = await fixture(t);
  const p = await ManagedTerminalProvider.create({ directory: f.root, socket: f.socket });
  t.after(() => p.dispose());
  await assert.rejects(provider(f).start(), providerError('conflict'));
  await assert.rejects(provider(f, { socket: `other-${randomUUID()}` }).start(), providerError('conflict'));
  const issued = await p.createSession({ sessionName: 'reservation' });
  matchesRaw(issued, await raw(f, 'reservation'));
  const id = `provider-${randomUUID()}`;
  const a = registry(p, id);
  const b = registry(p, id);
  const first = a.register({ sessionName: 'reservation' });
  await assert.rejects(b.register({ sessionName: 'reservation' }), registryError('conflict'));
  const bound = await first;
  assert.equal(a.unregister(bound), true);
  const second = await b.register({ sessionName: 'reservation' });
  assert.equal(await b.lookup(second), second);
});

async function waitForServerExit(serverPid) {
  const deadline = Date.now() + 5000;
  while (true) {
    try {
      const stat = await readFile(`/proc/${serverPid}/stat`, 'utf8');
      if (stat.slice(stat.lastIndexOf(')') + 2).startsWith('Z ')) return;
    } catch (error) {
      if (error.code === 'ENOENT' || error.code === 'ESRCH') return;
      throw error;
    }
    assert.ok(Date.now() < deadline, `tmux server ${serverPid} did not exit`);
    await delay(10);
  }
}

test('cleanup rechecks ownership in the destructive command after a real server replacement', async t => {
  for (const action of ['closeSession', 'dispose']) {
    const f = await fixture(t, 'replace');
    const original = childProcess.execFile;
    let armed = false, injected = false;
    const instrumented = (...args) => original(...args);
    instrumented[promisify.custom] = async (file, args, options) => {
      if (armed && !injected && file === tmux && args.includes(f.socket) && args.includes('if-shell')) {
        injected = true;
        const before = await raw(f, 'owned');
        await f.run('kill-server');
        // kill-server acknowledges before exit. Complete the injected replacement
        // before testing the destructive command's atomic ownership check.
        await waitForServerExit(before.serverPid);
        await f.run('new-session', '-d', '-s', 'replacement', '/bin/bash');
      }
      return exec(file, args, options);
    };
    let p;
    try {
      childProcess.execFile = instrumented;
      syncBuiltinESMExports();
      const isolated = await import(`../server/managed-terminal-provider.mjs?cleanup-race-${action}`);
      p = await isolated.ManagedTerminalProvider.create({ directory: f.root, socket: f.socket });
    } finally { childProcess.execFile = original; syncBuiltinESMExports(); }
    t.after(() => p.dispose());
    await p.createSession({ sessionName: 'owned' });
    armed = true;
    if (action === 'closeSession') assert.equal(await p.closeSession({ sessionName: 'owned' }), false);
    else await p.dispose();
    assert.equal(injected, true, 'must replace the server between inspection and destructive command');
    await f.run('has-session', '-t', '=replacement');
    await p.dispose();
    await f.run('has-session', '-t', '=replacement');
  }
});

test('dispose removes only owned server and lock, preserving decoy and orbit-persistent', async (t) => {
  const decoy = await fixture(t, 'decoy');
  const persistent = await fixture(t, 'orbit-persistent');
  await decoy.run('new-session', '-d', '-s', 'decoy', '/bin/bash');
  await persistent.run('new-session', '-d', '-s', 'persistent', '/bin/bash');
  const decoyBefore = await raw(decoy, 'decoy');
  const persistentBefore = await raw(persistent, 'persistent');
  const f = await fixture(t);
  assert.throws(() => provider(f, { socket: 'orbit-persistent' }), providerError('invalid_request'));
  const p = await ManagedTerminalProvider.create({ directory: f.root, socket: f.socket });
  await p.createSession({ sessionName: 'owned' });
  assert.equal(await exists(f.socketPath), true);
  assert.equal(await exists(path.join(f.root, 'managed-provider.lock')), true);
  assert.deepEqual(await raw(decoy, 'decoy'), decoyBefore);
  assert.deepEqual(await raw(persistent, 'persistent'), persistentBefore);
  await p.dispose();
  await assert.rejects(f.run('list-sessions'), { code: 1 });
  assert.equal(await exists(path.join(f.root, 'managed-provider.lock')), false);
  assert.deepEqual(await raw(decoy, 'decoy'), decoyBefore);
  assert.deepEqual(await raw(persistent, 'persistent'), persistentBefore);
});

test('already-aborted inspection fails typed without orphaning a tmux client', async (t) => {
  const f = await fixture(t);
  const p = await ManagedTerminalProvider.create({ directory: f.root, socket: f.socket });
  t.after(() => p.dispose());
  const issued = await p.createSession({ sessionName: 'bounded' });
  matchesRaw(issued, await raw(f, 'bounded'));
  const aborted = new AbortController();
  aborted.abort();
  await assert.rejects(p.inspectExact({ sessionName: 'bounded', signal: aborted.signal }),
    (error) => providerError('timeout')(error) || providerError('provider_error')(error));
  assert.equal(aborted.signal.aborted, true);
  matchesRaw(issued, await raw(f, 'bounded'));
  const { stdout } = await exec('/usr/bin/pgrep', ['-af', `tmux.*-L ${f.socket}.*display-message`], { timeout: 1000 }).catch((error) => {
    if (error.code === 1) return { stdout: '' };
    throw error;
  });
  assert.equal(stdout.trim(), '', 'no tmux client subprocess for this socket survives cancellation');
});

test('unresponsive owned server times out inspection without killing the shell or leaving probe clients', async (t) => {
  const f = await fixture(t);
  const p = provider(f, { timeoutMs: 200 });
  t.after(() => p.dispose());
  await p.start();
  const issued = await p.createSession({ sessionName: 'bounded' });
  const before = await raw(f, 'bounded');
  matchesRaw(issued, before);
  // Only this freshly created private fixture server is stopped. Its live PID
  // cannot be recycled while stopped; always resume before any cleanup command.
  process.kill(Number(before.serverPid), 'SIGSTOP');
  const started = performance.now();
  try {
    await assert.rejects(p.inspectExact({ sessionName: 'bounded' }), providerError('timeout'));
    assert.ok(performance.now() - started < 3000, 'inspection must be bounded');
  } finally { process.kill(Number(before.serverPid), 'SIGCONT'); }
  assert.deepEqual(await raw(f, 'bounded'), before);
  assert.equal(await p.inspectExact({ sessionName: 'bounded' }), null, 'timeout permanently invalidates the old binding');
  const { stdout } = await exec('/usr/bin/pgrep', ['-af', `tmux.*-L ${f.socket}.*display-message`], { timeout: 1000 }).catch((error) => {
    if (error.code === 1) return { stdout: '' };
    throw error;
  });
  assert.equal(stdout.trim(), '');
});

test('cross-session aliases and swapped identity tokens cannot resolve another binding', async (t) => {
  const f = await fixture(t);
  const p = await ManagedTerminalProvider.create({ directory: f.root, socket: f.socket });
  t.after(() => p.dispose());
  const a = await p.createSession({ sessionName: 'one' });
  const b = await p.createSession({ sessionName: 'two' });
  matchesRaw(a, await raw(f, 'one'));
  matchesRaw(b, await raw(f, 'two'));
  const gate = registry(p);
  const one = await gate.register({ sessionName: 'one' });
  const two = await gate.register({ sessionName: 'two' });
  assert.equal(await gate.lookup({ ...one, sessionName: 'two' }), null);
  assert.equal(await gate.lookup({ ...one, shellInstance: two.shellInstance }), null);
  assert.equal(await gate.lookup({ ...two, paneId: one.paneId }), null);
  assert.equal(await gate.lookup(one), one);
  assert.equal(await gate.lookup(two), two);
});
