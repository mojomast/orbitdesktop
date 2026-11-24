import fs from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHmac, randomBytes } from 'node:crypto';
import { canonicalJson } from '../../server/acdd-evidence.mjs';

// Based on the #26 pricing fixture; include re-runs and a distinct unrun
// criterion. Keys and signatures are disposable, not production evidence.
export function makeFixture(t) {
  const root = fs.mkdtempSync(join(tmpdir(),'orbit-acdd-board-'));
  t.after(() => fs.rmSync(root,{recursive:true,force:true}));
  const key = randomBytes(32), id = 'W1-pricing', sha = 'c'.repeat(64);
  fs.writeFileSync(join(root,'lease.key'),key,{mode:0o600});
  const dir = join(root,'evidence',id);
  for (const sub of ['leases','reports','evidence/'+id]) fs.mkdirSync(join(root,sub),{recursive:true});
  const contract = {contract_version:'acdd/1', id, title:'Pricing fixture', acceptance_criteria:[{id:'AC-001',statement:'Prices include tax.'},{id:'AC-002',statement:'Optional check.'}],
    review:{status:'approved',contract_sha256:sha},evidence_required:['red','green','refactor','integration','review']};
  fs.writeFileSync(join(root,'leases','fixture.json'), JSON.stringify({brief:{contract}}));
  function signed(file, fields) {
    fs.writeFileSync(file, JSON.stringify({...fields,signature:createHmac('sha256',key).update(canonicalJson(fields)).digest('hex')}));
  }
  const records = [['red','behavioral_failure'],['green','passed'],['refactor','passed'],['integration','failed']];
  for (const [index,[phase,classification]] of records.entries()) {
    signed(join(dir,`${index}-${phase}.json`), {evidence_version:'tdd-evidence/1',contract_id:id,contract_sha256:sha,phase,classification,
      revision:'a'.repeat(40),at:`2026-11-12T18:0${index}:00Z`,produced_by:{role:'verifier'},criteria:{'AC-001':classification==='passed'?'passed':'failed','AC-002':'not_run'}});
  }
  signed(join(root,'reports',`${id}.json`), {contract_id:id,contract_sha256:sha,accepted:false,
    phases:{red:'valid',green:'tests_tampered',refactor:'scope_violation',integration:'integration_failed',review:'unrun'}});
  return {root, ref:{id,contract_sha256:sha}};
}

export function snapshot(dir) {
  return Object.fromEntries(fs.readdirSync(dir,{withFileTypes:true}).map(entry => {
    const file = join(dir,entry.name);
    return [entry.name, entry.isDirectory() ? snapshot(file) : [fs.readFileSync(file).toString('base64'), fs.statSync(file).mtimeMs]];
  }));
}
