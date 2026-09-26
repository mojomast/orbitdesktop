#!/usr/bin/env node
// Explicit owner administration only. Never invoked by layout restore or plugin code.
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import {SqliteWorkspaceStore} from '../server/sqlite-workspace-store.mjs';

const [action,...args]=process.argv.slice(2),options={};
const backupInvalid=()=>Object.assign(Error('BACKUP_INVALID'),{category:'BACKUP_INVALID'});
function backupVersion(db) {
  try {
    const version=db.pragma('user_version',{simple:true});
    if(version>4)throw Object.assign(Error('UPGRADE_REQUIRED'),{category:'UPGRADE_REQUIRED'});
    if(![1,2,3,4].includes(version)||db.pragma('quick_check',{simple:true})!=='ok'||db.prepare("SELECT value FROM store_metadata WHERE key='bootstrap_complete'").get()?.value!=='1')throw backupInvalid();
    return version;
  } catch(error) {
    if(error.category==='UPGRADE_REQUIRED')throw error;
    throw backupInvalid();
  }
}
try {
  for(let i=0;i<args.length;i++) {
    if(args[i]==='--confirm-stopped')options.stopped=true;
    else if(args[i]==='--preserve-schema')options.preserveSchema=true;
    else if(['--runtime','--destination','--source'].includes(args[i])&&args[i+1])options[args[i].slice(2)]=path.resolve(args[++i]);
    else throw Error('INVALID_ARGUMENTS');
  }
  if(!['migrate','diagnose','backup','export-legacy','restore'].includes(action)||!options.runtime)throw Error('Usage: workspace_store.mjs migrate|diagnose|backup|export-legacy|restore --runtime PATH [--destination PATH|--source PATH] [--confirm-stopped] [--preserve-schema (restore only)]');
  if(options.preserveSchema&&action!=='restore')throw Error('INVALID_ARGUMENTS');
  if(['migrate','export-legacy','restore'].includes(action)&&!options.stopped)throw Error('Confirm old/new servers are stopped with --confirm-stopped; this tool does not stop them.');
  if(action==='restore') {
    if(options.preserveSchema&&(!options.source||options.source!==options.source.trim()||!fs.existsSync(options.source)))throw backupInvalid();
    if(!options.source||options.source!==options.source.trim()||fs.existsSync(options.runtime)||!fs.existsSync(options.source))throw Error('Restore requires an existing --source SQLite backup and a NEW --runtime directory.');
    const stage=fs.mkdtempSync(path.join(path.dirname(options.runtime),'.orbit-restore-'));
    let source;
    try {
      try {source=new Database(options.source,{readonly:true,fileMustExist:true});} catch {throw backupInvalid();}
      const version=backupVersion(source);
      const destination=path.join(stage,'workspace.sqlite');fs.closeSync(fs.openSync(destination,'wx',0o600));
      await source.backup(destination);source.close();source=undefined;
      let diagnostics;
      if(options.preserveSchema) {
        // Raw pre-upgrade runtime for the MATCHING older binary only. Opening it
        // with the newer server upgrades it; this is never a down-conversion.
        const copy=new Database(destination,{readonly:true,fileMustExist:true});
        try {
          const copiedVersion=backupVersion(copy);
          if(copiedVersion!==version)throw backupInvalid();
          diagnostics={preserved:true,schema_version:copiedVersion};
        } finally {copy.close();}
      } else {
        const store=new SqliteWorkspaceStore(stage);
        try {diagnostics=store.diagnostics();} finally {store.close();}
      }
      if(fs.existsSync(options.runtime))throw Error('DESTINATION_EXISTS');
      fs.renameSync(stage,options.runtime);
      console.log(JSON.stringify({restored:true,...diagnostics}));
    } finally {source?.close();fs.rmSync(stage,{recursive:true,force:true});}
  } else {
    if(!fs.existsSync(options.runtime))throw Error('Runtime directory must already exist');
    if(action!=='migrate'&&!fs.existsSync(path.join(options.runtime,'workspace.sqlite')))throw Error('An initialized SQLite store is required');
    const store=new SqliteWorkspaceStore(options.runtime,{importLegacy:action==='migrate'});
    try {
      if(action==='backup'||action==='export-legacy') {
        if(!options.destination)throw Error('--destination is required and must not exist');
        console.log(JSON.stringify(action==='backup'?await store.backup(options.destination):store.exportLegacy(options.destination)));
      } else console.log(JSON.stringify(store.diagnostics()));
    } finally {store.close();}
  }
} catch(error) {
  console.error(JSON.stringify({error:error.category||(['migrate','diagnose','backup','export-legacy','restore'].includes(action)?'Workspace administration failed; check arguments, stopped-writer requirement, file permissions and migration fixtures.':error.message)}));
  process.exitCode=1;
}
