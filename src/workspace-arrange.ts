import './workspace-arrange.css';
import { el, button, select } from './dom';
import { leaves, type Workspace } from './model';
import { workspaceFetch } from './workspace-client';
import { ensureWorkspaceSynced, workspaceId } from './workspace-sync';
import { arrangementOperations, requireFreshPreview, type ArrangeMode, type ArrangeViewport, type ArrangementPreview } from './workspace-arrange-plan';
import { parsePendingArrangement, pendingArrangementKey, storePendingArrangement, type PendingArrangement } from './workspace-arrange-pending';
import {clearRetainedCommand,clearRetainedEnvelope,retainedCommandMatches} from './saved-workspace-layouts-retention';

/** Existing-window layout only; independent of Workbench registration and recipes. */
export function showWorkspaceArrange(token: () => string, viewport: () => ArrangeViewport) {
  const existing = document.querySelector<HTMLDialogElement>('dialog.workspace-arrange');
  if (existing) { existing.focus(); return; }
  const d = el('dialog', 'workspace-arrange'); d.setAttribute('aria-label', 'Arrange workspace');
  const docking = document.documentElement.dataset.dockingRenderer === 'docking';
  const status = el('p', 'workspace-arrange-status'); status.setAttribute('role', 'status');
  const windows = el('div', 'workspace-arrange-windows'), summary = el('div', 'workspace-arrange-summary');
  const drawing = el('div', 'workspace-arrange-preview'); drawing.setAttribute('aria-label', 'Layout-only geometric preview');
  let state: Workspace | undefined, preview: ArrangementPreview | undefined, busy = false, uncertain = false, closed = false;
  let pending: PendingArrangement | undefined, blocked = false;
  try {
    const raw = sessionStorage.getItem(pendingArrangementKey(workspaceId));
    if (raw !== null) { uncertain = true; pending = parsePendingArrangement(raw, workspaceId); }
  } catch { blocked = true; uncertain = true; }
  let mode: ArrangeMode = docking ? 'focus' : 'grid';
  const chosen = new Set<string>();
  const modeSelect = select([['grid', 'Grid'], ['focus', docking ? 'Focus (select existing window)' : 'Focus'], ['compare', 'Compare']], mode, value => {
    mode = value as ArrangeMode; invalidate();
  }); modeSelect.setAttribute('aria-label', 'Arrangement');
  const columns = el('input'); columns.type = 'number'; columns.min = '1'; columns.step = '1'; columns.value = '2'; columns.setAttribute('aria-label', 'Grid columns');
  columns.addEventListener('input', () => invalidate());
  const previewButton = button('Preview', 'Preview workspace arrangement', () => void stage());
  const applyButton = button('Apply preview', 'Apply exact workspace arrangement preview', () => void commit());
  const refreshButton = button('Refresh windows', 'Refresh existing windows', () => void load());
  const closeButton = button('Close', 'Close workspace arrangement', () => d.close());
  const pendingDiscardButton = button('Read state and discard retained command', 'Read authoritative state before discarding retained arrangement', () => void discardPending());
  const discardButton = button('Discard preview', 'Discard workspace arrangement preview', () => { invalidate(); status.textContent = 'Preview discarded.'; });
  function controls() {
    previewButton.disabled = busy || uncertain || !state;
    refreshButton.disabled = busy; discardButton.disabled = busy || uncertain || !preview;
    pendingDiscardButton.hidden = !uncertain; pendingDiscardButton.disabled = busy;
    applyButton.disabled = busy || blocked || (!pending && !preview);
    applyButton.textContent = uncertain ? 'Retry exact apply' : 'Apply preview';
    modeSelect.disabled = busy || uncertain; columns.disabled = busy || uncertain || mode !== 'grid';
    for (const input of Array.from(windows.querySelectorAll('input'))) input.disabled = busy || uncertain;
  }
  function invalidate(message?: string) {
    if (uncertain) return;
    preview = undefined; summary.replaceChildren(); drawing.replaceChildren(); controls();
    if (message) status.textContent = message;
  }
  async function api(body: Record<string, unknown>, endpoint = '/api/workspace') {
    const response = await workspaceFetch(token(), { workspace_id: workspaceId, ...body }, endpoint);
    let data;
    try { data = await response.json(); } catch { throw Object.assign(Error('Response unreadable; apply outcome may be unknown.'), { unknown: true }); }
    if (!response.ok) throw Object.assign(Error(data.error || 'Workspace request failed'), { definitive: response.status < 500 });
    return data;
  }
  async function read() { await ensureWorkspaceSynced(); return api({ action: 'read' }); }
  function renderWindows() {
    windows.replaceChildren();
    for (const m of state!.monitors) {
      const label = el('label'), checkbox = el('input'); checkbox.type = 'checkbox'; checkbox.value = m.id;
      checkbox.checked = chosen.has(m.id); checkbox.setAttribute('aria-label', `Arrange ${m.name}`);
      checkbox.onchange = () => { checkbox.checked ? chosen.add(m.id) : chosen.delete(m.id); invalidate(); };
      label.append(checkbox, document.createTextNode(`${m.name} · ${leaves(m.layout).length} pane(s)`)); windows.append(label);
    }
  }
  async function load() {
    if (busy) return;
    busy = true; invalidate(); controls();
    try {
      const current = await read(); state = current.state;
      if (closed) return;
      const ids = new Set(state!.monitors.map(m => m.id));
      for (const id of chosen) if (!ids.has(id)) chosen.delete(id);
      if (!chosen.size) for (const m of state!.monitors) if (!docking || m.id === state!.selected) chosen.add(m.id);
      columns.max = String(state!.monitors.length); columns.value = String(Math.min(Number(columns.value), state!.monitors.length));
      renderWindows(); status.textContent = uncertain
        ? `Saved workspace revision ${current.revision}. ${pending ? `Unresolved operation ${pending.operation_id} (base ${pending.base_revision}). Retry sends the exact retained command.` : 'Retained command is unreadable or tab storage is unavailable; retry is blocked.'} Reading state does not prove the command outcome. Close or Escape is available; new arrangements remain blocked until resolution or explicit discard.`
        : 'Choose existing windows, then preview. IDs and pane contents are retained.';
    } catch (error) { status.textContent = String(error); }
    finally { busy = false; controls(); }
  }
  function clearPending(command:PendingArrangement) {
    if (!clearRetainedCommand(sessionStorage,pendingArrangementKey(workspaceId),command)) throw Error('Retained command was removed or replaced. Current storage was left intact; reopen to inspect it.');
    pending = undefined; blocked = false; uncertain = false;
  }
  async function discardPending() {
    if (busy || !uncertain) return;
    busy = true; controls();
    try {
      const retained=sessionStorage.getItem(pendingArrangementKey(workspaceId));
      if(pending&&!retainedCommandMatches(retained,pending))throw Error('Retained command changed; reopen before discarding');
      const current = await read();
      if(closed)return;
      state = current.state; renderWindows();
      if (!window.confirm(`Saved workspace revision ${current.revision} was read. Discard the retained retry command? This does not roll back any applied layout and does not establish whether the earlier command committed. An in-flight request may still finish. Inspect saved windows before making a new arrangement.`)) return;
      if(!clearRetainedEnvelope(sessionStorage,pendingArrangementKey(workspaceId),retained))throw Error('Retained command changed during the state read; nothing was discarded.');
      pending=undefined;blocked=false;uncertain=false;
      invalidate(); status.textContent = 'Retained retry command discarded after reading saved state. No layout was rolled back.';
    } catch (error) { status.textContent = `${String(error)} Retained command remains blocked; you can close this dialog.`; }
    finally { busy = false; controls(); }
  }
  async function stage() {
    if (busy || uncertain) return;
    busy = true; invalidate(); controls();
    try {
      const current = await read(); state = current.state; renderWindows();
      if (closed) return;
      const size = viewport(), measured = { width: Math.floor(size.width), height: Math.floor(size.height) };
      const ids = state!.monitors.filter(m => chosen.has(m.id)).map(m => m.id);
      const dockGrid = docking && mode !== 'focus';
      const ops = dockGrid ? [] : arrangementOperations(state!, ids, mode, Number(columns.value), measured, docking);
      const result = dockGrid
        ? await api({action:'arrange_preview',base_revision:current.revision,window_ids:ids,mode,columns:Number(columns.value),viewport:measured},'/api/workspace-layouts')
        : await api({ action: 'layout_preview', base_revision: current.revision, operations: ops });
      if (closed) return;
      preview = { before: current.state, state: result.state, base_revision: result.base_revision, viewport: measured, ops,
        ...(dockGrid ? {savedLayout:result.layout} : {}),
        intent: `Arrange existing workspace windows: ${mode}`, operation_id: crypto.randomUUID() };
      requireFreshPreview(preview, current, viewport());
      summary.append(el('p', '', `${docking ? 'Select' : 'Arrange'} ${ids.length} existing window(s): ${ids.map(id => state!.monitors.find(m => m.id === id)!.name).join(', ')}.`),
        el('p', '', `${dockGrid ? 'Selected windows receive docked grid placement and geometry in one atomic commit. Unselected placement is retained.' : docking ? 'Docking placement is retained.' : 'Switch to Windows view; update selected window frames. Unselected frames are retained and may overlap.'} All pane IDs, kinds, URLs and split contents are retained.`),
        el('p', '', `Base revision ${preview.base_revision} · desktop ${measured.width} × ${measured.height}. Layout-only preview, not a rendered app or terminal preview.`));
      if (!docking) {
        drawing.style.aspectRatio = `${measured.width} / ${measured.height}`;
        for (const m of preview.state.monitors.filter(m => ids.includes(m.id))) {
          const f = m.frame!; const tile = el('div', 'workspace-arrange-tile', m.name);
          Object.assign(tile.style, { left: `${f.x / measured.width * 100}%`, top: `${f.y / measured.height * 100}%`, width: `${f.width / measured.width * 100}%`, height: `${f.height / measured.height * 100}%` }); drawing.append(tile);
        }
      }
      status.textContent = 'Preview validated. Review the layout before applying.';
    } catch (error) { invalidate(); status.textContent = String(error); }
    finally { busy = false; controls(); }
  }
  async function commit() {
    if (busy || blocked || (!preview && !pending)) return;
    busy = true; controls(); let sent = false;
    try {
      if (!uncertain) {
        requireFreshPreview(preview!, await read(), viewport());
        if (closed) return;
        const command: PendingArrangement = preview!.savedLayout
          ? {action:'apply',workspace_id:workspaceId,base_revision:preview!.base_revision,layout:preview!.savedLayout,viewport:preview!.viewport,replacements:{},operation_id:preview!.operation_id,intent:preview!.intent}
          : { action: 'layout_apply', workspace_id: workspaceId, base_revision: preview!.base_revision,
            operations: preview!.ops, operation_id: preview!.operation_id, intent: preview!.intent };
        try { storePendingArrangement(sessionStorage, command); }
        catch (error) { blocked = true; uncertain = true; throw error; }
        pending = command;
      }
      sent = true;
      const command=structuredClone(pending!);
      const result = await api(command as unknown as Record<string, unknown>,command.action==='apply'?'/api/workspace-layouts':'/api/workspace');
      clearPending(command); invalidate();
      status.textContent = `Saved revision ${result.revision}. Waiting for workspace synchronization.`;
      await ensureWorkspaceSynced();
      // First read installs remote state; the next sync acknowledges that revision.
      await ensureWorkspaceSynced();
      const observed = await api({ action: 'read' });
      status.textContent = `Saved revision ${result.revision}. ${observed.observed_revision >= result.revision ? 'Browser acknowledged state; inspect your windows.' : 'Browser acknowledgement pending.'}`;
      state = observed.state; renderWindows();
    } catch (error) {
      if (sent && pending) {
        uncertain = true;
        preview = undefined; summary.replaceChildren(); drawing.replaceChildren();
        status.textContent = `Apply outcome unknown or unresolved: ${String(error)}. Retry uses the same operation ID and payload (${pending.operation_id}), retained in this tab across reopen/reload. You can close this dialog. New arrangements remain blocked until resolved or explicitly discarded after reading saved state.`;
      } else {
        invalidate(); status.textContent = `${String(error)} ${uncertain ? 'Retained command remains blocked; read saved state before discarding.' : 'Refresh and preview again.'}`;
      }
    } finally { busy = false; controls(); }
  }
  const timer = setInterval(() => {
    if (!preview || busy || uncertain) return;
    const size = viewport();
    if (Math.floor(size.width) !== preview.viewport.width || Math.floor(size.height) !== preview.viewport.height)
      invalidate('Desktop size changed. Preview again before applying.');
  }, 300);
  d.append(el('h2', '', 'Arrange workspace'), el('p', '', 'Reuse your current windows and panes. Preview first, then apply under a workspace revision check.'),
    ...(docking ? [el('p', '', 'Docking Grid and Compare preview geometry and placement together; Focus selects an existing window.')] : []),
    el('label', '', 'Arrangement'), modeSelect, el('label', '', 'Grid columns'), columns, windows,
    previewButton, applyButton, discardButton, refreshButton, pendingDiscardButton, closeButton, status, summary, drawing);
  d.addEventListener('close', () => { closed = true; clearInterval(timer); d.remove(); });
  controls(); document.body.append(d); d.showModal(); void load();
}
