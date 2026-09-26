import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {captureProject,openProjectRoot} from '../server/project-files.mjs';
import {applyCandidateChanges,candidateHash,createCandidate,previewCandidate,readCandidateFile,removeCandidateWorkspace} from '../server/workbench-candidates.mjs';

const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
function fixture(t){
  const base=fs.mkdtempSync('/tmp/opencode/candidate-changes-');
  const projectRoot=path.join(base,'project'),runtime=path.join(base,'runtime');
  fs.mkdirSync(projectRoot);fs.mkdirSync(runtime);
  fs.writeFileSync(path.join(projectRoot,'keep.txt'),'old');
  fs.writeFileSync(path.join(projectRoot,'remove.bin'),Buffer.from([0,255,42]));
  const opened=openProjectRoot(projectRoot),project={id:'project',root:projectRoot,identity:opened.identity,active:true};opened.close();
  const store={root:runtime},capture=captureProject(project);
  const preview=previewCandidate({project,capture});
  const candidate=createCandidate({store,project,capture,preview_digest:preview.digest});
  t.after(()=>fs.rmSync(base,{recursive:true,force:true}));
  return {base,projectRoot,store,candidate};
}
const change=(candidate,p,content)=>({op:'change',path:p,expected_hash:candidate.files.find(f=>f.path===p).hash,content});
const deletion=(candidate,p)=>({op:'delete',path:p,expected_hash:candidate.files.find(f=>f.path===p).hash});

test('batch create/change/delete produces a separately readable immutable root and full-tree hash',t=>{
  const {store,candidate,projectRoot}=fixture(t);
  const binary=Buffer.from([0,255,42,1]);
  const result=applyCandidateChanges({store,candidate,expected_candidate_hash:candidate.hash,changes:[
    change(candidate,'keep.txt','é 👋'),deletion(candidate,'remove.bin'),
    {op:'create',path:'nested/new.bin',expected_hash:null,content_base64:binary.toString('base64')},
  ]});
  assert.notEqual(result.root,candidate.root);
  assert.equal(result.generation,2);
  assert.equal(result.hash,candidateHash({...candidate,...result}));
  assert.deepEqual(result.files.map(f=>f.path),['keep.txt','nested/new.bin']);
  assert.equal(result.files.find(f=>f.path==='nested/new.bin').hash,sha(binary));
  assert.equal(readCandidateFile(store,{...candidate,...result},'nested/new.bin').binary,true);
  assert.equal(readCandidateFile(store,{...candidate,...result},'keep.txt').text,'é 👋');
  assert.throws(()=>readCandidateFile(store,{...candidate,...result},'remove.bin'),{code:'unsupported'});
  assert.equal(readCandidateFile(store,candidate,'keep.txt').text,'old');
  assert.deepEqual(fs.readFileSync(path.join(candidate.root,'remove.bin')),Buffer.from([0,255,42]));
  assert.equal(fs.readFileSync(path.join(projectRoot,'keep.txt'),'utf8'),'old');
  removeCandidateWorkspace(store,{root:result.root});
});

test('one bad precondition or invalid path aborts the entire batch without a new root',t=>{
  const {store,candidate}=fixture(t),parent=path.dirname(candidate.root),initial=fs.readdirSync(parent);
  const apply=changes=>applyCandidateChanges({store,candidate,expected_candidate_hash:candidate.hash,changes});
  assert.throws(()=>apply([change(candidate,'keep.txt','changed'),{op:'delete',path:'remove.bin',expected_hash:sha('wrong')}]),{code:'stale_resource'});
  assert.throws(()=>apply([{op:'create',path:'keep.txt/child',expected_hash:null,content:'x'},deletion(candidate,'remove.bin')]),{code:'unsupported'});
  assert.throws(()=>apply([{op:'create',path:'.env.secret',expected_hash:null,content:'x'}]),{code:'unsupported'});
  assert.throws(()=>apply([{op:'create',path:'new',expected_hash:null,content_base64:'a==='}]),{code:'invalid_request'});
  assert.throws(()=>apply([change(candidate,'keep.txt','x')].map(c=>({...c,expected_hash:'0'.repeat(64)}))),{code:'stale_resource'});
  assert.deepEqual(fs.readdirSync(parent),initial);
  assert.equal(readCandidateFile(store,candidate,'keep.txt').text,'old');
});

test('unexpected symlinks, hardlinks, special entries and replaced ancestors fail closed',t=>{
  const {store,candidate,base}=fixture(t);
  const apply=()=>applyCandidateChanges({store,candidate,expected_candidate_hash:candidate.hash,changes:[change(candidate,'keep.txt','new')]});
  fs.symlinkSync(path.join(base,'project'),path.join(candidate.root,'unexpected'));
  assert.throws(apply,{code:'unsupported'});fs.unlinkSync(path.join(candidate.root,'unexpected'));
  fs.linkSync(path.join(candidate.root,'keep.txt'),path.join(candidate.root,'other'));
  assert.throws(apply,{code:'unsupported'});fs.unlinkSync(path.join(candidate.root,'other'));
  fs.mkdirSync(path.join(candidate.root,'extra'));
  assert.throws(apply,{code:'unsupported'});fs.rmdirSync(path.join(candidate.root,'extra'));
  fs.renameSync(candidate.root,`${candidate.root}-held`);
  fs.symlinkSync(base,candidate.root);
  assert.throws(apply,{code:'permission_denied'});
  fs.unlinkSync(candidate.root);fs.renameSync(`${candidate.root}-held`,candidate.root);
  assert.equal(fs.readFileSync(path.join(candidate.root,'keep.txt'),'utf8'),'old');
});

test('a staged write failure cleans the staging root and leaves the old generation intact',t=>{
  const {store,candidate}=fixture(t),parent=path.dirname(candidate.root),original=fs.writeFileSync;
  let writes=0;
  fs.writeFileSync=function(...args){if(++writes===2)throw Object.assign(new Error('injected'),{code:'EIO'});return original.apply(this,args);};
  try{
    assert.throws(()=>applyCandidateChanges({store,candidate,expected_candidate_hash:candidate.hash,changes:[change(candidate,'keep.txt','new')]}),{code:'permission_denied'});
  }finally{fs.writeFileSync=original;}
  assert.deepEqual(fs.readdirSync(parent),[path.basename(candidate.root)]);
  assert.equal(readCandidateFile(store,candidate,'keep.txt').text,'old');
});

test('incomplete captures cannot be modified',t=>{
  const {store,candidate}=fixture(t);
  assert.throws(()=>applyCandidateChanges({store,candidate:{...candidate,limited:true},expected_candidate_hash:candidate.hash,changes:[change(candidate,'keep.txt','new')]}),{code:'unsupported'});
  assert.throws(()=>applyCandidateChanges({store,candidate:{...candidate,exclusions:[{path:'missing',reason:'unavailable_or_unsupported'}]},expected_candidate_hash:candidate.hash,changes:[change(candidate,'keep.txt','new')]}),{code:'unsupported'});
});
