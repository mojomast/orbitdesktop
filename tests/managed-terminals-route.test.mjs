import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { createManagedTerminalHandler } from '../server/managed-terminal-routes.mjs';
import { MANAGED_TERMINAL_RELEASE_ACKNOWLEDGEMENT } from '../server/managed-terminal-contract.mjs';

const pane = '12345678-1234-4123-8123-123456789abc';
const owner = 'a'.repeat(40);
const workspace_id = '12345678-1234-4123-8123-123456789abc';
const lease_id = 'lease-one';
const secret = { serverEpoch: 'SECRET_EPOCH', shellInstance: 'SECRET_SHELL', serverPid: 123, shellPid: 456, bootId: 'SECRET_BOOT', starttime: 789, kernel: { bootId: 'SECRET_KERNEL' }, stderr: 'RAW_TMUX_STDERR' };
const resource = { resourceId: 'resource-one', paneId: pane, workspaceId: workspace_id, status: 'managed', ...secret };
const lease = { leaseId: lease_id, scope: 'observe', resourceId: resource.resourceId, paneId: pane, expiresAt: 10000, state: 'active', ...secret };
function broker() {
  return {
    status: async () => ({ generation: 1, resources: [resource], leases: [lease], ...secret }),
    reconcile: async () => ({ entries: [{ pane_id: pane, status: 'managed', ...secret }], reconciled_at: 1000, ...secret }),
    adopt: async () => ({ resource_id: resource.resourceId, pane_id: pane, workspace_id, status: 'managed', ...secret }),
    grant: async () => ({ lease_id, scope: 'observe', resource_id: resource.resourceId, pane_id: pane, expires_at: 10000, state: 'active', ...secret }),
    revoke: async () => ({ revoked: true, ...secret }),
    release: async () => ({ released: true, mode: 'cleared', ...secret }),
    observe: async () => ({ text: 'bounded output', bytes: 14, lines: 1, observed_at: 1000, ...secret }),
    input: async ({ operationId }) => ({ operation_id: operationId, applied: true, ...secret }),
  };
}
async function request(body, { method = 'POST', token = owner, origin = 'http://127.0.0.1:4318', fake = broker(), raw, bearer = true } = {}) {
  const req = Readable.from([raw ?? JSON.stringify(body)]);
  req.method = method;
  req.headers = { host: '127.0.0.1:4318', origin, authorization: bearer ? `Bearer ${token}` : token };
  let status, text;
  const headers = {};
  await createManagedTerminalHandler({ broker: fake, token: owner, port: 4318, devOrigins: [], reply: (_res, code, data) => { status = code; text = JSON.stringify(data); } })(req, {setHeader: (key, value) => {headers[key] = value;}});
  assert.equal(headers['Cache-Control'], 'no-store');
  assert.equal(typeof status, 'number');
  for (const forbidden of [...Object.keys(secret), 'SECRET_EPOCH', 'SECRET_SHELL', 'SECRET_BOOT', 'SECRET_KERNEL', 'RAW_TMUX_STDERR']) assert.ok(!text.includes(forbidden), `${forbidden} leaked`);
  return { status, data: JSON.parse(text) };
}
const observe = { action: 'observe', workspace_id, lease_id, base_revision: 3 };
const input = { action: 'input', workspace_id, lease_id, base_revision: 3, text: 'hello', confirm: true, confirm_newline: false, operation_id: 'operation_1234' };
const release = { action: 'release', workspace_id, pane_id: pane, base_revision: 3, consent: true, acknowledge: MANAGED_TERMINAL_RELEASE_ACKNOWLEDGEMENT };
test('release success is redacted and forwards explicit consent', async () => {
  for (const mode of ['missing', 'cleared', 'unmanaged']) {
    const fake = broker();
    fake.release = async args => {
      assert.deepEqual(args, { workspaceId: workspace_id, paneId: pane, baseRevision: 3, consent: true, acknowledge: MANAGED_TERMINAL_RELEASE_ACKNOWLEDGEMENT });
      return { released: true, mode, ...secret };
    };
    assert.deepEqual(await request(release, { fake }), { status: 200, data: { ok: true, released: true, mode } });
  }
});
test('release rejects missing consent, incorrect acknowledgement and extra fields before broker dispatch', async () => {
  const fake = broker(); fake.release = async () => assert.fail('Invalid release reached broker');
  for (const [body, status, code] of [
    [{ ...release, consent: false }, 409, 'confirmation_required'],
    [{ ...release, acknowledge: 'wrong' }, 409, 'confirmation_required'],
    [{ ...release, unknown: true }, 400, 'invalid_request'],
  ]) assert.deepEqual(await request(body, { fake }), { status, data: { ok: false, error: code, code } });
});
test('release journal_full maps to 507 without private diagnostics', async () => {
  const fake = broker(); fake.release = async () => { throw Object.assign(Error('RAW_TMUX_STDERR'), { code: 'journal_full', ...secret }); };
  assert.deepEqual(await request(release, { fake }), { status: 507, data: { ok: false, error: 'journal_full', code: 'journal_full' } });
});
test('owner-only method, origin and bounded JSON schema', async () => {
  assert.equal((await request({ action: 'status' }, { method: 'GET' })).status, 405);
  assert.equal((await request({ action: 'status' }, { token: '' })).status, 403);
  assert.equal((await request({ action: 'status' }, { bearer: false })).status, 403);
  assert.equal((await request({ action: 'status', unknown: true })).status, 400);
  assert.equal((await request({ action: 'status' }, { origin: 'https://foreign.test' })).status, 403);
  for (const [body, options] of [[null, { raw: '{' }], [null, { raw: '[]' }], [{ action: 'unknown' }, {}], [{ action: 'adopt' }, {}], [{ ...observe, lease_id: undefined }, {}], [{ ...input, operation_id: undefined }, {}]])
    assert.equal((await request(body, options)).status, 400);
  assert.equal((await request(null, { raw: ' '.repeat(16385) })).status, 413);
  const missing = await request({ action: 'adopt', workspace_id, pane_id: pane });
  assert.equal(missing.status, 409); assert.equal(missing.data.code, 'confirmation_required');
});
test('revision, literal input and operation validation', async () => {
  assert.equal((await request({ ...observe, base_revision: undefined })).status, 400);
  assert.equal((await request({ ...input, base_revision: undefined })).status, 400);
  for (const action of ['observe', 'input']) {
    const fake = broker(); fake[action] = async ({ baseRevision }) => {
      if (baseRevision !== 3) throw Object.assign(Error('stale revision'), { code: 'conflict' });
      return action === 'observe' ? { text: '', bytes: 0, lines: 0, observed_at: 1 } : { operation_id: input.operation_id, applied: true };
    };
    const old = await request({ ...(action === 'observe' ? observe : input), base_revision: 2 }, { fake });
    assert.equal(old.status, 409); assert.equal(old.data.code, 'conflict');
  }
  for (const body of [{ ...input, text: '\x1b[31m' }, { ...input, text: '\r' }, { ...input, operation_id: '!' }]) assert.equal((await request(body)).status, 400);
  const newline = await request({ ...input, text: 'hello\n' });
  assert.equal(newline.status, 409); assert.equal(newline.data.code, 'confirmation_required');
  for (const action of ['observe', 'input']) {
    const fake = broker(); fake[action] = async () => { throw Object.assign(Error('RAW_TMUX_STDERR'), { code: 'conflict', ...secret }); };
    assert.equal((await request(action === 'observe' ? observe : input, { fake })).status, 409);
  }
});
test('broker failures map to fixed statuses, never to raw diagnostics', async () => {
  for (const [code, status] of [['revoked', 410], ['expired', 410], ['pending', 409], ['conflict', 409], ['busy', 429], ['timeout', 504], ['provider_error', 502], ['identity_changed', 409], ['unavailable', 409]]) {
    const fake = broker(); fake.observe = async () => { throw Object.assign(Error('RAW_TMUX_STDERR'), { code, ...secret }); };
    const result = await request(observe, { fake });
    assert.equal(result.status, status); assert.equal(result.data.code, code);
  }
  for (const code of ['pending', 'conflict']) {
    const fake = broker(); fake.input = async () => { throw Object.assign(Error('RAW_TMUX_STDERR'), { code }); };
    const result = await request(input, { fake });
    assert.equal(result.status, 409); assert.equal(result.data.code, code);
  }
});
test('redacted success results and bounded one-shot observation', async () => {
  for (const body of [{ action: 'status' }, { action: 'reconcile', workspace_id }, { action: 'adopt', workspace_id, pane_id: pane, consent: true, base_revision: 3 }, { action: 'grant', workspace_id, pane_id: pane, scope: 'observe', consent: true, base_revision: 3 }, observe, input, { action: 'revoke', lease_id }]) {
    assert.equal((await request(body)).status, 200);
  }
  assert.equal((await request(observe)).data.text, 'bounded output');
  assert.equal((await request({ action: 'grant', workspace_id, pane_id: pane, scope: 'observe', consent: true, base_revision: 3 })).data.lease.lease_id, lease_id);
  assert.equal((await request({ action: 'reconcile', workspace_id })).data.entries[0].pane_id, pane);
});
