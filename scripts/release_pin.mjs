#!/usr/bin/env node
// Operator-controlled activation/rollback for exactly one complete release.
// Separated roots are validated before any write; a probe must present the pinned
// release identity to count as activated; failure restores the previous release.
// Artifact rollback is not a database downgrade.
import {fileURLToPath,pathToFileURL} from 'node:url';
import {PinError,checkCompatibility,currentSchemaVersion,pointerPath,probeReleaseIdentity,readPointer,resolveExternalDependencies,resolveLaunch,startRelease,verifyRelease,writePointerAtomic} from './release_launch.mjs';
import {assertAbsoluteRoot,assertSeparatedRoots,canonicalTarget} from './release_roots.mjs';

export {PinError,checkCompatibility,currentSchemaVersion,pointerPath,probeReleaseIdentity,readPointer,resolveExternalDependencies,resolveLaunch,startRelease,verifyRelease,writePointerAtomic};

function flattenPointer(pointer){
  if(!pointer)return null;
  return {version:pointer.version??1,release_id:pointer.release_id,release_path:pointer.release_path,manifest_integrity:pointer.manifest_integrity,schema_version:pointer.schema_version??null,activated_at:pointer.activated_at??null,previous:null};
}

async function runProbe({probe,healthcheckUrl,launch}){
  if(typeof probe==='function')return probe({release_id:launch.release_id,manifest_integrity:launch.pointer.manifest_integrity,physical_root:launch.physical_root,entry:launch.entry,env:launch.env});
  if(healthcheckUrl)return probeReleaseIdentity({url:healthcheckUrl,release_id:launch.release_id,manifest_integrity:launch.pointer.manifest_integrity});
  return {ok:null,skipped:true,unverified:true};
}
// A probe that throws or rejects is a failure, not an unhandled crash: the caller
// must restore the prior selection and report a typed probe_failed result.
async function probeSafely(args){
  try{return await runProbe(args);}
  catch(error){return {ok:false,threw:true,error:error?.message??'probe_threw'};}
}

export async function activate({runtime,release,probe,healthcheckUrl,now=Date.now(),nodeVersion=process.versions.node,open}={}){
  const runtimeRoot=assertAbsoluteRoot('runtime',runtime,{mustExist:true});
  const releaseRoot=assertAbsoluteRoot('release',release,{mustExist:true});
  const {manifest}=verifyRelease(releaseRoot);
  // Keep the ORIGINAL validated pointer for exact restoration; flatten only when
  // embedding it as the new pointer's previous link.
  const original=readPointer(runtimeRoot);
  const previous=flattenPointer(original);
  assertSeparatedRoots({runtime:runtimeRoot,release:releaseRoot,previous:previous?.release_path});
  const {schema_version}=await currentSchemaVersion(runtimeRoot,{open});
  checkCompatibility({manifest,schema_version,nodeVersion});
  // Re-activating the same physical release is idempotent: never replace previous
  // with itself and never lose a valid rollback target.
  const sameTarget=original&&original.release_id===manifest.release_id&&canonicalTarget(original.release_path)===releaseRoot&&original.manifest_integrity===manifest.integrity;
  if(sameTarget){
    let launch;
    try{launch=await resolveLaunch({runtime:runtimeRoot,open,nodeVersion});}
    catch(error){return {pointer_selected:true,runtime_activated:false,idempotent:true,reason:'launch_unavailable',error:error.code??'unavailable'};}
    const health=await probeSafely({probe,healthcheckUrl,launch});
    return {pointer_selected:true,runtime_activated:health.ok===true,idempotent:true,...(health.ok===false?{reason:'probe_failed',probe_threw:health.threw===true}:{}),health,launch:{release_id:launch.release_id,physical_root:launch.physical_root,entry:launch.entry,env:launch.env}};
  }
  const pointer={version:1,release_id:manifest.release_id,release_path:releaseRoot,manifest_integrity:manifest.integrity,schema_version,activated_at:now,previous};
  writePointerAtomic(runtimeRoot,pointer);
  let launch;
  try{launch=await resolveLaunch({runtime:runtimeRoot,open,nodeVersion});}
  catch(error){
    if(original)writePointerAtomic(runtimeRoot,original);else await removePointer(runtimeRoot);
    return {pointer_selected:false,runtime_activated:false,rolled_back:true,reason:'launch_unavailable',error:error.code??'unavailable'};
  }
  const health=await probeSafely({probe,healthcheckUrl,launch});
  if(health.ok===false){
    if(original)writePointerAtomic(runtimeRoot,original);else await removePointer(runtimeRoot);
    return {pointer_selected:false,runtime_activated:false,rolled_back:true,reason:'probe_failed',probe_threw:health.threw===true,health,launch:{release_id:launch.release_id,physical_root:launch.physical_root}};
  }
  return {pointer_selected:true,runtime_activated:health.ok===true,health,launch:{release_id:launch.release_id,physical_root:launch.physical_root,entry:launch.entry,env:launch.env}};
}

export async function rollback({runtime,probe,healthcheckUrl,now=Date.now(),nodeVersion=process.versions.node,open}={}){
  const runtimeRoot=assertAbsoluteRoot('runtime',runtime,{mustExist:true});
  const current=readPointer(runtimeRoot);
  if(!current)throw new PinError('no_active_release','No active release to roll back.');
  if(!current.previous)throw new PinError('no_previous_release','No previous release is retained.');
  const previousRoot=assertAbsoluteRoot('previous release',current.previous.release_path,{mustExist:true});
  assertSeparatedRoots({runtime:runtimeRoot,release:previousRoot});
  const {manifest}=verifyRelease(previousRoot);
  const {schema_version}=await currentSchemaVersion(runtimeRoot,{open});
  checkCompatibility({manifest,schema_version,nodeVersion});
  const restored={...flattenPointer(current.previous),activated_at:now,previous:flattenPointer(current)};
  writePointerAtomic(runtimeRoot,restored);
  let launch;
  try{launch=await resolveLaunch({runtime:runtimeRoot,open,nodeVersion});}
  catch(error){
    writePointerAtomic(runtimeRoot,current);
    return {rolled_back:false,reason:'launch_unavailable',error:error.code??'unavailable',pointer:current};
  }
  const health=await probeSafely({probe,healthcheckUrl,launch});
  if(health.ok===false){
    writePointerAtomic(runtimeRoot,current);
    return {rolled_back:false,reason:'probe_failed',probe_threw:health.threw===true,health,pointer:current};
  }
  return {rolled_back:true,health,launch:{release_id:launch.release_id,physical_root:launch.physical_root,entry:launch.entry,env:launch.env}};
}

async function removePointer(runtime){
  const {default:fs}=await import('node:fs');
  fs.rmSync(pointerPath(runtime),{force:true});
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
    if(options.action==='status'){const launch=await resolveLaunch(options);console.log(JSON.stringify({ok:true,release_id:launch.release_id,physical_root:launch.physical_root,entry:launch.entry,env:launch.env}));return;}
    throw new PinError('invalid_request','Usage: release_pin.mjs activate|rollback|status --runtime DIR [--release DIR] [--healthcheck URL]');
  }catch(error){
    console.log(JSON.stringify({ok:false,code:error.code??'unavailable',message:error.message}));
    process.exitCode=1;
  }
}

if(import.meta.url===pathToFileURL(process.argv[1]??'').href)main();
