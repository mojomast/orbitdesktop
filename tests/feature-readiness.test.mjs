import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {observeFeatureReadiness} from '../server/feature-readiness.mjs';
import {featureCapabilities} from '../contracts/feature-capabilities.mjs';
import {VOICE_MODEL,VOICE_REVISION,VOICE_FILES} from '../server/voice-model-assets.mjs';
import {MODEL_FILES} from '../server/knowledge-model.mjs';
import {DATA_ENGINE_FILES,DATA_ENGINE_VERSION,DATA_ENGINE_PLATFORM} from '../server/data-engine-assets.mjs';
import {createTechnologyReadiness} from '../src/technology-readiness.ts';

test('request-time metadata observes assets/config without private libraries or claiming execution',()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'orbit-readiness-'));
  try{
    const env={}, options={root,runtimeRoot:root,env,now:()=>1000};
    const before=observeFeatureReadiness(options);
    assert.equal(before.features['voice-transcript'].state,'missing_prerequisite');
    assert.equal(before.features['mcp-apps'].state,'missing_prerequisite');
    assert.equal(before.features['browser-copilot'].state,'missing_prerequisite');
    assert.equal(before.features['data-workbench'].state,'missing_prerequisite');
    assert.equal(before.features['knowledge-search'].prerequisites[0].state,'missing_or_invalid');
    const sized=(file,size)=>{fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,'');fs.truncateSync(file,size);};
    for(const [name,[size]] of Object.entries(VOICE_FILES)){
      const file=path.join(root,'models',VOICE_MODEL,'resolve',VOICE_REVISION,name);
      sized(file,size);
    }
    for(const [name,size] of MODEL_FILES)sized(path.join(root,'knowledge-index/model',name),size);
    for(const file of Object.values(DATA_ENGINE_FILES))sized(path.join(root,'engines/duckdb',DATA_ENGINE_VERSION,DATA_ENGINE_PLATFORM,file.file),file.bytes);
    for(const name of ['duckdb-eh.wasm','duckdb-browser-eh.worker.js'])sized(path.join(root,'node_modules/@duckdb/duckdb-wasm/dist',name),10);
    env.ORBIT_BROWSER_EXECUTABLE=path.join(root,'PRIVATE-EXECUTABLE');fs.writeFileSync(env.ORBIT_BROWSER_EXECUTABLE,'not executable');
    env.ORBIT_BROWSER_ALLOWED_ORIGINS='https://PRIVATE-ORIGIN.invalid';
    const after=observeFeatureReadiness({...options,mcpConfigured:true,now:()=>2000});
    assert.equal(after.features['voice-transcript'].state,'unknown');
    assert.equal(after.features['browser-copilot'].state,'unknown');
    assert.equal(after.features['mcp-apps'].state,'unknown');
    assert.equal(after.features['data-workbench'].state,'unknown');
    assert.ok(after.features['data-workbench'].prerequisites.every(x=>x.state==='present_unverified'));
    assert.equal(after.features['knowledge-search'].prerequisites[0].state,'present_unverified');
    assert.notEqual(before.observed_at,after.observed_at);
    const owner=featureCapabilities({audience:'owner',observation:after}), controller=featureCapabilities({observation:after});
    assert.deepEqual(owner.features.map(x=>x.readiness),controller.features.map(x=>x.readiness));
    for(const item of controller.features){assert.equal(item.content.availability,'not_granted');assert.equal(item.execution_verified,false);assert.notEqual(item.delegated.availability,'granted');if(item.schema_ref)assert.ok(fs.existsSync(item.schema_ref));}
    assert.ok(!JSON.stringify(owner).includes('PRIVATE'));assert.ok(!JSON.stringify(owner).includes(root));
    assert.deepEqual(fs.readdirSync(root).sort(),['PRIVATE-EXECUTABLE','engines','knowledge-index','models','node_modules']);
    fs.unlinkSync(env.ORBIT_BROWSER_EXECUTABLE);
    assert.equal(observeFeatureReadiness(options).features['browser-copilot'].state,'missing_prerequisite');
  }finally{fs.rmSync(root,{recursive:true,force:true});}
});

test('shell rejects credential/workspace/overlapping responses and expired observations',async()=>{
  let identity={token:'first',workspace:'A'},clock=1000;const pending=[];
  const client=createTechnologyReadiness(()=>identity,()=>{},()=>new Promise(resolve=>pending.push(resolve)),()=>clock);
  const response=detail=>({ok:true,json:async()=>({descriptors:{observed_at:new Date(clock).toISOString(),features:[{surface_uri:'orbit://surface/voice',readiness:{detail},formats:['audio']}]}})});
  const first=client.refresh();identity={token:'second',workspace:'B'};const second=client.refresh();
  pending[1](response('current'));await second;pending[0](response('obsolete'));await first;
  assert.match(client.detail('voice','fallback'),/current/);assert.doesNotMatch(client.detail('voice','fallback'),/obsolete/);
  const older=client.refresh(true),newer=client.refresh(true);pending[3](response('new config'));await newer;pending[2](response('old config'));await older;
  assert.match(client.detail('voice','fallback'),/new config/);
  clock+=30001;assert.match(client.detail('voice','fallback'),/Prerequisites unknown/);
  const stale=client.refresh(true);pending[4]({ok:true,json:async()=>({descriptors:{observed_at:new Date(0).toISOString(),features:[]}})});await stale;
  assert.match(client.detail('voice','fallback'),/Prerequisites unknown/);
  identity={token:'',workspace:'B'};assert.doesNotMatch(client.detail('voice','fallback'),/new config/);
});
