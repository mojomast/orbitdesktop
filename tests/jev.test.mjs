import {test} from 'node:test';import assert from 'node:assert/strict';import {jevSuggest,jevCandidates} from '../server/jev.mjs';
const state={monitors:[{name:'PRIVATE',layout:{url:'secret'}}],plugins:[],view:'windows'};
const reply=(confidence=0.99)=>new Response(JSON.stringify({answers:{action:{type:'choice',choice:'spatial',confidence,probabilities:Object.fromEntries(Object.keys(jevCandidates(state)).map(k=>[k,k==='spatial'?1:0]))},ambiguous:{type:'noul',noul:0.01}}}));
test('Jev adapter sends typed fanout and minimal state; returns deterministic operation',async()=>{
 let calls=0;const result=await jevSuggest(state,'switch to 3D','test-key',true,async(url,opts)=>{calls++;assert.equal(url,'https://api.typesafe.ai/v1/systemone');const p=JSON.parse(opts.body);assert.equal(p.questions.action.type,'choice');assert.equal(p.questions.ambiguous.type,'noul');assert.ok(!opts.body.includes('PRIVATE'));assert.ok(!opts.body.includes('secret'));return reply();});assert.equal(calls,1);assert.deepEqual(result.operations,[{action:'set_view',view:'spatial'}]);
});
test('Jev abstains below threshold and fails closed without consent or on invalid response',async()=>{
 assert.equal((await jevSuggest(state,'3d','test-key',true,async()=>reply(0.5))).accepted,false);
 await assert.rejects(()=>jevSuggest(state,'3d','test-key',false,()=>{throw Error('should not send');}),/consent/);
 await assert.rejects(()=>jevSuggest(state,'3d','test-key',true,async()=>new Response('{}')),/Invalid/);
 await assert.rejects(()=>jevSuggest(state,'3d','test-key',true,async()=>new Response('',{status:401})),/401/);
});
