import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {Readable} from 'node:stream';
import {fixedSshExchange,ownerRelay} from '../server/rails-owner-relay.mjs';

const workspace=randomUUID();
const draft={workspace_id:workspace,target_event_id:'ev-1',idempotency_key:randomUUID(),category:'quality',rating:1,note:''};
function request(body,overrides={}){
  const bytes=Buffer.from(JSON.stringify(body));
  return Object.assign(Readable.from([bytes]),{url:'/api/rizzstack/rails/feedback',
    headers:{'content-length':String(bytes.length),'content-type':'application/json'},...overrides});
}

test('an absent transport or unregistered/held workspace cannot reach the writer',async()=>{
  assert.equal(fixedSshExchange({}),null);
  assert.equal(ownerRelay({workspace,workspaceRead:()=>{},exchange:null}),null);
  for(const record of [null,{id:randomUUID(),recovery_policy:{held:false}},{id:workspace},{id:workspace,recovery_policy:{held:true}}]){
    let calls=0;
    const send=ownerRelay({workspace,workspaceRead:()=>record,exchange:async()=>{calls++;}});
    await assert.rejects(send(request({action:'preview',draft})),{code:'forbidden'});
    assert.equal(calls,0);
  }
});

test('the relay accepts only bounded quality operations, never an unsigned confirmation',async()=>{
  let calls=0;
  const send=ownerRelay({workspace,workspaceRead:()=>({id:workspace,recovery_policy:{held:false}}),exchange:async()=>{calls++;}});
  for(const body of [{action:'preview',draft:{...draft,note:'raw prose'}},{action:'retry',draft},
    {action:'confirm',review:'{}'},{action:'preview',draft:{...draft,authority:'owner_record'}}]){
    await assert.rejects(send(request(body)),{code:'invalid_request'});
  }
  await assert.rejects(send(request({action:'preview',draft},{url:'/api/rizzstack/rails/feedback?actor=owner'})),{code:'invalid_request'});
  await assert.rejects(send(request({action:'preview',draft:{...draft,workspace_id:randomUUID()}})),{code:'forbidden'});
  await assert.rejects(send(request({action:'preview',draft:{...draft,note:'x'.repeat(8192)}})),{code:'too_large'});
  assert.equal(calls,0);
});
