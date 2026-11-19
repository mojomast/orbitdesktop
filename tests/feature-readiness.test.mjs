import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {observeFeatureReadiness} from '../server/feature-readiness.mjs';
import {featureCapabilities} from '../contracts/feature-capabilities.mjs';
import {MODEL_FILES} from '../server/knowledge-model.mjs';
import {createTechnologyReadiness} from '../src/technology-readiness.ts';

test('request-time metadata observes assets/config without private libraries or claiming execution',()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'orbit-readiness-'));
  try{
    const options={root,runtimeRoot:root,now:()=>1000};
    const before=observeFeatureReadiness(options);
    assert.equal(before.features['knowledge-search'].prerequisites[0].state,'missing_or_invalid');
    const sized=(file,size)=>{fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,'');fs.truncateSync(file,size);};
    for(const [name,size] of MODEL_FILES)sized(path.join(root,'knowledge-index/model',name),size);
    const after=observeFeatureReadiness({...options,now:()=>2000});
    assert.equal(after.features['knowledge-search'].state,'unknown');
    assert.equal(after.features['knowledge-search'].prerequisites[0].state,'present_unverified');
    assert.notEqual(before.observed_at,after.observed_at);
    const owner=featureCapabilities({audience:'owner',observation:after}), controller=featureCapabilities({observation:after});
    assert.deepEqual(owner.features.map(x=>x.readiness),controller.features.map(x=>x.readiness));
    assert.equal(controller.features.find(x=>x.feature_id==='run-traces').surface_uri,'orbit://surface/traces');
    for(const item of controller.features){assert.equal(item.content.availability,'not_granted');assert.equal(item.execution_verified,false);assert.notEqual(item.delegated.availability,'granted');if(item.schema_ref)assert.ok(fs.existsSync(item.schema_ref));}
    assert.ok(!JSON.stringify(owner).includes(root));
  }finally{fs.rmSync(root,{recursive:true,force:true});}
});

test('shell rejects credential/workspace/overlapping responses and expired observations',async()=>{
  let identity={token:'first',workspace:'A'},clock=1000;const pending=[];
  const client=createTechnologyReadiness(()=>identity,()=>{},()=>new Promise(resolve=>pending.push(resolve)),()=>clock);
  const response=detail=>({ok:true,json:async()=>({descriptors:{observed_at:new Date(clock).toISOString(),features:[{surface_uri:'orbit://surface/traces',readiness:{detail},formats:['JSON']}]}})});
  const first=client.refresh();identity={token:'second',workspace:'B'};const second=client.refresh();
  pending[1](response('current'));await second;pending[0](response('obsolete'));await first;
  assert.match(client.detail('orbit://surface/traces','fallback'),/current/);assert.doesNotMatch(client.detail('orbit://surface/traces','fallback'),/obsolete/);
  const older=client.refresh(true),newer=client.refresh(true);pending[3](response('new config'));await newer;pending[2](response('old config'));await older;
  assert.match(client.detail('orbit://surface/traces','fallback'),/new config/);
  clock+=30001;assert.match(client.detail('orbit://surface/traces','fallback'),/Prerequisites unknown/);
  const stale=client.refresh(true);pending[4]({ok:true,json:async()=>({descriptors:{observed_at:new Date(0).toISOString(),features:[]}})});await stale;
  assert.match(client.detail('orbit://surface/traces','fallback'),/Prerequisites unknown/);
  identity={token:'',workspace:'B'};assert.doesNotMatch(client.detail('orbit://surface/traces','fallback'),/new config/);
});
