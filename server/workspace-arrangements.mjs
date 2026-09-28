// Workspace arrangement compiler and durable proposal store.
//
// This module owns the `recipe_*` / `proposal_*` owner requests. It is
// deliberately separate from the execution adapter so the Normal workspace
// controller can route through the same compiler:
//
//   createWorkspaceArrangements({store,records,data,now}).dispatch(body,{actor})
//
// Durability and identity model:
//  - `recipe_preview` compiles and persists an exact, validated proposal
//    (`wb_proposals`) in one WorkbenchData transaction. There is no separate
//    editable draft lifecycle: the preview *is* the validated result.
//  - `recipe_apply` builds a command identity that includes the exact proposal
//    id, preview digest, recipe and project, so two different proposals with the
//    same operations never collide on a receipt.
//  - The committing actor is persisted distinctly (`committed_actor`) and the
//    operation index is actor-scoped: a receipt is never replayed across actors.
//  - `recipe_apply` revalidates project generation, recovery generation, full
//    binding identity (including resource generation), proposal status/version
//    and the saved-recipe version inside `store.commit`'s synchronous
//    `authorize` callback, i.e. under the same SQLite write transaction and
//    before the receipt lookup. Nothing that protects correctness relies on a
//    read taken outside the transaction.
//  - `return` is an exact-revision `set_workspace` inverse of the checkpoint
//    captured by the forward commit; an intervening edit makes it stale.
//
// Saved recipes (`wb_recipes`) snapshot only portable role constraints, layout
// and renderer names. They are reusable across projects of one workspace (the
// source project keeps ownership/edit scope) and are always compiled against the
// *target* project's live bindings.
import {createHash} from 'node:crypto';
import Ajv from 'ajv';
import {validate} from '../src/model.ts';
import {emptyPlacement,placementEqual,placementWindows,prunePlacement,validateDockingPlacement} from '../src/docking-placement.ts';
import {applyOperation} from '../src/workspace-ops.ts';
import {wbError} from './workbench-store.mjs';
import {WorkbenchData,WORKBENCH_RECORD_LIMITS} from './workbench-data.mjs';
import {canonicalJson,commandIdentity} from './command-identity.mjs';
import {arrangementRequests,ARRANGEMENT_LAYOUTS,ARRANGEMENT_LIMITS,ARRANGEMENT_RENDERERS,ARRANGEMENT_ROLES} from '../contracts/workbench-workflow-v1.mjs';

const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const digest=value=>sha(canonicalJson(value));
const TTL=ARRANGEMENT_LIMITS.ttlMs;
const MAX_RECIPE_RECEIPTS=512;
const PROPOSAL_PAGE=32;
// Semantic-diff bounds: readable monitor names, at most 300 characters per
// summary and at most 32 entries. Never paths or resource contents.
const MAX_DIFF_ITEMS=32,MAX_SUMMARY=300,MAX_NAME=60;
const bounded=(value,max=MAX_SUMMARY)=>{const text=String(value);return text.length<=max?text:`${[...text].slice(0,Math.max(1,max-1)).join('')}…`;};
const nameOf=monitor=>monitor&&typeof monitor.name==='string'&&monitor.name.trim()?bounded(monitor.name.trim(),MAX_NAME):'Window';
const frameText=frame=>frame?`${Math.round(frame.width)}×${Math.round(frame.height)} at (${Math.round(frame.x)}, ${Math.round(frame.y)})`:'unplaced';
const valid=new Ajv({strict:true}).compile({oneOf:Object.values(arrangementRequests)});

const BUILTIN_ROLES=Object.freeze({
  investigate:['primary_agent','project_files','active_terminal','preview'],
  implement:['primary_agent','candidate_diff','project_files'],
  review:['candidate_diff','project_files','primary_agent'],
  project_focus:[],
  return:[],
});
const REVIEW_WARNING='Targets only the uniquely bound or explicitly selected orbit://workbench-review window, positioning it beside primary_agent when measured space permits. The Docking float placement is updated without changing other placements. Return restores the exact previous workspace frame/view/selection and Docking placement under revision CAS. Only window order, geometry and Docking placement change; no pane, terminal, browser content or resource is created, reloaded or closed by these operations. Browser document continuity requires native moveBefore; fallback movement may reload a frame.';
const RETURN_WARNING='Restores the exact workspace state and Docking placement captured before the previous arrangement under revision CAS. Any intervening workspace revision prevents return. Only window order, geometry and Docking placement change; no pane, terminal, browser content or resource is created, reloaded or closed by these operations. Browser document continuity requires native moveBefore; fallback movement may reload a frame.';
const BUILTIN_WARNING='Explicit workspace revision CAS. Reorders existing windows only; pane IDs and contents stay the same. Only window order and geometry change; no pane, terminal, browser content or resource is created, reloaded or closed by these operations. Browser continuity depends on native moveBefore support; fallback movement may reload a frame.';
const REVIEW_PANE_URL='orbit://workbench-review';
const MIN_FRAME={width:280,height:180},MAX_FRAME={width:4000,height:4000},GAP=8;

const publicRecipe=record=>({id:record.id,project_id:record.source_project_id??record.project_id,version:record.revision,name:record.name,roles:record.roles,layout:record.layout,renderer:record.renderer,created_at:record.created_at,updated_at:record.updated_at});

function paneMonitor(state,paneId){
  for(const monitor of state.monitors){
    let found=false;
    const visit=node=>{if(node.type==='pane'){if(node.pane.id===paneId)found=true;}else{visit(node.first);visit(node.second);}};
    visit(monitor.layout);
    if(found)return monitor;
  }
  return null;
}
function paneNode(state,paneId){
  for(const monitor of state.monitors){
    let found=null;
    const visit=node=>{if(node.type==='pane'){if(node.pane.id===paneId)found={monitor,pane:node.pane};}else{visit(node.first);visit(node.second);}};
    visit(monitor.layout);
    if(found)return found;
  }
  return null;
}
function samePlacement(a,b){return placementEqual(a??emptyPlacement(),b??emptyPlacement());}
function sameViewport(a,b){return canonicalJson(a??null)===canonicalJson(b??null);}
const effectiveIntent=(proposal,body)=>body.intent??`Recipe ${proposal.recipe}`;
const sameRequest=(proposal,body)=>proposal.workspace_id===body.workspace_id&&proposal.project_id===body.project_id&&proposal.recipe===body.recipe&&proposal.id===body.preview_id&&proposal.preview_digest===body.preview_digest&&proposal.op_id===body.op_id&&sameViewport(body.viewport??proposal.viewport,proposal.viewport)&&effectiveIntent(proposal,body)===proposal.committed_intent;
function semanticDiff(before,after,beforePlacement,afterPlacement){
  const diff=[];
  if(before.monitors.map(m=>m.id).join(',')!==after.monitors.map(m=>m.id).join(',')){
    const names=after.monitors.slice(0,MAX_DIFF_ITEMS).map(monitor=>nameOf(monitor));
    const extra=after.monitors.length>MAX_DIFF_ITEMS?` … (+${after.monitors.length-MAX_DIFF_ITEMS})`:'';
    diff.push({kind:'order',summary:bounded(`Order: ${names.join(' → ')}${extra}`)});
  }
  if(before.selected!==after.selected){
    const from=before.monitors.find(monitor=>monitor.id===before.selected),to=after.monitors.find(monitor=>monitor.id===after.selected);
    diff.push({kind:'select',summary:bounded(`Active window: ${nameOf(from)} → ${nameOf(to)}`),window_id:after.selected});
  }
  if(before.view!==after.view)diff.push({kind:'view',summary:bounded(`View: ${before.view??'windows'} → ${after.view??'windows'}`)});
  if(!samePlacement(beforePlacement,afterPlacement)){
    const beforeFloats=(beforePlacement??emptyPlacement()).floats.length,afterFloats=(afterPlacement??emptyPlacement()).floats.length;
    const activeId=(afterPlacement??emptyPlacement()).active;
    const activeName=activeId?(nameOf(after.monitors.find(monitor=>monitor.id===activeId))||'Window'):'none';
    diff.push({kind:'placement',summary:bounded(`Docking placement: floats ${beforeFloats} → ${afterFloats}, active ${activeName}`)});
  }
  for(const monitor of after.monitors){
    const prior=before.monitors.find(item=>item.id===monitor.id);
    if(prior&&canonicalJson(prior.frame??null)!==canonicalJson(monitor.frame??null))diff.push({kind:'geometry',summary:bounded(`${nameOf(monitor)}: ${frameText(prior.frame)} → ${frameText(monitor.frame)}`),window_id:monitor.id});
  }
  if(diff.length>MAX_DIFF_ITEMS){const extra=diff.length-(MAX_DIFF_ITEMS-1);return [...diff.slice(0,MAX_DIFF_ITEMS-1),{kind:'truncated',summary:bounded(`… (+${extra} more changes)`) }];}
  return diff;
}
function restoreDiff(revision,list){return [{kind:'restore',summary:bounded(`Restore to revision ${revision}`),revision,window_id:null},...list];}
// Distinct columns vs rows shapes. `columns` prefers one row of columns and
// narrows (falling back toward stacked rows) until the minimum frame width fits;
// `rows` prefers one column of rows and shortens until the minimum height fits.
// Returns null when no honest cell of the requested shape can meet the minimum.
function gridShape(layout,monitorIds,{width,height}){
  if(!Number.isFinite(width)||!Number.isFinite(height)||!monitorIds.length)return null;
  const count=monitorIds.length;let columns,rows;
  if(layout==='columns'){columns=count;while(columns>1&&(width/columns-GAP)<MIN_FRAME.width)columns--;rows=Math.ceil(count/columns);}
  else{rows=count;while(rows>1&&(height/rows-GAP)<MIN_FRAME.height)rows--;columns=Math.ceil(count/rows);}
  const cellW=width/columns,cellH=height/rows;
  if(cellW-GAP<MIN_FRAME.width||cellH-GAP<MIN_FRAME.height)return null;
  return {columns,rows,cellW,cellH};
}
function arrangeGeometry(monitorIds,{layout,width,height}){
  const shape=gridShape(layout,monitorIds,{width,height});
  if(!shape)return null;
  const {columns,cellW,cellH}=shape;
  const frameWidth=Math.min(MAX_FRAME.width,Math.floor(cellW-GAP)),frameHeight=Math.min(MAX_FRAME.height,Math.floor(cellH-GAP));
  return monitorIds.map((window_id,index)=>({action:'update_window',window_id,frame:{x:Math.max(0,Math.floor((index%columns)*cellW+GAP/2)),y:Math.max(0,Math.floor(Math.floor(index/columns)*cellH+GAP/2)),width:frameWidth,height:frameHeight,z:index}}));
}

export function createWorkspaceArrangements({store,records,data,now=Date.now}={}){
  if(typeof store?.read!=='function'||typeof store?.commit!=='function'||typeof records?.bindings!=='function')throw Error('Workspace arrangement dependencies required');
  data=data??new WorkbenchData(store);

  const scope=body=>{const workspace=store.read(body.workspace_id);const project=records.project(body.workspace_id,body.project_id);return {workspace,project};};
  const asWbError=error=>{
    if(error?.code)return error;
    if(error?.category==='REVISION_CONFLICT'||error?.category==='RECOVERY_POLICY_CHANGED')return Object.assign(wbError('stale_resource'),{reason:error.category,category:'REVISION_CONFLICT'});
    if(error?.category==='IDEMPOTENCY_CONFLICT')return Object.assign(wbError('conflict'),{reason:error.category,category:'REVISION_CONFLICT'});
    if(error?.category==='RESOURCE_BUSY')return Object.assign(wbError('busy'),{reason:error.category,category:'RESOURCE_BUSY'});
    return error;
  };
  const markStale=proposal=>{try{const current=data.get('proposals',proposal.workspace_id,proposal.project_id,proposal.id);if(current.status==='previewed')data.update('proposals',proposal.workspace_id,proposal.project_id,current.id,current.revision,{status:'stale'});}catch{}};

  // Full binding identity: pane/resource binding plus the resource generation, so
  // a same-id resource whose contents were re-captured is a different identity.
  function bindingIdentity(workspaceId,projectId){
    return records.bindings(workspaceId,projectId).map(binding=>{
      const resource=records.getResource(workspaceId,projectId,binding.resource_id);
      return {id:binding.id,resource_id:binding.resource_id,pane_id:binding.pane_id,role:binding.role,resource_generation:resource.generation??null};
    });
  }
  function workspaceRecipes(workspaceId){
    const out=[];
    for(const project of records.list(workspaceId)){
      if(project.active===false)continue;
      for(const recipe of data.list('recipes',workspaceId,project.id))out.push({...recipe,source_project_id:project.id});
    }
    return out;
  }
  const findRecipe=(workspaceId,recipeId)=>workspaceRecipes(workspaceId).find(recipe=>recipe.id===recipeId)??null;

  function resolveRoles(roles,bindings,roleChoices,workspace){
    if(roleChoices)for(const key of Object.keys(roleChoices))if(!roles.includes(key))throw Object.assign(wbError('invalid_request'),{reason:'unused_role_choice',role:key});
    const byRole=new Map();
    for(const binding of bindings){if(!byRole.has(binding.role))byRole.set(binding.role,[]);byRole.get(binding.role).push(binding);}
    const resolved={},unbound=[],used=new Map();
    for(const role of roles){
      const candidates=byRole.get(role)??[],chosen=roleChoices?.[role];
      let selected=null;
      if(chosen){
        selected=candidates.find(candidate=>candidate.id===chosen)??null;
        if(!selected)throw Object.assign(wbError('conflict'),{reason:'unknown_binding_choice',candidates:candidates.map(candidate=>candidate.id)});
      }else if(candidates.length===1)selected=candidates[0];
      else if(candidates.length===0){resolved[role]=null;unbound.push(role);continue;}
      else throw Object.assign(wbError('conflict'),{reason:'ambiguous_role',candidates:candidates.map(candidate=>({id:candidate.id,pane_id:candidate.pane_id,resource_id:candidate.resource_id}))});
      if(used.has(selected.id))throw Object.assign(wbError('conflict'),{reason:'duplicate_binding_choice',binding_id:selected.id});
      used.set(selected.id,role);
      // A live binding whose pane no longer exists is unbound, never silently
      // treated as a usable target.
      if(!paneMonitor(workspace.state,selected.pane_id)){resolved[role]=null;unbound.push(role);continue;}
      resolved[role]=selected.id;
    }
    return {resolved,unbound};
  }

  function finalize(staged,workspace){
    const state=validate(structuredClone(staged.state));
    const placement=validateDockingPlacement(staged.placement??emptyPlacement(),{windowIds:state.monitors.map(monitor=>monitor.id)});
    const changed=canonicalJson(state)!==canonicalJson(workspace.state)||!samePlacement(placement,workspace.placement);
    const list=staged.semantic_diff??semanticDiff(workspace.state,state,workspace.placement,placement);
    const semantic_diff=staged.restore_revision!==undefined?restoreDiff(staged.restore_revision,list):list;
    return {...staged,state,placement,changed,semantic_diff};
  }

  function compileBuiltin(body,{workspace,bindings}){
    const isReview=body.recipe==='review';
    if(body.recipe_id)throw Object.assign(wbError('invalid_request'),{reason:'saved_recipe_fields_for_builtin'});
    if(isReview&&(!Number.isFinite(body.width)||body.width<280||body.width>16000||!Number.isFinite(body.height)||body.height<180||body.height>16000))throw wbError('invalid_request');
    // Record the actually supplied viewport whenever both bounds are measured.
    const viewport=Number.isFinite(body.width)&&Number.isFinite(body.height)?{width:body.width,height:body.height}:null;
    // Built-ins accept the same optional renderer as saved recipes. A `review`
    // preview switches to the Windows view by its operations, so a supplied
    // spatial target is recorded as the effective windows target; docking is
    // recorded because its operations update the Docking placement.
    const renderer=isReview?((body.renderer??'windows')==='spatial'?'windows':(body.renderer??'windows')):(body.renderer??'windows');
    const roles=BUILTIN_ROLES[body.recipe]??[];
    const ids=workspace.state.monitors.map(monitor=>monitor.id);
    const monitorIds=new Set();for(const binding of bindings){const monitor=paneMonitor(workspace.state,binding.pane_id);if(monitor)monitorIds.add(monitor.id);}
    if(!monitorIds.size)throw wbError('unsupported');
    let operations,placement=workspace.placement??emptyPlacement(),roleChoices={},unbound=[];
    if(isReview){
      const choices=body.role_choices??{};
      for(const key of Object.keys(choices))if(!roles.includes(key))throw Object.assign(wbError('invalid_request'),{reason:'unused_role_choice',role:key});
      const withPane=role=>bindings.filter(binding=>binding.role===role).map(binding=>({binding,node:paneNode(workspace.state,binding.pane_id)})).filter(entry=>entry.node);
      const trusted=withPane('candidate_diff').filter(entry=>entry.node.pane.kind==='browser'&&entry.node.pane.url===REVIEW_PANE_URL);
      let reviewEntry=null;
      if(choices.candidate_diff){
        reviewEntry=trusted.find(entry=>entry.binding.id===choices.candidate_diff)??null;
        if(!reviewEntry)throw Object.assign(wbError('unsupported'),{reason:'review_not_trusted'});
      }else if(trusted.length===1)reviewEntry=trusted[0];
      else if(trusted.length===0)throw wbError('unsupported');
      else throw Object.assign(wbError('conflict'),{reason:'ambiguous_role',role:'candidate_diff'});
      const agents=withPane('primary_agent');
      let anchorEntry=null;
      if(choices.primary_agent){
        anchorEntry=agents.find(entry=>entry.binding.id===choices.primary_agent)??null;
        if(!anchorEntry)throw Object.assign(wbError('conflict'),{reason:'unknown_binding_choice',role:'primary_agent'});
      }else if(agents.length===1)anchorEntry=agents[0];
      else if(agents.length===0)throw wbError('unsupported');
      else throw Object.assign(wbError('conflict'),{reason:'ambiguous_role',role:'primary_agent'});
      const projectFiles=withPane('project_files');
      if(choices.project_files){
        const chosen=projectFiles.find(entry=>entry.binding.id===choices.project_files)??null;
        if(!chosen)throw Object.assign(wbError('conflict'),{reason:'unknown_binding_choice',role:'project_files'});
        roleChoices.project_files=chosen.binding.id;
      }else if(projectFiles.length===1)roleChoices.project_files=projectFiles[0].binding.id;
      else{roleChoices.project_files=null;unbound.push('project_files');}
      roleChoices.candidate_diff=reviewEntry.binding.id;roleChoices.primary_agent=anchorEntry.binding.id;
      const target=reviewEntry.node.monitor,origin=anchorEntry.node.monitor;
      if(target.id===origin.id)throw wbError('unsupported');
      const anchorFrame=origin.frame??{x:24,y:18,width:Math.min(740,body.width-60),height:Math.min(510,body.height-90),z:0};
      const width=Math.min(body.width,Math.max(280,Math.min(740,body.width*.42))),height=Math.min(body.height,Math.max(180,Math.min(620,body.height*.78)));
      let x=anchorFrame.x+anchorFrame.width+16;if(x+width>body.width)x=Math.max(0,anchorFrame.x-width-16);x=Math.max(0,Math.min(x,body.width-width));
      const y=Math.max(0,Math.min(anchorFrame.y,body.height-height));
      const z=Math.max(0,...workspace.state.monitors.map(item=>item.frame?.z??0))+1;
      operations=[{action:'update_window',window_id:target.id,frame:{x,y,width,height,z}},{action:'select',window_id:target.id},{action:'set_view',view:'windows'}];
      const oldWindows=placementWindows(placement);
      placement=prunePlacement(placement,oldWindows.filter(id=>id!==target.id));
      placement.floats.push({windows:[target.id],frame:{x,y,width,height},active:target.id});placement.active=target.id;
      placement=validateDockingPlacement(placement,{windowIds:ids});
    }else{
      let resolved;
      ({resolved,unbound}=resolveRoles(roles,bindings,body.role_choices,workspace));
      roleChoices=resolved;
      // Only explicitly chosen candidates are prioritized; other bound windows
      // stay after them and unbound windows last.
      const chosenIds=[];
      for(const role of roles){const bindingId=resolved[role];if(!bindingId)continue;const binding=bindings.find(item=>item.id===bindingId),monitor=binding?paneMonitor(workspace.state,binding.pane_id):null;if(monitor&&!chosenIds.includes(monitor.id))chosenIds.push(monitor.id);}
      const next=[...chosenIds,...ids.filter(id=>!chosenIds.includes(id)&&monitorIds.has(id)),...ids.filter(id=>!monitorIds.has(id))];
      operations=[{action:'reorder_windows',window_ids:next}];
    }
    return {recipe:body.recipe,recipe_id:null,recipe_version:null,recipe_source_project_id:null,layout:'prioritize',renderer,roles,role_choices:roleChoices,unbound,operations,state:operations.reduce((state,operation)=>validate(applyOperation(state,operation)),workspace.state),placement,geometry:'none',viewport,warning:isReview?REVIEW_WARNING:BUILTIN_WARNING};
  }

  function compileSaved(body,{workspace,bindings},recipe){
    if(body.recipe==='return')throw wbError('invalid_request');
    const roles=recipe.roles??[],layout=recipe.layout,renderer=body.renderer??recipe.renderer;
    if(renderer==='spatial'&&(layout==='columns'||layout==='rows'))throw Object.assign(wbError('unsupported'),{reason:'spatial_renderer_prioritize_only'});
    const {resolved,unbound}=resolveRoles(roles,bindings,body.role_choices,workspace);
    const ids=workspace.state.monitors.map(monitor=>monitor.id);
    const ordered=[];
    for(const role of roles){const bindingId=resolved[role];if(!bindingId)continue;const binding=bindings.find(item=>item.id===bindingId),monitor=binding?paneMonitor(workspace.state,binding.pane_id):null;if(monitor&&!ordered.includes(monitor.id))ordered.push(monitor.id);}
    const operations=[];
    const NO_RESOURCES=' Only window order, geometry and Docking placement change; no pane, terminal, browser content or resource is created, reloaded or closed.';
    let geometry='none',placement=workspace.placement??emptyPlacement(),viewport=null,warning='Reorders existing windows only; pane IDs and contents stay the same.'+NO_RESOURCES;
    if(layout==='columns'||layout==='rows'){
      const frames=arrangeGeometry(ordered,{layout,width:body.width,height:body.height});
      if(frames){
        operations.push(...frames);geometry='applied';viewport={width:body.width,height:body.height};
        if(renderer==='docking'){
          // Update only the chosen windows in the Docking placement; unrelated
          // floats/groups are preserved exactly.
          const chosen=new Set(frames.map(operation=>operation.window_id));
          placement=prunePlacement(placement,placementWindows(placement).filter(id=>!chosen.has(id)));
          for(const operation of frames)placement.floats.push({windows:[operation.window_id],frame:{x:operation.frame.x,y:operation.frame.y,width:operation.frame.width,height:operation.frame.height},active:operation.window_id});
          if(frames.length)placement.active=frames[0].window_id;
          placement=validateDockingPlacement(placement,{windowIds:ids});
          warning='Places the chosen bound windows as measured Docking floats ('+layout+'), preserving unrelated placement. Geometry uses the caller-measured viewport; measured relative geometry is not yet persisted with a saved recipe.'+NO_RESOURCES;
        }else{
          warning='Places the chosen bound windows in a measured '+layout+' grid, then prioritizes them. Geometry uses the caller-measured viewport; measured relative geometry is not yet persisted with a saved recipe.'+NO_RESOURCES;
        }
      }else{geometry='deferred';warning='Prioritizes the chosen bound windows only. Measured '+layout+' geometry was deferred because the measured viewport cannot hold the bound windows at the minimum frame size; provide a larger measured viewport or use prioritize.'+NO_RESOURCES;}
    }
    const next=[...ordered,...ids.filter(id=>!ordered.includes(id))];
    operations.push({action:'reorder_windows',window_ids:next});
    return {recipe:body.recipe,recipe_id:recipe.id,recipe_version:recipe.revision,recipe_source_project_id:recipe.source_project_id??recipe.project_id,layout,renderer,roles,role_choices:resolved,unbound,operations,geometry,state:operations.reduce((state,operation)=>validate(applyOperation(state,operation)),workspace.state),placement,viewport,warning};
  }

  function compileReturn(body,{workspace}){
    if(body.recipe_id||body.role_choices||body.width!==undefined||body.height!==undefined)throw wbError('invalid_request');
    const sources=data.list('proposals',body.workspace_id,body.project_id).filter(proposal=>proposal.recipe!=='return'&&proposal.status==='committed'&&proposal.return_checkpoint_id&&!proposal.returned_at).sort((a,b)=>(b.committed_revision??0)-(a.committed_revision??0)||String(b.id).localeCompare(String(a.id)));
    const source=sources[0];
    if(!source)throw wbError('stale_resource');
    if(workspace.revision!==source.committed_revision)throw wbError('stale_resource');
    let checkpoint;try{checkpoint=store.checkpointGet(body.workspace_id,source.return_checkpoint_id);}catch{throw wbError('stale_resource');}
    const state=validate(structuredClone(checkpoint.state));
    // `restore_revision` lets finalize prepend the exact prior revision to the
    // real semantic diff computed against the current workspace.
    return {recipe:'return',recipe_id:null,recipe_version:null,recipe_source_project_id:null,layout:'prioritize',renderer:body.renderer??'windows',roles:[],role_choices:{},unbound:[],operations:[{action:'set_workspace',state}],state,placement:checkpoint.placement??emptyPlacement(),geometry:'none',viewport:null,return_of:source.id,restore_revision:checkpoint.revision,warning:RETURN_WARNING};
  }

  function pruneExpiredPreviews(workspaceId,projectId){
    try{data.db.prepare("DELETE FROM wb_proposals WHERE workspace_id=? AND project_id=? AND json_extract(record_json,'$.status')='previewed' AND json_extract(record_json,'$.op_id') IS NULL AND json_extract(record_json,'$.expires_at')<=?").run(workspaceId,projectId,now());}catch{}
  }

  function recipePreview(body,actor){
    // Compile and persist under one immediate transaction so the staged snapshot
    // is coherent against another SQLite connection.
    return data.db.transaction(()=>{
      const {workspace,project}=scope(body);
      const bindings=bindingIdentity(body.workspace_id,body.project_id);
      let staged;
      if(body.recipe==='return')staged=compileReturn(body,{workspace});
      else if(body.recipe_id){const found=findRecipe(body.workspace_id,body.recipe_id);if(!found)throw wbError('stale_resource');staged=compileSaved(body,{workspace,bindings},found);}
      else staged=compileBuiltin(body,{workspace,bindings});
      staged=finalize(staged,workspace);
      pruneExpiredPreviews(body.workspace_id,body.project_id);
      const identity={version:1,workspace_id:body.workspace_id,project_id:body.project_id,recipe:body.recipe,recipe_id:staged.recipe_id??null,recipe_version:staged.recipe_version??null,project_generation:project.generation,recovery_generation:workspace.recovery_policy?.generation??0,base_revision:workspace.revision,bindings,layout:staged.layout,renderer:staged.renderer,role_choices:staged.role_choices,unbound:staged.unbound,operations:staged.operations,state:staged.state,placement:staged.placement,viewport:staged.viewport??null,geometry:staged.geometry??'none'};
      const preview_digest=digest(identity);
      const created=data.create('proposals',{workspace_id:body.workspace_id,project_id:body.project_id,recipe:body.recipe,recipe_id:staged.recipe_id??null,recipe_version:staged.recipe_version??null,recipe_source_project_id:staged.recipe_source_project_id??null,layout:staged.layout,renderer:staged.renderer,base_revision:workspace.revision,project_generation:project.generation,recovery_generation:workspace.recovery_policy?.generation??0,actor,bindings,roles:staged.roles,role_choices:staged.role_choices,unbound:staged.unbound,operations:staged.operations,staged_state:staged.state,staged_placement:staged.placement,semantic_diff:staged.semantic_diff,geometry:staged.geometry??'none',viewport:staged.viewport??null,preview_digest,status:'previewed',op_id:null,committed_actor:null,committed_intent:null,committed_revision:null,committed_viewport:null,return_checkpoint_id:null,return_of:staged.return_of??null,returned_at:null,expires_at:now()+TTL,rendered:false,tested:false,changed:staged.changed,warning:staged.warning});
      return {preview_id:created.id,preview_digest,expires_at:created.expires_at,base_revision:workspace.revision,operations:staged.operations,changed:staged.changed,semantic_diff:staged.semantic_diff,unbound:staged.unbound,role_choices:staged.role_choices,roles:staged.roles,layout:staged.layout,renderer:staged.renderer,recipe_id:staged.recipe_id??null,recipe_project_id:staged.recipe_source_project_id??null,geometry:staged.geometry??'none',viewport:staged.viewport??null,rendered:false,tested:false,warning:staged.warning};
    }).immediate();
  }

  function authorizeApply(proposal){
    return previous=>{
      if(previous&&(previous.recovery_policy?.generation??0)!==proposal.recovery_generation)throw Object.assign(wbError('stale_resource'),{reason:'recovery_generation'});
      let live;try{live=data.get('proposals',proposal.workspace_id,proposal.project_id,proposal.id);}catch{throw Object.assign(wbError('stale_resource'),{reason:'proposal_missing'});}
      if(live.status!=='previewed'||live.revision!==proposal.revision)throw Object.assign(wbError('stale_resource'),{reason:'proposal_changed'});
      // Expiry is rechecked under the acquired write lock, not only before it.
      if(now()>live.expires_at)throw Object.assign(wbError('expired'),{reason:'expired_after_lock'});
      const project=records.project(proposal.workspace_id,proposal.project_id);
      if(project.generation!==proposal.project_generation)throw Object.assign(wbError('stale_resource'),{reason:'project_generation'});
      if(digest(bindingIdentity(proposal.workspace_id,proposal.project_id))!==digest(proposal.bindings))throw Object.assign(wbError('stale_resource'),{reason:'bindings_changed'});
      if(proposal.recipe_id){
        const found=findRecipe(proposal.workspace_id,proposal.recipe_id);
        if(!found||found.source_project_id!==proposal.recipe_source_project_id||found.revision!==proposal.recipe_version)throw Object.assign(wbError('stale_resource'),{reason:'recipe_changed'});
      }
      return true;
    };
  }
  function authorizeReplay(proposal){
    return previous=>{
      if(previous&&(previous.recovery_policy?.generation??0)!==proposal.recovery_generation)throw Object.assign(wbError('stale_resource'),{reason:'recovery_generation'});
      const project=records.project(proposal.workspace_id,proposal.project_id);
      if(project.generation!==proposal.project_generation)throw Object.assign(wbError('stale_resource'),{reason:'project_generation'});
      return true;
    };
  }
  // Identity binds the exact proposal, digest, recipe, project, viewport and the
  // caller-supplied intent so distinct proposals can never share a receipt even
  // with identical operations.
  const applyCommand=(proposal,operationId,intent)=>({workspace_id:proposal.workspace_id,project_id:proposal.project_id,recipe:proposal.recipe,action:'apply',proposal_id:proposal.id,preview_digest:proposal.preview_digest,operations:proposal.operations,base_revision:proposal.base_revision,operation_id:operationId,intent,viewport:proposal.viewport??null});

  function commitProposal(proposal,actor,operationId,intent){
    let committed;
    try{
      committed=store.commit(commandIdentity(applyCommand(proposal,operationId,intent),actor),{
        authorize:authorizeApply(proposal),
        apply:()=>structuredClone(proposal.staged_state),
        placement:structuredClone(proposal.staged_placement),
        checkpointLabel:`Before ${proposal.recipe} recipe`,
        // Runs inside the store's BEGIN IMMEDIATE transaction. If the proposal
        // CAS or the source-return write fails, the state change, checkpoint and
        // receipt roll back together — never a committed edit with missing or
        // duplicated metadata.
        response:(record,checkpoint)=>{
          data.update('proposals',proposal.workspace_id,proposal.project_id,proposal.id,proposal.revision,{status:'committed',op_id:operationId,committed_actor:actor,committed_intent:intent,committed_revision:record.revision,committed_viewport:proposal.viewport??null,return_checkpoint_id:checkpoint?.id??null,committed_at:now(),rendered:false,tested:false});
          if(proposal.return_of){const source=data.get('proposals',proposal.workspace_id,proposal.project_id,proposal.return_of);if(!source.returned_at)data.update('proposals',proposal.workspace_id,proposal.project_id,source.id,source.revision,{returned_at:now()});}
          return {workspace:{workspace_id:record.id,revision:record.revision,state:record.state,placement:record.placement},recipe:proposal.recipe,idempotent:false,status:'committed',preview_id:proposal.id,preview_digest:proposal.preview_digest,viewport:proposal.viewport??null,intent,rendered:false,tested:false};
        },
      });
    }catch(error){
      const mapped=asWbError(error);
      // The refused workspace transaction has rolled back. Persist the proposal
      // disposition separately; doing it inside authorize would roll it back too.
      if(mapped.code==='stale_resource'||mapped.code==='expired')markStale(proposal);
      throw mapped;
    }
    return committed.result;
  }

  function recipeApply(body,actor){
    scope(body);
    const byOp=data.list('proposals',body.workspace_id,body.project_id).find(proposal=>proposal.op_id===body.op_id&&proposal.committed_actor===actor);
    if(byOp){
      if(!sameRequest(byOp,body))throw wbError('conflict');
      const intent=byOp.committed_intent??`Recipe ${byOp.recipe}`;
      let replayed;
      try{replayed=store.commit(commandIdentity(applyCommand(byOp,byOp.op_id,intent),actor),{authorize:authorizeReplay(byOp),apply:()=>{throw wbError('stale_resource');}});}catch(error){throw asWbError(error);}
      if(!replayed.replayed)throw wbError('stale_resource');
      const result=replayed.result??{};
      return {workspace:result.workspace??result,recipe:byOp.recipe,idempotent:true,status:'committed',preview_id:byOp.id,preview_digest:byOp.preview_digest,viewport:result.viewport??byOp.committed_viewport??byOp.viewport??null,intent,rendered:false,tested:false};
    }
    let proposal;
    try{proposal=data.get('proposals',body.workspace_id,body.project_id,body.preview_id);}catch{throw wbError('expired');}
    if(proposal.status!=='previewed')throw wbError('stale_resource');
    if(proposal.workspace_id!==body.workspace_id||proposal.project_id!==body.project_id||proposal.recipe!==body.recipe||proposal.preview_digest!==body.preview_digest)throw wbError('stale_resource');
    if(now()>proposal.expires_at){markStale(proposal);throw wbError('expired');}
    if(body.viewport&&!sameViewport(body.viewport,proposal.viewport))throw Object.assign(wbError('stale_resource'),{reason:'viewport_changed'});
    return commitProposal(proposal,actor,body.op_id,body.intent??`Recipe ${proposal.recipe}`);
  }

  function recipeList(body){
    const {workspace,project}=scope(body),bindings=bindingIdentity(body.workspace_id,body.project_id);
    const recipes=workspaceRecipes(body.workspace_id).sort((a,b)=>(a.created_at??0)-(b.created_at??0)||String(a.id).localeCompare(String(b.id)));
    return {workspace_id:body.workspace_id,project_id:body.project_id,revision:workspace.revision,project_generation:project.generation,recipes:recipes.map(publicRecipe),bindings,capabilities:{roles:[...ARRANGEMENT_ROLES],layouts:[...ARRANGEMENT_LAYOUTS],renderers:[...ARRANGEMENT_RENDERERS],max_recipes:ARRANGEMENT_LIMITS.maxRecipes,max_proposals:WORKBENCH_RECORD_LIMITS.proposals,max_recipe_receipts:MAX_RECIPE_RECEIPTS,ttl_ms:TTL,measured_geometry:false,portable_constraints_only:true,cross_project_recipes:true,retention:'Committed proposals and their receipts are retained for the project lifetime; expired uncommitted previews may be pruned. No committed receipt is deleted.'}};
  }

  // Append-only recipe operation receipts. Read first under the same immediate
  // transaction as the create/update, so an exact retry after later edits returns
  // the original version/result and a changed payload on the same key conflicts.
  function recipeSave(body,actor){
    return data.db.transaction(()=>{
      const {project}=scope(body);
      const intent=body.intent??`Recipe save ${body.name}`;
      const normalized={action:'recipe_save',workspace_id:body.workspace_id,project_id:body.project_id,name:body.name,roles:body.roles,layout:body.layout,renderer:body.renderer,recipe_id:body.recipe_id??null,expected_version:body.expected_version??null,intent};
      const request_hash=digest(normalized);
      if(body.op_id){
        const prior=data.db.prepare('SELECT request_hash,result_json FROM wb_recipe_receipts WHERE workspace_id=? AND actor=? AND op_id=?').get(body.workspace_id,actor,body.op_id);
        if(prior){
          if(prior.request_hash!==request_hash)throw Object.assign(wbError('conflict'),{reason:'operation_key_reuse'});
          return {...JSON.parse(prior.result_json),idempotent:true,legacy:false};
        }
      }
      if(body.name.trim()!==body.name||!body.name.trim())throw wbError('invalid_request');
      const all=workspaceRecipes(body.workspace_id);
      // Revocation hides a source project's recipes from use, not from retained
      // storage budgets or workspace-wide name uniqueness.
      const retained=data.db.prepare("SELECT id,json_extract(record_json,'$.name') AS name FROM wb_recipes WHERE workspace_id=?").all(body.workspace_id);
      let stored;
      if(body.recipe_id){
        const current=all.find(item=>item.id===body.recipe_id);
        if(!current)throw wbError('stale_resource');
        // Source-project ownership: edits must target the owning project.
        if(current.source_project_id!==body.project_id)throw Object.assign(wbError('stale_resource'),{reason:'recipe_source_project'});
        if(!Number.isSafeInteger(body.expected_version)||body.expected_version!==current.revision)throw wbError('stale_resource');
        if(retained.some(item=>item.id!==current.id&&item.name===body.name))throw wbError('conflict');
        const updated=data.update('recipes',body.workspace_id,current.source_project_id,current.id,current.revision,{name:body.name,roles:body.roles,layout:body.layout,renderer:body.renderer});
        stored={recipe:publicRecipe({...updated,source_project_id:current.source_project_id}),project_generation:project.generation};
      }else{
        if(retained.length>=ARRANGEMENT_LIMITS.maxRecipes)throw wbError('limit_exceeded');
        if(retained.some(item=>item.name===body.name))throw wbError('conflict');
        const created=data.create('recipes',{workspace_id:body.workspace_id,project_id:project.id,name:body.name,roles:body.roles,layout:body.layout,renderer:body.renderer});
        stored={recipe:publicRecipe({...created,source_project_id:project.id}),project_generation:project.generation};
      }
      if(body.op_id){
        const count=data.db.prepare('SELECT count(*) AS n FROM wb_recipe_receipts WHERE workspace_id=?').get(body.workspace_id).n;
        if(count>=MAX_RECIPE_RECEIPTS)throw Object.assign(wbError('limit_exceeded'),{reason:'recipe_receipts_full'});
        data.db.prepare('INSERT INTO wb_recipe_receipts(workspace_id,actor,op_id,request_hash,intent,result_json,created) VALUES (?,?,?,?,?,?,?)').run(body.workspace_id,actor,body.op_id,request_hash,intent,JSON.stringify(stored),now());
      }
      return {...stored,idempotent:false,legacy:!body.op_id};
    }).immediate();
  }

  function proposalSummary(record){
    return {id:record.id,recipe:record.recipe,recipe_id:record.recipe_id??null,recipe_version:record.recipe_version??null,recipe_project_id:record.recipe_source_project_id??null,status:record.status,layout:record.layout,renderer:record.renderer,base_revision:record.base_revision,committed_revision:record.committed_revision??null,project_generation:record.project_generation,recovery_generation:record.recovery_generation??null,role_choices:record.role_choices??{},unbound:record.unbound??[],semantic_diff:record.semantic_diff??[],changed:record.changed===true,geometry:record.geometry??'none',viewport:record.viewport??null,version:record.revision,preview_digest:record.preview_digest,op_id:record.op_id??null,actor:record.actor??null,committed_actor:record.committed_actor??null,committed_intent:record.committed_intent??null,return_checkpoint_id:record.return_checkpoint_id??null,return_of:record.return_of??null,returned_at:record.returned_at??null,expires_at:record.expires_at,rendered:false,tested:false,created_at:record.created_at,updated_at:record.updated_at};
  }
  // Stable newest-first pagination by created_at/id, 32 per page.
  function proposalList(body){
    const {workspace}=scope(body);
    const all=data.list('proposals',body.workspace_id,body.project_id).filter(record=>!body.recipe||record.recipe===body.recipe).sort((a,b)=>(b.created_at??0)-(a.created_at??0)||String(b.id).localeCompare(String(a.id)));
    let start=0;
    if(body.after_id){const index=all.findIndex(record=>record.id===body.after_id);if(index<0)throw wbError('stale_resource');start=index+1;}
    const page=all.slice(start,start+PROPOSAL_PAGE),truncated=start+page.length<all.length;
    return {workspace_id:body.workspace_id,project_id:body.project_id,revision:workspace.revision,proposals:page.map(proposalSummary),truncated,next_after_id:truncated&&page.length?page[page.length-1].id:null,total_count:all.length};
  }
  function proposalGet(body){
    scope(body);
    const record=data.get('proposals',body.workspace_id,body.project_id,body.proposal_id);
    return {proposal:{...proposalSummary(record),operations:record.operations??[],bindings:record.bindings??[],staged_state:record.staged_state,staged_placement:record.staged_placement,warning:record.warning??null}};
  }
  function proposalReject(body){
    scope(body);
    const current=data.get('proposals',body.workspace_id,body.project_id,body.proposal_id);
    if(!Number.isSafeInteger(body.expected_version)||body.expected_version!==current.revision)throw wbError('stale_resource');
    if(current.status!=='previewed')throw wbError('stale_resource');
    const updated=data.update('proposals',body.workspace_id,body.project_id,current.id,current.revision,{status:'rejected',rejected_at:now()});
    return {proposal:proposalSummary(updated)};
  }

  async function dispatch(body,{actor='owner'}={}){
    if(!valid(body))throw wbError('invalid_request');
    switch(body.action){
      case 'recipe_list':return recipeList(body);
      case 'recipe_save':return recipeSave(body,actor);
      case 'recipe_preview':return recipePreview(body,actor);
      case 'recipe_apply':return recipeApply(body,actor);
      case 'proposal_list':return proposalList(body);
      case 'proposal_get':return proposalGet(body);
      case 'proposal_reject':return proposalReject(body);
    }
    throw wbError('invalid_request');
  }

  return {dispatch,recipeList,proposalList};
}
