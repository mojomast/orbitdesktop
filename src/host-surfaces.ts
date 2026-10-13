import { el } from './dom';
import './host-surfaces.css';
import { publishedDataInput } from './data-published-input';
import { workspaceId } from './workspace-sync';
import { TECHNOLOGY_SURFACES, mountTechnologySurface, type TechnologySurfaceId, type TechnologySurfaceOptions } from './technology-surfaces';

export type HostSurfaceId = 'outputs' | 'activity' | 'collab' | 'irc' | 'colab-runtime' | TechnologySurfaceId;
export const HOST_SURFACE_LABELS = {
  outputs:'Apps and outputs',activity:'Live activity',collab:'Collab',irc:'IRC','colab-runtime':'Google Colab',
  search:TECHNOLOGY_SURFACES.search.title,
  'interactive-results':TECHNOLOGY_SURFACES['interactive-results'].title,
  data:TECHNOLOGY_SURFACES.data.title,voice:TECHNOLOGY_SURFACES.voice.title,
  documents:TECHNOLOGY_SURFACES.documents.title,trace:TECHNOLOGY_SURFACES.trace.title,
  copilot:TECHNOLOGY_SURFACES.copilot.title,'mcp-apps':TECHNOLOGY_SURFACES['mcp-apps'].title,
} satisfies Record<HostSurfaceId,string>;
export const HOST_SURFACE_URLS = {
  outputs: 'orbit://surface/outputs',
  activity: 'orbit://surface/activity',
  collab: 'orbit://surface/collab',
  irc: 'orbit://surface/irc',
  'colab-runtime': 'orbit://surface/colab-runtime',
  search: 'orbit://surface/search',
  'interactive-results': 'orbit://surface/interactive-results',
  data: 'orbit://surface/data',
  voice: 'orbit://surface/voice',
  documents: 'orbit://surface/documents',
  trace: 'orbit://surface/traces',
  copilot: 'orbit://surface/browser-copilot',
  'mcp-apps': 'orbit://surface/mcp-apps',
} as const satisfies Record<HostSurfaceId,string>;

/** Exact reviewed routes only: persisted URLs carry identity, never credentials. */
export function hostSurfaceId(url: string): HostSurfaceId | null {
  if (publishedDataInput(url)) return 'data';
  for (const id of Object.keys(HOST_SURFACE_URLS) as HostSurfaceId[]) if(url===HOST_SURFACE_URLS[id]) return id;
  return null;
}

export function requestOpenHostSurface(id: HostSurfaceId) {
  window.dispatchEvent(new CustomEvent('orbit-open-host-surface', { detail: { id } }));
}

export function mountHostSurface(host: HTMLElement, id: HostSurfaceId, token: () => string, options:TechnologySurfaceOptions={}): () => void {
  const root = el('section', 'host-surface');
  root.dataset.hostSurface = id;
  root.setAttribute('aria-label', HOST_SURFACE_LABELS[id]);
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
    : id === 'activity' ? import('./agent-activity').then(module => {
      if (disposed) return;
      root.replaceChildren();
      cleanup = module.mountAgentOverview(root);
    }) : id === 'collab' ? import('./collab').then(module => {
      if (disposed) return;
      root.replaceChildren();
      const paneId = options.paneId || '';
      const view = module.mountCollab({
        standalone: true,
        onClose: () => {},
        request: async payload => {
          const response = await fetch('/api/agent', {
            method: 'POST',
            headers: { Authorization: `Bearer ${token()}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({
              action: 'collab',
              workspace_id: workspaceId,
              pane_id: paneId,
              session_id: `orbit-collab-${paneId || 'app'}`,
              profile_id: 'default',
              ...payload,
            }),
          });
          const data = await response.json().catch(() => ({}));
          if (!response.ok) throw Error(data.error || 'Collab request failed');
          return data;
        },
      });
      root.append(view.element);
      cleanup = () => view.dispose();
    }) : id === 'colab-runtime' ? import('./colab-orchestrator').then(module => {
      if (disposed) return;
      root.replaceChildren();
      const view = module.mountColab({
        token,
        request: async payload => {
          const response = await fetch('/api/colab-runtime', {
            method: 'POST',
            headers: { Authorization: `Bearer ${token()}`, 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
          });
          const data = await response.json().catch(() => ({}));
          if (!response.ok) throw Error(data.error || 'Colab request failed');
          return data;
        },
      });
      root.append(view.element);
      cleanup = () => view.dispose();
    }) : id === 'irc' ? import('./irc').then(module => {
      if (disposed) return;
      root.replaceChildren();
      const view = module.mountIrc({
        token,
        request: async payload => {
          const response = await fetch('/api/irc', {
            method: 'POST',
            headers: { Authorization: `Bearer ${token()}`, 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
          });
          const data = await response.json().catch(() => ({}));
          if (!response.ok) throw Error(data.error || 'IRC request failed');
          return data;
        },
      });
      root.append(view.element);
      cleanup = () => view.dispose();
    }) : Promise.resolve().then(()=>{
      if(disposed)return;
      root.replaceChildren();
      return mountTechnologySurface(root,id,token,options);
    }).then(mounted=>{
      if(!mounted)return;
      const dispose=typeof mounted==='function'?mounted:()=>mounted.dispose();
      if(disposed){dispose();return;}
      cleanup=dispose;
    });
  void ready.catch(error => {
    if (!disposed) root.replaceChildren(el('p', '', error instanceof Error ? error.message : 'Surface unavailable'));
  });
  return () => {
    if (disposed) return;
    disposed = true;
    try { cleanup(); } finally { root.remove(); }
  };
}
