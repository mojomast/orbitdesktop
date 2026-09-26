#!/usr/bin/env node
// Versioned, integrity-checked release manifest. Covers served assets AND the
// required server/plugin/contracts content, not only index.html. Build is
// deterministic for tests via --created-at; verify recomputes every hash.
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {fileURLToPath,pathToFileURL} from 'node:url';

export const REPO_ROOT=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
export const MANIFEST_NAME='.orbit-release-manifest.json';
export const MANIFEST_VERSION=1;
export const DEFAULT_EXCLUDE=Object.freeze(['.git','node_modules','.runtime','active-release.json',MANIFEST_NAME]);
export const REQUIRED_COMPONENTS=Object.freeze({
  server:['server/index.mjs'],
  contracts:['contracts/workspace-v1.mjs','contracts/workbench-v1.mjs','contracts/workbench-result-v1.mjs'],
  served:['dist/index.html'],
  plugin:['hermes-plugin/workbench.py'],
  metadata:['package.json'],
});

export class ManifestError extends Error{
  constructor(code,message,details={}){super(message);this.name='ManifestError';this.code=code;Object.assign(this,details);}
}

const sha256=value=>createHash('sha256').update(value).digest('hex');
const canonical=value=>JSON.stringify(value,Object.keys(value).sort());

function walk(root,{exclude=DEFAULT_EXCLUDE}={}){
  const excluded=new Set(exclude);
  const files=[];
  const visit=(relative)=>{
    const absolute=path.join(root,relative);
    const stat=fs.lstatSync(absolute);
    if(stat.isSymbolicLink())throw new ManifestError('symlink_not_allowed',`Release content must be ordinary files: ${relative}`,{path:relative});
    if(stat.isDirectory()){
      for(const entry of fs.readdirSync(absolute).sort())if(!excluded.has(entry))visit(path.posix.join(relative,entry));
      return;
    }
    if(!stat.isFile())throw new ManifestError('special_file_not_allowed',`Unsupported release entry: ${relative}`,{path:relative});
    files.push({path:relative.replaceAll('\\','/'),bytes:stat.size,mode:(stat.mode&0o777).toString(8),sha256:sha256(fs.readFileSync(absolute))});
  };
  for(const entry of fs.readdirSync(root).sort())if(!excluded.has(entry))visit(entry);
  return files;
}

export function buildManifest({root,release_id,compat={},exclude=DEFAULT_EXCLUDE,created_at=Date.now()}={}){
  const absolute=path.resolve(root);
  if(!fs.existsSync(absolute)||!fs.statSync(absolute).isDirectory())throw new ManifestError('invalid_root','Release root must be an existing directory.',{root:absolute});
  if(typeof release_id!=='string'||release_id.trim()==='')throw new ManifestError('invalid_request','A nonempty release id is required.');
  const files=walk(absolute,{exclude});
  const present=new Set(files.map(file=>file.path));
  const missing=[];
  for(const [group,entries] of Object.entries(REQUIRED_COMPONENTS))for(const entry of entries)if(!present.has(entry))missing.push({group,path:entry});
  if(missing.length)throw new ManifestError('missing_required_component','Release manifest is missing required content.',{missing});
  const manifest={version:MANIFEST_VERSION,release_id,created_at,compat:{node:compat.node??'>=22.12',schema_min:compat.schema_min??null,schema_max:compat.schema_max??null,hermes_commit:compat.hermes_commit??null},files};
  manifest.integrity=sha256(canonical(manifest));
  return manifest;
}

export function writeManifest({root,manifest}){const target=path.join(path.resolve(root),MANIFEST_NAME);fs.writeFileSync(target,`${JSON.stringify(manifest,null,2)}\n`,{mode:0o644});return target;}

export function readManifest({root,manifestPath}={}){
  const target=manifestPath?path.resolve(manifestPath):path.join(path.resolve(root),MANIFEST_NAME);
  if(!fs.existsSync(target))throw new ManifestError('manifest_missing','Release manifest not found.',{manifest:target});
  let manifest;
  try{manifest=JSON.parse(fs.readFileSync(target,'utf8'));}catch{throw new ManifestError('manifest_malformed','Release manifest is not valid JSON.',{manifest:target});}
  return manifest;
}

export function verifyManifest({root,manifest}){
  const absolute=path.resolve(root),errors=[];
  if(!manifest||manifest.version!==MANIFEST_VERSION)errors.push({code:'manifest_version',detail:manifest?.version??null});
  if(typeof manifest?.release_id!=='string'||!manifest.release_id)errors.push({code:'release_id'});
  const expected={...manifest};delete expected.integrity;
  if(manifest?.integrity!==sha256(canonical(expected)))errors.push({code:'integrity'});
  for(const file of manifest?.files??[]){
    const target=path.join(absolute,file.path);
    if(!fs.existsSync(target)){errors.push({code:'missing_file',path:file.path});continue;}
    const stat=fs.lstatSync(target);
    if(!stat.isFile()||stat.isSymbolicLink()){errors.push({code:'not_regular_file',path:file.path});continue;}
    if(stat.size!==file.bytes)errors.push({code:'size_mismatch',path:file.path});
    if(sha256(fs.readFileSync(target))!==file.sha256)errors.push({code:'hash_mismatch',path:file.path});
  }
  return {ok:errors.length===0,errors,release_id:manifest?.release_id??null};
}

function parseArgs(argv){
  const [action,...rest]=argv,options={compat:{},exclude:[...DEFAULT_EXCLUDE]};
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
    else if(arg==='--created-at')options.created_at=Number(rest[++i]);
    else if(arg==='--exclude')options.exclude.push(rest[++i]);
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
      console.log(JSON.stringify({ok:true,manifest:target,release_id:manifest.release_id,files:manifest.files.length,integrity:manifest.integrity}));
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
