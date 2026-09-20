import { pluginOperation } from './plugins.ts';
import { validate, monitor, leaves, replace, remove, pane, type Workspace, type PaneKind, type Monitor } from './model.ts';

export function applyOperation(input: Workspace, op: Record<string, any>): Workspace {
  let state = structuredClone(input);
  if (typeof op.action === 'string' && op.action.startsWith('plugin_')) { pluginOperation(state, op); return validate(state); }
  const target = () => { const m = state.monitors.find(m => m.id === op.window_id); if (!m) throw Error('Unknown window_id'); return m; };
  switch (op.action) {
    case 'set_workspace': return validate(structuredClone(op.state));
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
