import test from 'node:test';
import assert from 'node:assert/strict';
import {candidateDiffFromDetail} from '../src/candidate-diff-adapter.ts';

const from={candidate_id:'candidate',generation:1,candidate_hash:'a'.repeat(64)};
const to={candidate_id:'candidate',generation:2,candidate_hash:'b'.repeat(64)};
const file={path:'src/example.ts',old_hash:'c'.repeat(64),new_hash:'d'.repeat(64),old_mode:'100644',new_mode:'100755',text_available:true,old_text:'old\n',new_text:'new\n'};
const detail={mode:'candidate_generation_diff',available:true,comparison:'previous',from,to,files:[file],changed_files:1};

test('adapter preserves server identities, original bytes and observed mode provenance',()=>{
  const output=candidateDiffFromDetail({...detail,mode_provenance:'retained_tree_observation'},to);
  assert.deepEqual(output.from,from);assert.deepEqual(output.to,to);
  assert.equal(output.files[0].old_text,'old\n');assert.equal(output.files[0].new_mode,'100755');
  assert.equal(output.mode_provenance,'retained_tree_observation');
  const missing=candidateDiffFromDetail({...detail,available:false,reason:'historical_diff_unavailable',current_generation:8},to);
  assert.deepEqual(missing.from,from);assert.deepEqual(missing.to,to);assert.equal(missing.files,undefined);
  assert.equal(missing.current_generation,8);
});

test('adapter rejects a stale response instead of presenting another generation',()=>{
  for(const available of [true,false])assert.throws(()=>candidateDiffFromDetail({...detail,available,to:{...to,generation:3}},to),/stale_resource/);
  assert.throws(()=>candidateDiffFromDetail({...detail,from:{...from,candidate_id:'other'}}),/stale_resource/);
  assert.throws(()=>candidateDiffFromDetail({...detail,from:{...from,generation:4}}),/stale_resource/);
});

test('adapter never silently treats malformed hashes or omitted source as an added empty file',()=>{
  for(const patch of [{old_hash:undefined},{new_hash:'invalid'},{old_text:undefined}])assert.throws(()=>candidateDiffFromDetail({...detail,files:[{...file,...patch}]}));
  assert.throws(()=>candidateDiffFromDetail({...detail,changed_files:2,files:[file,file]}),/identity/);
  assert.throws(()=>candidateDiffFromDetail({...detail,files:[{...file,new_text:'界'.repeat(22000)}]}),/bound/);
  const binary=candidateDiffFromDetail({...detail,files:[{...file,text_available:false,reason:'binary',old_text:'never render this'}]});
  assert.equal(binary.files[0].old_text,null);
});
