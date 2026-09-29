import { test } from 'node:test';
import assert from 'node:assert/strict';
import Ajv from 'ajv';
import { initial } from '../src/model.ts';
import { contract } from '../contracts/workspace-v1.mjs';
import { validateWorkspaceRequest, workspaceLimits } from '../server/workspace-contract.mjs';

const workspaceId = '12345678-1234-1234-1234-123456789abc';

test('workspace command schema compiles with strict Ajv', () => {
  const ajv = new Ajv({ strict: true, allErrors: false, coerceTypes: false, useDefaults: false, removeAdditional: false });
  assert.equal(typeof ajv.compile(contract.schema), 'function');
});

test('request validation requires a correctly shaped request and never coerces or mutates it', () => {
  const valid = { workspace_id: workspaceId, action: 'apply', base_revision: 1, operations: [{ action: 'sidebar', hidden: true }] };
  const copy = structuredClone(valid);
  assert.doesNotThrow(() => validateWorkspaceRequest(valid));
  assert.deepEqual(valid, copy);

  for (const body of [null, [], {}, { ...valid, workspace_id: 'bad' }, { ...valid, base_revision: '1' }, { ...valid, action: 'unknown' }]) {
    const before = structuredClone(body);
    assert.throws(() => validateWorkspaceRequest(body));
    assert.deepEqual(body, before);
  }
});

test('unknown fields are rejected at the command and nested operation levels', () => {
  const request = { workspace_id: workspaceId, action: 'apply', base_revision: 1, operations: [{ action: 'sidebar', hidden: true }] };
  assert.throws(() => validateWorkspaceRequest({ ...request, surprise: true }));
  assert.throws(() => validateWorkspaceRequest({ ...request, operations: [{ ...request.operations[0], surprise: true }] }));
});

test('operation count and encoded request byte limits are exposed and enforced', () => {
  assert.equal(workspaceLimits.maxOperations, 32);
  assert.equal(workspaceLimits.maxRequestBytes, 150000);
  const base = { workspace_id: workspaceId, action: 'apply', base_revision: 1 };
  assert.doesNotThrow(() => validateWorkspaceRequest({ ...base, operations: Array(32).fill({ action: 'sidebar', hidden: true }) }));
  assert.throws(() => validateWorkspaceRequest({ ...base, operations: Array(33).fill({ action: 'sidebar', hidden: true }) }));
  const withinByteLimit = JSON.stringify({ ...base, action: 'jev_suggest', request: 'a'.repeat(12000), api_key: 'k'.repeat(4096), consent: true });
  assert.ok(Buffer.byteLength(withinByteLimit) < workspaceLimits.maxRequestBytes);
  assert.ok(Buffer.byteLength(JSON.stringify({ ...base, action: 'jev_suggest', request: 'a'.repeat(150000), api_key: 'k', consent: true })) > workspaceLimits.maxRequestBytes);
});

test('current command and operation examples validate', () => {
  assert.doesNotThrow(() => validateWorkspaceRequest({ workspace_id: workspaceId, action: 'sync', state: initial() }));
  assert.doesNotThrow(() => validateWorkspaceRequest({ workspace_id: workspaceId, action: 'apply', base_revision: 3, operations: [
    { action: 'set_view', view: 'spatial' },
    { action: 'set_appearance', appearance: { background: '#123456', wallpaper: '/neon-horizon-v1.svg' } },
    { action: 'update_window', window_id: 'window-1', frame: { x: 10, y: 20, width: 700, height: 450, z: 5 } },
  ] }));
});
