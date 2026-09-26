#!/usr/bin/env node
// Versioned release packaging. Assembles a clean immutable root from an explicit
// git-tracked source allowlist plus a built dist — never by walking an arbitrary
// checkout (so credentials/tests/experiments are not copied by accident). Node
// dependencies are referenced read-only from outside and bound by lock hash and
// Node ABI/version rather than pretending the release vendors them.
//
// Permission safety: read-only bits are applied only to the exact files/directories
// THIS packer created, each validated with lstat and an O_NOFOLLOW fd before any
// chmod. Symlinks and multiply-linked files are refused. Cleanup requires the
// packer's own marker, an exact manifest inventory and a canonical scratch-root
// proof; there is no generic recursive chmod over an arbitrary tree.
import fs from 'node:fs';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {buildManifest,writeManifest,verifyManifest,MANIFEST_NAME} from './release_manifest.mjs';
import {assertAbsoluteRoot,canonicalTarget,rootsCollide} from './release_roots.mjs';

export const REPO_ROOT=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
export const PACKAGE_VERSION=1;
export const OWNED_MARKER='.orbit-release-owned.json';
export const RELEASE_DIRS=Object.freeze(['server','contracts','src','scripts','public','hermes-plugin','docs']);
export const RELEASE_FILES=Object.freeze(['index.html','package.json','package-lock.json','tsconfig.json','vite.config.js','AGENTS.md']);
const EXCLUDE=Object.freeze(['server/mobile-proxy.mjs','hermes-plugin/orbit-source.tar.gz']);
const SECRET=/^(?:.*\/)?\.env(?:\..*)?$|\.(?:pem|key|p12|pfx)$/;
const sha256=value=>createHash('sha256').update(value).digest('hex');

export class PermissionSafetyError extends Error{
  constructor(code,message,details={}){super(message);this.name='PermissionSafetyError';this.code=code;Object.assign(this,details);}
}

function candidateFiles(sourceRoot){
  return execFileSync('/usr/bin/git',['-C',sourceRoot,'ls-files','-co','--exclude-standard','-z'],{encoding:'utf8',env:{PATH:'/usr/bin:/bin'}}).split('\0').filter(Boolean);
}
function allowed(relative){
  if(EXCLUDE.includes(relative))return false;
  if(relative.startsWith('docs/images/'))return false;
  if(SECRET.test(relative))return false;
  if(RELEASE_FILES.includes(relative))return true;
  return RELEASE_DIRS.some(dir=>relative.startsWith(dir+'/'));
}
export function releaseInputs({sourceRoot=REPO_ROOT}={}){return candidateFiles(sourceRoot).filter(allowed).sort();}

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
function ownedDirectories(root,files){
  const dirs=new Set([root]);
  for(const relative of files){let cursor=path.dirname(path.join(root,relative));while(cursor.startsWith(root)){dirs.add(cursor);if(cursor===root)break;cursor=path.dirname(cursor);}}
  return [...dirs].sort((a,b)=>b.length-a.length);
}
function assertNoSymlinkChain(root,relative){
  let cursor=root;
  for(const segment of String(relative).split('/')){
    if(!segment||segment==='.')continue;
    cursor=path.join(cursor,segment);
    const stat=fs.lstatSync(cursor);
    if(stat.isSymbolicLink())throw new PermissionSafetyError('symlink_in_path',`Refusing to follow a symlink in the owned path: ${relative}`,{root,path:relative});
  }
}
function assertUsableDirectory(root,relative){
  assertNoSymlinkChain(root,relative);
  const target=path.join(root,relative);
  const stat=fs.lstatSync(target);
  if(stat.isSymbolicLink()||!stat.isDirectory())throw new PermissionSafetyError('unsafe_directory',`Refusing to operate on a non-directory or symlink: ${target}`,{target});
  const fd=fs.openSync(target,fs.constants.O_RDONLY|fs.constants.O_DIRECTORY|fs.constants.O_NOFOLLOW);
  try{const fstat=fs.fstatSync(fd);if(!fstat.isDirectory())throw new PermissionSafetyError('unsafe_directory',`Not a stable directory fd: ${target}`,{target});return fd;}catch(error){fs.closeSync(fd);throw error;}
}
function assertUsableFile(root,relative){
  assertNoSymlinkChain(root,relative);
  const target=path.join(root,relative);
  const stat=fs.lstatSync(target);
  if(stat.isSymbolicLink()||!stat.isFile())throw new PermissionSafetyError('unsafe_file',`Refusing to operate on a non-regular file or symlink: ${target}`,{target});
  if(stat.nlink>1)throw new PermissionSafetyError('hardlinked_file',`Refusing to chmod a multiply-linked file: ${target}`,{target,nlink:stat.nlink});
  const fd=fs.openSync(target,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);
  try{const fstat=fs.fstatSync(fd);if(!fstat.isFile()||fstat.nlink>1)throw new PermissionSafetyError('hardlinked_file',`Not a stable ordinary-file fd: ${target}`,{target});return fd;}catch(error){fs.closeSync(fd);throw error;}
}

// Apply 0444 to exactly the owned files. Validation (symlink/hardlink) happens
// before any chmod, via an O_NOFOLLOW fd whose fstat must be a stable regular file.
export function applyReadOnlyOwnedFiles({root,files}){
  const absolute=path.resolve(root);
  const rootStat=fs.lstatSync(absolute);
  if(rootStat.isSymbolicLink()||!rootStat.isDirectory())throw new PermissionSafetyError('unsafe_root',`Refusing to operate on a non-directory or symlink root: ${absolute}`,{root:absolute});
  const fds=[];
  try{
    for(const relative of files)fds.push(assertUsableFile(absolute,relative));
    for(const fd of fds)fs.fchmodSync(fd,0o444);
  }finally{for(const fd of fds)try{fs.closeSync(fd);}catch{}}
  return true;
}

// Apply 0555 to exactly the owned directories (deepest first), same validation.
export function lockOwnedDirectories({root,files}){
  const absolute=path.resolve(root);
  const rootStat=fs.lstatSync(absolute);
  if(rootStat.isSymbolicLink()||!rootStat.isDirectory())throw new PermissionSafetyError('unsafe_root',`Refusing to operate on a non-directory or symlink root: ${absolute}`,{root:absolute});
  const directories=ownedDirectories(absolute,files);
  const fds=[];
  try{
    for(const directory of directories)fds.push(assertUsableDirectory(absolute,path.relative(absolute,directory)));
    for(const fd of fds)fs.fchmodSync(fd,0o555);
  }finally{for(const fd of fds)try{fs.closeSync(fd);}catch{}}
  return directories;
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
  for(const entry of fs.readdirSync(root).sort())if(entry!==OWNED_MARKER)visit(entry);
  return {files,directories};
}

// Cleanup of an owned release only: root must be an existing non-symlink directory
// inside the declared scratch base, must not collide with a protected root, must
// carry our marker matching the given manifest, and its on-disk inventory must equal
// the manifest exactly. No recursive chmod of an arbitrary tree is possible.
export function removeOwnedRelease({root,manifest,scratchBase,protectedRoots=[]}={}){
  if(!manifest||typeof manifest.release_id!=='string'||typeof manifest.integrity!=='string'||!Array.isArray(manifest.files))throw new PermissionSafetyError('invalid_manifest','A release manifest is required for owned cleanup.');
  const absolute=path.resolve(root);
  const rootStat=fs.lstatSync(absolute);
  if(rootStat.isSymbolicLink()||!rootStat.isDirectory())throw new PermissionSafetyError('unsafe_root',`Refusing to clean a non-directory or symlink root: ${absolute}`,{root:absolute});
  const canonicalRoot=canonicalTarget(absolute);
  if(typeof scratchBase!=='string'||!scratchBase)throw new PermissionSafetyError('missing_scratch_base','Owned cleanup requires a scratch base.');
  const canonicalBase=canonicalTarget(scratchBase);
  if(canonicalRoot!==canonicalBase&&!canonicalRoot.startsWith(canonicalBase+path.sep))throw new PermissionSafetyError('outside_scratch_base','Owned cleanup root is outside the scratch base.',{root:canonicalRoot,scratch_base:canonicalBase});
  for(const protectedRoot of protectedRoots){const relation=rootsCollide(canonicalRoot,protectedRoot);if(relation)throw new PermissionSafetyError('protected_root','Owned cleanup root collides with a protected root.',{relation,protected_root:protectedRoot});}
  const markerPath=path.join(absolute,OWNED_MARKER);
  if(!fs.existsSync(markerPath))throw new PermissionSafetyError('not_owned','Refusing to clean a root without the packer marker.',{root:canonicalRoot});
  let marker;try{marker=JSON.parse(fs.readFileSync(markerPath,'utf8'));}catch{throw new PermissionSafetyError('not_owned','Packer marker is malformed.');}
  if(marker.release_id!==manifest.release_id||marker.manifest_integrity!==manifest.integrity)throw new PermissionSafetyError('not_owned','Packer marker does not match the given manifest.',{root:canonicalRoot});
  const found=ownedInventory(absolute);
  const expectedFiles=new Set(manifest.files.map(file=>file.path));
  const expectedDirs=new Set(ownedDirectories(absolute,manifest.files.map(file=>file.path)).map(dir=>path.relative(absolute,dir)||'.'));
  for(const file of found.files)if(!expectedFiles.has(file))throw new PermissionSafetyError('inventory_mismatch',`Unlisted file in owned release: ${file}`,{path:file});
  for(const file of expectedFiles)if(!found.files.includes(file))throw new PermissionSafetyError('inventory_mismatch',`Missing file in owned release: ${file}`,{path:file});
  for(const directory of found.directories)if(directory!=='.'&&!expectedDirs.has(directory))throw new PermissionSafetyError('inventory_mismatch',`Unlisted directory in owned release: ${directory}`,{path:directory});
  const fds=[];
  try{
    for(const directory of ownedDirectories(absolute,manifest.files.map(file=>file.path)))fds.push(assertUsableDirectory(absolute,path.relative(absolute,directory)));
    for(const fd of fds)fs.fchmodSync(fd,0o700);
  }finally{for(const fd of fds)try{fs.closeSync(fd);}catch{}}
  fs.rmSync(absolute,{recursive:true,force:true});
  return {removed:true,root:canonicalRoot};
}

export function packageRelease({sourceRoot=REPO_ROOT,distRoot,outRoot,release_id,compat={},revision=null,external=null,readOnly=true,now=Date.now(),nonce='pack' }={}){
  const source=assertAbsoluteRoot('source',sourceRoot,{mustExist:true});
  const root=assertAbsoluteRoot('outRoot',outRoot);
  if(fs.existsSync(root)&&fs.lstatSync(root).isSymbolicLink())throw new PermissionSafetyError('unsafe_root','Release output must not be a symlink.',{root});
  if(rootsCollide(root,source))throw new PermissionSafetyError('roots_collide','Release output must be separated from the source root.');
  if(!distRoot||!fs.existsSync(path.join(distRoot,'index.html')))throw new Error('distRoot must contain index.html.');
  if(fs.existsSync(root)){if(fs.readdirSync(root).length)throw new Error('Release output directory must not already exist or must be empty.');}else fs.mkdirSync(root,{recursive:true,mode:0o700});
  const inputs=releaseInputs({sourceRoot:source});
  const owned=[];
  for(const relative of inputs)copyFile(source,relative,root,owned);
  copyTree(distRoot,root,'dist',owned);
  const marker={version:1,release_id,manifest_integrity:null,nonce};
  fs.writeFileSync(path.join(root,OWNED_MARKER),`${JSON.stringify(marker)}\n`,{mode:0o644});
  owned.push(OWNED_MARKER);
  if(readOnly)applyReadOnlyOwnedFiles({root,files:owned});
  let resolvedExternal=null;
  if(external)resolvedExternal={...external,lockfile_hash:sha256(fs.readFileSync(path.join(root,'package-lock.json')))};
  const manifest=buildManifest({root,release_id,compat,revision,external:resolvedExternal,created_at:now});
  marker.manifest_integrity=manifest.integrity;
  // The manifest is written while the root is still writable, then made read-only.
  fs.writeFileSync(path.join(root,OWNED_MARKER),`${JSON.stringify(marker)}\n`,{mode:0o644});
  writeManifest({root,manifest});
  if(readOnly){
    applyReadOnlyOwnedFiles({root,files:[OWNED_MARKER,MANIFEST_NAME]});
    lockOwnedDirectories({root,files:owned});
  }
  const verified=verifyManifest({root,manifest});
  if(!verified.ok)throw new Error(`Packaged release failed verification: ${JSON.stringify(verified.errors)}`);
  return {root,manifest,marker,file_count:manifest.files.length,inputs:inputs.length,package_version:PACKAGE_VERSION};
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
