// Isolated permission-safety regression for release packaging. Uses only Node
// builtins and a PRIVATE synthetic dependency tree under scratch: a shared external
// result must never be chmodded through a symlink or hardlink, unsafe relative paths
// and symlinked roots are refused, and every mode stays unchanged on refusal.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {OWNED_MARKER,PermissionSafetyError,applyReadOnlyOwnedFiles,lockOwnedDirectories,removeOwnedRelease,safeRelative} from '../scripts/release_package.mjs';

const mode=target=>fs.statSync(target).mode&0o777;
const scratch=()=>fs.mkdtempSync('/tmp/opencode/orbit-perm-');
function syntheticExternal(base){
  const ext=path.join(base,'external-deps');fs.mkdirSync(ext,{mode:0o700});
  const file=path.join(ext,'dep.js');fs.writeFileSync(file,'dep',{mode:0o600});
  fs.chmodSync(ext,0o700);fs.chmodSync(file,0o600);
  return {ext,file};
}

test('a shared dependency reached through a directory symlink is never chmodded',t=>{
  const base=scratch();t.after(()=>fs.rmSync(base,{recursive:true,force:true}));
  const {ext,file}=syntheticExternal(base);
  fs.symlinkSync(ext,path.join(base,'deps-link'),'dir');
  assert.throws(()=>applyReadOnlyOwnedFiles({root:base,files:['deps-link/dep.js']}),error=>error instanceof PermissionSafetyError);
  assert.throws(()=>lockOwnedDirectories({root:base,files:['deps-link/dep.js']}),error=>error instanceof PermissionSafetyError);
  assert.equal(mode(ext),0o700,'external directory sentinel unchanged');
  assert.equal(mode(file),0o600,'external file sentinel unchanged');
});

test('a symlinked external file is refused and unchanged',t=>{
  const base=scratch();t.after(()=>fs.rmSync(base,{recursive:true,force:true}));
  const {file}=syntheticExternal(base);
  fs.symlinkSync(file,path.join(base,'file-link'));
  assert.throws(()=>applyReadOnlyOwnedFiles({root:base,files:['file-link']}),{code:'symlink_in_path'});
  assert.equal(mode(file),0o600,'external file sentinel unchanged');
});

test('unsafe relative paths are refused without any chmod',t=>{
  const base=scratch();t.after(()=>fs.rmSync(base,{recursive:true,force:true}));
  for(const relative of ['../escape','/absolute','a\\b','a//b','./x','..',''])assert.equal(safeRelative(relative),false,relative);
  assert.throws(()=>applyReadOnlyOwnedFiles({root:base,files:['../escape']}),{code:'unsafe_path'});
  assert.throws(()=>lockOwnedDirectories({root:base,files:['../escape']}),{code:'unsafe_path'});
});

test('a root with a symlink ancestor is refused',t=>{
  const base=scratch();t.after(()=>fs.rmSync(base,{recursive:true,force:true}));
  const real=path.join(base,'real');fs.mkdirSync(real);fs.writeFileSync(path.join(real,'x.txt'),'x');
  const realMode=mode(real);
  const link=path.join(base,'link');fs.symlinkSync(real,link,'dir');
  assert.throws(()=>applyReadOnlyOwnedFiles({root:link,files:['x.txt']}),{code:'unsafe_root'});
  const ancestorLink=path.join(base,'ancestor-link');fs.symlinkSync(base,ancestorLink,'dir');
  const child=path.join(base,'child');fs.mkdirSync(child);fs.writeFileSync(path.join(child,'y.txt'),'y');
  const childMode=mode(child);
  const viaAncestor=path.join(ancestorLink,'child');
  assert.throws(()=>applyReadOnlyOwnedFiles({root:viaAncestor,files:['y.txt']}),{code:'symlink_ancestor'});
  assert.equal(mode(child),childMode,'ancestor refusal preserves the original directory mode');
  assert.equal(mode(real),realMode,'root refusal preserves the original directory mode');
});

test('a nested hardlink is refused and neither link nor target changes',t=>{
  const base=scratch();t.after(()=>fs.rmSync(base,{recursive:true,force:true}));
  const {file}=syntheticExternal(base);
  const rel=path.join(base,'rel');fs.mkdirSync(path.join(rel,'nested'),{recursive:true});
  const nestedMode=mode(path.join(rel,'nested'));
  fs.linkSync(file,path.join(rel,'nested','hard.js'));
  assert.throws(()=>applyReadOnlyOwnedFiles({root:rel,files:['nested/hard.js']}),{code:'hardlinked_file'});
  assert.equal(mode(file),0o600,'hardlink target unchanged');
  assert.equal(mode(path.join(rel,'nested','hard.js')),0o600,'hardlink entry unchanged');
  assert.equal(mode(path.join(rel,'nested')),nestedMode,'no directory chmod before refusal');
});

test('cleanup refuses unmarked, mismatched, marker-symlink and outside roots',t=>{
  const base=scratch();t.after(()=>fs.rmSync(base,{recursive:true,force:true}));
  const manifest={release_id:'x',integrity:'b'.repeat(64),files:[{path:'a.txt'}]};
  const rel=path.join(base,'nore');fs.mkdirSync(rel);fs.writeFileSync(path.join(rel,'a.txt'),'a');
  assert.throws(()=>removeOwnedRelease({root:rel,manifest,scratchBase:base}),{code:'not_owned'});
  const marked=path.join(base,'marked');fs.mkdirSync(marked);fs.writeFileSync(path.join(marked,'a.txt'),'a');
  fs.writeFileSync(path.join(marked,OWNED_MARKER),JSON.stringify({version:1,release_id:'other',manifest_integrity:'b'.repeat(64)}));
  assert.throws(()=>removeOwnedRelease({root:marked,manifest,scratchBase:base}),{code:'not_owned'});
  const {file}=syntheticExternal(base);
  const symlinkMarker=path.join(base,'marker-symlink');fs.mkdirSync(symlinkMarker);fs.writeFileSync(path.join(symlinkMarker,'a.txt'),'a');
  fs.symlinkSync(file,path.join(symlinkMarker,OWNED_MARKER));
  assert.throws(()=>removeOwnedRelease({root:symlinkMarker,manifest,scratchBase:base}),{code:'not_owned'});
  assert.equal(mode(file),0o600,'marker symlink target never read or chmodded');
  const outside=scratch();t.after(()=>fs.rmSync(outside,{recursive:true,force:true}));
  fs.writeFileSync(path.join(outside,OWNED_MARKER),JSON.stringify({version:1,release_id:'x',manifest_integrity:'b'.repeat(64)}));
  fs.writeFileSync(path.join(outside,'a.txt'),'a');
  assert.throws(()=>removeOwnedRelease({root:outside,manifest,scratchBase:base}),{code:'outside_scratch_base'});
});

test('the generic recursive unlockRelease/setReadOnly are no longer part of the public API',async()=>{
  const module=await import('../scripts/release_package.mjs');
  assert.equal('unlockRelease' in module,false);
  assert.equal('setReadOnly' in module,false);
});
