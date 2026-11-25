// RED for wave A slice T2a: Orbit passes docs/AGENT_GUIDE.md by path, not inline.
// Today every workspace-aware Hermes run carries the whole guide (~7.4k tokens).
// The Grok path already passes the path; the Hermes path does the same.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {randomUUID} from 'node:crypto';
import {initial} from '../src/model.ts';
import {createWorkspaceService} from '../server/workspace.mjs';

const guide = fs.readFileSync(new URL('../docs/AGENT_GUIDE.md', import.meta.url), 'utf8');
const guideBodyLine = guide.split('\n').find(line => line.startsWith('Do not tell the owner'));

async function service(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-guide-')), token = randomUUID(), id = randomUUID();
  let svc;
  const server = http.createServer((req, res) => svc.handle(req, res, req.url === '/control'));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  svc = createWorkspaceService({root, port: server.address().port, token, devOrigins: [], reply: (res, status, body) => { res.writeHead(status, {'Content-Type': 'application/json'}); res.end(JSON.stringify(body)); }});
  t.after(async () => { await new Promise(resolve => server.close(resolve)); svc.close(); fs.rmSync(root, {recursive: true, force: true}); });
  const response = await fetch(origin + '/workspace', {method: 'POST', headers: {Origin: origin, Authorization: `Bearer ${token}`, 'Content-Type': 'application/json'}, body: JSON.stringify({workspace_id: id, action: 'sync', state: initial()})});
  assert.equal(response.status, 200);
  return {svc, id};
}

test('the Hermes context names the guide by path and does not inline it', async t => {
  const {svc, id} = await service(t);
  assert.ok(guideBodyLine, 'fixture line moved in docs/AGENT_GUIDE.md; pick another body line');
  const text = svc.context(id);
  assert.equal(text.includes(guideBodyLine), false, 'guide body is still inlined');
  const guidePath = fileURLToPathSafe(new URL('../docs/AGENT_GUIDE.md', import.meta.url));
  assert.ok(text.includes(guidePath), 'context must name the guide path');
  assert.match(text, /Read .*AGENT_GUIDE\.md/);
  assert.ok(text.length < guide.length / 2, `context still ${text.length} chars`);
});

test('the operator block stays first and complete', async t => {
  const {svc, id} = await service(t);
  const text = svc.context(id);
  assert.ok(text.indexOf('Orbit workspace operator block') < text.indexOf('AGENT_GUIDE.md'));
  assert.match(text, /workspace_control\.py/);
  assert.match(text, /plugin_publish\.py/);
});

test('context.parts keeps the guide for callers that choose to inline it', async t => {
  const {svc, id} = await service(t);
  const parts = svc.context.parts(id);
  assert.equal(parts.guide, guide);
  assert.ok(parts.guidePath.endsWith('docs/AGENT_GUIDE.md'));
});

function fileURLToPathSafe(url) { return decodeURIComponent(url.pathname); }
