// F3 representative real project: a real maintained Orbit pure-Node subproject
// (explicit SOURCE SELECTION of exactly the module and its existing test), pinned
// at the inspected revision. A labelled controlled defect must be detected by the
// project's own test, and the real fix must restore it. No ambient node_modules,
// no toy tarball repackaging, and the original checkout is never written.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';

const ROOT=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const MANIFEST=path.join(ROOT,'tests/workbench-real-project/manifest.json');
const PIN='5b31fdaba1f867eeaf7b0aa30438f096a55b54f6';
const sha=value=>createHash('sha256').update(value).digest('hex');

function runProject(candidate){
  const env={...process.env};delete env.NODE_TEST_CONTEXT;delete env.NODE_OPTIONS;delete env.NODE_V8_COVERAGE;
  return spawnSync(process.execPath,['--experimental-strip-types','--test','tests/agent-profiles.test.mjs'],{cwd:candidate,encoding:'utf8',timeout:60000,env});
}

test('agent-profiles subproject: existing test passes, detects a labelled defect, and repairs',t=>{
  const manifest=JSON.parse(fs.readFileSync(MANIFEST,'utf8'));
  assert.equal(manifest.manifest_version,1);
  assert.equal(manifest.revision,PIN);
  assert.deepEqual(manifest.inputs,['server/agent-profiles.mjs','tests/agent-profiles.test.mjs'],'explicit two-input selection');
  assert.match(manifest.dependencies,/no ambient node_modules/);
  const candidates=[];
  t.after(()=>{for(const candidate of candidates)fs.rmSync(candidate,{recursive:true,force:true});});

  const sources=manifest.inputs.map(input=>({input,text:fs.readFileSync(path.join(ROOT,input),'utf8')}));
  const originalHashes=Object.fromEntries(sources.map(({input,text})=>[input,sha(text)]));

  const candidate=fs.mkdtempSync('/tmp/opencode/orbit-real-project-');
  candidates.push(candidate);
  for(const {input,text} of sources){const target=path.join(candidate,input);fs.mkdirSync(path.dirname(target),{recursive:true});fs.writeFileSync(target,text);}

  // Baseline: the project's own meaningful test passes with no installed dependencies.
  const baseline=runProject(candidate);
  assert.equal(baseline.status,0,baseline.stdout+baseline.stderr);

  // Labelled controlled defect: only the pinned find string changes.
  const moduleInput=manifest.defect.file,target=path.join(candidate,moduleInput);
  const text=fs.readFileSync(target,'utf8');
  assert.equal(text.split(manifest.defect.find).length-1,1,'the controlled defect must have exactly one application site');
  fs.writeFileSync(target,text.replace(manifest.defect.find,manifest.defect.replace));
  const defect=runProject(candidate);
  assert.notEqual(defect.status,0,'the existing test must detect the controlled defect');
  assert.equal(defect.status,1);

  // Real repair: restore the captured pinned source and re-run the unchanged test.
  fs.writeFileSync(target,sources.find(source=>source.input===moduleInput).text);
  const repaired=runProject(candidate);
  assert.equal(repaired.status,0,repaired.stdout+repaired.stderr);

  // The original checkout is never written and the candidate needs no ambient modules.
  for(const {input,text} of sources)assert.equal(sha(fs.readFileSync(path.join(ROOT,input),'utf8')),originalHashes[input],`${input} must be unchanged`);
  assert.equal(fs.existsSync(path.join(candidate,'node_modules')),false,'no ambient node_modules in the candidate');
});
