import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import Database from 'better-sqlite3';
import {bundleSchemaSql,createBundleRegistry} from '../server/bundle-registry.mjs';

function fixture(t) {
  const root=fs.mkdtempSync('/tmp/opencode/orbit-bundle-registry-');
  const db=new Database(path.join(root,'workspace.sqlite'));
  db.pragma('foreign_keys = ON');
  db.exec(`CREATE TABLE workspaces(id TEXT PRIMARY KEY,revision INTEGER,record_json TEXT);
    CREATE TABLE revisions(workspace_id TEXT,revision INTEGER,state_json TEXT,created INTEGER);
    CREATE TABLE checkpoints(workspace_id TEXT,id TEXT,revision INTEGER,created INTEGER,label TEXT,state_json TEXT);`);
  db.exec(bundleSchemaSql);
  t.after(()=>{db.close();fs.rmSync(root,{recursive:true,force:true});});
  const registry=createBundleRegistry({db,root});
  const write=(slug,relative,bytes)=>{const target=path.join(root,'apps',slug,relative);fs.mkdirSync(path.dirname(target),{recursive:true});fs.writeFileSync(target,bytes);};
  const publish=(content='hello',extra={})=>{
    const source=fs.mkdtempSync(path.join(root,'build-'));
    for(const [name,bytes] of Object.entries({'index.html':content,...extra})) {const target=path.join(source,name);fs.mkdirSync(path.dirname(target),{recursive:true});fs.writeFileSync(target,bytes);}
    const staging=fs.mkdtempSync(path.join(root,'publish-'));
    const result=spawnSync('python3',['scripts/plugin_publish.py',source,'--id','notes','--version','1.0.0','--title','Notes','--runtime',staging],{encoding:'utf8'});
    assert.equal(result.status,0,result.stderr);
    const manifest=JSON.parse(result.stdout),slug=manifest.entry.split('/')[2];
    fs.mkdirSync(path.join(root,'apps'),{recursive:true});
    fs.renameSync(path.join(staging,'apps',slug),path.join(root,'apps',slug));
    return {manifest,slug};
  };
  return {root,db,registry,write,publish};
}
const pane=url=>({type:'pane',pane:{id:'pane',kind:'browser',url}});
const state=url=>({version:1,monitors:url?[{id:'window',layout:pane(url)}]:[]});
const pluginState=(manifest,enabled=false)=>({...state(enabled?manifest.entry:undefined),plugins:[{manifest,enabled,window:{id:'window',layout:pane(manifest.entry)}}]});
const unavailable=error=>error.category==='BUNDLE_UNAVAILABLE';

test('actual publisher hash, unicode and pathlib ordering; explicit indexed reads and stable numeric versions',t=>{
  const {root,db,registry,publish}=fixture(t);
  const {manifest,slug}=publish('hello',{'a/child.txt':'nested','a.txt':'sibling','é.txt':'unicode','😀.txt':'astral'});
  assert.deepEqual(registry.versions(),{});
  registry.refresh();
  assert.equal(registry.list()[0].status,'verified');
  const versions=registry.versions();assert.equal(typeof versions[slug],'number');
  registry.refresh();assert.deepEqual(registry.versions(),versions);
  assert.equal(registry.validateState(state(manifest.entry)).ok,true);
  assert.equal(registry.resolveFile(slug).bytes.toString(),'hello');
  assert.equal(registry.verifyFile(slug,'index.html',Buffer.from('hello')),true);
  // A new instance and reads still work with the apps directory absent: no scan.
  fs.renameSync(path.join(root,'apps'),path.join(root,'hidden-apps'));
  const reopened=createBundleRegistry({db,root});
  assert.deepEqual(reopened.versions(),versions);assert.equal(reopened.list()[0].files.length,5);
  assert.equal(reopened.validateState(state(manifest.entry)).ok,true);
  assert.throws(()=>reopened.resolveFile(slug),unavailable);
  reopened.refresh();assert.equal(reopened.list()[0].status,'missing');
  assert.equal(reopened.list()[0].files.length,5);
  assert.throws(()=>reopened.validateState(state(manifest.entry)),unavailable);
});

test('modified bytes and unexpected files fail hash validation; serving enforces exact indexed bytes',t=>{
  const {registry,publish,write,root}=fixture(t),{slug,manifest}=publish();
  registry.refresh();
  write(slug,'index.html','HELLO');
  assert.throws(()=>registry.resolveFile(slug),unavailable);
  assert.throws(()=>registry.verifyFile(slug,'index.html',Buffer.from('HELLO')),unavailable);
  registry.refresh();assert.equal(registry.list()[0].status,'corrupt');
  assert.throws(()=>registry.validateState(state(manifest.entry)),unavailable);
  write(slug,'index.html','hello');registry.refresh();assert.equal(registry.list()[0].status,'verified');
  write(slug,'extra.js','extra');registry.refresh();assert.equal(registry.list()[0].status,'corrupt');
  fs.unlinkSync(path.join(root,'apps',slug,'extra.js'));registry.refresh();
  assert.throws(()=>registry.resolveFile(slug,'../index.html'),unavailable);
  assert.throws(()=>registry.resolveFile(slug,'unknown.js'),unavailable);
});

test('legacy bundles are compatible but explicitly unverified, with content-driven versions',t=>{
  const {registry,write}=fixture(t);
  write('legacy','index.html','old');registry.refresh();const before=registry.versions().legacy;
  assert.equal(registry.list()[0].status,'unverified');
  assert.equal(registry.validateState(state('/apps/legacy/index.html')).diagnostics.length,1);
  assert.equal(registry.validateState(state('/apps/absent/index.html')).ok,true);
  registry.refresh();assert.equal(registry.versions().legacy,before);
  write('legacy','index.html','new');registry.refresh();assert.equal(registry.versions().legacy,before+1);
});

test('all current states, revisions, checkpoints, disabled manifests and saved split panes retain bundles',t=>{
  const {registry,db,publish,write,root}=fixture(t);
  const current=publish('current'),revision=publish('revision'),checkpoint=publish('checkpoint'),unused=publish('unused');
  const disabled=pluginState(current.manifest);
  disabled.plugins[0].window.layout={type:'split',first:pane('/apps/saved/index.html?x=1#frag'),second:pane('/apps/other/')};
  db.prepare('INSERT INTO workspaces VALUES (?,?,?)').run('one',1,JSON.stringify({state:disabled}));
  db.prepare('INSERT INTO workspaces VALUES (?,?,?)').run('two',1,JSON.stringify({state:state('/apps/second/index.html')}));
  db.prepare('INSERT INTO revisions VALUES (?,?,?,?)').run('one',1,JSON.stringify(state(revision.manifest.entry)),0);
  db.prepare('INSERT INTO checkpoints VALUES (?,?,?,?,?,?)').run('one','cp',1,0,'test',JSON.stringify(state(checkpoint.manifest.entry)));
  write('saved','index.html','saved');registry.refresh();
  fs.rmSync(path.join(root,'apps',revision.slug),{recursive:true});registry.refresh();
  const plan=registry.cleanupPlan();
  assert.deepEqual(plan.candidates.map(row=>row.slug),[unused.slug]);
  assert.deepEqual(new Set(plan.retained.map(row=>row.slug)),new Set([current.slug,revision.slug,checkpoint.slug,'saved','other','second']));
  assert.equal(registry.list().find(row=>row.slug===revision.slug).status,'missing');
  assert.equal(plan.retained.find(row=>row.slug===checkpoint.slug).references[0].retained_by,'checkpoint');
  const pruned=registry.prune([current.slug,unused.slug],{confirm:true});
  assert.equal(pruned.dry_run,true);assert.deepEqual(pruned.deleted,[]);
  assert.deepEqual(pruned.candidates.map(row=>row.slug),[unused.slug]);
  assert.equal(fs.existsSync(path.join(root,'apps',unused.slug)),true);
});

test('activation and new references fail closed, while existing disabled registrations permit recovery',t=>{
  const {registry,publish}=fixture(t),{manifest}=publish();
  const disabled=pluginState(manifest),active=pluginState(manifest,true);
  assert.equal(registry.validateState(disabled).ok,true);
  assert.equal(registry.validateState(disabled,{previousState:active}).ok,true);
  assert.throws(()=>registry.validateState(disabled,{previousState:state()}),unavailable);
  assert.throws(()=>registry.validateState(active),unavailable);
  registry.refresh();assert.equal(registry.validateState(active).ok,true);
  assert.throws(()=>registry.validateState(state(manifest.entry.replace('index.html','absent.html'))),unavailable);
});

test('absolute and normalized app URLs conservatively retain bundles without claiming remote validation',t=>{
  const {registry,db,publish}=fixture(t),{manifest,slug}=publish();registry.refresh();
  const absolute=state('https://fixture.example'+manifest.entry);
  db.prepare('INSERT INTO workspaces VALUES (?,?,?)').run('absolute',1,JSON.stringify({state:absolute}));
  assert.ok(registry.cleanupPlan().retained.some(entry=>entry.slug===slug));
  assert.equal(registry.cleanupPlan().candidates.length,0);
  assert.equal(registry.references(state('/elsewhere/..'+manifest.entry))[0].slug,slug);
  assert.equal(registry.validateState(state('https://elsewhere.example/apps/absent-'+ 'a'.repeat(24)+'/index.html')).ok,true);
  const active=state(manifest.entry);registry.refresh();
  registry.validateState(active,{previousState:active,onlyChanged:true});
});

test('symlink files, directories, bundle roots and apps root fail closed',t=>{
  const {registry,publish,root,write}=fixture(t),{slug}=publish('hello',{'dir/file.txt':'asset'});
  registry.refresh();
  const target=path.join(root,'apps',slug,'index.html'),outside=path.join(root,'outside.html');
  fs.writeFileSync(outside,'hello');fs.unlinkSync(target);fs.symlinkSync(outside,target);
  assert.throws(()=>registry.verifyFile(slug,'index.html',Buffer.from('hello')),unavailable);
  registry.refresh();assert.equal(registry.list()[0].status,'corrupt');
  fs.unlinkSync(target);write(slug,'index.html','hello');
  const dir=path.join(root,'apps',slug,'dir');fs.renameSync(dir,path.join(root,'outside-dir'));fs.symlinkSync(path.join(root,'outside-dir'),dir);
  registry.refresh();assert.equal(registry.list()[0].status,'corrupt');
  fs.rmSync(path.join(root,'apps',slug),{recursive:true});fs.symlinkSync(path.join(root,'outside-dir'),path.join(root,'apps',slug));
  registry.refresh();assert.equal(registry.list()[0].status,'corrupt');
  fs.renameSync(path.join(root,'apps'),path.join(root,'real-apps'));fs.symlinkSync(path.join(root,'real-apps'),path.join(root,'apps'));
  registry.refresh();assert.equal(registry.list()[0].status,'corrupt');
});

test('20 MB / 500 file limits and hidden files are rejected without skipping native DB tests',t=>{
  const {registry,write}=fixture(t);
  write('large','index.html',Buffer.alloc(20_000_001));
  for(let i=0;i<501;i++)write('many',`${i}.txt`,'x');
  write('hidden','.secret','x');registry.refresh();
  assert.deepEqual(registry.list().map(row=>row.status),['corrupt','corrupt','corrupt']);
  assert.match(registry.list().find(row=>row.slug==='large').diagnostic,/limit/);
  assert.match(registry.list().find(row=>row.slug==='many').diagnostic,/limit/);
});
