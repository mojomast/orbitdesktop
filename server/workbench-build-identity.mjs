import fs from 'node:fs';
import {createHash} from 'node:crypto';

// Match the Doctor source identity exactly. Source bytes, not git HEAD or a
// caller-supplied build label, identify the service that recorded an outcome.
export function workbenchBuildIdentity(){
  const hash=createHash('sha256');
  for(const directory of ['./','../contracts/'])for(const name of fs.readdirSync(new URL(directory,import.meta.url)).filter(name=>name.endsWith('.mjs')&&name!=='mobile-proxy.mjs').sort()){
    hash.update(directory+name+'\0');hash.update(fs.readFileSync(new URL(directory+name,import.meta.url)));
  }
  return hash.digest('hex');
}
