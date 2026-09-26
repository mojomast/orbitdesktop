// Isolated permission-safety regression for release packaging. Uses only Node
// builtins and a PRIVATE synthetic dependency tree under scratch: a shared external
// result must never be chmodded through a symlink or hardlink, and cleanup only
// touches an exact, marker-verified, manifest-matching owned release root.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {OWNED_MARKER,PermissionSafetyError,applyReadOnlyOwnedFiles,lockOwnedDirectories,removeOwnedRelease} from '../scripts/release_package.mjs';

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

test('a hardlinked external file is refused and unchanged',t=>{
  const base=scratch();t.after(()=>fs.rmSync(base,{recursive:true,force:true}));
  const {file}=syntheticExternal(base);
  const hard=path.join(base,'hard.js');fs.linkSync(file,hard);
  assert.equal(fs.statSync(hard).nlink,2);
  assert.throws(()=>applyReadOnlyOwnedFiles({root:base,files:['hard.js']}),{code:'hardlinked_file'});
  assert.equal(mode(file),0o600,'hardlink target unchanged');
  assert.equal(mode(hard),0o600,'hardlink entry unchanged');
});

test('a root symlink alias is refused for read-only and cleanup',t=>{
  const base=scratch();t.after(()=>fs.rmSync(base,{recursive:true,force:true}));
  const {ext,file}=syntheticExternal(base);
  const alias=path.join(base,'alias');fs.symlinkSync(ext,alias,'dir');
  assert.throws(()=>applyReadOnlyOwnedFiles({root:alias,files:[]}),{code:'unsafe_root'});
  assert.throws(()=>removeOwnedRelease({root:alias,manifest:{release_id:'r',integrity:'0'.repeat(64),files:[]},scratchBase:base}),{code:'unsafe_root'});
  assert.equal(mode(ext),0o700);assert.equal(mode(file),0o600);
});

test('only an exact marker+inventory owned release is made read-only then removed',t=>{
  const base=scratch();t.after(()=>fs.rmSync(base,{recursive:true,force:true}));
  const rel=path.join(base,'rel');fs.mkdirSync(rel);
  fs.writeFileSync(path.join(rel,'a.txt'),'a');fs.mkdirSync(path.join(rel,'deep'));fs.writeFileSync(path.join(rel,'deep','b.txt'),'b');
  const integrity='a'.repeat(64);
  fs.writeFileSync(path.join(rel,OWNED_MARKER),JSON.stringify({version:1,release_id:'rel',manifest_integrity:integrity,nonce:'t'}));
  const manifest={release_id:'rel',integrity,files:[{path:'a.txt'},{path:'deep/b.txt'}]};
  applyReadOnlyOwnedFiles({root:rel,files:['a.txt','deep/b.txt',OWNED_MARKER]});
  lockOwnedDirectories({root:rel,files:['a.txt','deep/b.txt']});
  assert.equal(mode(path.join(rel,'a.txt')),0o444);
  assert.equal(mode(path.join(rel,'deep','b.txt')),0o444);
  assert.equal(mode(rel),0o555);
  const removed=removeOwnedRelease({root:rel,manifest,scratchBase:base});
  assert.equal(removed.removed,true);
  assert.equal(fs.existsSync(rel),false,'owned release fully removed');
});

test('cleanup refuses an unmarked root, a mismatched manifest and an outside root',t=>{
  const base=scratch();t.after(()=>fs.rmSync(base,{recursive:true,force:true}));
  const rel=path.join(base,'nore');fs.mkdirSync(rel);fs.writeFileSync(path.join(rel,'a.txt'),'a');
  const manifest={release_id:'x',integrity:'b'.repeat(64),files:[{path:'a.txt'}]};
  assert.throws(()=>removeOwnedRelease({root:rel,manifest,scratchBase:base}),{code:'not_owned'});
  const marked=path.join(base,'marked');fs.mkdirSync(marked);fs.writeFileSync(path.join(marked,'a.txt'),'a');
  fs.writeFileSync(path.join(marked,OWNED_MARKER),JSON.stringify({version:1,release_id:'other',manifest_integrity:'b'.repeat(64)}));
  assert.throws(()=>removeOwnedRelease({root:marked,manifest,scratchBase:base}),{code:'not_owned'});
  const outside=scratch();t.after(()=>fs.rmSync(outside,{recursive:true,force:true}));
  fs.writeFileSync(path.join(outside,OWNED_MARKER),JSON.stringify({version:1,release_id:'x',manifest_integrity:'b'.repeat(64)}));
  fs.writeFileSync(path.join(outside,'a.txt'),'a');
  assert.throws(()=>removeOwnedRelease({root:outside,manifest,scratchBase:base}),{code:'outside_scratch_base'});
});

test('the generic recursive unlockRelease is no longer part of the public API',async()=>{
  const module=await import('../scripts/release_package.mjs');
  assert.equal('unlockRelease' in module,false);
  assert.equal('setReadOnly' in module,false);
});
