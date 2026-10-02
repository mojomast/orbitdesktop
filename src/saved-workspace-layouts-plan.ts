import {validate, type Workspace, type Monitor} from './model.ts';
import {validateDockingPlacement, prunePlacement, emptyPlacement, type DockingPlacement, type PlacementNode} from './docking-placement.ts';
import {measuredViewport, type ArrangeViewport} from './workspace-arrange-plan.ts';

const geometryKeys = ['frame','spatial','diagonal','aspect','height','distance','pitch','yaw','offset'] as const;
export interface SavedLayout {
  version: 1;
  windows: {id:string; name:string; geometry:Partial<Monitor>}[];
  view: 'windows'|'spatial';
  selected: string;
  placement: DockingPlacement;
  viewport: ArrangeViewport;
}
export function captureLayout(state:Workspace, placement:DockingPlacement, viewport:ArrangeViewport):SavedLayout {
  if(state.monitors.length>100)throw Error('At most 100 windows can be saved.');
  return {version:1,windows:state.monitors.map(m=>({id:m.id,name:m.name,geometry:Object.fromEntries(geometryKeys.filter(k=>m[k]!==undefined).map(k=>[k,structuredClone(m[k])]))})),
    view:state.view??'windows',selected:state.selected,placement:validateDockingPlacement(placement,{windowIds:state.monitors.map(m=>m.id)}),viewport:measuredViewport(viewport)};
}
export function validateSavedLayout(value:SavedLayout):SavedLayout {
  const only=(v:object,keys:readonly string[])=>{if(!v||typeof v!=='object'||Array.isArray(v)||Object.keys(v).some(k=>!keys.includes(k)))throw Error('Invalid saved layout fields');};
  only(value,['version','windows','view','selected','placement','viewport']);
  if(value.version!==1||!Array.isArray(value.windows)||!value.windows.length||value.windows.length>100||!['windows','spatial'].includes(value.view))throw Error('Invalid saved layout');
  only(value.viewport,['width','height']);measuredViewport(value.viewport);
  const ids=new Set<string>();
  for(const w of value.windows){only(w,['id','name','geometry']);only(w.geometry,geometryKeys);if(!/^[a-zA-Z0-9_-]{1,100}$/.test(w.id)||ids.has(w.id)||typeof w.name!=='string'||w.name.length>60)throw Error('Invalid saved window');ids.add(w.id);
    // Reuse the core geometry contract without retaining or accepting pane content.
    validate({version:1,arc:14,selected:w.id,monitors:[{...w.geometry,id:w.id,name:w.name,fontSize:19,layout:{type:'pane',pane:{id:w.id==='validation-pane'?'validation-pane-2':'validation-pane',kind:'browser',url:'orbit://welcome'}}} as Monitor]});
  }
  if(!ids.has(value.selected))throw Error('Invalid selected window');
  validateDockingPlacement(value.placement,{windowIds:[...ids]});return structuredClone(value);
}
/** Bind by stable ID; mappings may replace only missing identities, never names. */
export function compileSavedLayout(record:{state:Workspace;placement?:DockingPlacement}, raw:SavedLayout, viewport:ArrangeViewport, replacements:Record<string,string>={}) {
  const saved=validateSavedLayout(raw),size=measuredViewport(viewport),state=structuredClone(record.state),current=new Set(state.monitors.map(m=>m.id));
  const bindings=new Map<string,string>(),used=new Set<string>();
  if(!replacements||typeof replacements!=='object'||Array.isArray(replacements)||Object.keys(replacements).length>100)throw Error('Invalid replacement mapping');
  for(const key of Object.keys(replacements))if(!saved.windows.some(w=>w.id===key)||current.has(key))throw Error('Replacement mappings apply only to missing saved IDs');
  const missing:string[]=[];
  for(const w of saved.windows){const id=current.has(w.id)?w.id:replacements[w.id];if(!id){missing.push(w.id);continue;}if(!current.has(id)||used.has(id))throw Error('Replacement must identify a distinct current window');bindings.set(w.id,id);used.add(id);}
  const sx=size.width/saved.viewport.width,sy=size.height/saved.viewport.height;
  for(const w of saved.windows){const id=bindings.get(w.id);if(!id)continue;const m=state.monitors.find(m=>m.id===id)!;
    for(const k of geometryKeys){delete m[k];if(w.geometry[k]!==undefined)Object.assign(m,{[k]:structuredClone(w.geometry[k])});}
    if(m.frame)m.frame={...m.frame,x:Math.min(10000,Math.max(0,Math.min(m.frame.x*sx,size.width-280))),y:Math.min(10000,Math.max(0,Math.min(m.frame.y*sy,size.height-180))),width:Math.max(280,Math.min(4000,size.width,m.frame.width*sx)),height:Math.max(180,Math.min(4000,size.height,m.frame.height*sy))};
  }
  const matched=saved.windows.flatMap(w=>bindings.has(w.id)?[state.monitors.find(m=>m.id===bindings.get(w.id))!]:[]);
  // Reorder matched slots only; unrelated windows retain their order and geometry.
  let index=0;state.monitors=state.monitors.map(m=>used.has(m.id)?matched[index++]:m);
  state.view=saved.view;state.selected=bindings.get(saved.selected)??state.selected;
  const mapped=prunePlacement(saved.placement,[...bindings.keys()]);
  const node=(n:PlacementNode|null):PlacementNode|null=>!n?null:n.type==='group'?{...n,windows:n.windows.map(id=>bindings.get(id)!),...(n.active?{active:bindings.get(n.active)!}:{})}:{...n,first:node(n.first)!,second:node(n.second)!};
  const retained=prunePlacement(record.placement??emptyPlacement(),state.monitors.filter(m=>!used.has(m.id)).map(m=>m.id));
  const layout=node(mapped.layout);
  const placement=validateDockingPlacement({version:1,layout:layout&&retained.layout?{type:'branch',direction:'horizontal',ratio:0.75,first:layout,second:retained.layout}:layout??retained.layout,
    floats:[...mapped.floats.map(f=>({...f,windows:f.windows.map(id=>bindings.get(id)!),...(f.active?{active:bindings.get(f.active)!}:{}),frame:{x:Math.min(10000,f.frame.x*sx),y:Math.min(10000,f.frame.y*sy),width:Math.min(10000,Math.max(80,f.frame.width*sx)),height:Math.min(10000,Math.max(60,f.frame.height*sy))}})),...retained.floats],active:bindings.get(saved.placement.active??'')??retained.active},{windowIds:state.monitors.map(m=>m.id)});
  return {state:validate(state),placement,missing,bindings:Object.fromEntries(bindings),viewport:size};
}
