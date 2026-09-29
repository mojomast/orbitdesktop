import fs from 'node:fs';
import path from 'node:path';
import {wbError} from './workbench-store.mjs';

// Narrow TypeScript test lane. Downloads are an operator provisioning action;
// preparation itself remains offline, using a dedicated host-configured cache.
export function registryTypeScriptProfile(pkg,lock){
  const unsupported=reason=>{throw Object.assign(wbError('unsupported'),{reason});};
  if(pkg.scripts?.test!=='tsx --test "test/**/*.test.ts"')unsupported('typescript_test_command_unsupported');
  if(Object.keys(pkg.dependencies??{}).length||pkg.workspaces||pkg.optionalDependencies||pkg.peerDependencies||pkg.overrides||pkg.bundleDependencies||pkg.bundledDependencies)unsupported('typescript_dependency_shape_unsupported');
  const names=Object.keys(pkg.devDependencies??{}).sort();
  if(JSON.stringify(names)!==JSON.stringify(['@types/node','tsx','typescript']))unsupported('typescript_toolchain_dependencies_required');
  if(JSON.stringify(lock.packages?.['']?.devDependencies)!==JSON.stringify(pkg.devDependencies))unsupported('development_lock_mismatch');
  const artifacts=[];
  for(const [name,info] of Object.entries(lock.packages??{})){
    if(!name)continue;
    if(!/^node_modules\/(?:@[A-Za-z0-9_.-]+\/)?[A-Za-z0-9_.-]+$/.test(name)||!info||info.link||!/^sha512-[A-Za-z0-9+/]{86}==$/.test(info.integrity??''))unsupported('registry_lock_entry_unsupported');
    let url;try{url=new URL(info.resolved);}catch{unsupported('registry_url_unsupported');}
    if(url.origin!=='https://registry.npmjs.org'||url.username||url.password||url.search||url.hash||!url.pathname.endsWith('.tgz')||info.resolved!==url.href)unsupported('registry_url_unsupported');
    artifacts.push({name,resolved:info.resolved,integrity:info.integrity});
  }
  if(!artifacts.length||artifacts.length>128)unsupported('registry_artifact_limit');
  return {kind:'locked-typescript-cache-v1',artifacts,test_runtime:'tsx',development_dependencies:true};
}

export function privateCacheRoot(root){
  let stat;
  try{
    if(typeof root!=='string'||!path.isAbsolute(root)||fs.realpathSync(root)!==root)throw Error('invalid cache');
    stat=fs.lstatSync(root);
  }catch{throw Object.assign(wbError('unsupported'),{reason:'dedicated_npm_cache_required'});}
  if(!stat.isDirectory()||stat.uid!==process.getuid()||(stat.mode&0o077)!==0)throw Object.assign(wbError('unsupported'),{reason:'private_npm_cache_required'});
  return root;
}
