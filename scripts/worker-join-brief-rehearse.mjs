import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath,pathToFileURL } from 'node:url';
import { createLocalWorkersRoute } from '../server/local-workers-route.mjs';
import { verifiedClientBytes } from '../server/worker-join-artifact.mjs';

export async function briefRehearsal(config){
  if(!config||Object.keys(config).sort().join()!=='bundlebees,bundlebeesRef,scanner,scannerSha256'||![config.bundlebees,config.scanner].every(p=>typeof p==='string'&&path.isAbsolute(p))||!/^([0-9a-f]{40})$/.test(config.bundlebeesRef)||!/^([0-9a-f]{64})$/.test(config.scannerSha256))throw Error('explicit_pins_required');
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'orbit-brief-')),owner=randomBytes(32).toString('base64url');let handler;
  const server=http.createServer((req,res)=>handler.handle(req,res));
  try{
    const client=path.join(dir,'client.mjs');fs.writeFileSync(client,verifiedClientBytes(),{flag:'wx',mode:0o600});verifiedClientBytes(client);const {join}=await import(pathToFileURL(client));
    await new Promise((r,j)=>{server.once('error',j);server.listen(0,'127.0.0.1',r);});const {port}=server.address(),origin=`http://127.0.0.1:${port}`;
    handler=createLocalWorkersRoute({runtimeRoot:dir,port,env:{ORBIT_TOKEN:owner,ORBIT_WORKER_JOIN_ONLY:'1'}});
    const post=async(body,priv=true,token=owner)=>{const res=await fetch(origin+'/api/local-workers',{method:'POST',redirect:'error',headers:{'Content-Type':'application/json',Authorization:`Bearer ${token}`,...(priv?{Origin:origin}:{})},body:JSON.stringify(body)});const data=await res.json();if(!res.ok)throw Error(data.error);return data;};
    const inv=()=>post({op:'invite',scopes:['sum-brief'],label:'Synthetic sum'});
    const i=await inv(), session=await join(i,{loopback:origin}), other=await join(await inv(),{loopback:origin});
    const coord=(action,attemptId,cfg=config,target=session)=>{
      const script=fileURLToPath(new URL('./worker-join/brief-coordinator.py',import.meta.url));
      return new Promise((resolve,reject)=>{const p=execFile('/usr/bin/python3',['-I','-B',script,action,target.workerId,attemptId],{cwd:dir,encoding:'utf8',timeout:60000,maxBuffer:65536,env:{PATH:'/usr/bin:/bin',HOME:dir,TMPDIR:dir,GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:'/dev/null',GIT_TERMINAL_PROMPT:'0',GIT_NO_REPLACE_OBJECTS:'1',GIT_NO_LAZY_FETCH:'1',GIT_ALLOW_PROTOCOL:'file'}},(err,out)=>{
        let data;try{data=JSON.parse(out);}catch{return reject(Error('verifier_unavailable'));}return err?reject(Error(data.error||'verifier_unavailable')):resolve(data);
      });p.stdin.on('error',()=>{});p.stdin.end(JSON.stringify(cfg));});
    };
    const aid=()=>`att_${randomBytes(8).toString('hex')}`;const id=aid();await coord('offer',id);
    assert.equal((await other.claimBrief()).brief,null);await assert.rejects(other.statusBrief(id),{code:'task_unavailable'});
    const {brief}=await session.claimBrief();assert.equal(brief.attemptId,id);assert.equal((await session.statusBrief(id)).brief.state,'claimed');
    await session.reportBrief(brief);assert.equal((await session.statusBrief(id)).brief.state,'reported');
    const accepted=await coord('verify',id);assert.equal(accepted.waveCommit,(await session.statusBrief(id)).brief.waveCommit);
    const next=aid();await coord('offer',next);await session.reportBrief((await session.claimBrief()).brief);
    await assert.rejects(coord('verify',next,{...config,scannerSha256:'0'.repeat(64)}),/scanner_digest_mismatch/);
    assert.equal((await post({op:'revoke',workerId:session.workerId})).quarantined,1);
    await assert.rejects(session.claimBrief(),{code:'credential_denied'});await assert.rejects(session.statusBrief(next),{code:'credential_denied'});await assert.rejects(coord('verify',next),/worker_unavailable/);
    const bad=aid();await coord('offer',bad,config,other);const assigned=(await other.claimBrief()).brief;
    await other.reportBrief({...assigned,a:0,b:1});await assert.rejects(coord('verify',bad,config,other),/tests_failed/);
    assert.equal((await other.statusBrief(bad)).brief.waveCommit,null);
    return {...accepted,verifiedBy:'BundleBees verify_local + integrate_job',bundlebeesRef:config.bundlebeesRef,scannerSha256:config.scannerSha256,wrongScanner:'refused',wrongTotal:'not_accepted',revokedReport:'quarantined',pushed:false};
  }finally{if(server.listening)await new Promise(r=>{server.close(r);server.closeAllConnections();});handler?.close();fs.rmSync(dir,{recursive:true,force:true});}
}
if(process.argv[1]&&pathToFileURL(process.argv[1]).href===import.meta.url){
  try{if(process.argv.length!==6)throw Error('expected CHECKOUT APPROVED_COMMIT SCANNER APPROVED_SCANNER_SHA256');const [bundlebees,bundlebeesRef,scanner,scannerSha256]=process.argv.slice(2);console.log(JSON.stringify(await briefRehearsal({bundlebees,bundlebeesRef,scanner,scannerSha256}),null,2));}
  catch(err){console.error(err.message);process.exitCode=1;}
}
