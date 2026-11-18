import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {createHash} from 'node:crypto';
import {tailcatPlan} from '../scripts/worker-join/tailcat-plan.mjs';

test('tailcat plan binds the audited CLI shape, exact local bytes, single peer and ephemeral key',t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'tc-config-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const binary=path.join(dir,'sample'),sample='non-executable fixture bytes';fs.writeFileSync(binary,sample,{mode:0o600});
  const cfg={binary,approvedRelease:'v0.7.0',approvedSha256:createHash('sha256').update(sample).digest('hex'),clientNodeKey:'nodekey:'+'1'.repeat(64),address:'tc'+'a'.repeat(32),peerPort:34567};
  const plan=tailcatPlan(cfg);assert.deepEqual(plan.argv.coordinator,[binary,'serve','--key=new','--allow='+cfg.clientNodeKey,'34567']);assert.deepEqual(plan.argv.client,[binary,'forward',cfg.address,'34567:34567']);
  assert.ok(!JSON.stringify(plan).includes(cfg.address));assert.equal(plan.nativeHandshake,'not_run');
  for(const change of [{approvedRelease:'latest'},{approvedSha256:'0'.repeat(64)},{peerPort:'all'},{address:'demo.example.org'},{clientNodeKey:''}])assert.throws(()=>tailcatPlan({...cfg,...change}));
  fs.appendFileSync(binary,'changed');assert.throws(()=>tailcatPlan(cfg),/digest_mismatch/);
});
