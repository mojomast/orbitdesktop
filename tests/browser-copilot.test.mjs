import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,writeFile,mkdir,symlink,stat,readFile,readdir,rename,chmod} from 'node:fs/promises';
import {join} from 'node:path';
import {createBrowserCopilot} from '../server/browser-copilot.mjs';
import {createPlaywrightDriver,createNavigationPolicy,copilotError,digest} from '../server/browser-copilot-driver.mjs';
import {validateCopilotRequest} from '../contracts/browser-copilot-v1.mjs';
import {createCopilotEvidenceStore,privateDirectory,privateWrite,privateNames} from '../server/browser-copilot-evidence.mjs';

const workspace_id='fixture-workspace';
const fullObservation=(target_id,text)=>({target_id,text,url_hash:digest('https://fixture.example/'),origin:'https://fixture.example',display_url:'https://fixture.example/',title:'Synthetic target',elements:[{ref:'r0',role:'button',name:'Click'}],truncated:false,captured_at:Date.now()});
function fakeDriver(){
  const pages=new Map();let clicks=0,resolveAct;
  const observation=(id='selected')=>{if(pages.get(id)?.closed)throw copilotError('stale_resource');return fullObservation(id,pages.get(id)?.text||'before');};
  return {
    capability:async()=>({available:true}),policy:async()=>{},
    launch:async()=>{pages.set('selected',{text:'before'});pages.set('neighbor',{text:'untouched'});return observation();},
    observe:async b=>observation(b.target_id),binding:async()=>({origin:'https://fixture.example',url_hash:digest('https://fixture.example/')}),
    screenshot:async()=>Buffer.from('synthetic screenshot'),
    act:async b=>{clicks++;if(resolveAct)await new Promise(resolve=>{resolveAct=resolve;});pages.get(b.target_id).text='after';return observation(b.target_id);},
    targets:async()=>[...pages].map(([target_id,p])=>({target_id,closed:!!p.closed})),
    closeTarget:async b=>{pages.get(b.target_id).closed=true;},close:async()=>{for(const p of pages.values())p.closed=true;if(typeof resolveAct==='function')resolveAct();},shutdown:async()=>{},
    pages,get clicks(){return clicks;},hang(){resolveAct=true;},
  };
}
async function fixture(t){const root=await mkdtemp('/tmp/opencode/browser-copilot-unit-');const driver=fakeDriver();const service=createBrowserCopilot({root,driver,workspaceRead:id=>id===workspace_id?{}:null});t.after(async()=>{await service.close();await rm(root,{recursive:true,force:true});});const request=b=>service.dispatch({workspace_id,...b});const opened=(await request({action:'open',url:'https://fixture.example',op_key:'start'})).receipt.result;return {root,driver,service,request,session_id:opened.session.session_id,revision:opened.session.revision,target_id:'selected'};}
test('strict closed action union and unavailable capability',async()=>{
  assert.equal(validateCopilotRequest({action:'preview',workspace_id,session_id:'s',target_id:'t',expected_revision:1,mode:'owner',operation:{kind:'evaluate',code:'alert(1)'}}),false);
  assert.equal(validateCopilotRequest({action:'open',workspace_id,url:'https://x',op_key:'k',executablePath:'/host'}),false);
  assert.equal((await createPlaywrightDriver().capability()).reason,'executable_not_configured');
  const policy=createNavigationPolicy(['http://127.0.0.1:12345']);await policy('http://127.0.0.1:12345/fixture');
  for(const u of ['file:///etc/passwd','javascript:alert(1)','http://localhost:12345','https://example.com','http://u:p@127.0.0.1:12345'])await assert.rejects(()=>policy(u),{code:'permission_denied'});
});
test('operator wildcard rules bind label boundaries, scheme and port',async()=>{
  const resolve=async()=>[{address:'203.0.113.10'}];
  const policy=createNavigationPolicy(['https://*.ussy.host','https://*.ussyco.de','https://discord.com'],{resolve});
  for(const url of ['https://one.ussy.host/path','https://nested.one.ussyco.de/','https://discord.com/channels'])await policy(url);
  for(const url of ['https://ussy.host','https://notussy.host','https://one.ussy.host.evil.test','http://one.ussy.host','https://one.ussy.host:8443','https://discord.com.evil.test','https://u:p@one.ussy.host','file:///tmp/test'])await assert.rejects(()=>policy(url),{code:'permission_denied'});
  for(const rule of ['https://*','https://*.com','https://foo.*.host','https://*.127.0.0.1','https://*.ussy.host/path','https://*.ussy.host:443'])assert.throws(()=>createNavigationPolicy([rule]),{code:'invalid_request'});
});
test('local rule admits local addresses on all ports, rejects public/mixed DNS and rechecks resolution',async()=>{
  let addresses=[{address:'192.168.1.2'},{address:'fd00::2'}],calls=0;
  const policy=createNavigationPolicy(['local'],{resolve:async()=>{calls++;return addresses;}});
  for(const host of ['localhost','printer.local','127.0.0.2','10.1.2.3','172.16.2.1','192.168.5.1','169.254.1.1','100.64.2.1','[::1]','[fd00::1]','[fe80::1]','[::ffff:127.0.0.1]'])await policy(`http://${host}:4321/test`);
  await policy('https://printer.local:8443');
  addresses.push({address:'8.8.8.8'});
  await assert.rejects(()=>policy('http://printer.local:4321'),{code:'permission_denied'});
  addresses=[{address:'8.8.8.8'}];
  await assert.rejects(()=>policy('http://printer.local:4321'),{code:'permission_denied'});
  assert.equal(calls,5);
  for(const host of ['8.8.8.8','172.32.0.1','100.128.0.1','224.0.0.1','[2001:4860:4860::8888]','[ff02::1]'])await assert.rejects(()=>policy(`http://${host}`),{code:'permission_denied'});
  await assert.rejects(()=>policy('http://u:p@127.0.0.1'),{code:'permission_denied'});
  await assert.rejects(()=>createNavigationPolicy(['local'],{resolve:async()=>[]})('http://absent.local'),{code:'permission_denied'});
});
test('revision preview, once-only click receipt, evidence identity and pause',async t=>{
  const f=await fixture(t),{request,session_id,target_id,revision,driver}=f;
  await assert.rejects(()=>request({action:'list',workspace_id:'wrong'}),{code:'permission_denied'});
  const preview=await request({action:'preview',session_id,target_id,expected_revision:revision,operation:{kind:'click',ref:'r0'},mode:'manual'});
  const b={action:'execute',session_id,target_id,expected_revision:revision,proposal_id:preview.proposal.proposal_id,op_key:'click-1'};
  const [a,retry]=await Promise.all([request(b),request(b)]);assert.equal(a.receipt.status,'completed');assert.equal(driver.clicks,1);assert.equal(retry.receipt.op_key,'click-1');
  assert.equal(a.receipt.result.mode,'manual');assert.equal(a.receipt.result.before.target_id,target_id);assert.equal(a.receipt.result.after.target_id,target_id);
  const evidence=(await request({action:'evidence',session_id,evidence_id:a.receipt.result.after.evidence_id})).evidence;assert.equal(evidence.observation.text,'after');
  await assert.rejects(()=>request({...b,proposal_id:'different'}),{code:'conflict'});
  const paused=await request({action:'pause',session_id});await assert.rejects(()=>request({action:'preview',session_id,target_id,expected_revision:paused.session.revision,operation:{kind:'snapshot'},mode:'owner'}),{code:'permission_denied'});
  assert.equal(driver.pages.get('neighbor').text,'untouched');
});
test('selected tab gone refuses, never selects neighbor',async t=>{
  const {request,driver,session_id,target_id,revision}=await fixture(t);
  const p=await request({action:'preview',session_id,target_id,expected_revision:revision,operation:{kind:'click',ref:'r0'},mode:'owner'});
  driver.pages.get(target_id).closed=true;
  const r=(await request({action:'execute',session_id,target_id,expected_revision:revision,proposal_id:p.proposal.proposal_id,op_key:'gone'})).receipt;
  assert.equal(r.status,'refused');assert.equal(r.reason,'stale_resource');assert.equal(driver.clicks,0);assert.equal(driver.pages.get('neighbor').text,'untouched');
});
test('URL / observation drift refuses the previously reviewed action',async t=>{
  const {request,driver,session_id,target_id,revision}=await fixture(t);
  const p=await request({action:'preview',session_id,target_id,expected_revision:revision,operation:{kind:'click',ref:'r0'},mode:'owner'});
  driver.pages.get(target_id).text='Page changed after review';
  const r=(await request({action:'execute',session_id,target_id,expected_revision:revision,proposal_id:p.proposal.proposal_id,op_key:'drift'})).receipt;
  assert.equal(r.status,'refused');assert.equal(r.reason,'stale_resource');assert.equal(driver.clicks,0);
  driver.binding=async()=>({origin:'https://other.example',url_hash:'other'});
  const again=await request({action:'preview',session_id,target_id,expected_revision:revision,operation:{kind:'click',ref:'r0'},mode:'owner'});
  const changed=(await request({action:'execute',session_id,target_id,expected_revision:revision,proposal_id:again.proposal.proposal_id,op_key:'origin-drift'})).receipt;
  assert.equal(changed.status,'refused');assert.equal(driver.clicks,0);
});
test('pending cancel declares unknown, cleans context, never replays',async t=>{
  const {request,driver,session_id,target_id,revision}=await fixture(t);driver.hang();
  const p=await request({action:'preview',session_id,target_id,expected_revision:revision,operation:{kind:'click',ref:'r0'},mode:'owner'});
  const pending=request({action:'execute',session_id,target_id,expected_revision:revision,proposal_id:p.proposal.proposal_id,op_key:'pending'});
  while(!driver.clicks)await new Promise(resolve=>setTimeout(resolve,5));
  await request({action:'cancel',session_id});await pending;const receipt=(await request({action:'receipt',op_key:'pending'})).receipt;
  assert.equal(receipt.status,'unknown');assert.equal(driver.clicks,1);assert.equal(driver.pages.get('neighbor').closed,true);
});
test('restart fences durable pending receipt and refuses private symlink directory',async t=>{
  const root=await mkdtemp('/tmp/opencode/browser-copilot-restart-');t.after(()=>rm(root,{recursive:true,force:true}));
  const directory=join(root,'browser-copilot','receipts');await mkdir(directory,{recursive:true,mode:0o700});
  const key=digest(workspace_id+'\0'+'lost');
  await writeFile(join(directory,key+'.json'),JSON.stringify({workspace_id,op_key:'lost',fingerprint:digest('request'),created_at:Date.now(),session_id:'s',target_id:'t',status:'pending'}),{mode:0o600});
  const s=createBrowserCopilot({root,driver:fakeDriver(),workspaceRead:()=>({})});t.after(()=>s.close());
  assert.equal((await s.dispatch({action:'receipt',workspace_id,op_key:'lost'})).receipt.status,'unknown');
  const other=await mkdtemp('/tmp/opencode/browser-copilot-symlink-');t.after(()=>rm(other,{recursive:true,force:true}));await symlink(root,join(other,'browser-copilot'));
  const bad=createBrowserCopilot({root:other,driver:fakeDriver(),workspaceRead:()=>({})});await assert.rejects(()=>bad.dispatch({action:'list',workspace_id}),{code:'unavailable'});
});
test('private CAS verifies bytes, binds workspace/session, and prunes bounded evidence',async t=>{
  const directory=await mkdtemp('/tmp/opencode/browser-copilot-cas-');t.after(()=>rm(directory,{recursive:true,force:true}));
  let at=Date.now();const store=createCopilotEvidenceStore(directory,{now:()=>at++});const items=[];
  for(let i=0;i<42;i++)items.push(await store.put({workspace_id,session_id:'s',target_id:'t',observation:fullObservation('t','synthetic '+i),bytes:Buffer.from('image '+i)}));
  await assert.rejects(()=>store.read({workspace_id,session_id:'s',evidence_id:items[0].evidence_id}),{code:'stale_resource'});
  const last=items.at(-1);const read={workspace_id,session_id:'s',evidence_id:last.evidence_id};
  assert.equal((await store.read(read)).target_id,'t');
  await assert.rejects(()=>store.read({...read,session_id:'other'}),{code:'permission_denied'});
  await assert.rejects(()=>store.read({...read,workspace_id:'other'}),{code:'permission_denied'});
  assert.equal((await stat(directory)).mode&0o777,0o700);assert.equal((await stat(join(directory,last.sha256+'.png'))).mode&0o777,0o600);
  await writeFile(join(directory,last.sha256+'.png'),'tampered');await assert.rejects(()=>store.read(read),{code:'unavailable'});
  at+=4*86400000;assert.equal((await store.prune({workspace_id,dry_run:true})).removed,40);assert.equal((await store.prune({workspace_id,dry_run:false})).retained,0);
});
test('untrusted receipt records fail closed before pending recovery or completed exposure',async t=>{
  const f=await fixture(t);await f.service.close();
  const receipts=join(f.root,'browser-copilot','receipts'),startKey=digest(workspace_id+'\0start'),path=join(receipts,startKey+'.json');
  const valid=JSON.parse(await readFile(path));
  const pendingKey=digest(workspace_id+'\0valid-pending'),pendingPath=join(receipts,pendingKey+'.json');
  const pending={workspace_id,op_key:'valid-pending',fingerprint:digest('request'),created_at:Date.now(),session_id:'s',target_id:'t',status:'pending'};
  await writeFile(pendingPath,JSON.stringify(pending),{mode:0o600});
  for(const corrupt of [
    {status:'completed',result:{authority:'completed'}},
    {...valid,workspace_id:'wrong-scope'},
    {...valid,fingerprint:'not-a-digest'},
    {...valid,unexpected:'extra authority'},
    {...valid,result:{...valid.result,evidence:{...valid.result.evidence,bytes:-1}}},
    {...valid,result:{...valid.result,observation:{...valid.result.observation,text:'x'.repeat(20001)}}},
  ]){
    await writeFile(path,JSON.stringify(corrupt));
    const restarted=createBrowserCopilot({root:f.root,driver:fakeDriver(),workspaceRead:()=>({})});
    await assert.rejects(()=>restarted.dispatch({action:'receipt',workspace_id,op_key:'start'}),{code:'unavailable'});
    await restarted.close();assert.equal(JSON.parse(await readFile(pendingPath)).status,'pending');
  }
});
test('symlink ancestors and replacement feature directories cannot redirect IO; permissions stay unchanged',async t=>{
  const root=await mkdtemp('/tmp/opencode/browser-copilot-ancestors-');t.after(()=>rm(root,{recursive:true,force:true}));
  const runtime=join(root,'runtime'),outside=join(root,'outside');await mkdir(runtime,{mode:0o700});await mkdir(outside,{mode:0o700});await symlink(runtime,join(root,'alias'));
  await assert.rejects(()=>privateDirectory(join(root,'alias','browser-copilot','evidence')),{code:'unavailable'});
  assert.deepEqual(await readdir(runtime),[]);
  const feature=join(runtime,'browser-copilot');await mkdir(feature,{mode:0o700});await chmod(feature,0o755);
  await assert.rejects(()=>privateDirectory(feature),{code:'unavailable'});assert.equal((await stat(feature)).mode&0o777,0o755);
  // Only the fixture operator changes this directory's permissions.
  await chmod(feature,0o700);await privateDirectory(join(feature,'receipts'));
  await privateDirectory(join(outside,'receipts'));await rename(feature,feature+'-old');await symlink(outside,feature);
  await assert.rejects(()=>privateWrite(join(feature,'receipts','record.json'),'private bytes'),{code:'unavailable'});
  assert.deepEqual(await readdir(join(outside,'receipts')),[]);
});
test('failed temporary writes are cleaned and directory enumeration has a hard bound',async t=>{
  const root=await mkdtemp('/tmp/opencode/browser-copilot-temp-');t.after(()=>rm(root,{recursive:true,force:true}));
  const directory=join(root,'browser-copilot','receipts');await privateDirectory(directory);
  await assert.rejects(()=>privateWrite(join(directory,'failed.json'),Symbol('not bytes')),{code:'unavailable'});
  assert.deepEqual(await readdir(directory),[]);
  for(const name of ['a','b','c','d'])await privateWrite(join(directory,name),'bytes');
  await assert.rejects(()=>privateNames(directory,3),{code:'limit_exceeded'});
});
test('a valid evidence digest cannot authorize malformed accounting or unknown metadata fields',async t=>{
  const directory=await mkdtemp('/tmp/opencode/browser-copilot-bogus-evidence-');t.after(()=>rm(directory,{recursive:true,force:true}));
  const store=createCopilotEvidenceStore(directory),bytes=Buffer.from('synthetic PNG'),sha256=digest(bytes);
  await privateWrite(join(directory,sha256+'.png'),bytes);
  const meta={workspace_id,session_id:'s',target_id:'t',observation:fullObservation('t','synthetic'),sha256,bytes:-1,captured_at:Date.now()};
  const evidence_id=digest(JSON.stringify(meta));await privateWrite(join(directory,evidence_id+'.json'),JSON.stringify({...meta,evidence_id}));
  await assert.rejects(()=>store.prune({dry_run:true}),{code:'unavailable'});
  await assert.rejects(()=>store.read({workspace_id,session_id:'s',evidence_id}),{code:'unavailable'});
  const extra={...meta,bytes:bytes.length,authority:'completed'},extraId=digest(JSON.stringify(extra));
  await privateWrite(join(directory,extraId+'.json'),JSON.stringify({...extra,evidence_id:extraId}));
  await assert.rejects(()=>store.read({workspace_id,session_id:'s',evidence_id:extraId}),{code:'unavailable'});
});
test('close-target reserves the session across driver await, blocking execution and pause',async t=>{
  const {request,driver,session_id,target_id,revision}=await fixture(t);
  const p=await request({action:'preview',session_id,target_id,expected_revision:revision,operation:{kind:'click',ref:'r0'},mode:'owner'});
  let release,entered;const started=new Promise(resolve=>entered=resolve);
  driver.closeTarget=async b=>{entered();await new Promise(resolve=>release=resolve);driver.pages.get(b.target_id).closed=true;};
  const closing=request({action:'close_target',session_id,target_id,expected_revision:revision});await started;
  await assert.rejects(()=>request({action:'execute',session_id,target_id,expected_revision:revision,proposal_id:p.proposal.proposal_id,op_key:'close-race'}),{code:'busy'});
  await assert.rejects(()=>request({action:'pause',session_id}),{code:'busy'});
  assert.equal((await request({action:'receipt',op_key:'close-race'})).receipt.status,'not_found');
  release();const closed=await closing;assert.equal(closed.session.state,'active');assert.equal(closed.session.revision,revision+1);assert.equal(driver.clicks,0);assert.equal(driver.pages.get('neighbor').text,'untouched');
});
test('session close interrupting an awaited target close cannot restore active state',async t=>{
  const {request,driver,session_id,target_id,revision}=await fixture(t);
  let release,entered;const started=new Promise(resolve=>entered=resolve);
  driver.closeTarget=async()=>{entered();await new Promise(resolve=>release=resolve);};
  const closing=request({action:'close_target',session_id,target_id,expected_revision:revision});await started;
  const stopped=await request({action:'cancel',session_id});assert.equal(stopped.session.state,'unknown');
  release();assert.equal((await closing).session.state,'unknown');assert.equal(driver.pages.get('neighbor').closed,true);assert.equal(driver.clicks,0);
});
