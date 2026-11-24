import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as pause } from 'node:timers/promises';
import { join } from '../scripts/worker-join/client.mjs';

test('real Orbit mount in join-only mode pairs and revokes without initializing the launcher',async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(),'orbit-join-boot-'));
  const runtime = path.join(dir,'runtime'), owner = randomBytes(32).toString('base64url');
  const probe = net.createServer();
  await new Promise((resolve,reject)=>{probe.once('error',reject);probe.listen(0,'127.0.0.1',resolve);});
  const { port } = probe.address(), origin = `http://127.0.0.1:${port}`;
  await new Promise(resolve=>probe.close(resolve));
  const child = spawn(process.execPath,['--experimental-strip-types','server/index.mjs'],{ stdio:'ignore',env:{
    PATH:process.env.PATH, HOME:dir,TMPDIR:dir,PORT:String(port),ORBIT_HOST:'127.0.0.1',ORBIT_CWD:dir,
    ORBIT_RUNTIME_DIR:runtime,ORBIT_TOKEN:owner,ORBIT_AGENT_DISCOVERY:'off',ORBIT_TMUX_SOCKET:`join-${process.pid}`,ORBIT_TMUX_CONFIG:'/dev/null',
    ORBIT_WORKER_JOIN_ONLY:'1',ORBIT_LOCAL_WORKERS:'1',
  } });
  t.after(async()=>{
    if (child.exitCode===null && child.signalCode===null) {
      const closed = new Promise(resolve=>child.once('exit',resolve)); child.kill('SIGTERM');
      const watchdog = setTimeout(()=>child.kill('SIGKILL'),3000); try { await closed; } finally { clearTimeout(watchdog); }
    }
    fs.rmSync(dir,{ recursive:true,force:true });
  });
  let ready = false;
  for (let i=0; i<150 && child.exitCode===null; i++) {
    try { if ((await (await fetch(origin+'/api/health')).json()).service==='orbit') { ready=true; break; } } catch {}
    await pause(50);
  }
  assert.ok(ready,'isolated Orbit did not start');
  const ownerOp = async body=>{
    const res = await fetch(origin+'/api/local-workers',{ method:'POST',headers:{ Origin:origin,Authorization:`Bearer ${owner}`,'Content-Type':'application/json' },body:JSON.stringify(body) });
    assert.equal(res.status,200); return res.json();
  };
  const invite = await ownerOp({ op:'invite',label:'Boot test',scopes:['presence'] });
  const session = await join(invite,{ loopback:origin }); await session.heartbeat();
  assert.equal((await ownerOp({ op:'inventory' })).workers[0].workerId,session.workerId);
  await ownerOp({ op:'revoke',workerId:session.workerId }); await assert.rejects(session.heartbeat(),{ code:'credential_denied' });
  assert.equal(fs.existsSync(path.join(runtime,'local-workers')),false);
});
