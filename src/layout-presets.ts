import { validate, type Workspace, type Monitor } from './model.ts';

const fields = ['frame','spatial','fontSize','spatialFontSize','diagonal','aspect','height','distance','pitch','yaw','offset'] as const;
type Placement = Pick<Monitor, typeof fields[number]> & {id:string};
export interface SavedLayout {
  id:string; name:string; view:'windows'|'spatial'; selected:string; arc:number;
  camera?:Workspace['spatialCamera']; windows:Placement[]; minimized:string[];
}
export function captureLayout(state:Workspace, name:string, id:string, minimized:string[] = []):SavedLayout {
  return structuredClone({id, name, view:state.view || 'windows', selected:state.selected, arc:state.arc,
    camera:state.spatialCamera, minimized, windows:state.monitors.map(m => {
      const placement:Record<string,unknown>={id:m.id};
      for(const key of fields) if(m[key]!==undefined) placement[key]=m[key];
      return placement as unknown as Placement;
    })});
}
// Only geometry and scaling are restored. Never resurrect closed panes or remove new ones.
export function applyLayout(state:Workspace, layout:SavedLayout):Workspace {
  if(!layout || !['windows','spatial'].includes(layout.view) || !Array.isArray(layout.windows) ||
    !Array.isArray(layout.minimized) || !layout.minimized.every(id=>typeof id==='string') ||
    typeof layout.name!=='string' || !layout.name.trim() || layout.name.length>80) throw Error('Invalid saved layout');
  const next=structuredClone(state);
  next.view=layout.view; next.arc=layout.arc; next.spatialCamera=structuredClone(layout.camera);
  if(next.monitors.some(m=>m.id===layout.selected)) next.selected=layout.selected;
  for(const m of next.monitors) {
    const placement=layout.windows.find(w=>w.id===m.id); if(!placement) continue;
    for(const field of fields) {
      if(placement[field]===undefined) delete (m as unknown as Record<string,unknown>)[field];
      else (m as unknown as Record<string,unknown>)[field]=structuredClone(placement[field]);
    }
  }
  return validate(next);
}
