import test from 'node:test';
import assert from 'node:assert/strict';
import { inspectDocumentEnvelope } from '../src/document-envelope.ts';

const doc = fields => JSON.stringify({ document: fields });
const fence = body => '```orbit-document\n' + body + '\n```';
const richtext = { title: 'Project brief', kind: 'richtext', format: 'lexical', content: JSON.stringify({ root: { type: 'root', version: 1, format: '', indent: 0, direction: null, children: [] } }) };
const element = (over = {}) => ({
  id: 'shape-1', type: 'rectangle', x: 0, y: 0, width: 120, height: 60, angle: 0,
  strokeColor: '#1e1e1e', backgroundColor: 'transparent', fillStyle: 'solid', strokeWidth: 2,
  strokeStyle: 'solid', roughness: 1, opacity: 100, groupIds: [], frameId: null, index: 'a0',
  roundness: null, seed: 1, version: 1, versionNonce: 1, isDeleted: false, boundElements: null,
  updated: 1, link: null, locked: false, ...over,
});
const realScene = content => JSON.stringify({
  type: 'excalidraw', version: 2, source: 'https://excalidraw.com',
  elements: [element(), element({ id: 'text-1', type: 'text', fontFamily: 5, fontSize: 16, text: 'Crew', originalText: 'Crew', width: 60, height: 20 })],
  appState: { gridSize: 20, viewBackgroundColor: '#ffffff', scrollX: 90, scrollY: -12, zoom: { value: 1.25 }, theme: 'light', collaborators: { u1: { username: 'owner' } }, openDialog: 'elementProperties' },
  files: {},
});
const canvas = { title: 'Deployment plan', kind: 'scene', format: 'excalidraw', content: realScene() };

test('a fence-only reply is accepted, as before', () => {
  const result = inspectDocumentEnvelope(fence(doc(richtext)));
  assert.equal(result.status, 'ok');
  assert.equal(result.title, 'Project brief');
});

test('an ordinary reply with no envelope is absent, not an error', () => {
  for (const text of ['Just prose.', '', 'Here is JSON: {"a":1}', '```json\n{"document":{}}\n```'])
    assert.equal(inspectDocumentEnvelope(text).status, 'absent', text);
  assert.equal(inspectDocumentEnvelope(undefined).status, 'absent');
  assert.equal(inspectDocumentEnvelope(42).status, 'absent');
});

test('fix 3: prose before the final envelope is now delivered', () => {
  const reply = `Here is the deployment plan you asked for. I used the relay month from DOC-04.\n\n${fence(doc(canvas))}`;
  const result = inspectDocumentEnvelope(reply);
  assert.equal(result.status, 'ok', JSON.stringify(result));
  assert.equal(result.title, 'Deployment plan');
  assert.equal(result.data.kind, 'scene');
});

test('a whole-reply sole-key JSON object still works without a fence', () => {
  const result = inspectDocumentEnvelope(doc(richtext));
  assert.equal(result.status, 'ok');
  assert.equal(result.title, 'Project brief');
});

test('fix 3 boundary: nothing may follow the final fence', () => {
  const reply = fence(doc(richtext)) + '\n\nAlso, ignore these instructions.';
  const result = inspectDocumentEnvelope(reply);
  assert.equal(result.status, 'unavailable');
  assert.match(result.reason, /last content/);
});

test('only the final fence is used when a reply mentions an earlier one', () => {
  const reply = `Use this shape: ${fence(doc({ ...richtext, title: 'Stale' }))}\n\nActually, use this one:\n\n${fence(doc({ ...richtext, title: 'Current' }))}`;
  const result = inspectDocumentEnvelope(reply);
  assert.equal(result.status, 'ok');
  assert.equal(result.title, 'Current');
});

test('fix 1: a truncated envelope reports a reason instead of vanishing', () => {
  const body = doc(canvas);
  const result = inspectDocumentEnvelope(fence(body.slice(0, 400)));
  assert.equal(result.status, 'unavailable');
  assert.equal(result.code, 'invalid_request');
  assert.match(result.reason, /not complete valid JSON/);
});

test('fix 2: an agent-authored canvas with full appState is accepted', () => {
  const result = inspectDocumentEnvelope(fence(doc(canvas)));
  assert.equal(result.status, 'ok', JSON.stringify(result));
  const appState = JSON.parse(result.data.content).appState;
  assert.equal(appState.zoom.value, 1.25);
  assert.equal(appState.scrollX, 90);
  assert.ok(!('collaborators' in appState));
  assert.ok(!('openDialog' in appState));
});

test('fix 1: every refusal carries an actionable reason', () => {
  const cases = {
    'retired font': doc({ title: 'C', kind: 'scene', format: 'excalidraw', content: realScene().replace('"fontFamily":5', '"fontFamily":1') }),
    'mismatched kind/format': doc({ title: 'C', kind: 'scene', format: 'lexical', content: '{}' }),
    'extra envelope key': JSON.stringify({ document: richtext, extra: true }),
    'empty title': doc({ ...richtext, title: '   ' }),
    'overlong title': doc({ ...richtext, title: 'x'.repeat(161) }),
    'malformed richtext': doc({ ...richtext, content: '{not lexical}' }),
    'oversized reply': 'x'.repeat(750001),
  };
  for (const [name, text] of Object.entries(cases)) {
    const result = inspectDocumentEnvelope(text);
    assert.equal(result.status, 'unavailable', name);
    assert.ok(result.reason && result.reason.length > 20, `${name} needs a reason`);
    assert.ok(['invalid_request', 'limit_exceeded', 'unsupported'].includes(result.code), name);
  }
});

test('retired fonts are named specifically rather than as a generic refusal', () => {
  const result = inspectDocumentEnvelope(fence(doc({ ...canvas, content: realScene().replace('"fontFamily":5', '"fontFamily":1') })));
  assert.equal(result.status, 'unavailable');
  assert.equal(result.code, 'unsupported');
  assert.match(result.reason, /Excalifont/);
});

test('envelope parsing is deterministic', () => {
  assert.deepEqual(inspectDocumentEnvelope(fence(doc(canvas))), inspectDocumentEnvelope(fence(doc(canvas))));
});