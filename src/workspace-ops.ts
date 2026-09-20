import { pluginOperation } from './plugins.ts';
import { validate, monitor, leaves, replace, remove, pane, type Workspace, type PaneKind, type Monitor } from './model.ts';

export function applyOperation(input: Workspace, op: Record<string, any>): Workspace {
  let state = structuredClone(input);
  if (typeof op.action === 'string' && op.action.startsWith('plugin_')) { pluginOperation(state, op); return validate(state); }
  const target = () => { const m = state.monitors.find(m => m.id === op.window_id); if (!m) throw Error('Unknown window_id'); return m; };
  switch (op.action) {
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
