import path from 'node:path';
import fs from 'node:fs';
import {createHash,randomUUID} from 'node:crypto';
import Ajv from 'ajv';
import {workbenchSchema} from '../contracts/workbench-v1.mjs';
import {WorkbenchStore,wbError} from './workbench-store.mjs';
import {openProjectRoot,captureProject,readProjectFile,literalPreview,repositorySnapshot,PROJECT_LIMITS} from './project-files.mjs';
import {allowedRequest,tokenMatches} from './security.mjs';
import {previewWorktree,revalidateWorktree} from './workbench-worktrees.mjs';
const validate=new Ajv({strict:true}).compile(workbenchSchema);
const publicProject=({identity,...project})=>project;
const publicResource=({identity,...resource})=>resource;
const panes=state=>{
  const result=[];const visit=(node,window)=>{if(node.type==='pane')result.push({pane_id:node.pane.id,kind:node.pane.kind,window_id:window.id,name:window.name});else{visit(node.first,window);visit(node.second,window);}};
  for(const window of state.monitors)visit(window.layout,window);return result;
};
export function createWorkbench({store,token,port,devOrigins,reply,now=Date.now,services={}}){
  const records=new WorkbenchStore(store),approvals=new Map();
  let inspecting=0;
  const buildHash=createHash('sha256');
  for(const directory of ['./','../contracts/'])for(const name of fs.readdirSync(new URL(directory,import.meta.url)).filter(name=>name.endsWith('.mjs')&&name!=='mobile-proxy.mjs').sort()){
    buildHash.update(directory+name+'\0');buildHash.update(fs.readFileSync(new URL(directory+name,import.meta.url)));
  }
  const identity=buildHash.digest('hex');
  async function dispatch(body){
    if(!validate(body))throw wbError('invalid_request');
    const workspace=store.read(body.workspace_id);
    if(body.action==='doctor')return {version:1,schema_version:store.db.pragma('user_version',{simple:true}),server_build:identity,frontend_build:fs.existsSync(new URL('../dist/index.html',import.meta.url))?createHash('sha256').update(fs.readFileSync(new URL('../dist/index.html',import.meta.url))).digest('hex'):null,renderer_support:['default','docking (native moveBefore required for continuity)'],gateway_compatibility:'Capabilities checked per configured recipient; pinned dedicated Hermes runtime is a separate native adapter. Real-model acceptance is deployment-specific.',native_adapter:services.nativeConfigured?'Configured: exact runtime/source and recipient binding verified when previewed':'Blocked: no explicitly configured local pinned Hermes runtime; set ORBIT_NATIVE_HERMES_SOURCE/PYTHON/MODEL_URL/PROFILE',dispatch_health:services.execution?.health?.()??{available:false},active_workbench_jobs:services.execution?.activeCount?.()??0,execution:services.execution?'Serial, owner-approved candidate checks; trusted host execution, not a sandbox':'Execution adapter unavailable',recovery:'SQLite records persist; pending jobs without proven child ownership become outcome_unknown. Finalization retry only records an already observed result. No execution is replayed by layout recovery.',authority:'Owner-authenticated controls; bounded native task consent, exact context disclosure and check contracts. Acceptance, private-branch integration and deployment are separate.'};
    if(body.action==='list')return {projects:records.list(body.workspace_id).map(publicProject),revision:workspace.revision,surfaces:panes(workspace.state)};
    if(body.action==='register_preview'){
      if(approvals.size>=32){for(const [id,value] of approvals)if(value.expires_at<=now())approvals.delete(id);if(approvals.size>=32)throw wbError('busy');}
      const root=openProjectRoot(body.root);root.close();
      const mapping=body.git_mapping?previewWorktree({root:body.root,...body.git_mapping}):null;
      const request={root:body.root,name:body.name,identity:root.identity,...(mapping?{git_mapping:mapping.mapping}:{})};
      const approval_id=randomUUID(),digest=createHash('sha256').update(JSON.stringify({workspace_id:body.workspace_id,...request})).digest('hex');
      const approval={workspace_id:body.workspace_id,request,digest,expires_at:now()+60000};approvals.set(approval_id,approval);
      return {approval_id,digest,expires_at:approval.expires_at,root:body.root,name:body.name,git_mapping:mapping?.mapping??null,authority:'Register this exact directory incarnation for bounded owner-only file/status/diff reads. '+(mapping?mapping.description+' ':'')+'Fixed read-only provider helpers may run with limits. No model sharing, project-script execution, project writes or terminal capture.',limits:PROJECT_LIMITS,exclusions:['.git from file previews','.env and .env.*','*.pem/*.key/*.p12/*.pfx','node_modules','.runtime','.ssh','.aws','.gnupg','dist/build/coverage','.venv','symlinks, hardlinks and special files']};
    }
    if(body.action==='register_commit'){
      const approval=approvals.get(body.approval_id);if(!approval||approval.workspace_id!==body.workspace_id)throw wbError('permission_denied');
      if(approval.expires_at<=now()){approvals.delete(body.approval_id);throw wbError('expired');}
      const root=openProjectRoot(approval.request.root,approval.request.identity);root.close();
      if(approval.request.git_mapping)revalidateWorktree(approval.request.git_mapping);
      const project=records.register(body.workspace_id,approval.request);approvals.delete(body.approval_id);
      return {project:publicProject(project),approval_digest:approval.digest};
    }
    const project=records.project(body.workspace_id,body.project_id);
    if(body.action==='unbind')return {bindings:records.unbind(body.workspace_id,project.id,body.binding_id)};
    if(body.action==='revoke_project'){
      const revoked=records.revoke(body.workspace_id,project.id,body.base_generation);
      services.context?.onRevoke?.(project.id);
      services.execution?.onRevoke?.(project.id);
      services.native?.onRevoke?.(project.id);
      for(const [id,approval] of approvals)if(approval.workspace_id===body.workspace_id&&approval.request.root===project.root)approvals.delete(id);
      return {project:publicProject(revoked)};
    }
    if(body.action==='bind'){const root=openProjectRoot(project.root,project.identity);root.close();return {bindings:records.bind(body)};}
    if(body.action==='link_pane'){
      const root=openProjectRoot(project.root,project.identity);root.close();
      if(workspace.revision!==body.base_revision)throw wbError('stale_resource');
      const pane=panes(workspace.state).find(p=>p.pane_id===body.pane_id);
      const kind={terminal:'terminal',agent:'conversation',browser:'browser'}[pane?.kind];if(!kind)throw wbError('unsupported');
      const resource=records.resource(project.id,`pane:${pane.pane_id}`,{kind,pane_id:pane.pane_id,state:'linked_metadata_only'});
      const role={terminal:'active_terminal',conversation:'primary_agent',browser:'preview'}[kind];
      return {resource:publicResource(resource),bindings:records.bind({...body,resource_id:resource.id,role})};
    }
    if(body.action==='file'){
      const resource=records.getResource(body.workspace_id,project.id,body.resource_id);if(resource.kind!=='file')throw wbError('unsupported');
      const file=readProjectFile(project,resource.path),preview=literalPreview(file.bytes);
      const updated=records.resource(project.id,`file:${resource.path}`,{kind:'file',path:resource.path,identity:file.identity,hash:file.hash,bytes:file.bytes.length,state:preview.binary?'binary':'available'});
      return {resource:publicResource(updated),snapshot:{id:randomUUID(),resource_id:resource.id,hash:file.hash,captured_at:now(),text:preview.text,binary:preview.binary,bytes:file.bytes.length,lines:preview.text?preview.text.split('\n').length:0,truncated:false,stale:file.hash!==resource.hash,generation:updated.generation}};
    }
    if(body.action==='inspect'){
      if(inspecting>=2)throw wbError('busy');
      inspecting++;
      try {
      const capture=captureProject(project);
      const resources=capture.files.map(file=>publicResource(records.resource(project.id,`file:${file.path}`,{kind:'file',path:file.path,identity:file.identity,hash:file.hash,bytes:file.bytes.length,state:literalPreview(file.bytes).binary?'binary':'available'})));
      const currentPanes=panes(store.read(body.workspace_id).state);
      for(const resource of records.resources(project.id).filter(resource=>resource.kind!=='file'))resources.push(publicResource({...resource,state:currentPanes.some(pane=>pane.pane_id===resource.pane_id&&({terminal:'terminal',agent:'conversation',browser:'browser'}[pane.kind])===resource.kind)?'linked_metadata_only':'stale_surface'}));
      const repository=await repositorySnapshot(project,capture,{scratchRoot:path.join(store.root,'workbench-scratch')});
      // Re-check root and project authority after asynchronous Git materialization.
      if(records.project(body.workspace_id,project.id).generation!==project.generation)throw wbError('stale_resource');const current=openProjectRoot(project.root,project.identity);current.close();
      return {project:publicProject(project),resources,bindings:records.bindings(body.workspace_id,project.id),repository,
        snapshot:{id:capture.id,hash:capture.hash,captured_at:capture.captured_at,manifest:capture.manifest,exclusions:capture.exclusions,truncated:capture.limited,total_bytes:capture.total_bytes},
        execution:{tasks:[],jobs:[],artifacts:[],state:services.execution?'available':'unavailable',message:services.execution?'Open managed execution to inspect authoritative task/job/evidence records; inspection starts no job.':'Execution adapter unavailable.'}};
      } finally { inspecting--; }
    }
    throw wbError('unsupported');
  }
  return {records,dispatch,async handle(req,res){
    res.setHeader('Cache-Control','no-store');
    if(req.method!=='POST')return reply(res,405,{ok:false,code:'invalid_request'});
    const auth=req.headers.authorization??'';
    if(!allowedRequest(req,port,devOrigins)||!auth.startsWith('Bearer ')||!tokenMatches(auth.slice(7),token))return reply(res,403,{ok:false,code:'permission_denied'});
    try{
      const chunks=[];let bytes=0;
      for await(const chunk of req){bytes+=Buffer.byteLength(chunk);if(bytes>16384)throw wbError('limit_exceeded');chunks.push(Buffer.from(chunk));}
      let body;try{body=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(chunks)));}catch{throw wbError('invalid_request');}
      const result=await dispatch(body);
      if(Buffer.byteLength(JSON.stringify(result))>2*1024*1024)throw wbError('limit_exceeded');
      return reply(res,200,{ok:true,...result});
    }catch(error){const statuses={invalid_request:400,permission_denied:403,expired:410,stale_resource:409,unsupported:422,unavailable:404,limit_exceeded:413,busy:429};const code=Object.hasOwn(statuses,error.code)?error.code:'unavailable';return reply(res,statuses[code],{ok:false,code,error:code});}
  }};
}
