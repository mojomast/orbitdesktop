// Isolated dockview-core@8.3.1 adapter. The packaged browser ESM entry is
// dist/package/main.esm.mjs (there is no dist/dockview-core.js in 8.3.1).
// CSS is loaded by the experiment harness.
import { createDockview } from '/vendor/dockview-core/dist/package/main.esm.mjs';

export class UnsupportedError extends Error {
  constructor(operation) {
    super(`dockview-core adapter does not support ${operation}`);
    this.name = 'UnsupportedError';
  }
}

export async function createAdapter(host, getSurface) {
  if (!host?.isConnected) throw new Error('Dockview host must be connected');

  const surfaces = new Map();
  for (const id of ['a', 'b']) {
    const surface = getSurface(id);
    if (!(surface instanceof HTMLElement) || !surface.isConnected) {
      throw new Error(`Missing connected surface ${id}`);
    }
    surfaces.set(id, surface);
  }
  // c is optional; the basic operation matrix only requires a and b.
  let optionalSurface;
  try { optionalSurface = getSurface('c'); } catch { /* optional */ }
  if (optionalSurface instanceof HTMLElement && optionalSurface.isConnected) {
    surfaces.set('c', optionalSurface);
  }

  const rendererCreations = new Map();
  const dockview = createDockview(host, {
    createComponent: ({ id }) => {
      const surface = surfaces.get(id);
      if (!surface) throw new Error(`Unexpected dockview panel ${id}`);
      rendererCreations.set(id, (rendererCreations.get(id) || 0) + 1);
      // The renderer owns the supplied element; never clone an iframe or
      // substitute a new DOM node when dockview re-renders a panel.
      return { element: surface, init() {}, dispose() {} };
    },
  });

  const layout = () => {
    const width = host.clientWidth;
    const height = host.clientHeight;
    if (width > 0 && height > 0) dockview.layout(width, height);
  };
  const a = dockview.addPanel({ id: 'a', title: 'A', component: 'surface', renderer: 'always' });
  dockview.addPanel({ id: 'b', title: 'B', component: 'surface', renderer: 'always', position: { referencePanel: a, direction: 'within' } });
  if (surfaces.has('c')) {
    dockview.addPanel({ id: 'c', title: 'C', component: 'surface', renderer: 'always', position: { referencePanel: a, direction: 'right' } });
  }
  layout();

  let disposed = false;
  let reorderAtEnd = false;
  let splitRight = false;
  let resizeLarge = false;
  let floating = false;
  let movedAway = false;

  const panel = (id) => {
    const result = dockview.getPanel(id);
    if (!result) throw new Error(`Panel ${id} has been closed`);
    return result;
  };

  // Explicit library moves set up the requested geometry if a previous matrix
  // operation left it in a different configuration. b always stays in the grid.
  const shareTabs = () => {
    const first = panel('a');
    const second = panel('b');
    if (first.group !== second.group) first.api.moveTo({ group: second.group, index: 0 });
  };
  const separate = () => {
    const first = panel('a');
    const second = panel('b');
    if (first.group === second.group || first.api.location.type !== 'grid') {
      first.api.moveTo({ group: second.group, position: 'right' });
    }
  };

  const capabilities = ['select', 'reorder', 'move', 'split', 'float', 'resize', 'saveLoad'];

  return {
    capabilities,
    async perform({ type, iteration = 0 }) {
      if (disposed) throw new Error('Dockview adapter disposed');
      const first = panel('a');
      const second = panel('b');
      switch (type) {
        case 'select': {
          // Toggle from the actual selected tab, not merely the iteration number.
          const selected = dockview.activePanel?.api.id === 'a' ? 'b' : 'a';
          panel(selected).api.setActive();
          return { selected };
        }
        case 'reorder': {
          shareTabs();
          // Destination index differs on each invocation, including after a
          // prior move/split. This is dockview's tab move API, not DOM sorting.
          const group = panel('b').group;
          reorderAtEnd = group.panels[0]?.api.id === 'a';
          panel('a').api.moveTo({ group, index: reorderAtEnd ? group.panels.length - 1 : 0 });
          return { order: group.panels.map((item) => item.api.id) };
        }
        case 'move': {
          // Alternate an inter-group move and a move back into b's tab group.
          // c, if supplied, gives a persistent second group; otherwise the
          // first move creates a split with dockview's API.
          if (first.group === second.group) {
            if (dockview.getPanel('c')?.api.location.type === 'grid') {
              first.api.moveTo({ group: panel('c').group, index: 0 });
            } else {
              first.api.moveTo({ group: second.group, position: 'left' });
            }
            movedAway = true;
          } else {
            first.api.moveTo({ group: second.group, index: 0 });
            movedAway = false;
          }
          return { group: panel('a').group.api.id, movedAway };
        }
        case 'split': {
          // Splitting relative to b makes a real new grid group even if a was
          // previously floating or in another grid group.
          splitRight = !splitRight;
          first.api.moveTo({ group: second.group, position: splitRight ? 'right' : 'left' });
          return { group: panel('a').group.api.id, side: splitRight ? 'right' : 'left' };
        }
        case 'float': {
          if (first.api.location.type === 'floating') {
            first.api.moveTo({ group: second.group, position: 'left' });
            floating = false;
          } else {
            dockview.addFloatingGroup(first, {
              x: 32 + (iteration % 4) * 12,
              y: 32 + (iteration % 4) * 12,
              width: Math.max(180, Math.round(host.clientWidth * 0.4)),
              height: Math.max(140, Math.round(host.clientHeight * 0.5)),
            });
            floating = true;
          }
          return { location: panel('a').api.location.type, floating };
        }
        case 'resize': {
          separate();
          layout();
          resizeLarge = !resizeLarge;
          const width = Math.max(120, Math.round(host.clientWidth * (resizeLarge ? 0.55 : 0.35)));
          panel('a').group.api.setSize({ width });
          return { requestedWidth: width, actualWidth: panel('a').group.api.width };
        }
        case 'saveLoad': {
          const before = new Map(rendererCreations);
          const panelObjects = new Map([...surfaces.keys()].map((id) => [id, dockview.getPanel(id)]));
          const saved = dockview.toJSON();
          // v8.3.1 supports reuseExistingPanels; without it fromJSON destroys
          // and creates panels. Report any renderer recreation, rather than
          // treating matching panel IDs as proof of iframe continuity.
          dockview.fromJSON(saved, { reuseExistingPanels: true });
          layout();
          const recreatedRenderers = [...surfaces.keys()].filter((id) => (rendererCreations.get(id) || 0) !== (before.get(id) || 0));
          const replacedPanels = [...surfaces.keys()].filter((id) => dockview.getPanel(id) !== panelObjects.get(id));
          return { recreatedRenderers, replacedPanels };
        }
        default:
          throw new UnsupportedError(type);
      }
    },
    async close(id) {
      if (disposed) throw new Error('Dockview adapter disposed');
      panel(id).api.close();
      surfaces.delete(id);
    },
    async dispose() {
      if (disposed) return;
      disposed = true;
      dockview.dispose();
    },
  };
}
