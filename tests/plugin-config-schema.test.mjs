import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  validatePluginConfigSchema,
  validateConfigAgainstSchema,
  configDefaults,
  applyConfigDefaults,
  assertValidPluginConfig,
  MAX_CONFIG_SCHEMA_FIELDS,
} from '../src/plugin-config-schema.ts';
import { rowsFromConfig, draftConfig, planConfigChange, parseConfigJson } from '../src/plugin-config-editor.ts';

// Cross-language fixtures shared with tests/plugin-config-schema.test.py.
const fixture = JSON.parse(readFileSync(fileURLToPath(new URL('./fixtures/plugin-config-schema.json', import.meta.url)), 'utf8'));

test('author config schema accepts and normalizes every shared valid fixture', () => {
  for (const entry of fixture.valid) {
    assert.deepEqual(validatePluginConfigSchema(entry.schema), entry.normalized, entry.name);
  }
});

test('author config schema rejects every shared invalid fixture', () => {
  for (const entry of fixture.invalid) {
    assert.throws(() => validatePluginConfigSchema(entry.schema), /Invalid plugin config schema/, entry.name);
  }
});

test('author config schema is bounded and closed', () => {
  const fields = Array.from({ length: MAX_CONFIG_SCHEMA_FIELDS + 1 }, (_, index) => ({ key: `k${index}`, type: 'string' }));
  assert.throws(() => validatePluginConfigSchema({ fields }), /at most 32/);
  assert.throws(() => validatePluginConfigSchema({ fields: [{ key: 'a', type: 'string', regex: '.*' }] }), /unsupported property/);
  assert.throws(() => validatePluginConfigSchema({ fields: [{ key: 'a', type: 'string', template: '{{x}}' }] }), /unsupported property/);
  assert.throws(() => validatePluginConfigSchema({ fields: [{ key: 'a', type: 'string', title: 'x'.repeat(61) }] }), /title/);
  assert.throws(() => validatePluginConfigSchema({ fields: [{ key: 'a', type: 'number', min: Number.NaN }] }), /finite/);
});

test('required string defaults must not be empty so effective defaults stay valid', () => {
  assert.throws(() => validatePluginConfigSchema({ fields: [{ key: 'a', type: 'string', required: true, default: '' }] }), /required string default/);
  assert.equal(validatePluginConfigSchema({ fields: [{ key: 'a', type: 'string', default: '' }] }).fields[0].default, '');
  const optional = validatePluginConfigSchema({ fields: [{ key: 'a', type: 'string', default: '' }] });
  assert.deepEqual(validateConfigAgainstSchema({ a: '' }, optional), { errors: {}, formError: '' });
  const required = validatePluginConfigSchema({ fields: [{ key: 'a', type: 'string', required: true }] });
  assert.match(validateConfigAgainstSchema({ a: '' }, required).errors.a, /Required/);
});

test('config validation against a schema matches every shared config fixture', () => {
  for (const entry of fixture.configs) {
    const result = validateConfigAgainstSchema(entry.config, entry.schema);
    assert.deepEqual(Object.keys(result.errors).sort(), entry.errors.slice().sort(), entry.name);
  }
  assert.deepEqual(validateConfigAgainstSchema({ anything: true }, null), { errors: {}, formError: '' });
});

test('declared defaults fill missing keys but never override saved owner values', () => {
  const schema = validatePluginConfigSchema({ fields: [
    { key: 'title', type: 'string', default: 'Notes' },
    { key: 'count', type: 'number', default: 5 },
    { key: 'pinned', type: 'boolean', default: false },
  ] });
  assert.deepEqual(configDefaults(schema), { title: 'Notes', count: 5, pinned: false });
  assert.deepEqual(applyConfigDefaults({ title: 'Mine' }, schema), { title: 'Mine', count: 5, pinned: false });
  assert.deepEqual(applyConfigDefaults({ title: 'Mine', count: 0, pinned: true }, schema), { title: 'Mine', count: 0, pinned: true });
});

test('primitive contract and schema validation combine without regressing schema-less configs', () => {
  assert.deepEqual(assertValidPluginConfig({ anything: 1 }), { anything: 1 });
  const schema = validatePluginConfigSchema({ fields: [{ key: 'count', type: 'number', max: 10 }] });
  assert.deepEqual(assertValidPluginConfig({ count: 3 }, schema), { count: 3 });
  assert.throws(() => assertValidPluginConfig({ count: 30 }, schema), /count/);
  assert.throws(() => assertValidPluginConfig({ count: [1] }, schema), /Invalid plugin config/);
});

test('schema rows render declared fields and keep additional saved keys', () => {
  const schema = validatePluginConfigSchema({ fields: [
    { key: 'mode', type: 'string', enum: ['light', 'dark'], default: 'light' },
    { key: 'count', type: 'number', min: 0, max: 10 },
    { key: 'pinned', type: 'boolean' },
  ] });
  const rows = rowsFromConfig({ count: 4, extra: 'kept' }, schema);
  assert.deepEqual(rows.map(row => row.key), ['mode', 'count', 'pinned', 'extra']);
  assert.equal(rows[0].present, false);
  assert.equal(rows[0].schema?.enum?.length, 2);
  assert.equal(rows[1].present, true);
  assert.equal(rows[1].text, '4');
  assert.equal(rows[3].schema, undefined);
  assert.deepEqual(draftConfig(rows, schema).config, { count: 4, extra: 'kept' });
});

test('an untouched declared default is not silently written, but a typed value is', () => {
  const schema = validatePluginConfigSchema({ fields: [{ key: 'title', type: 'string', default: 'Notes' }] });
  const rows = rowsFromConfig({}, schema);
  const untouched = draftConfig(rows, schema);
  assert.deepEqual(untouched.config, {});
  assert.deepEqual(planConfigChange({}, untouched.config), null);
  rows[0].text = 'Mine';
  assert.deepEqual(draftConfig(rows, schema).config, { title: 'Mine' });
});

test('required fields without defaults block saving and enums/ranges report inline', () => {
  const schema = validatePluginConfigSchema({ fields: [
    { key: 'title', type: 'string', required: true },
    { key: 'mode', type: 'string', enum: ['light', 'dark'] },
    { key: 'count', type: 'number', min: 0, max: 10 },
  ] });
  const missing = draftConfig(rowsFromConfig({ mode: 'sepia', count: 99 }, schema), schema);
  assert.equal(missing.config, null);
  assert.match(missing.errors[1], /Required/);
  assert.match(missing.errors[2], /Choose one/);
  assert.match(missing.errors[3], /at most/);
  const valid = draftConfig(rowsFromConfig({ title: 'Keep', mode: 'dark', count: 5 }, schema), schema);
  assert.deepEqual(valid.config, { title: 'Keep', mode: 'dark', count: 5 });
});

test('advanced JSON uses the same schema validation as the form', () => {
  const schema = validatePluginConfigSchema({ fields: [{ key: 'mode', type: 'string', enum: ['light', 'dark'] }, { key: 'count', type: 'number', min: 0 }] });
  assert.match(parseConfigJson(JSON.stringify({ mode: 'sepia' }), schema).error, /mode/);
  assert.match(parseConfigJson(JSON.stringify({ count: -1 }), schema).error, /count/);
  assert.deepEqual(parseConfigJson(JSON.stringify({ mode: 'dark', count: 0, extra: true }), schema).config, { mode: 'dark', count: 0, extra: true });
  // Schema-less parsing is unchanged.
  assert.deepEqual(parseConfigJson(JSON.stringify({ a: 1 })).config, { a: 1 });
});
