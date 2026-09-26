#!/usr/bin/env node
// Guarded, isolated production build. The DEFAULT destination is a private scratch
// directory, never the checkout's served dist. An explicit --dest is allowed only
// when it cannot destroy the source tree, the source served dist or a configured
// protected root. Nothing is created before the guard passes.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {canonicalTarget,identityOf,rootsCollide} from './release_roots.mjs';

export const REPO_ROOT=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
export {canonicalTarget};

export class BuildGuardError extends Error{
  constructor(code,message,details={}){super(message);this.name='BuildGuardError';this.code=code;Object.assign(this,details);}
}

function splitRoots(value){return String(value??'').split(/[:,]/).map(entry=>entry.trim()).filter(Boolean);}
function scratchBase(env){return env.ORBIT_BUILD_SCRATCH!==undefined?env.ORBIT_BUILD_SCRATCH:(fs.existsSync('/tmp/opencode')?'/tmp/opencode':os.tmpdir());}

// Protected roots are explicit configuration plus the runtime/release environments
// the served system uses. The default build never needs them because it targets an
// isolated scratch directory; they defend explicit --dest use.
export function protectedRoots({protect=[],env=process.env}={}){
  const roots=[...protect,...splitRoots(env.ORBIT_PROTECTED_ROOTS)];
  for(const key of ['ORBIT_RELEASE_ROOT','ORBIT_SERVED_DIST','ORBIT_RUNTIME_DIR','ORBIT_BUILD_PROTECTED'])if(env[key])roots.push(env[key]);
  return [...new Set(roots.filter(root=>typeof root==='string'&&root.trim()!=='').map(root=>path.resolve(root)))];
}

export function resolveDestination({dest,env=process.env}={}){
  if(dest!==undefined&&dest!==null){
    if(typeof dest!=='string'||dest.trim()==='')throw new BuildGuardError('invalid_destination','Build destination must be an explicit nonempty path.',{dest});
    if(!path.isAbsolute(dest))throw new BuildGuardError('invalid_destination','Build destination must be an absolute path.',{dest});
    const absolute=path.resolve(dest);
    if(absolute===path.parse(absolute).root)throw new BuildGuardError('invalid_destination','Refusing to build into a filesystem root.',{dest:absolute});
    return absolute;
  }
  const base=scratchBase(env);
  if(typeof base!=='string'||base.trim()==='')throw new BuildGuardError('invalid_destination','Scratch base must be a nonempty path.',{scratch_base:base});
  if(!path.isAbsolute(base))throw new BuildGuardError('invalid_destination','Scratch base must be an absolute path.',{scratch_base:base});
  return path.join(path.resolve(base),`orbit-isolated-build-${randomUUID()}`);
}

function isScratchSource(canonicalSource,env){
  const base=canonicalTarget(scratchBase(env));
  return canonicalSource===base||canonicalSource.startsWith(base+path.sep);
}

// Validate without creating anything. The guard runs before mkdir/mkdtemp.
export function guardDestination({dest,source=REPO_ROOT,protect=[],env=process.env,allowSourceDist=false}={}){
  if(typeof source!=='string'||source.trim()==='')throw new BuildGuardError('invalid_source','Build source must be a nonempty path.',{source});
  if(!path.isAbsolute(source))throw new BuildGuardError('invalid_source','Build source must be an absolute path.',{source});
  const canonicalSource=canonicalTarget(source);
  const destination=resolveDestination({dest,env});
  const canonical_dest=canonicalTarget(destination);
  if(canonical_dest===path.parse(canonical_dest).root)throw new BuildGuardError('invalid_destination','Refusing to build into a filesystem root.',{dest:destination,canonical_dest});
  if(canonical_dest===canonicalSource)throw new BuildGuardError('source_root_destination','Refusing to build into the source root itself.',{dest:destination,source:canonicalSource});
  if(canonicalSource.startsWith(canonical_dest+path.sep))throw new BuildGuardError('source_ancestor_destination','Refusing to build into an ancestor of the source root.',{dest:destination,source:canonicalSource});
  const canonicalSourceDist=path.join(canonicalSource,'dist');
  const roots=protectedRoots({protect,env});
  const destIdentity=identityOf(destination)??identityOf(canonical_dest);
  for(const root of roots){
    const canonical_root=canonicalTarget(root);
    const rootIdentity=identityOf(root)??identityOf(canonical_root);
    const relation=rootsCollide(canonical_dest,canonical_root);
    const sameIdentity=destIdentity&&rootIdentity&&destIdentity.dev===rootIdentity.dev&&destIdentity.ino===rootIdentity.ino;
    if(relation||sameIdentity){
      throw new BuildGuardError('protected_destination',`Build destination ${destination} collides with protected root ${root}.`,{dest:destination,canonical_dest,protected_root:root,canonical_protected_root:canonical_root,relation:relation||'same_identity'});
    }
  }
  if(allowSourceDist){
    if(!isScratchSource(canonicalSource,env))throw new BuildGuardError('source_not_scratch','--allow-source-dist is only valid for a verified scratch source.',{source:canonicalSource,scratch_base:canonicalTarget(scratchBase(env))});
    if(!(canonical_dest===canonicalSourceDist||canonical_dest.startsWith(canonicalSourceDist+path.sep)))throw new BuildGuardError('unsupported_destination','--allow-source-dist only permits the source dist subdirectory.',{dest:canonical_dest,source_dist:canonicalSourceDist});
  }else{
    const relation=rootsCollide(canonical_dest,canonicalSource);
    if(relation)throw new BuildGuardError('protected_destination',`Build destination ${destination} is inside the source tree; the source dist is protected by default.`,{dest:destination,source:canonicalSource,relation});
  }
  return {destination,canonical_dest,canonical_source:canonicalSource,protected_roots:roots,allow_source_dist:allowSourceDist};
}

export function planBuild({dest,source=REPO_ROOT,protect=[],env=process.env,allowSourceDist=false}={}){
  const resolvedSource=path.resolve(source);
  if(!fs.existsSync(resolvedSource))throw new BuildGuardError('invalid_source','Build source does not exist.',{source:resolvedSource});
  const guarded=guardDestination({dest,source:resolvedSource,protect,env,allowSourceDist});
  return {...guarded,source:resolvedSource,typecheck:path.join(resolvedSource,'tsconfig.json'),vite:path.join(resolvedSource,'node_modules','.bin','vite'),tsc:path.join(resolvedSource,'node_modules','.bin','tsc')};
}

export function runBuild({dest,source=REPO_ROOT,protect=[],env=process.env,allowSourceDist=false,typecheck=true,dryRun=false,spawn=spawnSync,log=()=>{}}={}){
  const plan=planBuild({dest,source,protect,env,allowSourceDist});
  if(dryRun)return {...plan,dry_run:true,wrote:false};
  // Create only after the guard passed.
  fs.mkdirSync(plan.destination,{recursive:true,mode:0o700});
  if(typecheck){
    if(!fs.existsSync(plan.tsc))throw new BuildGuardError('unavailable','TypeScript compiler not found for isolated build.',{tsc:plan.tsc});
    log(`typecheck: ${plan.tsc} --noEmit -p ${plan.typecheck}`);
    const check=spawn(plan.tsc,['--noEmit','-p',plan.typecheck],{cwd:plan.source,env:{...process.env,...env},encoding:'utf8'});
    if(check.status!==0)throw new BuildGuardError('typecheck_failed',(check.stderr||check.stdout||'TypeScript check failed').slice(-4000),{status:check.status});
  }
  if(!fs.existsSync(plan.vite))throw new BuildGuardError('unavailable','Vite binary not found for isolated build.',{vite:plan.vite});
  log(`vite: ${plan.vite} build --outDir ${plan.destination} --emptyOutDir`);
  const build=spawn(plan.vite,['build','--outDir',plan.destination,'--emptyOutDir'],{cwd:plan.source,env:{...process.env,...env},encoding:'utf8'});
  if(build.status!==0)throw new BuildGuardError('build_failed',(build.stderr||build.stdout||'Vite build failed').slice(-4000),{status:build.status});
  if(!fs.existsSync(path.join(plan.destination,'index.html')))throw new BuildGuardError('build_incomplete','Isolated build produced no index.html.',{dest:plan.destination});
  return {...plan,wrote:true};
}

function value(argv,index,flag){
  if(index>=argv.length||argv[index]===undefined)throw new BuildGuardError('invalid_request',`${flag} requires a value.`,{flag});
  return argv[index];
}

function parseArgs(argv){
  const options={protect:[],typecheck:true,dryRun:false,json:false};
  for(let i=0;i<argv.length;i++){
    const arg=argv[i];
    if(arg==='--dest')options.dest=value(argv,++i,arg);
    else if(arg==='--source')options.source=value(argv,++i,arg);
    else if(arg==='--protect')options.protect.push(value(argv,++i,arg));
    else if(arg==='--no-typecheck')options.typecheck=false;
    else if(arg==='--allow-source-dist')options.allowSourceDist=true;
    else if(arg==='--dry-run')options.dryRun=true;
    else if(arg==='--json')options.json=true;
    else throw new BuildGuardError('invalid_request',`Unknown argument: ${arg}`);
  }
  return options;
}

function main(){
  try{
    const options=parseArgs(process.argv.slice(2));
    const result=runBuild({...options,log:options.json?()=>{}:message=>console.error(message)});
    console.log(JSON.stringify({ok:true,...result}));
  }catch(error){
    console.log(JSON.stringify({ok:false,code:error.code??'unavailable',message:error.message,...(error.relation?{relation:error.relation,protected_root:error.protected_root,source:error.source}:{})}));
    process.exitCode=1;
  }
}

if(import.meta.url===pathToFileURL(process.argv[1]??'').href)main();
