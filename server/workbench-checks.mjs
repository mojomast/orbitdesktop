import fs from 'node:fs';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {createHash} from 'node:crypto';
import {openProjectRoot} from './project-files.mjs';
import {wbError} from './workbench-store.mjs';

const digest=value=>createHash('sha256').update(value).digest('hex');
// Fixed trusted supervisor. `/usr/bin/timeout` gives every child its own wall-time
// deadline independent of this Node process: if the server is killed, the child
// still terminates instead of leaking a detached job. It is a resource bound,
// NOT a sandbox or isolation mechanism, and it runs under the same UID.
const SUPERVISOR='/usr/bin/timeout';
const HOST_SCRIPT=`import {pathToFileURL} from 'node:url';
try {
  const {sum} = await import(pathToFileURL(process.argv[2]).href);
  if (typeof sum !== 'function' || sum(2, 3) !== 5 || sum(-1, 1) !== 0) process.exitCode = 1;
} catch (error) {
  console.error('Host regression failed:', error?.message ?? String(error));
  process.exitCode = 1;
}
`;
// HONEST LIMITS: `logBytes` is the enforced per-run retained artifact cap. There
// is deliberately NO enforced storage quota: the private check directory retains
// at most logBytes, and total disk use is host-limited and same-UID (advisory,
// not a quota). Duration and preview caps likewise bound the supervised command
// and recorder, not arbitrary host resources.
export const CHECK_LIMITS=Object.freeze({durationMs:60000,logBytes:262144,previewBytes:16384,maxConcurrent:1,storage:'advisory: no storage quota is enforced; each run retains at most logBytes in a private directory and total disk use is host-limited'});
export const CHECK_DEFINITIONS=Object.freeze({
  'node-test':Object.freeze({id:'node-test',executable:'/usr/bin/node',args:Object.freeze(['--test','--test-reporter=spec'])}),
  'host-regression':Object.freeze({id:'host-regression',executable:'/usr/bin/node',args:Object.freeze([]),script:HOST_SCRIPT}),
});
export function checkDefinition(id){const definition=Object.hasOwn(CHECK_DEFINITIONS,id)?CHECK_DEFINITIONS[id]:undefined;if(!definition)throw wbError('unsupported');return definition;}
export const definitionDigest=definition=>digest(JSON.stringify(definition));
export const checkSpecDigest=({definition_id,definition_digest,candidate_hash,acceptance_version})=>digest(JSON.stringify({definition_id,definition_digest,candidate_hash,acceptance_version}));

const active=new Map();
const pending=new Set();
export const activeCheckCount=()=>active.size;
function processStart(pid){
  try{const stat=fs.readFileSync(`/proc/${pid}/stat`,'utf8');const fields=stat.slice(stat.lastIndexOf(')')+2).trim().split(/\s+/);return fields[19]??null;}catch{return null;}
}
function signalGroup(pid,signal){try{process.kill(-pid,signal);return true;}catch{return false;}}
function groupAlive(pid){try{process.kill(-pid,0);return true;}catch{return false;}}
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
// Best-effort bounded removal. A supervised command can write an arbitrarily
// large tree through HOME/TMPDIR; an unbounded recursive delete would stall the
// recorder. If the node/time budget is exceeded the remaining private tree is
// retained (job storage is advisory, not a quota) instead of looping forever.
function boundedRemove(root,budgetNodes=4096,deadlineMs=2000){
  const deadline=Date.now()+deadlineMs;let nodes=0,parent;
  const walk=(fd,name,dev,depth)=>{
    if(depth>24||Date.now()>deadline||++nodes>budgetNodes)return false;
    const target=`/proc/self/fd/${fd}/${name}`,before=fs.lstatSync(target);
    if(!before.isDirectory()){fs.unlinkSync(target);return true;}
    const child=fs.openSync(target,fs.constants.O_RDONLY|fs.constants.O_DIRECTORY|fs.constants.O_NOFOLLOW);
    try{
      const opened=fs.fstatSync(child);
      if(opened.dev!==dev||opened.dev!==before.dev||opened.ino!==before.ino)return false;
      const directory=fs.opendirSync(`/proc/self/fd/${child}`);
      try{let entry;while((entry=directory.readSync()))if(!walk(child,entry.name,dev,depth+1))return false;}
      finally{directory.closeSync();}
      const current=fs.lstatSync(target);
      if(current.dev!==opened.dev||current.ino!==opened.ino)return false;
      fs.rmdirSync(target);return true;
    }finally{fs.closeSync(child);}
  };
  try{parent=openProjectRoot(path.dirname(root));return walk(parent.fd,path.basename(root),fs.fstatSync(parent.fd).dev,0);}
  catch{return false;}finally{parent?.close();}
}
// Cancellation is identity-conditional: a reused PID with a different kernel
// start time is never signalled. Returns {requested, confirmed} — confirmed is
// only ever true after the caller observes the actual child exit.
export function cancelCheck({job_id,pid,started_at}){
  const entry=active.get(job_id);
  if(!entry||entry.pid!==pid||entry.started_at!==String(started_at)||processStart(pid)!==entry.started_at)return {requested:false,confirmed:false};
  entry.cancel_requested=true;
  signalGroup(pid,'SIGTERM');
  entry.escalate();
  return {requested:true,confirmed:entry.cancelled===true};
}
function privateRoot(root){
  if(process.platform!=='linux'||typeof root!=='string'||!path.isAbsolute(root)||path.resolve(root)!==root||root==='/'||root.includes('\0'))throw wbError('invalid_request');
  const opened=openProjectRoot(root);
  try{if(!fs.fstatSync(opened.fd).isDirectory())throw wbError('permission_denied');}finally{opened.close();}
}
function validateRoots(candidate,artifacts){
  privateRoot(artifacts);privateRoot(candidate);
  if(candidate===artifacts||!candidate.startsWith(`${artifacts}${path.sep}`))throw wbError('permission_denied');
  if(artifacts.startsWith(`${candidate}${path.sep}`))throw wbError('permission_denied');
}

export async function runCheck(options){
  if(active.size+pending.size>=CHECK_LIMITS.maxConcurrent||pending.has(options?.job_id)||active.has(options?.job_id))throw wbError('busy');
  const reservation=Symbol('check');pending.add(reservation);
  try{return await executeCheck(options);}finally{pending.delete(reservation);}
}
async function executeCheck({definition_id,candidate_root,workspace_id,project_id,job_id,artifact_root,rehash,spawn_record}){
  const definition=checkDefinition(definition_id);
  if(typeof workspace_id!=='string'||typeof project_id!=='string'||typeof job_id!=='string'||!job_id||typeof rehash!=='function'||typeof spawn_record!=='function')throw wbError('invalid_request');
  validateRoots(candidate_root,artifact_root);
  const before=(await rehash())?.hash;
  if(typeof before!=='string'||!before)throw wbError('stale_resource');
  validateRoots(candidate_root,artifact_root);
  const definition_digest=definitionDigest(definition);
  const directory=fs.mkdtempSync(path.join(artifact_root,'check-'));fs.chmodSync(directory,0o700);
  const temp=fs.mkdtempSync(path.join(directory,'private-'));fs.chmodSync(temp,0o700);
  const log_path=path.join(directory,'output.log');
  const fd=fs.openSync(log_path,fs.constants.O_WRONLY|fs.constants.O_CREAT|fs.constants.O_EXCL|fs.constants.O_NOFOLLOW,0o600);
  const env={PATH:'/usr/bin:/bin',HOME:temp,LANG:'C.UTF-8',LC_ALL:'C.UTF-8',NODE_OPTIONS:'',TMPDIR:temp};
  const env_fingerprint=digest(JSON.stringify(env));
  let args=definition.args;
  if(definition_id==='host-regression'){
    const script=path.join(temp,'verify.mjs');
    fs.writeFileSync(script,HOST_SCRIPT,{mode:0o600,flag:'wx'});
    args=[script,path.join(candidate_root,'math.js')];
  }
  const seconds=Math.max(1,Math.ceil(CHECK_LIMITS.durationMs/1000));
  const supervisedArgs=['--kill-after=1s',`${seconds}s`,definition.executable,...args];
  const command={supervisor:SUPERVISOR,executable:definition.executable,args,supervised:supervisedArgs};
  let child,childStart=null,ended=false,timed_out=false,log_bytes=0,stdout=Buffer.alloc(0),stderr=Buffer.alloc(0),timer,killTimer,hardTimer;
  const logHash=createHash('sha256');
  const capture=(stream,chunk)=>{
    const remaining=CHECK_LIMITS.previewBytes-(stream==='stdout'?stdout.length:stderr.length);
    if(remaining>0){if(stream==='stdout')stdout=Buffer.concat([stdout,chunk.subarray(0,remaining)]);else stderr=Buffer.concat([stderr,chunk.subarray(0,remaining)]);}
    const room=CHECK_LIMITS.logBytes-log_bytes;
    if(room>0){const part=chunk.subarray(0,room);fs.writeSync(fd,part);logHash.update(part);log_bytes+=part.length;}
  };
  const started_at=Date.now();
  const finish=(extra)=>{
    ended=true;clearTimeout(timer);clearTimeout(killTimer);clearTimeout(hardTimer);active.delete(job_id);
    try{fs.closeSync(fd);}catch{}
    const log_hash=logHash.digest('hex');
    return {exit_code:null,signal:null,verdict:'inconclusive',started_at,ended_at:Date.now(),candidate_hash_before:before,candidate_hash_after:before,definition_id,definition_digest,definition_hash:definition_digest,stdout_preview:stdout.toString('utf8'),stderr_preview:stderr.toString('utf8'),log_path,log_hash,log_bytes,artifact_hash:digest(JSON.stringify({log_hash,log_bytes,definition_digest})),env_fingerprint,limits:CHECK_LIMITS,timed_out:false,process_survival_unknown:false,supervisor:SUPERVISOR,command,...extra};
  };
  try{
    child=spawn(SUPERVISOR,supervisedArgs,{cwd:candidate_root,env,detached:true,stdio:['ignore','pipe','pipe'],shell:false,windowsHide:true});
    // Install the error/close listeners IMMEDIATELY. A missing executable emits an
    // asynchronous 'error' event; an unhandled one would crash the host.
    const settled=new Promise(resolve=>{
      child.once('error',error=>resolve({code:null,signal:null,error}));
      child.once('close',(code,signal)=>resolve({code,signal,error:null}));
    });
    const pid=child.pid;
    if(!pid){
      const failure=await settled;
      return finish({spawn_error:'spawn_failed',stderr_preview:String(failure.error?.message??'spawn failed').slice(0,CHECK_LIMITS.previewBytes)});
    }
    childStart=processStart(pid);
    if(!childStart){
      // The child exists but its identity cannot be proven. Never signal a
      // PID/PGID we cannot verify (a reused PID could target an unrelated
      // process); the external supervisor still bounds the command. Report a
      // real unknown, never a pass.
      await settled;
      return finish({spawn_error:'identity_unavailable',process_survival_unknown:true});
    }
    const entry={pid,started_at:childStart,cancelled:false,cancel_requested:false,escalate:()=>{
      if(!killTimer)killTimer=setTimeout(()=>{if(processStart(pid)===childStart)signalGroup(pid,'SIGKILL');},500);
    }};
    active.set(job_id,entry);
    // Durable record is written in the same synchronous turn as spawn, before any
    // child event is awaited, so a crash cannot leave an unrecorded run.
    spawn_record({pid,pgid:pid,started_at:childStart,supervisor:SUPERVISOR,command});
    child.stdout.on('data',chunk=>capture('stdout',chunk));
    child.stderr.on('data',chunk=>capture('stderr',chunk));
    timer=setTimeout(()=>{timed_out=true;if(processStart(pid)===childStart)signalGroup(pid,'SIGTERM');entry.escalate();},CHECK_LIMITS.durationMs);
    // Hard deadline independent of whether the leader still exists. If a
    // descendant inherited the child's stdio and outlives the leader, the `close`
    // event may never fire; destroying the pipes and resolving guarantees the
    // recorder cannot hang. The lost leader is reported as inconclusive, and no
    // unrelated PID is ever signalled.
    const hardDeadline=new Promise(resolve=>{hardTimer=setTimeout(()=>{timed_out=true;try{child.stdout?.destroy();child.stderr?.destroy();}catch{}resolve({code:null,signal:null,error:null,forced:true});},CHECK_LIMITS.durationMs+3000);});
    const result=await Promise.race([settled,hardDeadline]);
    // uutils/GNU timeout exits 124 when the deadline fired.
    if(result.code===124)timed_out=true;
    entry.cancelled=entry.cancelled||entry.cancel_requested;
    active.delete(job_id);
    clearTimeout(timer);clearTimeout(killTimer);clearTimeout(hardTimer);
    fs.closeSync(fd);ended=true;
    let after;
    try{after=(await rehash())?.hash;}catch{after=null;}
    const log_hash=logHash.digest('hex');
    // The supervisor bounds its own main command while it waits. If the leader
    // exited and a descendant survived in the group, we cannot bound it and must
    // not report a clean pass. If the leader identity still matches we still own
    // the group and may kill it; otherwise we never signal a possibly-reused PGID.
    let process_survival_unknown=result.forced===true;
    if(!process_survival_unknown&&groupAlive(pid)){
      if(processStart(pid)===childStart){
        signalGroup(pid,'SIGKILL');
        for(let i=0;i<20&&groupAlive(pid);i++)await sleep(5);
      }
      if(groupAlive(pid))process_survival_unknown=true;
    }
    const verdict=timed_out||entry.cancelled||!after||after!==before||result.error||result.forced||process_survival_unknown?'inconclusive':result.code===0?'pass':'fail';
    return {exit_code:result.code,signal:result.signal,verdict,started_at,ended_at:Date.now(),candidate_hash_before:before,candidate_hash_after:after??null,definition_id,definition_digest,definition_hash:definition_digest,stdout_preview:stdout.toString('utf8'),stderr_preview:stderr.toString('utf8'),log_path,log_hash,log_bytes,artifact_hash:digest(JSON.stringify({log_hash,log_bytes,definition_digest})),env_fingerprint,limits:CHECK_LIMITS,timed_out,process_survival_unknown,supervisor:SUPERVISOR,command};
  }catch(error){
    if(child?.pid){if(childStart&&processStart(child.pid)===childStart)signalGroup(child.pid,'SIGTERM');setTimeout(()=>{if(childStart&&processStart(child.pid)===childStart)signalGroup(child.pid,'SIGKILL');},500).unref();child.on('error',()=>{});}
    throw error;
  }finally{
    if(!ended){clearTimeout(timer);clearTimeout(killTimer);clearTimeout(hardTimer);active.delete(job_id);try{fs.closeSync(fd);}catch{}}
    // Bounded best-effort cleanup of the private temp; a huge tree written by the
    // supervised command is left in place rather than stalling the recorder.
    boundedRemove(temp);
  }
}
