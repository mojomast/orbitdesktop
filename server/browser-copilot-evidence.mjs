import {mkdir,lstat,open,rename,unlink,opendir} from 'node:fs/promises';
import {constants} from 'node:fs';
import {join,resolve,dirname,basename} from 'node:path';
import {randomUUID} from 'node:crypto';
import {digest,copilotError} from './browser-copilot-driver.mjs';
import {COPILOT_LIMITS} from '../contracts/browser-copilot-v1.mjs';
import {verifyEvidence} from './browser-copilot-records.mjs';

// Linux dirfd anchoring: every ancestor is opened with O_NOFOLLOW, and all IO is
// relative to the resulting descriptor. Replacing a pathname during an await
// cannot redirect a write/read into a symlink's destination. Existing feature
// directories/files must already be private; unfamiliar permissions are refused.
async function withDirectory(path,create,fn){
  const components=resolve(path).split('/').filter(Boolean);let dir;
  try{
    dir=await open('/',constants.O_RDONLY|constants.O_DIRECTORY|constants.O_NOFOLLOW);let feature=false;
    for(let i=0;i<components.length;i++){
      const component=components[i];feature||=component==='browser-copilot';const child=`/proc/self/fd/${dir.fd}/${component}`;let next;
      try{next=await open(child,constants.O_RDONLY|constants.O_DIRECTORY|constants.O_NOFOLLOW);}catch(error){
        if(error.code!=='ENOENT'||!create)throw error;
        try{await mkdir(child,{mode:0o700});}catch(error){if(error.code!=='EEXIST')throw error;}
        next=await open(child,constants.O_RDONLY|constants.O_DIRECTORY|constants.O_NOFOLLOW);
      }
      try{const st=await next.stat();if(!st.isDirectory()||((feature||i===components.length-1)&&((st.mode&0o777)!==0o700||st.uid!==process.getuid())))throw copilotError('unavailable');}catch(error){await next.close();throw error;}
      await dir.close();dir=next;
    }
    return await fn(dir,`/proc/self/fd/${dir.fd}`);
  }catch(error){if(['ENOENT','unavailable','limit_exceeded'].includes(error.code))throw error;throw copilotError('unavailable');}finally{await dir?.close();}
}
const privateFile=st=>st.isFile()&&st.nlink===1&&(st.mode&0o777)===0o600&&st.uid===process.getuid()&&st.size<=4*1024*1024;
export async function privateDirectory(path){await withDirectory(path,true,async()=>{});}
export async function privateRead(path){return withDirectory(dirname(path),false,async(_dir,base)=>{const file=await open(join(base,basename(path)),constants.O_RDONLY|constants.O_NOFOLLOW);try{const st=await file.stat();if(!privateFile(st))throw copilotError('unavailable');return await file.readFile();}finally{await file.close();}});}
export async function privateWrite(path,bytes){return withDirectory(dirname(path),false,async(dir,base)=>{
  const destination=join(base,basename(path)),temp=destination+'.'+randomUUID()+'.tmp';let file,created=false;
  try{
    try{if(!privateFile(await lstat(destination)))throw copilotError('unavailable');}catch(error){if(error.code!=='ENOENT')throw error;}
    file=await open(temp,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);
    created=true;
    await file.writeFile(bytes);await file.sync();await file.close();file=null;await rename(temp,destination);await dir.sync();
  }finally{await file?.close().catch(()=>{});if(created)await unlink(temp).catch(error=>{if(error.code!=='ENOENT')throw error;});}
});}
export async function privateNames(path,limit){return withDirectory(path,false,async(_dir,base)=>{const entries=await opendir(base),names=[];for await(const entry of entries){if(names.length>=limit)throw copilotError('limit_exceeded');names.push(entry.name);}return names;});}
async function privateDelete(path){return withDirectory(dirname(path),false,async(_dir,base)=>{const target=join(base,basename(path));if(!privateFile(await lstat(target)))throw copilotError('unavailable');await unlink(target);});}

export function createCopilotEvidenceStore(directory,{now=Date.now}={}){
  async function entries(){await privateDirectory(directory);const names=await privateNames(directory,8192);const items=[];for(const name of names){if(!/^[a-f0-9]{64}\.(json|png)$/.test(name))throw copilotError('unavailable');if(name.endsWith('.png'))continue;if(items.length>=4096)throw copilotError('limit_exceeded');const record=verifyEvidence(JSON.parse(await privateRead(join(directory,name))));if(record.evidence_id!==name.slice(0,-5))throw copilotError('unavailable');items.push(record);}return items;}
  async function prune({dry_run=true,workspace_id}={}){
    const all=await entries(), groups=new Map();const removed=[];
    for(const item of all){if(workspace_id&&item.workspace_id!==workspace_id)continue;const key=item.workspace_id+'\0'+item.session_id;const group=groups.get(key)||[];group.push(item);groups.set(key,group);}
    for(const group of groups.values()){group.sort((a,b)=>b.captured_at-a.captured_at);for(let i=0;i<group.length;i++){const r=group[i];if(i>=COPILOT_LIMITS.evidenceRetainedPerSession||r.captured_at<now()-3*86400000)removed.push(r);}}
    // Global byte cap applies on automatic pruning; owner-scoped manual pruning
    // cannot delete another workspace's records.
    if(!workspace_id){let total=all.filter(r=>!removed.includes(r)).reduce((n,r)=>n+r.bytes,0);for(const r of [...all].sort((a,b)=>a.captured_at-b.captured_at)){if(total<=64*1024*1024)break;if(!removed.includes(r)){removed.push(r);total-=r.bytes;}}}
    if(!dry_run){for(const r of removed)await privateDelete(join(directory,r.evidence_id+'.json'));const kept=all.filter(r=>!removed.includes(r));const hashes=new Set(kept.map(r=>r.sha256));for(const name of await privateNames(directory,8192)){if(/^[a-f0-9]{64}\.png$/.test(name)&&!hashes.has(name.slice(0,-4)))await privateDelete(join(directory,name));}}
    return {dry_run,removed:removed.length,retained:all.length-removed.length};
  }
  const store={
    async put({workspace_id,session_id,target_id,observation,bytes}){
      if(bytes.length>COPILOT_LIMITS.evidenceBytes||!bytes.length)throw copilotError('limit_exceeded');await privateDirectory(directory);
      const sha256=digest(bytes);const meta={workspace_id,session_id,target_id,observation,sha256,bytes:bytes.length,captured_at:now()};const evidence_id=digest(JSON.stringify(meta));
      const record=verifyEvidence({...meta,evidence_id});if((await entries()).length>=4096)throw copilotError('limit_exceeded');
      await privateWrite(join(directory,sha256+'.png'),bytes);await privateWrite(join(directory,evidence_id+'.json'),JSON.stringify(record));await prune({dry_run:false});
      return {evidence_id,sha256,bytes:bytes.length,target_id,captured_at:meta.captured_at};
    },
    async read({workspace_id,session_id,evidence_id}){
      let meta;try{meta=verifyEvidence(JSON.parse(await privateRead(join(directory,evidence_id+'.json'))));if(meta.evidence_id!==evidence_id)throw copilotError('unavailable');}catch(error){if(error.code==='ENOENT')throw copilotError('stale_resource');throw copilotError('unavailable');}
      if(meta.workspace_id!==workspace_id||meta.session_id!==session_id)throw copilotError('permission_denied');
      const bytes=await privateRead(join(directory,meta.sha256+'.png'));if(bytes.length!==meta.bytes||digest(bytes)!==meta.sha256)throw copilotError('unavailable');
      return {...meta,media_type:'image/png',data_base64:bytes.toString('base64')};
    },prune,
  };
  let tail=Promise.resolve();
  return Object.fromEntries(Object.entries(store).map(([name,fn])=>[name,(body)=>{const task=tail.then(()=>fn(body));tail=task.catch(()=>{});return task;}]));
}
