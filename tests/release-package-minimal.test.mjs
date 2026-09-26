// Private minimal packaging + cleanup unit. A synthetic git-tracked source root and
// a synthetic dist (no external dependencies) exercise packageRelease and
// removeOwnedRelease end to end. Nothing here touches a shared dependency tree or a
// real server/source release.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {execFileSync,spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {packageRelease,removeOwnedRelease} from '../scripts/release_package.mjs';
import {buildManifest,MANIFEST_NAME,verifyManifest,readManifest} from '../scripts/release_manifest.mjs';

const sha256=value=>createHash('sha256').update(value).digest('hex');
const mode=target=>fs.statSync(target).mode&0o777;
const scratch=()=>fs.mkdtempSync('/tmp/opencode/orbit-pkg-');
const write=(target,text)=>{fs.mkdirSync(path.dirname(target),{recursive:true});fs.writeFileSync(target,text);};

function syntheticSource(base){
  const source=path.join(base,'source');fs.mkdirSync(source);
  const files={
    'server/index.mjs':'// server\n',
    'server/extra.mjs':'// tracked extra\n',
    'contracts/workspace-v1.mjs':'// contract\n',
    'contracts/workbench-v1.mjs':'// contract\n',
    'contracts/workbench-result-v1.mjs':'// contract\n',
    'hermes-plugin/workbench.py':'# plugin\n',
    'package.json':'{"type":"module"}\n',
    'package-lock.json':'{"lockfileVersion":3,"packages":{}}\n',
  };
  for(const [relative,text] of Object.entries(files))write(path.join(source,relative),text);
  const env={...process.env,GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:'/dev/null',HOME:path.join(base,'home')};
  fs.mkdirSync(path.join(base,'home'));
  const git=(...args)=>execFileSync('/usr/bin/git',['-C',source,...args],{encoding:'utf8',env});
  git('init','-q');
  git('add','.');
  git('-c','user.email=fixture@example.invalid','-c','user.name=Fixture','commit','-q','-m','initial');
  return {source,files};
}
function syntheticDist(base){
  const dist=path.join(base,'dist');fs.mkdirSync(dist);
  write(path.join(dist,'index.html'),'<h1>served</h1>');
  write(path.join(dist,'assets/app.js'),'// asset\n');
  return dist;
}

test('packageRelease assembles, verifies and cleans a synthetic tracked release',t=>{
  const base=scratch();t.after(()=>fs.rmSync(base,{recursive:true,force:true}));
  const {source}=syntheticSource(base),dist=syntheticDist(base);
  const out=path.join(base,'release');fs.mkdirSync(path.join(base,'releases'));
  const result=packageRelease({sourceRoot:source,distRoot:dist,outRoot:out,release_id:'rel',compat:{schema_min:7,schema_max:7},readOnly:true,env:{}});
  assert.equal(mode(out),0o555,'release root read-only');
  assert.equal(mode(path.join(out,'server/index.mjs')),0o444);
  assert.equal(mode(path.join(out,MANIFEST_NAME)),0o444);
  assert.equal(mode(path.join(out,'.orbit-release-owned.json')),0o444);
  assert.equal(verifyManifest({root:out,manifest:readManifest({root:out})}).ok,true);
  assert.ok(result.manifest.files.some(file=>file.path==='server/extra.mjs'));
  assert.ok(!result.manifest.files.some(file=>file.path==='.orbit-release-owned.json'),'marker is not a release file');
  const removed=removeOwnedRelease({root:out,manifest:result.manifest,scratchBase:base,env:{}});
  assert.equal(removed.removed,true);
  assert.equal(fs.existsSync(out),false);
});

test('a dirty tracked input is bound by actual bytes, not a clean-commit claim',t=>{
  const base=scratch();t.after(()=>fs.rmSync(base,{recursive:true,force:true}));
  const {source}=syntheticSource(base),dist=syntheticDist(base);
  const modified='// modified after commit\n';
  fs.writeFileSync(path.join(source,'server/extra.mjs'),modified);
  const out=path.join(base,'release-dirty');fs.mkdirSync(path.join(base,'releases'));
  const result=packageRelease({sourceRoot:source,distRoot:dist,outRoot:out,release_id:'rel-dirty',compat:{schema_min:7,schema_max:7},readOnly:true,env:{}});
  const entry=result.manifest.files.find(file=>file.path==='server/extra.mjs');
  assert.equal(entry.sha256,sha256(modified),'manifest binds the copied bytes');
  assert.notEqual(entry.sha256,sha256('// tracked extra\n'));
  removeOwnedRelease({root:out,manifest:result.manifest,scratchBase:base,env:{}});
});

test('packageRelease refuses an existing out root, a dist collision and a protected root',t=>{
  const base=scratch();t.after(()=>fs.rmSync(base,{recursive:true,force:true}));
  const {source}=syntheticSource(base),dist=syntheticDist(base);
  const existing=path.join(base,'existing');fs.mkdirSync(existing);
  assert.throws(()=>packageRelease({sourceRoot:source,distRoot:dist,outRoot:existing,release_id:'rel',compat:{schema_min:7,schema_max:7},env:{}}),{code:'out_exists'});
  const insideDist=path.join(dist,'newout');
  assert.throws(()=>packageRelease({sourceRoot:source,distRoot:dist,outRoot:insideDist,release_id:'rel',compat:{schema_min:7,schema_max:7},env:{}}),{code:'roots_collide'});
  const protectedDir=path.join(base,'protected');fs.mkdirSync(protectedDir);
  assert.throws(()=>packageRelease({sourceRoot:source,distRoot:dist,outRoot:path.join(protectedDir,'rel'),release_id:'rel',compat:{schema_min:7,schema_max:7},env:{ORBIT_RUNTIME_DIR:protectedDir}}),{code:'protected_root'});
  const protectedRelease=path.join(base,'rel-protected');
  assert.throws(()=>packageRelease({sourceRoot:source,distRoot:dist,outRoot:protectedRelease,release_id:'rel',compat:{schema_min:7,schema_max:7},env:{ORBIT_RELEASE_ROOT:protectedRelease}}),{code:'protected_root'});
});

test('removeOwnedRelease refuses a tampered on-disk manifest or inventory',t=>{
  const base=scratch();t.after(()=>fs.rmSync(base,{recursive:true,force:true}));
  const {source}=syntheticSource(base),dist=syntheticDist(base);
  const out=path.join(base,'release-tamper');fs.mkdirSync(path.join(base,'releases'));
  const result=packageRelease({sourceRoot:source,distRoot:dist,outRoot:out,release_id:'rel-t',compat:{schema_min:7,schema_max:7},readOnly:true,env:{}});
  // A marker that matches a manifest which does not match disk must be refused.
  assert.throws(()=>removeOwnedRelease({root:out,manifest:{...result.manifest,integrity:'0'.repeat(64)},scratchBase:base,env:{}}),{code:'not_owned'});
  removeOwnedRelease({root:out,manifest:result.manifest,scratchBase:base,env:{}});
  assert.equal(fs.existsSync(out),false);
});

test('external dependencies are labelled by scope and immutability, not read-only',t=>{
  const base=scratch();t.after(()=>fs.rmSync(base,{recursive:true,force:true}));
  const {source}=syntheticSource(base),dist=syntheticDist(base);
  const out=path.join(base,'release-external');fs.mkdirSync(path.join(base,'releases'));
  const external={kind:'operator-managed-external',path:base,node_abi:process.versions.modules,node_version:process.versions.node};
  const result=packageRelease({sourceRoot:source,distRoot:dist,outRoot:out,release_id:'rel-x',compat:{schema_min:7,schema_max:7},external,readOnly:true,env:{}});
  const recorded=result.manifest.dependencies.external;
  assert.equal(recorded.integrity_scope,'resolution-and-installed-version');
  assert.equal(recorded.immutability,'operator-managed-not-enforced');
  assert.equal(recorded.kind,'operator-managed-external');
  assert.equal(verifyManifest({root:out,manifest:result.manifest}).ok,true);
  assert.throws(()=>buildManifest({root:out,release_id:'x',compat:{schema_min:7,schema_max:7},external:{...external,integrity_scope:'full-copy-hash'}}),{code:'invalid_external'});
  assert.throws(()=>buildManifest({root:out,release_id:'x',compat:{schema_min:7,schema_max:7},external:{...external,immutability:'enforced'}}),{code:'invalid_external'});
  removeOwnedRelease({root:out,manifest:result.manifest,scratchBase:base,env:{}});
});
