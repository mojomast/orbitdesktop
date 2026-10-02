import fs from 'node:fs';
import {createHash} from 'node:crypto';
import {wbError} from './workbench-store.mjs';

// A private publication's complete byte identity, including Git metadata. No Git
// command/config/filter is executed during receipt recovery. Descriptor-relative,
// no-follow reads reject links, special files and unexpected mount boundaries.
export function publicationManifest(root,{flush=false}={}){
  const C=fs.constants,files=[],directories=[];let nodes=0,total=0;
  const fd=fs.openSync(root,C.O_RDONLY|C.O_DIRECTORY|C.O_NOFOLLOW),initial=fs.fstatSync(fd);
  const walk=(parent,prefix,depth)=>{
    if(depth>24||++nodes>8192)throw wbError('limit_exceeded');
    for(const name of fs.readdirSync(`/proc/self/fd/${parent}`).sort()){
      const target=`/proc/self/fd/${parent}/${name}`,stat=fs.lstatSync(target),relative=prefix?`${prefix}/${name}`:name;
      if(stat.dev!==initial.dev||stat.isSymbolicLink())throw wbError('stale_resource');
      const child=fs.openSync(target,C.O_RDONLY|C.O_NOFOLLOW|C.O_NONBLOCK|(stat.isDirectory()?C.O_DIRECTORY:0));
      try{
        const opened=fs.fstatSync(child);
        if(opened.ino!==stat.ino||opened.dev!==stat.dev)throw wbError('stale_resource');
        if(opened.isDirectory()){directories.push(relative);walk(child,relative,depth+1);}
        else{
          if(!opened.isFile()||opened.nlink!==1||++nodes>8192||(total+=opened.size)>64*1024*1024)throw wbError('stale_resource');
          const bytes=fs.readFileSync(child);
          if(bytes.length!==opened.size)throw wbError('stale_resource');
          files.push({path:relative,bytes:bytes.length,mode:opened.mode&0o777,hash:createHash('sha256').update(bytes).digest('hex')});
        }
        if(flush)fs.fsyncSync(child);
      }finally{fs.closeSync(child);}
    }
  };
  try{walk(fd,'',0);if(flush)fs.fsyncSync(fd);return {identity:`${initial.dev}:${initial.ino}`,directories,files};}
  finally{fs.closeSync(fd);}
}

export function flushDirectory(root){
  const fd=fs.openSync(root,fs.constants.O_RDONLY|fs.constants.O_DIRECTORY|fs.constants.O_NOFOLLOW);
  try{fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
}
