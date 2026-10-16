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

test('attachments upload to the host and reach the agent as paths (small text inlined), within limits', async () => {
  const h = await harness();
  try {
    const up = async (name, body, type = 'text/plain', key = h.key) => { const r = await fetch(h.base + '/api/grokbots-app/upload', { method: 'POST', headers: { Origin: 'null', Authorization: 'Bearer ' + key, 'Content-Type': type, 'X-File-Name': encodeURIComponent(name) }, body }); return { status: r.status, body: await r.json() }; };
    assert.equal((await up('a.txt', 'x', 'text/plain', 'wrong-key-wrong-key-wrong-key-wrong-k')).status, 401);
    const notes = await up('../../notes.md', '# Notes\nremember milk');
    assert.equal(notes.status, 200);
    assert.equal(notes.body.name, 'notes.md');
    const img = await up('shot.png', Buffer.alloc(2048, 7), 'image/png');
    const dir = path.join(h.runtimeRoot, 'grokbots-uploads', notes.body.id);
    assert.equal(fs.statSync(path.join(dir, 'notes.md')).mode & 0o777, 0o600);
    const r = await h.call({ action: 'send', profile: 'grok', agent: AGENT, prompt: 'see attached', attachments: [{ id: notes.body.id }, { id: img.body.id }] });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const prompt = h.gw.seen.find(s => s.url === '/api/sendPrompt').body.prompt;
    assert.match(prompt, /^see attached\n\n\[Attached files/);
    assert.ok(prompt.includes(path.join(dir, 'notes.md')));
    assert.match(prompt, /shot\.png \(image\/png, 2 KB\)/);
    assert.match(prompt, /--- notes\.md ---\n# Notes\nremember milk/);
    assert.doesNotMatch(prompt, /\u0007/);
    // attachments alone (no text) are allowed
    assert.equal((await h.call({ action: 'send', profile: 'grok', agent: AGENT, prompt: '', attachments: [{ id: img.body.id }] })).status, 200);
    // limits and bad ids
    assert.equal((await h.call({ action: 'send', profile: 'grok', agent: AGENT, prompt: 'x', attachments: Array.from({ length: 11 }, () => ({ id: img.body.id })) })).status, 400);
    assert.equal((await h.call({ action: 'send', profile: 'grok', agent: AGENT, prompt: 'x', attachments: [{ id: '../../etc/passwd' }] })).status, 400);
    assert.equal((await h.call({ action: 'send', profile: 'grok', agent: AGENT, prompt: 'x', attachments: [{ id: '00000000-0000-4000-8000-000000000000' }] })).status, 410);
    const { UPLOAD_LIMITS } = await import('../server/grokbots-uploads.mjs');
    const big = await up('big.bin', Buffer.alloc(UPLOAD_LIMITS.fileBytes + 1), 'application/octet-stream');
    assert.equal(big.status, 413);
    assert.deepEqual(fs.readdirSync(path.join(h.runtimeRoot, 'grokbots-uploads')).sort(), [img.body.id, notes.body.id].sort());
    // a message that fills the cap with the path list is refused; one that leaves no room to inline still sends paths
    assert.equal((await h.call({ action: 'send', profile: 'grok', agent: AGENT, prompt: 'p'.repeat(MAX_PROMPT - 10), attachments: [{ id: notes.body.id }] })).status, 400);
    const listLen = prompt.split('\n').find(l => l.includes('notes.md (')).length + 80;
    const long = await h.call({ action: 'send', profile: 'grok', agent: AGENT, prompt: 'p'.repeat(MAX_PROMPT - listLen - 20), attachments: [{ id: notes.body.id }] });
    assert.equal(long.status, 200);
    const last = h.gw.seen.filter(s => s.url === '/api/sendPrompt').at(-1).body.prompt;
    assert.ok(last.length <= MAX_PROMPT && !last.includes('remember milk') && last.includes('notes.md'));
  } finally { await h.close(); }
});

test('history returns redacted tool calls and results anchored to the preceding message', async () => {
  const h = await harness();
  try {
    h.gw.transcript.push(
      { id: 'u1', kind: 'message', role: 'user', content: 'go', timestampMs: 1000 },
      { id: 'c1', kind: 'tool-call', toolCallId: 'call_1', name: 'bash', status: 'pending', input: { cmd: 'curl -H "Authorization: Bearer abc.def" x', key: 'stub-secret-key-0123456789' }, timestampMs: 1100 },
      { id: 'r1', kind: 'tool-result', toolCallId: 'call_1', output: 'ok '.repeat(3000), timestampMs: 1600 },
      { id: 'a1', kind: 'message', role: 'assistant', content: 'done', timestampMs: 2000 });
    const r = await h.call({ action: 'history', profile: 'grok', agent: AGENT });
    assert.equal(r.status, 200);
    assert.equal(r.body.messages.length, 2);
    const [t] = r.body.tools;
    assert.equal(t.id, 'call_1'); assert.equal(t.name, 'bash'); assert.equal(t.status, 'done'); assert.equal(t.after, 'u1'); assert.equal(t.durationMs, 500);
    assert.ok(!t.input.includes('stub-secret-key') && !t.input.includes('abc.def'));
    assert.ok(t.output.length <= 4000);
    h.gw.transcript.hermes = [
      { id: 1, role: 'user', content: 'list files', timestamp: 1 },
      { id: 2, role: 'assistant', content: '', tool_calls: [{ id: 'tc1', function: { name: 'terminal', arguments: '{"command":"ls"}' } }], timestamp: 2 },
      { id: 3, role: 'tool', tool_call_id: 'tc1', name: 'terminal', content: 'a.txt', timestamp: 3 },
      { id: 4, role: 'assistant', content: 'a.txt', timestamp: 4 }];
    const hr = await h.call({ action: 'history', profile: 'default', session: 'sess_1' });
    assert.equal(hr.status, 200, JSON.stringify(hr.body));
    assert.deepEqual(hr.body.tools.map(x => [x.name, x.status, x.after, x.input, x.output]), [['terminal', 'done', '1', '{"command":"ls"}', 'a.txt']]);
  } finally { await h.close(); }
});
