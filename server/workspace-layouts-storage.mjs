import fs from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';

// One bounded atomic catalog per workspace. No credentials or pane content.
export function createLayoutStorage(root) {
  const directory=path.join(root,'saved-workspace-layouts');
  function privateDirectory(dir) {
    if(fs.existsSync(dir)&&(!fs.lstatSync(dir).isDirectory()||fs.lstatSync(dir).isSymbolicLink()))throw Error('Invalid layout storage');
    fs.mkdirSync(dir,{recursive:true,mode:0o700});fs.chmodSync(dir,0o700);
  }
  function file(workspace) {
    if(!/^[a-f0-9-]{36}$/i.test(workspace))throw Error('Invalid workspace');
    privateDirectory(directory);return path.join(directory,workspace+'.json');
  }
  function read(workspace) {
    const target=file(workspace);if(!fs.existsSync(target))return [];
    const stat=fs.lstatSync(target);
    if(!stat.isFile()||stat.isSymbolicLink()||stat.size>1048576)throw Error('Invalid layout catalog');
    const catalog=JSON.parse(fs.readFileSync(target,'utf8'));
    if(!Array.isArray(catalog)||catalog.length>32)throw Error('Invalid layout catalog');
    return catalog;
  }
  function write(workspace,catalog) {
    const target=file(workspace),temporary=path.join(directory,'.write-'+randomUUID()),bytes=JSON.stringify(catalog);
    if(catalog.length>32||Buffer.byteLength(bytes)>1048576)throw Error('Layout catalog limit reached');
    const fd=fs.openSync(temporary,'wx',0o600);
    try {
      fs.writeFileSync(fd,bytes);fs.fsyncSync(fd);fs.closeSync(fd);fs.renameSync(temporary,target);
      const directoryFd=fs.openSync(directory,'r');try{fs.fsyncSync(directoryFd);}finally{fs.closeSync(directoryFd);}
    } finally {try{fs.closeSync(fd);}catch{}fs.rmSync(temporary,{force:true});}
  }
  return {read,write};
}
