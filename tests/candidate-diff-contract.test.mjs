import test from 'node:test';
import assert from 'node:assert/strict';
import {validateWorkbenchLive,validateLiveItem} from '../contracts/workbench-live-v1.mjs';

const id='11111111-1111-4111-8111-111111111111';
const reference={kind:'candidate',id,generation:2,hash:'a'.repeat(64)};
const request={action:'detail',workspace_id:id,project_id:id,reference};

test('cumulative comparison is an explicit private detail option, not a client-resolved identity',()=>{
  assert.equal(validateWorkbenchLive(request),true);
  assert.equal(validateWorkbenchLive({...request,comparison:'initial'}),true);
  assert.equal(validateWorkbenchLive({...request,comparison:'previous'}),true);
  assert.equal(validateWorkbenchLive({...request,file_path:'src/omitted.ts'}),true);
  assert.equal(validateWorkbenchLive({...request,file_path:'x'.repeat(4097)}),false);
  for(const comparison of ['latest','current',0,null])assert.equal(validateWorkbenchLive({...request,comparison}),false);
  assert.equal(validateWorkbenchLive({...request,from_hash:'b'.repeat(64)}),false);
  assert.equal(validateWorkbenchLive({...request,from_generation:1}),false);
});

test('live metadata cannot transport diff source, source paths to read, or a comparison request',()=>{
  const item={version:1,id:'candidate-event',at:0,authority:'observed',category:'files',kind:'candidate',summary:'Candidate changed',status:'completed',reference};
  assert.equal(validateLiveItem(item),true);
  for(const field of ['old_text','new_text','files','comparison'])assert.equal(validateLiveItem({...item,[field]:'private source'}),false);
  assert.equal(validateWorkbenchLive({...request,reference:{...reference,path:'../../private'}}),false);
});
