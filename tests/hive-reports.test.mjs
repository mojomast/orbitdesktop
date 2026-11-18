import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {execFileSync} from 'node:child_process';
import {pathToFileURL} from 'node:url';
import {createHiveReportsRoute, HIVE_REPORTS_ROUTE as route} from '../server/hive-reports.mjs';

const token = 'owner-only-synthetic-value-for-the-reader';
const port = 4318, host = `localhost:${port}`, origin = `http://${host}`;
const headers = {host, origin, authorization: 'Bearer ' + token};
const empty = {version: 'hive.reports/1', queue: null, release: null, labels: null};
const reply = (_res, status, data) => ({status, data});
const handler = dir => createHiveReportsRoute({dir, token, port, reply});
const get = (handle, req = {}) => handle({url: route, method: 'GET', headers, ...req}, {});
const linux = {skip: process.platform !== 'linux' || !['x64','arm64'].includes(process.arch)};
const queue = () => ({version:'hive.queue/1', subject:{featureId:'F1',jobId:'job_a'},
  observedAt:new Date().toISOString().replace(/\.\d+Z$/, 'Z'), queue:{state:'claimed',updatedAt:null,sha256:'a'.repeat(64)},
  scheduler:{state:'unknown',overlap:'unknown',sha256:null},lease:{state:'unknown',sha256:null},
  coverage:{state:'UNKNOWN',head:null,covered:null,total:null,sha256:null,verificationSha256:null}});

async function temp(t) {
  const root = await fs.mkdtemp(path.resolve(os.tmpdir(), 'hive-reader-'));
  t.after(() => fs.rm(root, {recursive:true, force:true}));
  return root;
}

// An ordinary TMPDIR has a shared writable ancestor. Model the fixture root as
// '/' at the fs boundary in these tests only, keeping the actual Linux opens,
// private modes, mounts, inode identities, fd-pinned path traversal and reads.
// No configurable test root, ownership exception or injectable I/O in the API.
async function source(t) {
  const root = await temp(t), parent = path.join(root,'operator'), dir = path.join(parent,'reports');
  await fs.mkdir(dir, {recursive:true, mode:0o700});
  const open = fs.open.bind(fs), lstat = fs.lstat.bind(fs), readlink = fs.readlink.bind(fs);
  const opens = [], reads = [];
  const hooks = {};
  t.mock.method(fs,'open',async (file,flags,...other) => {
    opens.push(file);
    const fd = await open(file === '/' ? root : file,flags,...other);
    if (/^\/proc\/self\/fd\/\d+$/.test(file)) {
      const name = path.basename(await readlink(file));
      const read = fd.read.bind(fd);
      fd.read = async (...args) => {
        reads.push({name, bytes:args[2]});
        const result = await read(...args);
        await hooks.afterRead?.(name);
        return result;
      };
    }
    return fd;
  });
  t.mock.method(fs,'lstat',(file, opts) => lstat(file === '/' ? root : file, opts));
  t.mock.method(fs,'readlink',async file => {
    const target = await readlink(file);
    return target === root ? '/' : target.startsWith(root + '/') ? target.slice(root.length) : target;
  });
  const write = (name,data) => fs.writeFile(path.join(dir,name), typeof data === 'string' || Buffer.isBuffer(data) ? data : JSON.stringify(data), {mode:0o600});
  const read = () => get(handler('/operator/reports'));
  return {root, parent, dir, write, read, opens, reads, hooks};
}

test('exact GET, owner bearer and accepted Host/Origin precede all source I/O', async t => {
  const service = handler('/enrolled');
  const opens = t.mock.method(fs,'open',() => { throw Error(); });
  for (const [change,status] of [
    [{authorization:undefined},401], [{authorization:token},401], [{authorization:'Bearer guest'},401],
    [{host:'bad.example'},403], [{origin:'http://bad.example'},403], [{origin:'null'},403],
    [{origin:undefined},403], [{origin:undefined,'sec-fetch-site':'none'},403],
    [{'sec-fetch-site':'cross-site'},403], [{authorization:undefined,cookie:`orbit=${token}`},401],
    [{'content-length':'2'},400], [{'transfer-encoding':'chunked'},400],
  ]) assert.deepEqual(await get(service,{headers:{...headers,...change}}), {status,data:empty});
  for (const url of [route+'?',route+'#ignored',route+'?dir=/private',route+'/queue.json','/api/xx/../rizzstack/hive/reports','http://localhost'+route]) {
    assert.deepEqual(await get(service,{url}),{status:400,data:empty});
  }
  for (const method of ['HEAD','POST','PUT','PATCH','DELETE','OPTIONS']) assert.deepEqual(await get(service,{method}),{status:405,data:empty});
  assert.equal(opens.mock.callCount(),0);
  assert.deepEqual(await get(handler(''),{headers:{...headers,origin:undefined,'sec-fetch-site':'same-origin'}}),{status:200,data:empty});
});

test('default off and noncanonical enrollment are source-free, even with server-only installation', async t => {
  const root = await temp(t);
  for (const module of ['hive-reports.mjs','security.mjs']) {
    await fs.copyFile(new URL(`../server/${module}`,import.meta.url),path.join(root,module));
  }
  const isolated = await import(pathToFileURL(path.join(root,'hive-reports.mjs')));
  const opened = t.mock.method(fs,'open',() => {throw Error();});
  for (const dir of [undefined, '', 'relative', '/', '/./private', '/a/../b','/safe/', '//root', '/a//b', '/a\\b', '/x\n', '/x\0', '/a'.repeat(33)]) {
    const handle = isolated.createHiveReportsRoute({dir,token,port,reply});
    assert.deepEqual(await get(handle),{status:200,data:empty});
  }
  assert.equal(opened.mock.callCount(),0);
});

test('read-only source mode: validates files independently, reads only fixed basenames and claims no loaded identity', linux, async t => {
  const s = await source(t), q = queue();
  await s.write('queue.json', q);
  await s.write('release.json', {release_id:'private generic release metadata',manifest_integrity:'b'.repeat(64)});
  await s.write('labels.json', {version:'hive.public-labels/1',secret:'some private prose'});
  await s.write('unrelated.json', {private:'unrelated'});
  const {data,status} = await s.read();
  assert.equal(status,200);
  assert.deepEqual(data,{...empty,queue:q});
  assert.deepEqual(s.reads.map(r=>r.name),['queue.json','release.json','labels.json']);
  assert.ok(s.reads.reduce((n,r)=>n+r.bytes,0)<=3*65536);
  assert.ok(Buffer.byteLength(JSON.stringify(data))<200*1024);
  assert.doesNotMatch(JSON.stringify(data),/private|manifest_integrity|unrelated|\/operator/);
  await s.write('queue.json',{...q,subject:{...q.subject,featureId:token}});
  assert.deepEqual((await s.read()).data,empty,'owner bearer in an otherwise valid public ID is refused');
});

test('all three public validators accept real packet shapes; exact input ceilings are enforced before data read', linux, async t => {
  const s = await source(t), q = queue(), at = new Date().toISOString(), sha = 'c'.repeat(40);
  const checks = {at,sha,total:0,sampled:0,truncated:false,success:0,failure:0,skipped:0,neutral:0,pending:0};
  const repos = [['workflow',1455472841,91],['bundlebees',1454339884,82],['hyvv',1455851481,26],['orbitdesktop',1377703993,46]];
  const release = {schema:'hive-release-read/1',startedAt:at,observedAt:at,repos:repos.map(([r,repoId,number]) => ({
    repo:`mojomast/${r}`,repoId,at,main:{at,sha,checks},
    prs:[{at,number,head:sha,base:sha,draft:true,state:'open',mergedAt:null,mergedSha:null,checks}],
  }))};
  const labels = {version:'hive.public-labels/1',reviewedAt:at,rows:[{kind:'job',id:'amber',repo:'example/saffron',jobId:'amber',title:'Amber relay',revision:'a'.repeat(64)}]};
  const files = [['queue.json',q,65536],['release.json',release,16384],['labels.json',labels,65536]];
  for (const [file,data,limit] of files) await s.write(file,JSON.stringify(data).padEnd(limit));
  assert.deepEqual((await s.read()).data,{...empty,queue:q,release,labels});
  for (const [file] of files) await fs.appendFile(path.join(s.dir,file),' ');
  s.reads.length = 0;
  assert.deepEqual((await s.read()).data,empty);
  assert.equal(s.reads.length,0);
});

test('permissions, owner checks, symlinks (including ancestors), aliases, hardlinks, FIFO and oversized report', linux, async t => {
  const s = await source(t), file = path.join(s.dir,'queue.json');
  await s.write('queue.json',queue());
  for (const [name,unsafe,safe] of [[s.parent,0o775,0o700],[s.dir,0o750,0o700],[file,0o640,0o600],[file,0o4600,0o600]]) {
    await fs.chmod(name,unsafe);
    assert.deepEqual((await s.read()).data,empty);
    await fs.chmod(name,safe);
  }
  await fs.symlink(s.dir,path.join(s.parent,'alias'));
  await fs.symlink(s.parent,path.join(s.root,'alias'));
  for (const dir of ['/operator/alias','/alias/reports']) assert.deepEqual((await get(handler(dir))).data,empty);
  const outside = path.join(s.parent,'outside');
  await fs.link(file,outside); assert.deepEqual((await s.read()).data,empty);
  await fs.unlink(file); await fs.symlink(outside,file); assert.deepEqual((await s.read()).data,empty);
  await fs.unlink(file); execFileSync('mkfifo',[file]); assert.deepEqual((await s.read()).data,empty);
  await fs.unlink(file); await s.write('queue.json',' '.repeat(65537)); assert.deepEqual((await s.read()).data,empty);
  assert.equal(s.reads.length,0,'all unsafe sources rejected before data read');
});

test('foreign uid on a private source is unavailable before the data open', linux, async t => {
  const s = await source(t);
  await s.write('queue.json',queue());
  // Model foreign owner metadata without chown privileges or changing a host account.
  const open = fs.open;
  t.mock.method(fs,'open',async (file,...opts) => {
    const fd = await open(file,...opts);
    if (file.endsWith('/queue.json')) {
      const stat = fd.stat.bind(fd);
      fd.stat = async options => { const st = await stat(options); st.uid++; return st; };
    }
    return fd;
  });
  assert.deepEqual((await s.read()).data,empty);
  assert.equal(s.reads.length,0);
});

test('mount aliases are refused even when dev/ino and private modes appear acceptable', linux, async t => {
  const s = await source(t);
  await s.write('queue.json',queue());
  const readFile = fs.readFile.bind(fs);
  t.mock.method(fs,'readFile',async (name,...other) => {
    if (name.startsWith('/proc/self/fdinfo/') && (await fs.readlink(name.replace('/fdinfo/','/fd/'))).endsWith('/queue.json')) return 'mnt_id:\t9999999999999\n';
    return readFile(name,...other);
  });
  assert.deepEqual((await s.read()).data,empty);
  assert.equal(s.reads.length,0);
});

test('strict bounded JSON: decoded duplicate keys, invalid UTF-8/BOM, excessive depth and malformed or private input', linux, async t => {
  const s = await source(t), q = JSON.stringify(queue());
  for (const invalid of [q.replace('"version":','"version":null,"version":'),
    q.replace('"jobId":','"jobId":"discarded","job\\u0049d":'), '\ufeff'+q,
    Buffer.concat([Buffer.from(q),Buffer.from([0xff])]), '{"x":'+'['.repeat(64)+'0'+']'.repeat(64)+'}',
    q.replace('"F1"','"F\\ud800"'), q.replace('"F1"','"F\\u202e1"'), q.replace('"F1"','"F\\n1"'),
    q.slice(0,-1)+',"__proto__":{}}',q.slice(0,-1)+',"private":"private-key"}',
    '{"__proto__":true}', q+'x', q+q, '{"key":1e500}', '{"private":"/hidden/work/records"}',
  ]) {
    await s.write('queue.json',invalid);
    assert.deepEqual((await s.read()).data,empty);
  }
});

test('refuses replacement, chmod and same-size in-place writes during a read', linux, async t => {
  const s = await source(t), file = path.join(s.dir,'queue.json');
  for (const race of ['mode','rewrite','replace','ancestor']) {
    await s.write('queue.json',queue());
    s.hooks.afterRead = async name => {
      if (name !== 'queue.json') return;
      if (race === 'mode') await fs.chmod(file,0o644);
      if (race === 'rewrite') {
        const before = await fs.readFile(file,'utf8');
        await fs.writeFile(file,before.replace('"F1"','"F2"'));
        await fs.utimes(file,1,1);
      }
      if (race === 'replace') { await s.write('next',queue()); await fs.rename(path.join(s.dir,'next'),file); }
      if (race === 'ancestor') await fs.chmod(s.parent,0o777);
    };
    assert.deepEqual((await s.read()).data,empty,race);
    await fs.chmod(file,0o600); await fs.chmod(s.parent,0o700);
  }
  assert.equal(s.reads.length,4);
});

test('one in-flight read, no queued reads or cached replay under rate limit', linux, async t => {
  const s = await source(t), service = handler('/operator/reports'), q = queue();
  await s.write('queue.json',q);
  let resume, started;
  const reading = new Promise(r => {started=r;});
  const gate = new Promise(r => {resume=r;});
  s.hooks.afterRead = async () => {started();await gate;};
  const first = get(service);
  await reading;
  assert.deepEqual(await get(service),{status:429,data:empty});
  resume();
  assert.deepEqual(await first,{status:200,data:{...empty,queue:q}});
  assert.deepEqual(await get(service),{status:429,data:empty});
  assert.equal(s.reads.length,1);
});
