import fs from 'node:fs';
import path from 'node:path';
import {openProjectRoot} from './project-files.mjs';

// Before the legacy queue UI is first opened, its durable pending/unknown state
// must already fence new Workbench dispatch. This is a read-only projection;
// createBuildQueue remains the sole writer and replaces it with live counts.
export function legacyQueueSnapshot(runtimeRoot){
  return ()=>{
    let root,fd;
    try{
      root=openProjectRoot(path.join(runtimeRoot,'build-queue'));
      fd=fs.openSync(`/proc/self/fd/${root.fd}/queue.json`,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW|fs.constants.O_NONBLOCK);
      const stat=fs.fstatSync(fd);
      if(!stat.isFile()||stat.nlink!==1||stat.size>8*1024*1024)throw Error('Invalid legacy state');
      const bytes=Buffer.alloc(stat.size+1);let length=0,count;
      while(length<bytes.length&&(count=fs.readSync(fd,bytes,length,bytes.length-length,length)))length+=count;
      const after=fs.fstatSync(fd);
      if(length!==stat.size||after.size!==stat.size||after.mtimeMs!==stat.mtimeMs)throw Error('Changing legacy state');
      const state=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes.subarray(0,length)));
      if(state.version!==1||!Array.isArray(state.tasks)||state.tasks.length>200)throw Error('Invalid legacy state');
      const counts={enabled:false,active:0,uncertain:0,pending:0};
      for(const task of state.tasks){
        if(!task||typeof task.status!=='string')throw Error('Invalid legacy task');
        if(task.status==='starting'||(task.status==='blocked'&&/outcome unknown/i.test(String(task.note??''))))counts.uncertain++;
        else if(task.run&&!['completed','failed','cancelled','interrupted','blocked'].includes(task.status))counts.active++;
        else if(task.status==='queued')counts.pending++;
      }
      return counts;
    }catch(error){
      if(error.code==='ENOENT'||error.code==='unavailable')return {enabled:false,active:0,uncertain:0,pending:0};
      // An unreadable ledger is not evidence that it is safe to dispatch.
      return {enabled:false,active:0,uncertain:1,pending:0};
    }finally{if(fd!==undefined)fs.closeSync(fd);root?.close();}
  };
}
