import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { initial } from '../src/model.ts';
import { createWorkspaceService } from '../server/workspace.mjs';
import {WorkbenchStore} from '../server/workbench-store.mjs';
const exec = promisify(execFile);

test('Hermes plugin uses real Orbit API: preview, apply, conflict, checkpoint, restore', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-plugin-e2e-'));
  const token = randomUUID();
  let service;
  const server = http.createServer((req, res) => service.handle(req, res, req.url === '/api/workspace/control'));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const origin = `http://127.0.0.1:${port}`;
  service = createWorkspaceService({ token, port, root, devOrigins: [], reply: (res, status, body) => {
    res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body));
  }});
   t.after(async () => { await new Promise(resolve => server.close(resolve)); service.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const workspace = randomUUID();
  const seeded = await fetch(origin + '/api/workspace', { method: 'POST', headers: {
    Origin: origin, Authorization: `Bearer ${token}`, 'Content-Type': 'application/json',
  }, body: JSON.stringify({ action: 'sync', workspace_id: workspace, state: initial() }) });
  assert.equal(seeded.status, 200);
  const python = `
import importlib.util,json,sys
spec=importlib.util.spec_from_file_location('orbit',sys.argv[1]); module=importlib.util.module_from_spec(spec); spec.loader.exec_module(module)
class Context:
 def get_config(self,key,default=None): return {'runtime_dir':sys.argv[2],'workspace_id':sys.argv[3],'allow_mutations':True}.get(key,default)
 def register_tool(self,**kwargs): self.handler=kwargs['handler']
ctx=Context(); module.register(ctx); print(ctx.handler(json.loads(sys.argv[4])))
`;
  async function call(params) {
    const { stdout } = await exec('python3', ['-c', python, path.resolve('hermes-plugin/__init__.py'), root, workspace, JSON.stringify(params)]);
    return JSON.parse(stdout);
  }
  const read = await call({ action: 'read' });
  assert.equal(read.ok, true);
  const description=await call({action:'describe',catalog:true});
  assert.equal(description.ok,true);
  assert.equal(description.result.catalog.operations.layout_panes.input.properties.action.const,'layout_panes');
  assert.equal(description.result.catalog.limits.maxOperations,32);
  assert.deepEqual(description.result.bindings,[],'unbound initial panes must not invent project roles');
  const revision = read.result.revision;
  const operations = [{ action: 'sidebar', hidden: true }];
  assert.equal((await call({ action: 'preview', base_revision: revision, operations })).ok, true);
  assert.equal((await call({ action: 'read' })).result.revision, revision);
  const applied = await call({ action: 'apply', base_revision: revision, operations });
  assert.equal(applied.ok, true);
  assert.equal(applied.result.state.sidebarHidden, true);
  assert.equal((await call({ action: 'apply', base_revision: revision, operations })).status, 409);
  const history = await call({ action: 'history' });
  assert.equal(history.ok, true);
  const checkpoint = history.result.checkpoints[0].id;
  const restored = await call({ action: 'restore', base_revision: applied.result.revision, checkpoint_id: checkpoint, confirm: true });
  assert.equal(restored.ok, true);
  assert.equal(Boolean(restored.result.state.sidebarHidden), Boolean(read.result.state.sidebarHidden));
  assert.equal((await call({ action: 'checkpoint', label: 'Verified plugin integration' })).ok, true);
  const records=new WorkbenchStore(service.store);
  const project=records.register(workspace,{root:'/synthetic/hermes-arrangement',name:'Adapter fixture',identity:'fixture'});
  const current=service.store.read(workspace),pane=current.state.monitors[2].layout.pane;
  const resource=records.resource(project.id,'synthetic-terminal',{kind:'terminal',pane_id:pane.id});
  records.bind({workspace_id:workspace,project_id:project.id,resource_id:resource.id,pane_id:pane.id,base_revision:current.revision,role:'active_terminal'});
  const arrangement=request=>call({action:'arrangement',request:{project_id:project.id,...request}});
  const saved=await arrangement({action:'recipe_save',name:'Debug adapter',roles:['active_terminal'],layout:'columns',renderer:'windows',op_id:randomUUID()});
  assert.equal(saved.ok,true,JSON.stringify(saved));
  const preview=await arrangement({action:'recipe_preview',recipe:'project_focus',recipe_id:saved.result.recipe.id,width:1000,height:700,renderer:'windows'});
  assert.equal(preview.ok,true,JSON.stringify(preview));
  const apply={action:'recipe_apply',recipe:'project_focus',preview_id:preview.result.preview_id,preview_digest:preview.result.preview_digest,viewport:preview.result.viewport,op_id:randomUUID()};
  const committed=await arrangement(apply);
  assert.equal(committed.ok,true,JSON.stringify(committed));
  const retry=await arrangement(apply);
  assert.equal(retry.ok,true);assert.equal(retry.result.idempotent,true);
  assert.equal(retry.result.workspace.revision,committed.result.workspace.revision);
  const inverse=await arrangement({action:'recipe_preview',recipe:'return'});
  assert.equal(inverse.ok,true);
  const returned=await arrangement({action:'recipe_apply',recipe:'return',preview_id:inverse.result.preview_id,preview_digest:inverse.result.preview_digest,op_id:randomUUID()});
  assert.equal(returned.ok,true,JSON.stringify(returned));
  assert.deepEqual(returned.result.workspace.state,current.state);
  assert.deepEqual(returned.result.workspace.placement,current.placement);
});
