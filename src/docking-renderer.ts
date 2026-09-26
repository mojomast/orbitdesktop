import { moveConnected, supportsConnectedMove } from './connected-dom.ts';
import type { Monitor, Workspace } from './model';
import { dockviewToPlacement, placementToDockview, prunePlacement, ensurePlacementWindows, placementEqual, type DockingPlacement } from './docking-placement.ts';

export function dockingRequested(search: string): boolean {
  return new URLSearchParams(search).get('renderer') === 'docking';
}

export function dockingUnsupportedReason(
  workspace: Workspace | undefined,
  hasMoveBefore: boolean,
): string | null {
  if (!hasMoveBefore) return 'Docking requires native Element.moveBefore to preserve live windows.';
  if (!workspace || !Array.isArray(workspace.monitors) || workspace.monitors.length === 0) {
    return 'Docking requires at least one window.';
  }
  const ids = new Set<string>();
  for (const monitor of workspace.monitors) {
    if (!monitor || typeof monitor.id !== 'string' || !monitor.id.trim()) return 'Docking requires a nonempty window id.';
    if (ids.has(monitor.id)) return 'Docking cannot display duplicate window ids.';
    ids.add(monitor.id);
  }
  return null;
}

export interface DockingController {
  readonly surfaces: HTMLElement;
  retainWindows(monitors: Monitor[], selected: string): void;
  placeWindows(elements: Map<string, HTMLElement>, monitors: Monitor[], selected: string, focused: string | null): void;
  layout(): void;
  applyPlacement(placement: DockingPlacement): void;
  dispose(): void;
}

export interface DockingOptions {
  host: HTMLElement;
  getState: () => Workspace;
  onSelect: (id: string) => void;
  onError: (message: string) => void;
  onPlacementChange?: (placement: DockingPlacement) => void;
}

type Diagnostic = {
  renderer: 'docking'; supported: true; panels: string[]; floating: string[]; active: string | null;
};

export async function installDockingRenderer(options: DockingOptions): Promise<DockingController | null> {
  // Only an explicit installation loads these styles, including refusal styling.
  // @ts-expect-error stylesheet import handled by the bundler
  await import('./docking.css');
  const reason = dockingUnsupportedReason(options.getState(), supportsConnectedMove());
  if (reason !== null) {
    const alert = document.createElement('div');
    alert.className = 'docking-unsupported';
    alert.dataset.dockingUnsupported = '';
    alert.setAttribute('role', 'alert');
    alert.textContent = reason;
    options.host.append(alert);
    document.documentElement.dataset.dockingRenderer = 'unsupported';
    Object.assign(window, { __orbitDocking: { renderer: 'docking', supported: false, reason } });
    options.onError(reason);
    return null;
  }

  // Dockview itself is never loaded on the default or unsupported path.
  const { createDockview } = await import('dockview-core');
  const root = document.createElement('div');
  root.className = 'docking-root';
  const toolbar = document.createElement('div');
  toolbar.className = 'docking-toolbar';
  toolbar.setAttribute('role', 'toolbar');
  toolbar.setAttribute('aria-label', 'Docking layout');
  const windowSelect = document.createElement('select');
  windowSelect.dataset.dockingSelect = 'window';
  windowSelect.setAttribute('aria-label', 'Docking window');
  const targetSelect = document.createElement('select');
  targetSelect.dataset.dockingSelect = 'target';
  targetSelect.setAttribute('aria-label', 'Docking target');
  toolbar.append(windowSelect, targetSelect);
  const commands = [
    ['select', 'Select window'], ['tab', 'Tab to target'], ['dock-left', 'Dock left'],
    ['dock-right', 'Dock right'], ['float', 'Float window'], ['return', 'Return to grid'],
  ] as const;
  for (const [command, label] of commands) {
    const button = document.createElement('button');
    button.type = 'button';
    button.dataset.dockingCommand = command;
    button.textContent = label;
    toolbar.append(button);
  }
  const status = document.createElement('output');
  status.dataset.dockingStatus = '';
  status.setAttribute('role', 'status');
  toolbar.append(status);
  const grid = document.createElement('div');
  grid.className = 'docking-grid';
  const surfaces = document.createElement('div');
  surfaces.className = 'docking-surfaces';
  root.append(toolbar, grid, surfaces);
  options.host.append(root);

  const placeholders = new Map<string, HTMLElement>();
  const dock = createDockview(grid, {
    createComponent: ({ id }) => {
      const element = document.createElement('div');
      element.className = 'docking-placeholder';
      element.dataset.dockingWindow = id;
      placeholders.set(id, element);
      return { element, init() {}, dispose() { if (placeholders.get(id) === element) placeholders.delete(id); } };
    },
  });
  let ids: string[] = [];
  let reconciling = false;
  // Dockview can emit a panel activation asynchronously after a programmatic
  // reconciliation or placement command. That activation is a placement side
  // effect, not the user choosing a window, so it must not write v1 selection.
  let activationSuppressed = false;
  let suppressPlacement = true;
  let lastEmittedPlacement: DockingPlacement | null = null;
  let suppressionGeneration = 0;
  function suppressChanges() {
    suppressPlacement = true;
    const generation = ++suppressionGeneration;
    requestAnimationFrame(() => requestAnimationFrame(() => {
      if (!disposed && generation === suppressionGeneration) {
        lastEmittedPlacement = dockviewToPlacement(dock.toJSON(), dock.activePanel?.id ?? null);
        suppressPlacement = false;
      }
    }));
  }
  function suppressActivation() {
    activationSuppressed = true;
    requestAnimationFrame(() => requestAnimationFrame(() => { activationSuppressed = false; }));
  }
  let disposed = false;
  let lastElements: Map<string, HTMLElement> | null = null;
  let lastMonitors: Monitor[] = [];
  let lastSelected = '';
  let lastFocused: string | null = null;
  let animation = 0;
  const diagnostic: Diagnostic = { renderer: 'docking', supported: true, panels: [], floating: [], active: null };
  document.documentElement.dataset.dockingRenderer = 'docking';
  Object.assign(window, { __orbitDocking: diagnostic });
  function refresh() {
    if (disposed) return;
    diagnostic.panels = dock.panels.map(p => p.id);
    diagnostic.floating = dock.panels.filter(p => p.api.location.type === 'floating').map(p => p.id);
    diagnostic.active = dock.activePanel?.id ?? null;
  }
  function emitPlacement() {
    if (!disposed && !suppressPlacement && options.onPlacementChange) {
      const placement = dockviewToPlacement(dock.toJSON(), dock.activePanel?.id ?? null);
      if (!placementEqual(placement, lastEmittedPlacement)) {
        lastEmittedPlacement = placement;
        options.onPlacementChange(placement);
      }
    }
  }
  // Dockview reports grid/sash changes separately from panel moves. Floating
  // dragging also emits an end event; read its final frame after the drag.
  const subscriptions = [
    dock.onDidActivePanelChange(({ panel }) => {
      refresh();
      if (!reconciling && !activationSuppressed && panel && ids.includes(panel.id)) options.onSelect(panel.id);
      emitPlacement();
    }),
    dock.onDidAddPanel(() => { refresh(); emitPlacement(); }),
    dock.onDidRemovePanel(() => { refresh(); emitPlacement(); }),
    dock.onDidMovePanel(() => { refresh(); emitPlacement(); }),
    dock.onDidLayoutChange(emitPlacement),
    dock.onDidMutateLayout(emitPlacement),
  ];

  function retainWindows(monitors: Monitor[], selected: string): void {
    if (disposed) return;
    const nextIds = monitors.map(m => m.id);
    if (nextIds.some(id => !id || nextIds.filter(other => other === id).length !== 1)) {
      options.onError('Docking requires unique, nonempty window ids.');
      return;
    }
    reconciling = true;
    suppressActivation();
    suppressChanges();
    try {
      const wanted = new Set(nextIds);
      for (const panel of dock.panels) if (!wanted.has(panel.id)) dock.removePanel(panel);
      for (const monitor of monitors) {
        const existing = dock.getPanel(monitor.id);
        if (existing) existing.api.setTitle(monitor.name);
        else dock.addPanel({
          id: monitor.id, component: 'orbit-window', title: monitor.name, renderer: 'always',
          ...(dock.panels.length ? { position: { referencePanel: dock.panels[dock.panels.length - 1], direction: 'right' as const } } : {}),
        });
      }
      // The v1 monitor list and docking adjunct have distinct responsibilities.
      // Reorder/add/remove must not dissolve surviving tabs or floating groups.
      ids = nextIds;
      if (dock.getPanel(selected)) dock.getPanel(selected)!.api.setActive();
      const previousTarget = targetSelect.value;
      windowSelect.replaceChildren(...monitors.map(m => new Option(m.name, m.id)));
      targetSelect.replaceChildren(...monitors.map(m => new Option(m.name, m.id)));
      windowSelect.value = wanted.has(selected) ? selected : nextIds[0] ?? '';
      targetSelect.value = previousTarget !== windowSelect.value && wanted.has(previousTarget)
        ? previousTarget : nextIds.find(id => id !== windowSelect.value) ?? windowSelect.value;
      refresh();
      layout();
    } finally { reconciling = false; }
  }

  function applyPlacement(placement: DockingPlacement): void {
    if (disposed) return;
    let pruned = ensurePlacementWindows(prunePlacement(placement, ids), ids);
    if (!ids.length) return;
    if (!pruned.layout && !pruned.floats.length) {
      // Empty/legacy checkpoints mean the default grid, not "keep whatever
      // transient tabs/floats happened to be on screen before restore".
      pruned = dockviewToPlacement({grid:{orientation:'HORIZONTAL',root:{type:'branch',data:ids.map(id=>({type:'leaf' as const,data:{id,views:[id]},size:1}))}}}, options.getState().selected);
    }
    reconciling = true;
    suppressActivation();
    suppressChanges();
    try {
      // The pure structural adapter deliberately has a broader type than
      // Dockview's runtime JSON, while producing its required fields.
      dock.fromJSON(placementToDockview(pruned, options.getState().monitors.map(m => ({ id: m.id, title: m.name }))) as Parameters<typeof dock.fromJSON>[0], { reuseExistingPanels: true });
      refresh();
      layout();
    } finally { reconciling = false; }
  }

  function placeWindows(elements: Map<string, HTMLElement>, monitors: Monitor[], selected: string, focused: string | null): void {
    if (disposed) return;
    lastElements = elements; lastMonitors = monitors; lastSelected = selected; lastFocused = focused;
    const bounds = surfaces.getBoundingClientRect();
    for (const monitor of monitors) {
      const id = monitor.id, element = elements.get(id), panel = dock.getPanel(id);
      if (!element || !panel || focused === id) continue;
      if (element.parentElement !== surfaces) moveConnected(element, surfaces);
      element.dataset.dockingSurface = id;
      const rect = placeholders.get(id)?.getBoundingClientRect();
      const visible = !!panel.api.isVisible && !!rect && rect.width > 0 && rect.height > 0;
      element.style.visibility = visible ? 'visible' : 'hidden';
      // Hidden tabs have zero-size placeholders: keep their last live geometry.
      if (visible && rect) {
        element.style.left = `${rect.left - bounds.left}px`;
        element.style.top = `${rect.top - bounds.top}px`;
        element.style.width = `${rect.width}px`;
        element.style.height = `${rect.height}px`;
        element.style.zIndex = panel.api.location.type === 'floating' ? '1000' : '2';
      }
    }
  }

  function placeCurrent() {
    if (lastElements && options.getState().view !== 'spatial' && options.host.offsetWidth > 0) {
      placeWindows(lastElements, lastMonitors, lastSelected, lastFocused);
    }
  }

  function layout(): void {
    if (disposed) return;
    root.style.setProperty('--docking-toolbar-height', `${toolbar.offsetHeight}px`);
    const width = grid.clientWidth, height = grid.clientHeight;
    if (width > 0 && height > 0) dock.layout(width, height);
    placeCurrent();
  }

  const observer = new ResizeObserver(layout);
  observer.observe(options.host);
  observer.observe(grid);
  const abort = new AbortController();
  // Dockview 8.3.1 does not expose floating-group drag/resize completion on
  // DockviewApi. Pointer release catches final frames even when release occurs
  // outside the grid; deduplication avoids re-saving toolbar/tab/sash events.
  let pointerStartedInDock = false;
  root.addEventListener('pointerdown', () => { pointerStartedInDock = true; }, { signal: abort.signal });
  window.addEventListener('pointerup', () => {
    if (!pointerStartedInDock) return;
    pointerStartedInDock = false;
    requestAnimationFrame(emitPlacement);
  }, { signal: abort.signal });
  window.addEventListener('pointercancel', () => { pointerStartedInDock = false; }, { signal: abort.signal });
  windowSelect.addEventListener('change', () => {
    if (targetSelect.value === windowSelect.value) targetSelect.value = ids.find(id => id !== windowSelect.value) ?? windowSelect.value;
  }, { signal: abort.signal });
  toolbar.addEventListener('click', event => {
    const button = (event.target as HTMLElement).closest<HTMLButtonElement>('button[data-docking-command]');
    if (!button || !toolbar.contains(button)) return;
    const command = button.dataset.dockingCommand;
    const id = windowSelect.value, target = targetSelect.value;
    const panel = dock.getPanel(id), targetPanel = dock.getPanel(target);
    let error: string | null = null;
    // Programmatic placement may activate a Dockview tab. Only an explicit
    // select or a user's tab activation should flow back into v1 selection.
    reconciling = true;
    suppressActivation();
    suppressChanges();
    try {
      if (!ids.includes(id) || !panel) error = 'Unknown docking window.';
      else if (command === 'tab' || command === 'dock-left' || command === 'dock-right') {
        if (!ids.includes(target) || !targetPanel) error = 'Unknown docking target.';
        else if (id === target) error = 'Choose distinct windows.';
        else panel.api.moveTo({ group: targetPanel.group, ...(command === 'tab' ? { index: 0 } : { position: command === 'dock-left' ? 'left' : 'right' }) });
      } else if (command === 'float') {
        if (panel.api.location.type === 'floating') error = 'Window is already floating.';
        else dock.addFloatingGroup(panel, { x: 32, y: 32, width: 600, height: 420 });
      } else if (command === 'return') {
        const firstDocked = dock.panels.find(p => p.id !== id && p.api.location.type !== 'floating');
        if (panel.api.location.type !== 'floating') error = 'Window is not floating.';
        else if (!firstDocked) error = 'No docked target window is available.';
        else panel.api.moveTo({ group: firstDocked.group, position: 'right' });
      } else if (command === 'select') options.onSelect(id);
      else error = 'Unknown docking command.';
    } catch (failure) {
      error = failure instanceof Error ? failure.message : String(failure);
    } finally { reconciling = false; }
    status.textContent = error ?? `${button.textContent} complete`;
    if (error) options.onError(error);
    refresh();
    layout();
    // The explicit toolbar action is the user edit. Async Dockview notifications
    // remain suppressed so they cannot echo this snapshot back as another save.
    if (!error && command !== 'select') {
      const placement = dockviewToPlacement(dock.toJSON(), dock.activePanel?.id ?? null);
      if (!placementEqual(placement, lastEmittedPlacement)) {
        lastEmittedPlacement = placement;
        options.onPlacementChange?.(placement);
      }
    }
    if (button.isConnected) button.focus({ preventScroll: true });
  }, { signal: abort.signal });
  function tick() {
    if (disposed) return;
    placeCurrent();
    refresh();
    animation = requestAnimationFrame(tick);
  }
  animation = requestAnimationFrame(tick);
  refresh();
  layout();

  return {
    surfaces, retainWindows, placeWindows, layout, applyPlacement,
    dispose() {
      if (disposed) return;
      disposed = true;
      observer.disconnect();
      cancelAnimationFrame(animation);
      abort.abort();
      for (const subscription of subscriptions) subscription.dispose();
      // Park any live children in a connected parent before deleting our root.
      for (const element of Array.from(surfaces.children)) {
        if (element instanceof HTMLElement && element.classList.contains('monitor')) {
          moveConnected(element, options.host);
          if (element.dataset.dockingSurface) delete element.dataset.dockingSurface;
          element.style.visibility = '';
        }
      }
      dock.dispose();
      root.remove();
      if (Reflect.get(window, '__orbitDocking') === diagnostic) Reflect.deleteProperty(window, '__orbitDocking');
      if (document.documentElement.dataset.dockingRenderer === 'docking') delete document.documentElement.dataset.dockingRenderer;
    },
  };
}
