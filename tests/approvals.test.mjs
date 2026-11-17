// Keep the legacy-format contract in the ordinary `tests/*.test.mjs` suite.
import '../server/approvals-route.test.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { bindingDigest, createApprovalsRoute } from '../server/approvals-route.mjs';

// A real loopback socket, an empty private root and ephemeral credentials. The
// production composition-root refusal is exercised in server-boot.test.mjs.
async function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'approval-http-'));
  const token = randomBytes(32).toString('hex');
  const key = randomBytes(32);
  const pending = path.join(root, 'pending');
  const decisions = path.join(root, 'decisions');
  fs.mkdirSync(pending);
  let route;
  const server = http.createServer((req,res) => route.handle(req,res));
  await new Promise((resolve,reject) => server.once('error',reject).listen(0,'127.0.0.1',resolve));
  t.after(async () => {
    await new Promise(resolve => server.close(resolve));
    fs.rmSync(root, {recursive:true, force:true});
  });
  const {port} = server.address();
  const restart = () => { route = createApprovalsRoute({root,token,key,port}); };
  restart();
  const origin = `http://127.0.0.1:${port}`;
  const request = (suffix = '', body, headers = {}) => fetch(origin + '/api/approvals' + suffix, {
    headers:{Origin:origin, Authorization:`Bearer ${token}`, 'Content-Type':'application/json', ...headers},
    ...(body ? {method:'POST',body:JSON.stringify(body)} : {}),
  });
  function seed(id) {
    const row = {id, job:{test:id}, expires_at:new Date(Date.now()+60000).toISOString()};
    fs.writeFileSync(path.join(pending,`${id}.json`), JSON.stringify(row));
    return bindingDigest(row);
  }
  return {root, decisions, journal:path.join(decisions,'journal.jsonl'), request, seed, restart};
}

test('local HTTP store: neither transport hints nor actor/workspace claims grant access', async t => {
  const a = await fixture(t), b = await fixture(t);
  const binding = a.seed('one');
  b.seed('two');
  const decision = {decision:'approve', binding};
  for (const headers of [
    {Authorization:'', 'X-Actor':'owner', 'X-Workspace-Id':'one'},
    {Authorization:'Bearer '+randomBytes(32).toString('hex')},
    {Origin:'null'}, {Origin:'https://foreign.invalid'},
  ]) {
    for (const [url,body] of [['',null], ['/one',null], ['/one/decision',decision]])
      assert.equal((await a.request(url,body,headers)).status,403);
  }
  assert.equal((await a.request('/two',null,{'X-Workspace-Id':'two'})).status,404);
  assert.equal((await a.request('/one/decision',{...decision,actor:'owner'})).status,400);
  assert.equal((await a.request('/one/decision',{decision:'approve'})).status,409);
  assert.equal(fs.existsSync(a.journal),false);
});

test('successful retry inspection and subsequent append preserve the original journal inode and bytes', async t => {
  const f = await fixture(t);
  const one = {decision:'approve',binding:f.seed('one')};
  const two = {decision:'decline',binding:f.seed('two')};
  assert.equal((await f.request('/one/decision',one)).status,200);
  const original = fs.readFileSync(f.journal,'utf8');
  const first = fs.statSync(f.journal);
  assert.equal(first.mode & 0o777,0o600);
  f.restart();
  const retry = await f.request('/one/decision',one);
  assert.equal(retry.status,409);
  assert.equal((await retry.json()).error,'already_decided');
  assert.equal((await f.request('/one/decision',{...one,decision:'decline'})).status,409);
  assert.equal(fs.readFileSync(f.journal,'utf8'),original);
  assert.equal((await f.request('/two/decision',two)).status,200);
  const second = fs.statSync(f.journal);
  assert.deepEqual([first.dev, first.ino],[second.dev,second.ino]);
  const text = fs.readFileSync(f.journal,'utf8');
  assert.ok(text.startsWith(original));
  assert.deepEqual(text.trimEnd().split('\n').map(line=>JSON.parse(line).approval_id),['one','two']);
});

test('incomplete, corrupt or unreadable history fences decisions and retries without rewriting evidence', async t => {
  const f = await fixture(t);
  const first = {decision:'approve',binding:f.seed('one')};
  const next = {decision:'approve',binding:f.seed('two')};
  assert.equal((await f.request('/one/decision',first)).status,200);
  const original = fs.readFileSync(f.journal);
  const receipt = path.join(f.decisions,'one.json');
  async function fenced() {
    f.restart();
    for (const [url,body] of [['',null], ['/one',null], ['/two/decision',next], ['/one/decision',first]]) {
      const response = await f.request(url,body);
      assert.equal(response.status,503);
      assert.deepEqual(await response.json(),{error:'approval_store_unavailable'});
    }
    assert.equal(fs.existsSync(path.join(f.decisions,'two.json')),false);
  }
  for (const bad of [Buffer.concat([original,Buffer.from('{')]), Buffer.concat([Buffer.from('null\n'),original]),
    Buffer.concat([original,original]), Buffer.alloc(0),Buffer.from([0xff,0x0a])]) {
    fs.writeFileSync(f.journal,bad);
    await fenced();
    assert.deepEqual(fs.readFileSync(f.journal),bad);
  }
  fs.unlinkSync(f.journal); // ENOENT is not a fresh store when a receipt exists.
  await fenced();
  assert.equal(fs.existsSync(f.journal),false);
  fs.mkdirSync(f.journal); // deterministic non-ENOENT error even when run as root
  await fenced();
  assert.ok(fs.statSync(f.journal).isDirectory());
  fs.rmdirSync(f.journal);
  fs.writeFileSync(f.journal,original);
  const saved = fs.readFileSync(receipt);
  fs.unlinkSync(receipt); // crash after journal fsync, before receipt publication
  await fenced();
  assert.equal(fs.existsSync(receipt),false);
  fs.writeFileSync(receipt,'{');
  await fenced();
  assert.equal(fs.readFileSync(receipt,'utf8'),'{');
  fs.writeFileSync(receipt,saved); // offline restoration of the original evidence
  assert.equal((await f.request('/one/decision',first)).status,409);
  assert.equal((await f.request('/two/decision',next)).status,200);
});

test('journal fsync failure cannot publish a receipt; restart cannot re-sign an uncertain write', async t => {
  const f = await fixture(t);
  const body = {decision:'approve',binding:f.seed('one')};
  const sync = fs.fsyncSync;
  let injected = false;
  const fault = t.mock.method(fs,'fsyncSync',fd => {
    if (fs.fstatSync(fd).isFile()) {
      injected = true;
      throw Object.assign(Error('synthetic journal failure'), {code:'EIO'});
    }
    return sync(fd);
  });
  assert.equal((await f.request('/one/decision',body)).status,503);
  fault.mock.restore();
  assert.ok(injected);
  const partial = fs.readFileSync(f.journal);
  assert.equal(JSON.parse(partial.toString()).approval_id,'one');
  f.restart();
  assert.equal((await f.request('/one/decision',body)).status,503);
  assert.equal((await f.request('/one')).status,503);
  assert.deepEqual(fs.readFileSync(f.journal),partial);
  assert.ok(!fs.existsSync(path.join(f.decisions,'one.json')));
});
