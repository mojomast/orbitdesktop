import fs from 'node:fs';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {captureProject,openProjectRoot,readProjectFile,literalPreview,PROJECT_LIMITS} from './project-files.mjs';
import {wbError} from './workbench-store.mjs';

export const CANDIDATE_LIMITS=Object.freeze({files:512,fileBytes:262144,totalBytes:8388608,depth:12,edits:256,cleanupNodes:4096});
const C=fs.constants;
const excluded=new Set(['.git','node_modules','.runtime','.ssh','.aws','.gnupg','.env','dist','build','coverage','.venv','__pycache__']);
const excludedName=name=>name.includes('\uFFFD')||excluded.has(name)||name.startsWith('.env.')||/\.(?:pem|key|p12|pfx)$/i.test(name);
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const canonical=value=>JSON.stringify(value,(_key,item)=>item&&typeof item==='object'&&!Array.isArray(item)?Object.fromEntries(Object.keys(item).sort().map(key=>[key,item[key]])):item);
const digest=value=>sha(canonical(value));
const fdPath=fd=>`/proc/self/fd/${fd}`;
const identity=stat=>`${stat.dev}:${stat.ino}`;
const order=(a,b)=>a.path<b.path?-1:a.path>b.path?1:0;
const codes=new Set(['invalid_request','permission_denied','stale_resource','unsupported','unavailable','limit_exceeded']);
function failure(error){return codes.has(error?.code)?error:wbError(error?.code==='ENOENT'?'unavailable':'permission_denied');}
function safeParts(relative){
  if(typeof relative!=='string'||!relative||relative.length>4096||relative.includes('\0')||relative.includes('\\')||path.isAbsolute(relative)||/^[a-z]:/i.test(relative))throw wbError('unsupported');
  const parts=relative.split('/');
  if(parts.some(part=>!part||part==='.'||part==='..'||excludedName(part)))throw wbError('unsupported');
  // captureProject counts directory depth, with the root at zero.
  if(parts.length-1>Math.min(CANDIDATE_LIMITS.depth,PROJECT_LIMITS.depth))throw wbError('limit_exceeded');
  return parts;
}
function manifest(files){
  if(!Array.isArray(files))throw wbError('invalid_request');
  if(files.length>CANDIDATE_LIMITS.files)throw wbError('limit_exceeded');
  const seen=new Set();let total=0;
  const result=files.map(file=>{
    safeParts(file.path);
    if(seen.has(file.path))throw wbError('unsupported');seen.add(file.path);
    if(typeof file.hash!=='string'||!/^[a-f0-9]{64}$/.test(file.hash)||!Number.isSafeInteger(file.bytes)||file.bytes<0)throw wbError('invalid_request');
    total+=file.bytes;
    if(file.bytes>CANDIDATE_LIMITS.fileBytes||total>CANDIDATE_LIMITS.totalBytes)throw wbError('limit_exceeded');
    return {path:file.path,hash:file.hash,bytes:file.bytes};
  }).sort(order);
  for(const file of result){const parts=file.path.split('/');while(parts.length>1){parts.pop();if(seen.has(parts.join('/')))throw wbError('unsupported');}}
  return result;
}

export function previewCandidate({project,capture,now}){
  if(!project||typeof project.id!=='string'||project.active===false)throw wbError('permission_denied');
  if(!capture||!Array.isArray(capture.files)||!Array.isArray(capture.exclusions)||typeof capture.limited!=='boolean')throw wbError('invalid_request');
  if(capture.files.length>CANDIDATE_LIMITS.files||capture.exclusions.length>PROJECT_LIMITS.entries+PROJECT_LIMITS.directories)throw wbError('limit_exceeded');
  const original=capture.files.map(file=>{
    safeParts(file.path);
    if(!Buffer.isBuffer(file.bytes))throw wbError('invalid_request');
    if(file.bytes.length>CANDIDATE_LIMITS.fileBytes)throw wbError('limit_exceeded');
    if(sha(file.bytes)!==file.hash)throw wbError('stale_resource');
    return {path:file.path,hash:file.hash,bytes:file.bytes.length};
  });
  const files=manifest(original);
  const exclusions=capture.exclusions.map(entry=>{
    if(typeof entry.path!=='string'||typeof entry.reason!=='string'||entry.path.length>4096||entry.reason.length>256)throw wbError('invalid_request');
    return {path:entry.path,reason:entry.reason};
  });
  // Validate the capture's own identity using precisely captureProject's encoding.
  // Capture UUIDs and timestamps are intentionally not part of preview identity.
  const manifest_hash=sha(JSON.stringify({manifest:original,exclusions,limited:capture.limited}));
  if(capture.hash!==manifest_hash)throw wbError('stale_resource');
  exclusions.sort((a,b)=>order(a,b)||(a.reason<b.reason?-1:a.reason>b.reason?1:0));
  const base={manifest_hash,files,exclusions,limited:capture.limited,total_bytes:files.reduce((sum,file)=>sum+file.bytes,0),head:null};
  return {digest:digest({manifest_hash,files,exclusions,limited:base.limited,project_id:project.id}),base};
}

export function candidateHash(candidate){
  if(!Number.isSafeInteger(candidate.generation)||candidate.generation<1||typeof candidate.base_hash!=='string'||!/^[a-f0-9]{64}$/.test(candidate.base_hash))throw wbError('invalid_request');
  return digest({generation:candidate.generation,base_hash:candidate.base_hash,files:manifest(candidate.files)});
}

function childDirectory(parent,name,dev,create=false){
  const target=`${fdPath(parent)}/${name}`;
  if(create){try{fs.mkdirSync(target,{mode:0o700});fs.fsyncSync(parent);}catch(error){if(error.code!=='EEXIST')throw error;}}
  const fd=fs.openSync(target,C.O_RDONLY|C.O_DIRECTORY|C.O_NOFOLLOW|C.O_NONBLOCK);
  try{if(fs.fstatSync(fd).dev!==dev)throw wbError('unsupported');return fd;}
  catch(error){fs.closeSync(fd);throw error;}
}
function candidatesParent(store,create=false){
  const root=openProjectRoot(store.root);let fd=root.fd;const opened=[];
  try{
    for(const name of ['workbench-execution','candidates']){fd=childDirectory(fd,name,root.dev,create);opened.push(fd);}
    return {fd,dev:root.dev,close:()=>{for(const item of opened.reverse())fs.closeSync(item);root.close();}};
  }catch(error){for(const item of opened.reverse())fs.closeSync(item);root.close();throw failure(error);}
}
function candidateName(store,candidate){
  if(typeof store.root!=='string'||!path.isAbsolute(store.root)||store.root!==path.resolve(store.root))throw wbError('permission_denied');
  if(typeof candidate.root!=='string')throw wbError('permission_denied');
  const name=path.basename(candidate.root);
  if(!/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(name)||candidate.root!==path.join(store.root,'workbench-execution','candidates',name))throw wbError('permission_denied');
  return name;
}
function openCandidate(store,candidate){
  const name=candidateName(store,candidate),parent=candidatesParent(store);let fd;
  try{fd=childDirectory(parent.fd,name,parent.dev);const stat=fs.fstatSync(fd);return {fd,dev:stat.dev,identity:identity(stat),close:()=>{fs.closeSync(fd);parent.close();}};}
  catch(error){parent.close();throw failure(error);}
}
function fileParent(root,relative,create=false){
  const parts=safeParts(relative),name=parts.pop(),opened=[];let fd=root.fd;
  try{
    for(const part of parts){fd=childDirectory(fd,part,root.dev,create);opened.push(fd);}
    return {fd,name,close:()=>{for(const item of opened.reverse())fs.closeSync(item);}};
  }catch(error){for(const item of opened.reverse())fs.closeSync(item);throw failure(error);}
}
function writeNew(parent,name,bytes){
  const fd=fs.openSync(`${fdPath(parent)}/${name}`,C.O_WRONLY|C.O_CREAT|C.O_EXCL|C.O_NOFOLLOW|C.O_NONBLOCK,0o600);
  try{
    const stat=fs.fstatSync(fd);
    if(!stat.isFile()||stat.nlink!==1)throw wbError('unsupported');
    fs.fchmodSync(fd,0o600);fs.writeFileSync(fd,bytes);fs.fsyncSync(fd);
  }finally{fs.closeSync(fd);}
}

export function createCandidate({store,project,capture,preview_digest,now}){
  const supplied=previewCandidate({project,capture,now});
  if(supplied.digest!==preview_digest)throw wbError('stale_resource');
  // Re-observe the registered root, including untracked files and exclusions.
  // Neither a caller-supplied destination nor Git HEAD is a copy authority.
  const fresh=captureProject(project),preview=previewCandidate({project,capture:fresh,now});
  if(preview.digest!==preview_digest)throw wbError('stale_resource');
  const name=randomUUID(),root=path.join(store.root,'workbench-execution','candidates',name);
  const parent=candidatesParent(store,true);let candidateRoot,created=false;
  try{
    fs.mkdirSync(`${fdPath(parent.fd)}/${name}`,{mode:0o700});created=true;
    const fd=childDirectory(parent.fd,name,parent.dev);candidateRoot={fd,dev:parent.dev};fs.fchmodSync(fd,0o700);
    for(const file of fresh.files){
      const destination=fileParent(candidateRoot,file.path,true);
      try{writeNew(destination.fd,destination.name,file.bytes);}finally{destination.close();}
    }
    const base=preview.base;
    const candidate={source_manifest_hash:base.manifest_hash,preview_digest,base_hash:base.manifest_hash,generation:1,root,files:base.files.map(file=>({...file,state:'captured'})),exclusions:base.exclusions,limited:base.limited,total_bytes:base.total_bytes,head:null,status:'approved'};
    candidate.hash=candidateHash(candidate);return candidate;
  }catch(error){if(created)removeCandidateWorkspace(store,{root});throw failure(error);}
  finally{if(candidateRoot)fs.closeSync(candidateRoot.fd);parent.close();}
}

function knownFile(candidate,relative){
  safeParts(relative);const files=manifest(candidate.files);
  const file=files.find(item=>item.path===relative);if(!file)throw wbError('unsupported');return file;
}
function readAt(candidate,root,relative){return readProjectFile({root:candidate.root,identity:root.identity},relative);}
export function readCandidateFile(store,candidate,relative){
  knownFile(candidate,relative);const root=openCandidate(store,candidate);
  try{const data=readAt(candidate,root,relative);return {path:relative,hash:data.hash,bytes:data.bytes.length,...literalPreview(data.bytes)};}
  catch(error){throw failure(error);}finally{root.close();}
}
function rehash(candidate,root){
  return manifest(candidate.files).map(file=>{
    const data=readAt(candidate,root,file.path);
    return {path:file.path,hash:data.hash,bytes:data.bytes.length,state:candidate.files.find(item=>item.path===file.path).state};
  });
}

// A candidate root is an exact private tree, not merely a collection of paths
// that happen to match its manifest. In particular, never carry an untracked
// symlink, hardlink, directory or special file into a new generation.
function verifiedTree(candidate,root){
  const expected=manifest(candidate.files),byPath=new Map(expected.map(file=>[file.path,file]));
  const directories=new Set();
  for(const file of expected){const parts=file.path.split('/');while(parts.length>1){parts.pop();directories.add(parts.join('/'));}}
  const seen=new Set();let nodes=0;
  const walk=(fd,prefix,depth)=>{
    if(depth>CANDIDATE_LIMITS.depth||++nodes>CANDIDATE_LIMITS.cleanupNodes)throw wbError('limit_exceeded');
    const dir=fs.opendirSync(fdPath(fd));
    try{let entry;while((entry=dir.readSync())){
      const relative=prefix?`${prefix}/${entry.name}`:entry.name;
      safeParts(relative);
      const target=`${fdPath(fd)}/${entry.name}`,stat=fs.lstatSync(target);
      if(stat.dev!==root.dev)throw wbError('unsupported');
      if(stat.isDirectory()&&directories.has(relative)){
        const child=childDirectory(fd,entry.name,root.dev);
        try{if(identity(fs.fstatSync(child))!==identity(stat))throw wbError('stale_resource');walk(child,relative,depth+1);}
        finally{fs.closeSync(child);}
      }else if(stat.isFile()&&byPath.has(relative)&&stat.nlink===1)seen.add(relative);
      else throw wbError('unsupported');
    }}finally{dir.closeSync();}
  };
  walk(root.fd,'',0);
  if(seen.size!==expected.length)throw wbError('stale_resource');
  return expected.map(file=>{
    const data=readAt(candidate,root,file.path);
    if(data.hash!==file.hash||data.bytes.length!==file.bytes)throw wbError('stale_resource');
    return {...file,bytesBuffer:data.bytes,state:candidate.files.find(item=>item.path===file.path).state};
  });
}

// The caller must serialize this operation against checks and durably replace
// candidate.root along with these returned fields in its own transaction. The
// old root stays immutable for historical readers until retention disposes it.
export function applyCandidateChanges({store,candidate,expected_candidate_hash,changes}){
  if(typeof expected_candidate_hash!=='string'||candidateHash(candidate)!==expected_candidate_hash||candidate.hash!==expected_candidate_hash)throw wbError('stale_resource');
  if(candidate.limited||!Array.isArray(candidate.exclusions)||candidate.exclusions.some(item=>item.reason!=='excluded_by_policy')){
    throw Object.assign(wbError('unsupported'),{reason:'incomplete_candidate_capture',limited:candidate.limited===true,exclusions:Array.isArray(candidate.exclusions)?candidate.exclusions.filter(item=>item.reason!=='excluded_by_policy'):[]});
  }
  if(!Array.isArray(changes)||changes.length<1||changes.length>CANDIDATE_LIMITS.edits)throw wbError('invalid_request');
  if(candidate.generation>=CANDIDATE_LIMITS.edits)throw wbError('limit_exceeded');
  const before=manifest(candidate.files),current=new Map(before.map(file=>[file.path,file]));
  const seen=new Set(),operations=new Map();
  for(const change of changes){
    if(!change||typeof change!=='object'||Array.isArray(change))throw wbError('invalid_request');
    safeParts(change.path);
    if(seen.has(change.path))throw wbError('invalid_request');seen.add(change.path);
    const previous=current.get(change.path),op=change.op;
    if(!['create','change','delete'].includes(op))throw wbError('invalid_request');
    if(op==='create'){
      if(previous||change.expected_hash!==null)throw wbError('stale_resource');
    }else if(!previous||previous.hash!==change.expected_hash)throw wbError('stale_resource');
    let bytes;
    if(op!=='delete'){
      if(typeof change.content==='string'&&change.content_base64===undefined)bytes=Buffer.from(change.content,'utf8');
      else if(typeof change.content_base64==='string'&&change.content===undefined&&/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(change.content_base64)){
        bytes=Buffer.from(change.content_base64,'base64');
        if(bytes.toString('base64')!==change.content_base64)throw wbError('invalid_request');
      }else throw wbError('invalid_request');
      if(bytes.length>CANDIDATE_LIMITS.fileBytes)throw wbError('limit_exceeded');
    }else if(change.content!==undefined||change.content_base64!==undefined)throw wbError('invalid_request');
    operations.set(change.path,{op,bytes});
  }
  const next=before.filter(file=>operations.get(file.path)?.op!=='delete'&&operations.get(file.path)?.op!=='change');
  for(const [relative,{op,bytes}] of operations)if(op!=='delete')next.push({path:relative,hash:sha(bytes),bytes:bytes.length});
  manifest(next); // file/directory collisions, count, depth and aggregate bytes
  const source=openCandidate(store,candidate);let parent,stage,created=false;
  const name=randomUUID(),root=path.join(store.root,'workbench-execution','candidates',name);
  try{
    const original=verifiedTree(candidate,source);
    parent=candidatesParent(store);
    fs.mkdirSync(`${fdPath(parent.fd)}/${name}`,{mode:0o700});created=true;
    const fd=childDirectory(parent.fd,name,parent.dev);stage={fd,dev:parent.dev,identity:identity(fs.fstatSync(fd))};
    const files=[];
    for(const file of original){
      if(operations.has(file.path))continue;
      const destination=fileParent(stage,file.path,true);
      try{writeNew(destination.fd,destination.name,file.bytesBuffer);fs.fsyncSync(destination.fd);}
      finally{destination.close();}
      files.push({path:file.path,hash:file.hash,bytes:file.bytes,state:file.state});
    }
    for(const [relative,{op,bytes}] of operations){
      if(op==='delete')continue;
      const destination=fileParent(stage,relative,true);
      try{writeNew(destination.fd,destination.name,bytes);fs.fsyncSync(destination.fd);}
      finally{destination.close();}
      files.push({path:relative,hash:sha(bytes),bytes:bytes.length,state:op==='create'?'created':'modified'});
    }
    files.sort(order);
    // Both snapshots must still be complete immediately before returning the
    // new root. A caller must not publish a root on an exception.
    verifiedTree(candidate,source);
    const generation=candidate.generation+1;
    const updated={...candidate,root,files,generation};
    verifiedTree(updated,stage);
    fs.fsyncSync(stage.fd);fs.fsyncSync(parent.fd);
    return {root,files,generation,hash:candidateHash(updated),total_bytes:files.reduce((sum,file)=>sum+file.bytes,0),supersedes_evidence:true};
  }catch(error){
    if(created)removeCandidateWorkspace(store,{root});
    throw failure(error);
  }finally{if(stage)fs.closeSync(stage.fd);parent?.close();source.close();}
}
export function editCandidateFile({store,candidate,path:relative,expected_hash,content}){
  knownFile(candidate,relative);
  if(typeof content!=='string')throw wbError('invalid_request');
  if(Buffer.byteLength(content,'utf8')>CANDIDATE_LIMITS.fileBytes)throw wbError('limit_exceeded');
  if(!Number.isSafeInteger(candidate.generation)||candidate.generation<1)throw wbError('invalid_request');
  if(candidate.generation>CANDIDATE_LIMITS.edits)throw wbError('limit_exceeded');
  const root=openCandidate(store,candidate);let destination,temp;
  try{
    const before=rehash(candidate,root),current=before.find(file=>file.path===relative);
    if(current.hash!==expected_hash)throw wbError('stale_resource');
    const bytes=Buffer.from(content,'utf8');
    if(before.reduce((sum,file)=>sum+file.bytes,0)-current.bytes+bytes.length>CANDIDATE_LIMITS.totalBytes)throw wbError('limit_exceeded');
    destination=fileParent(root,relative);temp=`.candidate-edit-${randomUUID()}`;
    writeNew(destination.fd,temp,bytes);
    // Replace rather than truncate: a hardlink introduced after verification
    // cannot cause a write to an inode outside this private candidate.
    const verify=readAt(candidate,root,relative);
    if(verify.hash!==expected_hash)throw wbError('stale_resource');
    const resolved=fileParent(root,relative);
    try{if(identity(fs.fstatSync(resolved.fd))!==identity(fs.fstatSync(destination.fd)))throw wbError('stale_resource');}finally{resolved.close();}
    const parentStat=fs.lstatSync(`${fdPath(destination.fd)}/${destination.name}`);
    if(!parentStat.isFile()||identity(parentStat)!==verify.identity||parentStat.nlink!==1)throw wbError('stale_resource');
    fs.renameSync(`${fdPath(destination.fd)}/${temp}`,`${fdPath(destination.fd)}/${destination.name}`);temp=undefined;
    const files=rehash(candidate,root).map(file=>file.path===relative?{...file,state:'modified'}:file);
    const generation=candidate.generation+1,hash=candidateHash({...candidate,generation,files});
    const file=files.find(item=>item.path===relative);
    if(file.hash!==sha(bytes))throw wbError('stale_resource');
    return {generation,hash,files,supersedes_evidence:true,file:{path:file.path,hash:file.hash,bytes:file.bytes}};
  }catch(error){throw failure(error);}
  finally{if(temp&&destination){try{fs.unlinkSync(`${fdPath(destination.fd)}/${temp}`);}catch{}}destination?.close();root.close();}
}

// Descriptor-relative deletion unlinks links themselves, never their targets.
// Refuse mount transitions and stop on races; disposal is deliberately best effort.
export function removeCandidateWorkspace(store,candidate){
  // Disposal is bounded: managed code can create a deep or huge tree that would
  // otherwise stall the cleanup loop. Exceeding a node/depth/time budget leaves
  // the remaining tree in place rather than unlinking unknown paths blindly.
  const budget={nodes:0,depth:24,deadline:Date.now()+5000};
  let parent;
  try{
    const name=candidateName(store,candidate);parent=candidatesParent(store);
    const remove=(fd,name,dev,depth)=>{
      if(depth>budget.depth||Date.now()>budget.deadline||++budget.nodes>CANDIDATE_LIMITS.cleanupNodes)throw wbError('limit_exceeded');
      const target=`${fdPath(fd)}/${name}`,stat=fs.lstatSync(target);
      // lstat: never follow a symlink to an outside target.
      if(!stat.isDirectory()){fs.unlinkSync(target);return;}
      const child=childDirectory(fd,name,dev);
      try{
        if(identity(fs.fstatSync(child))!==identity(stat))return;
        const directory=fs.opendirSync(fdPath(child));
        try{let entry;while((entry=directory.readSync()))remove(child,entry.name,dev,depth+1);}finally{directory.closeSync();}
        if(identity(fs.lstatSync(target))!==identity(stat))return;
        fs.rmdirSync(target);
      }finally{fs.closeSync(child);}
    };
    remove(parent.fd,name,parent.dev,0);
  }catch{}finally{parent?.close();}
}
