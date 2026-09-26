import { applyAppearance } from './workspace-appearance';
import type { Workspace } from './model';
import { workspaceFetch } from './workspace-client';
import { connectWorkspaceEvents } from './workspace-events';
import type { DockingPlacement } from './docking-placement';
let id = '';
try { id = localStorage.getItem('orbit.workspace.id') || ''; } catch {}
if (!/^[a-f0-9-]{36}$/.test(id)) { id = crypto.randomUUID(); try { localStorage.setItem('orbit.workspace.id', id); } catch {} }
export const workspaceId = id;
let flush: (() => Promise<void>) | undefined;
export async function ensureWorkspaceSynced() { if (!flush) throw Error('Workspace connection is starting.'); await flush(); }

export function connectWorkspace(getState: () => Workspace, apply: (state: Workspace) => void, getToken: () => string, status: (message: string) => void,
  placementSink?: { onRemote?(placement: DockingPlacement, placementRevision: number): void }) {
  let revision = 0, ready = false, changes = 0, sent = 0, uncertain = false;
  let lastPlacementRevision: number | undefined;
  let placementPending: Promise<unknown> = Promise.resolve();
  let pending: Promise<void> | null = null;
  let appVersions: Record<string, number> = {};
  let backupSaved = false;
  function holdLocalChanges() {
    uncertain = true;
    backupSaved = false;
    try {localStorage.setItem('orbit.workspace.conflict-backup',JSON.stringify(getState()));backupSaved=true;}catch {}
  }
  async function request(action: string) {
    const snapshot = changes;
    let response: Response;
    try {
      response = await workspaceFetch(getToken(), { action, workspace_id: workspaceId, observed_revision: revision, ...(action === 'sync' ? { base_revision: revision, state: getState(), intent: 'Synchronize browser workspace changes' } : {}) });
    } catch (error) {
      if (action === 'sync') holdLocalChanges();
      throw error;
    }
    let data: any;
    try { data = await response.json(); }
    catch (error) { if (action === 'sync') holdLocalChanges(); throw error; }
    if (response.status === 404 && action === 'read') return request('sync');
    if (response.status === 409 && (!data.state || !Number.isSafeInteger(data.revision))) {
      // Policy errors do not contain a replacement layout. Never treat them as
      // successful saves or repeatedly submit the rejected local snapshot.
      if(action === 'sync') {
        holdLocalChanges();
      }
      ready = false; // next poll reads authoritative state, never retries mutation
      throw Error(data.category === 'RECOVERY_HOLD' || data.category === 'RECOVERY_POLICY_CHANGED'
        ? `Recovery policy blocked this change. ${backupSaved?'Local backup saved':'Local backup unavailable'}; reading saved state next.`
        : data.error || 'Workspace conflict; reading saved state before further changes.');
    }
    if (!response.ok && response.status !== 409) {
      if (action === 'sync' && response.status >= 500) holdLocalChanges();
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
    const remote = !ready || response.status === 409 || (action === 'read' && data.revision > revision);
    if (data.state) {
      revision = data.revision; ready = true;
      if (remote) {
        let backupNote='';
        if (changes !== sent) {holdLocalChanges();backupNote=backupSaved?'; local backup saved':'; local backup unavailable';}
        apply(data.state); applyAppearance(data.state); sent = changes; uncertain = false;
        status((data.recovery_policy?.held ? 'Workspace connected · registered-plugin recovery hold active' : response.status === 409 ? 'Workspace updated elsewhere' : 'Workspace connected')+backupNote);
      } else if (action === 'sync') sent = snapshot;
      else if(uncertain)status(`Previous save outcome unresolved; local changes are held. ${backupSaved?'Local backup saved.':'Local backup unavailable; keep this page open.'} Inspect saved state before reconnecting.`);
    }
    if (data.placement !== undefined && (remote || data.placement_revision !== lastPlacementRevision)) {
      lastPlacementRevision = data.placement_revision ?? 0;
      placementSink?.onRemote?.(data.placement, lastPlacementRevision ?? 0);
    }
  }
  async function sync() {
    if (!getToken()) throw Error('Connect host to enable workspace control.');
    await placementPending;
    if (pending) await pending;
    pending = request(!ready || changes === sent || uncertain ? 'read' : 'sync');
    try { await pending; } finally { pending = null; }
  }
  flush = async () => {
    await sync(); if (changes !== sent) await sync();
    if(uncertain || changes !== sent)throw Error('Workspace save is unresolved; dependent actions are blocked. Inspect saved state before reconnecting.');
  };
  function savePlacement(placement: DockingPlacement): Promise<{ conflict?: boolean; ok?: boolean; placement_revision?: number }> {
    const task = placementPending.then(async () => {
      if (pending) await pending;
      if (!getToken() || !ready || uncertain) return { ok: false };
      // A pending v1 layout edit must be committed (and acknowledged) before a
      // placement save uses its base revision; otherwise the placement would be
      // stranded until the next unrelated edit. This flush must not await
      // placementPending (we are inside that chain) to avoid a deadlock.
      if (changes !== sent) {
        const flushing = request('sync');
        pending = flushing;
        try { await flushing; } catch { return { ok: false }; }
        finally { if (pending === flushing) pending = null; }
      }
      if (changes !== sent || !ready || uncertain) return { ok: false };
      try {
        const response = await workspaceFetch(getToken(), { action: 'placement_save', workspace_id: workspaceId,
          base_revision: revision, placement, operation_id: crypto.randomUUID(), intent: 'Save docking placement' });
        if (response.status === 409) {
          try { await request('read'); } catch { status('Docking placement conflict; authoritative reload unavailable'); }
          return { conflict: true };
        }
        if (!response.ok) return { ok: false };
        const data = await response.json();
        if (!Number.isSafeInteger(data.revision) || !Number.isSafeInteger(data.placement_revision)) return { ok: false };
        revision = data.revision; ready = true;
        lastPlacementRevision = data.placement_revision;
        return data;
      } catch { return { ok: false }; }
    }).catch(() => ({ ok: false }));
    // A concurrently awaited layout read can fail before the placement request
    // starts. Keep the serialization tail fulfilled so reconnect/polling and
    // later placement saves are not permanently poisoned by that rejection.
    placementPending = task;
    return task;
  }
  window.addEventListener('orbit-host-connected', () => { void sync().catch(e => status(e.message)); });
  window.addEventListener('keydown', event => {
    if (event.ctrlKey && event.altKey && event.code === 'KeyP') {
      event.preventDefault();
      if (!document.querySelector('dialog[aria-label="Workspace plugins"]')) void import('./plugin-manager').then(m => m.showPlugins(getToken)).catch(e => status(String(e)));
    }
  });
  const startPolling=()=>setInterval(() => { if (getToken() && !pending) void sync().catch(e => status(e.message)); }, 1200);
  let timer = startPolling(), suspended=false;
  // Events are advisory invalidation, not replacement state or acknowledgement.
  // Coalesce a page into one read, and keep ordinary polling as compatibility fallback.
  let eventRefresh: ReturnType<typeof setTimeout> | undefined;
  const refreshFromEvents=()=>{
    if(eventRefresh!==undefined)return;
    eventRefresh=setTimeout(()=>{eventRefresh=undefined;if(getToken()&&!pending)void sync().catch(e=>status(e.message));},0);
  };
  const startEvents=()=>connectWorkspaceEvents({workspaceId,getToken,onChange:event=>{if(event.payload.revision>revision)refreshFromEvents();},onReset:refreshFromEvents});
  let events=startEvents();
  window.addEventListener('pagehide', () => {suspended=true;clearInterval(timer);if(eventRefresh!==undefined)clearTimeout(eventRefresh);eventRefresh=undefined;events.close();});
  window.addEventListener('pageshow', () => {
    if(!suspended)return;
    suspended=false;ready=false;timer=startPolling();events=startEvents();refreshFromEvents();
  });
  return { changed: () => { changes++; }, sync, savePlacement };
}
