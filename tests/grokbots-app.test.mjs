// Grok Bots app backend against stub gateways (no real bots are contacted).
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createGrokBotsApp, MAX_PROMPT } from '../server/grokbots-app.mjs';

const AGENT = '11111111-2222-4333-8444-555555555555';
export async function stubGateway() {
  const seen = [];
  const transcript = [];
  const server = http.createServer(async (req, res) => {
    const parts = []; for await (const c of req) parts.push(c); const raw = Buffer.concat(parts).toString('utf8'); const body = raw ? JSON.parse(raw) : {};
    seen.push({ url: req.url, method: req.method, body });
    const json = d => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(d)); };
    if (req.url === '/api/listAgents') return json([{ id: AGENT, name: 'Stub Bot', updatedAt: 1 }]);
    if (req.url === '/api/getAgentTranscriptTail') return json({ entries: transcript });
    if (req.url === '/api/sendPrompt') return json({ accepted: true });
    if (req.url.startsWith('/api/sessions?')) return json({ data: [{ id: 'sess_1', title: 'First', preview: 'hello', message_count: 2 }] });
    if (req.url.startsWith('/api/sessions/sess_1/messages')) return json({ data: transcript.hermes || [] });
    if (req.url === '/v1/runs') return json({ run_id: 'run_1' });
    res.writeHead(404); res.end('{}');
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${server.address().port}`;
  return { url, seen, transcript, close: () => { server.closeAllConnections(); return new Promise(r => server.close(r)); } };
}
export async function harness(extra = {}) {
  const gw = await stubGateway();
  const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gb-app-'));
  const profiles = { grok: { id: 'grok', provider: 'grok', apiUrl: gw.url, apiKey: 'stub-secret-key-0123456789' }, default: { id: 'default', provider: 'hermes', apiUrl: gw.url, apiKey: 'stub-secret-key-0123456789' } };
  const catalog = () => ({ list: [{ id: 'grok', label: 'Grok' }, { id: 'default', label: 'Hermes' }], get: id => profiles[id] });
  const app = createGrokBotsApp({ runtimeRoot, catalog, ...extra });
  const server = http.createServer((req, res) => (req.url.startsWith('/api/grokbots-app/upload') && app.upload ? app.upload(req, res) : app.handle(req, res)));
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const key = decodeURIComponent(app.launchUrl().split('#k=')[1]);
  const call = async body => { const r = await fetch(base + '/api/grokbots-app', { method: 'POST', headers: { Origin: 'null', Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' }, body: JSON.stringify(body) }); return { status: r.status, body: await r.json() }; };
  return { gw, app, base, key, call, runtimeRoot, close: async () => { app.close(); server.closeAllConnections(); await new Promise(r => server.close(r)); await gw.close(); } };
}

test('prompts up to 100,000 characters reach the gateway intact; longer ones are refused', async () => {
  const h = await harness();
  try {
    assert.equal(MAX_PROMPT, 100000);
    const long = 'é'.repeat(MAX_PROMPT); // multi-byte: exercises the byte-based body limit
    const ok = await h.call({ action: 'send', profile: 'grok', agent: AGENT, prompt: long });
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    const sent = h.gw.seen.find(s => s.url === '/api/sendPrompt');
    assert.equal(sent.body.prompt.length, MAX_PROMPT);
    const tooLong = await h.call({ action: 'send', profile: 'grok', agent: AGENT, prompt: 'x'.repeat(MAX_PROMPT + 1) });
    assert.equal(tooLong.status, 400);
    assert.match(tooLong.body.error, /100,000/);
    const hermes = await h.call({ action: 'send', profile: 'default', prompt: 'y'.repeat(MAX_PROMPT) });
    assert.equal(hermes.status, 200);
    assert.equal(h.gw.seen.find(s => s.url === '/v1/runs').body.input.length, MAX_PROMPT);
  } finally { await h.close(); }
});

test('long history messages are not cut below the prompt cap', async () => {
  const h = await harness();
  try {
    h.gw.transcript.push({ id: 'e1', kind: 'message', role: 'user', content: 'z'.repeat(90000), timestampMs: 5 });
    const r = await h.call({ action: 'history', profile: 'grok', agent: AGENT });
    assert.equal(r.body.messages[0].content.length, 90000);
  } finally { await h.close(); }
});

test('group posts and Pi/Hermes steering accept 100,000 characters', async () => {
  const groups = fs.readFileSync(new URL('../server/grokbots-groups.mjs', import.meta.url), 'utf8');
  assert.match(groups, /GROUP_MAX_MESSAGE = 100000/);
  assert.match(groups, /createSharedAgents\(\{ maxMessage: GROUP_MAX_MESSAGE/);
  assert.match(fs.readFileSync(new URL('../server/grokbots-controls-pi.mjs', import.meta.url), 'utf8'), /MAX_TEXT = 100_000/);
  const { control } = await import('../server/grokbots-controls-hermes.mjs');
  let posted;
  const ctx = { fetchHermes: async (p, o) => { posted = o.body; return { status: 'ok' }; }, redact: x => x };
  await control({ provider: 'hermes' }, { action: 'steer', run: 'run_1', args: { text: 'g'.repeat(100000) } }, ctx);
  assert.equal(posted.input.length, 100000);
  await assert.rejects(control({ provider: 'hermes' }, { action: 'steer', run: 'run_1', args: { text: 'g'.repeat(100001) } }, ctx), /100,000/);
});

test('the app composer allows 100,000 characters', () => {
  const html = fs.readFileSync(new URL('../apps/grokbots/index.html', import.meta.url), 'utf8');
  assert.match(html, /<textarea id="in" maxlength="100000"/);
});

test('drafts and queued messages persist per conversation, bounded', async () => {
  const h = await harness();
  try {
    const key = `grok|${AGENT}`;
    let r = await h.call({ action: 'prefs', op: 'draft', key, text: 'half-written', queue: [{ id: 'q1', text: 'next one' }] });
    assert.equal(r.status, 200);
    r = await h.call({ action: 'prefs', op: 'get' });
    assert.equal(r.body.drafts[key].text, 'half-written');
    assert.deepEqual(r.body.drafts[key].queue, [{ id: 'q1', text: 'next one' }]);
    const file = path.join(h.runtimeRoot, 'grokbots-prefs.json');
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    // a fresh backend instance reads the same drafts back
    const { createPrefs } = await import('../server/grokbots-prefs.mjs');
    assert.equal(createPrefs({ runtimeRoot: h.runtimeRoot }).read().drafts[key].text, 'half-written');
    assert.equal((await h.call({ action: 'prefs', op: 'draft', key, text: 'x'.repeat(100001) })).status, 400);
    assert.equal((await h.call({ action: 'prefs', op: 'draft', key, text: '', queue: Array.from({ length: 21 }, (_, i) => ({ id: 'q' + i, text: 't' })) })).status, 400);
    assert.equal((await h.call({ action: 'prefs', op: 'draft', key: '../../etc', text: 'x' })).status, 400);
    // clearing text and queue removes the entry
    await h.call({ action: 'prefs', op: 'draft', key, text: '', queue: [] });
    assert.equal((await h.call({ action: 'prefs', op: 'get' })).body.drafts[key], undefined);
  } finally { await h.close(); }
});
