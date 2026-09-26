// Shared canonical-root validation for release tooling. Resolves symlinks in the
// deepest existing ancestor so an alias/ancestor/inode collision cannot bypass a
// separation check, and validates roots before any write.
import fs from 'node:fs';
import path from 'node:path';

export class RootError extends Error{
  constructor(code,message,details={}){super(message);this.name='RootError';this.code=code;Object.assign(this,details);}
}

export function canonicalTarget(target){
  const absolute=path.resolve(target);
  const tail=[];
  let cursor=absolute;
  while(!fs.existsSync(cursor)){
    const parent=path.dirname(cursor);
    if(parent===cursor)break;
    tail.unshift(path.basename(cursor));
    cursor=parent;
  }
  let resolved;
  try{resolved=fs.realpathSync.native(cursor);}catch{resolved=cursor;}
  return tail.length?path.join(resolved,...tail):resolved;
}

export function identityOf(target){
  try{const stat=fs.statSync(target);return {dev:stat.dev,ino:stat.ino};}catch{return null;}
}

export function assertAbsoluteRoot(label,value,{mustExist=false}={}){
  if(typeof value!=='string'||value.trim()==='')throw new RootError('invalid_root',`${label} must be a nonempty path.`,{label});
  if(!path.isAbsolute(value))throw new RootError('invalid_root',`${label} must be an absolute path.`,{label,value});
  const canonical=canonicalTarget(value);
  if(canonical===path.parse(canonical).root)throw new RootError('invalid_root',`${label} must not be a filesystem root.`,{label,value});
  if(mustExist&&!fs.existsSync(canonical))throw new RootError('root_missing',`${label} does not exist.`,{label,value:canonical});
  return canonical;
}

// True when a and b are equal, nested, or the same physical object: any of these
// means writing into `a` could read/destroy `b`.
export function rootsCollide(a,b){
  const ca=canonicalTarget(a),cb=canonicalTarget(b);
  if(ca===cb)return ca===cb?'same_path':false;
  if(ca.startsWith(cb+path.sep))return 'inside';
  if(cb.startsWith(ca+path.sep))return 'contains';
  const ia=identityOf(ca),ib=identityOf(cb);
  if(ia&&ib&&ia.dev===ib.dev&&ia.ino===ib.ino)return 'same_identity';
  return false;
}

// Runtime data, the served release and any retained previous release must be
// mutually separated roots. Never written before this passes.
export function assertSeparatedRoots({runtime,release,previous}={}){
  const canonicalRuntime=assertAbsoluteRoot('runtime',runtime,{mustExist:true});
  const roots=[{label:'release',value:release,mustExist:true}];
  if(previous!==undefined&&previous!==null)roots.push({label:'previous release',value:previous,mustExist:true});
  const canonical=[];
  for(const root of roots){
    const canonicalRoot=assertAbsoluteRoot(root.label,root.value,{mustExist:root.mustExist});
    const relation=rootsCollide(canonicalRuntime,canonicalRoot);
    if(relation)throw new RootError('roots_not_separated',`Runtime must be separated from the ${root.label}.`,{relation,runtime:canonicalRuntime,[root.label.replace(/\s+/g,'_')]:canonicalRoot});
    if(!canonical.includes(canonicalRoot))canonical.push(canonicalRoot);
  }
  for(let i=0;i<canonical.length;i++)for(let j=i+1;j<canonical.length;j++){
    const relation=rootsCollide(canonical[i],canonical[j]);
    if(relation)throw new RootError('roots_not_separated','Release roots must be separated.',{relation});
  }
  return {runtime:canonicalRuntime,releases:canonical};
}
