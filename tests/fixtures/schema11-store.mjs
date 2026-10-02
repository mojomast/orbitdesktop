import fs from 'node:fs';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {fileURLToPath,pathToFileURL} from 'node:url';

// Authentic pre-feature schema-11 source, with its own model and operations.
const COMMIT='b404cf13e4a5a6aef197f7d12394648672061da2';
export async function archivedSchema11Store(t){
  const root=path.resolve(fileURLToPath(new URL('../..',import.meta.url)));
  const archived=fs.mkdtempSync('/tmp/opencode/orbit-schema11-source-');
  t.after(()=>fs.rmSync(archived,{recursive:true,force:true}));
  const bytes=execFileSync('git',['archive','--format=tar',COMMIT],{cwd:root,maxBuffer:64*1024*1024});
  execFileSync('tar',['-xf','-','-C',archived],{input:bytes,maxBuffer:64*1024*1024});
  fs.symlinkSync(path.join(root,'node_modules'),path.join(archived,'node_modules'),'dir');
  return (await import(pathToFileURL(path.join(archived,'server/sqlite-workspace-store.mjs')).href)).SqliteWorkspaceStore;
}
