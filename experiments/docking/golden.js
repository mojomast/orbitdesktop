// golden-layout@2.6.0: the published ESM entry is dist/esm/index.js.
// Its internal relative imports omit .js; the /vendor server must resolve those
// requests (or serve a bundled copy of this exact release).
import { VirtualLayout, LayoutConfig } from '/vendor/golden-layout/dist/esm/index.js';

export async function createAdapter(host, getSurface) {
  const ids = ['a', 'b', 'c'].filter(id => getSurface(id));
  if (!ids.includes('a') || !ids.includes('b')) throw new Error('Golden Layout requires surfaces a and b');

  const surfaces = new Map(ids.map(id => [id, getSurface(id)]));
  const previousStyles = new Map();
  for (const [id, surface] of surfaces) {
    if (!surface.isConnected) throw new Error(`Surface ${id} must already be connected`);
    previousStyles.set(surface, surface.getAttribute('style'));
    surface.style.position = 'fixed';
    surface.style.overflow = 'hidden';
    surface.style.pointerEvents = 'auto';
  }

  const bound = new Map();
  let disposed = false;
  // Application-owned virtual iframes are siblings of the layout chrome. Keep
  // splitter pointer events on the handle when crossing their document boundary,
  // including before Golden Layout's drag-distance threshold has been reached.
  // Pointer capture ends automatically on pointerup/pointercancel.
  const captureSplitterPointer = event => {
    if (event.isPrimary && event.target instanceof HTMLElement &&
        event.target.closest('.lm_splitter')) event.target.setPointerCapture(event.pointerId);
  };
  host.addEventListener('pointerdown', captureSplitterPointer);
  const layout = new VirtualLayout(host);
  layout.bindComponentEvent = (container, config) => {
    const id = config.componentState?.surfaceId;
    const surface = surfaces.get(id);
    if (!surface) throw new Error(`Unknown Golden Layout component: ${id}`);
    if (bound.has(id)) throw new Error(`Duplicate Golden Layout component: ${id}`);
    bound.set(id, container);
    container.virtualRectingRequiredEvent = (target, width, height) => {
      const rect = target.element.getBoundingClientRect();
      surface.style.left = `${rect.left}px`;
      surface.style.top = `${rect.top}px`;
      surface.style.width = `${width}px`;
      surface.style.height = `${height}px`;
    };
    container.virtualVisibilityChangeRequiredEvent = (_target, visible) => {
      surface.style.display = visible ? '' : 'none';
    };
    container.virtualZIndexChangeRequiredEvent = (_target, _logical, zIndex) => {
      surface.style.zIndex = zIndex;
    };
    return { component: surface, virtual: true };
  };
  layout.unbindComponentEvent = container => {
    const id = container.initialState?.surfaceId;
    if (bound.get(id) === container) bound.delete(id);
    // The application owns the connected surface and its iframe. Never remove it.
    const surface = surfaces.get(id);
    if (surface) surface.style.display = 'none';
  };

  const component = id => ({ type: 'component', componentType: 'orbit-surface', componentState: { surfaceId: id }, title: id });
  const initial = {
    root: {
      type: 'row',
      content: [
        { type: 'stack', content: [component('a'), component('b')] },
        { type: 'stack', content: ids.includes('c') ? [component('c')] : [] },
      ],
    },
    settings: { popoutWholeStack: false },
  };

  const item = id => {
    const container = bound.get(id);
    if (!container) throw new Error(`Golden Layout lost component ${id}`);
    return container.parent;
  };
  const stacks = () => {
    const row = layout.rootItem;
    if (!row?.isRow || row.contentItems.length !== 2 || !row.contentItems.every(child => child.isStack)) {
      throw new Error('Golden Layout row/stack topology changed unexpectedly');
    }
    return row.contentItems;
  };
  const transfer = (componentItem, target, index) => {
    const source = componentItem.parent;
    if (source === target) throw new Error('Transfer requires a different stack');
    // keepChild preserves the live component container; only GL-owned chrome moves.
    source.removeChild(componentItem, true);
    target.addChild(componentItem, index);
  };

  try {
    layout.loadLayout(initial);
    layout.updateSizeFromContainer();
  } catch (error) {
    host.removeEventListener('pointerdown', captureSplitterPointer);
    layout.destroy();
    for (const [surface, old] of previousStyles) {
      if (old === null) surface.removeAttribute('style');
      else surface.setAttribute('style', old);
    }
    throw error;
  }

  return {
    capabilities: [
      'select', 'reorder', ...(ids.includes('c') ? ['move', 'split'] : []),
      'resize', 'hide', 'show', 'saveLoad',
    ],
    async perform({ type, iteration = 0 }) {
      if (disposed) throw new Error('Golden Layout adapter was disposed');
      const [first, second] = stacks();
      switch (type) {
        case 'select': {
          const stack = item('a').parent;
          if (item('b').parent !== stack) transfer(item('b'), stack, stack.contentItems.length);
          const next = stack.getActiveComponentItem() === item('a') ? item('b') : item('a');
          stack.setActiveComponentItem(next, true);
          break;
        }
        case 'reorder': {
          const stack = item('a').parent;
          if (item('b').parent !== stack) transfer(item('b'), stack, stack.contentItems.length);
          const moving = item('b');
          const nextIndex = stack.contentItems.indexOf(moving) === 0 ? 1 : 0;
          stack.removeChild(moving, true);
          stack.addChild(moving, nextIndex);
          break;
        }
        case 'move': {
          if (!ids.includes('c')) throw new Error('Golden Layout move needs a populated destination stack (surface c)');
          const moving = item('b');
          transfer(moving, moving.parent === first ? second : first, 0);
          break;
        }
        case 'split': {
          if (!ids.includes('c')) throw new Error('Golden Layout split needs a populated destination stack (surface c)');
          // Separate the b tab into the adjacent GL stack, using its live item.
          if (item('b').parent === second) transfer(item('b'), first, first.contentItems.length);
          transfer(item('b'), second, 0);
          break;
        }
        case 'resize': {
          const container = bound.get('a');
          const targetWidth = Math.max(80, layout.width * (container.width < layout.width * 0.5 ? 0.57 : 0.43));
          if (!container.setSize(targetWidth, container.height)) throw new Error('Golden Layout could not resize');
          break;
        }
        case 'hide': {
          const container = bound.get('a');
          if (!container.visible) container.show();
          container.hide();
          break;
        }
        case 'show': {
          const container = bound.get('a');
          if (container.visible) container.hide();
          container.show();
          break;
        }
        case 'saveLoad': {
          const before = new Map([...surfaces].map(([id, surface]) => [id, surface.querySelector('iframe')?.contentDocument]));
          const config = LayoutConfig.fromResolved(layout.saveLayout());
          layout.loadLayout(config);
          for (const [id, surface] of surfaces) {
            if (!surface.isConnected || surface.querySelector('iframe')?.contentDocument !== before.get(id)) {
              throw new Error(`Golden Layout save/load broke iframe continuity: ${id}`);
            }
          }
          break;
        }
        default:
          throw new Error(`Golden Layout operation unsupported: ${type}`);
      }
    },
    async close(id) {
      if (disposed) throw new Error('Golden Layout adapter was disposed');
      const surface = surfaces.get(id);
      if (!surface) throw new Error(`Unknown surface ${id}`);
      item(id).remove();
      // Virtual components are application-owned: closing the GL component
      // requires the application to dispose its iframe separately.
      surface.remove();
      surfaces.delete(id);
    },
    async dispose() {
      if (disposed) return;
      disposed = true;
      host.removeEventListener('pointerdown', captureSplitterPointer);
      try {
        layout.destroy();
      } finally {
        bound.clear();
        // Disposal ends the fixture's runtime: detach the stable surfaces only
        // now, never during a docking transition or a save/load round trip.
        for (const surface of surfaces.values()) surface.remove();
      }
    },
  };
}
