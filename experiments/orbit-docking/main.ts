import { createDockview } from 'dockview-core';
import { createPane, setToken, type PaneView } from '../../src/panes';
import { applyOperation } from '../../src/workspace-ops';
import { leaves, monitor, validate, type Workspace, type Pane, type Layout } from '../../src/model';
import { DesktopScene } from '../../src/scene';
import { moveConnected, supportsConnectedMove } from '../../src/connected-dom';
import './style.css';

type Args = Record<string, any>;
type Runtime = { view: PaneView; signature: string; loads: number; pane: Pane };
const $ = (id: string) => document.getElementById(id)!;
const host = $('host'), surfaces = $('surfaces'), spatial = $('spatial'), focusHost = $('focus'), parking = $('parking');
const views = new Map<string, Runtime>();
const windows = new Map<string, HTMLElement>();
const placeholders = new Map<string, HTMLElement>();
const minimized = new Set<string>();
const identities = new WeakMap<object, number>();
let nextIdentity = 0;
function identity(value: object | null) { if (!value) return null; if (!identities.has(value)) identities.set(value, ++nextIdentity); return identities.get(value); }
let state: Workspace;
let dock: ReturnType<typeof createDockview>;
let scene: DesktopScene;
let focused: string | null = null;
let reconciling = false;
let revision = 0;
let lastDetails: Args = {};
const signature = (p: Pane) => `${p.kind}:${p.kind === 'browser' ? p.url : ''}`;
const owner = (id: string) => state.monitors.find(m => leaves(m.layout).some(p => p.id === id)) ?? (() => { throw Error('Unknown pane_id'); })();
const windowById = (id: string) => state.monitors.find(m => m.id === id) ?? (() => { throw Error('Unknown window_id'); })();
const panel = (id: string) => dock.getPanel(id) ?? (() => { throw Error('Unknown Dockview window'); })();
function supported(input: unknown): Workspace {
  // validate mutates selected/plugins, therefore always work on an isolated clone.
  // Orbit's validator repairs a missing selected window for normal loading;
  // this adapter must not silently normalize an injected checkpoint mapping.
  if (!input || typeof input !== 'object' || !Array.isArray((input as Workspace).monitors) ||
      !(input as Workspace).monitors.some(m => m?.id === (input as Workspace).selected)) {
    throw Error('Unsupported v1 mapping: selected window must exist');
  }
  const candidate = validate(structuredClone(input));
  if (candidate.plugins?.length) throw Error('Unsupported v1 construct: plugins');
  if (candidate.appearance && Object.keys(candidate.appearance).length) throw Error('Unsupported v1 construct: appearance overrides');
  if (candidate.sidebarHidden !== undefined) throw Error('Unsupported v1 construct: sidebar');
  for (const m of candidate.monitors) for (const p of leaves(m.layout)) {
    if (p.kind === 'agent') throw Error('Unsupported pane kind: agent (no external model calls)');
    if (p.kind === 'browser' && p.url !== 'orbit://welcome' && !/^\/apps\/[a-z0-9][a-z0-9-]{0,60}\//.test(p.url)) {
      throw Error('Unsupported browser URL: use a sandboxed same-origin /apps/ fixture');
    }
  }
  return candidate;
}
function snapshot() {
  return {
    state: state ? structuredClone(state) : null, revision,
    panes: Object.fromEntries([...views].map(([id, r]) => {
      const iframe = r.view.element.querySelector('iframe');
      return [id, { identity: identity(r.view.element), kind: r.pane.kind, url: r.pane.url,
        connected: r.view.element.isConnected, iframeIdentity: identity(iframe),
        contentWindowIdentity: identity(iframe?.contentWindow ?? null), iframeLoads: r.loads,
        terminalStatus: r.view.element.querySelector('.connection-state')?.textContent ?? null }];
    })),
    docking: dock?.toJSON() ?? null, focused, minimized: [...minimized],
    nativeMoveBefore: supportsConnectedMove(), details: lastDetails,
  };
}
function report(error: unknown) { $('status').textContent = error instanceof Error ? error.message : String(error); }
function invoke(name: string, args: Args) {
  const control = document.activeElement;
  void command(name, args).then(() => {
    if (control instanceof HTMLButtonElement && control.closest('#commands') && control.isConnected) control.focus({ preventScroll: true });
  }).catch(report);
}
function callbacks() {
  return {
    kind: (id: string, kind: Pane['kind']) => invoke('set-pane', { pane_id: id, kind }),
    split: (id: string, axis: 'row' | 'column') => invoke('apply', { operations: [{ action: 'split_pane', window_id: owner(id).id, pane_id: id, axis, kind: 'browser' }] }),
    close: (id: string) => invoke('close', { pane_id: id }),
    move: (id: string, popout: boolean) => invoke(popout ? 'float' : 'tab', { window_id: owner(id).id, target_window_id: state.monitors.find(m => m.id !== owner(id).id)?.id }),
    url: (id: string, url: string) => {
      // createPane calls url synchronously while mounting. An unchanged callback
      // is acknowledgement, not a request to recursively rebuild the runtime.
      const p = leaves(owner(id).layout).find(p => p.id === id)!;
      if (p.url !== url) invoke('set-pane', { pane_id: id, url });
    },
  };
}
function layoutTree(node: Layout): HTMLElement {
  const element = document.createElement('div');
  if (node.type === 'pane') {
    element.className = 'pane-slot'; element.dataset.slotId = node.pane.id;
  } else {
    element.className = 'split'; element.style.flexDirection = node.axis;
    const first = layoutTree(node.first), second = layoutTree(node.second);
    first.style.flex = `${node.ratio} 1 0`; second.style.flex = `${1 - node.ratio} 1 0`;
    element.append(first, second);
  }
  return element;
}
function reconcile(candidate: Workspace) {
  reconciling = true;
  try {
    // Park every live pane before any old split/window/CSS3D anchor is removed.
    for (const r of views.values()) moveConnected(r.view.element, parking);
    for (const element of windows.values()) moveConnected(element, parking);
    state = candidate;
    const wanted = new Map(state.monitors.flatMap(m => leaves(m.layout).map(p => [p.id, p] as const)));
    for (const [id, r] of views) if (!wanted.has(id) || signature(wanted.get(id)!) !== r.signature) {
      r.view.dispose(); r.view.element.remove(); views.delete(id);
    }
    for (const [id, element] of windows) if (!state.monitors.some(m => m.id === id)) {
      dock.removePanel(panel(id)); element.remove(); windows.delete(id); placeholders.delete(id); minimized.delete(id);
    }
    if (focused && !windows.has(focused)) focused = null;
    scene.retainWindows(state.monitors);
    for (const m of state.monitors) {
      let element = windows.get(m.id);
      if (!element) {
        element = document.createElement('section'); element.className = 'monitor'; element.dataset.monitorId = m.id;
        parking.append(element); windows.set(m.id, element);
      }
      const title = document.createElement('div'); title.className = 'monitor-title'; title.textContent = m.name;
      title.addEventListener('dblclick', () => invoke('focus', { window_id: m.id }));
      const content = layoutTree(m.layout); content.classList.add('monitor-layout'); element.replaceChildren(title, content);
      for (const p of leaves(m.layout)) {
        let runtime = views.get(p.id);
        if (!runtime) {
          const view = createPane(p, m.fontSize, callbacks());
          runtime = { view, signature: signature(p), pane: p, loads: 0 }; views.set(p.id, runtime);
          const captured = runtime;
          view.element.querySelector('iframe')?.addEventListener('load', () => captured.loads++);
        }
        runtime.pane = p; runtime.view.setFont(state.view === 'spatial' ? m.spatialFontSize ?? m.fontSize : m.fontSize);
        moveConnected(runtime.view.element, content.querySelector(`[data-slot-id="${p.id}"]`) as HTMLElement || content);
      }
      if (!dock.getPanel(m.id)) dock.addPanel({ id: m.id, component: 'orbit-window', title: m.name, renderer: 'always',
        ...(dock.panels.length ? { position: { referencePanel: dock.panels[dock.panels.length - 1], direction: 'right' as const } } : {}) });
      else panel(m.id).api.setTitle(m.name);
    }
    scene.configureCamera(state.spatialCamera, camera => { if (!reconciling) state = applyOperation(state, { action: 'set_spatial_camera', camera }); });
    panel(state.selected).api.setActive();
    for (const id of ['window', 'target']) {
      const select = $(id) as HTMLSelectElement, previous = select.value;
      select.replaceChildren(...state.monitors.map(m => new Option(m.name, m.id)));
      select.value = state.monitors.some(m => m.id === previous) ? previous : id === 'window' ? state.selected : state.monitors[1]?.id ?? state.selected;
    }
    revision++;
    place();
  } finally { reconciling = false; }
}
function place() {
  if (!state) return;
  const inSpatial = state.view === 'spatial';
  spatial.style.display = inSpatial ? 'block' : 'none';
  host.style.visibility = inSpatial || focused ? 'hidden' : 'visible';
  focusHost.style.display = focused ? 'block' : 'none';
  if (inSpatial) {
    for (const [id, element] of windows) { element.classList.toggle('flat-monitor', focused === id); element.style.cssText = ''; }
    scene.resize(); scene.update(state.monitors, windows, state.selected, state.arc);
  }
  const bounds = surfaces.getBoundingClientRect();
  for (const [id, element] of windows) {
    element.style.opacity = String(windowById(id).opacity ?? 1);
    if (id === focused) { element.classList.add('flat-monitor'); moveConnected(element, focusHost); element.style.cssText = 'width:100%;height:100%'; }
    else if (!inSpatial) {
      element.classList.remove('flat-monitor'); moveConnected(element, surfaces);
      const p = dock.getPanel(id), rect = placeholders.get(id)?.getBoundingClientRect();
      const visible = p?.api.isVisible && rect && rect.width > 0 && rect.height > 0 && !minimized.has(id) && !focused;
      element.style.visibility = visible ? 'visible' : 'hidden';
       // A hidden Dockview tab reports a zero-size placeholder. Keep its last
       // live geometry instead of fitting xterm to a 2-column pseudo-terminal.
       if (rect && rect.width > 0 && rect.height > 0) Object.assign(element.style, { left: `${rect.left - bounds.left}px`, top: `${rect.top - bounds.top}px`, width: `${rect.width}px`, height: `${rect.height}px`, zIndex: p?.api.location.type === 'floating' ? '1000' : '2' });
       else if (!visible) Object.assign(element.style, { width: '960px', height: '700px' });
    }
    if (inSpatial && id !== focused) element.style.visibility = minimized.has(id) ? 'hidden' : 'visible';
  }
   // PaneView's terminal host ResizeObserver fits xterm when actual geometry
   // changes. Fitting every animation frame floods resize frames and can shrink
   // a hidden tab's tmux grid while a fresh-output continuity probe is running.
}
const settle = () => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
async function command(name: string, args: Args = {}) {
  await ready;
  const id = args.window_id ?? state.selected;
  if (name === 'apply' || name === 'reconcile' || name === 'checkpoint') {
    let candidate = state;
    if (name === 'apply') {
      if (!Array.isArray(args.operations) || !args.operations.length) throw Error('Provide operations');
      for (const operation of args.operations) candidate = applyOperation(candidate, operation);
    } else candidate = args.state;
    reconcile(supported(candidate));
  } else if (name === 'set-pane' || name === 'close') {
    const m = owner(args.pane_id);
    const operation = name === 'set-pane' ? { action: 'set_pane', window_id: m.id, ...args }
      : leaves(m.layout).length === 1 ? { action: 'close_window', window_id: m.id } : { action: 'close_pane', window_id: m.id, pane_id: args.pane_id };
    reconcile(supported(applyOperation(state, operation as any)));
  } else if (name === 'spatial' || name === 'windows') {
    reconcile(supported(applyOperation(state, { action: 'set_view', view: name === 'spatial' && args.enabled !== false ? 'spatial' : 'windows' })));
  } else if (name === 'reorder') {
    const candidate = supported(applyOperation(state, { action: 'reorder_windows', window_ids: args.window_ids }));
    reconcile(candidate);
    // Explicitly reconstruct a docked sequence; v1 ordering has no tab topology.
    for (let i = 1; i < state.monitors.length; i++) panel(state.monitors[i].id).api.moveTo({ group: panel(state.monitors[i - 1].id).group, position: 'right' });
  } else if (name === 'unfocus') focused = null;
  else {
    windowById(id);
    switch (name) {
      case 'select': state = applyOperation(state, { action: 'select', window_id: id }); panel(id).api.setActive(); revision++; break;
      case 'focus': focused = id; state = applyOperation(state, { action: 'select', window_id: id }); break;
      case 'minimize': minimized.add(id); break;
      case 'restore': minimized.delete(id); panel(id).api.setActive(); break;
      case 'tab': case 'move': case 'dock': {
        const target = args.target_window_id ?? state.monitors.find(m => m.id !== id)?.id;
        windowById(target);
        if (id === target) throw Error('Choose distinct windows');
        if (args.index !== undefined && (!Number.isInteger(args.index) || args.index < 0)) throw Error('Invalid tab index');
        const direction = args.direction ?? 'right';
        if (!['left', 'right', 'above', 'below'].includes(direction)) throw Error('Invalid dock direction');
        panel(id).api.moveTo({ group: panel(target).group, ...(name === 'dock' ? { position: direction } : { index: args.index ?? 0 }) }); break;
      }
      case 'float': case 'resize': {
        const { width = 600, height = 420, x = 32, y = 32 } = args;
        if (![width, height, x, y].every(Number.isFinite) || width < 280 || height < 180 || width > 4000 || height > 4000 || x < 0 || y < 0) throw Error('Invalid geometry');
        if (name === 'float') dock.addFloatingGroup(panel(id), { x, y, width, height });
        else panel(id).group.api.setSize({ width, height });
        break;
      }
      default: throw Error(`Unsupported command: ${name}`);
    }
  }
  lastDetails = { command: name };
  place(); await settle(); place();
  $('status').textContent = `${name} complete · revision ${revision}`;
  return snapshot();
}
const ready = (async () => {
  if (!supportsConnectedMove()) throw Error('Native Element.moveBefore required; this is not a passing fallback');
  const query = new URLSearchParams(location.search), fixture = query.get('fixture');
  if (!fixture || !/^\/apps\/[a-z0-9][a-z0-9-]{0,60}\//.test(fixture)) throw Error('Provide ?fixture=/apps/<published-slug>/index.html');
  const fixtureToken = Reflect.get(window, '__orbitSpikeToken');
  setToken(typeof fixtureToken === 'string' ? fixtureToken : '');
  Reflect.deleteProperty(window, '__orbitSpikeToken');
  dock = createDockview(host, { createComponent: ({ id }) => {
    const element = document.createElement('div'); element.className = 'placeholder'; placeholders.set(id, element);
    return { element, init() {}, dispose() {} };
  }});
  scene = new DesktopScene(spatial);
  dock.onDidActivePanelChange(({ panel: p }) => { if (state && p && !reconciling && state.monitors.some(m => m.id === p.id)) state = applyOperation(state, { action: 'select', window_id: p.id }); });
  // Library close controls are intentionally hidden; pane close uses validated ops.
  host.addEventListener('pointerdown', event => {
    const target = (event.target as HTMLElement).closest('.dv-sash');
    if (target instanceof HTMLElement) target.setPointerCapture(event.pointerId);
  }, true);
  host.addEventListener('dragstart', () => document.body.classList.add('library-drag'));
  for (const event of ['dragend', 'drop']) document.addEventListener(event, () => document.body.classList.remove('library-drag'));
  const initial: Workspace = { version: 1, view: 'windows', arc: 14, selected: 'window-a', monitors: ['a', 'b', 'terminal'].map((suffix, index) => {
    const m = monitor(index + 1, suffix === 'terminal' ? 'terminal' : 'browser');
    m.id = `window-${suffix}`; m.name = `Orbit ${suffix}`;
    // LocalHostProvider persists only UUID pane IDs; friendly synthetic IDs
    // silently route the real PaneView to a direct, non-tmux shell.
    m.layout = { type: 'pane', pane: { id: crypto.randomUUID(), kind: suffix === 'terminal' ? 'terminal' : 'browser', url: suffix === 'terminal' ? 'orbit://welcome' : fixture } };
    return m;
  }) };
  reconcile(supported(initial));
  const resize = () => { dock.layout(host.clientWidth, host.clientHeight); place(); };
  new ResizeObserver(resize).observe(host); resize();
  // Geometry is library-owned and can change during native pointer gestures.
  function tick() { place(); requestAnimationFrame(tick); } requestAnimationFrame(tick);
  for (const name of ['select', 'tab', 'move', 'dock', 'float', 'resize', 'spatial', 'windows', 'focus', 'unfocus', 'minimize', 'restore', 'reorder']) {
    const button = document.createElement('button'); button.textContent = name; button.dataset.command = name;
    button.onclick = () => invoke(name, { window_id: ($('window') as HTMLSelectElement).value, target_window_id: ($('target') as HTMLSelectElement).value, ...(name === 'reorder' ? { window_ids: state.monitors.map(m => m.id).reverse() } : {}) });
    $('commands').append(button);
  }
  await settle(); place(); $('status').textContent = 'Ready · native connected moves required · disposable server only';
})();
(window as any).orbitSpike = { ready, command, snapshot };
ready.catch(report);
