import type { Workspace } from './model';
let id = '';
try { id = localStorage.getItem('orbit.workspace.id') || ''; } catch {}
if (!/^[a-f0-9-]{36}$/.test(id)) { id = crypto.randomUUID(); try { localStorage.setItem('orbit.workspace.id', id); } catch {} }
export const workspaceId = id;
let flush: (() => Promise<void>) | undefined;
export async function ensureWorkspaceSynced() { if (!flush) throw Error('Workspace connection is starting.'); await flush(); }

export function connectWorkspace(getState: () => Workspace, apply: (state: Workspace) => void, getToken: () => string, status: (message: string) => void) {
  let revision = 0, ready = false, changes = 0, sent = 0;
  let pending: Promise<void> | null = null;
  async function request(action: string) {
    const snapshot = changes;
    const response = await fetch('/api/workspace', { method: 'POST', headers: { Authorization: `Bearer ${getToken()}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ action, workspace_id: workspaceId, observed_revision: revision, base_revision: revision, ...(action === 'sync' ? { state: getState() } : {}) }), signal: AbortSignal.timeout(15000) });
    const data = await response.json();
    if (response.status === 404 && action === 'read') return request('sync');
    if (!response.ok && response.status !== 409) throw Error(data.error || 'Workspace sync failed');
    if (data.state) {
      const remote = !ready || response.status === 409 || (action === 'read' && data.revision > revision);
      revision = data.revision; ready = true;
      if (remote) {
        if (changes !== sent) { try { localStorage.setItem('orbit.workspace.conflict-backup', JSON.stringify(getState())); } catch {} }
        apply(data.state); sent = changes;
        status(response.status === 409 ? 'Workspace updated elsewhere; local backup saved' : 'Workspace connected');
      } else if (action === 'sync') sent = snapshot;
    }
  }
  async function sync() {
    if (!getToken()) throw Error('Connect host to enable workspace control.');
    if (pending) await pending;
    pending = request(!ready || changes === sent ? 'read' : 'sync');
    try { await pending; } finally { pending = null; }
  }
  flush = async () => { await sync(); if (changes !== sent) await sync(); };
  window.addEventListener('orbit-host-connected', () => { void sync().catch(e => status(e.message)); });
  const timer = setInterval(() => { if (getToken() && !pending) void sync().catch(e => status(e.message)); }, 1200);
  window.addEventListener('pagehide', () => clearInterval(timer), { once: true });
  return { changed: () => { changes++; }, sync };
}
