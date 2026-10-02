import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {validateCopilotRequest,COPILOT_LIMITS} from '../contracts/browser-copilot-v1.mjs';
import {resolveBrowserDriver,copilotError,digest} from './browser-copilot-driver.mjs';
import {createCopilotEvidenceStore,privateDirectory,privateRead,privateWrite,privateNames} from './browser-copilot-evidence.mjs';
import {verifyReceipt,safeReceiptReason} from './browser-copilot-records.mjs';

export function createBrowserCopilot({root,runtimeDirectory,workspaceRead,driver=resolveBrowserDriver(),now=Date.now}={}){
  const directory=join(root||runtimeDirectory||'.runtime','browser-copilot');
  const evidence=createCopilotEvidenceStore(join(directory,'evidence'),{now});
  const sessions=new Map(), receipts=new Map(), proposals=new Map();let initialized,reaper;
  const receiptsDir=join(directory,'receipts');
  async function init(){if(!initialized)initialized=(async()=>{
    await privateDirectory(directory);await privateDirectory(receiptsDir);
    const names=await privateNames(receiptsDir,COPILOT_LIMITS.receiptCount),loaded=[];
    // Validate the entire store before recovering any pending record. Malformed
    // optional data is unavailable, never repaired into completed authority.
    for(const name of names){if(!/^[a-f0-9]{64}\.json$/.test(name))throw copilotError('unavailable');let r;try{r=JSON.parse(await privateRead(join(receiptsDir,name)));}catch{throw copilotError('unavailable');}loaded.push([name.slice(0,-5),verifyReceipt(r,name.slice(0,-5))]);}
    for(const [k,r] of loaded){if(r.status==='pending'){r.status='unknown';r.reason='server_restarted_browser_outcome_unknown';await save(k,r);}receipts.set(k,r);}
    reaper=setInterval(()=>{for(const s of sessions.values())if(!idle(s)&&!s.pending&&now()-s.last_seen_at>COPILOT_LIMITS.idleTimeoutMs)void stop(s).catch(()=>{});},10000);reaper.unref();
  })();await initialized;}
  const key=b=>digest(b.workspace_id+'\0'+b.op_key);
  async function save(k,r){verifyReceipt(r,k);await privateWrite(join(receiptsDir,k+'.json'),JSON.stringify(r));receipts.set(k,r);}
  async function operation(b,fn){
    const k=key(b),fingerprint=digest(JSON.stringify(b)),old=receipts.get(k);
    if(old){verifyReceipt(old,k);if(old.fingerprint!==fingerprint)throw copilotError('conflict');return {receipt:old};}
    if(receipts.size>=COPILOT_LIMITS.receiptCount)throw copilotError('limit_exceeded');
    // Reserve synchronously before IO so two requests cannot both run a click.
    const r={op_key:b.op_key,workspace_id:b.workspace_id,fingerprint,status:'pending',created_at:now(),session_id:b.session_id||null,target_id:b.target_id||null};receipts.set(k,r);
    await save(k,r);
    try{const result=await fn(r);if(r.status==='pending'){const completed={...r,status:'completed',result};verifyReceipt(completed,k);Object.assign(r,completed);}}
    catch(error){if(r.status==='pending'){r.status=r.dispatched?'unknown':'refused';r.reason=safeReceiptReason(error.code);}}
    await save(k,r);return {receipt:r};
  }
  function session(b){const s=sessions.get(b.session_id);if(!s||s.workspace_id!==b.workspace_id)throw copilotError('stale_resource');s.last_seen_at=now();return s;}
  function idle(s){return s.state==='closed'||s.state==='unknown';}
  function ready(s,b){if(idle(s))throw copilotError('stale_resource');if(s.state==='paused')throw copilotError('permission_denied');if(s.pending||s.observing||s.changing||s.stopping)throw copilotError('busy');if(s.revision!==b.expected_revision)throw copilotError('conflict');}
  function publicSession(s){return {session_id:s.session_id,state:s.state,revision:s.revision,last_seen_at:s.last_seen_at,pending_op_key:s.pending||null};}
  const observationDigest=o=>digest(JSON.stringify({origin:o.origin,url_hash:o.url_hash,elements:o.elements,text:o.text}));
  async function capture(b,observation){return evidence.put({...b,observation,bytes:await driver.screenshot(b)});}
  async function stop(s,state='closed'){
    if(s.stopping)return s.stopping;
    s.state=state;s.revision++;
    s.stopping=(async()=>{try{
      try{if(s.pending){const r=receipts.get(digest(s.workspace_id+'\0'+s.pending));if(r?.status==='pending'){r.status='unknown';r.reason='cancelled_browser_outcome_unknown';await save(digest(s.workspace_id+'\0'+s.pending),r);}}}
      finally{await driver.close({session_id:s.session_id});}
    }catch(error){s.state='unknown';s.revision++;throw error;}finally{s.pending=null;}})();
    try{await s.stopping;}finally{s.stopping=null;}
  }
  async function dispatch(b){
    if(!validateCopilotRequest(b))throw copilotError('invalid_request');
    if(!workspaceRead)throw copilotError('unavailable');
    try{if(!await workspaceRead(b.workspace_id))throw Error();}catch{throw copilotError('permission_denied');}
    if(b.action==='capability')return {...await driver.capability(),limits:COPILOT_LIMITS};
    await init();
    for(const s of sessions.values())if(!idle(s)&&!s.pending&&now()-s.last_seen_at>COPILOT_LIMITS.idleTimeoutMs)await stop(s);
    if(b.action==='receipt'){const r=receipts.get(key(b));return {receipt:r?verifyReceipt(r,key(b)):{op_key:b.op_key,status:'not_found'}};}
    if(b.action==='retention')return evidence.prune(b);
    if(b.action==='evidence')return {evidence:await evidence.read(b)};
    if(b.action==='list')return {sessions:[...sessions.values()].filter(s=>s.workspace_id===b.workspace_id).map(publicSession)};
    if(b.action==='open')return operation(b,async r=>{
      if([...sessions.values()].filter(s=>s.workspace_id===b.workspace_id&&!idle(s)).length>=COPILOT_LIMITS.sessionsPerWorkspace)throw copilotError('limit_exceeded');
      const s={session_id:randomUUID(),workspace_id:b.workspace_id,state:'starting',revision:0,last_seen_at:now()};sessions.set(s.session_id,s);
      try{r.dispatched=true;const observation=await driver.launch({...s,url:b.url});s.state='active';s.revision++;const shot=await capture({...s,target_id:observation.target_id},observation);return {session:publicSession(s),observation,evidence:shot};}
      catch(error){await stop(s,'unknown');throw error;}
    });
    if(b.action==='execute'&&receipts.has(key(b)))return operation(b,()=>{});
    const s=session(b);
    if(['close','cancel'].includes(b.action)){await stop(s,b.action==='cancel'?'unknown':'closed');return {session:publicSession(s)};}
    if(b.action==='pause'||b.action==='resume'){if(idle(s))throw copilotError('stale_resource');if(s.changing||s.stopping||(b.action==='resume'&&s.pending))throw copilotError('busy');s.state=b.action==='pause'?'paused':'active';s.revision++;return {session:publicSession(s)};}
    if(idle(s))throw copilotError('stale_resource');
    if(b.action==='targets')return {session:publicSession(s),targets:await driver.targets(b)};
    if(b.action==='close_target'){
      ready(s,b);s.changing=true;s.revision++;
      try{await driver.closeTarget(b);return {session:publicSession(s)};}
      catch(error){if(!idle(s))await stop(s,'unknown');throw copilotError('stale_resource');}
      finally{s.changing=false;}
    }
    if(b.action==='observe'){
      if(s.pending||s.observing||s.changing||s.stopping)throw copilotError('busy');s.observing=true;
      try{const observation=await driver.observe(b);s.revision++;const shot=await capture(b,observation);return {session:publicSession(s),observation,evidence:shot};}finally{s.observing=false;}
    }
    if(b.action==='preview'){
      ready(s,b);s.observing=true;
      try{if(b.operation.kind==='navigate')await driver.policy(b.operation.url);
      const observation=await driver.observe(b);const shot=await capture(b,observation);
      if(s.state!=='active')throw copilotError('permission_denied');if(s.revision!==b.expected_revision)throw copilotError('conflict');
      for(const [id,p] of proposals)if(p.session_id===s.session_id)proposals.delete(id);
      const p={proposal_id:randomUUID(),workspace_id:b.workspace_id,session_id:b.session_id,target_id:b.target_id,expected_revision:s.revision,operation:b.operation,mode:b.mode,binding:{origin:observation.origin,url_hash:observation.url_hash},observation_digest:observationDigest(observation),expires_at:now()+60000,before:shot};
      proposals.set(p.proposal_id,p);return {proposal:p,session:publicSession(s),observation,evidence:shot};}finally{s.observing=false;}
    }
    if(b.action==='execute'){
      // Existing receipts are read even after cancellation or a revision change.
      const prior=receipts.get(key(b));if(prior)return operation(b,()=>{});
      ready(s,b);const p=proposals.get(b.proposal_id);
      if(!p||p.workspace_id!==b.workspace_id||p.session_id!==b.session_id||p.target_id!==b.target_id||p.expected_revision!==s.revision||p.expires_at<now())throw copilotError('stale_resource');
      s.pending=b.op_key;
      const deadline=setTimeout(()=>void stop(s,'unknown').catch(()=>{}),30000);deadline.unref();
      try{const result=await operation(b,async r=>{
        const binding=await driver.binding(b);if(binding.origin!==p.binding.origin||binding.url_hash!==p.binding.url_hash)throw copilotError('stale_resource');
        const before=await driver.observe({...b,preserve_refs:true});if(observationDigest(before)!==p.observation_digest)throw copilotError('stale_resource');
        const beforeEvidence=await capture(b,before);
        if(s.state!=='active')throw copilotError('permission_denied');
        if(s.revision!==p.expected_revision)throw copilotError('conflict');
        r.dispatched=true;const after=await driver.act({...b,operation:p.operation,expected_binding:p.binding});const afterEvidence=await capture(b,after);s.revision++;
        return {session:publicSession(s),target_id:b.target_id,mode:p.mode,operation_kind:p.operation.kind,before:beforeEvidence,after:afterEvidence,observation:after};
      });if(result.receipt.status==='unknown')await stop(s,'unknown');return result;}finally{clearTimeout(deadline);s.pending=null;proposals.delete(b.proposal_id);}
    }
    throw copilotError('unsupported');
  }
  return {dispatch,capability:()=>driver.capability(),limits:COPILOT_LIMITS,async close(){clearInterval(reaper);await Promise.all([...sessions.values()].filter(s=>!idle(s)).map(s=>stop(s)));await driver.shutdown();}};
}
