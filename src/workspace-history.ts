import { el, button } from './dom';
import { workspaceId, ensureWorkspaceSynced } from './workspace-sync';
import { workspaceFetch } from './workspace-client';

type Checkpoint = { id: string; label: string; created: number; revision: number };
type Preview = {
  checkpoint: Checkpoint; base_revision: number; warning: string; truncated: boolean;
  changes: Array<{ target: string; kind: string; label: string; fields: string[] }>;
};

export function showHistory(token: () => string) {
  const dialog = el('dialog', 'hermes-tools-dialog');
  dialog.setAttribute('aria-label', 'Workspace checkpoints');
  const status = el('p'); status.setAttribute('role', 'status');
  const list = el('div'), detail = el('section');
  detail.setAttribute('aria-label', 'Checkpoint comparison'); detail.hidden = true;
  let generation = 0, preview: Preview | undefined, restoring = false;
  let restoreRequest: Record<string, unknown> | undefined;

  async function api(body: Record<string, unknown>) {
    const response = await workspaceFetch(token(), { workspace_id: workspaceId, ...body });
    const data = await response.json();
    if (!response.ok) throw Object.assign(Error(data.error || 'Checkpoint request failed'), { category: data.category });
    return data;
  }

  const restore = button('Restore this checkpoint', 'Restore previewed checkpoint', async () => {
    if (!preview || restoring) return;
    if (!restoreRequest && !window.confirm('Restore this previewed layout? Conversations, files, live processes and external effects are not restored. Removed panes may disconnect. A before-restore checkpoint will be saved.')) return;
    restoring = true; restore.disabled = true;
    restoreRequest ??= { action: 'restore', checkpoint_id: preview.checkpoint.id, base_revision: preview.base_revision, confirm: true, operation_id: crypto.randomUUID(), intent: 'Restore reviewed checkpoint' };
    try {
      await api(restoreRequest);
      if (!dialog.open) return;
      restoreRequest = undefined;
      status.textContent = 'Layout restored; connected workspace will synchronize.';
      await load();
    } catch (error) {
      if (!dialog.open) return;
      const uncertain = !!(error as { operation_id?: string }).operation_id;
      status.textContent = error instanceof Error ? error.message : String(error);
      if (uncertain) {
        restore.textContent = 'Retry exact restore';
      } else {
        preview = undefined; restoreRequest = undefined;
        status.textContent += ' Select the checkpoint again for a fresh comparison.';
      }
    } finally {
      restoring = false; restore.disabled = !preview;
    }
  });

  async function select(checkpoint: Checkpoint) {
    if (restoring || restoreRequest) return;
    const requested = ++generation;
    preview = undefined; restore.disabled = true; detail.hidden = false;
    detail.replaceChildren(el('p', '', 'Comparing against the current workspace…'));
    try {
      await ensureWorkspaceSynced();
      const current = await api({ action: 'read' });
      const result: Preview = await api({ action: 'checkpoint_preview', checkpoint_id: checkpoint.id, base_revision: current.revision });
      if (!dialog.open || requested !== generation) return;
      preview = result;
      const changes = el('ul');
      for (const change of result.changes) changes.append(el('li', '', `${change.kind === 'added' ? 'Add' : change.kind === 'removed' ? 'Remove' : 'Change'} ${change.target}: ${change.label}${change.fields.length ? ` — ${change.fields.join(', ')}` : ''}`));
      if (!result.changes.length) changes.append(el('li', '', 'No layout, appearance, plugin or docking changes.'));
      detail.replaceChildren(el('h3', '', checkpoint.label), el('p', '', `Saved revision ${checkpoint.revision} → compare against current revision ${result.base_revision}`), changes, el('p', '', result.warning));
      if (result.truncated) detail.append(el('p', '', 'This large comparison is abbreviated. Restore still affects the complete checkpoint.'));
      restore.textContent = 'Restore this checkpoint'; restore.disabled = false;
      detail.append(restore);
    } catch (error) {
      if (dialog.open && requested === generation) detail.replaceChildren(el('p', '', `${error instanceof Error ? error.message : String(error)}. Select the checkpoint again to retry.`));
    }
  }

  async function load() {
    const requested = ++generation;
    preview = undefined; restore.disabled = true; detail.hidden = true;
    try {
      await ensureWorkspaceSynced();
      const data = await api({ action: 'history' });
      if (!dialog.open || requested !== generation) return;
      list.replaceChildren();
      for (const checkpoint of data.checkpoints as Checkpoint[]) list.append(button(`${checkpoint.label} · ${new Date(checkpoint.created).toLocaleString()}`, `Preview checkpoint ${checkpoint.label}`, () => { void select(checkpoint); }));
      if (!data.checkpoints.length) list.textContent = 'No checkpoints yet.';
    } catch (error) { if (dialog.open && requested === generation) status.textContent = String(error); }
  }

  dialog.append(
    el('h2', '', 'Workspace checkpoints'),
    el('p', '', 'Compare saved windows, panes, appearance and plugins before restoring. Checkpoints do not snapshot conversations, files or live processes.'),
    button('Close', 'Close workspace checkpoints', () => dialog.close()),
    button('Save checkpoint', 'Save workspace checkpoint', async () => {
      if (restoring || restoreRequest) return;
      try {
        await ensureWorkspaceSynced();
        const current = await api({ action: 'read' });
        await api({ action: 'checkpoint', label: 'Manual checkpoint', base_revision: current.revision, intent: 'Save manual workspace checkpoint' });
        if (dialog.open) await load();
      } catch (error) { if (dialog.open) status.textContent = String(error); }
    }),
    button('Refresh', 'Refresh workspace checkpoints', () => { if (!restoring && !restoreRequest) void load(); }),
    status, list, detail,
  );
  dialog.addEventListener('close', () => { generation++; dialog.remove(); });
  document.body.append(dialog); dialog.showModal(); void load();
}
