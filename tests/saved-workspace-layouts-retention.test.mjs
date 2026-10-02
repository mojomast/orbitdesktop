import test from 'node:test';
import assert from 'node:assert/strict';
import {clearRetainedCommand,clearRetainedEnvelope,retainedCommandMatches} from '../src/saved-workspace-layouts-retention.ts';

test('late X completion and discard cannot clear retained Y, including same ID with changed payload',()=>{
  const key='workspace-key',x={workspace_id:'workspace',operation_id:'X',payload:{width:800,height:600}},y={...x,operation_id:'Y'};
  let raw=JSON.stringify(x),removals=0;
  const storage={getItem:k=>k===key?raw:null,removeItem:k=>{assert.equal(k,key);removals++;raw=null;}};
  const discardSnapshot=raw;raw=JSON.stringify(y);
  assert.equal(clearRetainedCommand(storage,key,x),false);assert.equal(clearRetainedEnvelope(storage,key,discardSnapshot),false);assert.equal(raw,JSON.stringify(y));assert.equal(removals,0);
  raw=JSON.stringify({...x,payload:{width:900,height:600}});
  assert.equal(clearRetainedCommand(storage,key,x),false);assert.equal(removals,0);
  raw=JSON.stringify({payload:{height:600,width:800},operation_id:'X',workspace_id:'workspace'});
  assert.equal(retainedCommandMatches(raw,x),true);assert.equal(clearRetainedCommand(storage,key,x),true);assert.equal(raw,null);assert.equal(removals,1);
  assert.equal(clearRetainedCommand(storage,key,x),false);
});
test('explicit corrupt-envelope discard is compare-before-clear and storage failures propagate',()=>{
  let raw='corrupt X';const storage={getItem:()=>raw,removeItem:()=>{raw=null;}};
  assert.equal(retainedCommandMatches(raw,{workspace_id:'w',operation_id:'X'}),false);
  assert.equal(clearRetainedEnvelope(storage,'k','corrupt X'),true);
  assert.equal(clearRetainedEnvelope(storage,'k',null),false);
  assert.throws(()=>clearRetainedCommand({getItem(){throw Error('Storage unavailable');},removeItem(){}},'k',{workspace_id:'w',operation_id:'X'}),/Storage unavailable/);
});
