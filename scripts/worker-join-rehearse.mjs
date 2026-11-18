// Local acceptance only. No live target argument, environment discovery,
// Docker, SSH, subprocess, admin key file, or caller-selected cleanup path.
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createLocalWorkersRoute } from '../server/local-workers-route.mjs';
import { verifiedClientBytes, workerInstallDryRun } from '../server/worker-join-artifact.mjs';

export async function rehearse(mode = '--dry-run') {
  if (!['--dry-run','--local'].includes(mode)) throw Error('expected --dry-run or --local');
  const report = { ...workerInstallDryRun(), stage:'not_run', pairing:'not_run', replay:'not_run',
    pairingLifetimeMs:null, probes:[], digestCheck:'not_run', revocation:'not_run', teardown:'not_run',
    nativeTailcat:'not_run', imageInstall:'not_run', acceptedWave:'not_run', secondHost:'not_run', liveHost:'not_run' };
  if (mode === '--dry-run') return report;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(),'orbit-join-rehearsal-'));
  const owner = randomBytes(32).toString('base64url');
  let handler;
  const server = http.createServer((req,res) => handler.handle(req,res));
  try {
    const staged = path.join(dir,'client.mjs');
    fs.writeFileSync(staged,verifiedClientBytes(),{ flag:'wx',mode:0o600 });
    verifiedClientBytes(staged); report.stage = 'verified';
    const { join } = await import(pathToFileURL(staged));
    await new Promise((resolve,reject) => { server.once('error',reject); server.listen(0,'127.0.0.1',resolve); });
    const { port } = server.address(), origin = `http://127.0.0.1:${port}`;
    const makeHandler = () => createLocalWorkersRoute({ runtimeRoot:dir, port, env:{ ORBIT_WORKER_JOIN_ONLY:'1',ORBIT_TOKEN:owner } });
    handler = makeHandler();
    const post = async (body, privileged = true) => {
      const response = await fetch(origin + '/api/local-workers',{ method:'POST',redirect:'error',
        headers:{ 'Content-Type':'application/json', ...(privileged ? { Origin:origin,Authorization:`Bearer ${owner}` } : {}) },body:JSON.stringify(body) });
      const data = await response.json();
      if (!response.ok) throw Object.assign(Error('local_operation_failed'),{ code:data.error });
      return data;
    };
    const invite = await post({ op:'invite',label:'Throwaway verification',scopes:['presence','verify-client'] });
    const session = await join(invite,{ loopback:origin }); report.probes = session.transport.observations;
    await session.heartbeat(); await session.refresh(); report.pairing = 'joined';
    await assert.rejects(post({ op:'pair',code:invite.code,workerId:invite.workerId },false),{ code:'pairing_denied' });
    report.replay = 'refused';
    const state = await post({ op:'inventory' }); report.pairingLifetimeMs = invite.expiresAt - state.workers[0].issuedAt;
    const queue = () => post({ op:'queue-verification',workerId:session.workerId });
    const { taskId } = await queue(); assert.equal((await session.claim()).task.taskId,taskId);
    await session.report(taskId); assert.equal((await post({ op:'review-verification',taskId })).state,'digest_matched');
    report.digestCheck = 'staged_bytes_and_report_match_pin';
    const second = await queue(); await session.claim(); await session.report(second.taskId);
    assert.equal((await post({ op:'revoke',workerId:session.workerId })).quarantined,1);
    handler.close(); handler = makeHandler(); // reopen DB with no in-memory sessions
    await assert.rejects(session.claim(),{ code:'credential_denied' });
    await assert.rejects(session.refresh(),{ code:'credential_denied' });
    await assert.rejects(post({ op:'review-verification',taskId:second.taskId }),{ code:'task_unavailable' });
    assert.equal((await post({ op:'inventory' })).tasks.find(t => t.taskId === second.taskId).state,'quarantined');
    report.revocation = 'claim_and_refresh_denied_report_quarantined_after_reopen';
  } finally {
    if (server.listening) await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
    handler?.close(); fs.rmSync(dir,{ recursive:true,force:true });
    assert.equal(fs.existsSync(dir),false); report.teardown = 'local_stage_removed_listener_closed';
  }
  return report;
}
if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  try {
    if (process.argv.length > 3) throw Error('no targets accepted');
    console.log(JSON.stringify(await rehearse(process.argv[2]),null,2));
  } catch { console.error('Worker join rehearsal failed. Only --dry-run and --local are accepted.'); process.exitCode = 1; }
}
