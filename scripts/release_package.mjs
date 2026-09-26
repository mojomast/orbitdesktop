#!/usr/bin/env node
// Versioned release packaging. Assembles a clean immutable root from an explicit
// git-tracked source allowlist plus a built dist — never by walking an arbitrary
// checkout (so credentials/tests/experiments are not copied by accident). Node
// dependencies are referenced read-only from outside and bound by lock hash and
// Node ABI/version rather than pretending the release vendors them.
import fs from 'node:fs';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {buildManifest,writeManifest,verifyManifest,MANIFEST_NAME} from './release_manifest.mjs';
import {assertAbsoluteRoot,rootsCollide} from './release_roots.mjs';

export const REPO_ROOT=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
export const PACKAGE_VERSION=1;
export const RELEASE_DIRS=Object.freeze(['server','contracts','src','scripts','public','hermes-plugin','docs']);
export const RELEASE_FILES=Object.freeze(['index.html','package.json','package-lock.json','tsconfig.json','vite.config.js','AGENTS.md']);
const EXCLUDE=Object.freeze(['server/mobile-proxy.mjs','hermes-plugin/orbit-source.tar.gz']);
const SECRET=/^(?:.*\/)?\.env(?:\..*)?$|\.(?:pem|key|p12|pfx)$/;
const sha256=value=>createHash('sha256').update(value).digest('hex');

function candidateFiles(sourceRoot){
  // Tracked plus untracked-but-not-ignored, so a not-yet-committed runtime module
  // (e.g. a new server guard) is packaged once it lives under the allowlist. The
  // directory allowlist and the secret filter below are the safety boundary: this
  // never walks an arbitrary checkout.
  return execFileSync('/usr/bin/git',['-C',sourceRoot,'ls-files','-co','--exclude-standard','-z'],{encoding:'utf8',env:{PATH:'/usr/bin:/bin'}}).split('\0').filter(Boolean);
}
function allowed(relative){
  if(EXCLUDE.includes(relative))return false;
  if(relative.startsWith('docs/images/'))return false;
  if(SECRET.test(relative))return false;
  if(RELEASE_FILES.includes(relative))return true;
  return RELEASE_DIRS.some(dir=>relative.startsWith(dir+'/'));
}

export function releaseInputs({sourceRoot=REPO_ROOT}={}){
  return candidateFiles(sourceRoot).filter(allowed).sort();
}

function copyFile(sourceRoot,relative,root){
  const source=path.join(sourceRoot,relative);
  if(!fs.existsSync(source))return false;
  if(fs.lstatSync(source).isSymbolicLink()||!fs.lstatSync(source).isFile())throw Error(`Release input must be an ordinary file: ${relative}`);
  const target=path.join(root,relative);fs.mkdirSync(path.dirname(target),{recursive:true});
  fs.copyFileSync(source,target);return true;
}
function copyTree(source,root,prefix){
  for(const entry of fs.readdirSync(source)){const absolute=path.join(source,entry),relative=path.join(prefix,entry);
    if(fs.lstatSync(absolute).isDirectory())copyTree(absolute,root,relative);
    else if(fs.lstatSync(absolute).isFile()){const target=path.join(root,relative);fs.mkdirSync(path.dirname(target),{recursive:true});fs.copyFileSync(absolute,target);}
  }
}
function setReadOnly(root){
  for(const entry of fs.readdirSync(root,{withFileTypes:true})){
    const absolute=path.join(root,entry.name);
    if(entry.isDirectory()){setReadOnly(absolute);fs.chmodSync(absolute,0o555);}
    else fs.chmodSync(absolute,0o444);
  }
}
export function unlockRelease(root){
  if(!fs.existsSync(root))return;
  for(const entry of fs.readdirSync(root,{withFileTypes:true})){
    const absolute=path.join(root,entry.name);
    fs.chmodSync(absolute,entry.isDirectory()?0o755:0o644);
    if(entry.isDirectory())unlockRelease(absolute);
  }
  fs.chmodSync(root,0o755);
}

export function packageRelease({sourceRoot=REPO_ROOT,distRoot,outRoot,release_id,compat={},revision=null,external=null,readOnly=true,now=Date.now()}={}){
  const source=assertAbsoluteRoot('source',sourceRoot,{mustExist:true});
  const root=assertAbsoluteRoot('outRoot',outRoot);
  if(rootsCollide(root,source))throw Error('Release output must be separated from the source root.');
  if(!distRoot||!fs.existsSync(path.join(distRoot,'index.html')))throw Error('distRoot must contain index.html.');
  if(fs.existsSync(root)){if(fs.readdirSync(root).length)throw Error('Release output directory must not already exist or must be empty.');}else fs.mkdirSync(root,{recursive:true,mode:0o700});
  const inputs=releaseInputs({sourceRoot:source});
  let copied=0;
  for(const relative of inputs)if(copyFile(source,relative,root))copied++;
  copyTree(distRoot,root,'dist');
  if(readOnly)setReadOnly(root);
  let resolvedExternal=null;
  if(external)resolvedExternal={...external,lockfile_hash:sha256(fs.readFileSync(path.join(root,'package-lock.json')))};
  const manifest=buildManifest({root,release_id,compat,revision,external:resolvedExternal,created_at:now});
  writeManifest({root,manifest});
  if(readOnly)fs.chmodSync(path.join(root,MANIFEST_NAME),0o444);
  const verified=verifyManifest({root,manifest});
  if(!verified.ok)throw Error(`Packaged release failed verification: ${JSON.stringify(verified.errors)}`);
  return {root,manifest,file_count:manifest.files.length,inputs:inputs.length,copied,package_version:PACKAGE_VERSION};
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
    else throw Error(`Unknown argument: ${arg}`);
  }
  options.action=action;return options;
}

function main(){
  try{
    const options=parseArgs(process.argv.slice(2));
    if(options.action!=='build')throw Error('Usage: release_package.mjs build --source DIR --dist DIR --out DIR --id ID [--external-*] [--writable]');
    const result=packageRelease({...options});
    console.log(JSON.stringify({ok:true,root:result.root,release_id:result.manifest.release_id,file_count:result.file_count,copied:result.copied,integrity:result.manifest.integrity,build_id:result.manifest.source.build_id}));
  }catch(error){
    console.log(JSON.stringify({ok:false,code:error.code??'unavailable',message:error.message}));
    process.exitCode=1;
  }
}

if(import.meta.url===pathToFileURL(process.argv[1]??'').href)main();
