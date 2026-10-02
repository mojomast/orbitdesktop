import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { createDataRecipes } from '../server/data-recipes.mjs';
import { recipeFingerprintValue } from '../contracts/data-recipes-v1.mjs';
import { boundedSql, inputStatus, resultCsv, recipeFingerprint, validateRecipeImport } from '../src/data-query.ts';
function recipe() {
  const value = { id: randomUUID(), name: 'Synthetic', engine: { name: 'duckdb-wasm', npmVersion: '1.32.0', engineVersion: 'v1.4.3' }, inputs: [{ name: 'synthetic.csv', table: 'input_1', kind: 'csv', bytes: 10, sha256: 'a'.repeat(64) }], sql: 'SELECT * FROM input_1', params: [] };
  return { ...value, inputHash: createHash('sha256').update(JSON.stringify(recipeFingerprintValue(value))).digest('hex') };
}
test('private CAS survives restart, exact retries and conflicts preserve committed state', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-data-recipes-')), workspace_id = randomUUID();
  const options = { root, workspaceRead: id => id === workspace_id ? { id } : null };
  try {
    const store = createDataRecipes(options), r = recipe();
    const request = { action: 'save', workspace_id, base_revision: 0, op_id: randomUUID(), recipe: r };
    assert.equal((await store.dispatch(request)).revision, 1);
    assert.equal((await createDataRecipes(options).dispatch(request)).replayed, true);
    await assert.rejects(store.dispatch({ ...request, recipe: { ...r, name: 'Different' } }), { code: 'operation_mismatch' });
    await assert.rejects(store.dispatch({ ...request, op_id: randomUUID() }), e => e.code === 'conflict' && e.current.revision === 1);
    const raced = await Promise.allSettled([store.dispatch({ ...request, base_revision: 1, op_id: randomUUID() }), store.dispatch({ ...request, base_revision: 1, op_id: randomUUID() })]);
    assert.equal(raced.filter(r => r.status === 'fulfilled').length, 1);
    assert.equal(fs.statSync(path.join(root, 'data-recipes', `${workspace_id}.json`)).mode & 0o777, 0o600);
    await assert.rejects(store.dispatch({ action: 'list', workspace_id, extra: true }), { code: 'invalid_request' });
    await assert.rejects(store.dispatch({ action: 'list', workspace_id: randomUUID() }), { code: 'unavailable' });
    await assert.rejects(store.dispatch({ ...request, base_revision: 2, op_id: randomUUID(), recipe: { ...r, sql: 'SELECT 2' } }), { code: 'invalid_request' });
    await store.dispatch({ action: 'delete', workspace_id, recipe_id: r.id, base_revision: 2, op_id: randomUUID() });
    assert.deepEqual((await store.dispatch({ action: 'list', workspace_id })).recipes, []);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
test('symlink and corrupt private sidecars fail closed', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-data-recipes-')), workspace_id = randomUUID();
  try {
    fs.symlinkSync(root, path.join(root, 'data-recipes'));
    const store = createDataRecipes({ root, workspaceRead: () => ({}) });
    await assert.rejects(store.dispatch({ action: 'list', workspace_id }), { code: 'unavailable' });
    fs.unlinkSync(path.join(root, 'data-recipes')); fs.mkdirSync(path.join(root, 'data-recipes'), { mode: 0o700 });
    fs.writeFileSync(path.join(root, 'data-recipes', `${workspace_id}.json`), '{}', { mode: 0o600 });
    await assert.rejects(store.dispatch({ action: 'list', workspace_id }), { code: 'unavailable' });
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
test('existing insecure recipe directories and files fail closed without implicit chmod', async () => {
  const root = fs.mkdtempSync('/tmp/opencode/orbit-recipes-mode-'), workspace_id = randomUUID();
  try {
    const store = createDataRecipes({ root, workspaceRead: () => ({}) });
    const dir = path.join(root, 'data-recipes'); fs.mkdirSync(dir, { mode: 0o700 }); fs.chmodSync(dir, 0o755);
    await assert.rejects(store.dispatch({ action: 'list', workspace_id }), { code: 'unavailable' });
    assert.equal(fs.statSync(dir).mode & 0o777, 0o755);
    fs.chmodSync(dir, 0o700);
    await store.dispatch({ action: 'save', workspace_id, base_revision: 0, op_id: randomUUID(), recipe: recipe() });
    const file = path.join(dir, `${workspace_id}.json`); fs.chmodSync(file, 0o644);
    await assert.rejects(store.dispatch({ action: 'list', workspace_id }), { code: 'unavailable' });
    assert.equal(fs.statSync(file).mode & 0o777, 0o644);
    fs.chmodSync(file, 0o600);
    assert.equal((await store.dispatch({ action: 'list', workspace_id })).revision, 1);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
test('query boundary is one derived SELECT; exact input verification and escaped exports', () => {
  assert.match(boundedSql("WITH a AS (SELECT ';' AS x) SELECT * FROM a;"), /^SELECT \* FROM \(WITH/);
  for (const sql of ['SELECT 1; SELECT 2', 'SET enable_external_access=true', 'COPY input_1 TO \'x\'', 'SELECT 1 /*']) assert.throws(() => boundedSql(sql));
  const expected = recipe().inputs;
  assert.equal(inputStatus(expected, [])[0].status, 'missing');
  assert.equal(inputStatus(expected, expected)[0].status, 'verified');
  assert.equal(inputStatus(expected, [{ ...expected[0], sha256: 'b'.repeat(64) }])[0].status, 'changed');
  assert.equal(inputStatus(expected, [{ ...expected[0], table: 'input_2' }])[0].status, 'changed');
  assert.equal(inputStatus(expected, [{ ...expected[0], kind: 'json' }])[0].status, 'changed');
  const pair = [...expected, { ...expected[0], name: 'second.csv', table: 'input_2' }];
  assert.deepEqual(inputStatus(pair, [{ ...pair[1], table: 'input_1' }, { ...pair[0], table: 'input_2' }]).map(i => i.status), ['changed', 'changed']);
  assert.match(resultCsv({ columns: [{ name: 'x' }], rows: [['a"b\nc']] }), /"a""b\nc"/);
  const r = recipe();
  assert.deepEqual(recipeFingerprint(r), recipeFingerprintValue(r));
  assert.equal(validateRecipeImport(r), true);
  assert.equal(validateRecipeImport({ ...r, result: null }), false);
  assert.equal(validateRecipeImport({ ...r, fileBytes: 'not allowed' }), false);
});
