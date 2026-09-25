import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import test from 'node:test';

const exec = promisify(execFile);
const tmuxPath = '/usr/bin/tmux';
const paneId = 'b45066f1-5751-4ab9-a692-68ff4ef3c481';
const sessionName = `pane-${paneId}`;
const format = '#{session_name}|#{session_id}|#{pane_id}|#{session_created}|#{pid}';

// A disposable provider fixture, not an Orbit resource broker or a production API.
async function privateTmux(t) {
  const root = await mkdtemp(path.join('/tmp/opencode/', 'orbit-resource-identity-'));
  const socket = `orbit-identity-${randomUUID()}`;
  const env = {
    PATH: '/usr/bin:/bin',
    HOME: root,
    XDG_CONFIG_HOME: root,
    TMUX_TMPDIR: root,
    SHELL: '/bin/bash',
    LC_ALL: 'C',
    TERM: 'xterm-256color',
  };
  const run = async (...args) => exec(tmuxPath, ['-L', socket, '-f', '/dev/null', ...args], {
    cwd: root,
    env,
    timeout: 5000,
  });
  const attach = () => spawn(tmuxPath, ['-L', socket, '-f', '/dev/null', '-C', 'attach-session', '-t', `=${sessionName}`], {
    cwd: root,
    env,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  t.after(async () => {
    try { await run('kill-server'); } catch { /* already stopped */ }
    await rm(root, { recursive: true, force: true });
  });
  return { root, socket, run, attach };
}

function parseIdentity(text, workspaceId, socket) {
  const fields = text.trim().split('|');
  assert.equal(fields.length, 5, `unexpected tmux identity format: ${text}`);
  const [sessionName, sessionId, tmuxPaneId, sessionCreated, serverPid] = fields;
  assert.match(sessionId, /^\$\d+$/);
  assert.match(tmuxPaneId, /^%\d+$/);
  for (const value of [sessionCreated, serverPid]) assert.match(value, /^\d+$/);
  return { workspaceId, socket, sessionName, sessionId, tmuxPaneId, sessionCreated, serverPid };
}

// Side-effect-free lookup: no new-session, attach-session, shell, or PTY creation.
// The caller must supply a trusted workspace and socket binding; neither is inferred
// from the pane ID. A missing target yields null, never a new shell.
async function lookup({ run, root, socket }, trustedWorkspaceId, request) {
  if (request.workspaceId !== trustedWorkspaceId || request.socket !== socket ||
      typeof request.paneId !== 'string' || !/^[a-f0-9-]{36}$/.test(request.paneId)) return null;
  const name = `pane-${request.paneId}`;
  try {
    const { stdout } = await run('display-message', '-p', '-t', `=${name}:0.0`, format);
    // With another session alive, tmux can succeed but expand an absent
    // target's session/pane formats to empty strings instead of exiting 1.
    const [reportedName, reportedSessionId, reportedPaneId] = stdout.trim().split('|');
    if (reportedName === '' && reportedSessionId === '' && reportedPaneId === '') return null;
    const identity = parseIdentity(stdout, trustedWorkspaceId, socket);
    return identity.sessionName === name ? identity : null;
  } catch (error) {
    // Only tmux's specific absent-target/server diagnostics mean "missing";
    // a permission, transport, command, or timeout error is not a normal miss.
    const socketPath = path.join(root, `tmux-${process.getuid()}`, socket);
    const missingSocket = `error connecting to ${socketPath} (No such file or directory)\n`;
    if (error.code === 1 && typeof error.stderr === 'string' &&
        (error.stderr === `no server running on ${socketPath}\n` ||
         error.stderr === missingSocket ||
         error.stderr === `can't find session: ${name}\n`)) return null;
    throw error;
  }
}

async function attachThenDetach(t, fixture) {
  const client = fixture.attach();
  t.after(() => { if (client.exitCode === null) client.kill(); });
  let output = '';
  let errors = '';
  client.stderr.on('data', (chunk) => { errors += chunk; });
  const closed = new Promise((resolve) => client.once('close', resolve));
  try {
    // Control mode emits a session-changed notification after attaching. This
    // is event-driven rather than sleeping and hoping the client has started.
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error(`tmux control client did not attach: ${output} ${errors}`)), 5000);
      timeout.unref();
      const cleanup = () => {
        clearTimeout(timeout);
        client.stdout.off('data', onData);
        client.off('close', onClose);
        client.off('error', onError);
      };
      const onData = (chunk) => {
        output += chunk;
        if (output.includes('%session-changed ')) { cleanup(); resolve(); }
      };
      const onClose = (code) => { cleanup(); reject(new Error(`tmux client exited ${code}: ${output} ${errors}`)); };
      const onError = (error) => { cleanup(); reject(error); };
      client.stdout.on('data', onData);
      client.once('close', onClose);
      client.once('error', onError);
    });
    const { stdout: clients } = await fixture.run('list-clients', '-t', `=${sessionName}`);
    assert.notEqual(clients.trim(), '', 'a real control-mode client must be attached');
    await fixture.run('detach-client', '-s', `=${sessionName}`);
    let timeout;
    try {
      await Promise.race([
        closed,
        new Promise((_, reject) => {
          timeout = setTimeout(() => reject(new Error('detached tmux client did not exit')), 5000);
          timeout.unref();
        }),
      ]);
    } finally {
      clearTimeout(timeout);
    }
    const { stdout: detached } = await fixture.run('list-clients', '-t', `=${sessionName}`);
    assert.equal(detached.trim(), '', 'client detached without killing the session');
  } finally {
    if (client.exitCode === null) client.kill();
  }
}

function sameIncarnation(actual, bound) {
  return actual !== null && Object.keys(bound).every((key) => actual[key] === bound[key]);
}

test('real private tmux: lookup cannot create; detached shell retains identity; recreation and restart invalidate it', async (t) => {
  const fixture = await privateTmux(t);
  const foreign = await privateTmux(t);
  const workspaceId = `workspace-${randomUUID()}`;
  const request = { workspaceId, socket: fixture.socket, paneId };
  const socketDir = path.join(fixture.root, `tmux-${process.getuid()}`);

  assert.equal(await lookup(fixture, workspaceId, request), null);
  assert.deepEqual(await readdir(socketDir), [], 'a missing lookup must not start a server or shell');

  await fixture.run('new-session', '-d', '-s', sessionName, '/bin/bash --noprofile --norc');
  const original = await lookup(fixture, workspaceId, request);
  assert.ok(original);
  assert.equal(original.sessionName, sessionName);
  assert.ok((await readdir(socketDir)).includes(fixture.socket));
  const { stdout: clients } = await fixture.run('list-clients', '-t', `=${sessionName}`);
  assert.equal(clients.trim(), '', 'the shell is alive without an attached client');
  await attachThenDetach(t, fixture);
  assert.ok(sameIncarnation(await lookup(fixture, workspaceId, request), original));

  const broken = { ...fixture, run: async () => { throw Object.assign(new Error('tmux permission denied'), { code: 1, stderr: 'permission denied\n' }); } };
  await assert.rejects(lookup(broken, workspaceId, request), /tmux permission denied/);
  const malformed = { ...fixture, run: async () => ({ stdout: 'malformed nonempty identity\n' }) };
  await assert.rejects(lookup(malformed, workspaceId, request), /unexpected tmux identity format/);

  assert.equal(await lookup(fixture, workspaceId, { ...request, workspaceId: 'foreign-workspace' }), null);
  assert.equal(await lookup(fixture, workspaceId, { ...request, socket: 'foreign-socket' }), null);
  assert.equal(await lookup(fixture, workspaceId, { ...request, paneId: '../not-a-pane' }), null);
  await foreign.run('new-session', '-d', '-s', sessionName, '/bin/bash --noprofile --norc');
  const foreignIdentity = await lookup(foreign, workspaceId, { ...request, socket: foreign.socket });
  assert.ok(foreignIdentity, 'a different namespace can contain the same pane-shaped name');
  assert.equal(foreignIdentity.sessionId, original.sessionId);
  assert.equal(foreignIdentity.tmuxPaneId, original.tmuxPaneId);
  assert.equal(await lookup(fixture, workspaceId, { ...request, socket: foreign.socket }), null);
  assert.ok(!sameIncarnation(foreignIdentity, original));

  // Keep this tmux server alive when the target session is removed. Without a
  // second session, killing the last one would reset server-local ID counters.
  const sentinelName = `identity-sentinel-${randomUUID()}`;
  await fixture.run('new-session', '-d', '-s', sentinelName, '/bin/bash --noprofile --norc');
  assert.equal((await lookup(fixture, workspaceId, request)).serverPid, original.serverPid);
  await fixture.run('kill-session', '-t', `=${sessionName}`);
  await fixture.run('has-session', '-t', `=${sentinelName}`);
  assert.equal(await lookup(fixture, workspaceId, request), null);
  await assert.rejects(fixture.run('has-session', '-t', `=${sessionName}`), { code: 1 });
  await fixture.run('new-session', '-d', '-s', sessionName, '/bin/bash --noprofile --norc');
  const recreated = await lookup(fixture, workspaceId, request);
  assert.ok(recreated);
  assert.equal(recreated.serverPid, original.serverPid, 'target recreation must use the existing tmux server');
  assert.notEqual(recreated.sessionId, original.sessionId);
  assert.notEqual(recreated.tmuxPaneId, original.tmuxPaneId);
  assert.ok(!sameIncarnation(recreated, original), 'same layout pane name cannot authorize a new tmux shell');

  await fixture.run('kill-server');
  assert.equal(await lookup(fixture, workspaceId, request), null);
  await fixture.run('new-session', '-d', '-s', sessionName, '/bin/bash --noprofile --norc');
  const restarted = await lookup(fixture, workspaceId, request);
  assert.ok(restarted);
  assert.ok(!sameIncarnation(restarted, recreated), 'server restart must invalidate prior binding');
  // tmux counters may reset across server restarts. Numeric PID and seconds-
  // resolution creation times can be reused; neither is an absolute epoch.
  // A trusted server-issued epoch/token persisted and rotated on restart is
  // necessary for a hard no-ABA resource incarnation guarantee.
  assert.equal(restarted.sessionId, '$0');
  assert.equal(restarted.tmuxPaneId, '%0');
});
