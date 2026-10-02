import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {randomUUID} from 'node:crypto';
import {Readable} from 'node:stream';
import {createWorkspaceService} from '../server/workspace.mjs';
import {initial} from '../src/model.ts';
import {applyOperation} from '../src/workspace-ops.ts';
import {validateWorkspaceRequest} from '../server/workspace-contract.mjs';
import {checkpointChanges} from '../server/workspace-diff.mjs';
import {jevCandidates} from '../server/jev.mjs';

const manifest = {apiVersion:1,id:'notes',version:'1.0.0',title:'Notes',entry:'/apps/notes-v1/index.html'};
const features = ['plugin-instances-v1','plugin-config-schema-v1'];
function fixture(t) {
  const root = fs.mkdtempSync('/tmp/opencode/orbit-widget-compatibility-');
  const workspace_id = randomUUID(), token = 'isolated-widget-fixture', port = 4317;
  const service = createWorkspaceService({token,port,root,reply(res,status,body){res.status=status;res.end(JSON.stringify(body));}});
  t.after(()=>{service.close();fs.rmSync(root,{recursive:true,force:true});});
  async function call(body) {
    const req = Readable.from([Buffer.from(JSON.stringify({workspace_id,...body}))]);
    req.method='POST';req.headers={authorization:`Bearer ${token}`,host:`127.0.0.1:${port}`,origin:`http://127.0.0.1:${port}`};
    return new Promise((resolve,reject)=>{
      const res={status:0,end(value){resolve({status:this.status,body:JSON.parse(value)});}};
      service.handle(req,res).catch(reject);
    });
  }
  return {call,service,workspace_id};
}

test('browser feature fence protects instance identities even when an old browser learned the current revision',async t=>{
  const f=fixture(t), old=initial();
  assert.equal((await f.call({action:'sync',state:old})).status,200);
  const created=await f.call({action:'plugins_apply',base_revision:1,operations:[
    {action:'plugin_install',manifest}, {action:'plugin_duplicate',plugin_id:'notes',name:'Second notes'},
  ]});
  assert.equal(created.status,200,JSON.stringify(created.body));
  assert.equal(created.body.state.plugins.length,2);
  const before=f.service.read(f.workspace_id);
  const obsolete=await f.call({action:'sync',base_revision:before.revision,state:old});
  assert.equal(obsolete.status,409);assert.equal(obsolete.body.category,'UPGRADE_REQUIRED');
  assert.match(obsolete.body.error,/Reload Orbit/);
  assert.deepEqual(f.service.read(f.workspace_id),before);
  const state=structuredClone(before.state);state.arc=5;
  const accepted=await f.call({action:'sync',base_revision:before.revision,state,client_features:features});
  assert.equal(accepted.status,200);
  assert.deepEqual(accepted.body.state.plugins,before.state.plugins);
});

test('declared schema metadata cannot be erased by an unsupported browser sync',async t=>{
  const f=fixture(t), old=initial();
  await f.call({action:'sync',state:old});
  const created=await f.call({action:'plugins_apply',base_revision:1,operations:[{action:'plugin_install',manifest:{...manifest,configSchema:{fields:[{key:'title',type:'string',default:'Notes'}]}}}]});
  assert.equal(created.status,200,JSON.stringify(created.body));
  const before=f.service.read(f.workspace_id);
  const downgraded=structuredClone(before.state);delete downgraded.plugins[0].manifest.configSchema;
  const blocked=await f.call({action:'sync',base_revision:before.revision,state:downgraded,client_features:['plugin-instances-v1']});
  assert.equal(blocked.status,409);assert.equal(blocked.body.category,'UPGRADE_REQUIRED');
  assert.deepEqual(f.service.read(f.workspace_id),before);
});

test('owner plugin API enforces declared constraints independently of the form',async t=>{
  const f=fixture(t);
  await f.call({action:'sync',state:initial()});
  const schemaManifest={...manifest,configSchema:{fields:[{key:'count',type:'number',min:0,max:10,default:5}]}};
  const installed=await f.call({action:'plugins_apply',base_revision:1,operations:[{action:'plugin_install',manifest:schemaManifest}]});
  assert.equal(installed.status,200,JSON.stringify(installed.body));
  const before=f.service.read(f.workspace_id);
  const rejected=await f.call({action:'plugins_apply',base_revision:before.revision,operations:[{action:'plugin_patch_config',plugin_id:'notes',patch:{count:99}}]});
  assert.equal(rejected.status,400,JSON.stringify(rejected.body));
  assert.deepEqual(f.service.read(f.workspace_id),before);
});

test('selectors and declared metadata are closed contracts',()=>{
  const workspace_id=randomUUID();
  const envelope=op=>({workspace_id,action:'plugins_apply',base_revision:1,operations:[op]});
  assert.doesNotThrow(()=>validateWorkspaceRequest(envelope({action:'plugin_disable',instance_id:randomUUID()})));
  assert.throws(()=>validateWorkspaceRequest(envelope({action:'plugin_disable'})));
  assert.throws(()=>validateWorkspaceRequest(envelope({action:'plugin_update',instance_id:randomUUID(),manifest})));
  assert.throws(()=>validateWorkspaceRequest(envelope({action:'plugin_duplicate',plugin_id:'notes',copy_terminal:true})));
  assert.throws(()=>validateWorkspaceRequest(envelope({action:'plugin_install',manifest:{...manifest,configSchema:{fields:[{key:'name',type:'string',regex:'.*'}]}}})));
});

test('checkpoint comparisons and quick actions distinguish two instances of the same definition',()=>{
  let state=applyOperation(initial(),{action:'plugin_install',manifest});
  const one=structuredClone(state);
  state=applyOperation(state,{action:'plugin_duplicate',plugin_id:'notes',name:'Second notes'});
  const changes=checkpointChanges({state},{state:one}).changes;
  assert.equal(changes.filter(change=>change.target==='plugin'&&change.kind==='removed').length,1);
  assert.equal(changes.find(change=>change.target==='plugin'&&change.kind==='removed').label,'Second notes');
  const candidates=jevCandidates(state);
  assert.deepEqual(candidates.plugin_0.operations,[{action:'plugin_enable',plugin_id:'notes'}]);
  assert.equal(candidates.plugin_1.operations[0].instance_id,state.plugins[1].instance_id);
});
