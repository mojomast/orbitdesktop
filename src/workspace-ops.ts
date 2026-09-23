import { pluginOperation } from './plugins.ts';
import { validate, monitor, leaves, replace, remove, pane, type Workspace, type PaneKind, type Monitor } from './model.ts';

export function applyOperation(input: Workspace, op: Record<string, any>): Workspace {
  let state = structuredClone(input);
  if (typeof op.action === 'string' && op.action.startsWith('plugin_')) { pluginOperation(state, op); return validate(state); }
  const target = () => { const m = state.monitors.find(m => m.id === op.window_id); if (!m) throw Error('Unknown window_id'); return m; };
  switch (op.action) {
    case 'reset_appearance': {
      if (!Array.isArray(op.keys) || op.keys.some((k:unknown)=>typeof k!=='string' || !['theme','surfaceColor','panelColor','borderColor','mutedColor','titlebarColor','titlebarTextColor','buttonColor','buttonTextColor','controlRadius','titlebarHeight','uiFont','background','wallpaper','textColor','cornerRadius','fullViewport','headerHeight','sidebarWidth','workspaceGap','accentColor','navigationPosition','wallpaperFit'].includes(k as string))) throw Error('Invalid appearance reset keys');
      for(const key of op.keys) if(state.appearance) delete (state.appearance as any)[key];break;
    }
    case 'set_arc': state.arc=op.arc;break;
    case 'reorder_windows': {
      if(!Array.isArray(op.window_ids)||op.window_ids.length!==state.monitors.length||new Set(op.window_ids).size!==state.monitors.length||op.window_ids.some((id:string)=>!state.monitors.some(m=>m.id===id)))throw Error('Provide every window ID exactly once');
      state.monitors=op.window_ids.map((id:string)=>state.monitors.find(m=>m.id===id)!);break;
    }
    case 'swap_panes': {
      const a=target(),b=state.monitors.find(m=>m.id===op.other_window_id);if(!b)throw Error('Unknown other_window_id');
      const pa=leaves(a.layout).find(p=>p.id===op.pane_id),pb=leaves(b.layout).find(p=>p.id===op.other_pane_id);if(!pa||!pb||pa.id===pb.id)throw Error('Choose two distinct existing panes');
      if(a===b){const swap=(node:any):any=>node.type==='pane'?{type:'pane',pane:node.pane.id===pa.id?pb:node.pane.id===pb.id?pa:node.pane}:{...node,first:swap(node.first),second:swap(node.second)};a.layout=swap(a.layout);}
      else {a.layout=replace(a.layout,pa.id,()=>({type:'pane',pane:pb}));b.layout=replace(b.layout,pb.id,()=>({type:'pane',pane:pa}));}break;
    }
    case 'layout_panes': {
      const m=target(),existing=leaves(m.layout),used=new Set<string>();
      const build=(node:any,depth=0):any=>{if(!node||typeof node!=='object'||depth>8)throw Error('Invalid layout template');if(node.pane_id){const p=existing.find(p=>p.id===node.pane_id);if(!p||used.has(p.id))throw Error('Unknown or duplicate pane');used.add(p.id);return {type:'pane',pane:p};}return {type:'split',axis:node.axis,ratio:node.ratio,first:build(node.first,depth+1),second:build(node.second,depth+1)};};
      m.layout=build(op.layout);if(used.size!==existing.length)throw Error('Layout must retain every pane');break;
    }
    case 'arrange_windows': {
      const ids=op.window_ids??state.monitors.map(m=>m.id);
      if(!Array.isArray(ids)||!ids.length||new Set(ids).size!==ids.length)throw Error('Provide distinct window IDs');
      const windows=ids.map((id:string)=>{const m=state.monitors.find(m=>m.id===id);if(!m)throw Error('Unknown window ID');return m;});
      const {width,height}=op,gap=op.gap??8,columns=op.columns??Math.ceil(Math.sqrt(windows.length));
      if(!Number.isFinite(width)||!Number.isFinite(height)||width<280||height<180||width>16000||height>16000||!Number.isFinite(gap)||gap<0||gap>100||!Number.isInteger(columns)||columns<1||columns>windows.length)throw Error('Invalid arrangement bounds');
      const rows=Math.ceil(windows.length/columns),w=(width-gap*(columns-1))/columns,h=(height-gap*(rows-1))/rows;
      if(w<280||h<180)throw Error('Viewport too small for requested grid');
      windows.forEach((m:Monitor,i:number)=>{m.frame={x:(i%columns)*(w+gap),y:Math.floor(i/columns)*(h+gap),width:w,height:h,z:i+1};});state.view='windows';break;
    }
    case 'set_workspace': return validate(structuredClone(op.state));
    case 'patch_appearance': {
      if (!op.patch || typeof op.patch !== 'object' || Array.isArray(op.patch)) throw Error('Expected appearance patch object');
      state.appearance = { ...state.appearance, ...op.patch }; break;
    }
    case 'update_split': {
      const m = target();
      if (!Array.isArray(op.path) || op.path.length > 8 || op.path.some((p:unknown) => p !== 'first' && p !== 'second')) throw Error('Split path must contain first/second');
      let node = m.layout;
      for (const branch of op.path) { if (node.type !== 'split') throw Error('Split path crosses a pane'); node = branch === 'first' ? node.first : node.second; }
      if (node.type !== 'split') throw Error('Target is not a split');
      if (op.ratio !== undefined) node.ratio = op.ratio;
      if (op.axis !== undefined) node.axis = op.axis;
      if (op.swap !== undefined && typeof op.swap !== 'boolean') throw Error('swap must be boolean');
      if (op.swap) [node.first, node.second] = [node.second, node.first];
      break;
    }
    case 'set_appearance': state.appearance = op.appearance; break;
    case 'set_view': state.view = op.view; break;
    case 'sidebar': state.sidebarHidden = op.hidden; break;
    case 'select': state.selected = target().id; break;
    case 'add_window': {
      const m = monitor(state.monitors.length + 1, (op.kind || 'browser') as PaneKind);
      if (op.name) m.name = op.name;
      if (op.url) leaves(m.layout)[0].url = op.url;
      if (op.frame) m.frame = op.frame;
      state.monitors.push(m); state.selected = m.id; break;
    }
    case 'update_window': {
      const m = target();
      const keys = ['name', 'diagonal', 'aspect', 'height', 'distance', 'pitch', 'yaw', 'offset', 'fontSize', 'frame'] as const;
      for (const key of keys) if (op[key] !== undefined) (m as any)[key] = op[key];
      break;
    }
    case 'close_window': state.monitors = state.monitors.filter(m => m.id !== target().id); break;
    case 'set_pane': {
      const m = target();
      if (!leaves(m.layout).some(p => p.id === op.pane_id)) throw Error('Unknown pane_id');
      m.layout = replace(m.layout, op.pane_id, p => ({ type: 'pane', pane: { ...p, ...(op.kind ? { kind: op.kind } : {}), ...(op.url ? { url: op.url } : {}) } })); break;
    }
    case 'split_pane': {
      const m = target();
      if (!leaves(m.layout).some(p => p.id === op.pane_id)) throw Error('Unknown pane_id');
      m.layout = replace(m.layout, op.pane_id, p => ({ type: 'split', axis: op.axis || 'row', ratio: op.ratio || 0.5, first: { type: 'pane', pane: p }, second: pane(op.kind || 'browser') })); break;
    }
    case 'close_pane': {
      const m = target(); if (!leaves(m.layout).some(p => p.id === op.pane_id)) throw Error('Unknown pane_id');
      const next = remove(m.layout, op.pane_id); if (!next) throw Error('Keep at least one pane'); m.layout = next; break;
    }
    default: throw Error('Unknown workspace action');
  }
  return validate(state);
}
