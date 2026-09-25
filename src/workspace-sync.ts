import { applyAppearance } from './workspace-appearance';
import type { Workspace } from './model';
import { workspaceFetch } from './workspace-client';
let id = '';
try { id = localStorage.getItem('orbit.workspace.id') || ''; } catch {}
if (!/^[a-f0-9-]{36}$/.test(id)) { id = crypto.randomUUID(); try { localStorage.setItem('orbit.workspace.id', id); } catch {} }
export const workspaceId = id;
let flush: (() => Promise<void>) | undefined;
export async function ensureWorkspaceSynced() { if (!flush) throw Error('Workspace connection is starting.'); await flush(); }

export function connectWorkspace(getState: () => Workspace, apply: (state: Workspace) => void, getToken: () => string, status: (message: string) => void) {
  let revision = 0, ready = false, changes = 0, sent = 0, uncertain = false;
  let pending: Promise<void> | null = null;
  let appVersions: Record<string, number> = {};
  async function request(action: string) {
    const snapshot = changes;
    let response: Response;
    try {
      response = await workspaceFetch(getToken(), { action, workspace_id: workspaceId, observed_revision: revision, ...(action === 'sync' ? { base_revision: revision, state: getState(), intent: 'Synchronize browser workspace changes' } : {}) });
    } catch (error) {
      if (action === 'sync') {uncertain = true;try {localStorage.setItem('orbit.workspace.conflict-backup',JSON.stringify(getState()));}catch {}}
      throw error;
    }
    let data: any;
    try { data = await response.json(); }
    catch (error) { if (action === 'sync') uncertain = true; throw error; }
    if (response.status === 404 && action === 'read') return request('sync');
    if (!response.ok && response.status !== 409) {
      if (action === 'sync' && response.status >= 500) uncertain = true;
      throw Error(data.error || 'Workspace sync failed');
    }
    if (data.app_versions) {
      for (const frame of Array.from(document.querySelectorAll<HTMLIFrameElement>('iframe[src]'))) {
        const url = new URL(frame.src, location.href);
        const slug = url.pathname.match(/^\/apps\/([a-z0-9-]+)\//)?.[1];
        if (url.origin !== location.origin || !slug) continue;
        if (appVersions[slug] !== undefined && data.app_versions[slug] !== undefined && appVersions[slug] !== data.app_versions[slug]) {
          url.searchParams.set('orbit_revision', String(data.app_versions[slug])); frame.src = url.href;
        }
      }
      appVersions = data.app_versions;
    }
    if (data.state) {
      const remote = !ready || response.status === 409 || (action === 'read' && data.revision > revision);
      revision = data.revision; ready = true;
      if (remote) {
        if (changes !== sent) { try { localStorage.setItem('orbit.workspace.conflict-backup', JSON.stringify(getState())); } catch {} }
        apply(data.state); applyAppearance(data.state); sent = changes; uncertain = false;
        status(response.status === 409 ? 'Workspace updated elsewhere; local backup saved' : 'Workspace connected');
      } else if (action === 'sync') sent = snapshot;
      else if(uncertain)status('Previous save outcome unresolved; local changes are held and backed up. Inspect saved state before reconnecting.');
    }
  }
  async function sync() {
    if (!getToken()) throw Error('Connect host to enable workspace control.');
    if (pending) await pending;
    pending = request(!ready || changes === sent || uncertain ? 'read' : 'sync');
    try { await pending; } finally { pending = null; }
  }
  flush = async () => { await sync(); if (changes !== sent) await sync(); };
  window.addEventListener('orbit-host-connected', () => { void sync().catch(e => status(e.message)); });
  window.addEventListener('keydown', event => {
    if (event.ctrlKey && event.altKey && event.code === 'KeyP') {
      event.preventDefault();
      if (!document.querySelector('dialog[aria-label="Workspace plugins"]')) void import('./plugin-manager').then(m => m.showPlugins(getToken)).catch(e => status(String(e)));
    }
  });
  const timer = setInterval(() => { if (getToken() && !pending) void sync().catch(e => status(e.message)); }, 1200);
  window.addEventListener('pagehide', () => clearInterval(timer), { once: true });
  return { changed: () => { changes++; }, sync };
}
