import fs from 'node:fs';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {execFile} from 'node:child_process';
import {wbError} from './workbench-store.mjs';
import {revalidateWorktree,materializeWorktree} from './workbench-worktrees.mjs';
const C=fs.constants;
// Repository observation deliberately uses only raw object reads. `git status`
// and `git diff` are never invoked because they can run repository-configured
// clean/smudge/textconv drivers, fsmonitors or external diff commands.
const GIT='/usr/bin/git',DIFF='/usr/bin/diff',PRLIMIT='/usr/bin/prlimit';
// Address-space and CPU limits are applied to every child. --nofile keeps
// descriptor use bounded. There is deliberately no network or filesystem
// isolation claim: these limits bound resource abuse, not disclosure.
const PRLIMIT_ARGS=Object.freeze(['--as=268435456','--cpu=5','--nofile=64','--']);
const GIT_CONFIG_OVERRIDES=Object.freeze([['protocol.allow','never'],['core.fsmonitor','false'],['core.hooksPath','/dev/null']]);
const COMMAND_TIMEOUT_MS=5000,OBSERVATION_TIMEOUT_MS=10000,SCRATCH_PREFIX='wb-git-',DIFF_OLD_FILE='old',DIFF_NEW_FILE='new';
export const PROJECT_LIMITS=Object.freeze({files:512,entries:2048,directories:128,totalBytes:8*1024*1024,fileBytes:256*1024,depth:12,gitBytes:32*1024*1024,gitFiles:4096,diffBytes:256*1024,compareFiles:128});
const excluded=new Set(['.git','node_modules','.runtime','.ssh','.aws','.gnupg','.env','dist','build','coverage','.venv','__pycache__']);
// Node decodes directory entries as UTF-8. Refuse the replacement character so
// malformed byte names cannot alias a different literal path/resource ID.
const excludedName=name=>name.includes('\uFFFD')||excluded.has(name)||name.startsWith('.env.')||/\.(?:pem|key|p12|pfx)$/i.test(name);
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const identity=stat=>`${stat.dev}:${stat.ino}`;
const fdPath=fd=>`/proc/self/fd/${fd}`;
function failure(error){if(error?.code&&['permission_denied','unsupported','stale_resource','limit_exceeded'].includes(error.code))return error;return wbError(error?.code==='ENOENT'?'unavailable':'permission_denied');}
function child(parent,name,directory=false){
  if(!name||name==='.'||name==='..'||name.includes('/')||name.includes('\0'))throw wbError('permission_denied');
  return fs.openSync(`${fdPath(parent)}/${name}`,C.O_RDONLY|C.O_NOFOLLOW|C.O_NONBLOCK|(directory?C.O_DIRECTORY:0));
}
// Any opened descendant whose device differs from the registered root is a
// mount transition below the root. The registered root itself may legitimately
// be a mount point, so only transitions below it are refused.
function guardedChild(parent,name,directory,device){
  const fd=child(parent,name,directory);
  try{if(fs.fstatSync(fd).dev!==device)throw wbError('unsupported');return fd;}
  catch(error){fs.closeSync(fd);throw failure(error);}
}
// Every component is opened relative to an already held directory descriptor.
// A replaced pathname cannot redirect the next open through a symlink. Linux
// /proc is required; there is deliberately no realpath + unchecked-open fallback.
export function openProjectRoot(root,expected){
  if(process.platform!=='linux'||typeof root!=='string'||!path.isAbsolute(root)||root!==path.resolve(root)||root==='/'||root.includes('\0'))throw wbError('unsupported');
  let fd=fs.openSync('/',C.O_RDONLY|C.O_DIRECTORY|C.O_NOFOLLOW);
  try{
    for(const component of root.split('/').filter(Boolean)){const next=child(fd,component,true);fs.closeSync(fd);fd=next;}
    const stat=fs.fstatSync(fd),key=identity(stat);if(expected&&key!==expected)throw wbError('stale_resource');
    return {fd,identity:key,dev:stat.dev,close:()=>fs.closeSync(fd)};
  }catch(error){fs.closeSync(fd);throw failure(error);}
}
function bytesAt(fd,maxBytes){
  const before=fs.fstatSync(fd);
  if(!before.isFile()||before.nlink!==1)throw wbError('unsupported');
  if(before.size>maxBytes)throw wbError('limit_exceeded');
  const bytes=Buffer.alloc(Math.min(before.size+1,maxBytes+1));
  let length=0,count;
  while(length<bytes.length&&(count=fs.readSync(fd,bytes,length,bytes.length-length,length)))length+=count;
  const after=fs.fstatSync(fd);
  if(length!==before.size||before.size!==after.size||before.mtimeMs!==after.mtimeMs||before.ctimeMs!==after.ctimeMs)throw wbError('stale_resource');
  return {bytes:bytes.subarray(0,length),identity:identity(after)};
}
// A repository-relative path is only ever used after it has been proven to be a
// plain, non-excluded descendant name. It is never passed to a shell.
function safePath(relative){
  if(typeof relative!=='string'||relative.length===0||relative.length>4096||relative.includes('\0')||relative.startsWith('/'))return false;
  return relative.split('/').every(part=>part&&part!=='.'&&part!=='..'&&!excludedName(part));
}
export function readProjectFile(project,relative){
  const parts=relative.split('/');if(parts.some(excludedName))throw wbError('permission_denied');
  const root=openProjectRoot(project.root,project.identity);let fd=root.fd;const opened=[];
  try{
    for(let i=0;i<parts.length;i++){fd=guardedChild(fd,parts[i],i<parts.length-1,root.dev);opened.push(fd);}
    const data=bytesAt(fd,PROJECT_LIMITS.fileBytes);
    // Re-resolve the entire chain without following links before releasing data.
    // A directory moved out of the registered root is not still a valid pathname.
    const verify=openProjectRoot(project.root,project.identity);const checks=[];let check=verify.fd;
    try{for(let i=0;i<parts.length;i++){check=guardedChild(check,parts[i],i<parts.length-1,verify.dev);checks.push(check);}if(identity(fs.fstatSync(check))!==data.identity)throw wbError('stale_resource');}
    finally{for(const value of checks.reverse())fs.closeSync(value);verify.close();}
    return {...data,hash:hash(data.bytes)};
  }catch(error){throw failure(error);}finally{for(const value of opened.reverse())fs.closeSync(value);root.close();}
}
export function captureProject(project){
  const root=openProjectRoot(project.root,project.identity),files=[],exclusions=[];let total=0,limited=false,entries=0,directories=0;
  const walk=(fd,prefix,depth)=>{
    if(++directories>PROJECT_LIMITS.directories||entries>=PROJECT_LIMITS.entries){limited=true;exclusions.push({path:prefix,reason:'traversal_budget'});return;}
    if(depth>PROJECT_LIMITS.depth){limited=true;exclusions.push({path:prefix,reason:'depth_limit'});return;}
    // Bound directory enumeration before sorting/returning it to the browser.
    const directory=fs.opendirSync(fdPath(fd));const names=[];
    try{let entry;while(entries<PROJECT_LIMITS.entries&&(entry=directory.readSync())){entries++;if(names.length>=PROJECT_LIMITS.files){limited=true;break;}names.push(entry.name);}if(entries>=PROJECT_LIMITS.entries){limited=true;exclusions.push({path:prefix,reason:'traversal_budget'});}}finally{directory.closeSync();}
    for(const name of names.sort()){
      const relative=prefix?`${prefix}/${name}`:name;
      if(excludedName(name)){exclusions.push({path:relative,reason:'excluded_by_policy'});continue;}
      if(files.length>=PROJECT_LIMITS.files||total>=PROJECT_LIMITS.totalBytes){limited=true;break;}
      let current;
      try{
        current=child(fd,name);const stat=fs.fstatSync(current);
        if(stat.dev!==root.dev)throw Object.assign(Error('cross_device'),{code:'cross_device'});
        if(stat.isDirectory())walk(current,relative,depth+1);
        else if(stat.isFile()){
          const data=bytesAt(current,PROJECT_LIMITS.fileBytes);
          if(total+data.bytes.length>PROJECT_LIMITS.totalBytes){limited=true;break;}
          total+=data.bytes.length;files.push({path:relative,...data,hash:hash(data.bytes)});
        }else exclusions.push({path:relative,reason:'unsupported_special_file'});
      }catch(error){
        const reason=error.code==='limit_exceeded'?'file_size_limit':error.code==='cross_device'?'cross_device':'unavailable_or_unsupported';
        exclusions.push({path:relative,reason});
      }
      finally{if(current!==undefined)fs.closeSync(current);}
    }
  };
  try{walk(root.fd,'',0);for(const file of files){const verify=readProjectFile(project,file.path);if(verify.identity!==file.identity||verify.hash!==file.hash)throw wbError('stale_resource');}}
  finally{root.close();}
  const manifest=files.map(({path,hash,bytes})=>({path,hash,bytes:bytes.length}));
  return {id:randomUUID(),captured_at:Date.now(),files,manifest,hash:hash(JSON.stringify({manifest,exclusions,limited})),exclusions,limited,total_bytes:total};
}
// Binary detection never returns replacement/NUL text: content is either valid
// UTF-8 without NUL or it is marked binary and withheld from the browser.
export function literalPreview(bytes){
  if(bytes.includes(0))return {text:'',binary:true};
  try{return {text:new TextDecoder('utf-8',{fatal:true}).decode(bytes),binary:false};}catch{return {text:'',binary:true};}
}
function textOf(bytes){if(bytes.includes(0))return null;try{return new TextDecoder('utf-8',{fatal:true}).decode(bytes);}catch{return null;}}
function gitBlobHash(bytes,algorithm){return createHash(algorithm).update(`blob ${bytes.length}\0`).update(bytes).digest('hex');}
function execFileRaw(file,args,options){
  return new Promise(resolve=>{
    execFile(file,args,options,(error,stdout,stderr)=>resolve({code:error?error.code:0,stdout,stderr,error:error??null}));
  });
}
// Owner registration only observes a bounded private materialization of raw Git
// objects. It must never execute repository code: no hooks, filters, textconv,
// fsmonitor, external diff, aliases, includes, alternates or lazy fetch. Local
// config/hooks/logs/info are excluded, linked worktrees are refused, and the
// child Git/diff processes run under an address-space and CPU limit.
export async function repositorySnapshot(project,capture,{scratchRoot='/tmp/opencode'}={}){
  const unavailable=reason=>({state:'unavailable',reason,head:null,status:'',diff:'',snapshot_hash:null,base:null,exclusions:'Repository inspection is unavailable; the document project remains readable.'});
  if(process.platform!=='linux'||!fs.existsSync(PRLIMIT))return unavailable('Bounded child execution requires /usr/bin/prlimit on Linux; repository inspection is disabled');
  let root;
  // The root is opened before any temporary state exists, so a stale root fails
  // without leaving a scratch directory behind.
  try{root=openProjectRoot(project.root,project.identity);}catch{return unavailable('Project root could not be re-verified for repository inspection');}
  if(project.git_mapping){
    try{if(project.git_mapping.root!==project.root||project.git_mapping.identity_root!==project.identity)throw wbError('stale_resource');revalidateWorktree(project.git_mapping);}
    catch{root.close();return unavailable('Approved linked-worktree mapping changed or is unavailable');}
  }
  let scratch;
  try{
    try{fs.mkdirSync(scratchRoot,{recursive:true,mode:0o700});}catch{return unavailable('Private workbench scratch directory is unavailable');}
    scratch=fs.mkdtempSync(path.join(scratchRoot,SCRATCH_PREFIX));fs.chmodSync(scratch,0o700);
    const deadline=Date.now()+OBSERVATION_TIMEOUT_MS;
    let git;
    if(!project.git_mapping){try{git=guardedChild(root.fd,'.git',true,root.dev);}catch{return unavailable('No supported in-root Git directory; the document project remains usable');}}
    try{
      // Materialize a bounded copy. Config, hooks, logs, info, worktree and
      // module indirection are skipped; anything that is not a plain single
      // link regular file/directory is rejected rather than copied.
      let count=0,total=0;
       const copy=(fd,destination,depth=0,device=root.dev)=>{
        if(depth>20)throw wbError('limit_exceeded');fs.mkdirSync(destination,{recursive:true,mode:0o700});
        const directory=fs.opendirSync(fdPath(fd));
        try{let entry;while((entry=directory.readSync())){
          if(++count>PROJECT_LIMITS.gitFiles)throw wbError('limit_exceeded');
          if(['commondir','gitdir'].includes(entry.name))throw wbError('unsupported');
           if(['config','hooks','logs','info','worktrees','modules'].includes(entry.name))continue;
          let next;
          try{
            next=child(fd,entry.name);const stat=fs.fstatSync(next),target=path.join(destination,entry.name);
             if(stat.dev!==device)throw wbError('unsupported');
             if(stat.isDirectory())copy(next,target,depth+1,device);
            else if(stat.isFile()){const data=bytesAt(next,PROJECT_LIMITS.gitBytes);total+=data.bytes.length;if(total>PROJECT_LIMITS.gitBytes)throw wbError('limit_exceeded');fs.writeFileSync(target,data.bytes,{mode:0o600,flag:'wx'});}
            else throw wbError('unsupported');
          }finally{if(next!==undefined)fs.closeSync(next);}
        }}finally{directory.closeSync();}
      };
       if(project.git_mapping){
         materializeWorktree(project.git_mapping,scratch,(fd,name,destination,device)=>{
           const next=guardedChild(fd,name,false,device);
           try{
             const stat=fs.fstatSync(next),target=path.join(destination,name);
             if(stat.isDirectory())copy(next,target,0,device);
             else if(stat.isFile()){
               const data=bytesAt(next,PROJECT_LIMITS.gitBytes);
               total+=data.bytes.length;if(total>PROJECT_LIMITS.gitBytes)throw wbError('limit_exceeded');
               fs.writeFileSync(target,data.bytes,{mode:0o600,flag:'wx'});
             }else throw wbError('unsupported');
           }finally{fs.closeSync(next);}
         });
       }else copy(git,path.join(scratch,'.git'));
      const captured=new Map();
      for(const file of capture.files){
        if(!safePath(file.path))throw wbError('unsupported');
        const target=path.join(scratch,file.path);fs.mkdirSync(path.dirname(target),{recursive:true,mode:0o700});
        fs.writeFileSync(target,file.bytes,{mode:0o600,flag:'wx'});captured.set(file.path,file);
      }
      // A fresh, secret-free environment. No inherited credentials or command
      // environment is forwarded; config keys are overridden in-process.
      const env={PATH:'/usr/bin:/bin',HOME:scratch,LANG:'C.UTF-8',LC_ALL:'C.UTF-8',GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:'/dev/null',GIT_TERMINAL_PROMPT:'0',GIT_NO_REPLACE_OBJECTS:'1',GIT_NO_LAZY_FETCH:'1',GIT_OPTIONAL_LOCKS:'0',GIT_CONFIG_COUNT:String(GIT_CONFIG_OVERRIDES.length)};
      GIT_CONFIG_OVERRIDES.forEach(([key,value],index)=>{env[`GIT_CONFIG_KEY_${index}`]=key;env[`GIT_CONFIG_VALUE_${index}`]=value;});
      const runLimited=(command,args,{binary=false,maxBuffer=PROJECT_LIMITS.diffBytes+PROJECT_LIMITS.fileBytes+65536}={})=>{
        const remaining=deadline-Date.now();
        if(remaining<=0)return Promise.resolve({code:'ETIMEDOUT',stdout:binary?Buffer.alloc(0):'',stderr:'',error:null});
        // execFile defaults to utf8; binary object reads must request Buffers.
        const options={cwd:scratch,env,timeout:Math.min(COMMAND_TIMEOUT_MS,remaining),maxBuffer,windowsHide:true,encoding:binary?'buffer':'utf8'};
        return execFileRaw(PRLIMIT,[...PRLIMIT_ARGS,command,...args],options);
      };
      const runGit=async(args,options)=>{const result=await runLimited(GIT,args,options);if(result.code!==0)throw wbError('unavailable');return result.stdout;};
      const head=String(await runGit(['rev-parse','--verify','HEAD'])).trim();
      const head_reference=fs.readFileSync(path.join(scratch,'.git','HEAD'),'utf8').trim();
      if(!/^[a-f0-9]{40,64}$/.test(head))throw wbError('unsupported');
      const algorithm=head.length===64?'sha256':'sha1';
      // ls-tree -l reports the true uncompressed blob size before any object is
      // inflated, so an oversized historical blob is refused without exposure.
      // Trusted metadata stdout is capped at the diff budget (not the 32 MiB
      // object budget), so an enormous tree cannot be buffered into memory.
      const listing=String(await runGit(['ls-tree','-r','-z','-l','HEAD'],{maxBuffer:PROJECT_LIMITS.diffBytes}));
      const tree=new Map();
      for(const record of listing.split('\0')){
        if(!record)continue;
        const tab=record.indexOf('\t');if(tab<0)continue;
        const meta=record.slice(0,tab).trim().split(/\s+/);if(meta.length!==4)continue;
        const [mode,type,oid,size]=meta;if(type==='commit'||mode==='160000')throw wbError('unsupported');if(type!=='blob')continue;
        const name=record.slice(tab+1);if(!safePath(name))continue;
        tree.set(name,{mode,oid,size:Number(size)});
      }
      // The parsed HEAD tree is bounded by the project file budget. A repository
      // with more tracked paths than that is reported unavailable instead of
      // exposing an unbounded set of historical paths.
      if(tree.size>PROJECT_LIMITS.files)throw wbError('limit_exceeded');
      const omittedAt=relative=>capture.exclusions.some(entry=>relative===entry.path||relative.startsWith(`${entry.path}/`));
      const entries=[],compare=[];
      for(const file of capture.files){
        if(!safePath(file.path)||!captured.has(file.path))continue;
        const tracked=tree.get(file.path);
        if(!tracked){entries.push({xy:'??',path:file.path});compare.push({path:file.path,kind:'added'});continue;}
        // Content-only comparison. Index staging and executable-bit changes are
        // not represented in the capture and are explicitly not reported.
        if(gitBlobHash(file.bytes,algorithm)!==tracked.oid){entries.push({xy:' M',path:file.path});compare.push({path:file.path,kind:'modified',oid:tracked.oid,size:tracked.size});}
      }
      // In an incomplete capture, absence is not proof of deletion.
      if(!capture.limited){
        for(const [name,tracked] of tree){
          if(captured.has(name)||omittedAt(name))continue;
          entries.push({xy:' D',path:name});compare.push({path:name,kind:'deleted',oid:tracked.oid,size:tracked.size});
        }
      }
      entries.sort((left,right)=>left.path<right.path?-1:left.path>right.path?1:0);
      const status=entries.length?`${entries.map(entry=>`${entry.xy} ${entry.path}`).join('\0')}\0`:'';
      // Porcelain status is bounded by the diff budget as well; an oversized
      // status (for example many long untracked paths) is reported unavailable.
      if(Buffer.byteLength(status,'utf8')>PROJECT_LIMITS.diffBytes)throw wbError('limit_exceeded');
      const limited=compare.slice(0,PROJECT_LIMITS.compareFiles);
      const comparisonLimited=compare.length>limited.length;
      const work=fs.mkdtempSync(path.join(scratch,'diff-'));
      const labels=item=>({old:item.kind==='added'?'/dev/null':`a/${item.path}`,fresh:item.kind==='deleted'?'/dev/null':`b/${item.path}`});
      const omittedChunk=(item,oversized)=>{
        const {old,fresh}=labels(item);let chunk=`--- ${old}\n+++ ${fresh}\n[Binary content omitted]\n`;
        if(oversized)chunk+=`[historical blob exceeds the bounded ${PROJECT_LIMITS.fileBytes}-byte preview and was not read]\n`;
        return chunk;
      };
      const textChunk=async(item,oldBytes,newBytes)=>{
        fs.writeFileSync(path.join(work,DIFF_OLD_FILE),oldBytes,{mode:0o600,flag:'w'});
        fs.writeFileSync(path.join(work,DIFF_NEW_FILE),newBytes,{mode:0o600,flag:'w'});
        const {old,fresh}=labels(item);
        const result=await runLimited(DIFF,['-u','--label',old,'--label',fresh,'--',path.join(work,DIFF_OLD_FILE),path.join(work,DIFF_NEW_FILE)]);
        if(result.code===0)return '';
        if(result.code!==1)throw wbError('unavailable');
        return typeof result.stdout==='string'?result.stdout:result.stdout.toString('utf8');
      };
      let diff='',truncated=false;
      for(const item of limited){
        let chunk='';
        if(item.kind!=='added'&&item.size>PROJECT_LIMITS.fileBytes)chunk=omittedChunk(item,true);
        else{
          let oldBytes=Buffer.alloc(0),newBytes=Buffer.alloc(0);
          if(item.kind!=='added'){
            // Object IDs only: no :path revision resolution is used.
            oldBytes=await runGit(['cat-file','blob',item.oid],{binary:true,maxBuffer:PROJECT_LIMITS.fileBytes+4096});
            if(!Buffer.isBuffer(oldBytes)||oldBytes.length!==item.size)throw wbError('unsupported');
          }
          if(item.kind!=='deleted')newBytes=captured.get(item.path).bytes;
          const oldText=textOf(oldBytes),newText=textOf(newBytes);
          if(oldText===null||newText===null)chunk=omittedChunk(item,false);
          else if(oldText!==newText)chunk=await textChunk(item,oldBytes,newBytes);
        }
        if(!chunk)continue;
        if(Buffer.byteLength(diff,'utf8')+Buffer.byteLength(chunk,'utf8')>PROJECT_LIMITS.diffBytes){truncated=true;break;}
        diff+=chunk;
      }
      if(truncated){
        const note=Buffer.from('[diff truncated at bounded output size]\n','utf8');
        const room=Math.max(0,PROJECT_LIMITS.diffBytes-note.length);
        diff=Buffer.concat([Buffer.from(diff,'utf8').subarray(0,room),note]).toString('utf8');
      }
      const notes=[
        'Policy-excluded, cross-device, oversized, special and unsupported paths are omitted or marked.',
        'Repository .gitattributes filter/diff attributes are ignored and no clean, smudge, textconv, fsmonitor, alias or external-diff driver is executed.',
        'Index staging state and executable-bit changes are not implemented and are not reported.',
        'Binary changes are described as [Binary content omitted]; raw bytes are never returned.',
        'Root identity is dev/ino based and is not ABA-proof; same-UID isolation and filesystem/network isolation are out of scope.',
        capture.limited?'The capture tree was incomplete, so absence of a tracked path is not reported as a deletion.':'',
        comparisonLimited?`Unified diff comparison was limited to ${PROJECT_LIMITS.compareFiles} paths.`:'',
        truncated?`Unified diff output was truncated at ${PROJECT_LIMITS.diffBytes} bytes.`:'',
      ].filter(Boolean).join(' ');
      return {
        state:'available',head,head_reference,status,diff,
        snapshot_hash:hash(JSON.stringify({head,manifest_hash:capture.hash,diff})),
         base:`Raw rev-parse/ls-tree/cat-file object reads over a bounded private ${project.git_mapping?'approved linked-worktree':'in-root .git'} materialization; unified diffs from /usr/bin/diff over captured bytes. Child Git and diff run under address-space and CPU limits only; no network or filesystem isolation is claimed.`,
        exclusions:notes,
      };
    }finally{if(git!==undefined)fs.closeSync(git);}
  }catch(error){
    const reason=error?.code==='limit_exceeded'
      ?'Repository metadata exceeds the bounded tree, status and diff observation limits'
      :'Repository unavailable, changed, unsupported, or exceeds bounded materialization limits';
    return unavailable(reason);
  }
  finally{root.close();if(scratch!==undefined)fs.rmSync(scratch,{recursive:true,force:true});}
}
