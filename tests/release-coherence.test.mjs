import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { themes, themePatch } from '../src/themes.ts';
import { initial, validate } from '../src/model.ts';
import { applyOperation } from '../src/workspace-ops.ts';
import { validateWorkspaceRequest } from '../server/workspace-contract.mjs';

const workspace_id = '12345678-1234-1234-1234-123456789abc';
test('all release theme personalities use the authoritative v1 appearance contract', () => {
  assert.equal(themes.length, 14);
  assert.equal(new Set(themes.map(theme => theme.name)).size, themes.length);
  for (const theme of themes) {
    const patch = themePatch(theme.name);
    const operation = { action: 'patch_appearance', patch };
    assert.doesNotThrow(() => validateWorkspaceRequest({ workspace_id, action: 'apply', base_revision: 1, operations: [operation] }), theme.name);
    const before = initial();
    const after = applyOperation(structuredClone(before), operation);
    assert.deepEqual(after.monitors, before.monitors, 'Theme must not replace pane identities');
    assert.doesNotThrow(() => validate(after), theme.name);
    assert.doesNotThrow(() => validateWorkspaceRequest({ workspace_id, action: 'sync', base_revision: 1, state: after }), theme.name);
    assert.deepEqual(after.appearance, patch);
    assert.ok(fs.existsSync(new URL('../public' + patch.wallpaper, import.meta.url)), theme.name + ' wallpaper must ship');
    assert.equal(Object.hasOwn(patch, 'name'), false);
    assert.equal(Object.hasOwn(patch, 'description'), false);
  }
});
