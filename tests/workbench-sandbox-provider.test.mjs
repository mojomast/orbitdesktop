import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {createWorkbenchSandboxProvider,sandboxTreeHash,sandboxBundle,sandboxDigest,sandboxRunArgs,sandboxDeleteArgs,sandboxRuntimeIdentity} from '../server/workbench-sandbox-provider.mjs';
import {runCheck} from '../server/workbench-checks.mjs';
import {createWorkbenchEnvironments} from '../server/workbench-environments.mjs';

const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
function fixture(t){
  const root=fs.mkdtempSync('/tmp/opencode/orbit-sandbox-');t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const state=path.join(root,'state'),rootfs=path.join(root,'rootfs'),runsc=path.join(root,'runsc');fs.mkdirSync(state,{mode:0o700});fs.mkdirSync(rootfs,{mode:0o700});
  for(const p of ['workspace','tmp','proc','opt/orbit','usr/local/bin'])fs.mkdirSync(path.join(rootfs,p),{recursive:true,mode:0o700});
  fs.writeFileSync(path.join(rootfs,'usr/local/bin/node'),'unit fixture, never a runtime',{mode:0o700});
  fs.writeFileSync(path.join(rootfs,'opt/orbit/node-version'),'v22.0.0\n',{mode:0o600});
  fs.writeFileSync(path.join(rootfs,'opt/orbit/runner.mjs'),'',{mode:0o600});
  fs.writeFileSync(runsc,'#!/bin/sh\necho unit-fixture-not-gvisor\n',{mode:0o700});
  const sidecars=path.join(root,'gvisor-bin');fs.mkdirSync(sidecars,{mode:0o700});fs.writeFileSync(path.join(sidecars,'sentry'),'unit-payload-never-executed',{mode:0o700});
  const env={ORBIT_WORKBENCH_GVISOR_RUNSC:runsc,ORBIT_WORKBENCH_GVISOR_RUNSC_SHA256:sha(fs.readFileSync(runsc)),ORBIT_WORKBENCH_GVISOR_RUNTIME_LAYOUT:'gvisor-bin-v1',ORBIT_WORKBENCH_GVISOR_SIDECARS_SHA256:sandboxTreeHash(sidecars,{allowSymlinks:false}),ORBIT_WORKBENCH_GVISOR_ROOTFS:rootfs,ORBIT_WORKBENCH_GVISOR_IMAGE_DIGEST:sandboxTreeHash(rootfs)};
  return {root,state,rootfs,runsc,env,provider:extra=>createWorkbenchSandboxProvider({root:state,env:{...env,...extra}})};
}
test('provider is off by default and fails closed for unsupported or altered provisions',t=>{
  const f=fixture(t);
  assert.equal(createWorkbenchSandboxProvider({root:f.state,env:{}}).describe().reason,'disabled');
  for(const [extra,reason] of [
    [{ORBIT_WORKBENCH_GVISOR_NETWORK:'host'},'network_policy_invalid'],
    [{ORBIT_WORKBENCH_GVISOR_PLATFORM:'kvm'},'platform_unsupported'],
    [{ORBIT_WORKBENCH_GVISOR_DISK_QUOTA:'100M'},'disk_quota_unsupported'],
    [{ORBIT_WORKBENCH_GVISOR_RUNSC:'/absent/runsc'},'runsc_missing'],
    [{ORBIT_WORKBENCH_GVISOR_RUNSC_SHA256:'0'.repeat(64)},'runsc_hash_mismatch'],
    [{ORBIT_WORKBENCH_GVISOR_ROOTFS:'/absent/rootfs'},'rootfs_missing'],
    [{ORBIT_WORKBENCH_GVISOR_IMAGE_DIGEST:'0'.repeat(64)},'rootfs_hash_mismatch'],
  ]){const observed=f.provider(extra).describe();assert.equal(observed.available,false);assert.equal(observed.reason,reason);assert.ok(!JSON.stringify(observed).includes(f.root));}
  fs.chmodSync(f.runsc,0o777);assert.equal(f.provider().describe().reason,'permissions_invalid');
});
test('rootfs and policy identities change with executable bytes, modes and spec',t=>{
  const f=fixture(t),before=sandboxTreeHash(f.rootfs);
  fs.writeFileSync(path.join(f.rootfs,'usr/local/bin/node'),'changed',{mode:0o700});assert.notEqual(sandboxTreeHash(f.rootfs),before);
  const bundle=sandboxBundle({rootfs:f.rootfs,candidate:'/private/candidate',runner:'/private/runner',files:['fixture.test.mjs']});
  assert.deepEqual(bundle.process.args,['/usr/local/bin/node','/opt/orbit/runner.mjs','["fixture.test.mjs"]']);
  assert.equal(bundle.root.readonly,true);assert.ok(bundle.mounts.find(m=>m.destination==='/workspace').options.includes('ro'));
  assert.deepEqual(bundle.linux.namespaces.map(n=>n.type),['pid','mount','ipc','uts','network','user']);
  assert.equal(sandboxDigest(bundle),sandboxDigest(JSON.parse(JSON.stringify(bundle))));
  assert.deepEqual(sandboxRunArgs({runtime:'/private/state',bundle:'/private/bundle',id:'orbit-fixture'}),['--rootless','--platform=systrap','--network=none','--root=/private/state','run','--bundle=/private/bundle','--pass-fd=3:3','orbit-fixture']);
  assert.deepEqual(sandboxDeleteArgs({runtime:'/private/state',id:'orbit-fixture'}),['--rootless','--platform=systrap','--network=none','--root=/private/state','delete','--force','orbit-fixture']);
});
test('real rootfs symlinks hash link text without following guest absolute paths; mount escapes fail',t=>{
  const f=fixture(t),target=path.join(f.rootfs,'guest-library');
  fs.symlinkSync('/usr/lib/guest-library.so',target);
  assert.equal(fs.lstatSync(target).mode&0o777,0o777);
  const first=sandboxTreeHash(f.rootfs);assert.equal(sandboxTreeHash(f.rootfs),first);
  fs.unlinkSync(target);fs.symlinkSync('/usr/lib/other-library.so',target);assert.notEqual(sandboxTreeHash(f.rootfs),first);
  const outside=path.join(f.root,'outside');fs.mkdirSync(outside,{mode:0o700});fs.writeFileSync(path.join(outside,'secret'),'first');
  fs.symlinkSync(outside,path.join(f.rootfs,'guest-absolute-link'));
  const linked=sandboxTreeHash(f.rootfs);fs.writeFileSync(path.join(outside,'secret'),'second');assert.equal(sandboxTreeHash(f.rootfs),linked,'host symlink targets are never hashed/read');
  fs.rmSync(path.join(f.rootfs,'opt'),{recursive:true});fs.symlinkSync(outside,path.join(f.rootfs,'opt'));
  assert.equal(f.provider({ORBIT_WORKBENCH_GVISOR_IMAGE_DIGEST:sandboxTreeHash(f.rootfs)}).describe().reason,'rootfs_missing');
});
test('runtime sidecar payload is exact, no executable symlink escape or unknown standalone layout',t=>{
  const f=fixture(t),sidecars=path.join(f.root,'gvisor-bin');
  const config={runsc:f.runsc,expected:f.env.ORBIT_WORKBENCH_GVISOR_RUNSC_SHA256,layout:'gvisor-bin-v1',sidecarsExpected:f.env.ORBIT_WORKBENCH_GVISOR_SIDECARS_SHA256};
  const first=sandboxRuntimeIdentity(config);
  fs.writeFileSync(path.join(sidecars,'sentry'),'changed');
  assert.equal(f.provider().describe().reason,'runtime_payload_changed');
  const updated=sandboxRuntimeIdentity({...config,sidecarsExpected:sandboxTreeHash(sidecars,{allowSymlinks:false})});assert.notEqual(updated.runtime_payload_digest,first.runtime_payload_digest);
  fs.symlinkSync(f.runsc,path.join(sidecars,'unhashed-executable'));
  assert.equal(f.provider().describe().reason,'runtime_payload_unverified');
  assert.equal(f.provider({ORBIT_WORKBENCH_GVISOR_RUNTIME_LAYOUT:'standalone'}).describe().reason,'runtime_layout_unsupported');
  fs.rmSync(sidecars,{recursive:true});assert.equal(f.provider().describe().reason,'runtime_payload_unverified');
});
test('poll projection is bounded IO-free cached display; authority probe observes changes afresh',t=>{
  const f=fixture(t),provider=f.provider({ORBIT_WORKBENCH_GVISOR_IMAGE_DIGEST:'0'.repeat(64)});
  assert.equal(provider.publicStatus().reason,'not_probed');
  assert.equal(provider.describe().reason,'rootfs_hash_mismatch');
  const cached=provider.publicStatus();assert.equal(cached.display_only,true);assert.equal(typeof cached.checked_at,'number');
  fs.unlinkSync(f.runsc);
  const methods=['readFileSync','readdirSync','lstatSync','realpathSync'],originals=methods.map(name=>fs[name]);
  try{for(const name of methods)fs[name]=()=>{throw Error('public status must not perform IO');};for(let i=0;i<100;i++)assert.deepEqual(provider.publicStatus(),cached);}
  finally{methods.forEach((name,i)=>{fs[name]=originals[i];});}
  assert.equal(provider.describe().reason,'runsc_missing','authority never accepts cached provider data');
  assert.equal(provider.publicStatus().reason,'runsc_missing');
});
test('explicit gVisor never reaches the trusted host spawn when provider absent or unavailable',async t=>{
  const f=fixture(t);let rehashed=false,spawned=false;
  const options={execution_backend:'gvisor',definition_id:'node-test',job_id:randomUUID(),rehash:()=>{rehashed=true;return {hash:'fixture'};},spawn_record:()=>{spawned=true;}};
  await assert.rejects(runCheck(options),{code:'unavailable'});
  await assert.rejects(runCheck({...options,provider:{kind:'gvisor',describe:()=>({available:false}),spawnCheck:()=>{spawned=true;}}}),{code:'unavailable'});
  assert.equal(rehashed,false);assert.equal(spawned,false);assert.equal(fs.readdirSync(f.state).length,0);
});
test('restart resources fence admission without deleting or replaying them',t=>{
  const f=fixture(t);fs.mkdirSync(path.join(f.state,'bundles'),{mode:0o700});fs.mkdirSync(path.join(f.state,'bundles','orphan'),{mode:0o700});
  assert.equal(f.provider().reconcile().reason,'resources_unknown');assert.ok(fs.existsSync(path.join(f.state,'bundles','orphan')));
});
test('new profile validator rejects a changed backend identity before dependency or candidate access',t=>{
  const f=fixture(t),workspace_id=randomUUID(),project_id=randomUUID(),profile_id=randomUUID();let touchedCandidate=false;
  const p={id:profile_id,candidate_id:randomUUID(),project_generation:1,status:'ready',prepared:{},profile_version:2,execution_backend:'gvisor',provider_identity:'a'.repeat(64),provider:{available:true,provider_identity:'a'.repeat(64)}};
  const env=createWorkbenchEnvironments({store:{root:f.root,read(){}},records:{project:()=>({generation:1})},data:{get:kind=>{if(kind==='profiles')return p;touchedCandidate=true;throw Error();},create(){},update(){},list(){}},sandboxProvider:{describe:()=>({available:true,provider_identity:'b'.repeat(64)})}});
  assert.equal(env.profileReadiness({workspace_id,project_id,profile_id}).reason,'sandbox_provider_changed');assert.equal(touchedCandidate,false);
});
test('authentic pre-feature 6db86bd environment writer refuses version-2 sandbox profiles and views',async t=>{
  const f=fixture(t);
  // Load the entire historical module, preserving its actual admission code.
  const source=execFileSync('git',['show','6db86bd:server/workbench-environments.mjs'],{encoding:'utf8'});
  const relocated=source.replace(/from '([^']+)'/g,(all,specifier)=>`from '${specifier.startsWith('.')?new URL(specifier,new URL('../server/workbench-environments.mjs',import.meta.url)).href:import.meta.resolve(specifier)}'`);
  const old=await import(`data:text/javascript;base64,${Buffer.from(relocated).toString('base64')}`);
  const workspace_id=randomUUID(),project_id=randomUUID(),profile_id=randomUUID(),candidate_id=randomUUID();
  const p={id:profile_id,candidate_id,project_generation:1,status:'ready',prepared:{},profile_version:2,execution_backend:'gvisor',provider_identity:'a'.repeat(64)};
  let candidateRead=false;
  const env=old.createWorkbenchEnvironments({store:{root:f.root,read(){}},records:{project:()=>({generation:1})},data:{get:kind=>{if(kind==='profiles')return p;candidateRead=true;throw Error('host candidate must not be reached');},create(){},update(){},list(){}}});
  const args={workspace_id,project_id,profile_id,candidate_id};
  assert.throws(()=>env.verifyProfile(args),{code:'unsupported'});
  assert.throws(()=>env.createExecutionView(args),{code:'unsupported'});
  assert.equal(env.profileReadiness(args).reason,'unsupported_profile_kind');assert.equal(candidateRead,false);
});
