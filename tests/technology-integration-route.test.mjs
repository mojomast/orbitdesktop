import test from 'node:test';
import assert from 'node:assert/strict';
import {Readable} from 'node:stream';
import {technologyOwnerRoute,lazyTechnologyService} from '../server/technology-owner-route.mjs';
const token='x'.repeat(40);
async function request({bytes=Buffer.from('{}'),method='POST',auth=`Bearer ${token}`,origin='http://127.0.0.1:4318',dispatch=()=>({}),maxBytes=100,maxResponseBytes=1000}={}){
  let result;const req=Readable.from([bytes]);req.method=method;req.headers={host:'127.0.0.1:4318',origin,authorization:auth};
  await technologyOwnerRoute({token,port:4318,devOrigins:[],reply:(_res,status,body)=>{result={status,body};},dispatch,maxBytes,maxResponseBytes})(req,{setHeader(){}});
  return result;
}
test('owner boundary rejects method, credentials and hostile origins before dispatch',async()=>{
  const dispatch=()=>{throw Error('must not run');};
  assert.equal((await request({method:'GET',dispatch})).status,405);
  assert.equal((await request({auth:'Bearer wrong',dispatch})).status,403);
  assert.equal((await request({origin:'http://evil.test',dispatch})).status,403);
});
test('byte cap, strict UTF8, response cap and safe conflict revision',async()=>{
  assert.equal((await request({bytes:Buffer.from('"éé"'),maxBytes:5})).status,413);
  assert.equal((await request({bytes:Buffer.from([0x22,0xff,0x22])})).status,400);
  assert.equal((await request({dispatch:()=>({value:'x'.repeat(1000)}),maxResponseBytes:100})).status,413);
  const conflict=await request({dispatch:()=>{throw {code:'conflict',revision:7,message:'private',path:'/secret'};}});
  assert.equal(conflict.status,409);assert.equal(conflict.body.revision,7);assert.equal(JSON.stringify(conflict.body).includes('secret'),false);
});
test('lazy service single-flight and close during initialization disposes once',async()=>{
  let resolve,loaded=0,closed=0;
  const service=lazyTechnologyService(()=>{loaded++;return new Promise(r=>{resolve=r;});});
  const a=service.get(),b=service.get();await Promise.resolve();const closing=service.close();
  resolve({close(){closed++;},dispatch(){}});
  await assert.rejects(a);await assert.rejects(b);await closing;assert.equal(loaded,1);assert.equal(closed,1);
});
