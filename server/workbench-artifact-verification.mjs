import fs from 'node:fs';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {captureProject,openProjectRoot,readProjectFile} from './project-files.mjs';
import {checkDefinition,definitionDigest,discoverTestFiles,runCheck} from './workbench-checks.mjs';
import {workbenchBuildIdentity} from './workbench-build-identity.mjs';
import {wbError} from './workbench-store.mjs';

const hash=value=>createHash('sha256').update(value).digest('hex');
const uuid=/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const sorted=value=>JSON.stringify([...value].sort((a,b)=>a.path.localeCompare(b.path)));
const mode=stat=>(stat.mode&0o111)?'100755':'100644';

// Internal confirmation-only capability. The patch exporter owns publication;
// this supplier never writes candidate jobs/review evidence or accepts commands.
export function createArtifactVerifier({store,records,data,gate,verifyCurrent,now=Date.now}){
  const root=path.join(store.root,'workbench-execution'),patchRoot=path.join(store.root,'workbench-patches');
  const held=new Map();
  const quarantine=id=>{if(!held.has(id))held.set(id,gate.quarantine(`patch-verification:${id}`));};
  // A crash during check execution loses process ownership. Do not redispatch.
  try{
    for(const row of data.db.prepare("SELECT id FROM wb_patches WHERE json_extract(record_json, '$.status') = 'verifying'").all())quarantine(row.id);
  }catch{throw wbError('unavailable');}
  const revise=(scope,id,fields)=>{
    const current=data.get('patches',scope.workspace_id,scope.project_id,id);
    return data.update('patches',scope.workspace_id,scope.project_id,id,current.revision,fields);
  };
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
    const id=randomUUID(),release=gate.claim('job',id),scope={workspace_id,project_id};
    let observed=false,completed=false;
    const observations=[];
    try{
      // The admission record is durable before copying or spawning. A restart
      // quarantines `verifying` receipts and never re-executes these checks.
      revise(scope,artifact_id,{status:'verifying',verification:{version:1,id,status:'verifying',artifact_id,artifact_hash:patch.artifact_hash,source_manifest_hash:source.hash,candidate_id:candidate.id,candidate_hash:candidate.hash,candidate_generation:candidate.generation,review_id:review.id,review_identity:review.review_identity,acceptance_digest:task.acceptance_digest,required_checks_digest:task.acceptance.required_checks_digest,recorded_by:{kind:'comet_service',component:'patch-artifact-check-recorder',build_id:workbenchBuildIdentity()},results:[]}});
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
        const raw=await runCheck({definition_id:check.definition_id,required_test_files:check.required_test_files,candidate_root:view,workspace_id,project_id,job_id:randomUUID(),artifact_root:root,rehash:verifyView,spawn_record:process=>{
          observed=true;
          const current=data.get('patches',workspace_id,project_id,artifact_id);
          revise(scope,artifact_id,{verification:{...current.verification,process:{pid:process.pid,pgid:process.pgid,started_at:process.started_at,supervisor:process.supervisor},status:'running'}});
        }});
        observations.push({definition_id:check.definition_id,definition_digest:raw.definition_digest,required_test_files:check.required_test_files,verdict:raw.verdict,test_results:raw.test_results,candidate_hash_before:raw.candidate_hash_before,candidate_hash_after:raw.candidate_hash_after,artifact_hash:raw.artifact_hash,log_hash:raw.log_hash,env_fingerprint:raw.env_fingerprint,process_survival_unknown:raw.process_survival_unknown});
        const current=data.get('patches',workspace_id,project_id,artifact_id);
        revise(scope,artifact_id,{verification:{...current.verification,results:observations,process:null,status:raw.process_survival_unknown?'outcome_unknown':'verifying'}});
        if(raw.process_survival_unknown){quarantine(artifact_id);return {verification:data.get('patches',workspace_id,project_id,artifact_id).verification};}
        if(raw.verdict!=='pass')break;
      }
      const status=observations.length===required.length&&observations.every(item=>item.verdict==='pass')?'verified':observations.some(item=>item.verdict==='fail')?'failed':'inconclusive';
      verifyView();
      const current=data.get('patches',workspace_id,project_id,artifact_id);
      const verification={...current.verification,status,results:observations,verified_at:status==='verified'?now():null,process:null};
      revise(scope,artifact_id,{status:status==='verified'?'verified':'verification_failed',verification});
      completed=true;
      return {verification};
    }catch(error){
      if(observed){quarantine(artifact_id);try{const current=data.get('patches',workspace_id,project_id,artifact_id);revise(scope,artifact_id,{verification:{...current.verification,status:'outcome_unknown',results:observations}});}catch{}}
      else try{const current=data.get('patches',workspace_id,project_id,artifact_id);if(current.status==='verifying')revise(scope,artifact_id,{status:'verification_failed',verification:{...current.verification,status:'inconclusive',results:observations}});}catch{quarantine(artifact_id);}
      throw error;
    }finally{
      if(!held.has(artifact_id))release();
      // Retain the private view when process ownership is uncertain. Logs remain
      // under the execution root; no caller-selected cleanup path is used.
      if(completed||!observed)try{fs.rmSync(view,{recursive:true,force:true});}catch{}
    }
  }
  return {verifyPatchArtifact};
}
