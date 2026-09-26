#!/usr/bin/env node
// Guarded, isolated production build. The DEFAULT destination is a private scratch
// directory, never the checkout's served `dist/`. An explicit --dest is allowed but
// must not collide with a configured protected release/served root.
//
// No caller-supplied destination may alias, be an ancestor of, contain, or share the
// identity of a protected root, because an empty-out build would otherwise destroy a
// served release. This is a structural guard, not a claim of sandboxing against
// same-UID/root writers.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {fileURLToPath,pathToFileURL} from 'node:url';

export const REPO_ROOT=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');

export class BuildGuardError extends Error{
  constructor(code,message,details={}){super(message);this.name='BuildGuardError';this.code=code;Object.assign(this,details);}
}

// Resolve a path to its canonical form even when the leaf does not exist yet:
// resolve symlinks in the deepest existing ancestor, then re-append the rest.
export function canonicalTarget(target){
  const absolute=path.resolve(target);
  const tail=[];
  let cursor=absolute;
  while(!fs.existsSync(cursor)){
    const parent=path.dirname(cursor);
    if(parent===cursor)break;
    tail.unshift(path.basename(cursor));
    cursor=parent;
  }
  let resolved;
  try{resolved=fs.realpathSync.native(cursor);}catch{resolved=cursor;}
  return tail.length?path.join(resolved,...tail):resolved;
}

function identity(target){
  try{const stat=fs.statSync(target);return {dev:stat.dev,ino:stat.ino};}catch{return null;}
}

function splitRoots(value){
  return String(value??'').split(/[:,]/).map(entry=>entry.trim()).filter(Boolean);
}

// Protected roots are explicit configuration. The default build never needs them
// because it targets an isolated scratch directory; they defend explicit --dest use.
export function protectedRoots({protect=[],env=process.env}={}){
  const roots=[...protect,...splitRoots(env.ORBIT_PROTECTED_ROOTS)];
  if(env.ORBIT_RELEASE_ROOT)roots.push(env.ORBIT_RELEASE_ROOT);
  if(env.ORBIT_SERVED_DIST)roots.push(env.ORBIT_SERVED_DIST);
  return [...new Set(roots.map(root=>path.resolve(root)))];
}

export function resolveDestination({dest,protect=[],env=process.env,dryRun=false}={}){
  if(dest!==undefined&&dest!==null){
    if(typeof dest!=='string'||dest.trim()==='')throw new BuildGuardError('invalid_destination','Build destination must be an explicit nonempty path.');
    if(!path.isAbsolute(dest))throw new BuildGuardError('invalid_destination','Build destination must be an absolute path.',{dest});
    const absolute=path.resolve(dest);
    if(absolute===path.parse(absolute).root)throw new BuildGuardError('invalid_destination','Refusing to build into a filesystem root.',{dest:absolute});
    return absolute;
  }
  const base=env.ORBIT_BUILD_SCRATCH||(fs.existsSync('/tmp/opencode')?'/tmp/opencode':os.tmpdir());
  if(dryRun)return path.join(base,`orbit-isolated-build-${randomUUID()}`);
  fs.mkdirSync(base,{recursive:true,mode:0o700});
  return fs.mkdtempSync(path.join(base,'orbit-isolated-build-'));
}

export function guardDestination({dest,protect=[],env=process.env,dryRun=false}={}){
  const destination=resolveDestination({dest,protect,env,dryRun});
  const canonical_dest=canonicalTarget(destination);
  if(canonical_dest===path.parse(canonical_dest).root)throw new BuildGuardError('invalid_destination','Refusing to build into a filesystem root.',{dest:destination,canonical_dest});
  const roots=protectedRoots({protect,env});
  const destIdentity=identity(destination)??identity(canonical_dest);
  for(const root of roots){
    const canonical_root=canonicalTarget(root);
    const rootIdentity=identity(root)??identity(canonical_root);
    const insideDest=canonical_root===canonical_dest||canonical_root.startsWith(canonical_dest+path.sep);
    const insideRoot=canonical_dest.startsWith(canonical_root+path.sep);
    const sameIdentity=destIdentity&&rootIdentity&&destIdentity.dev===rootIdentity.dev&&destIdentity.ino===rootIdentity.ino;
    if(insideDest||insideRoot||sameIdentity){
      throw new BuildGuardError('protected_destination',`Build destination ${destination} collides with protected root ${root}.`,{dest:destination,canonical_dest,protected_root:root,canonical_protected_root:canonical_root,relation:insideDest?'contains_protected_root':insideRoot?'inside_protected_root':'same_identity'});
    }
  }
  return {destination,canonical_dest,protected_roots:roots};
}

export function planBuild({dest,source=REPO_ROOT,protect=[],env=process.env,dryRun=false}={}){
  const resolvedSource=path.resolve(source);
  if(!fs.existsSync(resolvedSource))throw new BuildGuardError('invalid_source','Build source does not exist.',{source:resolvedSource});
  const guarded=guardDestination({dest,protect,env,dryRun});
  return {...guarded,source:resolvedSource,typecheck:path.join(resolvedSource,'tsconfig.json'),vite:path.join(resolvedSource,'node_modules','.bin','vite'),tsc:path.join(resolvedSource,'node_modules','.bin','tsc')};
}

export function runBuild({dest,source=REPO_ROOT,protect=[],env=process.env,typecheck=true,dryRun=false,spawn=spawnSync,log=()=>{}}={}){
  const plan=planBuild({dest,source,protect,env,dryRun});
  if(dryRun)return {...plan,dry_run:true,wrote:false};
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

function parseArgs(argv){
  const options={protect:[],typecheck:true,dryRun:false,json:false};
  for(let i=0;i<argv.length;i++){
    const arg=argv[i];
    if(arg==='--dest')options.dest=argv[++i];
    else if(arg==='--source')options.source=argv[++i];
    else if(arg==='--protect')options.protect.push(argv[++i]);
    else if(arg==='--no-typecheck')options.typecheck=false;
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
    console.log(JSON.stringify({ok:false,code:error.code??'unavailable',message:error.message,...(error.relation?{relation:error.relation,protected_root:error.protected_root}:{})}));
    process.exitCode=1;
  }
}

if(import.meta.url===pathToFileURL(process.argv[1]??'').href)main();
