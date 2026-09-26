import fs from 'node:fs';
import {createHash} from 'node:crypto';

// Match Doctor's source identity exactly. Snapshot once at module import: an
// on-disk source change while loaded code is serving cannot relabel its recorder.
export function createWorkbenchBuildIdentity(serverRoot=new URL('./',import.meta.url),contractRoot=new URL('../contracts/',import.meta.url)){
  const hash=createHash('sha256');
  for(const [directory,root] of [['./',serverRoot],['../contracts/',contractRoot]])for(const name of fs.readdirSync(root).filter(name=>name.endsWith('.mjs')&&name!=='mobile-proxy.mjs').sort()){
    hash.update(directory+name+'\0');hash.update(fs.readFileSync(new URL(name,root)));
  }
  const identity=hash.digest('hex');return ()=>identity;
}
export const workbenchBuildIdentity=createWorkbenchBuildIdentity();
