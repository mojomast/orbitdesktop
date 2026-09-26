import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {verifyRelease,checkCompatibility,currentSchemaVersion} from '../scripts/release_launch.mjs';
import {assertSeparatedRoots} from '../scripts/release_roots.mjs';

// Resolve once at startup. Requests never follow a mutable active-release pointer.
// A development checkout remains usable without pretending to be a pinned release.
export async function pinnedReleaseIdentity({env=process.env,sourceRoot=fileURLToPath(new URL('../',import.meta.url))}={}){
  const fields=['ORBIT_RELEASE_ROOT','ORBIT_RELEASE_ID','ORBIT_RELEASE_INTEGRITY'];
  if(!fields.some(key=>env[key]!==undefined))return null;
  if(fields.some(key=>typeof env[key]!=='string'||!env[key].trim())||typeof env.ORBIT_RUNTIME_DIR!=='string'||!path.isAbsolute(env.ORBIT_RUNTIME_DIR))throw Error('Complete pinned release and external runtime configuration required');
  const {root,manifest}=verifyRelease(env.ORBIT_RELEASE_ROOT);
  if(fs.realpathSync(sourceRoot)!==root||manifest.release_id!==env.ORBIT_RELEASE_ID||manifest.integrity!==env.ORBIT_RELEASE_INTEGRITY)throw Error('Pinned release identity does not match the running source');
  assertSeparatedRoots({runtime:env.ORBIT_RUNTIME_DIR,release:root});
  const {schema_version}=await currentSchemaVersion(env.ORBIT_RUNTIME_DIR);
  checkCompatibility({manifest,schema_version});
  return Object.freeze({release_id:manifest.release_id,manifest_integrity:manifest.integrity});
}
