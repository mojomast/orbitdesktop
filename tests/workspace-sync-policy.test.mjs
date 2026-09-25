import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import {randomUUID} from 'node:crypto';

// Execute the real sync module in a disposable browser-like environment. Only
// transport, appearance DOM writes and scheduling are replaced; no owner profile.
function fixture(responses,{storageFailure=false}={}) {
  const requests=[],statuses=[],storage=new Map(),applied=[];
  const listeners=new Map(),lifecycle={started:0,closed:0,intervals:0};
  let state={plugins:[],monitors:[]};
  const exports={};
  const context=vm.createContext({exports,crypto:{randomUUID},
    localStorage:{getItem:key=>storage.get(key),setItem:(key,value)=>{if(storageFailure)throw Error('quota');storage.set(key,value);}},
    document:{querySelectorAll:()=>[],querySelector:()=>null},
    window:{addEventListener:(name,callback)=>listeners.set(name,callback)},setInterval:()=>++lifecycle.intervals,clearInterval:()=>{},setTimeout:()=>1,clearTimeout:()=>{},
    require:name=>{
      if(name==='./workspace-appearance')return {applyAppearance:()=>{}};
      if(name==='./workspace-events')return {connectWorkspaceEvents:()=>{lifecycle.started++;return {close:()=>{lifecycle.closed++;},poll:async()=>{}};}};
      if(name==='./workspace-client')return {workspaceFetch:async(_token,body)=>{
        requests.push(body);const next=responses.shift();assert.ok(next,'Unexpected extra request');
        if(next.transportError)throw Error('timeout');
        return {ok:next.status===200,status:next.status,json:async()=>{if(next.invalidJson)throw Error('invalid JSON');return next.body;}};
      }};
      throw Error(`Unexpected import ${name}`);
    },
  });
  const source=fs.readFileSync(new URL('../src/workspace-sync.ts',import.meta.url),'utf8');
  vm.runInContext(ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,context);
  const connection=exports.connectWorkspace(()=>state,next=>{state=next;applied.push(next);},()=> 'fixture-token',message=>statuses.push(message));
  return {connection,flush:exports.ensureWorkspaceSynced,requests,statuses,storage,applied,lifecycle,dispatch:name=>listeners.get(name)?.(),edit:next=>{state=next;connection.changed();}};
}
for(const category of ['RECOVERY_HOLD','RECOVERY_POLICY_CHANGED'])test(`${category} forces a read, backs up local state, never retries the mutation`,async()=>{
  const saved={plugins:[],monitors:[]},local={plugins:[{enabled:true}],monitors:[]};
  const fixtureState=fixture([
    {status:200,body:{state:saved,revision:3}},
    {status:409,body:{category,error:'Recovery policy blocked activation'}},
    {status:200,body:{state:saved,revision:3,recovery_policy:{held:true,generation:1}}},
    {status:200,body:{state:saved,revision:3,recovery_policy:{held:true,generation:1}}},
  ]);
  await fixtureState.connection.sync();fixtureState.edit(local);
  await assert.rejects(fixtureState.connection.sync(),/Recovery policy blocked/);
  assert.deepEqual(JSON.parse(fixtureState.storage.get('orbit.workspace.conflict-backup')),local);
  await fixtureState.connection.sync();await fixtureState.connection.sync();
  assert.deepEqual(fixtureState.requests.map(body=>body.action),['read','sync','read','read']);
  assert.equal(fixtureState.applied.length,2);
  assert.match(fixtureState.statuses.at(-1),/recovery hold active/);
});

for(const failure of [{transportError:true},{status:200,invalidJson:true},{status:503,body:{error:'busy'}}])test(`uncertain ${JSON.stringify(failure)} save is backed up and blocks dependent actions`,async()=>{
  const saved={plugins:[],monitors:[]},local={...saved,arc:12};
  const f=fixture([{status:200,body:{state:saved,revision:3}},failure,
    {status:200,body:{state:saved,revision:3}},{status:200,body:{state:saved,revision:3}}]);
  await f.connection.sync();f.edit(local);await assert.rejects(f.connection.sync());
  assert.deepEqual(JSON.parse(f.storage.get('orbit.workspace.conflict-backup')),local);
  await assert.rejects(f.flush(),/save is unresolved/);
  assert.deepEqual(f.requests.map(body=>body.action),['read','sync','read','read']);
  assert.match(f.statuses.at(-1),/Local backup saved/);
});
test('failed local backup is disclosed rather than claiming saved recovery data',async()=>{
  const state={plugins:[],monitors:[]};
  const f=fixture([{status:200,body:{state,revision:3}},{transportError:true},{status:200,body:{state,revision:3}}],{storageFailure:true});
  await f.connection.sync();f.edit({...state,arc:12});await assert.rejects(f.connection.sync());await f.connection.sync();
  assert.equal(f.storage.has('orbit.workspace.conflict-backup'),false);
  assert.match(f.statuses.at(-1),/backup unavailable/);
});

test('pagehide suspends both polling paths and pageshow restarts them once',()=>{
  const f=fixture([]);assert.deepEqual(f.lifecycle,{started:1,closed:0,intervals:1});
  f.dispatch('pagehide');assert.deepEqual(f.lifecycle,{started:1,closed:1,intervals:1});
  f.dispatch('pageshow');f.dispatch('pageshow');assert.deepEqual(f.lifecycle,{started:2,closed:1,intervals:2});
  f.dispatch('pagehide');assert.equal(f.lifecycle.closed,2);
});
