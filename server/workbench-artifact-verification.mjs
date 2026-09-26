import fs from 'node:fs';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {captureProject,openProjectRoot,readProjectFile} from './project-files.mjs';
import {checkDefinition,definitionDigest,discoverTestFiles,runCheck,cancelCheck} from './workbench-checks.mjs';
import {workbenchBuildIdentity} from './workbench-build-identity.mjs';
import {wbError} from './workbench-store.mjs';

const hash=value=>createHash('sha256').update(value).digest('hex');
const uuid=/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const sorted=value=>JSON.stringify([...value].sort((a,b)=>a.path.localeCompare(b.path)));
const mode=stat=>(stat.mode&0o111)?'100755':'100644';
const canonical=value=>Array.isArray(value)?`[${value.map(canonical).join(',')}]`:value&&typeof value==='object'?`{${Object.keys(value).sort().map(key=>`${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`:JSON.stringify(value);
const digest=value=>hash(canonical(value));

// Internal confirmation-only capability. The patch exporter owns publication;
// this supplier never writes candidate jobs/review evidence or accepts commands.
export function createArtifactVerifier({store,records,data,gate,verifyCurrent,now=Date.now}){
  const root=path.join(store.root,'workbench-execution'),patchRoot=path.join(store.root,'workbench-patches');
  const journalRoot=path.join(root,'patch-verification-pending');fs.mkdirSync(journalRoot,{recursive:true,mode:0o700});
  const held=new Map(),leases=new Map(),activeRuns=new Map(),inProgress=new Set();
  const quarantine=id=>{if(!held.has(id))held.set(id,gate.quarantine(`patch-verification:${id}`));};
  const releaseGate=id=>{leases.get(id)?.();leases.delete(id);held.get(id)?.();held.delete(id);};
  const journalPath=id=>{if(!uuid.test(id))throw wbError('invalid_request');return path.join(journalRoot,`${id}.json`);};
  const journalDigest=record=>digest(record);
  function journal(id){
    const target=journalPath(id);
    if(!fs.existsSync(target))return null;
    let envelope;
    try{const stat=fs.lstatSync(target);if(!stat.isFile()||stat.isSymbolicLink()||stat.nlink!==1||stat.size>65536)throw Error();envelope=JSON.parse(fs.readFileSync(target,'utf8'));}
    catch{throw wbError('outcome_unknown');}
    if(envelope?.digest!==journalDigest(envelope.record)||envelope.record?.artifact_id!==id||envelope.record?.version!==1)throw wbError('outcome_unknown');
    return envelope.record;
  }
  function writeJournal(record){
    const target=journalPath(record.artifact_id),temp=`${target}.${randomUUID()}.tmp`,bytes=JSON.stringify({record,digest:journalDigest(record)});
    if(Buffer.byteLength(bytes)>65536)throw wbError('limit_exceeded');
    const fd=fs.openSync(temp,fs.constants.O_WRONLY|fs.constants.O_CREAT|fs.constants.O_EXCL|fs.constants.O_NOFOLLOW,0o600);
    try{fs.writeFileSync(fd,bytes);fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
    fs.renameSync(temp,target);
    const dir=fs.openSync(journalRoot,fs.constants.O_RDONLY|fs.constants.O_DIRECTORY|fs.constants.O_NOFOLLOW);
    try{fs.fsyncSync(dir);}finally{fs.closeSync(dir);}
  }
  const clearJournal=id=>{try{fs.unlinkSync(journalPath(id));}catch(error){if(error.code!=='ENOENT')throw error;}};
  const recoveryDigest=(patch,observed)=>digest({version:1,artifact_id:patch.id,verification_id:patch.verification?.id,status:patch.status,artifact_hash:patch.artifact_hash,process:patch.verification?.process??null,journal_digest:observed?journalDigest(observed):null});
  const revise=(scope,id,fields)=>{
    const current=data.get('patches',scope.workspace_id,scope.project_id,id);
    return data.update('patches',scope.workspace_id,scope.project_id,id,current.revision,fields);
  };
  function outcome(patch,record){
    if(record.verification_id!==patch.verification?.id||record.artifact_hash!==patch.artifact_hash||record.workspace_id!==patch.workspace_id||record.project_id!==patch.project_id||!Array.isArray(record.results)||record.results.length<1||record.results.length>8||record.results.some(item=>!['pass','fail','inconclusive'].includes(item.verdict)||item.process_survival_unknown))throw wbError('outcome_unknown');
    const all=record.results.length===record.required_count&&record.results.every(item=>item.verdict==='pass');
    const status=all?'verified':record.results.some(item=>item.verdict==='fail')?'failed':'inconclusive';
    return {status,verification:{...patch.verification,status,results:record.results,process:null,verified_at:all?now():null,recovery_digest:null}};
  }
  function settle(patch,record){
    const fields=outcome(patch,record),scope={workspace_id:patch.workspace_id,project_id:patch.project_id};
    // This is DB-only: never inspect a deleted stage or launch a verifier here.
    const updated=revise(scope,patch.id,{status:fields.status==='verified'?'verified':'verification_failed',verification:fields.verification});
    releaseGate(patch.id);
    try{clearJournal(patch.id);}catch{} // A committed terminal receipt wins over a stale journal.
    return {verification:updated.verification,replayed:true};
  }
  function recovery({workspace_id,project_id,artifact_id}){
    store.read(workspace_id);
    const patch=data.get('patches',workspace_id,project_id,artifact_id);
    let observed=null,valid=true;
    try{observed=journal(artifact_id);}catch{valid=false;}
    return {artifact_id,status:patch.status,verification_status:patch.verification?.status??null,recovery_digest:recoveryDigest(patch,valid?observed:null),recoverable:!!observed&&valid,process_owned:activeRuns.has(artifact_id)};
  }
  function retryPatchArtifact({workspace_id,project_id,artifact_id,expected_digest}){
    const state=recovery({workspace_id,project_id,artifact_id}),patch=data.get('patches',workspace_id,project_id,artifact_id);
    if(!['verifying','verification_pending','outcome_unknown'].includes(patch.status)||state.recovery_digest!==expected_digest||inProgress.has(artifact_id))throw wbError('stale_resource');
    const observed=journal(artifact_id);
    if(!observed)throw wbError('outcome_unknown');
    let record=observed;
    if(observed.results.length===observed.required_count&&observed.results.every(item=>item.verdict==='pass')){
      try{
        const project=records.project(workspace_id,project_id),candidate=data.get('candidates',workspace_id,project_id,patch.candidate_id),task=data.get('tasks',workspace_id,project_id,patch.task_id),review=data.get('reviews',workspace_id,project_id,patch.review_id);
        patchBytes(patch);
        verifyCurrent({workspace_id,project_id,patch,candidate,task,review,project});
        if(captureProject(project).hash!==patch.source.manifest_hash)throw wbError('stale_resource');
      }catch{
        record={...observed,results:observed.results.map((item,index)=>index===observed.results.length-1?{...item,verdict:'inconclusive',recovery_note:'identity_changed_after_observation'}:item)};
      }
    }
    try{return settle(patch,record);}catch(error){quarantine(artifact_id);throw error;}
  }
  function acknowledgePatchArtifactUnknown({workspace_id,project_id,artifact_id,expected_digest,known_externally_terminated}){
    const state=recovery({workspace_id,project_id,artifact_id}),patch=data.get('patches',workspace_id,project_id,artifact_id);
    if(known_externally_terminated!==true||!['verifying','outcome_unknown'].includes(patch.status)||state.recovery_digest!==expected_digest||inProgress.has(artifact_id)||state.recoverable)throw wbError('stale_resource');
    const verification={...patch.verification,status:'acknowledged_unknown',process:null,recovery_digest:null,owner_asserted_terminated:true,acknowledged_at:now()};
    const updated=revise({workspace_id,project_id},artifact_id,{status:'verification_failed',verification});
    releaseGate(artifact_id);try{clearJournal(artifact_id);}catch{}
    return {verification:updated.verification};
  }
  function cancelPatchArtifact({workspace_id,project_id,artifact_id}){
    const state=recovery({workspace_id,project_id,artifact_id}),patch=data.get('patches',workspace_id,project_id,artifact_id),run=activeRuns.get(artifact_id);
    if(patch.status!=='verifying'||!state.process_owned||!run||run.job_id!==patch.verification?.process?.job_id||run.pid!==patch.verification.process.pid||String(run.started_at)!==String(patch.verification.process.started_at))throw wbError('stale_resource');
    const request=cancelCheck(run);
    if(!request.requested)throw wbError('outcome_unknown');
    return {requested:true,confirmed:request.confirmed,artifact_id};
  }
  // Reconcile a known journal as pending. Lost process ownership without an
  // observed journal is unknown, and only explicit digest-bound owner risk
  // acknowledgment releases its shared quarantine.
  try{
    for(const row of data.db.prepare("SELECT record_json FROM wb_patches WHERE json_extract(record_json, '$.status') IN ('verifying','verification_pending','outcome_unknown')").all()){
      const patch=JSON.parse(row.record_json);let observed=null;
      try{observed=journal(patch.id);if(observed)outcome(patch,observed);}catch{observed=null;}
      if(observed){
        if(patch.status!=='verification_pending')try{revise(patch,patch.id,{status:'verification_pending',verification:{...patch.verification,status:'verification_pending',recovery_digest:recoveryDigest(patch,observed)}});}catch{}
        quarantine(patch.id);
      }else if(patch.status==='verifying'&&!patch.verification?.process){
        try{revise(patch,patch.id,{status:'verification_failed',verification:{...patch.verification,status:'inconclusive',process:null}});}catch{quarantine(patch.id);}
      }else{
        if(patch.status!=='outcome_unknown')try{revise(patch,patch.id,{status:'outcome_unknown',verification:{...patch.verification,status:'outcome_unknown',recovery_digest:recoveryDigest(patch,null)}});}catch{}
        quarantine(patch.id);
      }
    }
  }catch{throw wbError('unavailable');}
  function stageFiles(stage,expected){
    const opened=openProjectRoot(stage),files=[];
    try{
      const capture=captureProject({root:stage,identity:opened.identity});
      if(capture.limited||sorted(capture.manifest)!==sorted(expected.map(({path,hash,bytes})=>({path,hash,bytes}))))throw wbError('stale_resource');
      if(capture.exclusions.length!==1||capture.exclusions[0].path!=='.git'||capture.exclusions[0].reason!=='excluded_by_policy')throw wbError('unsupported');
      for(const file of expected){
        const read=readProjectFile({root:stage,identity:opened.identity},file.path);
        const stat=fs.lstatSync(path.join(stage,file.path));
        if(!stat.isFile()||stat.isSymbolicLink()||mode(stat)!==file.mode||read.hash!==file.hash||read.bytes.length!==file.bytes)throw wbError('stale_resource');
        files.push({path:file.path,hash:file.hash,bytes:file.bytes,mode:file.mode,content:read.bytes});
      }
      return files;
    }finally{opened.close();}
  }
  function patchBytes(record){
    const target=record.private_root;
    if(typeof target!=='string'||path.dirname(target)!==patchRoot||!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}\.patch$/.test(path.basename(target)))throw wbError('permission_denied');
    const fd=fs.openSync(target,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);
    try{const stat=fs.fstatSync(fd),bytes=fs.readFileSync(fd);if(!stat.isFile()||stat.nlink!==1||stat.size!==record.bytes||hash(bytes)!==record.artifact_hash)throw wbError('stale_resource');}
    finally{fs.closeSync(fd);}
  }
  async function verifyPatchArtifact({workspace_id,project_id,artifact_id,stage_root}){
    if(!uuid.test(artifact_id)||typeof stage_root!=='string'||!path.isAbsolute(stage_root))throw wbError('invalid_request');
    const parent=path.dirname(stage_root),name=path.basename(parent);
    if(stage_root!==path.join(parent,'roundtrip')||path.dirname(parent)!==patchRoot||!/^\.verify-[a-f0-9-]{36}$/.test(name)||!uuid.test(name.slice(8)))throw wbError('permission_denied');
    const project=records.project(workspace_id,project_id),patch=data.get('patches',workspace_id,project_id,artifact_id);
    if(patch.status!=='preparing'||!patch.roundtrip?.verified||patch.workspace_id!==workspace_id||patch.project_id!==project_id)throw wbError('stale_resource');
    patchBytes(patch);
    const candidate=data.get('candidates',workspace_id,project_id,patch.candidate_id),task=data.get('tasks',workspace_id,project_id,patch.task_id),review=data.get('reviews',workspace_id,project_id,patch.review_id);
    const required=task.acceptance?.required_checks;
    if(!Array.isArray(required)||!required.length||candidate.project_generation!==project.generation||task.project_generation!==project.generation||candidate.task_id!==task.id||task.candidate_id!==candidate.id||candidate.hash!==patch.candidate_hash||candidate.generation!==patch.candidate_generation||candidate.source_manifest_hash!==patch.source?.manifest_hash||review.decision!=='approved'||review.review_identity!==patch.review_identity||review.candidate_hash!==candidate.hash||task.acceptance_digest!==patch.review?.required_check_state?.acceptance_digest)throw wbError('stale_resource');
    if(required.some(check=>check.execution_profile_id!==null&&check.execution_profile_id!==undefined))throw wbError('unsupported');
    verifyCurrent({workspace_id,project_id,patch,candidate,task,review,project});
    if(sorted(candidate.files.map(({path,hash,bytes})=>({path,hash,bytes})))!==sorted(patch.candidate.files.map(({path,hash,bytes})=>({path,hash,bytes}))))throw wbError('stale_resource');
    const source=captureProject(project);
    if(source.hash!==patch.source.manifest_hash||source.limited||sorted(source.manifest)!==sorted(patch.source.files.map(({path,hash,bytes})=>({path,hash,bytes}))))throw wbError('stale_resource');
    for(const file of patch.source.files){const stat=fs.lstatSync(path.join(project.root,file.path));if(!stat.isFile()||stat.isSymbolicLink()||mode(stat)!==file.mode)throw wbError('stale_resource');}
    const exact=stageFiles(stage_root,patch.candidate.files);
    for(const check of required){
      if(check.definition_digest!==definitionDigest(checkDefinition(check.definition_id))||check.definition_id==='node-test'&&(!check.required_test_files?.length||JSON.stringify(check.required_test_files)!==JSON.stringify(discoverTestFiles(candidate.files))))throw wbError('stale_resource');
    }
    const view=path.join(root,'patch-verification',randomUUID());
    const id=randomUUID(),release=gate.claim('job',id),scope={workspace_id,project_id};leases.set(artifact_id,release);
    inProgress.add(artifact_id);
    let observed=false,completed=false,known=false,launchedAttempt=false;
    const observations=[];
    try{
      // The admission record is durable before copying or spawning. A restart
      // quarantines `verifying` receipts and never re-executes these checks.
      const required_checks_digest=digest(required);
      if(task.acceptance.required_checks_digest!==undefined&&task.acceptance.required_checks_digest!==required_checks_digest)throw wbError('stale_resource');
      revise(scope,artifact_id,{status:'verifying',verification:{version:1,id,status:'verifying',artifact_id,artifact_hash:patch.artifact_hash,source_manifest_hash:source.hash,candidate_id:candidate.id,candidate_hash:candidate.hash,candidate_generation:candidate.generation,review_id:review.id,review_identity:review.review_identity,acceptance_digest:task.acceptance_digest,required_checks_digest,recorded_by:{kind:'comet_service',component:'patch-artifact-check-recorder',build_id:workbenchBuildIdentity()},results:[],process:null}});
      fs.mkdirSync(view,{recursive:true,mode:0o700});
      for(const file of exact){const destination=path.join(view,file.path);fs.mkdirSync(path.dirname(destination),{recursive:true,mode:0o700});fs.writeFileSync(destination,file.content,{flag:'wx',mode:file.mode==='100755'?0o700:0o600});}
      const verifyView=()=>{
        patchBytes(patch);
        verifyCurrent({workspace_id,project_id,patch,candidate,task,review,project});
        const read=stageFiles(stage_root,patch.candidate.files);
        const captured=captureProject({root:view});
        if(captured.limited||captured.exclusions.length||sorted(captured.manifest)!==sorted(patch.candidate.files.map(({path,hash,bytes})=>({path,hash,bytes}))))throw wbError('stale_resource');
        for(const file of read){const observed=readProjectFile({root:view},file.path),stat=fs.lstatSync(path.join(view,file.path));if(observed.hash!==file.hash||mode(stat)!==file.mode)throw wbError('stale_resource');}
        if(captureProject(project).hash!==source.hash)throw wbError('stale_resource');
        return {hash:hash(sorted(read.map(({path,hash,bytes,mode})=>({path,hash,bytes,mode}))))};
      };
      for(const check of required){
        const job_id=randomUUID();observed=false;known=false;
        const starting=data.get('patches',workspace_id,project_id,artifact_id);
        revise(scope,artifact_id,{verification:{...starting.verification,process:{job_id,state:'starting'},status:'verifying'}});
        launchedAttempt=true;
        const raw=await runCheck({definition_id:check.definition_id,required_test_files:check.required_test_files,candidate_root:view,workspace_id,project_id,job_id,artifact_root:root,rehash:verifyView,spawn_record:process=>{
          observed=true;activeRuns.set(artifact_id,{job_id,pid:process.pid,started_at:String(process.started_at)});
          const current=data.get('patches',workspace_id,project_id,artifact_id);
          revise(scope,artifact_id,{verification:{...current.verification,process:{job_id,pid:process.pid,pgid:process.pgid,started_at:String(process.started_at),supervisor:process.supervisor},status:'running'}});
        }});
        activeRuns.delete(artifact_id);launchedAttempt=false;
        if(raw.process_survival_unknown)throw wbError('outcome_unknown');
        observations.push({definition_id:check.definition_id,definition_digest:raw.definition_digest,required_test_files:check.required_test_files,verdict:raw.verdict,test_results:raw.test_results,candidate_hash_before:raw.candidate_hash_before,candidate_hash_after:raw.candidate_hash_after,artifact_hash:raw.artifact_hash,log_hash:raw.log_hash,env_fingerprint:raw.env_fingerprint,process_survival_unknown:raw.process_survival_unknown});
        const record={version:1,workspace_id,project_id,artifact_id,verification_id:id,artifact_hash:patch.artifact_hash,required_count:required.length,results:[...observations]};
        writeJournal(record);known=true;
        const current=data.get('patches',workspace_id,project_id,artifact_id);
        if(raw.verdict!=='pass'||observations.length===required.length){
          const result=settle(current,record);completed=true;return {...result,replayed:false};
        }
        revise(scope,artifact_id,{verification:{...current.verification,results:[...observations],process:null,status:'verifying'}});
        clearJournal(artifact_id);known=false;
      }
      throw wbError('unavailable');
    }catch(error){
      activeRuns.delete(artifact_id);
      let staged=null;try{staged=journal(artifact_id);}catch{}
      if(staged){
        quarantine(artifact_id);
        try{const current=data.get('patches',workspace_id,project_id,artifact_id);if(current.status==='verifying')revise(scope,artifact_id,{status:'verification_pending',verification:{...current.verification,status:'verification_pending',recovery_digest:recoveryDigest(current,staged)}});}catch{}
      }else if(observed||launchedAttempt){
        quarantine(artifact_id);
        try{const current=data.get('patches',workspace_id,project_id,artifact_id);revise(scope,artifact_id,{status:'outcome_unknown',verification:{...current.verification,status:'outcome_unknown',recovery_digest:recoveryDigest(current,null)}});}catch{}
      }else{
        try{const current=data.get('patches',workspace_id,project_id,artifact_id);if(current.status==='verifying')revise(scope,artifact_id,{status:'verification_failed',verification:{...current.verification,status:'inconclusive',process:null,results:[...observations]}});}catch{quarantine(artifact_id);}
      }
      throw error;
    }finally{
      inProgress.delete(artifact_id);
      if(!held.has(artifact_id))releaseGate(artifact_id);
      // Retain the private view when process ownership is uncertain. Logs remain
      // under the execution root; no caller-selected cleanup path is used.
      if(completed||!observed&& !known)try{fs.rmSync(view,{recursive:true,force:true});}catch{}
    }
  }
  return {verifyPatchArtifact,retryPatchArtifact,acknowledgePatchArtifactUnknown,cancelPatchArtifact,patchArtifactRecovery:recovery};
}
