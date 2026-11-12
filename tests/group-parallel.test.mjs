// Parallel group turns: concurrent members, per-member queueing, sequential option, Stop all.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createSharedAgents } from '../server/shared-agents.mjs';

const MEMBERS = [{ id: 'hermes', label: 'Hermes' }, { id: 'mr_india', label: 'MR.INDIA' }, { id: 'pipi', label: 'pipi' }];
let seq = 0;

function room({ parallel, script }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'par-'));
  const log = []; const live = new Map(); const stopped = [];
  const gateways = {
    async startSpeaker(a) { const runId = `run_${String(++seq).padStart(32, '0')}`; live.set(runId, { speaker: a.speaker, polls: 0 }); log.push({ ev: 'start', speaker: a.speaker, prompt: a.prompt, inFlight: [...live.values()].map(x => x.speaker) }); return { runId, started: Date.now() }; },
    async pollSpeaker(r) { const x = live.get(r.runId); if (!x) return { status: 'failed', error: 'gone' }; x.polls += 1; const s = script[r.speaker] || {}; if (x.polls < (s.polls || 1)) return { status: 'running' }; live.delete(r.runId); log.push({ ev: 'done', speaker: r.speaker }); const out = Array.isArray(s.out) ? s.out.shift() : s.out; return { status: 'completed', output: out || '(quiet)' }; },
    async stopSpeaker(r) { stopped.push(r.speaker); live.delete(r.runId); },
  };
  const r = createSharedAgents({ directory: dir, gateways, members: MEMBERS, defaultResponder: 'all', advanceIntervalMs: 15, ...(parallel === undefined ? {} : { parallel }) });
  const call = body => new Promise((resolve, reject) => r.handle((_res, status, obj) => (status >= 400 ? reject(new Error(obj.error)) : resolve(obj)), {}, { workspace_id: '0b0b0b0b-0000-4000-8000-00000000c0de', pane_id: '33333333-3333-4333-8333-333333333333', ...body }));
  const settle = async () => { for (let i = 0; i < 200; i += 1) { const s = await call({ operation: 'state' }); if (!s.working.length && !s.queued.length) return s; await new Promise(x => setTimeout(x, 15)); } throw new Error('room did not settle'); };
  return { call, settle, log, stopped, live, done: () => { r.dispose(); fs.rmSync(dir, { recursive: true, force: true }); } };
}

test('a message waking several members runs them concurrently, and each reply posts when ready', async () => {
  const t = room({ script: { hermes: { polls: 6, out: 'slow hermes' }, mr_india: { polls: 1, out: 'fast india' }, pipi: { polls: 3, out: 'mid pipi' } } });
  try {
    await t.call({ operation: 'post', text: 'everyone build' });
    const s = await t.settle();
    const starts = t.log.filter(e => e.ev === 'start');
    assert.equal(starts.length, 3);
    assert.deepEqual(starts.at(-1).inFlight.sort(), ['hermes', 'mr_india', 'pipi'], 'all three in flight together');
    assert.deepEqual(s.messages.map(m => m.text), ['everyone build', 'fast india', 'mid pipi', 'slow hermes'], 'replies post in finish order');
    assert.match(starts[0].prompt, /Working in parallel: .*MR\.INDIA.*pipi/);
    assert.match(starts[0].prompt, /Collab board/);
  } finally { t.done(); }
});

test('a wake for a member that is still working waits for its own turn to finish (no overlap)', async () => {
  const t = room({ script: { hermes: { polls: 8, out: ['first hermes', 'second hermes'] }, mr_india: { polls: 1, out: '@hermes please also check X' }, pipi: { polls: 1, out: '(quiet)' } } });
  try {
    await t.call({ operation: 'post', text: 'go' });
    const s = await t.settle();
    const hermes = t.log.filter(e => e.speaker === 'hermes');
    assert.deepEqual(hermes.map(e => e.ev), ['start', 'done', 'start', 'done'], 'second hermes turn starts only after the first ends');
    assert.ok(s.messages.some(m => m.text === 'second hermes'));
  } finally { t.done(); }
});

test('sequential option keeps one turn at a time', async () => {
  const t = room({ parallel: false, script: { hermes: { polls: 2, out: 'a' }, mr_india: { polls: 2, out: 'b' }, pipi: { polls: 2, out: 'c' } } });
  try {
    await t.call({ operation: 'post', text: 'go' });
    await t.settle();
    for (const e of t.log.filter(x => x.ev === 'start')) assert.equal(e.inFlight.length, 1);
  } finally { t.done(); }
});

test('Stop all stops every in-flight member', async () => {
  const t = room({ script: { hermes: { polls: 1000 }, mr_india: { polls: 1000 }, pipi: { polls: 1000 } } });
  try {
    await t.call({ operation: 'post', text: 'go' });
    const before = await t.call({ operation: 'state' });
    assert.equal(before.working.length, 3);
    const after = await t.call({ operation: 'stop' });
    assert.deepEqual(t.stopped.sort(), ['hermes', 'mr_india', 'pipi']);
    assert.equal(after.working.length, 0);
    assert.equal(after.paused, true);
  } finally { t.done(); }
});
