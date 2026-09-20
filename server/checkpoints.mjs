import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
export function checkpointStore(root) {
 const dir=path.join(root,'checkpoints');fs.mkdirSync(dir,{recursive:true,mode:0o700});
 const folder=id=>{if(!/^[a-f0-9-]{36}$/.test(id))throw Error('Invalid workspace');const p=path.join(dir,id);fs.mkdirSync(p,{recursive:true,mode:0o700});return p;};
 function list(id){return fs.readdirSync(folder(id)).filter(n=>n.endsWith('.json')).map(n=>JSON.parse(fs.readFileSync(path.join(folder(id),n),'utf8'))).sort((a,b)=>b.created-a.created);}
 function save(record,label){const entry={id:randomUUID(),created:Date.now(),label:String(label||'Checkpoint').slice(0,160),revision:record.revision,state:record.state};const file=path.join(folder(record.id),entry.id+'.json');fs.writeFileSync(file+'.tmp',JSON.stringify(entry),{mode:0o600});fs.renameSync(file+'.tmp',file);return entry;}
 function get(id,key){if(!/^[a-f0-9-]{36}$/.test(key||''))throw Error('Invalid checkpoint');return JSON.parse(fs.readFileSync(path.join(folder(id),key+'.json'),'utf8'));}
 return {save,get,list:id=>list(id).map(({state,...meta})=>meta)};
}
