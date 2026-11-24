// Long group turns: every message of a turn posts, the turn limit is an inactivity limit, interim @mentions do not wake.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createSharedAgents } from '../server/shared-agents.mjs';
import { createGatewayChat } from '../server/gateway-chat.mjs';

const MEMBERS = [{ id: 'hermes', label: 'Hermes' }, { id: 'pipi', label: 'pipi' }];

function room(gateways, extra = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'long-'));
  const r = createSharedAgents({ directory: dir, gateways, members: MEMBERS, defaultResponder: 'hermes', advanceIntervalMs: 15, ...extra });
  const call = body => new Promise(resolve => r.handle((_res, _s, obj) => resolve(obj), {}, { workspace_id: '0b0b0b0b-0000-4000-8000-00000000c0de', pane_id: '44444444-4444-4444-8444-444444444444', ...body }));
  return { call, done: () => { r.dispose(); fs.rmSync(dir, { recursive: true, force: true }); } };
}
const wait = ms => new Promise(x => setTimeout(x, ms));

test('a turn that keeps producing output outlives the inactivity limit, posts every message, and only the final @mentions wake', async () => {
  const t0 = Date.now(); const started = [];
  const texts = ['step one @pipi look', 'step two', 'step three', 'all done'];
  const gateways = {
    async startSpeaker(a) { started.push(a.speaker); return { runId: `run_${String(started.length).padStart(32, '0')}`, started: Date.now() }; },
    async pollSpeaker(r) {
      if (r.speaker !== 'hermes') return { status: 'completed', output: '(quiet)' };
      const n = Math.min(texts.length, 1 + Math.floor((Date.now() - t0) / 700));
      return n < texts.length ? { status: 'running', interim: texts.slice(0, n) } : { status: 'completed', output: texts.at(-1), interim: texts.slice() };
    },
    async stopSpeaker() {},
  };
  const t = room(gateways, { turnTimeoutMs: 1000, hardCapMs: 60000 });
  try {
    await t.call({ operation: 'post', text: 'build' });
    let s; for (let i = 0; i < 300; i += 1) { s = await t.call({ operation: 'state' }); if (!s.working.length && s.messages.length >= 5) break; await wait(15); }
    assert.deepEqual(s.messages.map(m => m.text), ['build', ...texts], 'no timeout, each message once');
    assert.deepEqual(started, ['hermes'], 'an interim @pipi does not wake pipi');
  } finally { t.done(); }
});

test('an idle turn still times out, and the hard cap stops a busy one', async () => {
  const gateways = { async startSpeaker() { return { runId: `run_${'9'.padStart(32, '0')}`, started: Date.now() }; }, async pollSpeaker() { return { status: 'running', interim: [] }; }, async stopSpeaker() {} };
  const t = room(gateways, { turnTimeoutMs: 1000, hardCapMs: 60000 });
  try {
    await t.call({ operation: 'post', text: 'build' });
    let s; for (let i = 0; i < 200; i += 1) { s = await t.call({ operation: 'state' }); if (!s.working.length) break; await wait(15); }
    assert.match(s.messages.at(-1).text, /no new activity for 1 minute/);
  } finally { t.done(); }
  let k = 0;
  const busy = { async startSpeaker() { return { runId: `run_${'8'.padStart(32, '0')}`, started: Date.now() }; }, async pollSpeaker() { k += 1; return { status: 'running', interim: [`tick ${k}`] }; }, async stopSpeaker() {} };
  const h = room(busy, { turnTimeoutMs: 60000, hardCapMs: 1000 });
  try {
    await h.call({ operation: 'post', text: 'build' });
    let s; for (let i = 0; i < 200; i += 1) { s = await h.call({ operation: 'state' }); if (!s.working.length) break; await wait(15); }
    assert.match(s.messages.at(-1).text, /1-minute turn cap|turn cap/);
  } finally { h.done(); }
});

test('gateway pollSharedTurn waits for the agent to go idle and returns every reply', async () => {
  let running = true; const tail = [];
  const fetchImpl = async (url, init) => {
    const route = String(url); const json = v => new Response(JSON.stringify(v), { status: 200, headers: { 'content-type': 'application/json' } });
    if (route.endsWith('/api/promptAcceptanceStatus')) return json({ outcome: 'found', record: { status: 'accepted' } });
    if (route.endsWith('/api/getAgentTranscriptTail')) return json(tail.slice());
    if (route.endsWith('/api/listAgents')) return json([{ id: 'a1', name: 'x', isRunning: running }]);
    return json({});
  };
  let clock = 1000;
  const chat = createGatewayChat({ provider: 'grok', fetchImpl, now: () => clock });
  const profile = { id: 'grok', apiUrl: 'http://gw.test', apiKey: 'k' };
  const run = { agentId: 'a1', nonce: 'n', started: 1000, baseline: { maxSeq: 0, ids: [], count: 0, fingerprints: [] } };
  tail.push({ seq: 1, id: 'e1', kind: 'send-message', message: { type: 'text', content: 'on it' } });
  let v = await chat.pollSharedTurn(profile, run);
  assert.equal(v.status, 'running'); assert.deepEqual(v.messages, ['on it']);
  tail.push({ seq: 2, id: 'e2', kind: 'send-message', message: { type: 'text', content: 'published v9' } });
  running = false; clock += 1000;
  v = await chat.pollSharedTurn(profile, run);
  assert.equal(v.status, 'running', 'idle must settle first');
  clock += 5000;
  v = await chat.pollSharedTurn(profile, run);
  assert.equal(v.status, 'completed'); assert.equal(v.output, 'published v9'); assert.deepEqual(v.messages, ['on it', 'published v9']);
});

test('pollSharedTurn closes a finished turn even when every poll passes a fresh copy of the run', async () => {
  let clock = 1000;
  const tail = [{ seq: 1, id: 'e1', kind: 'send-message', message: { type: 'text', content: 'done' } }];
  const fetchImpl = async url => { const r = String(url); const json = v => new Response(JSON.stringify(v), { status: 200, headers: { 'content-type': 'application/json' } });
    if (r.endsWith('/api/promptAcceptanceStatus')) return json({ outcome: 'found', record: { status: 'accepted' } });
    if (r.endsWith('/api/getAgentTranscriptTail')) return json(tail);
    if (r.endsWith('/api/listAgents')) return json([{ id: 'a1', name: 'x', isRunning: false }]);
    return json({}); };
  const chat = createGatewayChat({ provider: 'grok', fetchImpl, now: () => clock });
  const profile = { id: 'grok', apiUrl: 'http://gw.test', apiKey: 'k' };
  const run = Object.freeze({ agentId: 'a1', nonce: 'n2', started: 1000, baseline: { maxSeq: 0, ids: [], count: 0, fingerprints: [] } });
  assert.equal((await chat.pollSharedTurn(profile, { ...run })).status, 'running');
  clock += 5000;
  const v = await chat.pollSharedTurn(profile, { ...run });
  assert.equal(v.status, 'completed');
  assert.equal(v.output, 'done');
});

test('tool activity with no new messages keeps a turn alive (activityKey heartbeat)', async () => {
  let k = 0; let polls = 0;
  const gateways = { async startSpeaker() { return { runId: `run_${'7'.padStart(32, '0')}`, started: Date.now() }; },
    async pollSpeaker() { polls += 1; k += 1; return polls < 120 ? { status: 'running', interim: [], activityKey: `tool:${k}` } : { status: 'completed', output: 'finished after tools', interim: [] }; },
    async stopSpeaker() {} };
  const t = room(gateways, { turnTimeoutMs: 1000, hardCapMs: 60000 });
  try {
    await t.call({ operation: 'post', text: 'build' });
    let s; for (let i = 0; i < 400; i += 1) { s = await t.call({ operation: 'state' }); if (!s.working.length) break; await wait(15); }
    assert.equal(s.messages.at(-1).text, 'finished after tools');
  } finally { t.done(); }
});
