// Structural release-isolation tests: ordinary builds must not be able to modify a
// served release, canonical roots must reject empty/symlink/ancestor/inode aliases,
// manifests must cover server/plugin/contracts, and activation/rollback must fail
// safely without database downgrade.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {BuildGuardError,canonicalTarget,guardDestination,planBuild,resolveDestination,runBuild} from '../scripts/isolated_build.mjs';
import {ManifestError,buildManifest,readManifest,verifyManifest} from '../scripts/release_manifest.mjs';
import {PinError,activate,checkCompatibility,currentSchemaVersion,pointerPath,readPointer,rollback} from '../scripts/release_pin.mjs';

const root=()=>fs.mkdtempSync('/tmp/opencode/orbit-iso-');
const write=(target,text)=>{fs.mkdirSync(path.dirname(target),{recursive:true});fs.writeFileSync(target,text);};

function fakeRelease(base,release_id,{files={}}={}){
  const dir=path.join(base,release_id);
  write(path.join(dir,'dist/index.html'),'<h1>served</h1>');
  write(path.join(dir,'server/index.mjs'),'// server');
  for(const name of ['workspace-v1.mjs','workbench-v1.mjs','workbench-result-v1.mjs'])write(path.join(dir,'contracts',name),'// contract');
  write(path.join(dir,'hermes-plugin/workbench.py'),'# plugin');
  write(path.join(dir,'package.json'),'{}');
  for(const [name,text] of Object.entries(files))write(path.join(dir,name),text);
  const manifest=buildManifest({root:dir,release_id,compat:{node:'>=22.12',schema_min:7,schema_max:7},created_at:1});
  fs.writeFileSync(path.join(dir,'.orbit-release-manifest.json'),`${JSON.stringify(manifest,null,2)}\n`);
  return {dir,manifest};
}

test('ordinary build default destination is isolated and never the checkout dist',t=>{
  const base=root();t.after(()=>fs.rmSync(base,{recursive:true,force:true}));
  const destination=resolveDestination({env:{ORBIT_BUILD_SCRATCH:base},dryRun:true});
  assert.ok(path.isAbsolute(destination));
  assert.ok(destination.startsWith(base+path.sep));
  assert.equal(destination.startsWith(path.resolve('dist')+path.sep),false);
  const plan=planBuild({dest:path.join(base,'out'),env:{ORBIT_BUILD_SCRATCH:base},dryRun:true});
  assert.equal(plan.wrote,undefined);
  assert.ok(plan.destination.startsWith(base));
});

test('canonical roots reject empty, relative, root, symlink, ancestor and alias destinations',t=>{
  const base=root();t.after(()=>fs.rmSync(base,{recursive:true,force:true}));
  const served=path.join(base,'served');write(path.join(served,'dist/index.html'),'served');
  for(const dest of ['', '   ', 'relative/dir', '/'])assert.throws(()=>guardDestination({dest,protect:[served],env:{}}),error=>error instanceof BuildGuardError&&(error.code==='invalid_destination'));
  assert.throws(()=>guardDestination({dest:served,protect:[served],env:{}}),{code:'protected_destination'});
  assert.throws(()=>guardDestination({dest:path.join(served,'dist'),protect:[served],env:{}}),{code:'protected_destination'});
  assert.throws(()=>guardDestination({dest:base,protect:[path.join(served,'dist')],env:{}}),{code:'protected_destination'});
  assert.throws(()=>guardDestination({dest:path.join(served,'.','dist'),protect:[served],env:{}}),{code:'protected_destination'});
  const link=path.join(base,'served-link');fs.symlinkSync(served,link,'dir');
  assert.throws(()=>guardDestination({dest:path.join(link,'dist'),protect:[served],env:{}}),{code:'protected_destination'});
  assert.equal(canonicalTarget(path.join(link,'dist')),path.join(canonicalTarget(served),'dist'));
  // env-configured protected roots
  assert.throws(()=>guardDestination({dest:path.join(served,'dist'),env:{ORBIT_PROTECTED_ROOTS:served}}),{code:'protected_destination'});
  // an unrelated destination is allowed
  assert.ok(guardDestination({dest:path.join(base,'safe-out'),protect:[served],env:{}}).destination);
});

test('ordinary build cannot modify a sentinel served release',t=>{
  const base=root();t.after(()=>fs.rmSync(base,{recursive:true,force:true}));
  const served=path.join(base,'served');const sentinel=path.join(served,'dist','index.html');write(sentinel,'SENTINEL-RELEASE');
  const before=fs.readFileSync(sentinel);
  assert.throws(()=>runBuild({dest:path.join(served,'dist'),source:base,protect:[served],env:{},typecheck:false}),{code:'protected_destination'});
  assert.deepEqual(fs.readFileSync(sentinel),before,'protected build must not touch the served release');
  // Default destination: an injected spawn proves the ordinary build wrote only to scratch.
  write(path.join(base,'node_modules/.bin/vite'),'#!/bin/sh\nexit 0\n');
  const destination=path.join(base,'scratch-out');
  const spawn=(command,args)=>{if(args.includes('--outDir')){const target=args[args.indexOf('--outDir')+1];write(path.join(target,'index.html'),'<h1>built</h1>');}return {status:0,stdout:'',stderr:''};};
  const result=runBuild({dest:destination,source:base,protect:[served],env:{},typecheck:false,spawn});
  assert.equal(result.wrote,true);
  assert.ok(fs.existsSync(path.join(destination,'index.html')));
  assert.deepEqual(fs.readFileSync(sentinel),before,'served sentinel must remain unchanged');
});

test('release manifest covers served, server, plugin and contracts content and detects tampering',t=>{
  const base=root();t.after(()=>fs.rmSync(base,{recursive:true,force:true}));
  const {dir,manifest}=fakeRelease(base,'rel-1');
  assert.ok(manifest.files.some(file=>file.path==='dist/index.html'));
  assert.ok(manifest.files.some(file=>file.path==='server/index.mjs'));
  assert.ok(manifest.files.some(file=>file.path==='hermes-plugin/workbench.py'));
  assert.ok(manifest.files.some(file=>file.path==='contracts/workbench-result-v1.mjs'));
  assert.equal(verifyManifest({root:dir,manifest}).ok,true);
  write(path.join(dir,'server/index.mjs'),'// tampered');
  const tampered=verifyManifest({root:dir,manifest});
  assert.equal(tampered.ok,false);
  assert.ok(tampered.errors.some(error=>error.code==='hash_mismatch'&&error.path==='server/index.mjs'));
  // Missing required component fails closed.
  const empty=path.join(base,'empty');fs.mkdirSync(empty);
  assert.throws(()=>buildManifest({root:empty,release_id:'empty'}),error=>error instanceof ManifestError&&error.code==='missing_required_component');
  // Symlinked content is rejected rather than silently hashed.
  const linked=path.join(base,'linked');
  write(path.join(linked,'dist/index.html'),'x');write(path.join(linked,'server/index.mjs'),'x');
  for(const name of ['workspace-v1.mjs','workbench-v1.mjs','workbench-result-v1.mjs'])write(path.join(linked,'contracts',name),'x');
  write(path.join(linked,'hermes-plugin/workbench.py'),'x');write(path.join(linked,'package.json'),'{}');
  fs.symlinkSync(path.join(linked,'server/index.mjs'),path.join(linked,'alias.mjs'));
  assert.throws(()=>buildManifest({root:linked,release_id:'linked'}),{code:'symlink_not_allowed'});
});

test('activation pins one complete release, rolls back on health failure and refuses DB downgrade',async t=>{
  const base=root();t.after(()=>fs.rmSync(base,{recursive:true,force:true}));
  const runtime=path.join(base,'runtime');fs.mkdirSync(runtime);write(path.join(runtime,'workspace.sqlite'),'');
  const a=fakeRelease(base,'rel-a'),b=fakeRelease(base,'rel-b'),c=fakeRelease(base,'rel-c');
  const open=()=>({pragma:()=>7,close(){}});
  const okCheck=async()=>({ok:true,status:200});
  const first=await activate({runtime,release:a.dir,open,check:okCheck,now:1});
  assert.equal(first.activated,true);
  assert.equal(readPointer(runtime).release_id,'rel-a');
  const second=await activate({runtime,release:b.dir,open,check:okCheck,now:2});
  assert.equal(second.activated,true);
  assert.equal(readPointer(runtime).release_id,'rel-b');
  assert.equal(readPointer(runtime).previous.release_id,'rel-a','previous release retained');
  // Healthcheck failure must keep the previous (working) release.
  const failed=await activate({runtime,release:c.dir,open,check:async()=>({ok:false,status:500}),now:3});
  assert.equal(failed.activated,false);
  assert.equal(failed.rolled_back,true);
  assert.equal(readPointer(runtime).release_id,'rel-b');
  assert.ok(fs.existsSync(a.dir),'retained releases are not deleted on rollback');
  // Rollback to the previous release succeeds with matching schema.
  const reverted=await rollback({runtime,open,check:okCheck,now:4});
  assert.equal(reverted.rolled_back,true);
  assert.equal(readPointer(runtime).release_id,'rel-a');
  // A newer database cannot be paired with an older release (no DB downgrade).
  const older=fakeRelease(base,'rel-old',{});older.manifest=buildManifest({root:older.dir,release_id:'rel-old',compat:{schema_max:6},created_at:1});
  fs.writeFileSync(path.join(older.dir,'.orbit-release-manifest.json'),`${JSON.stringify(older.manifest,null,2)}\n`);
  await assert.rejects(activate({runtime,release:older.dir,open,check:okCheck}),{code:'schema_downgrade_refused'});
  await assert.rejects(rollback({runtime:path.join(base,'empty-runtime'),open,check:okCheck}),{code:'no_active_release'});
});

test('compatibility rejects an older Node and a release-integrity failure',async t=>{
  const base=root();t.after(()=>fs.rmSync(base,{recursive:true,force:true}));
  const {manifest}=fakeRelease(base,'rel-node');
  assert.throws(()=>checkCompatibility({manifest,schema_version:7,nodeVersion:'18.0.0'}),{code:'node_incompatible'});
  assert.doesNotThrow(()=>checkCompatibility({manifest,schema_version:7,nodeVersion:'22.23.1'}));
  const runtime=path.join(base,'runtime');fs.mkdirSync(runtime);write(path.join(runtime,'workspace.sqlite'),'');
  write(path.join(base,'rel-node','server/index.mjs'),'// tampered after manifest');
  await assert.rejects(activate({runtime,release:path.join(base,'rel-node'),open:()=>({pragma:()=>7,close(){}}),check:async()=>({ok:true})}),{code:'release_integrity_failed'});
  assert.equal(readPointer(runtime),null,'no pointer is written for an invalid release');
});
