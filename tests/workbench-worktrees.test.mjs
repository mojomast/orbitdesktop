import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {previewWorktree,revalidateWorktree} from '../server/workbench-worktrees.mjs';
import {openProjectRoot,captureProject,repositorySnapshot} from '../server/project-files.mjs';

function fixture(t){
  const home=fs.mkdtempSync('/tmp/opencode/worktree-fixture-');
  t.after(()=>fs.rmSync(home,{recursive:true,force:true}));
  const main=path.join(home,'main'),root=path.join(home,'linked space 日本語');
  fs.mkdirSync(main);
  const git=(cwd,...args)=>execFileSync('/usr/bin/git',args,{cwd,env:{PATH:'/usr/bin:/bin',HOME:home,GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:'/dev/null'},stdio:'pipe'}).toString().trim();
  git(main,'init');git(main,'config','user.email','owner@example.invalid');git(main,'config','user.name','Owner');
  fs.writeFileSync(path.join(main,'value.txt'),'main\n');git(main,'add','.');git(main,'commit','-m','first');
  git(main,'worktree','add','-b','linked',root);
  fs.writeFileSync(path.join(root,'value.txt'),'linked\n');git(root,'add','.');git(root,'commit','-m','linked');
  fs.writeFileSync(path.join(root,'value.txt'),'linked dirty\n');fs.writeFileSync(path.join(root,'fresh.txt'),'untracked\n');
  const git_directory=fs.readFileSync(path.join(root,'.git'),'utf8').trim().slice('gitdir: '.length);
  const common_directory=path.join(main,'.git');
  const approved={root,git_directory,common_directory};
  const project=()=>{const opened=openProjectRoot(root);try{return {root,identity:opened.identity,git_mapping:previewWorktree(approved).mapping};}finally{opened.close();}};
  return {home,main,root,git_directory,common_directory,approved,project,git};
}

test('explicit approved worktree observes its own HEAD and dirty/untracked content without modifying Git metadata',async t=>{
  const f=fixture(t),preview=previewWorktree(f.approved),project=f.project();
  assert.equal(revalidateWorktree(preview.mapping).identity_root,project.identity);
  assert.match(preview.digest,/^[a-f0-9]{64}$/);
  const tracked=[path.join(f.git_directory,'HEAD'),path.join(f.git_directory,'index'),path.join(f.common_directory,'refs','heads','linked'),path.join(f.common_directory,'refs','heads','master')].filter(fs.existsSync);
  const before=tracked.map(file=>fs.readFileSync(file).toString('hex'));
  const snapshot=await repositorySnapshot(project,captureProject(project),{scratchRoot:path.join(f.home,'scratch')});
  assert.equal(snapshot.state,'available',snapshot.reason);
  assert.equal(snapshot.head,f.git(f.root,'rev-parse','HEAD'));
  assert.notEqual(snapshot.head,f.git(f.main,'rev-parse','HEAD'));
  assert.match(snapshot.diff,/-linked\n\+linked dirty/);
  assert.match(snapshot.status,/\?\? fresh.txt/);
  assert.deepEqual(tracked.map(file=>fs.readFileSync(file).toString('hex')),before);
});

test('unapproved mapping, tampered backlink, missing common directory and linked metadata refusal fail closed',async t=>{
  const f=fixture(t),mapping=previewWorktree(f.approved).mapping;
  assert.throws(()=>revalidateWorktree({...mapping,common_directory:f.root}),/unsupported|stale_resource/);
  assert.throws(()=>previewWorktree({...f.approved,git_directory:f.common_directory}),/unsupported/);
  const original=fs.readFileSync(path.join(f.git_directory,'gitdir'));
  fs.writeFileSync(path.join(f.git_directory,'gitdir'),`${f.main}/.git\n`);
  assert.throws(()=>revalidateWorktree(mapping),/stale_resource/);
  const project={root:f.root,identity:mapping.identity_root,git_mapping:mapping};
  assert.equal((await repositorySnapshot(project,captureProject(project),{scratchRoot:path.join(f.home,'scratch')})).state,'unavailable');
  fs.writeFileSync(path.join(f.git_directory,'gitdir'),original);
  fs.renameSync(f.common_directory,path.join(f.main,'metadata-relocated'));
  assert.throws(()=>revalidateWorktree(mapping));
});

test('unsupported extension, symlink pointer and hardlinked backlink are refused',t=>{
  const f=fixture(t),config=path.join(f.common_directory,'config'),original=fs.readFileSync(config);
  fs.appendFileSync(config,'\n[extensions]\n\tworktreeConfig = true\n');
  assert.throws(()=>previewWorktree(f.approved),/unsupported/);
  fs.writeFileSync(config,original);
  const pointer=path.join(f.root,'.git'),bytes=fs.readFileSync(pointer);
  fs.unlinkSync(pointer);fs.symlinkSync(path.join(f.git_directory,'gitdir'),pointer);
  assert.throws(()=>previewWorktree(f.approved));
  fs.unlinkSync(pointer);fs.writeFileSync(pointer,bytes);
  const backlink=path.join(f.git_directory,'gitdir');
  fs.linkSync(backlink,path.join(f.home,'hardlinked'));
  assert.throws(()=>previewWorktree(f.approved),/unsupported/);
});
