import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {openProjectRoot,PROJECT_LIMITS} from './project-files.mjs';
import {wbError} from './workbench-store.mjs';

const C=fs.constants;
const hash=value=>createHash('sha256').update(value).digest('hex');
const identity=stat=>`${stat.dev}:${stat.ino}`;
const fdPath=fd=>`/proc/self/fd/${fd}`;
const validPath=value=>typeof value==='string'&&path.isAbsolute(value)&&value===path.resolve(value)&&value!=='/'&&!value.includes('\0');
function openFile(parent,name,limit=4096){
  const fd=fs.openSync(`${fdPath(parent)}/${name}`,C.O_RDONLY|C.O_NOFOLLOW|C.O_NONBLOCK);
  try{
    const stat=fs.fstatSync(fd);
    if(!stat.isFile()||stat.nlink!==1||stat.size>limit||stat.size<1)throw wbError('unsupported');
    const bytes=Buffer.alloc(stat.size+1);
    const count=fs.readSync(fd,bytes,0,bytes.length,0);
    const after=fs.fstatSync(fd);
    if(count!==stat.size||after.size!==stat.size||after.mtimeMs!==stat.mtimeMs||after.ctimeMs!==stat.ctimeMs)throw wbError('stale_resource');
    return {bytes:bytes.subarray(0,count),identity:identity(after)};
  }finally{fs.closeSync(fd);}
}
function text(bytes){
  if(bytes.includes(0))throw wbError('unsupported');
  return new TextDecoder('utf-8',{fatal:true}).decode(bytes);
}
function entry(fd,name){
  try{return fs.lstatSync(`${fdPath(fd)}/${name}`);}catch(error){if(error.code==='ENOENT')return null;throw error;}
}
function checkedMetadata(common,git){
  const config=text(openFile(common.fd,'config',65536).bytes);
  if(/^\s*\[(?:extensions|include|includeIf)(?:\s|\])/im.test(config)||/\b(?:sparsecheckout|worktree|fsmonitor|repositoryformatversion)\s*=\s*(?:true|[1-9]|\/)/i.test(config))throw wbError('unsupported');
  for(const name of ['config.worktree','shallow','modules','worktrees/unused']){
    if(entry(git.fd,name)||entry(common.fd,name))throw wbError('unsupported');
  }
  const objects=fs.openSync(`${fdPath(common.fd)}/objects`,C.O_RDONLY|C.O_DIRECTORY|C.O_NOFOLLOW);
  try{
    if(entry(objects,'info')){
      const info=fs.openSync(`${fdPath(objects)}/info`,C.O_RDONLY|C.O_DIRECTORY|C.O_NOFOLLOW);
      try{if(entry(info,'alternates')||entry(info,'grafts'))throw wbError('unsupported');}finally{fs.closeSync(info);}
    }
  }finally{fs.closeSync(objects);}
  if(entry(git.fd,'info')||entry(git.fd,'packed-refs'))throw wbError('unsupported');
  if(entry(git.fd,'refs')){
    const refs=fs.openSync(`${fdPath(git.fd)}/refs`,C.O_RDONLY|C.O_DIRECTORY|C.O_NOFOLLOW);
    try{if(fs.readdirSync(fdPath(refs)).length)throw wbError('unsupported');}finally{fs.closeSync(refs);}
  }
  const head=text(openFile(git.fd,'HEAD').bytes);
  if(!(/^ref: refs\/heads\/[A-Za-z0-9._\/-]+\n?$/.test(head)||/^[a-f0-9]{40}\n?$/.test(head)))throw wbError('unsupported');
  if(entry(git.fd,'index'))openFile(git.fd,'index',PROJECT_LIMITS.gitBytes);
}
function verify(input){
  if(process.platform!=='linux'||!input||!validPath(input.root)||!validPath(input.git_directory)||!validPath(input.common_directory))throw wbError('unsupported');
  const {root:rootPath,git_directory:gitPath,common_directory:commonPath}=input;
  if(path.dirname(gitPath)!==path.join(commonPath,'worktrees')||gitPath===commonPath)throw wbError('unsupported');
  const root=openProjectRoot(rootPath,input.identity_root);
  let git,common;
  try{
    git=openProjectRoot(gitPath,input.identity_git_directory);
    common=openProjectRoot(commonPath,input.identity_common_directory);
    if(root.dev!==git.dev||root.dev!==common.dev)throw wbError('unsupported');
    if(entry(root.fd,'.gitmodules'))throw wbError('unsupported');
    if(entry(root.fd,'.gitattributes')&&/filter\s*=\s*lfs/i.test(text(openFile(root.fd,'.gitattributes',65536).bytes)))throw wbError('unsupported');
    const pointer=openFile(root.fd,'.git');
    const backlink=openFile(git.fd,'gitdir');
    const commondir=openFile(git.fd,'commondir');
    if(text(pointer.bytes)!==`gitdir: ${gitPath}\n`||text(backlink.bytes)!==`${path.join(rootPath,'.git')}\n`||text(commondir.bytes)!=='../..\n')throw wbError('stale_resource');
    checkedMetadata(common,git);
    const mapping={root:rootPath,git_directory:gitPath,common_directory:commonPath,
      identity_root:root.identity,identity_git_directory:git.identity,identity_common_directory:common.identity,
      pointer_hash:hash(pointer.bytes),backlink_hash:hash(backlink.bytes),commondir_hash:hash(commondir.bytes)};
    if(input.pointer_hash&&input.pointer_hash!==mapping.pointer_hash||input.backlink_hash&&input.backlink_hash!==mapping.backlink_hash||input.commondir_hash&&input.commondir_hash!==mapping.commondir_hash)throw wbError('stale_resource');
    return {mapping,root,git,common};
  }catch(error){root.close();git?.close();common?.close();throw error;}
}
const close=handles=>{handles.root.close();handles.git.close();handles.common.close();};
export function previewWorktree({root,git_directory,common_directory}){
  const handles=verify({root,git_directory,common_directory});
  try{
    const mapping=handles.mapping;
    return {mapping,digest:hash(JSON.stringify(mapping)),description:'Explicit linked Git worktree: visible .git pointer, per-worktree HEAD/index and shared common objects/refs; repository code and config are not executed.'};
  }finally{close(handles);}
}
export function revalidateWorktree(mapping){
  const handles=verify(mapping);
  try{
    if(Object.keys(handles.mapping).some(key=>mapping[key]!==handles.mapping[key]))throw wbError('stale_resource');
    return handles.mapping;
  }finally{close(handles);}
}
// The caller supplies its existing bounded, descriptor-relative copier. Never
// copy the original pointer, config, hooks, or worktree administration links.
export function materializeWorktree(mapping,destination,copy){
  const handles=verify(mapping);
  try{
    if(Object.keys(handles.mapping).some(key=>mapping[key]!==handles.mapping[key]))throw wbError('stale_resource');
    const target=path.join(destination,'.git');
    fs.mkdirSync(target,{mode:0o700});
    const commonEntries=['objects','refs','packed-refs'];
    for(const name of commonEntries){
      if(!entry(handles.common.fd,name))continue;
      copy(handles.common.fd,name,target,handles.common.dev);
    }
    // Generated config contains no repository-controlled instructions.
    fs.writeFileSync(path.join(target,'config'),'[core]\n\trepositoryformatversion = 0\n\tbare = false\n',{flag:'wx',mode:0o600});
    for(const name of ['HEAD','index']){
      if(entry(handles.git.fd,name))copy(handles.git.fd,name,target,handles.git.dev);
    }
    revalidateWorktree(mapping);
  }finally{close(handles);}
}
