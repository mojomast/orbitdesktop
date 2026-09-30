import { canonicalJson } from './command-identity.mjs';
import { emptyPlacement } from '../src/docking-placement.ts';

// Bounded, content-free restore summary. Never return URLs, config values,
// terminal buffers or conversation contents as diff labels.
export function checkpointChanges(current, checkpoint) {
  const changes = [];
  let truncated = false;
  const add = (target, kind, label, fields = []) => {
    if (changes.length >= 300) { truncated = true; return; }
    changes.push({ target, kind, label: String(label).slice(0, 160), fields: fields.slice(0, 32) });
  };
  const same = (a, b) => canonicalJson(a ?? null) === canonicalJson(b ?? null);
  const fieldsChanged = (before, after, keys) => keys.filter(key => !same(before?.[key], after?.[key]));
  const before = current.state, after = checkpoint.state;
  const workspaceFields = fieldsChanged(before, after, ['selected', 'arc', 'view', 'sidebarHidden', 'spatialCamera']);
  if (!same(before.monitors.map(m => m.id), after.monitors.map(m => m.id))) workspaceFields.push('window order');
  const appearanceFields = [...new Set([...Object.keys(before.appearance ?? {}), ...Object.keys(after.appearance ?? {})])].filter(key => !same(before.appearance?.[key], after.appearance?.[key]));
  if (appearanceFields.length) add('workspace', 'changed', 'Appearance', appearanceFields);
  if (workspaceFields.length) add('workspace', 'changed', 'Workspace', workspaceFields);
  const left = new Map(before.monitors.map(m => [m.id, m]));
  const right = new Map(after.monitors.map(m => [m.id, m]));
  for (const [id, window] of left) {
    if (!right.has(id)) add('window', 'removed', window.name || 'Window');
    else {
      const fields = fieldsChanged(window, right.get(id), ['name', 'frame', 'fontSize', 'spatialFontSize', 'opacity', 'diagonal', 'aspect', 'height', 'distance', 'pitch', 'yaw', 'offset', 'spatial', 'layout']);
      if (fields.length) add('window', 'changed', right.get(id).name || 'Window', fields);
    }
  }
  for (const [id, window] of right) if (!left.has(id)) add('window', 'added', window.name || 'Window');
  const panes = state => {
    const result = new Map();
    const visit = (node, window) => {
      if (node.type === 'pane') result.set(node.pane.id, { ...node.pane, window });
      else { visit(node.first, window); visit(node.second, window); }
    };
    for (const window of state.monitors) visit(window.layout, window.id);
    return result;
  };
  const oldPanes = panes(before), newPanes = panes(after);
  for (const [id, pane] of oldPanes) {
    if (!newPanes.has(id)) add('pane', 'removed', `${pane.kind} pane`);
    else {
      const fields = fieldsChanged(pane, newPanes.get(id), ['kind', 'url', 'window']);
      if (fields.length) add('pane', 'changed', `${newPanes.get(id).kind} pane`, fields);
    }
  }
  for (const [id, pane] of newPanes) if (!oldPanes.has(id)) add('pane', 'added', `${pane.kind} pane`);
  const pluginKey = p => p.instance_id === undefined ? `legacy:${p.manifest.id}` : `instance:${p.instance_id}`;
  const oldPlugins = new Map((before.plugins ?? []).map(p => [pluginKey(p), p]));
  const newPlugins = new Map((after.plugins ?? []).map(p => [pluginKey(p), p]));
  for (const [id, plugin] of oldPlugins) {
    if (!newPlugins.has(id)) add('plugin', 'removed', plugin.window.name || plugin.manifest.title);
    else {
      const fields = fieldsChanged(plugin, newPlugins.get(id), ['manifest', 'enabled', 'window', 'config', 'backendEndpoint']);
      if (fields.length) add('plugin', 'changed', newPlugins.get(id).window.name || newPlugins.get(id).manifest.title, fields);
    }
  }
  for (const [id, plugin] of newPlugins) if (!oldPlugins.has(id)) add('plugin', 'added', plugin.window.name || plugin.manifest.title);
  if (!same(current.placement ?? emptyPlacement(), checkpoint.placement ?? emptyPlacement())) add('docking', 'changed', 'Docking placement', ['groups, tabs or floating windows']);
  return { changes, truncated };
}
