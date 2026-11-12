// Auto-resume: a group member turn cancelled by its own runtime (Hermes lease lost after a box pause) is re-queued.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createSharedAgents, AUTO_RESUME_NOTE } from '../server/shared-agents.mjs';
import { createAgentGateways } from '../server/agent-gateways.mjs';

const MEMBERS = [{ id: 'hermes', label: 'Hermes' }, { id: 'pipi', label: 'pipi' }];
let seq = 0;
const wait = ms => new Promise(r => setTimeout(r, ms));

// script[speaker]: array of outcomes per turn: 'cancel' | 'fail' | 'hang' | text
function room({ script, delay = 30, cap }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'resume-'));
  const starts = []; const live = new Map(); const stopped = [];
  const gateways = {
    async startSpeaker(a) { const runId = `run_${String(++seq).padStart(32, '0')}`; const outcome = (script[a.speaker] || []).shift() ?? '(quiet)'; live.set(runId, { outcome, polls: 0 }); starts.push({ speaker: a.speaker, prompt: a.prompt }); return { runId, started: Date.now() }; },
    async pollSpeaker(r) {
      const x = live.get(r.runId); if (!x) return { status: 'failed', error: 'gone' };
      x.polls += 1; if (x.polls < 2 || x.outcome === 'hang') return { status: 'running' };
      live.delete(r.runId);
      if (x.outcome === 'cancel') return { status: 'failed', error: 'Hermes cancelled this turn.', runtimeCancelled: true, cancelReason: 'interrupted_by_system(session_turn_lease_lost)' };
      if (x.outcome === 'usercancel') return { status: 'failed', error: 'Hermes cancelled this turn.', runtimeCancelled: true, cancelReason: 'interrupted_by_user' };
      if (x.outcome === 'fail') return { status: 'failed', error: 'Hermes reported a failure.' };
      return { status: 'completed', output: x.outcome };
    },
    async stopSpeaker(r) { stopped.push(r.speaker); live.delete(r.runId); },
  };
  const r = createSharedAgents({ directory: dir, gateways, members: MEMBERS, defaultResponder: 'hermes', advanceIntervalMs: 15, autoResumeDelayMs: delay, ...(cap === undefined ? {} : { maxAutoResumes: cap }) });
  const call = body => new Promise((resolve, reject) => r.handle((_res, status, obj) => (status >= 400 ? reject(new Error(obj.error)) : resolve(obj)), {}, { workspace_id: '0b0b0b0b-0000-4000-8000-00000000c0de', pane_id: '44444444-4444-4444-8444-444444444444', ...body }));
  const pump = async (ms = 600) => { const end = Date.now() + ms; let s; while (Date.now() < end) { s = await call({ operation: 'state' }); await wait(10); } return s; };
  return { call, pump, starts, stopped, done: () => { r.dispose(); fs.rmSync(dir, { recursive: true, force: true }); } };
}

test('a runtime-cancelled turn is resumed with the resume note, and a normal completion ends the chain', async () => {
  const t = room({ script: { hermes: ['cancel', 'finished after resume'] } });
  try {
    await t.call({ operation: 'post', text: '@hermes build it' });
    const s = await t.pump();
    const h = t.starts.filter(x => x.speaker === 'hermes');
    assert.equal(h.length, 2);
    assert.ok(h[1].prompt.startsWith(AUTO_RESUME_NOTE));
    assert.ok(!h[0].prompt.includes(AUTO_RESUME_NOTE));
    const texts = s.messages.map(m => m.text);
    assert.ok(texts.some(x => /Orbit will resume it in about/.test(x) && /auto-resume 1 of 2/.test(x)));
    assert.ok(texts.includes('finished after resume'));
  } finally { t.done(); }
});

test('auto-resume is capped at 2 per original turn', async () => {
  const t = room({ script: { hermes: ['cancel', 'cancel', 'cancel', 'never'] } });
  try {
    await t.call({ operation: 'post', text: '@hermes build it' });
    const s = await t.pump(900);
    assert.equal(t.starts.filter(x => x.speaker === 'hermes').length, 3, 'original + 2 resumes');
    assert.ok(s.messages.some(m => /not resuming automatically/.test(m.text)));
  } finally { t.done(); }
});

test('a plain failure, a manual cancel reason, a pause or a stop never auto-resumes', async () => {
  for (const [outcome, action] of [['fail', null], ['usercancel', null], ['cancel', 'pause'], ['cancel', 'stop-after']]) {
    const t = room({ script: { hermes: [outcome, 'should not run'] }, delay: action === 'stop-after' ? 200 : 30 });
    try {
      await t.call({ operation: 'post', text: '@hermes build it' });
      if (action === 'pause') await t.call({ operation: 'pause' });
      if (action === 'stop-after') { await t.pump(120); await t.call({ operation: 'stop' }); }
      await t.pump(500);
      assert.equal(t.starts.filter(x => x.speaker === 'hermes').length, 1, `${outcome}/${action}`);
    } finally { t.done(); }
  }
});

test('Stop during a running turn stops it and does not resume', async () => {
  const t = room({ script: { hermes: ['hang', 'should not run'] } });
  try {
    await t.call({ operation: 'post', text: '@hermes build it' });
    await t.pump(80);
    await t.call({ operation: 'stop' });
    await t.pump(300);
    assert.deepEqual(t.stopped, ['hermes']);
    assert.equal(t.starts.length, 1);
  } finally { t.done(); }
});

test('hermesView flags cancelled runs as runtime cancellations with the exit reason', async () => {
  const fetchImpl = async () => ({ ok: true, status: 200, text: async () => JSON.stringify({ status: 'cancelled', turn_exit_reason: 'interrupted_by_system(session_turn_lease_lost)' }) });
  const g = createAgentGateways({ fetchImpl, hermesProfile: () => ({ apiUrl: 'http://127.0.0.1:1', apiKey: 'x' }) });
  const v = await g.pollSpeaker({ speaker: 'hermes', runId: 'run_abcdefgh12345678' });
  assert.equal(v.status, 'failed');
  assert.equal(v.runtimeCancelled, true);
  assert.equal(v.cancelReason, 'interrupted_by_system(session_turn_lease_lost)');
  assert.equal(v.error, 'Hermes cancelled this turn.');
  const f = createAgentGateways({ fetchImpl: async () => ({ ok: true, status: 200, text: async () => '{"status":"failed"}' }), hermesProfile: () => ({ apiUrl: 'http://127.0.0.1:1', apiKey: 'x' }) });
  const fv = await f.pollSpeaker({ speaker: 'hermes', runId: 'run_abcdefgh12345678' });
  assert.equal(fv.runtimeCancelled, undefined);
});
