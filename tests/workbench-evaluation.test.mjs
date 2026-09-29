// Versioned live-model evaluation catalogue. This file never calls a model: the
// live gate is UNAUTHORIZED/UNRUN, and the committed UNRUN manifest must match the
// catalogue exactly so a fake pass cannot be inserted.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const HERE=path.dirname(fileURLToPath(import.meta.url));
const CATALOGUE=path.join(HERE,'workbench-evaluation','cases.json');
const UNRUN=path.join(HERE,'workbench-evaluation','UNRUN.json');
const REQUIRED_CATEGORIES=['task_outcome','authorized_effects','protected_resources','evidence_correctness','unrelated_work_preserved'];
const REQUIRED_METRICS=['task_outcome','first_attempt_success','bounded_repair_success','intervention_count','unauthorized_attempts','unauthorized_effects','verification_correctness','result_delivery_accuracy','duration_ms','usage'];
const ALLOWED_CHECKS=new Set(['node-test','host-regression','browser-test']);
const deriveReport=catalogue=>({
  mode:'unrun',
  reason:catalogue.unrun_reason,
  catalogue_version:catalogue.catalogue_version,
  authorization_provided:catalogue.authorization.provided===true,
  families:catalogue.families.map(family=>({id:family.id,version:family.version,status:'unrun',trials:0,expected_outcome:family.expected.task_outcome})),
  totals:{admitted_trials:0,pass:0,fail:0,harness_errors:0,model_errors:0,invalid:0,interventions:0},
  note:'No live-model trial was run; no case is claimed passed or failed. Deterministic simulated-model results are reported separately from real-model results.',
});

test('evaluation catalogue is versioned, leak-guarded and explicitly unrun',t=>{
  const catalogue=JSON.parse(fs.readFileSync(CATALOGUE,'utf8'));
  assert.equal(catalogue.catalogue_version,1);
  assert.equal(catalogue.evaluation_status,'unrun');
  assert.equal(catalogue.authorization.provided,false);
  assert.equal(catalogue.families.length,6,'exactly six case families');
  assert.deepEqual([...catalogue.assertion_categories].sort(),[...REQUIRED_CATEGORIES].sort());
  assert.deepEqual([...catalogue.metrics].sort(),[...REQUIRED_METRICS].sort());
  assert.match(catalogue.counting_rule,/harness errors, model errors, invalid cases and interventions/);
  const ids=new Set();
  for(const family of catalogue.families){
    assert.ok(!ids.has(family.id),`duplicate family id ${family.id}`);ids.add(family.id);
    assert.ok(Number.isInteger(family.version)&&family.version>=1,`${family.id} version`);
    assert.ok(family.title.length>0&&family.task.length>0,`${family.id} task text`);
    assert.ok(ALLOWED_CHECKS.has(family.check),`${family.id} check`);
    assert.equal(family.status,'unrun');assert.equal(family.trials,0);
    assert.ok(REQUIRED_CATEGORIES.filter(category=>category in family.expected).length>=3,`${family.id} expected categories`);
    assert.ok(Array.isArray(family.forbidden_in_task_text)&&family.forbidden_in_task_text.length>0,`${family.id} leak guard`);
    for(const token of family.forbidden_in_task_text)assert.ok(!family.task.includes(token),`${family.id} leaks expected patch token: ${token}`);
  }
  // The committed UNRUN manifest must be exactly the derivation; no fake pass/fail.
  const committed=JSON.parse(fs.readFileSync(UNRUN,'utf8'));
  assert.deepEqual(committed,deriveReport(catalogue));
  assert.equal(committed.families.every(family=>family.status==='unrun'&&family.trials===0),true);
  assert.equal(committed.totals.admitted_trials,0);
});

test('an unrun catalogue cannot be reported as passed or failed',()=>{
  const catalogue=JSON.parse(fs.readFileSync(CATALOGUE,'utf8'));
  const serialized=JSON.stringify(catalogue);
  assert.equal(/"status"\s*:\s*"(passed|failed|ok)"/.test(serialized),false);
  assert.equal(catalogue.families.some(family=>Object.hasOwn(family,'score')||Object.hasOwn(family,'cost')),false);
});
