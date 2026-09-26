import fs from 'node:fs';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {spawn} from 'node:child_process';
import Ajv from 'ajv';
import {wbError} from './workbench-store.mjs';
import {captureProject,openProjectRoot,readProjectFile} from './project-files.mjs';

const uuid={type:'string',pattern:'^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$'};
const hex={type:'string',pattern:'^[a-f0-9]{64}$'};
const base={action:{type:'string'},workspace_id:uuid,project_id:uuid};
const strict=(properties,required=Object.keys(properties))=>({type:'object',properties,required,additionalProperties:false});
export const environmentRequests=Object.freeze({
  profile_preview:strict({...base,action:{const:'profile_preview'},candidate_id:uuid,required_inputs:{type:'array',minItems:2,maxItems:128,uniqueItems:true,items:{type:'string',minLength:1,maxLength:512}}}),
  profile_approve:strict({...base,action:{const:'profile_approve'},preview_id:uuid,preview_digest:hex}),
  environment_prepare:strict({...base,action:{const:'environment_prepare'},profile_id:uuid}),
  environment_status:strict({...base,action:{const:'environment_status'},profile_id:uuid}),
});
export const environmentSchema=Object.freeze({$schema:'http://json-schema.org/draft-07/schema#',title:'Workbench offline Node environments v1',oneOf:Object.values(environmentRequests)});
const validate=new Ajv({strict:true}).compile(environmentSchema);
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const digest=value=>hash(JSON.stringify(value));
const safe=p=>typeof p==='string'&&p.length<=512&&!p.includes('\\')&&!p.includes('\0')&&p.split('/').every(part=>part&&part!=='.'&&part!=='..'&&part!=='.git'&&part!=='node_modules'&&!part.startsWith('.env'))&&!path.isAbsolute(p);
const validFile=(root,relative,expected)=>{
  if(!safe(relative))throw wbError('unsupported');
  const opened=openProjectRoot(root);
  let bytes;
  try{bytes=readProjectFile({root,identity:opened.identity},relative).bytes;}finally{opened.close();}
  if(bytes.length!==expected.bytes)throw wbError('stale_resource');
  if(hash(bytes)!==expected.hash)throw wbError('stale_resource');
  return bytes;
};
const stable=value=>Array.isArray(value)?`[${value.map(stable).join(',')}]`:value&&typeof value==='object'?`{${Object.keys(value).sort().map(key=>`${JSON.stringify(key)}:${stable(value[key])}`).join(',')}}`:JSON.stringify(value);
function fullCandidate(candidate){
  const root=openProjectRoot(candidate.root),capture=(()=>{try{return captureProject({root:candidate.root,identity:root.identity});}finally{root.close();}})();
  const files=capture.files.map(f=>({path:f.path,hash:f.hash,bytes:f.bytes.length}));
  if(capture.limited||files.length!==candidate.files.length||files.some(f=>!candidate.files.some(item=>item.path===f.path&&item.hash===f.hash&&item.bytes===f.bytes))||stable(capture.exclusions)!==stable(candidate.exclusions))throw wbError('stale_resource');
  const identity={version:1,generation:candidate.generation,base_hash:candidate.base_hash,files:files.sort((a,b)=>a.path<b.path?-1:a.path>b.path?1:0),exclusions:[...capture.exclusions].sort((a,b)=>a.path<b.path?-1:a.path>b.path?1:a.reason<b.reason?-1:a.reason>b.reason?1:0),limited:capture.limited};
  if(hash(stable(identity))!==candidate.hash)throw wbError('stale_resource');
}
function toolchain(){
  const node=fs.realpathSync(process.execPath);
  const npm=path.resolve(path.dirname(node),'../lib/node_modules/npm/bin/npm-cli.js');
  const cli=fs.realpathSync(npm);
  if(!path.isAbsolute(cli)||!fs.statSync(cli).isFile())throw wbError('unavailable');
  const packagePath=path.resolve(path.dirname(cli),'../package.json');
  const version=JSON.parse(fs.readFileSync(packagePath,'utf8')).version;
  return {node,npm:cli,version,hash:digest([node,hash(fs.readFileSync(node)),cli,hash(fs.readFileSync(cli)),version])};
}
function inspect(candidate,inputs){
  if(candidate.status!=='approved'||candidate.limited||!Array.isArray(candidate.exclusions)||candidate.exclusions.some(e=>e.path!=='.git'||e.reason!=='excluded_by_policy'))throw wbError('unsupported');
  fullCandidate(candidate);
  const entries=new Map(candidate.files.map(f=>[f.path,f]));
  if(entries.size!==candidate.files.length||!inputs.includes('package.json')||!inputs.includes('package-lock.json')||inputs.some(p=>!safe(p)||!entries.has(p)))throw wbError('invalid_request');
  // npm is only given the named input tree. All other candidate files remain out
  // of the dependency install directory; the whole candidate hash still binds approval.
  const selected=inputs.map(p=>entries.get(p)).sort((a,b)=>a.path.localeCompare(b.path));
  const packageBytes=validFile(candidate.root,'package.json',entries.get('package.json'));
  const lockBytes=validFile(candidate.root,'package-lock.json',entries.get('package-lock.json'));
  let pkg,lock;
  try{pkg=JSON.parse(packageBytes);lock=JSON.parse(lockBytes);}catch{throw wbError('invalid_request');}
  if(!pkg||!lock||lock.lockfileVersion!==3||!lock.packages||!lock.packages['']||!pkg.name||lock.packages[''].name!==pkg.name||JSON.stringify(lock.packages[''].dependencies??{})!==JSON.stringify(pkg.dependencies??{})||pkg.scripts?.preinstall||pkg.scripts?.install||pkg.scripts?.postinstall)throw wbError('unsupported');
  if(pkg.workspaces||pkg.optionalDependencies||pkg.devDependencies||pkg.peerDependencies||pkg.overrides||pkg.bundleDependencies||pkg.bundledDependencies)throw wbError('unsupported');
  const required=new Set(['package.json','package-lock.json']);
  for(const [name,info] of Object.entries(lock.packages)){
    if(!name)continue;
    if(!name.startsWith('node_modules/')||!info||typeof info.resolved!=='string'||!info.resolved.startsWith('file:')||!/^sha512-[A-Za-z0-9+/]+={0,2}$/.test(info.integrity??''))throw wbError('unsupported');
    const relative=decodeURIComponent(info.resolved.slice(5));
    if(!safe(relative)||!relative.endsWith('.tgz')||!entries.has(relative))throw wbError('unsupported');
    required.add(relative);
  }
  if(inputs.length!==required.size||inputs.some(p=>!required.has(p)))throw wbError('unsupported');
  for(const item of selected)validFile(candidate.root,item.path,item);
  return {selected,lock_hash:hash(lockBytes),source_hash:candidate.hash};
}
function traverse(root,copyTo,{rejectBins=false}={}){
  const files=[];let nodes=0,total=0;
  const base=openProjectRoot(root);
  function walk(fd,relative,depth){
    if(depth>16)throw wbError('limit_exceeded');
    const names=fs.readdirSync(`/proc/self/fd/${fd}`).sort();
    if(names.length+nodes>8192)throw wbError('limit_exceeded');
    for(const name of names){
      if(name==='.bin'){if(rejectBins)throw wbError('stale_resource');continue;}
      if(!name||name==='.'||name==='..'||name.includes('/')||name.includes('\\')||name.includes('\0'))throw wbError('unsupported');
      const key=relative?`${relative}/${name}`:name;
      const item=fs.openSync(`/proc/self/fd/${fd}/${name}`,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW|fs.constants.O_NONBLOCK);
      try{
        const before=fs.fstatSync(item);if(before.dev!==base.dev||++nodes>8192)throw wbError('limit_exceeded');
        if(before.isDirectory()){
          if(copyTo)fs.mkdirSync(path.join(copyTo,key),{mode:0o700});
          walk(item,key,depth+1);
        }else if(before.isFile()&&before.nlink===1){
          if(before.size>4*1024*1024||total+before.size>64*1024*1024)throw wbError('limit_exceeded');
          const bytes=Buffer.alloc(before.size);let offset=0;
          while(offset<bytes.length){const count=fs.readSync(item,bytes,offset,bytes.length-offset,offset);if(!count)throw wbError('stale_resource');offset+=count;}
          const after=fs.fstatSync(item);
          if(after.size!==before.size||after.mtimeMs!==before.mtimeMs||after.ctimeMs!==before.ctimeMs)throw wbError('stale_resource');
          total+=bytes.length;files.push([key,hash(bytes)]);
          if(copyTo)fs.writeFileSync(path.join(copyTo,key),bytes,{flag:'wx',mode:0o600});
        }else throw wbError('unsupported');
      }finally{fs.closeSync(item);}
    }
  }
  try{walk(base.fd,'',0);}finally{base.close();}
  return digest(files);
}
const treeHash=root=>traverse(root);
const runNpm=(node,npm,cwd,config)=>new Promise((resolve,reject)=>{
  const child=spawn('/usr/bin/timeout',['--kill-after=5s','60s',node,npm,'ci','--ignore-scripts','--offline','--no-audit','--no-fund','--omit=dev','--no-package-lock=false'],{
    cwd,stdio:['ignore','pipe','pipe'],env:{PATH:path.dirname(node),HOME:config,NPM_CONFIG_USERCONFIG:path.join(config,'userconfig'),NPM_CONFIG_GLOBALCONFIG:path.join(config,'globalconfig'),NPM_CONFIG_CACHE:path.join(config,'cache'),NPM_CONFIG_REGISTRY:'http://127.0.0.1:9/',NPM_CONFIG_OFFLINE:'true',NPM_CONFIG_IGNORE_SCRIPTS:'true',NPM_CONFIG_AUDIT:'false',NPM_CONFIG_FUND:'false'},detached:true,
  });
  let output='';
  for(const stream of [child.stdout,child.stderr])stream.on('data',chunk=>{output=(output+chunk.toString()).slice(-8192);});
  child.on('error',()=>reject(wbError('outcome_unknown')));
  child.on('close',(code,signal)=>{code===0?resolve():reject(Object.assign(wbError(code===124||code===137||signal?'outcome_unknown':'unavailable'),{detail:output.slice(-512)}));});
});

export function createWorkbenchEnvironments({store,records,data,now=Date.now,gate}={}){
  if(!path.isAbsolute(store?.root??'')||!records?.project||!data?.get||!data?.create||!data?.update||!data?.list)throw Error('Workbench environments require store, records and data');
  const root=path.join(store.root,'workbench-environments');
  fs.mkdirSync(root,{recursive:true,mode:0o700});
  const previews=new Map(),active=new Set();
  const scope=body=>{store.read?.(body.workspace_id);return records.project(body.workspace_id,body.project_id);};
  const profile=body=>data.get('profiles',body.workspace_id,body.project_id,body.profile_id);
  function current(body,p){
    const candidate=data.get('candidates',body.workspace_id,body.project_id,p.candidate_id);
    const observed=inspect(candidate,p.required_inputs);
    if(candidate.project_generation!==p.project_generation||observed.lock_hash!==p.lock_hash||toolchain().hash!==p.toolchain_hash||p.required_inputs.some(item=>observed.selected.find(file=>file.path===item)?.hash!==p.input_hashes[item]))throw wbError('stale_resource');
    return {candidate,observed};
  }
  async function dispatch(body){
    if(!validate(body))throw wbError('invalid_request');
    const project=scope(body);
    if(body.action==='profile_preview'){
      const candidate=data.get('candidates',body.workspace_id,body.project_id,body.candidate_id);
      if(candidate.project_generation!==project.generation)throw wbError('stale_resource');
      const observed=inspect(candidate,body.required_inputs),chain=toolchain();
      const spec={candidate_id:body.candidate_id,project_generation:project.generation,required_inputs:body.required_inputs.slice().sort(),input_hashes:Object.fromEntries(observed.selected.map(file=>[file.path,file.hash])),source_hash:observed.source_hash,source_selection_policy:'candidate_generation_may_change_if_dependency_inputs_remain_identical',lock_hash:observed.lock_hash,toolchain_hash:chain.hash,toolchain:{node:chain.node,npm:chain.npm,version:chain.version},network_policy:'offline_only',lifecycle_policy:'ignore_scripts',command:['/usr/bin/timeout','--kill-after=5s','60s',chain.node,chain.npm,'ci','--ignore-scripts','--offline','--no-audit','--no-fund','--omit=dev','--no-package-lock=false']};
      const preview_id=randomUUID(),preview_digest=digest(spec),expires_at=now()+60000;
      previews.set(preview_id,{...spec,preview_digest,expires_at,workspace_id:body.workspace_id,project_id:body.project_id});
      return {preview_id,preview_digest,expires_at,...spec};
    }
    if(body.action==='profile_approve'){
      const p=previews.get(body.preview_id);
      if(!p||p.expires_at<=now()||p.workspace_id!==body.workspace_id||p.project_id!==body.project_id)throw wbError('expired');
      if(p.preview_digest!==body.preview_digest)throw wbError('stale_resource');
      if(project.generation!==p.project_generation)throw wbError('stale_resource');
      current(body,p);previews.delete(body.preview_id);
      const {preview_digest,expires_at,...fields}=p;
      return data.create('profiles',{...fields,status:'approved',profile_version:1,approved_at:now()});
    }
    const p=profile(body);
    if(body.action==='environment_status')return p.project_generation===project.generation?p:{...p,status:'revoked',prepared:null};
    if(p.project_generation!==project.generation)throw wbError('stale_resource');
    if(p.status!=='approved'&&p.status!=='failed')throw wbError('busy');
    const {candidate,observed}=current(body,p);
    const release=gate?.claim?.('job',`environment:${p.id}`)??(()=>{});
    if(active.has(p.id)){release();throw wbError('busy');}active.add(p.id);
    let record,dir;
    try{
      // Persist intent before any child process. Interrupted preparations are not replayed.
      record=data.update('profiles',body.workspace_id,body.project_id,p.id,p.revision,{status:'preparing',started_at:now()});
      dir=path.join(root,randomUUID());fs.mkdirSync(dir,{mode:0o700});
      const source=path.join(dir,'source'),config=path.join(dir,'config');fs.mkdirSync(source,{mode:0o700});fs.mkdirSync(config,{mode:0o700});
      fs.writeFileSync(path.join(config,'userconfig'),'',{mode:0o600});fs.writeFileSync(path.join(config,'globalconfig'),'',{mode:0o600});
      for(const item of observed.selected){const destination=path.join(source,item.path);fs.mkdirSync(path.dirname(destination),{recursive:true,mode:0o700});fs.writeFileSync(destination,validFile(candidate.root,item.path,item),{flag:'wx',mode:0o600});}
      await runNpm(p.toolchain.node,p.toolchain.npm,source,config);
      if(scope(body).generation!==p.project_generation)throw wbError('stale_resource');
      current(body,p);
      const dependency_root=path.join(source,'node_modules');
      if(!fs.statSync(dependency_root).isDirectory())throw wbError('unavailable');
      const dependency_hash=treeHash(dependency_root);
      const prepared={dependency_root,dependency_hash,node_path:p.toolchain.node,lock_hash:p.lock_hash,toolchain_hash:p.toolchain_hash,profile_id:p.id,profile_version:p.profile_version,source_hash:candidate.hash,environment_identity:digest([p.id,p.lock_hash,p.toolchain_hash,dependency_hash,dir]),network_policy:p.network_policy,lifecycle_policy:p.lifecycle_policy};
      return data.update('profiles',body.workspace_id,body.project_id,p.id,record.revision,{status:'ready',prepared,finished_at:now()});
    }catch(error){if(record){try{data.update('profiles',body.workspace_id,body.project_id,p.id,record.revision,{status:error.code==='outcome_unknown'?'outcome_unknown':'failed',finished_at:now(),failure_code:error.code??'unavailable',private_artifact:dir});}catch{}}throw error;}
    finally{active.delete(p.id);release();}
  }
  function createExecutionView({workspace_id,project_id,profile_id,candidate_id}){
    const body={workspace_id,project_id,profile_id};const project=scope(body);
    const p=profile(body);
    if(p.status!=='ready'||p.candidate_id!==candidate_id||!p.prepared)throw wbError('unsupported');
    if(p.project_generation!==project.generation)throw wbError('stale_resource');
    const {candidate}=current(body,p);
    const rootDir=path.join(root,randomUUID()),source=path.join(rootDir,'source');
    fs.mkdirSync(rootDir,{mode:0o700});fs.mkdirSync(source,{mode:0o700});
    try{
      if(treeHash(p.prepared.dependency_root)!==p.prepared.dependency_hash)throw wbError('stale_resource');
      for(const item of candidate.files){const destination=path.join(source,item.path);fs.mkdirSync(path.dirname(destination),{recursive:true,mode:0o700});fs.writeFileSync(destination,validFile(candidate.root,item.path,item),{flag:'wx',mode:0o600});}
      fs.mkdirSync(path.join(source,'node_modules'),{mode:0o700});
      if(traverse(p.prepared.dependency_root,path.join(source,'node_modules'))!==p.prepared.dependency_hash)throw wbError('stale_resource');
      if(treeHash(path.join(source,'node_modules'))!==p.prepared.dependency_hash||treeHash(p.prepared.dependency_root)!==p.prepared.dependency_hash)throw wbError('stale_resource');
      if(scope(body).generation!==p.project_generation)throw wbError('stale_resource');
      current(body,p);
      const opened=openProjectRoot(source),sourceIdentity=opened.identity;opened.close();
      const prepared={...p.prepared,source_hash:candidate.hash,environment_identity:digest([p.prepared.environment_identity,candidate.hash])};
      const verify=()=>{
        if(scope(body).generation!==p.project_generation||current(body,p).candidate.hash!==candidate.hash)throw wbError('stale_resource');
        const capture=captureProject({root:source,identity:sourceIdentity});
        const observed=capture.files.map(file=>({path:file.path,hash:file.hash,bytes:file.bytes.length})).sort((a,b)=>a.path.localeCompare(b.path));
        const expected=candidate.files.map(({path,hash,bytes})=>({path,hash,bytes})).sort((a,b)=>a.path.localeCompare(b.path));
        if(capture.limited||stable(observed)!==stable(expected)||capture.exclusions.some(entry=>entry.path!=='node_modules'||entry.reason!=='excluded_by_policy'))throw wbError('stale_resource');
        const dependency_hash=traverse(path.join(source,'node_modules'),undefined,{rejectBins:true});
        if(dependency_hash!==prepared.dependency_hash||treeHash(p.prepared.dependency_root)!==prepared.dependency_hash)throw wbError('stale_resource');
        return {source_hash:candidate.hash,dependency_hash,environment_identity:prepared.environment_identity,output_hash:digest([]),allowed_outputs:[]};
      };
      verify();
      // Views remain private immutable artifacts for evidence/retention. No
      // generated source outputs are allowlisted by this profile version.
      return {root:source,prepared,verify,dispose:()=>{}};
    }catch(error){throw error;}
  }
  function verifyProfile({workspace_id,project_id,profile_id,candidate_id}){
    const body={workspace_id,project_id,profile_id},project=scope(body),p=profile(body);
    if(p.project_generation!==project.generation||p.status!=='ready'||!p.prepared||candidate_id&&p.candidate_id!==candidate_id)throw wbError('stale_resource');
    current(body,p);
    if(treeHash(p.prepared.dependency_root)!==p.prepared.dependency_hash)throw wbError('stale_resource');
    return {profile_id:p.id,profile_version:p.profile_version,project_generation:p.project_generation,lock_hash:p.lock_hash,toolchain_hash:p.toolchain_hash,dependency_hash:p.prepared.dependency_hash,environment_identity:p.prepared.environment_identity,network_policy:p.network_policy,lifecycle_policy:p.lifecycle_policy};
  }
  return {dispatch,createExecutionView,verifyProfile};
}
