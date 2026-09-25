import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

// Compatibility boundary, NOT a transactional database. Checkpoints remain separate.
// A future SQLite store must retain original records and migrate once under one writer.
export class JsonWorkspaceStore {
  constructor(root) {
    this.directory = path.join(root, 'workspaces');
    fs.mkdirSync(this.directory, {recursive:true,mode:0o700});
  }
  filename(id) {
    if(typeof id!=='string'||!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(id))throw Error('Invalid workspace id');
    return path.join(this.directory,`${id}.json`);
  }
  read(id) { return JSON.parse(fs.readFileSync(this.filename(id),'utf8')); }
  write(record) {
    const file=this.filename(record.id),temporary=`${file}.${randomUUID()}.tmp`;
    try {
      fs.writeFileSync(temporary,JSON.stringify(record),{mode:0o600,flag:'wx'});
      fs.renameSync(temporary,file);
    } finally { fs.rmSync(temporary,{force:true}); }
  }
}
