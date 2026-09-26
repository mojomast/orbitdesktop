import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { ManagedTerminalIdentityLedger } from '../server/managed-terminal-ledger.mjs';
import { ManagedTerminalProvider } from '../server/managed-terminal-provider.mjs';
import { ManagedTerminalBroker } from '../server/managed-terminal-broker.mjs';
import { MANAGED_TERMINAL_LIMITS, MANAGED_TERMINAL_RELEASE_ACKNOWLEDGEMENT } from '../server/managed-terminal-contract.mjs';

const exec = promisify(execFile);
async function fixture(t) {
  const root = await mkdtemp('/tmp/opencode/broker-'), socket = 'broker-' + randomUUID(), paneId = randomUUID();
  const sessionName = 'pane-' + paneId;
  const env = { PATH: '/usr/bin:/bin', HOME: root, TMUX_TMPDIR: root, TERM: 'xterm-256color' };
  const run = (...args) => exec('/usr/bin/tmux', ['-L', socket, '-f', '/dev/null', ...args], { env, timeout: 3000 });
  t.after(async () => { try { await run('kill-server'); } catch {} await rm(root, { recursive: true, force: true }); });
  await run('new-session', '-d', '-s', sessionName, '/bin/bash');
  const ledger = await new ManagedTerminalIdentityLedger({ directory: root }).load();
  const provider = await ManagedTerminalProvider.create({ mode: 'attach', socket, tmuxTmpDir: root, ledger });
  const record = { id: 'workspace', revision: 1, state: { monitors: [{ layout: { type: 'pane', pane: { id: paneId, kind: 'terminal' } } }] } };
  let now = Date.now();
  const workspaceRead = id => ({ ...record, id });
  const options = { ownerId: 'owner', providerId: socket, provider, workspaceRead, journalPath: root + '/journal.json', now: () => now };
  const broker = new ManagedTerminalBroker(options);
  const adopt = () => broker.adopt({ workspaceId: 'workspace', paneId, consent: true });
  const grant = scope => broker.grant({ workspaceId: 'workspace', paneId, scope, ttlMs: 5000 });
  const request = lease => ({ workspaceId: 'workspace', leaseId: lease.lease_id, baseRevision: 1 });
  return { root, run, provider, broker, paneId, sessionName, record, options, adopt, grant, request, advance: ms => { now += ms; } };
}

const releaseRequest = f => ({ workspaceId: 'workspace', paneId: f.paneId, baseRevision: f.record.revision,
  consent: true, acknowledge: MANAGED_TERMINAL_RELEASE_ACKNOWLEDGEMENT });

test('advertised expiry is per lease even after a longer grant', async t => {
  const f = await fixture(t); await f.adopt();
  const long = await f.broker.grant({ workspaceId: 'workspace', paneId: f.paneId, scope: 'observe', ttlMs: 300000 });
  const short = await f.grant('input');
  assert.ok(long.expires_at - short.expires_at > 294000 && long.expires_at - short.expires_at <= 295000);
});

test('revoking another input lease during dispatch does not abort this lease', async t => {
  const f = await fixture(t); await f.adopt();
  const a = await f.grant('input'), b = await f.grant('input');
  const original = f.provider.sendLiteral.bind(f.provider);
  f.provider.sendLiteral = async request => {
    f.broker.revoke({ leaseId: a.lease_id });
    return original(request);
  };
  assert.deepEqual(await f.broker.input({ ...f.request(b), operationId: 'unrelated-revoke', text: 'SAFE', confirmNewline: false }),
    { operation_id: 'unrelated-revoke', applied: true });
  assert.equal(f.broker.status().leases.find(l => l.lease_id === a.lease_id).state, 'revoked');
});

test('registry binding repairs after a failed inspection and fences old leases', async t => {
  const f = await fixture(t);
  const inspect = f.provider.inspectExact.bind(f.provider);
  let failOnce = false;
  f.provider.inspectExact = async request => {
    if (failOnce) { failOnce = false; throw Object.assign(Error('transient'), { code: 'provider_error' }); }
    return inspect(request);
  };
  await f.adopt(); const old = await f.grant('observe');
  failOnce = true;
  await assert.rejects(f.grant('observe'), { code: 'provider_error' });
  const previous = f.broker.status().resources[0].resource_id;
  await f.adopt();
  assert.equal(f.broker.status().resources[0].resource_id, previous);
  await assert.rejects(f.broker.observe(f.request(old)), { code: 'revoked' });
  const fresh = await f.grant('observe');
  assert.equal(typeof (await f.broker.observe(f.request(fresh))).text, 'string');
});

test('missing target release drops metadata and leases without creating a shell', async t => {
  const foreign = await fixture(t); await foreign.adopt();
  await assert.rejects(foreign.broker.release({ ...releaseRequest(foreign), workspaceId: 'other-workspace' }), { code: 'conflict' });
  assert.ok(foreign.provider.ledger.get(foreign.sessionName));
  const f = await fixture(t); await f.adopt(); const lease = await f.grant('observe');
  await f.run('kill-session', '-t', '=' + f.sessionName);
  assert.deepEqual(await f.broker.release(releaseRequest(f)), { released: true, mode: 'missing' });
  assert.equal(f.provider.ledger.get(f.sessionName), null);
  assert.equal(f.broker.status().resources.length, 0);
  assert.equal(f.broker.status().leases.find(l => l.lease_id === lease.lease_id).state, 'revoked');
  await assert.rejects(f.run('has-session', '-t', '=' + f.sessionName));
  await f.run('new-session', '-d', '-s', f.sessionName, '/bin/bash');
  await f.adopt();
  assert.ok(f.provider.ledger.get(f.sessionName));
});

test('release clears owned markers after respawn, but refuses foreign markers', async t => {
  const f = await fixture(t); await f.adopt();
  const first = f.provider.ledger.get(f.sessionName);
  await f.run('respawn-pane', '-k', '-t', first.paneId, '/bin/bash');
  const changed = await f.provider.observeExact({ sessionName: f.sessionName });
  assert.notEqual(changed.shellPid, first.shellPid);
  assert.equal(changed.markers.shellInstance, first.shellInstance);
  assert.deepEqual(await f.broker.release(releaseRequest(f)), { released: true, mode: 'cleared' });
  const observed = await f.provider.observeExact({ sessionName: f.sessionName });
  assert.deepEqual(observed.markers, { serverEpoch: '', shellInstance: '', sessionEpoch: '' });
  await f.run('has-session', '-t', '=' + f.sessionName);
  assert.equal(f.provider.ledger.get(f.sessionName), null);
  await f.adopt();
  const retained = f.provider.ledger.get(f.sessionName);
  await f.run('set-option', '-t', retained.sessionId, '@orbit_adopted_shell', 'a'.repeat(64));
  await assert.rejects(f.broker.release(releaseRequest(f)), { code: 'identity_changed' });
  assert.deepEqual(f.provider.ledger.get(f.sessionName), retained);
  assert.equal((await f.provider.observeExact({ sessionName: f.sessionName })).markers.shellInstance, 'a'.repeat(64));
});

test('journal capacity denies a new operation before dispatch and retains replay receipts', async t => {
  const root = await mkdtemp('/tmp/opencode/journal-capacity-');
  t.after(() => rm(root, { recursive: true, force: true }));
  const entries = {};
  let i = 0;
  const sampleLength = JSON.stringify({ 'prior-000000': { hash: '0'.repeat(64), state: 'applied' } }).length - 2;
  const initialCount = Math.floor((MANAGED_TERMINAL_LIMITS.journalMaxBytes - 300) / (sampleLength + 1));
  while (i < initialCount) {
    entries[`prior-${String(i++).padStart(6, '0')}`] = { hash: '0'.repeat(64), state: 'applied' };
  }
  // Leave room for exactly one applied receipt, then fail the next new ID.
  while (JSON.stringify(entries).length < MANAGED_TERMINAL_LIMITS.journalMaxBytes - 220) {
    entries[`prior-${String(i++).padStart(6, '0')}`] = { hash: '0'.repeat(64), state: 'applied' };
  }
  while (JSON.stringify(entries).length > MANAGED_TERMINAL_LIMITS.journalMaxBytes - 180) delete entries[`prior-${String(--i).padStart(6, '0')}`];
  await writeFile(root + '/journal.json', JSON.stringify(entries), { mode: 0o600 });
  const paneId = randomUUID(), sessionName = 'pane-' + paneId;
  const identity = { serverEpoch: 'a'.repeat(64), shellInstance: 'b'.repeat(64), sessionId: '$0', paneId: '%0' };
  let sends = 0;
  const provider = { ledger: { get: () => ({ workspaceId: 'workspace' }) },
    observeExact: async () => ({ sessionName, sessionId: '$0', paneId: '%0', serverPid: '1', shellPid: '2',
      kernel: {}, markers: { serverEpoch: identity.serverEpoch, shellInstance: identity.shellInstance, sessionEpoch: identity.serverEpoch } }),
    adoptSession: async () => identity, inspectExact: async () => identity,
    sendLiteral: async ({ authorize }) => { authorize(); sends++; return { sent: true }; } };
  const broker = new ManagedTerminalBroker({ ownerId: 'owner', providerId: 'journal-stub-' + randomUUID(), provider,
    workspaceRead: () => ({ id: 'workspace', revision: 1, state: { monitors: [{ layout: { type: 'pane', pane: { id: paneId, kind: 'terminal' } } }] } }),
    journalPath: root + '/journal.json' });
  await broker.adopt({ workspaceId: 'workspace', paneId, consent: true });
  const lease = await broker.grant({ workspaceId: 'workspace', paneId, scope: 'input', ttlMs: 120000 });
  const base = { workspaceId: 'workspace', leaseId: lease.lease_id, baseRevision: 1, text: 'x', confirmNewline: false };
  const first = { ...base, operationId: 'capacity-000000' };
  await broker.input(first);
  let rejected;
  for (let n = 1; n < 8; n++) {
    const request = { ...base, operationId: `capacity-${String(n).padStart(6, '0')}` };
    try { await broker.input(request); } catch (e) { assert.equal(e.code, 'journal_full'); rejected = request; break; }
  }
  assert.ok(rejected, 'journal should reach capacity within seven new receipts');
  const sentBefore = sends;
  await assert.rejects(broker.input(rejected), { code: 'journal_full' });
  assert.equal(sends, sentBefore, 'no send on capacity refusal');
  assert.deepEqual(await broker.input(first), { operation_id: first.operationId, applied: true });
  assert.equal(sends, sentBefore, 'replay must not send');
  assert.ok((await readFile(root + '/journal.json')).byteLength <= MANAGED_TERMINAL_LIMITS.journalMaxBytes);
});

test('orphan metadata is pruned before resource capacity rejects new adoption', async () => {
  const ids = Array.from({ length: MANAGED_TERMINAL_LIMITS.maxResources + 1 }, () => randomUUID());
  const panes = new Set(ids.slice(0, -1));
  const identity = { serverEpoch: 'a'.repeat(64), shellInstance: 'b'.repeat(64), sessionId: '$0', paneId: '%0' };
  const entry = { workspaceId: 'workspace', sessionName: '', sessionId: '$0', paneId: '%0', serverPid: '1', shellPid: '2',
    serverEpoch: identity.serverEpoch, shellInstance: identity.shellInstance };
  const provider = { ledger: { get: name => ({ ...entry, sessionName: name }) },
    observeExact: async ({ sessionName }) => ({ sessionName, sessionId: '$0', paneId: '%0', serverPid: '1', shellPid: '2',
      kernel: {}, markers: { serverEpoch: identity.serverEpoch, shellInstance: identity.shellInstance, sessionEpoch: identity.serverEpoch } }),
    adoptSession: async () => identity, inspectExact: async () => identity };
  const broker = new ManagedTerminalBroker({ ownerId: 'owner', providerId: 'orphans-' + randomUUID(), provider,
    workspaceRead: () => ({ id: 'workspace', revision: 1, state: { monitors: [...panes].map(id => ({ layout: { type: 'pane', pane: { id, kind: 'terminal' } } })) } }) });
  for (const paneId of panes) await broker.adopt({ workspaceId: 'workspace', paneId, consent: true });
  assert.equal(broker.status().resources.length, MANAGED_TERMINAL_LIMITS.maxResources);
  panes.clear(); panes.add(ids.at(-1));
  const adopted = await broker.adopt({ workspaceId: 'workspace', paneId: ids.at(-1), consent: true });
  assert.equal(adopted.pane_id, ids.at(-1));
  assert.equal(broker.status().resources.length, 1);
});

test('real capture grants enforce scope, workspace, revision, expiry, revocation and cross-workspace claims', async t => {
  const f = await fixture(t);
  await f.adopt(); const lease = await f.grant('observe');
  const result = await f.broker.observe(f.request(lease));
  assert.equal(result.bytes, Buffer.byteLength(result.text));
  assert.equal((await f.broker.reconcile({ workspaceId: 'workspace' })).entries[0].status, 'managed');
  assert.deepEqual(Object.keys(f.broker.status().resources[0]).sort(), ['pane_id', 'resource_id', 'status', 'workspace_id']);
  await assert.rejects(f.broker.observe({ ...f.request(lease), workspaceId: 'other' }), { code: 'unauthorized' });
  await assert.rejects(f.broker.observe({ ...f.request(lease), baseRevision: 0 }), { code: 'conflict' });
  await assert.rejects(f.broker.adopt({ workspaceId: 'other', paneId: f.paneId, consent: true }), { code: 'conflict' });
  const later = await f.grant('observe'); assert.ok(later.expires_at >= lease.expires_at);
  f.broker.revoke({ leaseId: lease.lease_id });
  await assert.rejects(f.broker.observe(f.request(lease)), { code: 'revoked' });
  f.advance(6000);
  await assert.rejects(f.broker.observe(f.request(later)), { code: 'expired' });
  await assert.rejects(f.broker.adopt({ workspaceId: 'workspace', paneId: randomUUID(), consent: true }), { code: 'not_found' });
  assert.equal((await f.run('list-sessions', '-F', '#{session_name}')).stdout.trim(), f.sessionName);
});

test('revoke and identity replacement racing capture never return captured text', async t => {
  const f = await fixture(t); await f.adopt();
  const original = f.provider.captureExact.bind(f.provider);
  for (const race of ['revoke', 'respawn']) {
    const lease = await f.grant('observe');
    let release, entered;
    const held = new Promise(r => { release = r; });
    const started = new Promise(r => { entered = r; });
    f.provider.captureExact = async request => { const result = await original(request); entered(); await held; return result; };
    const pending = f.broker.observe(f.request(lease));
    const denial = assert.rejects(pending, { code: race === 'revoke' ? 'revoked' : 'identity_changed' });
    await started;
    if (race === 'revoke') f.broker.revoke({ leaseId: lease.lease_id });
    else await f.run('respawn-pane', '-k', '-t', f.provider.ledger.get(f.sessionName).paneId, '/bin/bash');
    release(); await denial;
  }
});

test('literal input is bounded, confirmed, journaled before sending and replayed without resending', async t => {
  const f = await fixture(t); await f.adopt(); const lease = await f.grant('input');
  const base = { ...f.request(lease), operationId: 'operation-1', text: '$(echo pwned)', confirmNewline: false };
  let sends = 0;
  const original = f.provider.sendLiteral.bind(f.provider);
  f.provider.sendLiteral = async request => {
    sends++;
    const data = JSON.parse(await readFile(f.root + '/journal.json'));
    assert.equal(data['operation-1'].state, 'pending');
    return original(request);
  };
  assert.deepEqual(await f.broker.input(base), { operation_id: 'operation-1', applied: true });
  await f.broker.input(base); assert.equal(sends, 1);
  const captured = await f.provider.captureExact({ sessionName: f.sessionName, lines: 100, maxBytes: 65536 });
  assert.ok(captured.text.includes('$(echo pwned)'));
  await assert.rejects(f.broker.input({ ...base, text: 'different' }), { code: 'conflict' });
  await assert.rejects(f.broker.input({ ...base, operationId: 'operation-2', text: '\u001b' }), { code: 'invalid_request' });
  await assert.rejects(f.broker.input({ ...base, operationId: 'operation-2', text: 'echo hi\n' }), { code: 'confirmation_required' });
  await assert.rejects(f.broker.observe(f.request(lease)), { code: 'unauthorized' });
  f.provider.sendLiteral = async () => { throw Object.assign(Error('private details'), { code: 'provider_error' }); };
  const pending = { ...base, operationId: 'operation-pending' };
  await assert.rejects(f.broker.input(pending), { code: 'provider_error' });
  await assert.rejects(f.broker.input(pending), { code: 'pending' });
  const persisted = JSON.parse(await readFile(f.root + '/journal.json'));
  assert.equal(persisted['operation-pending'].state, 'pending');
  assert.equal(JSON.stringify(persisted).includes('pwned'), false);
  // A fresh broker loads the durable journal without restoring any grants.
  const restarted = new ManagedTerminalBroker(f.options);
  assert.deepEqual(restarted.status().leases, []);
});

test('server restart requires explicit fresh consent and invalidates previous leases', async t => {
  const f = await fixture(t); await f.adopt(); const lease = await f.grant('observe');
  await f.run('kill-server'); await f.run('new-session', '-d', '-s', f.sessionName, '/bin/bash');
  assert.equal(await f.provider.inspectExact({ sessionName: f.sessionName }), null);
  assert.equal((await f.broker.reconcile({ workspaceId: 'workspace' })).entries[0].status, 'requires_consent');
  await assert.rejects(f.broker.adopt({ workspaceId: 'workspace', paneId: f.paneId }), { code: 'confirmation_required' });
  await f.adopt();
  await assert.rejects(f.broker.observe(f.request(lease)), { code: 'revoked' });
  const fresh = await f.grant('observe'); assert.equal(typeof (await f.broker.observe(f.request(fresh))).text, 'string');
});

test('revocation and revision changes immediately before input dispatch send no bytes', async t => {
  const f = await fixture(t); await f.adopt();
  const original = f.provider.sendLiteral.bind(f.provider);
  for (const race of ['revoke', 'revision']) {
    const lease = await f.grant('input');
    f.provider.sendLiteral = async request => {
      if (race === 'revoke') f.broker.revoke({leaseId:lease.lease_id});
      else f.record.revision++;
      return original(request);
    };
    await assert.rejects(f.broker.input({...f.request(lease),operationId:'before-dispatch-'+race,text:'NEVER_DISPATCH_'+race,confirmNewline:false}), {code:race === 'revoke' ? 'revoked' : 'conflict'});
    const capture = await f.provider.captureExact({sessionName:f.sessionName,lines:100,maxBytes:65536});
    assert.ok(!capture.text.includes('NEVER_DISPATCH_'+race));
  }
});

test('adoption and grants reject stale workspace revisions', async t => {
  const f = await fixture(t);
  await assert.rejects(f.broker.adopt({workspaceId:'workspace',paneId:f.paneId,consent:true,baseRevision:0}), {code:'conflict'});
  assert.equal(f.provider.ledger.get(f.sessionName), null);
  await f.adopt();
  await assert.rejects(f.broker.grant({workspaceId:'workspace',paneId:f.paneId,scope:'observe',baseRevision:0}), {code:'conflict'});
});
