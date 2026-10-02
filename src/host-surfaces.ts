import { el } from './dom';
import './host-surfaces.css';

export type HostSurfaceId = 'outputs' | 'activity';
export const HOST_SURFACE_URLS = {
  outputs: 'orbit://surface/outputs',
  activity: 'orbit://surface/activity',
} as const;

/** Exact reviewed routes only: persisted URLs carry identity, never credentials. */
export function hostSurfaceId(url: string): HostSurfaceId | null {
  if (url === HOST_SURFACE_URLS.outputs) return 'outputs';
  if (url === HOST_SURFACE_URLS.activity) return 'activity';
  return null;
}

export function requestOpenHostSurface(id: HostSurfaceId) {
  window.dispatchEvent(new CustomEvent('orbit-open-host-surface', { detail: { id } }));
}

export function mountHostSurface(host: HTMLElement, id: HostSurfaceId, token: () => string): () => void {
  const root = el('section', 'host-surface');
  root.dataset.hostSurface = id;
  root.setAttribute('aria-label', id === 'outputs' ? 'Outputs' : 'Workspace Activity');
  root.append(el('p', '', 'Loading…'));
  host.append(root);
  let disposed = false;
  let cleanup = () => {};
  const ready = id === 'outputs'
    ? import('./hermes-surfaces').then(module => {
      if (disposed) return;
      root.replaceChildren();
      cleanup = module.mountShelf(root, token).dispose;
    })
    : import('./agent-activity').then(module => {
      if (disposed) return;
      root.replaceChildren();
      cleanup = module.mountAgentOverview(root);
    });
  void ready.catch(error => {
    if (!disposed) root.replaceChildren(el('p', '', error instanceof Error ? error.message : 'Surface unavailable'));
  });
  return () => {
    if (disposed) return;
    disposed = true;
    cleanup();
    root.remove();
  };
}
