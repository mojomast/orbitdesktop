import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { randomUUID, createHash } from 'node:crypto';
import { createAgentHandler } from '../server/agent.mjs';
import { createConversationPrivateStore } from '../server/conversation-private-store.mjs';

test('authenticated isolated conversation API: durable scoped drafts, CAS, metadata-only catalogs and binding fences', async t => {
  const directory=fs.mkdtempSync(path.join('/tmp/opencode','orbit-conversation-api-'));
  t.after(()=>fs.rmSync(directory,{recursive:true,force:true}));
  const workspace=randomUUID(), pane=randomUUID(), token='fixture-'.repeat(8), calls=[];
  const gateway=http.createServer((req,res)=>{
    calls.push(req.url);
    assert.equal(req.headers.authorization,'Bearer fake-private-key');
    assert.equal(req.method,'GET','library and drafts never mutate upstream');
    res.setHeader('Content-Type','application/json');
    if(req.url.startsWith('/api/sessions?'))return res.end(JSON.stringify({data:[{id:'existing',title:'Upstream name',prompt:'DO NOT EXPOSE'}],has_more:false}));
    if(req.url==='/api/sessions/existing')return res.end(JSON.stringify({id:'existing',title:'Upstream name'}));
    if(req.url.startsWith('/api/sessions/existing/messages'))return res.end(JSON.stringify({data:[{role:'user',content:'Earlier turn'},{role:'assistant',content:'Saved answer'}]}));
    res.statusCode=404;res.end('{}');
  });
  await new Promise(resolve=>gateway.listen(0,'127.0.0.1',resolve));
  t.after(()=>gateway.close());
  const options={token,port:0,devOrigins:[],runtimeDirectory:directory,apiUrl:`http://127.0.0.1:${gateway.address().port}`,apiKey:'fake-private-key',profilesJson:undefined,
    reply:(res,status,data)=>{res.writeHead(status,{'Content-Type':'application/json'});res.end(JSON.stringify(data));},
    workspaceRead:id=>{if(id!==workspace)throw Error('missing');return {state:{monitors:[{layout:{type:'pane',pane:{id:pane,kind:'agent'}}}]}};}};
  let handler;
  const server=http.createServer((req,res)=>handler(req,res));
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>server.close());
  const port=server.address().port, origin=`http://127.0.0.1:${port}`;
  handler=createAgentHandler({...options,port});
  const identity={workspace_id:workspace,profile_id:'default',session_id:'existing'};
  async function api(body, extra={}) {
    const response=await fetch(origin,{method:'POST',headers:{Origin:origin,Authorization:`Bearer ${token}`,'Content-Type':'application/json',...extra},body:JSON.stringify(body)});
    return {status:response.status,...await response.json()};
  }
  assert.equal((await api({action:'draft_read',...identity},{Authorization:'Bearer wrong'})).status,401);
  assert.equal((await api({action:'draft_read',...identity},{Origin:'https://evil.example'})).status,403);
  assert.equal((await api({action:'draft_read',...identity,workspace_id:randomUUID()})).status,404);
  assert.equal((await api({action:'draft_read',...identity,session_id:'../bad'})).status,400);
  assert.equal((await api({action:'draft_write',...identity,expected_revision:0,text:'x'.repeat(100001)})).status,400);
  let result=await api({action:'draft_write',...identity,expected_revision:0,text:'Owner draft'});
  assert.equal(result.record.revision,1);
  result=await api({action:'draft_write',...identity,expected_revision:0,text:'Stale device'});
  assert.equal(result.status,409);assert.equal(result.record.draft,'Owner draft');
  result=await api({action:'conversation_metadata',...identity,expected_revision:1,patch:{title:'Orbit title',pinned:true,archived:true}});
  assert.equal(result.record.revision,2);assert.equal('draft' in result.record,false);
  handler=createAgentHandler({...options,port});
  result=await api({action:'draft_read',...identity});
  assert.equal(result.record.draft,'Owner draft');assert.equal(result.record.title,'Orbit title');assert.equal(result.record.revision,2);
  assert.equal((await api({action:'draft_read',...identity,session_id:'other'})).record.draft,'');
  result=await api({action:'conversation_library',workspace_id:workspace,profile_id:'default'});
  assert.equal(result.conversations[0].title,'Orbit title');assert.equal(result.conversations[0].upstream_title,'Upstream name');
  assert.equal(result.conversations[0].archived,true);assert.equal(result.conversations[0].pinned,true);
  assert.ok(!JSON.stringify(result).includes('Owner draft'));assert.ok(!JSON.stringify(result).includes('DO NOT EXPOSE'));
  const initial=`orbit-${randomUUID()}`;
  const binding={workspace_id:workspace,pane_id:pane,profile_id:'default',session_id:initial};
  const linked=await api({action:'shared_chat',...binding,initial:{session:initial,messages:[],create_new:true}});
  const revision=linked.state.binding_revision;
  assert.equal((await api({action:'select_session',...binding,target_profile_id:'default',target_session_id:'existing',expected_binding_revision:revision-1})).status,409);
  result=await api({action:'select_session',...binding,target_profile_id:'default',target_session_id:'existing',expected_binding_revision:revision});
  assert.equal(result.state.session,'existing');assert.equal(result.state.title,'Orbit title');assert.equal(result.state.messages[0].text,'Earlier turn');
  const files=fs.readdirSync(path.join(directory,'conversation-private'));
  assert.equal(files.length,1);assert.match(files[0],/^[a-f0-9]{64}\.json$/);
  assert.equal(fs.statSync(path.join(directory,'conversation-private',files[0])).mode & 0o777,0o600);
  assert.ok(calls.every(route=>route.startsWith('/api/sessions')));
});

test('private record reads/listing reject corrupt shapes, unsafe revisions and mismatched hash keys', t => {
  const directory=fs.mkdtempSync(path.join('/tmp/opencode','orbit-conversation-integrity-'));
  t.after(()=>fs.rmSync(directory,{recursive:true,force:true}));
  const store=createConversationPrivateStore(directory);
  const scope={workspace_id:randomUUID(),profile_id:'default',session_id:'existing'};
  const filename=createHash('sha256').update(JSON.stringify([scope.workspace_id,scope.profile_id,scope.session_id])).digest('hex')+'.json';
  const file=path.join(directory,filename);
  // Older valid records need not have updated_at.
  const record={...scope,revision:1,title:'Owner title',draft:'Owner draft',pinned:false,archived:false};
  fs.writeFileSync(file,JSON.stringify(record));
  assert.deepEqual(store.read(scope),record);
  assert.deepEqual(store.list(scope.workspace_id,scope.profile_id),[record]);
  const missing={...record};delete missing.draft;
  const corrupt=[
    null,[],{...record,unknown:'unexpected'},missing,
    {...record,workspace_id:3},{...record,profile_id:null},{...record,session_id:{}},
    {...record,revision:-1},{...record,revision:1.5},{...record,revision:Number.MAX_SAFE_INTEGER+1},
    {...record,title:3},{...record,title:'x'.repeat(201)},{...record,title:'line\nbreak'},
    {...record,draft:null},{...record,draft:'x'.repeat(100001)},
    {...record,pinned:1},{...record,archived:'false'},
    {...record,updated_at:3},{...record,updated_at:'x'.repeat(101)},
    {...record,session_id:'different-key'},
  ];
  for(const value of corrupt) {
    fs.writeFileSync(file,JSON.stringify(value));
    assert.throws(()=>store.read(scope),error=>error.status===409);
    assert.throws(()=>store.list(scope.workspace_id,scope.profile_id),error=>error.status===409);
  }
  fs.writeFileSync(file,'{invalid JSON');
  assert.throws(()=>store.read(scope),error=>error.status===409);
  assert.throws(()=>store.list(scope.workspace_id,scope.profile_id),error=>error.status===409);
  fs.unlinkSync(file);
  fs.writeFileSync(path.join(directory,'0'.repeat(64)+'.json'),JSON.stringify(record));
  assert.throws(()=>store.list(scope.workspace_id,scope.profile_id),error=>error.status===409,'list must validate the hash filename too');
});

test('private store rejects symlink/non-directory roots before chmod and rejects raw record symlinks', t => {
  const directory=fs.mkdtempSync(path.join('/tmp/opencode','orbit-conversation-symlinks-'));
  t.after(()=>fs.rmSync(directory,{recursive:true,force:true}));
  const target=path.join(directory,'target');fs.mkdirSync(target,{mode:0o755});fs.chmodSync(target,0o755);
  const link=path.join(directory,'private-link');fs.symlinkSync(target,link);
  assert.throws(()=>createConversationPrivateStore(link),error=>error.status===409);
  assert.equal(fs.statSync(target).mode & 0o777,0o755,'rejected symlink must not chmod its target');
  const regular=path.join(directory,'regular');fs.writeFileSync(regular,'owner bytes',{mode:0o644});fs.chmodSync(regular,0o644);
  assert.throws(()=>createConversationPrivateStore(regular),error=>error.status===409);
  assert.equal(fs.statSync(regular).mode & 0o777,0o644);
  assert.equal(fs.readFileSync(regular,'utf8'),'owner bytes');
  const dangling=path.join(directory,'dangling');fs.symlinkSync(path.join(directory,'missing-target'),dangling);
  assert.throws(()=>createConversationPrivateStore(dangling),error=>error.status===409);
  assert.equal(fs.existsSync(path.join(directory,'missing-target')),false);
  const root=path.join(directory,'private'),store=createConversationPrivateStore(root);
  const scope={workspace_id:randomUUID(),profile_id:'default',session_id:'existing'};
  const filename=createHash('sha256').update(JSON.stringify([scope.workspace_id,scope.profile_id,scope.session_id])).digest('hex')+'.json';
  const external=path.join(directory,'external.json');
  fs.writeFileSync(external,JSON.stringify({...scope,revision:1,title:'Owner title',draft:'Owner draft',pinned:false,archived:false}));
  fs.symlinkSync(external,path.join(root,filename));
  assert.throws(()=>store.read(scope),error=>error.status===409);
  assert.throws(()=>store.list(scope.workspace_id,scope.profile_id),error=>error.status===409);
  assert.equal(fs.lstatSync(path.join(root,filename)).isSymbolicLink(),true);
});

test('revision exhaustion rejects before committing an unsafe revision or changing durable bytes', t => {
  const directory=fs.mkdtempSync(path.join('/tmp/opencode','orbit-conversation-revision-'));
  t.after(()=>fs.rmSync(directory,{recursive:true,force:true}));
  const store=createConversationPrivateStore(directory);
  const scope={workspace_id:randomUUID(),profile_id:'default',session_id:'existing'};
  const filename=createHash('sha256').update(JSON.stringify([scope.workspace_id,scope.profile_id,scope.session_id])).digest('hex')+'.json';
  const file=path.join(directory,filename);
  fs.writeFileSync(file,JSON.stringify({...scope,revision:Number.MAX_SAFE_INTEGER-1,title:'',draft:'Previous draft',pinned:false,archived:false}));
  const last=store.write(scope,Number.MAX_SAFE_INTEGER-1,{draft:'Last safe draft'});
  assert.equal(last.record.revision,Number.MAX_SAFE_INTEGER);
  const bytes=fs.readFileSync(file,'utf8');
  assert.throws(()=>store.write(scope,Number.MAX_SAFE_INTEGER,{draft:'Must not commit'}),error=>error.status===409);
  assert.equal(fs.readFileSync(file,'utf8'),bytes);
  assert.deepEqual(fs.readdirSync(directory),[filename]);
});

test('write and file-fsync failures remove temporary files and preserve the previous durable record', t => {
  const directory=fs.mkdtempSync(path.join('/tmp/opencode','orbit-conversation-io-failure-'));
  t.after(()=>fs.rmSync(directory,{recursive:true,force:true}));
  const store=createConversationPrivateStore(directory);
  const scope={workspace_id:randomUUID(),profile_id:'default',session_id:'existing'};
  store.write(scope,0,{draft:'Durable owner text'});
  const [filename]=fs.readdirSync(directory), file=path.join(directory,filename), bytes=fs.readFileSync(file,'utf8');
  for(const method of ['writeFileSync','fsyncSync']) {
    const injected=t.mock.method(fs,method,()=>{throw Object.assign(Error('Injected private-store I/O failure'),{code:'EIO'});});
    try {
      assert.throws(()=>store.write(scope,1,{draft:'Not durable'}),error=>error.code==='EIO');
      assert.deepEqual(fs.readdirSync(directory),[filename],`${method} left a temporary file`);
      assert.equal(fs.readFileSync(file,'utf8'),bytes);
    } finally {injected.mock.restore();}
  }
  assert.equal(store.write(scope,1,{draft:'Recovered save'}).record.draft,'Recovered save');
});
