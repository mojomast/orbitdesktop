// Fail-closed external dependency resolution: the declared external node_modules
// root must be the ACTUAL nearest resolution from the physical entry, installed
// versions must match the release lockfile, and the ABI must match. No NODE_PATH, no
// custom loader — exactly Node's own resolution.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {resolveExternalDependencies} from '../scripts/release_pin.mjs';

const scratch=()=>fs.mkdtempSync('/tmp/opencode/orbit-extdep-');
const write=(target,text)=>{fs.mkdirSync(path.dirname(target),{recursive:true});fs.writeFileSync(target,text);};
function install(root,version){
  write(path.join(root,'dep-a/package.json'),JSON.stringify({name:'dep-a',version,main:'index.js'}));
  write(path.join(root,'dep-a/index.js'),'module.exports = 1;\n');
}
function release(base,{dependencies={'dep-a':'1.0.0'},lockVersion='1.0.0'}={}){
  const rel=path.join(base,'rel');write(path.join(rel,'server/index.mjs'),'// entry\n');
  write(path.join(rel,'package.json'),JSON.stringify({name:'fixture',version:'1.0.0',dependencies}));
  const packages=lockVersion?{'node_modules/dep-a':{version:lockVersion}}:{};
  write(path.join(rel,'package-lock.json'),JSON.stringify({lockfileVersion:3,packages}));
  return rel;
}
const manifest=externalPath=>({dependencies:{external:{kind:'referenced-readonly',path:externalPath,node_abi:process.versions.modules,node_version:process.versions.node,lockfile_hash:'x'.repeat(64)}}});

test('ambient resolution outside the declared external root is refused',t=>{
  const base=scratch();t.after(()=>fs.rmSync(base,{recursive:true,force:true}));
  const real=path.join(base,'real');install(real,'1.0.0');
  const other=path.join(base,'other');install(other,'2.0.0');
  const rel=release(base);
  fs.symlinkSync(other,path.join(rel,'node_modules'),'dir');
  assert.throws(()=>resolveExternalDependencies({root:rel,manifest:manifest(real)}),{code:'external_resolution_mismatch'});
});

test('an unknown declared external path is refused',t=>{
  const base=scratch();t.after(()=>fs.rmSync(base,{recursive:true,force:true}));
  const rel=release(base);
  assert.throws(()=>resolveExternalDependencies({root:rel,manifest:manifest(path.join(base,'missing')),requireRoot:path.join(base,'node_modules')}),{code:'external_path_missing'});
});

test('a declared external path that is not the actual parent-sibling resolution is refused',t=>{
  const base=scratch();t.after(()=>fs.rmSync(base,{recursive:true,force:true}));
  const real=path.join(base,'real');install(real,'1.0.0');
  const other=path.join(base,'other');install(other,'1.0.0');
  const rel=release(base);
  fs.symlinkSync(other,path.join(base,'node_modules'),'dir');
  assert.throws(()=>resolveExternalDependencies({root:rel,manifest:manifest(real)}),{code:'external_resolution_mismatch'});
});

test('a matching parent-sibling external root passes and reports the resolved dependency',t=>{
  const base=scratch();t.after(()=>fs.rmSync(base,{recursive:true,force:true}));
  const real=path.join(base,'real');install(real,'1.0.0');
  const rel=release(base);
  fs.symlinkSync(real,path.join(base,'node_modules'),'dir');
  const result=resolveExternalDependencies({root:rel,manifest:manifest(real)});
  assert.equal(result.checked.length,1);
  assert.equal(result.checked[0].dependency,'dep-a');
  assert.equal(result.checked[0].version,'1.0.0');
  assert.ok(result.checked[0].resolved.startsWith(result.declared_root+path.sep));
});

test('an installed version that does not match the lockfile is refused',t=>{
  const base=scratch();t.after(()=>fs.rmSync(base,{recursive:true,force:true}));
  const real=path.join(base,'real');install(real,'1.0.0');
  const rel=release(base,{lockVersion:'2.0.0'});
  fs.symlinkSync(real,path.join(base,'node_modules'),'dir');
  assert.throws(()=>resolveExternalDependencies({root:rel,manifest:manifest(real)}),{code:'external_version_mismatch'});
});

test('a release without runtime dependencies needs no external root',t=>{
  const base=scratch();t.after(()=>fs.rmSync(base,{recursive:true,force:true}));
  const rel=release(base,{dependencies:{},lockVersion:null});
  const result=resolveExternalDependencies({root:rel,manifest:{dependencies:{external:null}}});
  assert.deepEqual(result.checked,[]);
});

function linked(base,{metadata}){
  const real=path.join(base,'real');fs.mkdirSync(real,{mode:0o700});
  write(path.join(real,'dep-a/index.js'),'module.exports = 1;\n');
  if(metadata!==null&&metadata!==undefined)write(path.join(real,'dep-a/package.json'),metadata);
  const rel=release(base);
  fs.symlinkSync(real,path.join(base,'node_modules'),'dir');
  return {rel,real};
}
const validMetadata=JSON.stringify({name:'dep-a',version:'1.0.0',main:'index.js'});

test('installed dependency metadata must be present, ordinary, bounded and match the lockfile',t=>{
  const cases=[
    {name:'missing package.json',metadata:null,code:'external_metadata_missing'},
    {name:'missing version',metadata:JSON.stringify({name:'dep-a',main:'index.js'}),code:'external_metadata_missing'},
    {name:'name mismatch',metadata:JSON.stringify({name:'other',version:'1.0.0',main:'index.js'}),code:'external_name_mismatch'},
  ];
  for(const variant of cases){
    const base=scratch();t.after(()=>fs.rmSync(base,{recursive:true,force:true}));
    const {rel,real}=linked(base,{metadata:variant.metadata});
    assert.throws(()=>resolveExternalDependencies({root:rel,manifest:manifest(real)}),{code:variant.code},variant.name);
  }
});

test('malformed installed metadata fails closed',t=>{
  const base=scratch();t.after(()=>fs.rmSync(base,{recursive:true,force:true}));
  const {rel,real}=linked(base,{metadata:'{ not json'});
  assert.throws(()=>resolveExternalDependencies({root:rel,manifest:manifest(real)}),error=>/^external_/.test(error.code),'malformed metadata must fail closed');
});

test('a symlinked or oversized installed package.json is refused',t=>{
  const base=scratch();t.after(()=>fs.rmSync(base,{recursive:true,force:true}));
  const {rel,real}=linked(base,{metadata:validMetadata});
  write(path.join(base,'metadata-copy.json'),validMetadata);
  fs.rmSync(path.join(real,'dep-a/package.json'));
  fs.symlinkSync(path.join(base,'metadata-copy.json'),path.join(real,'dep-a/package.json'));
  assert.throws(()=>resolveExternalDependencies({root:rel,manifest:manifest(real)}),{code:'external_metadata_not_regular'});

  const big=scratch();t.after(()=>fs.rmSync(big,{recursive:true,force:true}));
  const bigLinked=linked(big,{metadata:JSON.stringify({name:'dep-a',version:'1.0.0',main:'index.js',padding:'x'.repeat(300000)})});
  assert.throws(()=>resolveExternalDependencies({root:bigLinked.rel,manifest:manifest(bigLinked.real)}),{code:'external_metadata_too_large'});
});

test('a lockfile without a version for an installed dependency is refused',t=>{
  const base=scratch();t.after(()=>fs.rmSync(base,{recursive:true,force:true}));
  const {rel,real}=linked(base,{metadata:validMetadata});
  fs.writeFileSync(path.join(rel,'package-lock.json'),JSON.stringify({lockfileVersion:3,packages:{}}));
  assert.throws(()=>resolveExternalDependencies({root:rel,manifest:manifest(real)}),{code:'external_lock_metadata_missing'});
});
