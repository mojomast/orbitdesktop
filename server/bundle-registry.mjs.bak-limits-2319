import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';

// Installed by the store's schema migration, never implicitly by this module.
export const bundleSchemaSql = `
  CREATE TABLE IF NOT EXISTS bundles(
    slug TEXT PRIMARY KEY, content_addressed INTEGER NOT NULL,
    status TEXT NOT NULL, digest TEXT, version INTEGER NOT NULL,
    file_count INTEGER NOT NULL DEFAULT 0, byte_count INTEGER NOT NULL DEFAULT 0,
    diagnostic TEXT, refreshed_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS bundle_files(
    slug TEXT NOT NULL REFERENCES bundles(slug), relative TEXT NOT NULL,
    digest TEXT NOT NULL, size INTEGER NOT NULL,
    PRIMARY KEY(slug,relative)
  );
`;

const slugPattern = /^[a-z0-9][a-z0-9-]{0,63}$/;
export const isContentAddressedBundle = slug => /^[a-z][a-z0-9-]{0,25}-[a-f0-9]{24}$/.test(slug);
const addressed = isContentAddressedBundle;
const safeRelative = value => typeof value==='string' && value.length>0 && !value.includes('\\') && !value.includes('\0') && value.split('/').every(part=>part && !part.startsWith('.'));
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const unavailable = (slug,diagnostic) => Object.assign(Error(`Bundle unavailable: ${slug} (${diagnostic})`),{code:'BUNDLE_UNAVAILABLE',category:'BUNDLE_UNAVAILABLE',slug,diagnostic});
const length = n => {const bytes=Buffer.alloc(8);bytes.writeBigUInt64BE(BigInt(n));return bytes;};
// pathlib sorts path components, not the entire slash-separated string.
function publisherOrder(a,b) {
  const aa=a.split('/'),bb=b.split('/');
  for(let i=0;i<Math.min(aa.length,bb.length);i++) {const order=Buffer.compare(Buffer.from(aa[i]),Buffer.from(bb[i]));if(order)return order;}
  return aa.length-bb.length;
}
function appReference(url) {
  if(typeof url!=='string')return null;
  let parts,absolute;
  try {
    const parsed=new URL(url,'http://orbit-reference.invalid/');
    if(!['http:','https:'].includes(parsed.protocol))return null;
    const pathname=decodeURIComponent(parsed.pathname);
    if(!pathname.startsWith('/apps/'))return null;
    parts=pathname.slice(6).split('/');
    absolute=/^(?:https?:)?\/\//i.test(url);
  } catch {return null;}
  const slug=parts.shift();
  if(!slugPattern.test(slug))return null;
  const relative=parts.join('/')||'index.html';
  return {slug,relative:relative.endsWith('/')?relative+'index.html':relative,...(absolute?{absolute:true}:{})};
}

/** root is the runtime directory (bundles live in root/apps).
 * All ordinary reads are SQLite-only. refresh() is the sole directory scan.
 * Indexed availability is a snapshot, not a filesystem lock: serving MUST use
 * resolveFile(), or verifyFile() on the exact bytes subsequently sent, without
 * re-reading the file. Those methods reject links and enforce indexed digests.
 * Filesystem-owner concurrent edits cannot be made atomic with SQLite; cleanup
 * is deliberately advisory and never removes files, even with confirm:true.
 */
export function createBundleRegistry({db,root}) {
  const apps=path.join(path.resolve(root),'apps');
  const get=db.prepare('SELECT * FROM bundles WHERE slug=?');
  const files=db.prepare('SELECT relative,digest,size FROM bundle_files WHERE slug=? ORDER BY relative');
  const file=db.prepare('SELECT digest,size FROM bundle_files WHERE slug=? AND relative=?');
  const all=db.prepare('SELECT * FROM bundles ORDER BY slug');

  // Includes disabled registrations and their saved windows for retention.
  // active is only an activation hint; caller must pass model-validated state.
  function references(state) {
    const result=[];
    const add=(url,source,active)=>{const ref=appReference(url);if(ref)result.push({...ref,source,active});};
    const layout=(node,source,active)=>{
      if(node?.type==='pane') {if(node.pane?.kind==='browser')add(node.pane.url,source,active);}
      else if(node?.type==='split') {layout(node.first,source,active);layout(node.second,source,active);}
    };
    for(const monitor of state?.monitors||[])layout(monitor.layout,`monitor:${monitor.id}`,true);
    for(const plugin of state?.plugins||[]) {
      const active=!!plugin.enabled || (state.monitors||[]).some(monitor=>monitor.id===plugin.window?.id);
      add(plugin.manifest?.entry,`plugin:${plugin.manifest?.id}`,active);
      layout(plugin.window?.layout,`plugin-window:${plugin.manifest?.id}`,active);
    }
    add(state?.appearance?.wallpaper,'wallpaper',true);
    return result;
  }
  function retainedReferences() {
    const result=[];
    for(const row of db.prepare('SELECT id,record_json FROM workspaces').all())for(const ref of references(JSON.parse(row.record_json).state))result.push({...ref,workspace_id:row.id,retained_by:'workspace'});
    for(const row of db.prepare('SELECT workspace_id,revision,state_json FROM revisions').all())for(const ref of references(JSON.parse(row.state_json)))result.push({...ref,workspace_id:row.workspace_id,revision:row.revision,retained_by:'revision'});
    for(const row of db.prepare('SELECT workspace_id,id,state_json FROM checkpoints').all())for(const ref of references(JSON.parse(row.state_json)))result.push({...ref,workspace_id:row.workspace_id,checkpoint_id:row.id,retained_by:'checkpoint'});
    return result;
  }
  function directory(filename) {
    const stat=fs.lstatSync(filename);
    if(stat.isSymbolicLink()||!stat.isDirectory())throw Error('symlink or non-directory');
  }
  function inspect(slug) {
    const collected=[];let size=0;
    directory(apps);directory(path.join(apps,slug));
    const walk=(relative='',depth=0)=>{
      if(depth>64)throw Error('directory depth limit');
      for(const entry of fs.readdirSync(path.join(apps,slug,relative),{withFileTypes:true})) {
        const name=relative?relative+'/'+entry.name:entry.name;
        if(!safeRelative(name))throw Error('hidden or invalid pathname');
        const target=path.join(apps,slug,name),stat=fs.lstatSync(target);
        if(stat.isSymbolicLink())throw Error('symlink');
        if(stat.isDirectory())walk(name,depth+1);
        else {
          if(!stat.isFile())throw Error('non-regular file');
          if(collected.length>=500||size+stat.size>20_000_000)throw Error('bundle limit: 20 MB / 500 files');
          const fd=fs.openSync(target,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW|fs.constants.O_NONBLOCK);
          let bytes;
          try {
            const current=fs.fstatSync(fd);
            if(!current.isFile()||current.size+size>20_000_000)throw Error('bundle limit or non-regular file');
            // Bounded reads even if the owner grows a file during refresh.
            bytes=Buffer.alloc(current.size+1);
            let used=0,n;
            while(used<bytes.length && (n=fs.readSync(fd,bytes,used,bytes.length-used,null))>0)used+=n;
            if(used!==current.size)throw Error('file changed during refresh');
            bytes=bytes.subarray(0,used);
          } finally {fs.closeSync(fd);}
          size+=bytes.length;collected.push({relative:name,bytes,digest:sha256(bytes),size:bytes.length});
        }
      }
    };
    walk();
    const digest=createHash('sha256');
    for(const item of collected.sort((a,b)=>publisherOrder(a.relative,b.relative))) {
      const name=Buffer.from(item.relative);
      digest.update(length(name.length)).update(name).update(length(item.size)).update(item.bytes);
    }
    const hash=digest.digest('hex');
    if(addressed(slug) && (!collected.some(item=>item.relative==='index.html')||!slug.endsWith('-'+hash.slice(0,24))))throw Error('content hash mismatch or missing index.html');
    return {digest:hash,files:collected,byte_count:size};
  }
  function refresh() {
    // Filesystem work outside the DB writer lock; no implicit refresh on reads.
    let names=[],rootError;
    try {directory(apps);names=fs.readdirSync(apps).filter(name=>slugPattern.test(name));}
    catch(error) {if(error.code!=='ENOENT')rootError=error.message;}
    const inspected=new Map();
    for(const slug of names) {
      try {inspected.set(slug,{status:addressed(slug)?'verified':'unverified',...inspect(slug)});}
      catch(error) {inspected.set(slug,{status:'corrupt',diagnostic:error.message});}
    }
    db.transaction(()=>{
      const slugs=new Set([...all.all().map(row=>row.slug),...inspected.keys(),...retainedReferences().map(ref=>ref.slug)]);
      for(const slug of slugs) {
        const old=get.get(slug),next=inspected.get(slug)||{status:rootError?'corrupt':'missing',diagnostic:rootError||'bundle directory missing'};
        const digest=next.digest??old?.digest??null;
        const changed=!old||old.status!==next.status||old.digest!==digest;
        const version=old?old.version+(changed?1:0):1;
        db.prepare(`INSERT INTO bundles VALUES (?,?,?,?,?,?,?,?,?) ON CONFLICT(slug) DO UPDATE SET
          status=excluded.status,digest=excluded.digest,version=excluded.version,file_count=excluded.file_count,
          byte_count=excluded.byte_count,diagnostic=excluded.diagnostic,refreshed_at=excluded.refreshed_at`).run(
          slug,Number(addressed(slug)),next.status,digest,version,next.files?.length??old?.file_count??0,next.byte_count??old?.byte_count??0,next.diagnostic??null,Date.now());
        // Preserve the last known file manifest when a referenced bundle vanishes.
        if(next.files) {
          db.prepare('DELETE FROM bundle_files WHERE slug=?').run(slug);
          for(const item of next.files)db.prepare('INSERT INTO bundle_files VALUES (?,?,?,?)').run(slug,item.relative,item.digest,item.size);
        }
      }
    }).immediate();
    return list();
  }
  function list() {return all.all().map(row=>({...row,content_addressed:!!row.content_addressed,files:files.all(row.slug)}));}
  function versions() {return Object.fromEntries(all.all().filter(row=>['verified','unverified'].includes(row.status)).map(row=>[row.slug,row.version]));}

  /** By default validates active references only, so disabling broken plugins is
   * possible. Pass {previousState} to additionally gate newly introduced inactive
   * references (install/update/sync). Existing inactive registrations never block
   * recovery. Callers must validate activation/new refs at their commit boundary;
   * this is not a general state/model validator and never refreshes the index.
   */
  function validateState(state,{previousState,onlyChanged=false}={}) {
    const prior=new Set(references(previousState).map(ref=>`${ref.slug}/${ref.relative}`));
    const priorActive=new Set(references(previousState).filter(ref=>ref.active).map(ref=>`${ref.slug}/${ref.relative}`));
    const diagnostics=[];
    for(const ref of references(state)) {
      // Absolute URLs may refer to another host: conservatively retain matching
      // local slugs, but do not pretend this registry validates remote resources.
      if(ref.absolute)continue;
      if(onlyChanged && (ref.active?priorActive:prior).has(`${ref.slug}/${ref.relative}`))continue;
      if(!ref.active && (previousState===undefined||prior.has(`${ref.slug}/${ref.relative}`)))continue;
      const row=get.get(ref.slug);
      if(addressed(ref.slug)) {
        if(row?.status!=='verified'||!safeRelative(ref.relative)||!file.get(ref.slug,ref.relative))throw unavailable(ref.slug,row?.status||'not indexed');
      } else diagnostics.push({...ref,status:row?.status||'not indexed',diagnostic:'legacy bundle is unverified'});
    }
    return {ok:true,diagnostics};
  }
  function checkedPath(slug,relative) {
    if(!slugPattern.test(slug)||!safeRelative(relative))throw unavailable(slug,'invalid pathname');
    const row=get.get(slug);
    if(!row||!['verified','unverified'].includes(row.status)||!file.get(slug,relative))throw unavailable(slug,row?.status||'not indexed');
    try {
      directory(apps);directory(path.join(apps,slug));
      const parts=relative.split('/');
      for(let i=1;i<parts.length;i++)directory(path.join(apps,slug,...parts.slice(0,i)));
      const target=path.join(apps,slug,relative),stat=fs.lstatSync(target);
      if(!stat.isFile()||stat.isSymbolicLink())throw Error('symlink or non-regular file');
      return target;
    } catch(error) {throw unavailable(slug,error.message);}
  }
  function verifyFile(slug,relative,bytes) {
    checkedPath(slug,relative);
    const indexed=file.get(slug,relative);
    if(!(bytes instanceof Uint8Array)||bytes.byteLength!==indexed.size||sha256(bytes)!==indexed.digest)throw unavailable(slug,'file digest mismatch');
    return true;
  }
  function resolveFile(slug,relative='index.html') {
    const target=checkedPath(slug,relative),indexed=file.get(slug,relative);
    let fd;
    try {
      fd=fs.openSync(target,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW|fs.constants.O_NONBLOCK);
      const stat=fs.fstatSync(fd);
      if(!stat.isFile()||stat.size!==indexed.size)throw Error('file size mismatch');
      const bytes=Buffer.alloc(indexed.size);let used=0,n;
      while(used<bytes.length && (n=fs.readSync(fd,bytes,used,bytes.length-used,null))>0)used+=n;
      if(used!==bytes.length)throw Error('file size mismatch');
      verifyFile(slug,relative,bytes);
      return {bytes,digest:indexed.digest,relative,slug};
    } catch(error) {throw unavailable(slug,error.message);}
    finally {if(fd!==undefined)fs.closeSync(fd);}
  }
  function cleanupPlan() {
    return db.transaction(()=>{
      const refs=retainedReferences(),retained=new Map();
      for(const ref of refs) {if(!retained.has(ref.slug))retained.set(ref.slug,[]);retained.get(ref.slug).push(ref);}
      return {dry_run:true,candidates:all.all().filter(row=>!retained.has(row.slug)),retained:[...retained].map(([slug,references])=>({slug,references}))};
    }).deferred();
  }
  function prune(slugs,{confirm=false}={}) {
    if(!Array.isArray(slugs)||slugs.some(slug=>!slugPattern.test(slug)))throw Error('Invalid bundle slugs');
    const plan=cleanupPlan(),requested=new Set(slugs);
    return {...plan,candidates:plan.candidates.filter(row=>requested.has(row.slug)),requested:[...requested],confirm,deleted:[],reason:'Dry-run only: filesystem publication and workspace references do not share an atomic deletion lock'};
  }
  return {refresh,versions,list,validateState,references,cleanupPlan,prune,verifyFile,resolveFile};
}
