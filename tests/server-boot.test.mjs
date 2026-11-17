import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import net from 'node:net';
import { randomUUID, randomBytes } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, mkdir, rm, writeFile, readFile, readdir } from 'node:fs/promises';
import { initial } from '../src/model.ts';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

const repo = path.resolve(fileURLToPath(new URL('..', import.meta.url)));

function freePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const assigned = probe.address().port;
      probe.close(error => error ? reject(error) : resolve(assigned));
    });
  });
}

test('the server boots; job approvals remain unavailable to the authenticated owner and workspace controller', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'orbit-boot-'));
  const runtime = path.join(root, 'runtime');
  const home = path.join(root, 'home');
  const legacy = path.join(root, 'legacy-approvals');
  await mkdir(path.join(legacy,'pending'),{recursive:true});
  await writeFile(path.join(legacy,'pending','example.json'), JSON.stringify({id:'example',job:{example:true},expires_at:new Date(Date.now()+60000).toISOString()}));
  await Promise.all([mkdir(runtime), mkdir(home)]);
  const port = await freePort();
  assert.ok(port >= 1024);
  const token = `orbit-boot-${process.pid}-token-with-32-characters`;
  const child = spawn(process.execPath, ['--experimental-strip-types', 'server/index.mjs'], {
    cwd: repo,
    env: {
      PATH: process.env.PATH,
      HOME: home,
      TMPDIR: os.tmpdir(),
      PORT: String(port),
      ORBIT_TOKEN: token,
      ORBIT_AGENT_DISCOVERY: 'off',
      ORBIT_TMUX_SOCKET: `approval-test-${process.pid}`, ORBIT_TMUX_CONFIG:'/dev/null',
      BUNDLEBEES_APPROVALS_DIR: legacy, BUNDLEBEES_APPROVAL_SECRET: randomBytes(32).toString('hex'),
      ORBIT_RUNTIME_DIR: runtime,
      ORBIT_CWD: root,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let logs = '';
  child.stdout.on('data', chunk => { logs += chunk; });
  child.stderr.on('data', chunk => { logs += chunk; });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = new Promise(resolve => child.once('exit', resolve));
      child.kill('SIGTERM');
      await Promise.race([exited, delay(3000)]);
      if (child.exitCode === null && child.signalCode === null) {
        child.kill('SIGKILL');
        await exited;
      }
    }
    await rm(root, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${port}`;
  let health;
  for (let attempt = 0; attempt < 80; attempt++) {
    if (child.exitCode !== null) throw Error(logs || `Server exited ${child.exitCode} before /api/health`);
    try {
      const response = await fetch(base + '/api/health');
      if (response.ok) {
        health = await response.json();
        break;
      }
    } catch { /* still starting */ }
    await delay(50);
  }
  assert.ok(health, logs || 'Server did not answer /api/health');
  assert.equal(health.service, 'orbit');
  assert.equal(health.host, 'local');
  assert.equal(health.sessions, 0);
  assert.equal(logs.includes('reading \'add\''), false);
  const headers = {Origin:base, 'Content-Type':'application/json'};
  const auth = await fetch(base+'/api/auth',{method:'POST',headers,body:JSON.stringify({token})});
  assert.equal(auth.status,200,'fixture bearer must actually authenticate to Orbit');
  const workspace_id = randomUUID();
  async function workspace(route, key, command) {
    return fetch(base+route,{method:'POST',headers:{...headers,Authorization:`Bearer ${key}`},body:JSON.stringify({workspace_id,...command})});
  }
  assert.equal((await workspace('/api/workspace',token,{action:'sync',state:initial()})).status,200);
  const {capability} = JSON.parse(await readFile(path.join(runtime,'workspace-access',`${workspace_id}.json`),'utf8'));
  assert.equal((await workspace('/api/workspace/control',capability,{action:'read'})).status,200);
  assert.equal((await workspace('/api/workspace',capability,{action:'read'})).status,403);
  for (const credentials of [{}, {Authorization:`Bearer ${token}`}, {Authorization:`Bearer ${capability}`}, {'X-Actor':'owner','X-Workspace-Id':workspace_id}]) {
    for (const [suffix,opts] of [['',{}],['/example',{}],['/example/decision',{method:'POST',body:JSON.stringify({decision:'approve'})}]]) {
      const denied = await fetch(base+'/api/approvals'+suffix,{...opts,headers:{...headers,...credentials}});
      assert.equal(denied.status,404);
    }
  }
  assert.deepEqual(await readdir(legacy),['pending']);
  assert.equal((await fetch(base+'/apps/rizzstack-approvals/')).status,404);
});
