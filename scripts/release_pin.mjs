#!/usr/bin/env node
// Operator-controlled activation/rollback for one complete release. Resolves a
// single release (server + assets + plugin + contracts), never mixes modules and
// assets across an active-pointer change, and keeps the previous release.
// Runtime data lives outside every release. Artifact rollback is NOT a database
// downgrade: incompatible schema is refused and points at the matching backup.
import fs from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {readManifest,verifyManifest} from './release_manifest.mjs';

export const REPO_ROOT=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
export const POINTER_NAME='active-release.json';

export class PinError extends Error{
  constructor(code,message,details={}){super(message);this.name='PinError';this.code=code;Object.assign(this,details);}
}

export function pointerPath(runtime){return path.join(path.resolve(runtime),POINTER_NAME);}

export function readPointer(runtime){
  const target=pointerPath(runtime);
  if(!fs.existsSync(target))return null;
  try{return JSON.parse(fs.readFileSync(target,'utf8'));}catch{throw new PinError('pointer_malformed','Active release pointer is not valid JSON.',{pointer:target});}
}

export function writePointerAtomic(runtime,pointer){
  const directory=path.resolve(runtime);
  if(!fs.existsSync(directory))throw new PinError('runtime_missing','Runtime directory must already exist.',{runtime:directory});
  const target=pointerPath(directory),temporary=path.join(directory,`.${POINTER_NAME}.${randomUUID()}.tmp`);
  fs.writeFileSync(temporary,`${JSON.stringify(pointer,null,2)}\n`,{mode:0o600,flag:'wx'});
  fs.renameSync(temporary,target);
  return target;
}

export function currentSchemaVersion(runtime,{open=defaultOpen}={}){
  const database=path.join(path.resolve(runtime),'workspace.sqlite');
  if(!fs.existsSync(database))return {schema_version:null,database:null};
  try{
    const db=open(database);
    try{return {schema_version:db.pragma('user_version',{simple:true}),database};}finally{db.close();}
  }catch{throw new PinError('schema_unreadable','Runtime database could not be inspected read-only.',{database});}
}

async function defaultOpen(database){
  const {default:Database}=await import('better-sqlite3');
  return new Database(database,{readonly:true,fileMustExist:true});
}

function parseNodeRequirement(requirement){
  const match=/^>=\s*(\d+)(?:\.(\d+))?(?:\.(\d+))?/.exec(String(requirement??'').trim());
  return match?[Number(match[1]),Number(match[2]??0),Number(match[3]??0)]:null;
}

export function checkCompatibility({manifest,schema_version,nodeVersion=process.versions.node}={}){
  const required=parseNodeRequirement(manifest?.compat?.node);
  if(required){
    const current=nodeVersion.split('.').map(Number);
    for(let i=0;i<3;i++){
      if(current[i]>required[i])break;
      if(current[i]<required[i])throw new PinError('node_incompatible',`Release requires Node ${manifest.compat.node}; running ${nodeVersion}.`,{required:manifest.compat.node,node:nodeVersion});
    }
  }
  const {schema_min:min,schema_max:max}=manifest?.compat??{};
  if(schema_version!==null&&schema_version!==undefined){
    if(Number.isInteger(min)&&schema_version<min)throw new PinError('schema_upgrade_required',`Runtime schema ${schema_version} is older than the release minimum ${min}; back up and upgrade, never downgrade.`,{schema_version,schema_min:min});
    if(Number.isInteger(max)&&schema_version>max)throw new PinError('schema_downgrade_refused',`Runtime schema ${schema_version} is newer than release maximum ${max}; restoring an older binary requires the matching pre-upgrade backup.`,{schema_version,schema_max:max});
  }
  return true;
}

export async function healthcheck(url,{timeoutMs=5000,fetchImpl=globalThis.fetch}={}){
  if(!url)return {ok:true,skipped:true};
  const controller=new AbortController();
  const timer=setTimeout(()=>controller.abort(),timeoutMs);
  try{
    const response=await fetchImpl(url,{signal:controller.signal,redirect:'error'});
    const body=await response.text();
    let parsed=null;try{parsed=JSON.parse(body);}catch{}
    return {ok:response.status===200&&(!parsed||parsed.ok!==false),status:response.status,body:body.slice(0,2000)};
  }catch(error){
    return {ok:false,status:null,error:error.name==='AbortError'?'timeout':'healthcheck_failed'};
  }finally{clearTimeout(timer);}
}

export function verifyRelease(releaseDir){
  const root=path.resolve(releaseDir);
  if(!fs.existsSync(root))throw new PinError('release_missing','Release directory does not exist.',{release:root});
  const manifest=readManifest({root});
  const verified=verifyManifest({root,manifest});
  if(!verified.ok)throw new PinError('release_integrity_failed','Release manifest verification failed.',{release:root,errors:verified.errors});
  if(typeof manifest.release_id!=='string'||!manifest.release_id)throw new PinError('release_id_missing','Release manifest has no release id.',{release:root});
  return {root,manifest,verified};
}

export async function activate({runtime,release,healthcheckUrl,now=Date.now(),nodeVersion=process.versions.node,open,check=healthcheck}={}){
  const {root,manifest}=verifyRelease(release);
  const {schema_version}=await currentSchemaVersion(runtime,{open});
  checkCompatibility({manifest,schema_version,nodeVersion});
  const previous=readPointer(runtime);
  const pointer={version:1,release_id:manifest.release_id,release_path:root,manifest_integrity:manifest.integrity,schema_version,activated_at:now,previous};
  writePointerAtomic(runtime,pointer);
  const health=await check(healthcheckUrl);
  if(!health.ok){
    if(previous)writePointerAtomic(runtime,previous);else fs.rmSync(pointerPath(runtime),{force:true});
    return {activated:false,rolled_back:true,reason:'healthcheck_failed',health,pointer:previous};
  }
  return {activated:true,rolled_back:false,health,pointer};
}

export async function rollback({runtime,healthcheckUrl,now=Date.now(),nodeVersion=process.versions.node,open,check=healthcheck}={}){
  const current=readPointer(runtime);
  if(!current)throw new PinError('no_active_release','No active release to roll back.');
  if(!current.previous)throw new PinError('no_previous_release','No previous release is retained.');
  const {manifest}=verifyRelease(current.previous.release_path);
  const {schema_version}=await currentSchemaVersion(runtime,{open});
  checkCompatibility({manifest,schema_version,nodeVersion});
  const restored={...current.previous,activated_at:now,previous:current};
  writePointerAtomic(runtime,restored);
  const health=await check(healthcheckUrl);
  if(!health.ok){
    writePointerAtomic(runtime,current);
    return {rolled_back:false,reason:'healthcheck_failed',health,pointer:current};
  }
  return {rolled_back:true,health,pointer:restored};
}

function parseArgs(argv){
  const [action,...rest]=argv,options={};
  for(let i=0;i<rest.length;i++){
    const arg=rest[i];
    if(arg==='--runtime')options.runtime=rest[++i];
    else if(arg==='--release')options.release=rest[++i];
    else if(arg==='--healthcheck')options.healthcheckUrl=rest[++i];
    else throw new PinError('invalid_request',`Unknown argument: ${arg}`);
  }
  options.action=action;return options;
}

async function main(){
  try{
    const options=parseArgs(process.argv.slice(2));
    if(!options.runtime)throw new PinError('invalid_request','--runtime is required');
    if(options.action==='activate'){
      if(!options.release)throw new PinError('invalid_request','activate requires --release');
      console.log(JSON.stringify({ok:true,...await activate(options)}));return;
    }
    if(options.action==='rollback'){console.log(JSON.stringify({ok:true,...await rollback(options)}));return;}
    if(options.action==='status'){console.log(JSON.stringify({ok:true,pointer:readPointer(options.runtime)}));return;}
    throw new PinError('invalid_request','Usage: release_pin.mjs activate|rollback|status --runtime DIR [--release DIR] [--healthcheck URL]');
  }catch(error){
    console.log(JSON.stringify({ok:false,code:error.code??'unavailable',message:error.message}));
    process.exitCode=1;
  }
}

if(import.meta.url===pathToFileURL(process.argv[1]??'').href)main();
