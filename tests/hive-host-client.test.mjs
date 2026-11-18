import assert from 'node:assert/strict';
import {test} from 'node:test';
import {fixtures, fixtureTime} from '../apps/rizzstack-hive/fixtures.js';
import {project} from '../apps/rizzstack-hive/snapshot-adapter.js';

test('navigation requires a bounded view followed by connected on this active document channel',async t=>{
  // Exercise protocol ordering independently of whether the UI happens to hide
  // an Open Rails button. This mock has no token, network or receiver privileges.
  let port;
  const outbound=[], states=[], views=[];
  const globals={location:{hash:'#orbit-hive-document=00000000-0000-4000-9000-000000000000'},
    self:{}, parent:{postMessage(){}}, document:{createElement(){return {};},head:{prepend(){}}},addEventListener(){},
    MessageChannel:class {constructor(){this.port2={};this.port1=port={postMessage:d=>outbound.push(d),close(){}};}}};
  for (const [key,val] of Object.entries(globals)) {const old=Object.getOwnPropertyDescriptor(globalThis,key);Object.defineProperty(globalThis,key,{configurable:true,value:val});
    t.after(()=>{if(old)Object.defineProperty(globalThis,key,old);else delete globalThis[key];});}
  const {connectHost}=await import('../apps/rizzstack-hive/host-client.js');
  let admission='new';
  const client={onStatus:s=>states.push(s),onView:v=>{views.push(v);return admission;},onReturnFocus(){}};
  let handle=connectHost(client);const open=()=>handle.openRails('attempt','att_digest');
  const send=data=>port.onmessage({data});
  const view=project(fixtures.shift,{now:fixtureTime});
  for(const data of [{}, {type:'unknown'}, {type:'status',value:'connected'}, {type:'view',view},
    {type:'status',value:'loading'},{type:'view',view:{}},{type:'status',value:'connected'},
    {type:'status',value:'connected',other:true}]) {send(data);assert.equal(open(),false);}
  assert.equal(views.length,0);assert.equal(outbound.length,0);
  send({type:'view',view});assert.equal(views.length,0);assert.equal(open(),false);
  send({type:'status',value:'connected'});assert.equal(views.length,1);assert.equal(open(),true);
  admission='old';send({type:'status',value:'loading'});send({type:'view',view});send({type:'status',value:'connected'});
  assert.equal(states.at(-1),'out of order');assert.equal(open(),false);admission='new';
  handle.close();assert.equal(open(),false);
  handle=connectHost(client);send({type:'status',value:'connected'});assert.equal(open(),false);
  for(const status of ['unavailable','unauthorized','disconnected','loading']) {
    send({type:'status',value:'loading'});send({type:'view',view});send({type:'status',value:'connected'});assert.equal(open(),true);
    send({type:'status',value:status});assert.equal(open(),false);
  }
  port.onmessageerror();assert.equal(open(),false);assert.equal(states.at(-1),'unauthorized');
});
