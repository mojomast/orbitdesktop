// Group (member) rooms: reply gating, tolerant handles, interim bubbles, and delta prompts.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createSharedAgents, mentionedAgents, resolveHandle, namedAgents, parseDelegate } from '../server/shared-agents.mjs';

const MEMBERS = [{ id: 'hermes', label: 'Hermes' }, { id: 'mr_india', label: 'MR.INDIA' }, { id: 'pipi', label: 'pipi' }];
const IDS = MEMBERS.map(m => m.id);

test('handles match case- and punctuation-insensitively', () => {
  for (const typed of ['@mr.india', '@mr-india', '@mrindia', '@MR_INDIA', '@Mr.India,']) assert.equal(mentionedAgents(`hey ${typed} go`, IDS).mr_india, true, typed);
  assert.equal(mentionedAgents('mail kyle@mrindia.com', IDS).mr_india, false);
  assert.equal(resolveHandle('mr.india', IDS), 'mr_india');
  assert.equal(resolveHandle('@PiPi', IDS), 'pipi');
  assert.equal(resolveHandle('nobody', IDS), '');
  assert.equal(parseDelegate('```delegate\ntarget: mr.india\ntask: build it\n```').to, 'mr_india');
});

test('plain-word names count as addressing', () => {
  assert.deepEqual(namedAgents('Hermes, can you check?', IDS, id => MEMBERS.find(m => m.id === id).label), ['hermes']);
  assert.deepEqual(namedAgents('nothing for anyone', IDS, id => MEMBERS.find(m => m.id === id).label), []);
});

function room(defaultResponder, outputs = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'grp-'));
  const started = []; let n = 0;
  const gateways = {
    async startSpeaker(a) { started.push(a); n += 1; return { runId: `run_${String(n).padStart(32, '0')}`, started: Date.now() }; },
    async pollSpeaker(r) { const o = outputs[r.speaker]; return { status: 'completed', output: typeof o === 'function' ? o() : (o || '(quiet)') }; },
    async stopSpeaker() {},
  };
  const r = createSharedAgents({ directory: dir, gateways, members: MEMBERS, defaultResponder, advanceIntervalMs: 20 });
  const call = body => new Promise((resolve, reject) => r.handle((_res, status, obj) => (status >= 400 ? reject(new Error(obj.error)) : resolve(obj)), {}, { workspace_id: '0b0b0b0b-0000-4000-8000-00000000c0de', pane_id: '11111111-1111-4111-8111-111111111111', ...body }));
  const settle = async () => { for (let i = 0; i < 60; i += 1) { const s = await call({ operation: 'state' }); if (!s.running && !s.queued.length) return s; await new Promise(x => setTimeout(x, 25)); } throw new Error('room did not settle'); };
  return { r, call, settle, started, done: () => { r.dispose(); fs.rmSync(dir, { recursive: true, force: true }); } };
}

test('an un-mentioned owner message goes to the single default responder', async () => {
  const t = room('pipi', { pipi: 'hi' });
  try { await t.call({ operation: 'post', text: 'hello there' }); await t.settle(); assert.deepEqual(t.started.map(s => s.speaker), ['pipi']); } finally { t.done(); }
});

test("everyone answers only when the group chose 'all'", async () => {
  const t = room('all', { hermes: 'a', mr_india: 'b', pipi: 'c' });
  try { await t.call({ operation: 'post', text: 'hello there' }); await t.settle(); assert.deepEqual(t.started.map(s => s.speaker).sort(), IDS.slice().sort()); } finally { t.done(); }
});

test('@mention and plain-name routing override the default', async () => {
  const t = room('hermes', { mr_india: 'ok', pipi: 'ok' });
  try {
    await t.call({ operation: 'post', text: '@mr.india build it' }); await t.settle();
    await t.call({ operation: 'post', text: 'pipi, test it please' }); await t.settle();
    assert.deepEqual(t.started.map(s => s.speaker), ['mr_india', 'pipi']);
  } finally { t.done(); }
});

test('an agent reply wakes only the members it @mentions; @all from an agent wakes no one', async () => {
  const t = room('hermes', { hermes: 'over to you @pipi @all', pipi: 'done @kyle' });
  try {
    await t.call({ operation: 'post', text: 'start' }); await t.settle();
    assert.deepEqual(t.started.map(s => s.speaker), ['hermes', 'pipi']);
  } finally { t.done(); }
});

test('later turns get only new messages (delta prompt)', async () => {
  const t = room('hermes', { hermes: 'first reply' });
  try {
    await t.call({ operation: 'post', text: 'message one' }); await t.settle();
    await t.call({ operation: 'post', text: 'message two' }); await t.settle();
    const second = t.started[1].prompt;
    assert.match(second, /New messages since your last turn/);
    assert.match(second, /Kyle \(owner\): message two/);
    assert.doesNotMatch(second, /message one/);
  } finally { t.done(); }
});

test('interim assistant texts post as separate bubbles and the final is not duplicated', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'grp-'));
  let polls = 0;
  const gateways = {
    async startSpeaker() { return { runId: `run_${'1'.padStart(32, '0')}`, started: Date.now() }; },
    async pollSpeaker() { polls += 1; return polls < 3 ? { status: 'running', interim: polls === 1 ? ['working on it'] : ['working on it', 'halfway'] } : { status: 'completed', output: 'all done', interim: ['working on it', 'halfway', 'all done'] }; },
    async stopSpeaker() {},
  };
  const r = createSharedAgents({ directory: dir, gateways, members: MEMBERS, defaultResponder: 'hermes', advanceIntervalMs: 20 });
  const call = body => new Promise(resolve => r.handle((_res, _s, obj) => resolve(obj), {}, { workspace_id: '0b0b0b0b-0000-4000-8000-00000000c0de', pane_id: '22222222-2222-4222-8222-222222222222', ...body }));
  try {
    await call({ operation: 'post', text: 'go' });
    let s; for (let i = 0; i < 80; i += 1) { s = await call({ operation: 'state' }); if (!s.running && s.messages.length >= 4) break; await new Promise(x => setTimeout(x, 25)); }
    assert.deepEqual(s.messages.map(m => m.text), ['go', 'working on it', 'halfway', 'all done']);
  } finally { r.dispose(); fs.rmSync(dir, { recursive: true, force: true }); }
});
