import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import {runCheck} from '../server/workbench-checks.mjs';

test('job temporary cleanup rejects a directory-to-symlink swap without deleting outside data',async t=>{
  const root=fs.mkdtempSync('/tmp/opencode/workbench-cleanup-');
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const candidate=path.join(root,'candidate'),outside=path.join(root,'outside');
  fs.mkdirSync(candidate);fs.mkdirSync(outside);fs.writeFileSync(path.join(outside,'keep'),'SYNTHETIC_OWNER_DATA');
  fs.writeFileSync(path.join(candidate,'package.json'),'{"type":"module"}');
  fs.writeFileSync(path.join(candidate,'math.js'),`import fs from 'node:fs';import path from 'node:path';
    fs.mkdirSync(path.join(process.env.HOME,'nested'),{recursive:true});
    fs.writeFileSync(path.join(process.env.HOME,'nested','generated'),'fixture');
    export const sum=(a,b)=>a+b;`);
  const rehash=()=>({hash:createHash('sha256').update(fs.readFileSync(path.join(candidate,'math.js'))).digest('hex')});
  const original=fs.openSync;let swapped=false;
  fs.openSync=function(file,...args){
    if(!swapped&&typeof file==='string'&&file.startsWith('/proc/self/fd/')&&file.endsWith('/nested')){
      fs.renameSync(file,file+'-held');fs.symlinkSync(outside,file);swapped=true;
    }
    return original.call(this,file,...args);
  };
  try{
    const result=await runCheck({definition_id:'host-regression',candidate_root:candidate,artifact_root:root,workspace_id:randomUUID(),project_id:randomUUID(),job_id:randomUUID(),rehash,spawn_record:()=>{}});
    assert.equal(result.exit_code,0);assert.equal(swapped,true);
    assert.equal(fs.readFileSync(path.join(outside,'keep'),'utf8'),'SYNTHETIC_OWNER_DATA');
  }finally{fs.openSync=original;}
});
