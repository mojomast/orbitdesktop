import { el, button } from './dom';
import { workspaceId, ensureWorkspaceSynced } from './workspace-sync';
import { requestConversationContext } from './conversation-transfer';
import {
  filterOutputItems,
  joinOutputItem,
  outputReferenceText,
  sanitizeShelfEntries,
  shelfItemId,
  OUTPUT_LIBRARY_LIMITS,
  type MetadataRecord,
  type OutputFilter,
  type OutputItem,
  type OutputKindFilter,
  type ShelfEntry,
} from './output-library-helpers';
import './output-library.css';

interface ApiResult { ok: boolean; status: number; data: Record<string, unknown>; }

const FILTER_KEY = 'orbit-output-library-filters';

function readFilters(): Required<Pick<OutputFilter, 'query' | 'kind' | 'pinnedOnly'>> {
  try {
    const raw = JSON.parse(localStorage.getItem(FILTER_KEY) || 'null') as Record<string, unknown> | null;
    const kind = raw?.kind === 'app/report' || raw?.kind === 'output' ? raw.kind : 'all';
    return {
      query: typeof raw?.query === 'string' ? raw.query.slice(0, 200) : '',
      kind: kind as OutputKindFilter,
      pinnedOnly: raw?.pinnedOnly === true,
    };
  } catch { return { query: '', kind: 'all', pinnedOnly: false }; }
}

function writeFilters(filter: OutputFilter) {
  try {
    localStorage.setItem(FILTER_KEY, JSON.stringify({ query: filter.query ?? '', kind: filter.kind ?? 'all', pinnedOnly: filter.pinnedOnly === true }));
  } catch { /* Storage is optional. */ }
}

// The conversation transfer helper (src/conversation-transfer.ts, owned by the
// context-handoff round) opens a host dialog and returns an async outcome. This
// view never sends automatically and never inspects raw file contents.

export interface OutputLibraryView { ready: Promise<void>; dispose: () => void; }

export function mountOutputLibrary(host: HTMLElement, token: () => string, heading = true): OutputLibraryView {
  const root = el('section', 'outputs-view');
  const note = el('p', 'outputs-note', 'Only deliberately published app folders and files are indexed.');
  const status = el('p', 'outputs-status', '');
  status.setAttribute('role', 'status');
  const controls = el('div', 'outputs-controls');
  const list = el('div', 'outputs-list');
  const provenance = el('p', 'outputs-provenance', 'Source conversation and task links are not recorded for these published files.');
  if (heading) root.append(el('h2', '', 'Published apps and outputs'));
  root.append(note, controls, list, provenance, status);
  host.append(root);

  const lifetime = new AbortController();
  let request: AbortController | undefined;
  let disposed = false;
  let entries: ShelfEntry[] = [];
  let metadata: Record<string, MetadataRecord> = {};
  let metadataRevision = 0;
  let metadataAvailable = true;
  const filters = readFilters();
  const previews = new Set<HTMLDialogElement>();
  const dialogs = new Set<HTMLDialogElement>();

  const search = el('input', 'outputs-search') as HTMLInputElement;
  search.type = 'search';
  search.placeholder = 'Search published outputs';
  search.setAttribute('aria-label', 'Search published outputs');
  search.value = filters.query ?? '';
  search.maxLength = 200;
  const kindSelect = el('select', 'outputs-kind') as HTMLSelectElement;
  kindSelect.setAttribute('aria-label', 'Filter by output type');
  for (const [value, label] of [['all', 'All types'], ['app/report', 'Apps and reports'], ['output', 'Output files']] as [string, string][]) {
    const option = el('option', '', label); option.value = value; kindSelect.append(option);
  }
  kindSelect.value = filters.kind ?? 'all';
  const pinnedToggle = el('input', 'outputs-pinned') as HTMLInputElement;
  pinnedToggle.type = 'checkbox';
  pinnedToggle.id = `outputs-pinned-${Math.random().toString(36).slice(2, 8)}`;
  pinnedToggle.checked = filters.pinnedOnly === true;
  const pinnedLabel = el('label', 'outputs-pinned-label', 'Pinned only');
  pinnedLabel.append(pinnedToggle);
  const refresh = button('Refresh', 'Refresh published outputs', () => { void load(); }, 'small-button');
  controls.append(search, kindSelect, pinnedLabel, refresh);

  search.addEventListener('input', () => { filters.query = search.value; writeFilters(filters); render(); });
  kindSelect.addEventListener('change', () => { filters.kind = kindSelect.value as OutputKindFilter; writeFilters(filters); render(); });
  pinnedToggle.addEventListener('change', () => { filters.pinnedOnly = pinnedToggle.checked; writeFilters(filters); render(); });

  const api = async (path: string, body: Record<string, unknown>, signal: AbortSignal): Promise<ApiResult> => {
    const response = await fetch(path, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token()}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      // A bounded network timeout so a stalled host never leaves a dialog or the
      // view waiting indefinitely. Disposal still aborts through the caller signal.
      signal: AbortSignal.any([signal, AbortSignal.timeout(15000)]),
    });
    let data: Record<string, unknown> = {};
    try { data = await response.json(); } catch { data = {}; }
    return { ok: response.ok, status: response.status, data };
  };

  function currentItems(): OutputItem[] {
    const items: OutputItem[] = [];
    for (const entry of entries) {
      const item = joinOutputItem(entry, metadata[shelfIdOf(entry)]);
      if (item) items.push(item);
    }
    items.sort((a, b) => (Number(b.pinned) - Number(a.pinned)) || a.display_title.localeCompare(b.display_title));
    return items;
  }

  function shelfIdOf(entry: ShelfEntry): string {
    // The helper derives the same id the server uses; entries are pre-validated.
    return shelfItemId(entry.url) ?? '';
  }

  function render() {
    list.replaceChildren();
    const all = currentItems();
    const visible = filterOutputItems(all, filters);
    const pinned = all.filter(item => item.pinned).length;
    const tags = new Set(all.flatMap(item => item.tags));
    status.textContent = `${all.length} published item${all.length === 1 ? '' : 's'}${pinned ? ` · ${pinned} pinned` : ''}${tags.size ? ` · ${tags.size} tag${tags.size === 1 ? '' : 's'}` : ''}${visible.length !== all.length ? ` · showing ${visible.length}` : ''}${metadataAvailable ? '' : ' · owner metadata unavailable'}`;
    if (!all.length) {
      list.append(el('p', 'outputs-empty', 'No published outputs yet.'));
      return;
    }
    if (!visible.length) {
      list.append(el('p', 'outputs-empty', 'No published outputs match the current filter.'));
      return;
    }
    for (const item of visible) list.append(itemRow(item));
  }

  function itemRow(item: OutputItem): HTMLElement {
    const row = el('div', 'output-item');
    row.dataset.itemId = item.item_id;
    row.dataset.pinned = String(item.pinned);
    const head = el('div', 'output-item-head');
    const title = el('strong', 'output-item-title', item.display_title);
    head.append(title, el('span', 'output-item-kind', item.kind === 'app/report' ? 'App/report' : 'Output'));
    if (item.pinned) head.append(el('span', 'output-item-pin', 'Pinned'));
    row.append(head);
    if (item.alias && item.alias !== item.title) row.append(el('span', 'output-item-original', item.title));
    if (item.tags.length) {
      const tagRow = el('div', 'output-item-tags');
      for (const tag of item.tags) tagRow.append(el('span', 'output-item-tag', tag));
      row.append(tagRow);
    }
    const actions = el('div', 'output-item-actions');
    actions.append(
      button('Preview', `Preview ${item.display_title}`, () => openPreview(item), 'small-button'),
      button(item.pinned ? 'Unpin' : 'Pin', `${item.pinned ? 'Unpin' : 'Pin'} ${item.display_title}`, () => void togglePin(item), 'small-button'),
      button('Rename', `Rename ${item.display_title}`, () => openRename(item), 'small-button'),
      button('Tags', `Edit tags for ${item.display_title}`, () => openTags(item), 'small-button'),
      button('Send to conversation', `Add a reference to ${item.display_title} in the conversation draft`, () => sendToConversation(item), 'small-button'),
    );
    row.append(actions);
    return row;
  }

  function openPreview(item: OutputItem) {
    const dialog = el('dialog', 'hermes-tools-dialog') as HTMLDialogElement;
    dialog.setAttribute('aria-label', item.display_title);
    dialog.style.width = 'min(1000px, 94vw)';
    dialog.append(el('h2', '', item.display_title), button('Close', `Close ${item.display_title}`, () => dialog.close()));
    const frame = el('iframe');
    frame.title = item.display_title;
    frame.setAttribute('sandbox', 'allow-scripts allow-forms allow-downloads');
    frame.src = item.url;
    frame.style.cssText = 'width:100%;height:65vh;border:0;background:white';
    dialog.append(frame, el('p', 'outputs-provenance', 'Untrusted published content in a sandboxed frame. No host credential or bridge is provided.'));
    const link = el('a', '', 'Download file');
    link.href = item.url;
    link.download = '';
    dialog.append(link);
    dialog.addEventListener('close', () => { previews.delete(dialog); dialog.remove(); });
    previews.add(dialog);
    document.body.append(dialog);
    dialog.showModal();
  }

  async function persist(item: OutputItem, patch: Record<string, unknown>): Promise<{ ok: boolean; conflict: boolean; message: string }> {
    if (!metadataAvailable) return { ok: false, conflict: false, message: 'Owner metadata is unavailable on this host.' };
    if (disposed) return { ok: false, conflict: false, message: '' };
    try {
      const result = await api('/api/output-library', {
        action: 'set',
        workspace_id: workspaceId,
        url: item.url,
        base_revision: metadataRevision,
        patch,
      }, lifetime.signal);
      if (disposed) return { ok: false, conflict: false, message: '' };
      if (result.status === 409) {
        if (Number.isSafeInteger(result.data.revision)) metadataRevision = result.data.revision as number;
        metadata = (result.data.items && typeof result.data.items === 'object') ? result.data.items as Record<string, MetadataRecord> : metadata;
        render();
        return { ok: false, conflict: true, message: typeof result.data.error === 'string' ? result.data.error : 'Metadata changed; review the current values and retry.' };
      }
      if (!result.ok) throw Error(typeof result.data.error === 'string' ? result.data.error : `Metadata update failed (${result.status}).`);
      if (Number.isSafeInteger(result.data.revision)) metadataRevision = result.data.revision as number;
      if (result.data.items && typeof result.data.items === 'object') metadata = result.data.items as Record<string, MetadataRecord>;
      render();
      return { ok: true, conflict: false, message: 'Saved.' };
    } catch (error) {
      if (disposed) return { ok: false, conflict: false, message: '' };
      return { ok: false, conflict: false, message: error instanceof Error ? error.message : 'Metadata update failed.' };
    }
  }

  async function togglePin(item: OutputItem) {
    const result = await persist(item, { pinned: !item.pinned });
    if (!disposed && !result.ok && result.message) status.textContent = result.message;
  }

  function metadataDialog(title: string, fields: HTMLElement[], submitLabel: string, submit: (setMessage: (text: string) => void, close: () => void) => Promise<void>) {
    const dialog = el('dialog', 'hermes-tools-dialog') as HTMLDialogElement;
    dialog.setAttribute('aria-label', title);
    const message = el('p', 'outputs-status', '');
    message.setAttribute('role', 'status');
    const form = el('form');
    let busy = false;
    const commit = button(submitLabel, submitLabel, () => {}); commit.type = 'submit';
    const cancel = button('Cancel', `Cancel ${title}`, () => { if (!busy) dialog.close(); });
    const settable = fields.filter(field => 'disabled' in field) as (HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement)[];
    function setBusy(next: boolean) {
      busy = next;
      commit.disabled = next;
      // Cancel stays enabled; every other edit control is disabled during submit.
      for (const field of settable) field.disabled = next;
    }
    form.append(el('h2', '', title), ...fields, message, commit, cancel);
    form.onsubmit = event => {
      event.preventDefault();
      if (busy || disposed) return;
      setBusy(true);
      void submit(
        text => { if (!disposed) message.textContent = text; },
        () => { if (!disposed) dialog.close(); },
      ).finally(() => { if (!disposed && dialog.open) setBusy(false); });
    };
    dialog.append(form);
    dialogs.add(dialog);
    dialog.addEventListener('close', () => { dialogs.delete(dialog); dialog.remove(); }, { once: true });
    document.body.append(dialog);
    dialog.showModal();
    fields[0]?.focus();
  }

  function openRename(item: OutputItem) {
    const input = el('input') as HTMLInputElement;
    input.maxLength = OUTPUT_LIBRARY_LIMITS.maxAliasLength;
    input.value = item.alias ?? '';
    input.placeholder = item.title;
    input.setAttribute('aria-label', 'Display alias');
    metadataDialog(`Rename ${item.display_title}`, [
      el('p', '', 'This changes only the owner-visible display alias. The published file and its URL are never renamed.'),
      input,
    ], 'Save alias', async (setMessage, close) => {
      const alias = input.value.trim();
      const result = await persist(item, { alias: alias || null });
      if (result.ok) { close(); return; }
      // Keep the draft on conflict so the owner can compare and retry.
      setMessage(result.conflict ? `${result.message} Your draft is kept; press Save again to apply it to the current revision.` : result.message);
      input.focus();
    });
  }

  function openTags(item: OutputItem) {
    const input = el('input') as HTMLInputElement;
    input.value = item.tags.join(', ');
    input.setAttribute('aria-label', 'Tags, comma separated');
    metadataDialog(`Tags for ${item.display_title}`, [
      el('p', '', `Comma-separated, up to ${OUTPUT_LIBRARY_LIMITS.maxTagsPerItem} tags of ${OUTPUT_LIBRARY_LIMITS.maxTagLength} characters.`),
      input,
    ], 'Save tags', async (setMessage, close) => {
      const tags = input.value.split(',').map(value => value.trim()).filter(Boolean);
      const result = await persist(item, { tags });
      if (result.ok) { close(); return; }
      setMessage(result.conflict ? `${result.message} Your draft is kept; press Save again to apply it to the current revision.` : result.message);
      input.focus();
    });
  }

  function sendToConversation(item: OutputItem) {
    status.textContent = 'Choose a conversation for this reference…';
    void (async () => {
      try {
        const outcome = await requestConversationContext({
          text: outputReferenceText(item),
          title: item.display_title,
          source: 'outputs',
        });
        if (disposed) return;
        switch (outcome.status) {
          case 'delivered':
            status.textContent = 'Reference inserted into the conversation draft. Nothing is sent automatically.';
            break;
          case 'cancelled':
            status.textContent = 'Reference not inserted (cancelled).';
            break;
          case 'no-recipient':
            status.textContent = 'Reference not inserted: no conversation is available to receive it.';
            break;
          case 'empty':
            status.textContent = 'Nothing to add to the conversation.';
            break;
          case 'busy':
            status.textContent = 'Another transfer dialog is open; finish it and try again.';
            break;
          case 'rejected':
          case 'stale':
            status.textContent = `Reference not inserted: ${outcome.reason || 'the conversation is no longer available'}.`;
            break;
        }
      } catch {
        if (!disposed) status.textContent = 'Reference could not be prepared for the conversation.';
      }
    })();
  }

  async function load() {
    request?.abort();
    const current = new AbortController();
    request = current;
    if (!token()) {
      note.textContent = 'Connect host to view published outputs.';
      entries = [];
      render();
      return;
    }
    note.textContent = 'Only deliberately published app folders and files are indexed. Owner aliases, pins and tags never change the published files.';
    try {
      await ensureWorkspaceSynced();
      if (disposed || current.signal.aborted) return;
      const shelf = await api('/api/workspace', { action: 'shelf', workspace_id: workspaceId }, current.signal);
      if (disposed || current.signal.aborted) return;
      if (!shelf.ok) throw Error(typeof shelf.data.error === 'string' ? shelf.data.error : 'Shelf unavailable.');
      entries = sanitizeShelfEntries(shelf.data.items);
      // Owner metadata is a separate, best-effort read: the shelf remains usable
      // if the metadata store is unavailable on an older host.
      try {
        const result = await api('/api/output-library', { action: 'list', workspace_id: workspaceId }, current.signal);
        if (disposed || current.signal.aborted) return;
        if (result.ok && result.data.items && typeof result.data.items === 'object' && !Array.isArray(result.data.items)) {
          metadata = result.data.items as Record<string, MetadataRecord>;
          metadataRevision = Number.isSafeInteger(result.data.revision) ? result.data.revision as number : 0;
          metadataAvailable = true;
        } else {
          metadata = {};
          metadataRevision = 0;
          metadataAvailable = false;
        }
      } catch (error) {
        if (disposed || current.signal.aborted) return;
        metadata = {};
        metadataRevision = 0;
        metadataAvailable = false;
      }
      render();
    } catch (error) {
      if (disposed || current.signal.aborted) return;
      entries = [];
      list.replaceChildren();
      note.textContent = error instanceof Error ? error.message : 'Shelf unavailable';
    }
  }

  window.addEventListener('orbit-host-connected', () => { void load(); }, { signal: lifetime.signal });
  const ready = load();
  return {
    ready,
    dispose() {
      if (disposed) return;
      disposed = true;
      lifetime.abort();
      request?.abort();
      for (const preview of previews) preview.close();
      previews.clear();
      for (const dialog of dialogs) dialog.close();
      dialogs.clear();
      root.remove();
    },
  };
}
