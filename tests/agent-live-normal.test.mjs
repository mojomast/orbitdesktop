import test from 'node:test';
import assert from 'node:assert/strict';
import {createNormalLiveAdapter} from '../src/agent-live-normal.ts';

test('Normal adapter normalizes times to milliseconds and never retains private provider fields',()=>{
  const items=new Map(),timeline={upsert:rows=>rows.forEach(row=>items.set(row.id,row)),reset:()=>items.clear(),setConnection(){}};
  const adapter=createNormalLiveAdapter(timeline);adapter.reset('binding-a');
  const at=1790000000000;
  for(const [id,timestamp] of [['seconds',at/1000],['milliseconds',at],['iso',new Date(at).toISOString()]]){
    adapter.event({event:'tool.completed',tool:'candidate_read',tool_call_id:id,timestamp,duration:1.25,arguments:{secret:'SECRET'},output:'SECRET',reasoning_content:'SECRET'});
  }
  assert.equal(items.size,3);
  for(const item of items.values()){assert.equal(item.at,at);assert.equal(item.duration_ms,1250);assert.equal(item.authority,'observed');assert.equal(JSON.stringify(item).includes('SECRET'),false);}
  adapter.event({event:'tool.denied',tool:'shell',tool_call_id:'denied',timestamp:at});
  assert.equal([...items.values()].at(-1).status,'denied');
  adapter.reset('binding-b');assert.equal(items.size,0,'binding reset cannot leak another conversation activity');
});
