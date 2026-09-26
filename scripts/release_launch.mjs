#!/usr/bin/env node
// Resolves and verifies the single pinned release and returns the physical root,
// entry point and environment a launcher must use. Activation is not "healthy"
// merely because a URL returns 200: the probe must present the pinned release
// identity. Runtime data lives outside every release.
import fs from 'node:fs';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {readManifest,verifyManifest,assertCompatComplete} from './release_manifest.mjs';
import {assertSeparatedRoots,canonicalTarget} from './release_roots.mjs';

export const REPO_ROOT=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
export const POINTER_NAME='active-release.json';

export class PinError extends Error{
  constructor(code,message,details={}){super(message);this.name='PinError';this.code=code;Object.assign(this,details);}
}

export function pointerPath(runtime){return path.join(canonicalTarget(path.resolve(runtime)),POINTER_NAME);}

export function readPointer(runtime){
  const target=pointerPath(runtime);
  if(!fs.existsSync(target))return null;
  let pointer;try{pointer=JSON.parse(fs.readFileSync(target,'utf8'));}catch{throw new PinError('pointer_malformed','Active release pointer is not valid JSON.',{pointer:target});}
  // Flatten any accidental nesting: exactly one retained previous release.
  if(pointer.previous&&pointer.previous.previous){pointer={...pointer,previous:{...pointer.previous,previous:null}};}
  return pointer;
}

export function writePointerAtomic(runtime,pointer){
  const directory=canonicalTarget(path.resolve(runtime));
  if(!fs.existsSync(directory))throw new PinError('runtime_missing','Runtime directory must already exist.',{runtime:directory});
  const target=path.join(directory,POINTER_NAME),temporary=path.join(directory,`.${POINTER_NAME}.${randomUUID()}.tmp`);
  fs.writeFileSync(temporary,`${JSON.stringify(pointer,null,2)}\n`,{mode:0o600,flag:'wx'});
  fs.renameSync(temporary,target);
  return target;
}

async function defaultOpen(database){
  const {default:Database}=await import('better-sqlite3');
  return new Database(database,{readonly:true,fileMustExist:true});
}

export async function currentSchemaVersion(runtime,{open=defaultOpen}={}){
  const database=path.join(canonicalTarget(path.resolve(runtime)),'workspace.sqlite');
  if(!fs.existsSync(database))return {schema_version:null,database:null};
  let db;
  try{db=await open(database);}catch{throw new PinError('schema_unreadable','Runtime database could not be opened read-only.',{database});}
  if(!db||typeof db.pragma!=='function')throw new PinError('schema_unreadable','SQLite opener did not return a database handle.',{database});
  try{return {schema_version:db.pragma('user_version',{simple:true}),database};}finally{db.close();}
}

function parseNodeRequirement(requirement){
  const match=/^>=\s*(\d+)(?:\.(\d+))?(?:\.(\d+))?/.exec(String(requirement??'').trim());
  return match?[Number(match[1]),Number(match[2]??0),Number(match[3]??0)]:null;
}

export function checkCompatibility({manifest,schema_version,nodeVersion=process.versions.node}={}){
  assertCompatComplete(manifest?.compat);
  const required=parseNodeRequirement(manifest.compat.node);
  if(required){
    const current=nodeVersion.split('.').map(Number);
    for(let i=0;i<3;i++){
      if(current[i]>required[i])break;
      if(current[i]<required[i])throw new PinError('node_incompatible',`Release requires Node ${manifest.compat.node}; running ${nodeVersion}.`,{required:manifest.compat.node,node:nodeVersion});
    }
  }
  const {schema_min:min,schema_max:max}=manifest.compat;
  if(schema_version!==null&&schema_version!==undefined){
    if(schema_version<min)throw new PinError('schema_upgrade_required',`Runtime schema ${schema_version} is older than the release minimum ${min}; back up and upgrade, never downgrade.`,{schema_version,schema_min:min});
    if(schema_version>max)throw new PinError('schema_downgrade_refused',`Runtime schema ${schema_version} is newer than release maximum ${max}; restoring an older binary requires the matching pre-upgrade backup.`,{schema_version,schema_max:max});
  }
  return true;
}

export function verifyRelease(releaseDir){
  const root=canonicalTarget(path.resolve(releaseDir));
  if(!fs.existsSync(root))throw new PinError('release_missing','Release directory does not exist.',{release:root});
  const manifest=readManifest({root});
  const verified=verifyManifest({root,manifest});
  if(!verified.ok)throw new PinError('release_integrity_failed','Release manifest verification failed.',{release:root,errors:verified.errors});
  if(typeof manifest.release_id!=='string'||!manifest.release_id)throw new PinError('release_id_missing','Release manifest has no release id.',{release:root});
  return {root,manifest,verified};
}

export async function resolveLaunch({runtime,open=defaultOpen,nodeVersion=process.versions.node}={}){
  const runtimeRoot=canonicalTarget(path.resolve(runtime));
  if(!fs.existsSync(runtimeRoot))throw new PinError('runtime_missing','Runtime directory must already exist.',{runtime:runtimeRoot});
  const pointer=readPointer(runtimeRoot);
  if(!pointer)throw new PinError('no_active_release','No active release is selected.');
  const {root,manifest}=verifyRelease(pointer.release_path);
  if(pointer.release_id!==manifest.release_id)throw new PinError('pointer_manifest_mismatch','The pointer release id does not match the verified manifest.',{pointer_release_id:pointer.release_id,manifest_release_id:manifest.release_id});
  if(pointer.manifest_integrity!==manifest.integrity)throw new PinError('pointer_manifest_mismatch','The pointer manifest integrity does not match the verified manifest.',{pointer_integrity:pointer.manifest_integrity,manifest_integrity:manifest.integrity});
  if(canonicalTarget(pointer.release_path)!==root)throw new PinError('pointer_path_mismatch','The pointer release path is not the verified physical root.',{pointer_path:pointer.release_path,physical_root:root});
  assertSeparatedRoots({runtime:runtimeRoot,release:root});
  const {schema_version}=await currentSchemaVersion(runtimeRoot,{open});
  checkCompatibility({manifest,schema_version,nodeVersion});
  const external=manifest.dependencies?.external;
  if(external){
    if(external.node_abi!==process.versions.modules)throw new PinError('dependency_abi_mismatch','External dependency ABI does not match the running Node.',{expected:external.node_abi,actual:process.versions.modules});
    if(external.lockfile_hash!==manifest.dependencies.lockfile_hash)throw new PinError('dependency_lock_mismatch','External dependency lock hash does not match the release lockfile.',{});
  }
  const entry=path.join(root,'server/index.mjs'),assets_index=path.join(root,'dist/index.html');
  if(!fs.existsSync(entry))throw new PinError('release_incomplete','Release is missing server/index.mjs.',{release:root});
  if(!fs.existsSync(assets_index))throw new PinError('release_incomplete','Release is missing dist/index.html.',{release:root});
  return {release_id:manifest.release_id,manifest,physical_root:root,entry,assets_index,pointer,env:Object.freeze({ORBIT_RUNTIME_DIR:runtimeRoot,ORBIT_RELEASE_ROOT:root,ORBIT_RELEASE_ID:manifest.release_id,ORBIT_RELEASE_INTEGRITY:manifest.integrity})};
}

// A 200 from an arbitrary (possibly old) server is not proof. The probe must
// report the pinned release id and manifest integrity.
export async function probeReleaseIdentity({url,release_id,manifest_integrity,timeoutMs=5000,fetchImpl=globalThis.fetch}={}){
  if(!url)return {ok:false,skipped:true,reason:'probe_url_required'};
  const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),timeoutMs);
  try{
    const response=await fetchImpl(url,{signal:controller.signal,redirect:'error'});
    const body=await response.text();
    let parsed=null;try{parsed=JSON.parse(body);}catch{}
    const identity_match=parsed!==null&&parsed.release_id===release_id&&(parsed.manifest_integrity??parsed.integrity)===manifest_integrity;
    return {ok:response.status===200&&identity_match,status:response.status,identity_match,body:body.slice(0,2000)};
  }catch(error){
    return {ok:false,status:null,identity_match:false,error:error.name==='AbortError'?'timeout':'probe_failed'};
  }finally{clearTimeout(timer);}
}

function parseArgs(argv){
  const options={};
  for(let i=0;i<argv.length;i++){
    const arg=argv[i];
    if(arg==='--runtime')options.runtime=argv[++i];
    else if(arg==='--probe')options.probeUrl=argv[++i];
    else if(arg==='--start')options.start=true;
    else throw new PinError('invalid_request',`Unknown argument: ${arg}`);
  }
  return options;
}

// Start the verified physical entry with the verified environment. The operator
// controls the process; this never activates a release, and no credential value is
// logged. Signals are forwarded and the child's exit status is preserved.
export async function startRelease({runtime,probeUrl,spawnImpl=spawn,proc=process}={}){
  const launch=await resolveLaunch({runtime});
  if(probeUrl){
    const probe=await probeReleaseIdentity({url:probeUrl,release_id:launch.release_id,manifest_integrity:launch.manifest.integrity});
    if(probe.ok!==true)return {started:false,reason:'probe_failed',probe,release_id:launch.release_id};
  }
  const child=spawnImpl(proc.execPath,['--experimental-strip-types',launch.entry],{cwd:launch.physical_root,env:{...proc.env,...launch.env},stdio:'inherit'});
  const forwarded=[];
  for(const signal of ['SIGINT','SIGTERM','SIGHUP'])proc.on?.(signal,()=>{forwarded.push(signal);try{child.kill(signal);}catch{}});
  const result=await new Promise(resolve=>child.once('exit',(code,signal)=>resolve({code:Number.isInteger(code)?code:(signal?1:0),signal})));
  return {started:true,release_id:launch.release_id,physical_root:launch.physical_root,exit_code:result.code,exit_signal:result.signal??null,forwarded_signals:forwarded};
}

async function main(){
  try{
    const options=parseArgs(process.argv.slice(2));
    if(!options.runtime)throw new PinError('invalid_request','--runtime is required');
    if(options.start){const result=await startRelease(options);console.log(JSON.stringify({ok:result.started!==false,...result}));if(result.started===false)process.exitCode=1;return;}
    const launch=await resolveLaunch(options);
    let probe=null;
    if(options.probeUrl)probe=await probeReleaseIdentity({url:options.probeUrl,release_id:launch.release_id,manifest_integrity:launch.manifest.integrity});
    console.log(JSON.stringify({ok:true,release_id:launch.release_id,physical_root:launch.physical_root,entry:launch.entry,assets_index:launch.assets_index,env:launch.env,probe}));
  }catch(error){
    console.log(JSON.stringify({ok:false,code:error.code??'unavailable',message:error.message}));
    process.exitCode=1;
  }
}

if(import.meta.url===pathToFileURL(process.argv[1]??'').href)main();
