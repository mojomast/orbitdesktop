#!/usr/bin/env node
// Versioned, integrity-checked release manifest. Covers served assets, server,
// plugin, contracts, metadata AND the dependency lockfile. Integrity uses a
// recursive canonical serialization, so nested file hashes and compatibility
// values are covered. Verify distinguishes a complete inventory from a partial one:
// unlisted served/server files, missing required components, wrong modes, unsafe
// paths, symlinked ancestors and incomplete compatibility all fail closed.
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {fileURLToPath,pathToFileURL} from 'node:url';

export const REPO_ROOT=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
// Pinned runtime commit for release compatibility. Kept as a local constant so the
// release tooling depends only on Node builtins (it must run even when the shared
// dependency tree is unavailable); packageRelease may override it explicitly.
export const DEFAULT_HERMES_COMMIT='d0288be5b3330d2442e3907185b8e9d0958297bb';
export const MANIFEST_NAME='.orbit-release-manifest.json';
export const OWNED_MARKER='.orbit-release-owned.json';
export const MANIFEST_VERSION=1;
export const DEFAULT_EXCLUDE=Object.freeze(['.git','node_modules','.runtime','active-release.json',MANIFEST_NAME,OWNED_MARKER]);
export const REQUIRED_COMPONENTS=Object.freeze({
  server:['server/index.mjs'],
  contracts:['contracts/workspace-v1.mjs','contracts/workbench-v1.mjs','contracts/workbench-result-v1.mjs'],
  served:['dist/index.html'],
  plugin:['hermes-plugin/workbench.py'],
  metadata:['package.json'],
  lock:['package-lock.json'],
});
const REQUIRED_FLAT=Object.values(REQUIRED_COMPONENTS).flat();

export class ManifestError extends Error{
  constructor(code,message,details={}){super(message);this.name='ManifestError';this.code=code;Object.assign(this,details);}
}

const sha256=value=>createHash('sha256').update(value).digest('hex');

// Recursive canonical JSON: sorts keys at EVERY level so nested file hashes and
// compatibility values participate in the integrity digest.
export function canonicalJson(value){
  if(Array.isArray(value))return `[${value.map(canonicalJson).join(',')}]`;
  if(value&&typeof value==='object')return `{${Object.keys(value).sort().map(key=>`${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}

export function manifestIntegrity(manifest){
  const body={...manifest};delete body.integrity;
  return sha256(canonicalJson(body));
}

function safeRelativePath(value){
  if(typeof value!=='string'||value==='')return 'empty';
  if(path.isAbsolute(value))return 'absolute';
  if(value.includes('\\'))return 'backslash';
  const segments=value.split('/');
  if(segments.some(segment=>segment===''||segment==='.'||segment==='..'))return 'unsafe_segment';
  if(value!==value.normalize('NFC'))return 'non_nfc';
  return null;
}

function symlinkInChain(root,relative){
  let cursor=root;
  for(const segment of relative.split('/')){
    cursor=path.join(cursor,segment);
    let stat;try{stat=fs.lstatSync(cursor);}catch{return false;}
    if(stat.isSymbolicLink())return true;
  }
  return false;
}

function walk(root){
  const excluded=new Set(DEFAULT_EXCLUDE),files=[];
  const visit=relative=>{
    const absolute=path.join(root,relative),stat=fs.lstatSync(absolute);
    if(stat.isSymbolicLink())throw new ManifestError('symlink_not_allowed',`Release content must be ordinary files: ${relative}`,{path:relative});
    if(stat.isDirectory()){for(const entry of fs.readdirSync(absolute).sort())if(!excluded.has(entry))visit(path.posix.join(relative,entry));return;}
    if(!stat.isFile())throw new ManifestError('special_file_not_allowed',`Unsupported release entry: ${relative}`,{path:relative});
    files.push({path:relative.replaceAll('\\','/'),bytes:stat.size,mode:(stat.mode&0o777).toString(8),sha256:sha256(fs.readFileSync(absolute))});
  };
  for(const entry of fs.readdirSync(root).sort())if(!excluded.has(entry))visit(entry);
  return files;
}

// Mirrors the service Doctor identity: SHA-256 over sorted server/*.mjs and
// contracts/*.mjs names/bytes (excluding the owner-specific mobile proxy).
export function serviceBuildId(root){
  const hash=createHash('sha256');
  for(const [prefix,directory] of [['./','server'],['../contracts/','contracts']]){
    const absolute=path.join(root,directory);
    if(!fs.existsSync(absolute))continue;
    for(const name of fs.readdirSync(absolute).filter(name=>name.endsWith('.mjs')&&name!=='mobile-proxy.mjs').sort()){
      hash.update(prefix+name+'\0');hash.update(fs.readFileSync(path.join(absolute,name)));
    }
  }
  return hash.digest('hex');
}

function normaliseCompat(compat={}){
  const value={node:compat.node??'>=22.12',schema_min:compat.schema_min??7,schema_max:compat.schema_max??7,hermes_commit:compat.hermes_commit??DEFAULT_HERMES_COMMIT};
  assertCompatComplete(value);
  return value;
}

export function assertCompatComplete(compat){
  const errors=[];
  if(typeof compat?.node!=='string'||!compat.node.trim())errors.push('node');
  if(!Number.isInteger(compat?.schema_min)||compat.schema_min<1)errors.push('schema_min');
  if(!Number.isInteger(compat?.schema_max)||compat.schema_max<1)errors.push('schema_max');
  if(Number.isInteger(compat?.schema_min)&&Number.isInteger(compat?.schema_max)&&compat.schema_min>compat.schema_max)errors.push('schema_range');
  if(typeof compat?.hermes_commit!=='string'||!/^[a-f0-9]{40}$/.test(compat.hermes_commit))errors.push('hermes_commit');
  if(errors.length)throw new ManifestError('incomplete_compatibility','Release compatibility values must be complete and valid.',{missing:errors});
  return true;
}

function readLockfile(root){
  const target=path.join(root,'package-lock.json');
  if(!fs.existsSync(target))throw new ManifestError('missing_required_component','package-lock.json is required for a release.',{path:'package-lock.json'});
  let lock;try{lock=JSON.parse(fs.readFileSync(target,'utf8'));}catch{throw new ManifestError('lockfile_malformed','package-lock.json is not valid JSON.');}
  if(!Number.isInteger(lock.lockfileVersion))throw new ManifestError('lockfile_malformed','package-lock.json has no lockfileVersion.');
  return {lockfile:'package-lock.json',lockfile_hash:sha256(fs.readFileSync(target)),lockfile_version:lock.lockfileVersion,package_count:Object.keys(lock.packages??{}).length,install:'npm-ci-offline',node_modules_included:false};
}

// Node dependencies are referenced read-only from outside the immutable release.
// Their provenance (lock hash + Node ABI/version) is recorded rather than pretending
// the release contains a complete vendored dependency tree.
function normaliseExternal({external,lockfile_hash}={}){
  if(external===undefined||external===null)return null;
  const errors=[];
  if(external.kind!=='referenced-readonly')errors.push('kind');
  if(typeof external.path!=='string'||!external.path.trim())errors.push('path');
  if(typeof external.node_abi!=='string'||!external.node_abi)errors.push('node_abi');
  if(typeof external.node_version!=='string'||!external.node_version)errors.push('node_version');
  if(external.lockfile_hash!==lockfile_hash)errors.push('lockfile_hash');
  if(errors.length)throw new ManifestError('invalid_external','External dependency provenance is incomplete or does not match the lockfile.',{missing:errors});
  return {kind:'referenced-readonly',path:external.path,node_abi:external.node_abi,node_version:external.node_version,lockfile_hash};
}

export function buildManifest({root,release_id,compat={},revision=null,external=null,created_at=Date.now()}={}){
  const absolute=path.resolve(root);
  if(!fs.existsSync(absolute)||!fs.statSync(absolute).isDirectory())throw new ManifestError('invalid_root','Release root must be an existing directory.',{root:absolute});
  if(typeof release_id!=='string'||release_id.trim()==='')throw new ManifestError('invalid_request','A nonempty release id is required.');
  const files=walk(absolute);
  const present=new Set(files.map(file=>file.path));
  const missing=REQUIRED_FLAT.filter(entry=>!present.has(entry)).map(entry=>({path:entry}));
  if(missing.length)throw new ManifestError('missing_required_component','Release manifest is missing required content.',{missing});
  if(revision!==null&&(typeof revision!=='string'||!revision.trim()))throw new ManifestError('invalid_request','revision must be a nonempty string when provided.');
  const dependencies=readLockfile(absolute);
  dependencies.external=normaliseExternal({external,lockfile_hash:dependencies.lockfile_hash});
  const manifest={
    version:MANIFEST_VERSION,release_id,created_at,
    source:{build_id:serviceBuildId(absolute),revision},
    compat:normaliseCompat(compat),
    dependencies,
    runtime:{directory_env:'ORBIT_RUNTIME_DIR',sqlite_filename:'workspace.sqlite'},
    files,
    required:REQUIRED_COMPONENTS,
  };
  manifest.integrity=manifestIntegrity(manifest);
  return manifest;
}

export function writeManifest({root,manifest}){const target=path.join(path.resolve(root),MANIFEST_NAME);fs.writeFileSync(target,`${JSON.stringify(manifest,null,2)}\n`,{mode:0o644});return target;}
export function readManifest({root,manifestPath}={}){
  const target=manifestPath?path.resolve(manifestPath):path.join(path.resolve(root),MANIFEST_NAME);
  if(!fs.existsSync(target))throw new ManifestError('manifest_missing','Release manifest not found.',{manifest:target});
  try{return JSON.parse(fs.readFileSync(target,'utf8'));}catch{throw new ManifestError('manifest_malformed','Release manifest is not valid JSON.',{manifest:target});}
}

export function verifyManifest({root,manifest}){
  const absolute=path.resolve(root),errors=[];
  if(!manifest||manifest.version!==MANIFEST_VERSION)errors.push({code:'manifest_version',detail:manifest?.version??null});
  if(typeof manifest?.release_id!=='string'||!manifest.release_id)errors.push({code:'release_id'});
  if(manifest&&Object.hasOwn(manifest,'integrity')){
    const body={...manifest};delete body.integrity;
    if(manifest.integrity!==sha256(canonicalJson(body)))errors.push({code:'integrity'});
  }else errors.push({code:'integrity'});
  try{assertCompatComplete(manifest?.compat);}catch(error){errors.push({code:'incomplete_compatibility',missing:error.missing});}
  // Exact inventory: reject unlisted extra files and missing listed files.
  let discovered=[];
  try{discovered=walk(absolute);}catch(error){errors.push({code:error.code??'inventory_unreadable',path:error.path});}
  const discoveredPaths=new Set(discovered.map(file=>file.path));
  const seen=new Set();
  for(const file of manifest?.files??[]){
    const unsafe=safeRelativePath(file.path);
    if(unsafe){errors.push({code:'unsafe_path',path:file.path,reason:unsafe});continue;}
    if(seen.has(file.path)){errors.push({code:'duplicate_path',path:file.path});continue;}
    seen.add(file.path);
    if(!discoveredPaths.has(file.path)){errors.push({code:'missing_file',path:file.path});continue;}
    if(symlinkInChain(absolute,file.path)){errors.push({code:'symlink_ancestor',path:file.path});continue;}
    const target=path.join(absolute,file.path);
    let stat;try{stat=fs.lstatSync(target);}catch{errors.push({code:'missing_file',path:file.path});continue;}
    if(!stat.isFile()||stat.isSymbolicLink()){errors.push({code:'not_regular_file',path:file.path});continue;}
    if(stat.size!==file.bytes)errors.push({code:'size_mismatch',path:file.path});
    if((stat.mode&0o777).toString(8)!==file.mode)errors.push({code:'mode_mismatch',path:file.path});
    if(sha256(fs.readFileSync(target))!==file.sha256)errors.push({code:'hash_mismatch',path:file.path});
  }
  for(const file of discovered)if(!seen.has(file.path))errors.push({code:'unlisted_file',path:file.path});
  for(const entry of REQUIRED_FLAT)if(!seen.has(entry))errors.push({code:'missing_required_component',path:entry});
  if(manifest?.source?.build_id!==serviceBuildId(absolute))errors.push({code:'build_id_mismatch'});
  try{
    const lock=readLockfile(absolute);
    if(manifest?.dependencies?.lockfile_hash!==lock.lockfile_hash)errors.push({code:'lockfile_hash_mismatch'});
    if(manifest?.dependencies?.external){
      const ext=manifest.dependencies.external;
      if(ext.lockfile_hash!==lock.lockfile_hash)errors.push({code:'external_lock_mismatch'});
      if(typeof ext.node_abi!=='string'||!ext.node_abi||typeof ext.node_version!=='string'||!ext.node_version)errors.push({code:'invalid_external'});
    }
  }catch(error){errors.push({code:error.code??'lockfile_unreadable'});}
  return {ok:errors.length===0,errors,release_id:manifest?.release_id??null};
}

function parseArgs(argv){
  const [action,...rest]=argv,options={compat:{}};
  for(let i=0;i<rest.length;i++){
    const arg=rest[i];
    if(arg==='--root')options.root=rest[++i];
    else if(arg==='--id')options.release_id=rest[++i];
    else if(arg==='--out')options.out=rest[++i];
    else if(arg==='--manifest')options.manifest=rest[++i];
    else if(arg==='--node')options.compat.node=rest[++i];
    else if(arg==='--schema-min')options.compat.schema_min=Number(rest[++i]);
    else if(arg==='--schema-max')options.compat.schema_max=Number(rest[++i]);
    else if(arg==='--hermes-commit')options.compat.hermes_commit=rest[++i];
    else if(arg==='--revision')options.revision=rest[++i];
    else if(arg==='--created-at')options.created_at=Number(rest[++i]);
    else throw new ManifestError('invalid_request',`Unknown argument: ${arg}`);
  }
  options.action=action;return options;
}

function main(){
  try{
    const options=parseArgs(process.argv.slice(2));
    if(options.action==='build'){
      if(!options.root||!options.release_id)throw new ManifestError('invalid_request','build requires --root and --id');
      const manifest=buildManifest(options);
      const target=options.out?path.resolve(options.out):writeManifest({root:options.root,manifest});
      if(options.out)fs.writeFileSync(target,`${JSON.stringify(manifest,null,2)}\n`,{mode:0o644});
      console.log(JSON.stringify({ok:true,manifest:target,release_id:manifest.release_id,files:manifest.files.length,build_id:manifest.source.build_id,integrity:manifest.integrity}));
      return;
    }
    if(options.action==='verify'){
      const manifest=readManifest({root:options.root,manifestPath:options.manifest});
      const result=verifyManifest({root:options.root,manifest});
      console.log(JSON.stringify(result));
      if(!result.ok)process.exitCode=1;
      return;
    }
    throw new ManifestError('invalid_request','Usage: release_manifest.mjs build --root DIR --id ID [--out FILE] | verify --root DIR [--manifest FILE]');
  }catch(error){
    console.log(JSON.stringify({ok:false,code:error.code??'unavailable',message:error.message,...(error.missing?{missing:error.missing}:{})}));
    process.exitCode=1;
  }
}

if(import.meta.url===pathToFileURL(process.argv[1]??'').href)main();
