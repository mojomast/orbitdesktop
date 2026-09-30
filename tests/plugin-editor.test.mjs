import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rowsFromConfig, draftConfig, planConfigChange, parseConfigJson, inferConfigType } from '../src/plugin-config-editor.ts';
import { windowDraftValues, assembleWindowSettings, WINDOW_SETTING_KEYS } from '../src/plugin-window-editor.ts';

const previous = { title: 'Keep', count: 1, pinned: true };

test('config rows infer primitive types and round-trip through validation', () => {
  const rows = rowsFromConfig(previous);
  assert.deepEqual(rows.map(row => row.type), ['string', 'number', 'boolean']);
  assert.equal(inferConfigType(false), 'boolean');
  assert.equal(inferConfigType(2.5), 'number');
  assert.deepEqual(draftConfig(rows).config, previous);
});

test('config draft rejects invalid keys, values and duplicates inline', () => {
  assert.match(draftConfig([{ id: 1, key: '1bad', type: 'string', text: 'x', bool: false }]).errors[1], /letter/);
  assert.equal(draftConfig([{ id: 1, key: 'count', type: 'number', text: 'abc', bool: false }]).config, null);
  const duplicate = draftConfig([{ id: 1, key: 'a', type: 'string', text: '', bool: false }, { id: 2, key: 'a', type: 'string', text: '', bool: false }]);
  assert.match(duplicate.errors[2], /Duplicate/);
  const many = Array.from({ length: 33 }, (_, index) => ({ id: index + 1, key: `k${index}`, type: 'string', text: 'v', bool: false }));
  assert.match(draftConfig(many).formError, /32/);
});

test('config planning preserves untouched fields and only replaces when removing', () => {
  const patch = planConfigChange(previous, { title: 'Keep', count: 2, pinned: true });
  assert.equal(patch.action, 'plugin_patch_config');
  assert.deepEqual(patch.operation.patch, { count: 2 });
  assert.deepEqual(patch.removed, []);
  const added = planConfigChange(previous, { ...previous, note: 'hi' });
  assert.deepEqual(added.operation.patch, { note: 'hi' });
  const removed = planConfigChange(previous, { count: 2, pinned: true });
  assert.equal(removed.action, 'plugin_configure');
  assert.deepEqual(removed.operation.config, { count: 2, pinned: true });
  assert.deepEqual(removed.removed, ['title']);
  assert.equal(planConfigChange(previous, { ...previous }), null);
});

test('advanced JSON parsing reuses contract validation', () => {
  assert.ok(parseConfigJson('{').error);
  assert.ok(parseConfigJson('[]').error);
  assert.ok(parseConfigJson(JSON.stringify({ bad: [] })).error);
  assert.deepEqual(parseConfigJson(JSON.stringify({ a: 1 })).config, { a: 1 });
});

const original = { name: 'Notes', fontSize: 19, opacity: 0.5, diagonal: 32, aspect: '16:9', height: 0, distance: 0, pitch: 0, yaw: 0, offset: 0 };

test('window planning emits only changed settings (partial patch)', () => {
  const values = windowDraftValues(original);
  const result = assembleWindowSettings(original, { ...values, fontSize: '22' });
  assert.deepEqual(result.settings, { fontSize: 22 });
  assert.deepEqual(result.errors, {});
  assert.deepEqual(assembleWindowSettings(original, { ...values, diagonal: '60', aspect: '21:9' }).settings, { diagonal: 60, aspect: '21:9' });
  assert.deepEqual(assembleWindowSettings(original, values).changedKeys, []);
});

test('window planning validates ranges without rejecting valid model names or geometry', () => {
  const values = windowDraftValues(original);
  assert.ok(assembleWindowSettings(original, { ...values, fontSize: '99' }).errors.fontSize);
  assert.deepEqual(assembleWindowSettings(original, { ...values, name: '' }).settings, { name: '' });
  assert.deepEqual(assembleWindowSettings(original, { ...values, name: ' Notes ' }).settings, { name: ' Notes ' });
  assert.deepEqual(assembleWindowSettings(original, { ...values, diagonal: '100001' }).errors, {});
  assert.ok(assembleWindowSettings(original, { ...values, aspect: '5:4' }).errors.aspect);
});

test('optional window settings stay omitted when blank', () => {
  const noOpacity = { ...original };
  delete noOpacity.opacity;
  const values = windowDraftValues(noOpacity);
  assert.equal(values.opacity, '');
  assert.deepEqual(assembleWindowSettings(noOpacity, values).settings, {});
  assert.deepEqual(assembleWindowSettings(noOpacity, { ...values, opacity: '0.7' }).settings, { opacity: 0.7 });
});

test('frame settings require all parts and validate geometry', () => {
  const values = windowDraftValues(original);
  assert.ok(assembleWindowSettings(original, { ...values, 'frame.x': '1' }).errors.frame);
  const full = assembleWindowSettings(original, { ...values, 'frame.x': '1', 'frame.y': '2', 'frame.width': '800', 'frame.height': '600', 'frame.z': '10' });
  assert.deepEqual(full.settings.frame, { x: 1, y: 2, width: 800, height: 600, z: 10 });
  const invalid = assembleWindowSettings(original, { ...values, 'frame.x': '1', 'frame.y': '2', 'frame.width': '10', 'frame.height': '600', 'frame.z': '10' });
  assert.ok(invalid.errors['frame.width']);
});

test('supported setting keys match the existing plugin_window contract', () => {
  assert.deepEqual([...WINDOW_SETTING_KEYS].sort(), ['aspect', 'diagonal', 'distance', 'fontSize', 'frame', 'height', 'name', 'offset', 'opacity', 'pitch', 'spatialFontSize', 'yaw'].sort());
});
