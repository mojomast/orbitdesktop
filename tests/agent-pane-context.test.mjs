import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createAgentHandler } from '../server/agent.mjs';

const token = 'orbit-test-token-'.repeat(4);
const session = 'orbit-12345678-1234-4234-9234-123456789abc';
const workspace_id = '12345678-1234-4234-9234-123456789abc';
const pane_id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const seed = `${'x'.repeat(800)}\nDecided to keep the parser because the old one failed.\nPlan: finish compact.\nTODO: cover fork.\nFile src/agent-chat.ts\n$ npm test\nError: boom\nMust keep session orbit-1234.`;

async function setup(t, { failHealth = false } = {}) {
  const calls = [];
  const runtimeDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-context-'));
  let port;
  let handler;
  let created = 0;
  const reply = (res, status, data) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(data)); };
  const workspaceRead = () => ({ state: { monitors: [{ layout: { type: 'pane', pane: { id: pane_id, kind: 'agent' } } }] } });
  const fetchImpl = async (url, options) => {
    calls.push({ url: String(url), body: options?.body });
    const route = String(url);
    const json = (value, status = 200) => new Response(JSON.stringify(value), { status });
    if (failHealth) return json({ error: 'down' }, 500);
    if (route.endsWith('/v1/capabilities')) return json({ endpoints: { toolsets: {} } });
    if (route.endsWith('/api/sessions?limit=100&offset=0')) return json({ data: [{ id: session, title: 'Design', updated_at: '2026-10-13T12:00:00.000Z' }] });
    if (route.includes('/messages')) {
      if (route.includes(session)) return json({ data: [{ role: 'user', content: 'remember the cobalt token path' }, { role: 'assistant', content: 'I will remember cobalt.' }] });
      return json({ error: 'missing' }, 404);
    }
    if (route.endsWith('/v1/runs')) return json({ run_id: 'run_123456789abcdef', status: 'running', session_id: session });
    if (route.endsWith('/api/listAgents')) return json([{ id: 'agent_orbit_001', name: 'Orbit chat' }]);
    if (route.endsWith('/api/listBoxMcpServers')) return json([{ serverIdentifier: 'box', status: 'connected' }]);
    if (route.endsWith('/api/createAgent')) {
      created += 1;
      return json({ agent: { id: `agent_fork_${created}`, name: 'Fork' } });
    }
    if (route.endsWith('/api/getAgentTranscriptTail')) return json([]);
    if (route.endsWith('/api/sendPrompt')) return json({ accepted: true });
    return json({ error: 'missing' }, 404);
  };
  const server = http.createServer((req, res) => (handler ||= createAgentHandler({
    token, port, devOrigins: [], reply, runtimeDirectory, workspaceRead,
    apiUrl: 'http://hermes.test', apiKey: 'hermes-key',
    additionalProfiles: [{ id: 'grok', label: 'Grok Bot', provider: 'grok', apiUrl: 'http://127.0.0.1:1340', apiKey: 'grok-token-secret', model: 'window-100' }],
    fetchImpl,
  }))(req, res));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  port = server.address().port;
  t.after(async () => { await new Promise(resolve => server.close(resolve)); fs.rmSync(runtimeDirectory, { recursive: true, force: true }); });
  const origin = `http://127.0.0.1:${port}`;
  async function request(body) {
    const response = await fetch(`${origin}/api/agent`, {
      method: 'POST',
      headers: { Origin: origin, Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    return { status: response.status, body: await response.json(), calls };
  }
  return { request, runtimeDirectory, calls };
}

test('provider menu lists a down gateway and never returns its token', async t => {
  const { request } = await setup(t, { failHealth: true });
  const menu = await request({ action: 'provider_menu', workspace_id, pane_id });
  assert.equal(menu.status, 200);
  assert.equal(menu.body.providers.length, 2);
  assert.deepEqual(menu.body.providers.map(item => item.health), ['down', 'down']);
  assert.equal(JSON.stringify(menu.body).includes('grok-token-secret'), false);
  assert.equal(JSON.stringify(menu.body).includes('hermes-key'), false);
});

test('history, compact, and provider switch fork with a visible marker', async t => {
  const { request, runtimeDirectory, calls } = await setup(t);
  const base = { workspace_id, pane_id, session_id: session, profile_id: 'default', expected_binding_revision: 0 };
  const menu = await request({ action: 'provider_menu', workspace_id, pane_id });
  assert.equal(menu.status, 200);
  const hermes = menu.body.providers.find(item => item.id === 'default');
  const grok = menu.body.providers.find(item => item.id === 'grok');
  assert.equal(hermes.health, 'up');
  assert.equal(hermes.tools, true);
  assert.equal(hermes.gateway.startsWith('Hermes :'), true);
  assert.equal(grok.model, 'window-100');
  assert.equal(grok.context_window, 100);
  assert.equal(grok.tools, true);
  assert.equal(JSON.stringify(menu.body).includes('grok-token-secret'), false);

  assert.equal((await request({ ...base, action: 'shared_chat', initial: { session, messages: [{ role: 'user', text: seed }] } })).status, 200);
  const compact = await request({ ...base, action: 'compact_transcript', confirm: true });
  assert.equal(compact.status, 200);
  assert.equal(compact.body.compacted, false);
  assert.match(compact.body.hermes.note, /not compacting it again/);
  const still = await request({ ...base, action: 'shared_chat' });
  assert.match(still.body.state.messages[0].text, /Ship|Decided|x{20}/);

  const found = await request({ ...base, action: 'history_search', query: 'cobalt', provider: 'hermes' });
  assert.equal(found.status, 200);
  assert.equal(found.body.conversations.some(row => row.session_id === session && row.snippet.includes('cobalt')), true);
  const opened = await request({ ...base, action: 'history_transcript', target_profile_id: 'default', target_session_id: session });
  assert.equal(opened.body.read_only, true);
  assert.equal(opened.body.messages[0].text.includes('cobalt'), true);

  const blocked = await request({ ...base, action: 'switch_provider', target_profile_id: 'grok' });
  assert.equal(blocked.body.suggest_compact, true);
  assert.equal(blocked.body.switched, false);
  assert.equal((await request({ ...base, action: 'shared_chat' })).body.state.session, session);

  const switched = await request({ ...base, action: 'switch_provider', target_profile_id: 'grok', acknowledge_smaller: true });
  assert.equal(switched.status, 200);
  assert.equal(switched.body.switched, true);
  assert.equal(switched.body.state.profile_id, 'grok');
  assert.match(switched.body.state.messages.map(message => message.text).join('\n'), /Switched to Grok Bot · window-100/);
  assert.match(switched.body.state.messages.map(message => message.text).join('\n'), /Decisions:/);
  assert.equal(fs.readdirSync(path.join(runtimeDirectory, 'transcript-raw')).some(name => name.endsWith('.json')), true);
  const remembered = await request({ action: 'provider_menu', workspace_id, pane_id });
  assert.equal(remembered.body.remembered_profile_id, 'grok');

  const scoped = { ...base, profile_id: 'grok', session_id: switched.body.state.session, expected_binding_revision: switched.body.state.binding_revision };
  const started = await request({ ...scoped, action: 'start', input: 'continue from the summary' });
  assert.equal(started.status, 202);
  const sent = calls.find(call => call.url.endsWith('/api/sendPrompt'));
  assert.match(JSON.parse(sent.body).prompt, /Summary of|Decided to keep/);
  assert.equal(JSON.parse(sent.body).prompt.includes('grok-token-secret'), false);
});

test('a Hermes fork replays the copied transcript when the gateway session is new', async t => {
  const { request, calls } = await setup(t);
  const base = { workspace_id, pane_id, session_id: session, profile_id: 'default', expected_binding_revision: 0 };
  assert.equal((await request({ ...base, action: 'shared_chat', initial: { session, messages: [{ role: 'user', text: 'local only' }] } })).status, 200);
  const forked = await request({ ...base, action: 'fork_transcript', source_profile_id: 'default', source_session_id: session, target_profile_id: 'default', upto: 1 });
  assert.equal(forked.status, 200, JSON.stringify(forked.body));
  assert.equal(forked.body.copied, true);
  assert.match(forked.body.state.session, /^orbit-/);
  const started = await request({
    workspace_id, pane_id, profile_id: 'default', session_id: forked.body.state.session,
    expected_binding_revision: forked.body.state.binding_revision, action: 'start', input: 'continue the fork',
  });
  assert.equal(started.status, 202, JSON.stringify(started.body));
  const run = calls.find(call => call.url.endsWith('/v1/runs'));
  assert.match(JSON.stringify(JSON.parse(run.body).conversation_history), /cobalt/);
});
