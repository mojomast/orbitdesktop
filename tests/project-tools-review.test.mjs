import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {SqliteWorkspaceStore} from '../server/sqlite-workspace-store.mjs';
import {WorkbenchStore} from '../server/workbench-store.mjs';
import {WorkbenchData} from '../server/workbench-data.mjs';
import {commandIdentity} from '../server/command-identity.mjs';
import {initial} from '../src/model.ts';
import {projectToolChecks} from '../server/project-tools-evidence.mjs';

// Independent review regressions for the `evidence_checks` projection. These
// use the real WorkbenchData write path and recorder-shaped records (never a
// shape-inventing mock). They intentionally fail until the projection applies
// annotation-driven supersession and attaches the current review, because that
// is the concrete gap under review.
function fixture(t){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'orbit-tool-review-'));
  const store=new SqliteWorkspaceStore(root);
  const workspace_id=randomUUID();
  store.commit(commandIdentity({workspace_id,action:'sync',base_revision:0,operation_id:randomUUID(),intent:'Tool review fixture'},'owner'),{
    create:()=>({id:workspace_id,revision:1,state:initial(),capability:randomUUID(),api:'http://127.0.0.1:4318'}),
  });
  const records=new WorkbenchStore(store);
  const project=records.register(workspace_id,{root:path.join(root,'project'),name:'Review fixture',identity:'review-fixture'});
  const data=new WorkbenchData(store);
  t.after(()=>{store.close();fs.rmSync(root,{recursive:true,force:true});});
  return {store,workspace_id,project,data};
}
// Mirrors the exact recorder evidence fields (server/workbench-execution.mjs:663)
// that the projection reads, minus the private log/stdout/env fields.
function evidenceFields(workspace_id,project_id,overrides={}){
  const candidate_id=randomUUID();
  return {scope:{workspace_id,project_id},candidate_id,candidate_hash_after:'a'.repeat(64),fields:{
    workspace_id,project_id,project_generation:1,acceptance_digest:'b'.repeat(64),execution_profile_id:'owner-safe',
    job_id:randomUUID(),task_id:randomUUID(),candidate_id,verdict:'pass',test_results:null,exit_code:0,signal:null,
    timed_out:false,spawn_error:null,recording_error:null,process_survival_unknown:false,started_at:1,ended_at:2,
    candidate_hash_before:'a'.repeat(64),candidate_hash_after:'a'.repeat(64),definition_id:'node-test',definition_digest:'c'.repeat(64),
    artifact_hash:'d'.repeat(64),superseded:false,revoked:false,
    // Private fields that must never surface.
    log_path:'/private/output.log',stdout_preview:'SECRET BODY',stderr_preview:'SECRET ERR',env_fingerprint:'ENV',command:'node --test',
    ...overrides,
  }};
}

test('review projection excludes evidence superseded by an annotation, not only by a record flag',t=>{
  const f=fixture(t);
  const {scope,fields}=evidenceFields(f.workspace_id,f.project.id);
  const evidence=f.data.create('evidence',fields);
  // The recorder records supersession as an annotation and leaves the raw
  // record's `superseded:false` intact (server/workbench-execution.mjs:427-428,
  // :663). The projection reads raw `data.list('evidence')`, so it must apply
  // the annotation itself.
  f.data.create('annotations',{...scope,kind:'evidence_superseded',evidence_id:evidence.id,candidate_id:evidence.candidate_id,reason:'candidate_edited',actor:'owner'});
  const checks=projectToolChecks({data:f.data},scope);
  assert.equal(checks.recorded_count,0,'superseded evidence must not be presented as a current recorded fact');
  assert.match(checks.message,/never a pass/);
});

test('review projection attaches the newest matching review instead of the oldest by evidence id',t=>{
  const f=fixture(t);
  const {scope,fields}=evidenceFields(f.workspace_id,f.project.id);
  const evidence=f.data.create('evidence',fields);
  // A rejected review recorded first, then an approval over the same evidence
  // (same candidate/hash/evidence). `reviews.find(...)` returns insertion order,
  // so the naive join surfaces the stale rejection.
  f.data.create('reviews',{...scope,task_id:fields.task_id,candidate_id:evidence.candidate_id,candidate_hash:fields.candidate_hash_after,evidence_ids:[evidence.id],decision:'rejected',review_identity:'review-oldest',acceptance_version:1,acceptance_digest:fields.acceptance_digest,actor:'owner',accept_is_merge:false});
  f.data.create('reviews',{...scope,task_id:fields.task_id,candidate_id:evidence.candidate_id,candidate_hash:fields.candidate_hash_after,evidence_ids:[evidence.id],decision:'approved',review_identity:'review-newest',acceptance_version:1,acceptance_digest:fields.acceptance_digest,actor:'owner',accept_is_merge:false});
  const checks=projectToolChecks({data:f.data},scope);
  assert.equal(checks.recorded.length,1);
  assert.equal(checks.recorded[0].review?.decision,'approved','the current review decision must be shown, not an older rejected one');
  assert.equal(checks.recorded[0].review?.review_identity,'review-newest');
});
