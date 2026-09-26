// Trusted parent harness. Candidate modules run only in node:test's children;
// their stdout/stderr are data, never the FD3 result protocol. This is not a
// same-UID sandbox or protection from hostile host filesystem access.
import fs from 'node:fs';
import path from 'node:path';
import {run} from 'node:test';
import {inspect} from 'node:util';

const files=JSON.parse(process.argv[2]);
if(!Array.isArray(files)||!files.length||files.length>512)throw Error('Invalid pinned test discovery');
let sequence=0,bytes=0,failed=false;
const emit=record=>{
  const line=JSON.stringify({version:1,sequence:sequence++,...record})+'\n';
  bytes+=Buffer.byteLength(line);
  if(bytes>262144)throw Error('Structured result limit exceeded');
  fs.writeSync(3,line);
};
emit({type:'start',files});
for await(const event of run({files:files.map(file=>path.resolve(file)),concurrency:1})){
  const d=event.data;
  if(event.type==='test:stdout'){process.stdout.write(d.message);continue;}
  if(event.type==='test:stderr'){process.stderr.write(d.message);continue;}
  if(event.type!=='test:pass'&&event.type!=='test:fail')continue;
  const file=typeof d.file==='string'?path.relative(process.cwd(),d.file):null;
  const wrapper=d.nesting===0&&d.name===d.file;
  const passed=event.type==='test:pass';
  if(!passed&&!d.todo){
    failed=true;
    // Readable failure context is a bounded log, not result protocol. Only the
    // actual event on FD3 contributes to the verification counts.
    const detail=inspect(d.details?.error,{depth:4,maxStringLength:4096,maxArrayLength:32,customInspect:false,getters:false});
    process.stderr.write(`FAIL ${String(d.name).slice(0,512)}\n${detail.slice(0,8192)}\n`);
  }
  emit({type:'result',file,kind:d.details?.type??'test',wrapper,passed,skip:!!d.skip,todo:!!d.todo});
}
emit({type:'end'});
if(failed)process.exitCode=1;
