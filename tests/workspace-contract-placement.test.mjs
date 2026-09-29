import test from 'node:test';
import assert from 'node:assert/strict';
import {emptyPlacement} from '../src/docking-placement.ts';
import {validateWorkspaceRequest} from '../server/workspace-contract.mjs';

test('placement_save requires identity, intent, shared revision and strict versioned placement',()=>{
  const request={workspace_id:'12345678-1234-1234-1234-123456789abc',action:'placement_save',base_revision:1,operation_id:'placement-test',intent:'Save docking placement',placement:emptyPlacement()};
  const before=structuredClone(request);
  assert.doesNotThrow(()=>validateWorkspaceRequest(request));
  assert.deepEqual(request,before);
  for(const field of ['operation_id','intent','base_revision','placement']) {
    const invalid={...request};delete invalid[field];
    assert.throws(()=>validateWorkspaceRequest(invalid));
  }
  for(const placement of [{...emptyPlacement(),extra:true},{...emptyPlacement(),version:2}])assert.throws(()=>validateWorkspaceRequest({...request,placement}));
});
