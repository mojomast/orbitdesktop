import test from 'node:test';
import assert from 'node:assert/strict';
import {Readable} from 'node:stream';
import {EventEmitter} from 'node:events';
import {createWorkbenchLiveHandler} from '../server/workbench-live-route.mjs';

test('slow stream replays every page and catches commits during first write without buffering notifications',async()=>{
  const workspace_id='11111111-1111-4111-8111-111111111111',project_id='22222222-2222-4222-8222-222222222222';
  let listener=null,latest=70,reads=0,unsubscribed=0;
  const live={
    records:{project:()=>({generation:1})},snapshot:()=>({}),lane:()=>({}),dispatch(){throw Error('No execution');},
    subscribe(callback){listener=callback;return()=>{listener=null;unsubscribed++;};},
    page({after_sequence=0,limit=32}){reads++;const end=Math.min(latest,after_sequence+limit);return {version:1,project_generation:1,after_sequence:end,has_more:end<latest,reset_required:false,events:Array.from({length:end-after_sequence},(_,i)=>({sequence:after_sequence+i+1}))};},
  };
  const res=new EventEmitter();let blocked=true;const writes=[];
  res.setHeader=()=>{};res.writeHead=()=>{};res.end=()=>res.emit('close');
  res.destroy=()=>res.emit('close');
  res.write=text=>{writes.push(text);if(blocked){assert.ok(listener,'subscription installed before potentially blocking first write');latest=75;listener({workspace_id,project_id,sequence:75});return false;}return true;};
  const req=Readable.from([JSON.stringify({action:'stream',workspace_id,project_id})]);req.method='POST';req.headers={authorization:'Bearer owner',host:'127.0.0.1:54321',origin:'http://127.0.0.1:54321'};
  const handler=createWorkbenchLiveHandler({live,token:'owner',port:54321,devOrigins:[],reply(){throw Error('Unexpected refusal');},heartbeatMs:60000});
  await handler(req,res);assert.equal(writes.length,1);assert.equal(reads,1);
  for(let i=0;i<10000;i++)listener({workspace_id,project_id,sequence:75});
  assert.equal(writes.length,1,'slow response cannot accumulate parallel writes');
  blocked=false;res.emit('drain');await new Promise(resolve=>setImmediate(resolve));
  const events=writes.flatMap(text=>JSON.parse(text.split('data: ')[1]).events);
  assert.deepEqual(events.map(item=>item.sequence),Array.from({length:75},(_,i)=>i+1));
  assert.equal(res.listenerCount('drain'),0);assert.equal(res.listenerCount('close'),1);
  handler.close();assert.equal(unsubscribed,1);assert.equal(listener,null);
});
