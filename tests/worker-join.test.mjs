import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { joinFixture } from './fixtures/worker-join.mjs';
import { openWorkerJoinStore, PAIR_MS, TOKEN_MS, SESSION_MS } from '../server/worker-join-store.mjs';
import { join, selectTransport } from '../scripts/worker-join/client.mjs';
import { CLIENT_SHA256, verifiedClientBytes } from '../server/worker-join-artifact.mjs';
import { rehearse } from '../scripts/worker-join-rehearse.mjs';

test('one concurrent exchange wins; a worker cannot list, extend its scope or enter launcher operations',async t => {
  const f = await joinFixture(t); const i = await f.invite();
  assert.deepEqual(Object.keys(i).sort(),['code','expiresAt','orbitUrl','protocol','workerId']);
  const pair = { op:'pair',workerId:i.workerId,code:i.code };
  const res = await Promise.all([f.post(pair),f.post(pair)]);
  assert.deepEqual(res.map(r=>r.status).sort(),[200,401]);
  const { token } = await res.find(r=>r.ok).json(); const auth = { Authorization:`Bearer ${token}` };
  assert.equal((await f.post({ op:'claim' },auth)).status,403);
  assert.equal((await f.post({ op:'heartbeat',platform:'linux',arch:'x64' },auth)).status,200);
  assert.equal((await f.post({ op:'inventory' },{ ...auth,Origin:f.origin })).status,403);
  assert.equal((await f.post({ op:'invite',label:'More',scopes:['verify-client'] },auth)).status,403);
  assert.equal((await f.post({ op:'create' },auth)).status,400);
  assert.equal((await f.post({ op:'refresh',scopes:['verify-client'] },auth)).status,400);
  const inventory = await f.post({ op:'inventory' },f.auth);
  assert.equal(inventory.headers.get('cache-control'),'no-store');
  const data = await inventory.json(); assert.equal(data.workers[0].platform,'linux');
  const db = path.join(f.dir,'worker-join','registry.sqlite');
  for (const secret of [token,i.code,f.owner]) { assert.ok(!JSON.stringify(data).includes(secret)); assert.ok(!fs.readFileSync(db).includes(secret)); }
  assert.equal(fs.statSync(db).mode & 0o777,0o600);
  assert.ok(!fs.existsSync(path.join(f.dir,'local-workers')));
});

function registry(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(),'orbit-join-clock-')); let time = Date.now();
  const db = openWorkerJoinStore(dir,()=>time);
  t.after(()=>{ db.close(); fs.rmSync(dir,{ recursive:true,force:true }); });
  const owner = b => db.dispatch(b,undefined,true,'http://127.0.0.1:4318');
  const invite = (scopes=['presence'])=>owner({ op:'invite',scopes,label:'Lab' });
  const exchange = i=>db.dispatch({ op:'pair',code:i.code,workerId:i.workerId });
  return { dir,db,owner,invite,exchange,set:t=>{ time=t; } };
}
test('pairing and tokens expire at the deadline; refresh rotates within an absolute lifetime',t => {
  const f = registry(t), expired = f.invite(); f.set(expired.expiresAt);
  assert.throws(()=>f.exchange(expired),{ code:'pairing_denied' });
  const pending = f.invite(); f.owner({ op:'revoke',workerId:pending.workerId });
  assert.throws(()=>f.exchange(pending),{ code:'pairing_denied' });
  const i = f.invite(); let creds = f.exchange(i); const start = i.expiresAt - PAIR_MS;
  assert.equal(creds.expiresAt,start + TOKEN_MS);
  while (creds.expiresAt < start + SESSION_MS) {
    f.set(creds.expiresAt - 1); const old = creds.token; creds = f.db.dispatch({ op:'refresh' },old);
    assert.notEqual(creds.token,old); assert.throws(()=>f.db.dispatch({ op:'refresh' },old),{ code:'credential_denied' });
  }
  assert.equal(creds.expiresAt,start+SESSION_MS); f.set(creds.expiresAt);
  assert.throws(()=>f.db.dispatch({ op:'refresh' },creds.token),{ code:'credential_denied' });
  assert.equal(f.owner({ op:'inventory' }).workers.find(w=>w.workerId===i.workerId).state,'expired');
});
test('tasks are bound to their worker; review compares the owner pin; revoked records survive reopen',t => {
  const f = registry(t); const a = f.exchange(f.invite(['verify-client'])), b = f.exchange(f.invite(['verify-client']));
  const queue = () => f.owner({ op:'queue-verification',workerId:a.workerId });
  const claim = w => f.db.dispatch({ op:'claim' },w.token);
  const report = (w,taskId,sha256) => f.db.dispatch({ op:'report',taskId,sha256 },w.token);
  const review = taskId => f.owner({ op:'review-verification',taskId });
  const { taskId } = queue(); assert.throws(queue,{ code:'task_pending' });
  assert.deepEqual(claim(b),{ task:null }); assert.throws(()=>report(a,taskId,CLIENT_SHA256),{ code:'task_unavailable' });
  assert.deepEqual(claim(a).task,{ taskId,kind:'hash-installed-client' });
  assert.throws(()=>report(b,taskId,CLIENT_SHA256),{ code:'task_unavailable' });
  assert.throws(()=>f.db.dispatch({ op:'report',taskId,sha256:CLIENT_SHA256,path:'elsewhere' },a.token),{ code:'invalid_request' });
  report(a,taskId,'f'.repeat(64)); assert.equal(review(taskId).state,'digest_mismatch');
  const second = queue(); claim(a); report(a,second.taskId,CLIENT_SHA256);
  assert.equal(f.owner({ op:'revoke',workerId:a.workerId }).quarantined,1);
  assert.throws(()=>review(second.taskId),{ code:'task_unavailable' });
  const reopened = openWorkerJoinStore(f.dir); t.after(()=>reopened.close());
  for (const op of ['claim','refresh','report']) {
    const request = op==='report' ? { op,taskId:second.taskId,sha256:CLIENT_SHA256 } : { op };
    assert.throws(()=>reopened.dispatch(request,a.token),{ code:'credential_denied' });
  }
  assert.equal(f.owner({ op:'inventory' }).tasks.find(t=>t.taskId===second.taskId).state,'quarantined');
  assert.deepEqual(claim(b),{ task:null });
});
test('request guards refuse forwarded, cross-origin, non-JSON, oversized and ownerless traffic',async t => {
  const f = await joinFixture(t), b = { op:'inventory' };
  for (const headers of [{},{ Authorization:`Bearer ${f.owner}` },{ ...f.auth,Origin:'null' },{ ...f.auth,'X-Forwarded-For':'127.0.0.1' }]) assert.equal((await f.post(b,headers)).status,403);
  assert.equal((await f.post(b,{ ...f.auth,'Content-Type':'text/plain' })).status,415);
  assert.equal((await f.post({ op:'inventory',pad:'x'.repeat(5000) },f.auth)).status,413);
  assert.equal((await f.post(b,f.auth,'?code=ignored')).status,404);
  assert.equal((await f.post({ op:'inventory',extra:true },f.auth)).status,400);
  assert.equal((await f.post({ op:'invite',label:'bad',scopes:['dispatch'] },f.auth)).status,400);
  const disabled = await joinFixture(t,{ env:{ ORBIT_TOKEN:'' } });
  assert.equal((await disabled.post({ op:'claim' })).status,503);
  const exposed = await joinFixture(t,{ env:{ ORBIT_HOST:'0.0.0.0' } });
  assert.equal((await exposed.post(b,exposed.auth)).status,403);
});
test('fixed probe order and overrides; QR and unverified endpoints cannot redirect credentials',async t => {
  const f = await joinFixture(t), invite = await f.invite(), seen = [];
  const decoy = http.createServer(async(req,res)=>{ let text = ''; for await (const c of req) text += c;
    seen.push({ url:req.url,body:JSON.parse(text),auth:req.headers.authorization });
    res.writeHead(307,{ Location:f.origin+'/api/local-workers' }); res.end(); });
  await new Promise(resolve=>decoy.listen(0,'127.0.0.1',resolve)); t.after(()=>new Promise(resolve=>decoy.close(resolve)));
  const origin = `http://127.0.0.1:${decoy.address().port}`;
  const all = { https:origin.replace('http:','https:'),loopback:origin };
  await assert.rejects(join(invite,all),err=>{
    assert.deepEqual(err.observations.map(x=>x.kind),['https','loopback','tailcat','mesh']);
    assert.deepEqual(err.observations.map(x=>x.status),['probe_failed','probe_failed','native_adapter_unavailable','native_adapter_unavailable']); return true;
  });
  assert.equal(seen.length,1); assert.equal(seen[0].auth,undefined); assert.deepEqual(Object.keys(seen[0].body).sort(),['nonce','op','workerId']);
  const fallback = await selectTransport(invite,{ ...all,loopback:f.origin }); assert.equal(fallback.kind,'loopback');
  assert.equal(fallback.observations[0].status,'probe_failed');
  const selected = await selectTransport({ ...invite,orbitUrl:origin },{ ...all,loopback:f.origin },{ only:'loopback' });
  assert.equal(selected.observations[0].status,'override_skipped'); assert.equal(seen.length,1);
  for (const invalid of ['http://localhost:123','http://192.0.2.1:123','http://127.0.0.1:123/extra','http://127.0.0.1:123?code=x','http://127.0.0.1:99999']) await assert.rejects(selectTransport(invite,{ loopback:invalid }),{ code:'invalid_owned_endpoint' });
  await assert.rejects(selectTransport({ ...invite,code:undefined },{ loopback:f.origin }),{ code:'invalid_invitation' });
});

test('the CLI selects an explicitly trusted TLS loopback endpoint and does not print secrets',async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(),'orbit-join-tls-')); t.after(()=>fs.rmSync(root,{ recursive:true,force:true }));
  const cert = path.join(root,'test-cert.pem'), key = path.join(root,'test-key.pem');
  execFileSync('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-days','1','-subj','/CN=local fixture','-addext','subjectAltName=IP:127.0.0.1','-keyout',key,'-out',cert],{ stdio:'ignore' });
  const f = await joinFixture(t,{ tls:{ key:fs.readFileSync(key),cert:fs.readFileSync(cert) } });
  // Seed via the owner store so the test runner never changes global TLS trust.
  const db = openWorkerJoinStore(f.dir);
  let i; try { i = db.dispatch({ op:'invite',scopes:['presence'],label:'TLS CLI' },null,true,f.origin); } finally { db.close(); }
  await assert.rejects(selectTransport(i,{ https:f.origin }),{ code:'no_verified_transport' });
  const child = spawn(process.execPath,['scripts/worker-join/client.mjs','--https',f.origin,'--once'],{ env:{ NODE_EXTRA_CA_CERTS:cert },stdio:['pipe','pipe','pipe'] });
  let out='',err=''; child.stdout.on('data',c=>{out+=c;}); child.stderr.on('data',c=>{err+=c;});
  child.stdin.end(JSON.stringify(i));
  assert.equal(await new Promise((res,rej)=>{child.once('exit',res);child.once('error',rej);}),0,err);
  assert.deepEqual(JSON.parse(out).observations,[{ kind:'https',status:'selected' }]);
  assert.ok(!out.includes(i.code) && !out.includes('wjt_') && !err.includes(i.code));
  const verify = openWorkerJoinStore(f.dir); try { assert.equal(verify.dispatch({ op:'inventory' },null,true).workers[0].platform,process.platform); } finally { verify.close(); }
});
test('throwaway staging verifies actual bytes; drift and symlinks fail; unrun steps stay unrun',async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(),'orbit-join-verify-')); t.after(()=>fs.rmSync(dir,{ recursive:true,force:true }));
  const staged = path.join(dir,'staged.mjs'); fs.writeFileSync(staged,verifiedClientBytes()); fs.appendFileSync(staged,'// drift');
  assert.throws(()=>verifiedClientBytes(staged),/client_digest_mismatch/);
  fs.symlinkSync(staged,path.join(dir,'link')); assert.throws(()=>verifiedClientBytes(path.join(dir,'link')));
  const dry = await rehearse(); assert.equal(dry.stage,'not_run'); assert.equal(dry.image,null); assert.equal(dry.pairing,'not_run');
  await assert.rejects(rehearse('some-target'),/expected/);
  const local = await rehearse('--local'); assert.equal(local.pairingLifetimeMs,900000); assert.equal(local.digestCheck,'staged_bytes_and_report_match_pin');
  assert.equal(local.teardown,'local_stage_removed_listener_closed'); assert.equal(local.acceptedWave,'not_run'); assert.equal(local.liveHost,'not_run');
});
