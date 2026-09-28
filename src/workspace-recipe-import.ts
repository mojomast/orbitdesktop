import {applyLayout, type SavedLayout} from './layout-presets.ts';
import {leaves, type Workspace} from './model.ts';

const ROLES=['primary_agent','active_terminal','preview','candidate_diff','project_files'] as const;
type RecipeRole=typeof ROLES[number];
export type WorkspaceRecipeBinding={id:string;pane_id:string;role:RecipeRole};
export type PortableWorkspaceRecipe={name:string;roles:RecipeRole[];layout:'prioritize'|'columns'|'rows';renderer:'windows'|'spatial'};
export type WorkspaceRecipeImport={definition:PortableWorkspaceRecipe;warnings:string[];omitted_fields:string[];absent_roles:RecipeRole[]};

const ID=/^[A-Za-z0-9_-]{1,100}$/;
const roleSet=new Set<string>(ROLES);
const savedFields=new Set(['id','name','view','selected','arc','camera','windows','minimized']);
const placementFields=new Set(['id','frame','spatial','fontSize','spatialFontSize','diagonal','aspect','height','distance','pitch','yaw','offset']);
const OMITTED_FIELDS=Object.freeze([
  'frame pixel coordinates',
  'window size and scaling geometry',
  'minimized-window state',
  'selected-window state',
  'spatial camera position',
]);

function invalid(reason:string):never{throw new Error(`Cannot import saved layout: ${reason}`);}
function plainObject(value:unknown):value is Record<string,unknown>{return !!value&&typeof value==='object'&&!Array.isArray(value)&&Object.getPrototypeOf(value)===Object.prototype;}
function checkKeys(value:Record<string,unknown>,allowed:Set<string>,label:string){
  if(Object.keys(value).some(key=>!allowed.has(key)))invalid(`unsupported ${label} fields`);
}

/**
 * Convert an existing local SavedLayout to portable role-order constraints.
 * This function is pure: callers retain the legacy layout and should preview a
 * returned definition before saving it durably. It never writes localStorage.
 */
export function importSavedLayoutAsWorkspaceRecipe(
  saved:SavedLayout,
  current:Workspace,
  bindings:readonly WorkspaceRecipeBinding[],
  roleChoices:Readonly<Record<string,string>>={},
):WorkspaceRecipeImport{
  if(!plainObject(saved))invalid('layout must be an object');
  checkKeys(saved,savedFields,'layout');
  if(typeof saved.id!=='string'||!ID.test(saved.id))invalid('layout ID is invalid');
  if(typeof saved.name!=='string'||saved.name.length<1||saved.name.length>60||!saved.name.trim()||saved.name.trim()!==saved.name)invalid('recipe name must be 1–60 trimmed characters');
  if(!Array.isArray(saved.windows)||saved.windows.length>100)invalid('layout window count exceeds 100');
  const seenWindowIds=new Set<string>();
  for(const item of saved.windows){
    if(!plainObject(item))invalid('window placement must be an object');
    checkKeys(item,placementFields,'window placement');
    if(typeof item.id!=='string'||!ID.test(item.id)||seenWindowIds.has(item.id))invalid('window ID is invalid or duplicated');
    seenWindowIds.add(item.id);
  }
  if(!Array.isArray(saved.minimized)||saved.minimized.length>100||saved.minimized.some(item=>typeof item!=='string'||!ID.test(item)))invalid('minimized window list is invalid');

  // Reuse the authoritative legacy validation/application semantics, but only
  // against a clone; no returned value or caller workspace contains its result.
  try{applyLayout(current,saved);}catch{invalid('legacy layout or current workspace failed validation');}

  if(!Array.isArray(bindings)||bindings.length>1000)invalid('project binding count exceeds 1000');
  const panes=new Map<string,string>();
  for(const monitor of current.monitors){
    for(const item of leaves(monitor.layout)){
      if(panes.has(item.id))invalid('current workspace contains a duplicate pane ID');
      panes.set(item.id,monitor.id);
    }
  }
  const bindingIds=new Set<string>();
  const byRole=new Map<RecipeRole,WorkspaceRecipeBinding[]>();
  for(const candidate of bindings){
    if(!plainObject(candidate))invalid('binding must be an object');
    checkKeys(candidate,new Set(['id','pane_id','role']),'binding');
    if(typeof candidate.id!=='string'||!ID.test(candidate.id)||bindingIds.has(candidate.id))invalid('binding ID is invalid or duplicated');
    if(typeof candidate.pane_id!=='string'||!ID.test(candidate.pane_id)||!panes.has(candidate.pane_id))invalid('binding pane does not exist in the current workspace');
    if(typeof candidate.role!=='string'||!roleSet.has(candidate.role))invalid('binding role is not supported');
    bindingIds.add(candidate.id);
    const role=candidate.role as RecipeRole;
    const entries=byRole.get(role)??[];entries.push(candidate as WorkspaceRecipeBinding);byRole.set(role,entries);
  }

  if(!plainObject(roleChoices))invalid('role choices must be an object');
  if(Object.keys(roleChoices).length>ROLES.length)invalid('too many role choices');
  const order=new Map(saved.windows.map((window,index)=>[window.id,index]));
  const currentWindowIds=new Set(current.monitors.map(monitor=>monitor.id));
  const choices=new Map<RecipeRole,WorkspaceRecipeBinding>();
  for(const [key,value] of Object.entries(roleChoices)){
    if(!roleSet.has(key)||typeof value!=='string'||!ID.test(value))invalid('unknown or malformed role choice');
    const role=key as RecipeRole,candidates=byRole.get(role)??[];
    const selected=candidates.find(candidate=>candidate.id===value);
    if(!selected)invalid('role choice is not an actual binding for this project and role');
    choices.set(role,selected);
  }

  const absentRoles:RecipeRole[]=[],ordered:Array<{role:RecipeRole;windowOrder:number;bindingOrder:number}>=[];
  for(const role of ROLES){
    const candidates=byRole.get(role)??[];
    if(!candidates.length){absentRoles.push(role);continue;}
    if(candidates.length>1&&!choices.has(role))invalid(`ambiguous ${role} bindings require an explicit choice`);
    const selected=choices.get(role)??candidates[0];
    const monitorId=panes.get(selected.pane_id)!;
    const savedOrder=order.get(monitorId);
    if(savedOrder===undefined||!currentWindowIds.has(monitorId)){
      absentRoles.push(role);
      continue;
    }
    ordered.push({role,windowOrder:savedOrder,bindingOrder:bindings.indexOf(selected)});
  }
  ordered.sort((a,b)=>a.windowOrder-b.windowOrder||a.bindingOrder-b.bindingOrder);

  const staleWindows=saved.windows.some(window=>!currentWindowIds.has(window.id));
  const unorderedWindows=current.monitors.some(monitor=>!order.has(monitor.id));
  const warnings=[
    'Imports saved window order as portable role-order constraints only; it does not reproduce the legacy layout geometry.',
    'Keep the original local layout unchanged and preview the imported recipe before use. Mark import successful only after durable recipe save.',
  ];
  if(staleWindows)warnings.push('Some saved window IDs are stale and were ignored; no windows or panes were recreated.');
  if(unorderedWindows)warnings.push('Some current windows have no saved-order entry; roles bound there were omitted.');
  if(absentRoles.length)warnings.push('Roles without one usable ordered binding remain absent from the imported recipe.');

  return {
    definition:{name:saved.name,roles:ordered.map(entry=>entry.role),layout:'prioritize',renderer:saved.view},
    warnings,
    omitted_fields:[...OMITTED_FIELDS],
    absent_roles:absentRoles,
  };
}
