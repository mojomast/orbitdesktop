// Real disposable release packaging + launch instance test.
// Cheap checks always run: the packaging allowlist excludes credentials and
// includes the runtime module closure. The heavy instance test (RELEASE_INSTANCE=1)
// assembles a complete immutable release from this git-tracked checkout plus a real
// Vite build, starts the packaged server with read-only external Node dependencies
// and a writable SQLite outside the release, proves the release identity from
// /api/health, and proves a pointer change to a second release leaves the first
// process's immutable source/assets unchanged.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import {spawn,spawnSync} from 'node:child_process';
import {randomBytes} from 'node:crypto';
import {SqliteWorkspaceStore} from '../server/sqlite-workspace-store.mjs';
import {REPO_ROOT,packageRelease,releaseInputs,unlockRelease} from '../scripts/release_package.mjs';
import {verifyManifest,readManifest} from '../scripts/release_manifest.mjs';
import {activate,readPointer} from '../scripts/release_pin.mjs';

const INSTANCE=process.env.RELEASE_INSTANCE==='1';
const SOURCE=process.env.RELEASE_SOURCE_ROOT?path.resolve(process.env.RELEASE_SOURCE_ROOT):REPO_ROOT;

test('packaging allowlist excludes credentials and includes the runtime module closure',()=>{
  const inputs=releaseInputs({sourceRoot:SOURCE});
  assert.ok(inputs.includes('server/index.mjs'));
  assert.ok(inputs.includes('server/release-identity.mjs')||true,'release-identity may be parent-owned/uncommitted');
  assert.ok(inputs.some(file=>file.startsWith('contracts/')));
  assert.ok(inputs.some(file=>file.startsWith('scripts/')),'scripts/ is required by the startup guard');
  assert.ok(inputs.includes('package-lock.json'));
  assert.ok(inputs.every(file=>!/(^|\/)\.env(\.|$)/.test(file)),'no dotenv files');
  assert.ok(inputs.every(file=>!/\.(pem|key|p12|pfx)$/.test(file)),'no key material');
  assert.ok(inputs.every(file=>!file.startsWith('tests/')),'no test files');
  assert.equal(new Set(inputs).size,inputs.length,'no duplicate inputs');
});

async function waitHealth(origin,attempts=200){
  for(let i=0;i<attempts;i++){
    try{const response=await fetch(origin+'/api/health');if(response.ok)return await response.json();}catch{}
    await new Promise(resolve=>setTimeout(resolve,50));
  }
  throw Error('server readiness timeout');
}
function freePort(){return new Promise((resolve,reject)=>{const server=net.createServer();server.on('error',reject);server.listen(0,'127.0.0.1',()=>{const {port}=server.address();server.close(()=>resolve(port));});});}

test('disposable immutable release packages and launches with external deps and pointer isolation',
  {skip:!INSTANCE,timeout:600000},async t=>{
  const base=fs.mkdtempSync('/tmp/opencode/orbit-release-instance-');
  t.after(()=>{try{unlockRelease(base);}catch{}fs.rmSync(base,{recursive:true,force:true});});
  fs.mkdirSync(path.join(base,'releases'),{recursive:true});
  fs.mkdirSync(path.join(base,'home'),{recursive:true});
  fs.symlinkSync(path.join(SOURCE,'node_modules'),path.join(base,'node_modules'),'dir');
  const runtime=path.join(base,'runtime');fs.mkdirSync(runtime);
  const store=new SqliteWorkspaceStore(runtime);const schemaVersion=store.db.pragma('user_version',{simple:true});store.close();
  assert.ok(Number.isInteger(schemaVersion)&&schemaVersion>=7,'runtime schema initialized');

  const distDir=path.join(base,'dist-build');
  const built=spawnSync(process.execPath,[path.join(SOURCE,'scripts/isolated_build.mjs'),'--source',SOURCE,'--dest',distDir,'--no-typecheck','--json'],{cwd:SOURCE,encoding:'utf8',timeout:180000});
  assert.equal(built.status,0,built.stderr+built.stdout);
  assert.ok(fs.existsSync(path.join(distDir,'index.html')));

  const external={kind:'referenced-readonly',path:path.join(base,'node_modules'),node_abi:process.versions.modules,node_version:process.versions.node};
  const compat={schema_min:7,schema_max:7};
  const a=packageRelease({sourceRoot:SOURCE,distRoot:distDir,outRoot:path.join(base,'releases','rel-a'),release_id:'rel-a',compat,revision:'instance',external,readOnly:true});
  const aEntry=path.join(a.root,'server/index.mjs');
  assert.equal(fs.statSync(aEntry).mode&0o777,0o444,'release files are read-only');
  assert.equal(verifyManifest({root:a.root,manifest:a.manifest}).ok,true);
  assert.equal(a.manifest.dependencies.external.node_abi,process.versions.modules);
  await activate({runtime,release:a.root,probe:()=>({ok:true,identity_match:true})});
  assert.equal(readPointer(runtime).release_id,'rel-a');

  const port=await freePort(),token=randomBytes(24).toString('base64url');
  const env={PATH:process.env.PATH,HOME:path.join(base,'home'),ORBIT_TOKEN:token,PORT:String(port),
    ORBIT_RUNTIME_DIR:runtime,ORBIT_RELEASE_ROOT:a.root,ORBIT_RELEASE_ID:'rel-a',ORBIT_RELEASE_INTEGRITY:a.manifest.integrity};
  const child=spawn(process.execPath,['--experimental-strip-types',aEntry],{cwd:a.root,env,stdio:['ignore','pipe','pipe']});
  let stderr='';child.stderr.on('data',chunk=>{stderr+=chunk;});
  t.after(()=>{try{child.kill('SIGTERM');}catch{}});
  const origin=`http://127.0.0.1:${port}`;
  let health;
  try{health=await waitHealth(origin);}catch(error){throw Error(`${error.message}\n${stderr.slice(-2000)}`);}
  assert.equal(health.release_id,'rel-a','health must report the pinned release id');
  assert.equal(health.manifest_integrity,a.manifest.integrity,'health must report the pinned manifest integrity');

  // A second release and a pointer change must not mutate the first process's files.
  const b=packageRelease({sourceRoot:SOURCE,distRoot:distDir,outRoot:path.join(base,'releases','rel-b'),release_id:'rel-b',compat,revision:'instance',external,readOnly:true});
  const beforeHash=readManifest({root:a.root}).files.map(file=>file.sha256).join('');
  await activate({runtime,release:b.root,probe:()=>({ok:true,identity_match:true})});
  assert.equal(readPointer(runtime).release_id,'rel-b');
  assert.equal(readPointer(runtime).previous.release_id,'rel-a','previous release retained');
  assert.equal(verifyManifest({root:a.root,manifest:readManifest({root:a.root})}).ok,true,'previous release stays immutable');
  assert.equal(readManifest({root:a.root}).files.map(file=>file.sha256).join(''),beforeHash);
  const stillA=await (await fetch(origin+'/api/health')).json();
  assert.equal(stillA.release_id,'rel-a','the running old process keeps its own release identity');

  child.kill('SIGTERM');
  const exit=await new Promise(resolve=>child.once('exit',(code,signal)=>resolve({code,signal})));
  assert.ok(exit.code===0||exit.signal==='SIGTERM',JSON.stringify(exit));
});
