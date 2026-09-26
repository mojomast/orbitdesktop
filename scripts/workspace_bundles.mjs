#!/usr/bin/env node
// Local-only bundle administration. Never create a runtime as a side effect of a typo.
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import {SqliteWorkspaceStore} from '../server/sqlite-workspace-store.mjs';
import {createBundleRegistry} from '../server/bundle-registry.mjs';

function usage() {
  throw Error('Usage: node --experimental-strip-types scripts/workspace_bundles.mjs <refresh|plan> --root ABSOLUTE_RUNTIME_DIR');
}

function main(args) {
  const command=args.shift();
  if(!['refresh','plan'].includes(command)||args.length!==2||args[0]!=='--root')usage();
  const root=args[1];
  if(!root||!path.isAbsolute(root)||root!==root.trim())usage();
  const filename=path.join(root,'workspace.sqlite');
  if(!fs.existsSync(filename)||!fs.lstatSync(filename).isFile()||fs.lstatSync(filename).isSymbolicLink())throw Error('Initialized workspace.sqlite required; standalone publication does not need bundle indexing');
  const check=new Database(filename,{readonly:true,fileMustExist:true});
  try {if(check.pragma('user_version',{simple:true})!==8)throw Error('Bundle administration requires schema 8; coordinate an offline upgrade before publishing with this version');}finally {check.close();}
  const store=new SqliteWorkspaceStore(root);
  try {
    const registry=createBundleRegistry({db:store.db,root});
    const result=command==='refresh'?registry.refresh():registry.cleanupPlan();
    console.log(JSON.stringify(result));
  } finally {store.close();}
}

try {main(process.argv.slice(2));}
catch(error) {console.error(error.category||error.message);process.exitCode=1;}
