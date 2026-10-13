import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { estimateTokens, meterLevel, summarizeTranscript } from '../server/agent-session-controls.mjs';
import { dateGroup, groupHistory, providerSwitchNote } from '../src/agent-session-model.ts';
import { createAgentHandler } from '../server/agent.mjs';

const token = 'orbit-test-token-'.repeat(4);
const session = 'orbit-12345678-1234-4234-9234-123456789abc';
const workspace_id = '12345678-1234-4234-9234-123456789abc';
const pane_id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

test('context meter colors and transcript summary follow the pane rules', () => {
  assert.equal(meterLevel(100, 1000).level, 'ok');
  assert.equal(meterLevel(600, 1000).level, 'warn');
  assert.equal(meterLevel(800, 1000).level, 'hot');
  assert.equal(estimateTokens('abcd'), 1);
  const summary = summarizeTranscript([
    { role: 'user', text: 'Decide the release notes' },
    { role: 'assistant', text: 'Decision ship docs/AGENT_PANE_SESSION.md' },
    { role: 'user', text: 'todo check server/agent.mjs' },
  ]);
  assert.match(summary, /Goal: Decide the release notes/);
  assert.match(summary, /docs\/AGENT_PANE_SESSION\.md/);
  assert.match(summary, /Recent turns:/);
  const noon = Date.parse('2026-10-13T15:00:00Z');
  assert.equal(dateGroup('2026-10-13T12:00:00Z', noon), 'Today');
  assert.equal(dateGroup('2026-10-12T12:00:00Z', noon), 'Yesterday');
  assert.equal(dateGroup('2026-10-08T12:00:00Z', noon), 'Previous 7 days');
  assert.equal(dateGroup('2026-01-01T00:00:00Z', noon), 'Older');
  const grouped = groupHistory([
    { session_id: 'a', profile_id: 'default', pinned: true, updated_at: '2026-01-01T00:00:00Z' },
    { session_id: 'b', profile_id: 'grok', updated_at: '2026-10-13T12:00:00Z' },
  ], noon);
  assert.equal(grouped.pinned[0].session_id, 'a');
  assert.equal(grouped.groups[0].label, 'Today');
  const note = providerSwitchNote('Hermes', 'Grok Bot', 200000, 128000);
  assert.equal(note.suggestCompact, true);
  assert.match(note.text, /Switched from Hermes to Grok Bot/);
});

test('Hermes reports context usage and does not double-compact when compression is not exposed', async t => {
  const calls = [];
  const runtimeDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-pane-session-'));
  let port;
  let handler;
  const reply = (res, status, data) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(data)); };
  const workspaceRead = () => ({ state: { monitors: [{ layout: { type: 'pane', pane: { id: pane_id, kind: 'agent' } } }] } });
  const fetchImpl = async (url, options) => {
    calls.push({ url: String(url), method: options?.method });
    const route = String(url);
    const json = (value, status = 200) => new Response(JSON.stringify(value), { status });
    if (route.includes('missing-session')) return json({ error: 'missing' }, 404);
    if (route.endsWith('/compress')) return json({ error: 'missing' }, 404);
    if (route.includes('/messages')) return json({ data: [{ role: 'user', content: 'hello orbit' }] });
    if (route.includes('/api/sessions/')) return json({ id: session, model: 'deepseek-v4', usage: { total_tokens: 90000 }, context_length: 100000 });
    return json({ data: [] });
  };
  const server = http.createServer((req, res) => (handler ||= createAgentHandler({
    token, port, devOrigins: [], reply, runtimeDirectory, workspaceRead,
    apiUrl: 'http://hermes.test', apiKey: 'hermes-key', fetchImpl,
  }))(req, res));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  port = server.address().port;
  t.after(async () => { await new Promise(resolve => server.close(resolve)); fs.rmSync(runtimeDirectory, { recursive: true, force: true }); });
  const origin = `http://127.0.0.1:${port}`;
  const request = async body => {
    const response = await fetch(`${origin}/api/agent`, {
      method: 'POST',
      headers: { Origin: origin, Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ workspace_id, pane_id, session_id: session, profile_id: 'default', ...body }),
    });
    return { status: response.status, body: await response.json() };
  };
  assert.equal((await request({ action: 'shared_chat', initial: { session, messages: [] } })).status, 200);
  const meter = await request({ action: 'context_meter', expected_binding_revision: 0 });
  assert.equal(meter.status, 200);
  assert.equal(meter.body.source, 'reported');
  assert.equal(meter.body.used, 90000);
  assert.equal(meter.body.window, 100000);
  assert.equal(meter.body.level, 'hot');
  assert.equal(meter.body.hermes_compression.native, true);
  const denied = await request({ action: 'compact_session', expected_binding_revision: 0 });
  assert.equal(denied.status, 400);
  const compact = await request({ action: 'compact_session', confirm: true, expected_binding_revision: 0 });
  assert.equal(compact.status, 200);
  assert.equal(compact.body.applied, false);
  assert.match(compact.body.note, /first 3 turns/);
  assert.equal(calls.some(call => String(call.url).endsWith('/compress') && call.method === 'POST'), true);
  const missing = await request({ action: 'session_preview', target_profile_id: 'default', target_session_id: 'missing-session', expected_binding_revision: 0 });
  assert.equal(missing.body.resumable, false);
});

test('Grok Bot compact continues in a new agent and estimates context from the transcript', async t => {
  const calls = [];
  const runtimeDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-pane-grok-'));
  let port;
  let handler;
  const reply = (res, status, data) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(data)); };
  const workspaceRead = () => ({ state: { monitors: [{ layout: { type: 'pane', pane: { id: pane_id, kind: 'agent' } } }] } });
  const fetchImpl = async (url, options) => {
    calls.push({ url: String(url), body: options?.body });
    const route = String(url);
    const json = (value, status = 200) => new Response(JSON.stringify(value), { status });
    if (route.endsWith('/api/listAgents')) return json([{ id: 'agent_orbit_001', name: 'Orbit chat' }]);
    if (route.endsWith('/api/getAgentTranscriptTail')) return json([{ kind: 'message', role: 'user', content: 'Write the changelog' }]);
    if (route.endsWith('/api/createAgent')) return json({ agent: { id: 'agent_compact_1', name: 'Compact' } });
    if (route.endsWith('/api/sendPrompt')) return json({ accepted: true });
    return json({ data: [] });
  };
  const server = http.createServer((req, res) => (handler ||= createAgentHandler({
    token, port, devOrigins: [], reply, runtimeDirectory, workspaceRead,
    apiUrl: 'http://hermes.test', apiKey: 'hermes-key',
    additionalProfiles: [{ id: 'grok', label: 'Grok Bot', provider: 'grok', apiUrl: 'http://127.0.0.1:1340', apiKey: 'grok-token-secret', model: 'grok-4' }],
    fetchImpl,
  }))(req, res));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  port = server.address().port;
  t.after(async () => { await new Promise(resolve => server.close(resolve)); fs.rmSync(runtimeDirectory, { recursive: true, force: true }); });
  const origin = `http://127.0.0.1:${port}`;
  const request = async body => {
    const response = await fetch(`${origin}/api/agent`, {
      method: 'POST',
      headers: { Origin: origin, Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    return { status: response.status, body: await response.json() };
  };
  const base = { workspace_id, pane_id, session_id: session, profile_id: 'default' };
  assert.equal((await request({ ...base, action: 'shared_chat', initial: { session, messages: [] } })).status, 200);
  const selected = await request({ ...base, action: 'select_session', target_profile_id: 'grok', target_session_id: 'agent_orbit_001', expected_binding_revision: 0 });
  assert.equal(selected.status, 200, JSON.stringify(selected.body));
  const meter = await request({ ...base, action: 'context_meter', session_id: 'agent_orbit_001', profile_id: 'grok', expected_binding_revision: 1 });
  assert.equal(meter.body.source, 'estimated');
  assert.equal(meter.body.provider, 'grok');
  assert.ok(meter.body.used > 0);
  const compact = await request({ ...base, action: 'compact_session', confirm: true, session_id: 'agent_orbit_001', profile_id: 'grok', expected_binding_revision: 1 });
  assert.equal(compact.status, 200, JSON.stringify(compact.body));
  assert.equal(compact.body.strategy, 'grok-fresh-agent');
  assert.equal(compact.body.previous_session_id, 'agent_orbit_001');
  assert.equal(compact.body.state.session, 'agent_compact_1');
  assert.match(compact.body.summary, /Write the changelog/);
  const seed = calls.find(call => String(call.url).endsWith('/api/sendPrompt'));
  assert.match(JSON.parse(seed.body).prompt, /continues compacted session agent_orbit_001/);
});
