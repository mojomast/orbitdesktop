import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, stat, chmod, symlink, readFile, writeFile } from 'node:fs/promises';
import { execFile, execFileSync, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { ManagedTerminalIdentityLedger, LEDGER_SENTINEL_SUFFIX } from '../server/managed-terminal-ledger.mjs';
import { ManagedTerminalProvider } from '../server/managed-terminal-provider.mjs';
import { ManagedTerminalBroker } from '../server/managed-terminal-broker.mjs';
import { LocalHostProvider } from '../server/local-host.mjs';
import { literalChunks } from '../server/managed-terminal-contract.mjs';

const exec = promisify(execFile);
const pause = () => new Promise(r => setTimeout(r, 30));
test('private ledger rejects insecure paths and malformed entries without leaking tokens', async t => {
  const root = await mkdtemp('/tmp/opencode/ledger-');
  t.after(() => rm(root, { recursive: true, force: true }));
  await chmod(root, 0o755);
  assert.throws(() => new ManagedTerminalIdentityLedger({ directory: root }), { code: 'invalid_request' });
  await chmod(root, 0o700);
  await symlink(root, root + '-link'); t.after(() => rm(root + '-link'));
  assert.throws(() => new ManagedTerminalIdentityLedger({ directory: root + '-link' }), { code: 'invalid_request' });
  const ledger = await new ManagedTerminalIdentityLedger({ directory: root }).load();
  await assert.rejects(ledger.put({ token: 'secret-token' }), e => e.code === 'provider_error' && !e.message.includes('secret-token'));
  await writeFile(root + '/identity-ledger.json', '[]', { mode: 0o644 });
  await chmod(root + '/identity-ledger.json', 0o644);
  await assert.rejects(new ManagedTerminalIdentityLedger({ directory: root }).load(), { code: 'provider_error' });
  await rm(root + '/identity-ledger.json');
  await symlink('/dev/null', root + '/identity-ledger.json');
  await assert.rejects(new ManagedTerminalIdentityLedger({ directory: root }).load(), { code: 'provider_error' });
});

test('fresh ledger creates a private sentinel; missing ledger after initialization fails closed', async t => {
  const root = await mkdtemp('/tmp/opencode/ledger-loss-');
  t.after(() => rm(root, { recursive: true, force: true }));
  const file = root + '/identity-ledger.json', sentinel = file + LEDGER_SENTINEL_SUFFIX;
  const fresh = await new ManagedTerminalIdentityLedger({ directory: root }).load();
  assert.equal(fresh.size, 0);
  assert.equal(fresh.lost, false);
  assert.equal((await stat(root)).mode & 0o777, 0o700);
  assert.equal((await stat(sentinel)).mode & 0o777, 0o600);
  // A fresh install must persist an empty ledger too, so a later restart cannot
  // mistake an untouched install for a lost ledger.
  assert.equal((await stat(file)).mode & 0o777, 0o600);
  const restarted = await new ManagedTerminalIdentityLedger({ directory: root }).load();
  assert.equal(restarted.lost, false);
  assert.equal(restarted.size, 0);
  await fresh.remove('not-present');
  assert.equal((await stat(file)).mode & 0o777, 0o600);
  await rm(file);
  const lost = new ManagedTerminalIdentityLedger({ directory: root });
  await assert.rejects(lost.load(), { code: 'unavailable' });
  assert.equal(lost.lost, true);
  assert.equal(lost.loaded, false);
  assert.equal((await stat(sentinel)).mode & 0o777, 0o600);
});

test('owner re-adoption recovers a transient attach inspection timeout', async t => {
  const root = await mkdtemp('/tmp/opencode/attach-timeout-');
  const socket = 'timeout-' + randomUUID();
  const sessionName = 'pane-' + randomUUID();
  const env = { PATH: '/usr/bin:/bin', HOME: root, TMUX_TMPDIR: root, TERM: 'xterm-256color' };
  const run = (...args) => exec('/usr/bin/tmux', ['-L', socket, '-f', '/dev/null', ...args], { env, timeout: 3000 });
  let stoppedPid;
  t.after(async () => {
    if (stoppedPid) process.kill(stoppedPid, 'SIGCONT');
    try { await run('kill-server'); } catch {}
    await rm(root, { recursive: true, force: true });
  });
  await run('new-session', '-d', '-s', sessionName, '/bin/bash');
  const ledger = await new ManagedTerminalIdentityLedger({ directory: root }).load();
  const p = await ManagedTerminalProvider.create({ mode: 'attach', socket, tmuxTmpDir: root, ledger, timeoutMs: 200 });
  t.after(() => p.dispose());
  const identity = await p.adoptSession({ sessionName, workspaceId: 'workspace' });
  assert.ok(identity);
  const pid = Number(ledger.get(sessionName).serverPid);
  process.kill(pid, 'SIGSTOP'); stoppedPid = pid;
  try { await assert.rejects(p.inspectExact({ sessionName }), { code: 'timeout' }); }
  finally { process.kill(pid, 'SIGCONT'); stoppedPid = undefined; }
  assert.equal(await p.inspectExact({ sessionName }), null);
  assert.deepEqual(await p.adoptSession({ sessionName, workspaceId: 'workspace' }), identity);
  assert.ok(await p.attachmentArguments({ sessionName }));
});

test('LocalHost shell is adopted, durably recovered, fenced on replacement, and never killed by disposal', async t => {
  const root = await mkdtemp('/tmp/opencode/adoption-');
  const socket = 'adopt-' + randomUUID();
  const paneId = 'b45066f1-5751-4ab9-a692-68ff4ef3c481';
  const sessionName = 'pane-' + paneId;
  const env = { PATH: '/usr/bin:/bin', HOME: root, TMUX_TMPDIR: root, SHELL: '/bin/bash', TERM: 'xterm-256color' };
  const run = (...args) => exec('/usr/bin/tmux', ['-L', socket, '-f', '/dev/null', ...args], { env, timeout: 3000 });
  let client;
  t.after(async () => { client?.kill(); try { await run('kill-server'); } catch {} await rm(root, { recursive: true, force: true }); });
  const ledger = await new ManagedTerminalIdentityLedger({ directory: root }).load();
  const options = { mode: 'attach', socket, ledger, tmuxTmpDir: root };
  const p = await ManagedTerminalProvider.create(options);
  assert.equal(await p.observeExact({ sessionName }), null);
  assert.equal(await p.adoptSession({ sessionName, workspaceId: 'workspace' }), null);
  await assert.rejects(run('list-sessions'));
  const host = new LocalHostProvider({ tmuxSocket: socket, tmuxConfig: '/dev/null', cwd: root, home: root, env });
  client = host.spawn({ pane_id: paneId, cols: 80, rows: 24 });
  await new Promise((resolve, reject) => {
    let output = ''; const timeout = setTimeout(() => reject(Error('PTY initialization timeout')), 5000);
    const sub = client.onData(chunk => { output += chunk; if (output.includes('READY_retained')) { clearTimeout(timeout); sub.dispose(); resolve(); } });
    client.write("export ORBIT_TEST=retained; printf 'READY_%s\\n' \"$ORBIT_TEST\"\r");
  });
  client.kill(); client = null;
  const workspaceRead = id => ({ id, revision: 1, state: { monitors: [{ layout: { type: 'pane', pane: { id: paneId, kind: 'terminal' } } }] } });
  const broker = new ManagedTerminalBroker({ ownerId: 'owner', providerId: socket, provider: p, workspaceRead });
  assert.equal((await broker.reconcile({ workspaceId: 'workspace' })).entries[0].status, 'unmanaged');
  await assert.rejects(broker.adopt({ workspaceId: 'workspace', paneId, consent: false }), { code: 'confirmation_required' });
  await broker.adopt({ workspaceId: 'workspace', paneId, consent: true });
  const identity = await p.inspectExact({ sessionName });
  const original = ledger.get(sessionName);
  assert.ok(Object.isFrozen(original)); assert.ok(Object.isFrozen(ledger.list()));
  assert.equal((await stat(root)).mode & 0o777, 0o700);
  assert.equal((await stat(root + '/identity-ledger.json')).mode & 0o777, 0o600);
  assert.equal(JSON.parse(await readFile(root + '/identity-ledger.json'))[0].shellPid, original.shellPid);
  await p.dispose(); await run('has-session', '-t', '=' + sessionName);
  const recovered = new ManagedTerminalIdentityLedger({ directory: root });
  const p2 = await ManagedTerminalProvider.create({ ...options, ledger: recovered });
  const b2 = new ManagedTerminalBroker({ ownerId: 'owner', providerId: socket + '-inspect', provider: p2, workspaceRead });
  assert.deepEqual(recovered.get(sessionName), original);
  assert.deepEqual(await p2.inspectExact({ sessionName }), identity);
  assert.deepEqual(await p2.adoptSession({ sessionName, workspaceId: 'workspace' }), identity);
  const tmuxArguments = await p2.attachmentArguments({sessionName});
  assert.ok(tmuxArguments && !tmuxArguments.includes('new-session'));
  client = host.spawn({pane_id:paneId, cols:80, rows:24}, {tmuxArguments});
  await new Promise((resolve, reject) => {
    let output = ''; const timer = setTimeout(() => reject(Error('Managed PTY reattachment timeout')), 5000);
    const sub = client.onData(chunk => { output += chunk; if (output.includes(`REATTACHED_retained_${original.shellPid}`)) { clearTimeout(timer); sub.dispose(); resolve(); } });
    client.write("printf 'REATTACHED_%s_%s\\n' \"$ORBIT_TEST\" \"$$\"\r");
  });
  client.kill(); client = null;
  await p2.sendLiteral({ sessionName, plan: literalChunks("printf 'RECOVERED_%s_%s\\n' \"$ORBIT_TEST\" \"$$\"\n", { confirmNewline: true }) });
  let captured;
  for (let i = 0; i < 100; i++) { captured = await p2.captureExact({ sessionName, lines: 100, maxBytes: 65536 }); if (captured.text.includes(`RECOVERED_retained_${original.shellPid}`)) break; await pause(); }
  assert.ok(captured.text.includes(`RECOVERED_retained_${original.shellPid}`));
  await assert.rejects(p2.sendLiteral({sessionName, plan: literalChunks('UNAUTHORIZED_LITERAL'), authorize: () => { throw Object.assign(Error('revoked'), {code:'revoked'}); }}), {code:'revoked'});
  const switched = await p2.sendLiteral({sessionName, plan: literalChunks('WRONG_IDENTITY_LITERAL'), authorize: () => {
    execFileSync('/usr/bin/tmux', ['-L', socket, 'set-option', '-t', original.sessionId, '@orbit_adopted_shell', 'a'.repeat(64)], {env, timeout:3000});
  }});
  assert.equal(switched, null, 'tmux conditional must refuse identity changed after inspection');
  await run('set-option', '-t', original.sessionId, '@orbit_adopted_shell', original.shellInstance);
  captured = await p2.captureExact({sessionName, lines:100, maxBytes:65536});
  assert.ok(!captured.text.includes('UNAUTHORIZED_LITERAL'));
  assert.ok(!captured.text.includes('WRONG_IDENTITY_LITERAL'));
  await run('respawn-pane', '-k', '-t', identity.paneId, '/bin/bash');
  assert.equal(await p2.adoptSession({ sessionName, workspaceId: 'workspace' }), null);
  assert.equal(await p2.inspectExact({ sessionName }), null);
  assert.equal(await p2.attachmentArguments({ sessionName }), null, 'Changed shells must not be silently attached or recreated');
  assert.equal((await b2.reconcile({ workspaceId: 'workspace' })).entries[0].status, 'identity_changed');
  // kill-server acknowledges the command before the old server has exited. Bind
  // a Linux pidfd BEFORE killing it, then await kernel exit notification instead
  // of racing new-session against a dying server/socket (or retrying until green).
  const waiter=spawn('/usr/bin/python3',['-c',"import os,select,sys\nfd=os.pidfd_open(int(sys.argv[1]))\nprint('READY',flush=True)\nready=select.select([fd],[],[],10)[0]\nos.close(fd)\nsys.exit(0 if ready else 1)",String(original.serverPid)],{env,stdio:['ignore','pipe','pipe']});
  t.after(()=>{if(waiter.exitCode===null)waiter.kill();});
  await new Promise((resolve,reject)=>{let ready=false;waiter.stdout.once('data',data=>{ready=true;try{assert.equal(data.toString().trim(),'READY');resolve();}catch(error){reject(error);}});waiter.once('error',reject);waiter.once('exit',()=>{if(!ready)reject(Error('pidfd observer exited before binding the old tmux server'));});});
  const exited=new Promise((resolve,reject)=>waiter.once('exit',code=>code===0?resolve():reject(Error('Old tmux server did not exit'))));
  await run('kill-server');
  await exited;
  await run('new-session', '-d', '-s', sessionName, '/bin/bash');
  const p3 = await ManagedTerminalProvider.create({ ...options, ledger: recovered });
  const b3 = new ManagedTerminalBroker({ ownerId: 'owner', providerId: socket + '-reloaded', provider: p3, workspaceRead });
  assert.equal(await p3.inspectExact({ sessionName }), null);
  assert.equal((await b3.reconcile({ workspaceId: 'workspace' })).entries[0].status, 'requires_consent');
  await assert.rejects(b3.adopt({ workspaceId: 'workspace', paneId, consent: false }), { code: 'confirmation_required' });
  await p2.dispose(); await p3.dispose(); await run('has-session', '-t', '=' + sessionName);
});
