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
});
