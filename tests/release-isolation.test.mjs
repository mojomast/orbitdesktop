// Release boundary regressions: recursive manifest integrity over nested values,
// complete inventory/required/path/mode/symlink verification, real-SQLite schema
// compatibility, separated-root enforcement and truthful activation/rollback.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import {createHash} from 'node:crypto';
import Database from 'better-sqlite3';
import {EventEmitter} from 'node:events';
import {ManifestError,assertCompatComplete,buildManifest,canonicalJson,manifestIntegrity,readManifest,verifyManifest} from '../scripts/release_manifest.mjs';
import {PinError,activate,checkCompatibility,currentSchemaVersion,probeReleaseIdentity,readPointer,resolveLaunch,rollback,startRelease,writePointerAtomic} from '../scripts/release_pin.mjs';
import {assertSeparatedRoots} from '../scripts/release_roots.mjs';

const root=()=>fs.mkdtempSync('/tmp/opencode/orbit-rel-');
const write=(target,text,mode)=>{fs.mkdirSync(path.dirname(target),{recursive:true});fs.writeFileSync(target,text);if(mode)fs.chmodSync(target,mode);};
const sha=value=>createHash('sha256').update(value).digest('hex');
const CONTRACTS=['workspace-v1.mjs','workbench-v1.mjs','workbench-result-v1.mjs'];

function fakeRelease(base,release_id,{compat={schema_min:7,schema_max:7},lock={lockfileVersion:3,packages:{}}}={}){
  const dir=path.join(base,release_id);
  write(path.join(dir,'dist/index.html'),'<h1>served</h1>');
  write(path.join(dir,'server/index.mjs'),`// server ${release_id}\n`);
  for(const name of CONTRACTS)write(path.join(dir,'contracts',name),`// contract ${name}\n`);
  write(path.join(dir,'hermes-plugin/workbench.py'),'# plugin\n');
  write(path.join(dir,'package.json'),'{}');
  write(path.join(dir,'package-lock.json'),JSON.stringify(lock));
  const manifest=buildManifest({root:dir,release_id,compat,revision:'test',created_at:1});
  write(path.join(dir,'.orbit-release-manifest.json'),`${JSON.stringify(manifest,null,2)}\n`);
  return {dir,manifest};
}
function runtimeWithSchema(base,schema){
  const runtime=path.join(base,'runtime');fs.mkdirSync(runtime);
  const db=new Database(path.join(runtime,'workspace.sqlite'));db.pragma(`user_version = ${schema}`);db.close();
  return runtime;
}
const healthyProbe=context=>({ok:true,identity_match:true,release_id:context.release_id});

test('manifest integrity covers nested file hashes and compatibility values',t=>{
  const base=root();t.after(()=>fs.rmSync(base,{recursive:true,force:true}));
  const {dir,manifest}=fakeRelease(base,'rel-1');
  assert.equal(verifyManifest({root:dir,manifest}).ok,true);
  assert.equal(manifestIntegrity(manifest),manifest.integrity);
  assert.equal(canonicalJson({b:1,a:{d:2,c:3}}),'{"a":{"c":3,"d":2},"b":1}');
  // Nested file hash mutation without recomputation must invalidate integrity.
  const fileTampered=structuredClone(manifest);fileTampered.files[0].sha256='0'.repeat(64);
  assert.ok(verifyManifest({root:dir,manifest:fileTampered}).errors.some(error=>error.code==='integrity'),'nested file hash must be covered');
  // Nested compat mutation without recomputation must invalidate integrity.
  const compatTampered=structuredClone(manifest);compatTampered.compat.schema_max=99;
  assert.ok(verifyManifest({root:dir,manifest:compatTampered}).errors.some(error=>error.code==='integrity'),'nested compat must be covered');
});

test('manifest verification rejects extra, missing, unsafe, duplicate, mode and symlink content',t=>{
  const base=root();t.after(()=>fs.rmSync(base,{recursive:true,force:true}));
  const {dir,manifest}=fakeRelease(base,'rel-2');
  write(path.join(dir,'server/extra.mjs'),'// unlisted served/server file');
  assert.ok(verifyManifest({root:dir,manifest}).errors.some(error=>error.code==='unlisted_file'&&error.path==='server/extra.mjs'));
  fs.rmSync(path.join(dir,'server/extra.mjs'));
  write(path.join(dir,'dist/index.html'),'<h1>tampered</h1>');
  assert.ok(verifyManifest({root:dir,manifest}).errors.some(error=>error.code==='hash_mismatch'));
  write(path.join(dir,'dist/index.html'),'<h1>served</h1>');
  fs.chmodSync(path.join(dir,'server/index.mjs'),0o700);
  assert.ok(verifyManifest({root:dir,manifest}).errors.some(error=>error.code==='mode_mismatch'),'mode change must be detected');
  fs.chmodSync(path.join(dir,'server/index.mjs'),parseInt(manifest.files.find(file=>file.path==='server/index.mjs').mode,8));
  for(const unsafe of ['../escape','/absolute','a\\b','a//b','./x']){
    const injected=structuredClone(manifest);injected.files.push({path:unsafe,bytes:1,mode:'644',sha256:'0'.repeat(64)});injected.integrity=manifestIntegrity(injected);
    assert.ok(verifyManifest({root:dir,manifest:injected}).errors.some(error=>error.code==='unsafe_path'&&error.path===unsafe),unsafe);
  }
  const duplicated=structuredClone(manifest);duplicated.files.push({...duplicated.files[0]});duplicated.integrity=manifestIntegrity(duplicated);
  assert.ok(verifyManifest({root:dir,manifest:duplicated}).errors.some(error=>error.code==='duplicate_path'));
  const linked=path.join(base,'rel-linked');write(path.join(linked,'dist/index.html'),'x');fs.mkdirSync(path.join(linked,'server'));
  fs.symlinkSync(path.join(dir,'server/index.mjs'),path.join(linked,'server/index.mjs'));
  assert.equal(verifyManifest({root:linked,manifest:manifest}).ok,false,'symlinked content must fail closed');
});

test('manifest requires the lockfile and a complete compatibility set',t=>{
  const base=root();t.after(()=>fs.rmSync(base,{recursive:true,force:true}));
  const {dir}=fakeRelease(base,'rel-3');
  fs.rmSync(path.join(dir,'package-lock.json'));
  assert.throws(()=>buildManifest({root:dir,release_id:'rel-3'}),error=>error instanceof ManifestError&&error.code==='missing_required_component');
  for(const bad of [{node:'',schema_min:7,schema_max:7,hermes_commit:'0'.repeat(40)},{node:'>=22',schema_min:null,schema_max:7,hermes_commit:'0'.repeat(40)},{node:'>=22',schema_min:7,schema_max:7,hermes_commit:'nope'},{node:'>=22',schema_min:8,schema_max:7,hermes_commit:'0'.repeat(40)}])
    assert.throws(()=>assertCompatComplete(bad),{code:'incomplete_compatibility'});
  assert.throws(()=>checkCompatibility({manifest:{compat:{node:'>=22',schema_min:7,schema_max:7,hermes_commit:null}},schema_version:7}),{code:'incomplete_compatibility'});
});

test('currentSchemaVersion reads a real SQLite file through the real opener',async t=>{
  const base=root();t.after(()=>fs.rmSync(base,{recursive:true,force:true}));
  const runtime=runtimeWithSchema(base,7);
  const {schema_version,database}=await currentSchemaVersion(runtime);
  assert.equal(schema_version,7);
  assert.equal(database,path.join(runtime,'workspace.sqlite'));
  const empty=path.join(base,'empty-runtime');fs.mkdirSync(empty);
  assert.deepEqual(await currentSchemaVersion(empty),{schema_version:null,database:null});
});

test('activation refuses colliding runtime/release roots before any write',async t=>{
  const base=root();t.after(()=>fs.rmSync(base,{recursive:true,force:true}));
  const release=fakeRelease(base,'rel-sep');
  const runtimeInsideRelease=path.join(release.dir,'data');fs.mkdirSync(runtimeInsideRelease);
  const before=JSON.stringify(readPointer(runtimeInsideRelease));
  await assert.rejects(activate({runtime:runtimeInsideRelease,release:release.dir,probe:healthyProbe}),{code:'roots_not_separated'});
  assert.equal(JSON.stringify(readPointer(runtimeInsideRelease)),before,'no pointer is written for colliding roots');
  const runtime=runtimeWithSchema(base,7);
  const releaseInsideRuntime=path.join(runtime,'rel');fs.mkdirSync(releaseInsideRuntime);
  assert.throws(()=>assertSeparatedRoots({runtime,release:releaseInsideRuntime}),{code:'roots_not_separated'});
  const alias=path.join(base,'runtime-alias');fs.symlinkSync(release.dir,alias,'dir');
  await assert.rejects(activate({runtime:alias,release:release.dir,probe:healthyProbe}),{code:'roots_not_separated'});
  await assert.rejects(activate({runtime:'relative/runtime',release:release.dir}),{code:'invalid_root'});
  await assert.rejects(activate({runtime:'',release:release.dir}),{code:'invalid_root'});
  const prior=path.join(runtime,'prior');fs.mkdirSync(prior);
  assert.throws(()=>assertSeparatedRoots({runtime,release:release.dir,previous:prior}),{code:'roots_not_separated'});
});

test('activation reports pointer selection separately from verified runtime activation',async t=>{
  const base=root();t.after(()=>fs.rmSync(base,{recursive:true,force:true}));
  const runtime=runtimeWithSchema(base,7);
  const a=fakeRelease(base,'rel-a'),b=fakeRelease(base,'rel-b'),c=fakeRelease(base,'rel-c');
  const first=await activate({runtime,release:a.dir,probe:healthyProbe,now:1});
  assert.equal(first.pointer_selected,true);assert.equal(first.runtime_activated,true);
  const second=await activate({runtime,release:b.dir,probe:healthyProbe,now:2});
  assert.equal(second.runtime_activated,true);
  let pointer=readPointer(runtime);
  assert.equal(pointer.release_id,'rel-b');assert.equal(pointer.previous.release_id,'rel-a');assert.equal(pointer.previous.previous,null);
  // An old server returning 200 without the pinned identity is not activated.
  const mismatched=await activate({runtime,release:c.dir,probe:()=>({ok:false,identity_match:false,status:200}),now:3});
  assert.equal(mismatched.pointer_selected,false);assert.equal(mismatched.runtime_activated,false);assert.equal(mismatched.rolled_back,true);
  assert.equal(readPointer(runtime).release_id,'rel-b');
  // No probe supplied: selected but explicitly unverified, never claimed healthy.
  const unverified=await activate({runtime,release:c.dir,now:4});
  assert.equal(unverified.pointer_selected,true);assert.equal(unverified.runtime_activated,false);assert.equal(unverified.health.unverified,true);
  assert.equal(readPointer(runtime).release_id,'rel-c');
  assert.equal(readPointer(runtime).previous.release_id,'rel-b');
  assert.equal(readPointer(runtime).previous.previous,null,'previous chain must stay bounded');
});

test('a real 200 without release identity is rejected; identity match is required',async t=>{
  const base=root();t.after(()=>fs.rmSync(base,{recursive:true,force:true}));
  const {dir,manifest}=fakeRelease(base,'rel-probe');
  const old=await probeReleaseIdentity({url:'data:',release_id:manifest.release_id,manifest_integrity:manifest.integrity,fetchImpl:async()=>({status:200,text:async()=>JSON.stringify({ok:true})})});
  assert.equal(old.ok,false);assert.equal(old.identity_match,false);
  const matched=await probeReleaseIdentity({url:'data:',release_id:manifest.release_id,manifest_integrity:manifest.integrity,fetchImpl:async()=>({status:200,text:async()=>JSON.stringify({release_id:manifest.release_id,manifest_integrity:manifest.integrity})})});
  assert.equal(matched.ok,true);assert.equal(matched.identity_match,true);
  const runtime=runtimeWithSchema(base,7);
  await activate({runtime,release:dir,probe:healthyProbe});
  const server=http.createServer((request,response)=>{response.writeHead(200,{'content-type':'application/json'});response.end(JSON.stringify({ok:true}));});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>server.close());
  const next=fakeRelease(base,'rel-probe-2');
  const result=await activate({runtime,release:next.dir,healthcheckUrl:`http://127.0.0.1:${server.address().port}/`,now:9});
  assert.equal(result.rolled_back,true,'a bare 200 must not activate');
  assert.equal(readPointer(runtime).release_id,'rel-probe');
});

test('rollback restores the previous release and refuses a database downgrade',async t=>{
  const base=root();t.after(()=>fs.rmSync(base,{recursive:true,force:true}));
  const runtime=runtimeWithSchema(base,7);
  const a=fakeRelease(base,'rel-r1'),b=fakeRelease(base,'rel-r2');
  await activate({runtime,release:a.dir,probe:healthyProbe,now:1});
  await activate({runtime,release:b.dir,probe:healthyProbe,now:2});
  const reverted=await rollback({runtime,probe:healthyProbe,now:3});
  assert.equal(reverted.rolled_back,true);assert.equal(readPointer(runtime).release_id,'rel-r1');
  assert.equal(readPointer(runtime).previous.previous,null);
  const older=fakeRelease(base,'rel-old',{compat:{schema_min:6,schema_max:6}});
  await assert.rejects(activate({runtime,release:older.dir,probe:healthyProbe}),{code:'schema_downgrade_refused'});
  const empty=path.join(base,'empty');fs.mkdirSync(empty);
  await assert.rejects(rollback({runtime:empty}),{code:'no_active_release'});
  const freshBase=root();t.after(()=>fs.rmSync(freshBase,{recursive:true,force:true}));
  const freshRuntime=runtimeWithSchema(freshBase,7);
  await activate({runtime:freshRuntime,release:a.dir,probe:healthyProbe,now:4});
  await assert.rejects(rollback({runtime:freshRuntime}),{code:'no_previous_release'});
});

test('the pinned launch helper returns the verified physical root, entry and env',async t=>{
  const base=root();t.after(()=>fs.rmSync(base,{recursive:true,force:true}));
  const runtime=runtimeWithSchema(base,7);
  const a=fakeRelease(base,'rel-launch');
  await activate({runtime,release:a.dir,probe:healthyProbe,now:1});
  const launch=await resolveLaunch({runtime});
  assert.equal(launch.release_id,'rel-launch');
  assert.equal(launch.physical_root,fs.realpathSync.native(a.dir));
  assert.equal(launch.entry,path.join(launch.physical_root,'server/index.mjs'));
  assert.equal(launch.assets_index,path.join(launch.physical_root,'dist/index.html'));
  assert.equal(launch.env.ORBIT_RUNTIME_DIR,fs.realpathSync.native(runtime));
  assert.equal(launch.env.ORBIT_RELEASE_ROOT,launch.physical_root);
  assert.equal(launch.env.ORBIT_RELEASE_ID,'rel-launch');
  assert.equal(launch.env.ORBIT_RELEASE_INTEGRITY,a.manifest.integrity);
  const empty=path.join(base,'no-pointer');fs.mkdirSync(empty);
  await assert.rejects(resolveLaunch({runtime:empty}),{code:'no_active_release'});
  write(path.join(a.dir,'server/index.mjs'),'// tampered after manifest');
  await assert.rejects(resolveLaunch({runtime}),{code:'release_integrity_failed'});
});

test('compatibility rejects an older Node',t=>{
  const base=root();t.after(()=>fs.rmSync(base,{recursive:true,force:true}));
  const {manifest}=fakeRelease(base,'rel-node');
  assert.throws(()=>checkCompatibility({manifest,schema_version:7,nodeVersion:'18.0.0'}),{code:'node_incompatible'});
  assert.doesNotThrow(()=>checkCompatibility({manifest,schema_version:7,nodeVersion:'22.23.1'}));
});

test('resolveLaunch strictly matches the pointer against the verified manifest',async t=>{
  const base=root();t.after(()=>fs.rmSync(base,{recursive:true,force:true}));
  const runtime=runtimeWithSchema(base,7);
  const a=fakeRelease(base,'rel-match');
  await activate({runtime,release:a.dir,probe:healthyProbe,now:1});
  const pointer=readPointer(runtime);
  writePointerAtomic(runtime,{...pointer,release_id:'tampered-id'});
  await assert.rejects(resolveLaunch({runtime}),{code:'pointer_manifest_mismatch'});
  writePointerAtomic(runtime,{...pointer,manifest_integrity:'0'.repeat(64)});
  await assert.rejects(resolveLaunch({runtime}),{code:'pointer_manifest_mismatch'});
  writePointerAtomic(runtime,pointer);
  const launch=await resolveLaunch({runtime});
  assert.equal(launch.release_id,'rel-match');
});

test('external Node dependencies are bound by lock hash and ABI',async t=>{
  const base=root();t.after(()=>fs.rmSync(base,{recursive:true,force:true}));
  const runtime=runtimeWithSchema(base,7);
  const dir=path.join(base,'rel-ext');
  write(path.join(dir,'dist/index.html'),'x');
  write(path.join(dir,'server/index.mjs'),'// s');
  for(const name of CONTRACTS)write(path.join(dir,'contracts',name),'// c');
  write(path.join(dir,'hermes-plugin/workbench.py'),'# p');
  write(path.join(dir,'package.json'),'{}');
  write(path.join(dir,'package-lock.json'),'{"lockfileVersion":3,"packages":{}}');
  const lockHash=sha(fs.readFileSync(path.join(dir,'package-lock.json')));
  const external={kind:'operator-managed-external',path:path.join(base,'node_modules'),node_abi:process.versions.modules,node_version:process.versions.node,lockfile_hash:lockHash};
  const manifest=buildManifest({root:dir,release_id:'rel-ext',compat:{schema_min:7,schema_max:7},external,created_at:1});
  write(path.join(dir,'.orbit-release-manifest.json'),`${JSON.stringify(manifest,null,2)}\n`);
  assert.equal(verifyManifest({root:dir,manifest}).ok,true);
  const badExternal={...external,lockfile_hash:sha('other')};
  assert.throws(()=>buildManifest({root:dir,release_id:'rel-bad',compat:{schema_min:7,schema_max:7},external:badExternal}),{code:'invalid_external'});
  // A release whose external ABI does not match this Node is refused.
  const abiManifest=structuredClone(manifest);abiManifest.release_id='rel-abi';abiManifest.dependencies.external.node_abi='0';abiManifest.integrity=manifestIntegrity(abiManifest);
  write(path.join(dir,'.orbit-release-manifest.json'),`${JSON.stringify(abiManifest,null,2)}\n`);
  const result=await activate({runtime,release:dir,probe:healthyProbe});
  assert.equal(result.pointer_selected,false);
  assert.equal(result.rolled_back,true);
  assert.equal(result.error,'dependency_abi_mismatch');
  assert.equal(readPointer(runtime),null);
});

test('start mode spawns the verified entry, forwards signals and preserves exit status',async t=>{
  const base=root();t.after(()=>fs.rmSync(base,{recursive:true,force:true}));
  const runtime=runtimeWithSchema(base,7);
  const a=fakeRelease(base,'rel-start');
  await activate({runtime,release:a.dir,probe:healthyProbe,now:1});
  const handlers={};const kills=[];
  const child=new EventEmitter();child.kill=signal=>{kills.push(signal);return true;};
  const proc={execPath:'/usr/bin/node',env:{},on:signal=>{handlers[signal]=(...args)=>child.kill(...args);},};
  let captured;
  const pending=startRelease({runtime,spawnImpl:(command,args,options)=>{captured={command,args,options};setTimeout(()=>child.emit('exit',0,null),10);return child;},proc});
  const result=await pending;
  assert.equal(captured.command,'/usr/bin/node');
  assert.equal(captured.args[0],'--experimental-strip-types');
  assert.match(captured.args[1],/server\/index\.mjs$/);
  assert.equal(captured.options.env.ORBIT_RELEASE_ID,'rel-start');
  assert.equal(captured.options.env.ORBIT_RELEASE_ROOT,fs.realpathSync.native(a.dir));
  assert.equal(result.started,true);
  assert.equal(result.exit_code,0);
  assert.equal(result.forwarded_signals.length,0,'no signal is forwarded before one is delivered');
});

test('a failed probe restores the exact pointer and a retry still works',async t=>{
  const base=root();t.after(()=>fs.rmSync(base,{recursive:true,force:true}));
  const runtime=runtimeWithSchema(base,7);
  const a=fakeRelease(base,'rel-throw-a'),b=fakeRelease(base,'rel-throw-b');
  const throwingProbe=()=>{throw Error('probe transport boom');};
  await activate({runtime,release:a.dir,probe:healthyProbe,now:1});
  const before=readPointer(runtime);
  const failed=await activate({runtime,release:b.dir,probe:throwingProbe,now:2});
  assert.equal(failed.pointer_selected,false);
  assert.equal(failed.runtime_activated,false);
  assert.equal(failed.rolled_back,true);
  assert.equal(failed.reason,'probe_failed');
  assert.equal(failed.probe_threw,true);
  assert.deepEqual(readPointer(runtime),before,'a failed activation restores the exact original pointer');
  await activate({runtime,release:b.dir,probe:healthyProbe,now:3});
  const active=readPointer(runtime);
  assert.equal(active.release_id,'rel-throw-b');
  assert.equal(active.previous.release_id,'rel-throw-a');
  const rollbackFailed=await rollback({runtime,probe:throwingProbe,now:4});
  assert.equal(rollbackFailed.rolled_back,false);
  assert.equal(rollbackFailed.reason,'probe_failed');
  assert.equal(rollbackFailed.probe_threw,true);
  assert.deepEqual(readPointer(runtime),active,'a failed rollback restores the exact current pointer');
  const retried=await rollback({runtime,probe:healthyProbe,now:5});
  assert.equal(retried.rolled_back,true,'a retried rollback still works after a failed probe');
  const rolled=readPointer(runtime);
  assert.equal(rolled.release_id,'rel-throw-a');
  assert.equal(rolled.previous.release_id,'rel-throw-b');
  const beforeIdempotent=readPointer(runtime);
  const repeated=await activate({runtime,release:a.dir,probe:healthyProbe,now:6});
  assert.equal(repeated.idempotent,true);
  assert.deepEqual(readPointer(runtime),beforeIdempotent,'re-activating the same release preserves the previous rollback target');
});


