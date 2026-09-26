#!/usr/bin/env node
// Versioned release packaging. Assembles a NEW immutable root from an explicit
// git-tracked (cached) source allowlist plus a built dist. Node dependencies are
// referenced read-only from outside and bound by lock hash and Node ABI/version.
//
// Permission safety: read-only bits are applied only to the exact files/dirs THIS
// packer created. Every path is validated first (strict relative path, canonical
// root with no symlink ancestor, lstat + O_NOFOLLOW fd + dev/ino equality, nlink==1)
// and only then fchmod'd. There is no recursive chmod over an arbitrary tree.
import fs from 'node:fs';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {buildManifest,writeManifest,verifyManifest,readManifest,MANIFEST_NAME,OWNED_MARKER} from './release_manifest.mjs';
import {assertAbsoluteRoot,canonicalTarget,rootsCollide} from './release_roots.mjs';

export const REPO_ROOT=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
export {OWNED_MARKER};
export const PACKAGE_VERSION=1;
export const RELEASE_DIRS=Object.freeze(['server','contracts','src','scripts','public','hermes-plugin','docs']);
export const RELEASE_FILES=Object.freeze(['index.html','package.json','package-lock.json','tsconfig.json','vite.config.js','AGENTS.md']);
const EXCLUDE=Object.freeze(['server/mobile-proxy.mjs','hermes-plugin/orbit-source.tar.gz']);
const SECRET=/^(?:.*\/)?\.env(?:\..*)?$|\.(?:pem|key|p12|pfx)$/;
const sha256=value=>createHash('sha256').update(value).digest('hex');

export class PermissionSafetyError extends Error{
  constructor(code,message,details={}){super(message);this.name='PermissionSafetyError';this.code=code;Object.assign(this,details);}
}

function splitRoots(value){return String(value??'').split(/[:,]/).map(entry=>entry.trim()).filter(Boolean);}
export function protectedRootsFromEnv(env=process.env){
  const roots=[...splitRoots(env.ORBIT_PROTECTED_ROOTS)];
  for(const key of ['ORBIT_RELEASE_ROOT','ORBIT_RUNTIME_DIR','ORBIT_SERVED_DIST'])if(env[key])roots.push(env[key]);
  return roots.map(root=>path.resolve(root));
}

// Only git-tracked (cached) inputs are eligible; untracked and ignored files are
// never copied. The manifest binds the actual copied bytes, so a dirty tracked file
// is bound by digest rather than claimed as a clean commit.
function candidateFiles(sourceRoot){
  return execFileSync('/usr/bin/git',['-C',sourceRoot,'ls-files','--cached','-z'],{encoding:'utf8',env:{PATH:'/usr/bin:/bin'}}).split('\0').filter(Boolean);
}
function allowed(relative){
  if(EXCLUDE.includes(relative))return false;
  if(relative.startsWith('docs/images/'))return false;
  if(SECRET.test(relative))return false;
  if(RELEASE_FILES.includes(relative))return true;
  return RELEASE_DIRS.some(dir=>relative.startsWith(dir+'/'));
}
export function releaseInputs({sourceRoot=REPO_ROOT}={}){return candidateFiles(sourceRoot).filter(allowed).sort();}

// --- strict, symlink-safe path handling -----------------------------------

export function safeRelative(relative){
  if(typeof relative!=='string'||relative==='')return false;
  if(path.isAbsolute(relative)||relative.includes('\\'))return false;
  return relative.split('/').every(segment=>segment!==''&&segment!=='.'&&segment!=='..');
}
function assertSafeRoot(root){
  if(typeof root!=='string'||!path.isAbsolute(root))throw new PermissionSafetyError('unsafe_root','Root must be an absolute path.',{root});
  const absolute=path.resolve(root);
  const stat=fs.lstatSync(absolute);
  if(stat.isSymbolicLink()||!stat.isDirectory())throw new PermissionSafetyError('unsafe_root',`Root must be a non-symlink directory: ${absolute}`,{root:absolute});
  const real=fs.realpathSync.native(absolute);
  if(real!==absolute)throw new PermissionSafetyError('symlink_ancestor','Root path must not contain a symlink ancestor.',{root:absolute,resolved:real});
  return absolute;
}
function identity(stat){return `${stat.dev}:${stat.ino}`;}
function assertNoSymlinkChain(root,relative){
  let cursor=root;
  for(const segment of relative.split('/')){
    cursor=path.join(cursor,segment);
    if(fs.lstatSync(cursor).isSymbolicLink())throw new PermissionSafetyError('symlink_in_path',`Refusing to follow a symlink: ${relative}`,{root,path:relative});
  }
}
function assertWithin(root,relative){
  if(!safeRelative(relative))throw new PermissionSafetyError('unsafe_path',`Refusing unsafe relative path: ${relative}`,{path:relative});
  const target=path.join(root,relative);
  if(target!==root&&!target.startsWith(root+path.sep))throw new PermissionSafetyError('path_escape',`Path escapes the owned root: ${relative}`,{path:relative});
  assertNoSymlinkChain(root,relative);
  return target;
}
function openStable(target,before,{directory}){
  const flags=fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW|(directory?fs.constants.O_DIRECTORY:0);
  const fd=fs.openSync(target,flags);
  try{
    const after=fs.fstatSync(fd);
    const typeOk=directory?after.isDirectory():after.isFile();
    if(!typeOk||(!directory&&after.nlink>1)||identity(after)!==identity(before))throw new PermissionSafetyError('unstable_entry',`Entry changed or is not a stable ${directory?'directory':'regular file'}: ${target}`,{target});
    return fd;
  }catch(error){fs.closeSync(fd);throw error;}
}

// Apply 0444 to exactly the owned files. Validation happens before any chmod.
export function applyReadOnlyOwnedFiles({root,files}){
  const absolute=assertSafeRoot(root);
  const fds=[];
  try{
    for(const relative of files){
      const target=assertWithin(absolute,relative);
      const before=fs.lstatSync(target);
      if(before.isSymbolicLink()||!before.isFile())throw new PermissionSafetyError('unsafe_file',`Not an ordinary file: ${relative}`,{path:relative});
      if(before.nlink>1)throw new PermissionSafetyError('hardlinked_file',`Refusing to chmod a multiply-linked file: ${relative}`,{path:relative,nlink:before.nlink});
      fds.push(openStable(target,before,{directory:false}));
    }
    for(const fd of fds)fs.fchmodSync(fd,0o444);
  }finally{for(const fd of fds)try{fs.closeSync(fd);}catch{}}
  return true;
}

export function lockOwnedDirectories({root,files}){
  const absolute=assertSafeRoot(root);
  const dirs=new Set([absolute]);
  for(const relative of files){const target=assertWithin(absolute,relative);let cursor=path.dirname(target);while(cursor.startsWith(absolute)){dirs.add(cursor);if(cursor===absolute)break;cursor=path.dirname(cursor);}}
  const ordered=[...dirs].sort((a,b)=>b.length-a.length);
  const fds=[];
  try{
    for(const directory of ordered){
      const before=fs.lstatSync(directory);
      if(before.isSymbolicLink()||!before.isDirectory())throw new PermissionSafetyError('unsafe_directory',`Not a directory: ${directory}`,{path:directory});
      fds.push(openStable(directory,before,{directory:true}));
    }
    for(const fd of fds)fs.fchmodSync(fd,0o555);
  }finally{for(const fd of fds)try{fs.closeSync(fd);}catch{}}
  return ordered;
}

// --- packaging --------------------------------------------------------------

function copyFile(sourceRoot,relative,root,owned){
  const source=path.join(sourceRoot,relative);
  if(!fs.existsSync(source))return false;
  const stat=fs.lstatSync(source);
  if(stat.isSymbolicLink()||!stat.isFile())throw new PermissionSafetyError('unsafe_input',`Release input must be an ordinary file: ${relative}`,{path:relative});
  const target=path.join(root,relative);fs.mkdirSync(path.dirname(target),{recursive:true});
  fs.copyFileSync(source,target);owned.push(relative.replaceAll('\\','/'));return true;
}
function copyTree(source,root,prefix,owned){
  for(const entry of fs.readdirSync(source)){const absolute=path.join(source,entry),relative=path.posix.join(prefix,entry),stat=fs.lstatSync(absolute);
    if(stat.isSymbolicLink())throw new PermissionSafetyError('unsafe_input',`Release dist must not contain symlinks: ${relative}`,{path:relative});
    if(stat.isDirectory())copyTree(absolute,root,relative,owned);
    else if(stat.isFile()){const target=path.join(root,relative);fs.mkdirSync(path.dirname(target),{recursive:true});fs.copyFileSync(absolute,target);owned.push(relative);}
  }
}
function ownedInventory(root){
  const files=[],directories=[];
  const visit=relative=>{
    const absolute=path.join(root,relative),stat=fs.lstatSync(absolute);
    if(stat.isSymbolicLink())throw new PermissionSafetyError('unsafe_entry',`Release contains a symlink: ${relative}`,{path:relative});
    if(stat.isDirectory()){directories.push(relative.replaceAll('\\','/')||'.');for(const entry of fs.readdirSync(absolute).sort())visit(path.join(relative,entry));return;}
    if(!stat.isFile()||stat.nlink>1)throw new PermissionSafetyError('unsafe_entry',`Release contains a non-ordinary file: ${relative}`,{path:relative});
    files.push(relative.replaceAll('\\','/'));
  };
  for(const entry of fs.readdirSync(root).sort())if(entry!==OWNED_MARKER&&entry!==MANIFEST_NAME)visit(entry);
  return {files,directories};
}

export function packageRelease({sourceRoot=REPO_ROOT,distRoot,outRoot,release_id,compat={},revision=null,external=null,readOnly=true,now=Date.now(),nonce='pack',env=process.env}={}){
  const source=assertAbsoluteRoot('source',sourceRoot,{mustExist:true});
  if(typeof release_id!=='string'||!release_id.trim())throw new PermissionSafetyError('invalid_request','A nonempty release id is required.');
  if(!outRoot||!path.isAbsolute(outRoot))throw new PermissionSafetyError('invalid_root','Release output must be an absolute path.');
  if(fs.existsSync(outRoot))throw new PermissionSafetyError('out_exists','Release output must be a new path; refusing to adopt an existing directory.',{root:outRoot});
  const root=assertAbsoluteRoot('outRoot',outRoot);
  if(canonicalTarget(outRoot)!==path.resolve(outRoot))throw new PermissionSafetyError('symlink_ancestor','Release output must not contain a symlink ancestor.',{root:outRoot});
  if(!distRoot||!fs.existsSync(path.join(distRoot,'index.html')))throw new Error('distRoot must contain index.html.');
  const canonicalDist=assertAbsoluteRoot('distRoot',distRoot,{mustExist:true});
  if(rootsCollide(root,canonicalDist))throw new PermissionSafetyError('roots_collide','Release output must be separated from dist.',{root,dist:canonicalDist});
  if(rootsCollide(root,source))throw new PermissionSafetyError('roots_collide','Release output must be separated from the source root.',{root,source});
  for(const protectedRoot of protectedRootsFromEnv(env)){const relation=rootsCollide(root,protectedRoot);if(relation)throw new PermissionSafetyError('protected_root','Release output collides with a protected root.',{relation,protected_root:protectedRoot});}
  fs.mkdirSync(root,{recursive:true,mode:0o700});
  const inputs=releaseInputs({sourceRoot:source});
  const owned=[];
  for(const relative of inputs)copyFile(source,relative,root,owned);
  copyTree(canonicalDist,root,'dist',owned);
  if(readOnly)applyReadOnlyOwnedFiles({root,files:owned});
  let resolvedExternal=null;
  if(external)resolvedExternal={...external,lockfile_hash:sha256(fs.readFileSync(path.join(root,'package-lock.json')))};
  const manifest=buildManifest({root,release_id,compat,revision,external:resolvedExternal,created_at:now});
  const marker={version:1,release_id,manifest_integrity:manifest.integrity,nonce};
  fs.writeFileSync(path.join(root,OWNED_MARKER),`${JSON.stringify(marker)}\n`,{mode:0o644,flag:'wx'});
  writeManifest({root,manifest});
  if(readOnly){
    applyReadOnlyOwnedFiles({root,files:[OWNED_MARKER,MANIFEST_NAME]});
    lockOwnedDirectories({root,files:owned});
  }
  const verified=verifyManifest({root,manifest});
  if(!verified.ok)throw new Error(`Packaged release failed verification: ${JSON.stringify(verified.errors)}`);
  return {root,manifest,marker,file_count:manifest.files.length,inputs:inputs.length,package_version:PACKAGE_VERSION};
}

// Cleanup of an owned release only. Requires: root absolute, non-symlink, no symlink
// ancestor, inside the declared scratch base, no protected-root collision; our marker
// (read only after lstat rejects a symlink) matching the actual on-disk manifest;
// and an inventory exactly equal to that verified manifest including manifest/marker
// separately. No recursive chmod of an arbitrary tree is possible.
export function removeOwnedRelease({root,manifest,scratchBase,protectedRoots=[],env=process.env}={}){
  const absolute=assertSafeRoot(root);
  if(!manifest||typeof manifest.release_id!=='string'||typeof manifest.integrity!=='string'||!Array.isArray(manifest.files))throw new PermissionSafetyError('invalid_manifest','A release manifest is required for owned cleanup.');
  if(typeof scratchBase!=='string'||!scratchBase)throw new PermissionSafetyError('missing_scratch_base','Owned cleanup requires a scratch base.');
  const canonicalBase=assertSafeRoot(scratchBase);
  if(absolute!==canonicalBase&&!absolute.startsWith(canonicalBase+path.sep))throw new PermissionSafetyError('outside_scratch_base','Owned cleanup root is outside the scratch base.',{root:absolute,scratch_base:canonicalBase});
  for(const protectedRoot of [...protectedRoots,...protectedRootsFromEnv(env)]){const relation=rootsCollide(absolute,protectedRoot);if(relation)throw new PermissionSafetyError('protected_root','Owned cleanup root collides with a protected root.',{relation,protected_root:protectedRoot});}
  const markerPath=path.join(absolute,OWNED_MARKER);
  if(!fs.existsSync(markerPath))throw new PermissionSafetyError('not_owned','Refusing to clean a root without the packer marker.',{root:absolute});
  const markerStat=fs.lstatSync(markerPath);
  if(markerStat.isSymbolicLink()||!markerStat.isFile())throw new PermissionSafetyError('not_owned','Packer marker must be an ordinary file.',{root:absolute});
  let marker;try{marker=JSON.parse(fs.readFileSync(markerPath,'utf8'));}catch{throw new PermissionSafetyError('not_owned','Packer marker is malformed.');}
  if(marker.release_id!==manifest.release_id||marker.manifest_integrity!==manifest.integrity)throw new PermissionSafetyError('not_owned','Packer marker does not match the given manifest.',{root:absolute});
  const diskManifest=readManifest({root:absolute});
  const verified=verifyManifest({root:absolute,manifest:diskManifest});
  if(!verified.ok)throw new PermissionSafetyError('manifest_invalid','On-disk release manifest failed verification.',{errors:verified.errors});
  if(diskManifest.release_id!==manifest.release_id||diskManifest.integrity!==manifest.integrity)throw new PermissionSafetyError('not_owned','On-disk manifest does not match the given manifest.',{root:absolute});
  const found=ownedInventory(absolute);
  const expectedFiles=new Set(diskManifest.files.map(file=>file.path));
  for(const file of found.files)if(!expectedFiles.has(file))throw new PermissionSafetyError('inventory_mismatch',`Unlisted file in owned release: ${file}`,{path:file});
  for(const file of expectedFiles)if(!found.files.includes(file))throw new PermissionSafetyError('inventory_mismatch',`Missing file in owned release: ${file}`,{path:file});
  const expectedDirs=new Set(['.']);
  for(const file of diskManifest.files)for(const directory of ownedDirectoriesUnder(absolute,file.path))expectedDirs.add(directory);
  for(const directory of found.directories)if(!expectedDirs.has(directory))throw new PermissionSafetyError('inventory_mismatch',`Unlisted directory in owned release: ${directory}`,{path:directory});
  const dirs=[...new Set([absolute,...found.directories.map(dir=>path.join(absolute,dir))])].sort((a,b)=>b.length-a.length);
  const fds=[];
  try{
    for(const directory of dirs){
      const before=fs.lstatSync(directory);
      if(before.isSymbolicLink()||!before.isDirectory())throw new PermissionSafetyError('unsafe_directory',`Not a directory: ${directory}`,{path:directory});
      fds.push(openStable(directory,before,{directory:true}));
    }
    for(const fd of fds)fs.fchmodSync(fd,0o700);
  }finally{for(const fd of fds)try{fs.closeSync(fd);}catch{}}
  fs.rmSync(absolute,{recursive:true,force:true});
  return {removed:true,root:absolute};
}
function ownedDirectoriesUnder(root,relative){
  const dirs=[];let cursor=path.dirname(path.join(root,relative));
  while(cursor.startsWith(root)&&cursor!==root){dirs.push(path.relative(root,cursor));cursor=path.dirname(cursor);}
  return dirs;
}

function parseArgs(argv){
  const [action,...rest]=argv,options={};
  for(let i=0;i<rest.length;i++){
    const arg=rest[i];
    if(arg==='--source')options.sourceRoot=rest[++i];
    else if(arg==='--dist')options.distRoot=rest[++i];
    else if(arg==='--out')options.outRoot=rest[++i];
    else if(arg==='--id')options.release_id=rest[++i];
    else if(arg==='--revision')options.revision=rest[++i];
    else if(arg==='--schema-min')options.compat={...(options.compat??{}),schema_min:Number(rest[++i])};
    else if(arg==='--schema-max')options.compat={...(options.compat??{}),schema_max:Number(rest[++i])};
    else if(arg==='--node')options.compat={...(options.compat??{}),node:rest[++i]};
    else if(arg==='--hermes-commit')options.compat={...(options.compat??{}),hermes_commit:rest[++i]};
    else if(arg==='--external-path')options.external={...(options.external??{}),kind:'referenced-readonly',path:rest[++i]};
    else if(arg==='--external-abi')options.external={...(options.external??{}),node_abi:rest[++i]};
    else if(arg==='--external-node')options.external={...(options.external??{}),node_version:rest[++i]};
    else if(arg==='--writable')options.readOnly=false;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  options.action=action;return options;
}

function main(){
  try{
    const options=parseArgs(process.argv.slice(2));
    if(options.action!=='build')throw new Error('Usage: release_package.mjs build --source DIR --dist DIR --out DIR --id ID [--external-*] [--writable]');
    const result=packageRelease({...options});
    console.log(JSON.stringify({ok:true,root:result.root,release_id:result.manifest.release_id,file_count:result.file_count,integrity:result.manifest.integrity,build_id:result.manifest.source.build_id}));
  }catch(error){
    console.log(JSON.stringify({ok:false,code:error.code??'unavailable',message:error.message}));
    process.exitCode=1;
  }
}

if(import.meta.url===pathToFileURL(process.argv[1]??'').href)main();
