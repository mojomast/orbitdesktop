import {test} from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import Ajv from 'ajv';
import {contract} from '../contracts/workspace-v1.mjs';
import {initial} from '../src/model.ts';
import {createWorkspaceService} from '../server/workspace.mjs';

test('real HTTP contract rejects extra fields, byte overflow and type coercion without writes; Unicode survives chunk boundaries',async t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'orbit-protocol-')),token=randomUUID(),workspace_id=randomUUID();
  let service;
  const server=http.createServer((req,res)=>service.handle(req,res,req.url==='/control'));
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const port=server.address().port,origin=`http://127.0.0.1:${port}`;
  service=createWorkspaceService({root,port,token,devOrigins:[],reply:(res,status,body)=>{res.writeHead(status,{'Content-Type':'application/json'});res.end(JSON.stringify(body));}});
   t.after(async()=>{await new Promise(resolve=>server.close(resolve));service.close();fs.rmSync(root,{recursive:true,force:true});});
  async function send(body,options={}) {
    const bytes=options.bytes||Buffer.from(JSON.stringify({workspace_id,...body}));
    return await new Promise((resolve,reject)=>{
      const request=http.request(origin+(options.control?'/control':'/workspace'),{method:'POST',headers:{Origin:origin,Authorization:`Bearer ${options.capability||token}`}},res=>{
        let text='';res.setEncoding('utf8');res.on('data',part=>text+=part);res.on('end',()=>resolve({status:res.statusCode,body:JSON.parse(text)}));
      });
      request.on('error',reject);
      if(options.split) {request.write(bytes.subarray(0,options.split));setImmediate(()=>request.end(bytes.subarray(options.split)));}
      else request.end(bytes);
    });
  }
  const seeded=await send({action:'sync',state:initial()});assert.equal(seeded.status,200);
   const original=service.store.read(workspace_id);
   const capability=original.capability,control={control:true,capability};
  for(const body of [
    {action:'read',actor:'administrator'},
    {action:'apply',base_revision:'1',operations:[{action:'sidebar',hidden:true}]},
    {action:'apply',base_revision:1,operations:[{action:'sidebar',hidden:true,secret:'fixture-secret'}]},
    {action:'apply',base_revision:1,operations:[{action:'sidebar',hidden:'true'}]},
    {action:'apply',base_revision:1,operations:Array(33).fill({action:'sidebar',hidden:true})},
  ]) {
    const result=await send(body,control);assert.equal(result.status,400);assert.equal(result.body.category,'INVALID_OPERATION');
    assert.ok(!JSON.stringify(result.body).includes('fixture-secret'));
     assert.deepEqual(service.store.read(workspace_id),original);
  }
  const tooLarge=Buffer.from(' '.repeat(contract.limits.maxRequestBytes+1));
  assert.equal((await send({}, {...control,bytes:tooLarge})).body.category,'REQUEST_TOO_LARGE');
   const state=original.state,window_id=state.monitors[0].id;
  const body={workspace_id,action:'apply',base_revision:1,operations:[{action:'update_window',window_id,name:'界😀 fixture'}]};
  const bytes=Buffer.from(JSON.stringify(body)),split=bytes.indexOf(Buffer.from('界'))+1;
  const result=await send(body,{...control,bytes,split});
  assert.equal(result.status,200);assert.equal(result.body.state.monitors[0].name,'界😀 fixture');
  const ajv=new Ajv({strict:true});
  const output=ajv.compile({$defs:contract.schema.$defs,...contract.commands.apply.output});
  assert.equal(output(result.body),true,JSON.stringify(output.errors));
  assert.equal(result.body.revision,2);
});
