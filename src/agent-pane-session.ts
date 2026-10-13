import { el, button } from './dom';
import { dateGroup, groupHistory, matchesHistoryQuery, providerSwitchNote, type HistoryRow } from './agent-session-model';

type Profile = { id: string; label: string; configured: boolean; provider?: string };
type Meter = { used?: number; window?: number; level?: string; source?: string; model?: string; tools?: boolean; provider?: string; hermes_compression?: { detail?: string } | null };
type Preview = { messages?: { role: string; text: string }[]; resumable?: boolean; note?: string; provider?: string };

export function mountAgentPaneSession({
  api,
  library,
  profiles,
  state,
  providerOf,
  switchConversation,
  acceptState,
  showError,
}: {
  api: (payload: Record<string, unknown>, passive?: boolean) => Promise<Record<string, unknown>>;
  library: (profileId: string, body: Record<string, unknown>) => Promise<Record<string, unknown>>;
  profiles: () => Profile[];
  state: () => { session: string; profile_id?: string; title?: string; run?: string; binding_revision?: number };
  providerOf: (id: string) => 'grok' | 'hermes';
  switchConversation: (profileId: string, sessionId?: string) => Promise<void>;
  acceptState: (next: { session: string; messages: { role: 'user' | 'assistant'; text: string }[] }) => void;
  showError: (error: unknown) => void;
}) {
  const header = el('span', 'agent-provider');
  const health = el('span', 'agent-provider-health');
  health.setAttribute('aria-hidden', 'true');
  const select = el('select');
  select.setAttribute('aria-label', 'Provider');
  const tools = el('span', 'agent-tools-badge', 'Tools');
  const meter = el('span', 'agent-context-meter');
  meter.setAttribute('role', 'meter');
  meter.setAttribute('aria-label', 'Context usage');
  meter.setAttribute('aria-valuemin', '0');
  const compact = button('Compact', 'Compact this session after confirmation', () => { void compactSession(); }, 'small-button');
  const historyToggle = button('History', 'Show previous sessions', () => {
    sidecar.hidden = !sidecar.hidden;
    historyToggle.setAttribute('aria-expanded', String(!sidecar.hidden));
    if (!sidecar.hidden) void loadHistory();
  }, 'small-button');
  historyToggle.setAttribute('aria-expanded', 'false');
  header.append(health, select, tools, meter, compact, historyToggle);

  const banner = el('p', 'agent-context-banner');
  banner.hidden = true;
  const notes = el('div', 'agent-switch-notes');
  const sidecar = el('aside', 'agent-history');
  sidecar.hidden = true;
  sidecar.setAttribute('aria-label', 'Chat history');
  const search = el('input');
  search.type = 'search';
  search.placeholder = 'Search titles or sessions';
  search.setAttribute('aria-label', 'Search chat history');
  const filter = el('select');
  filter.setAttribute('aria-label', 'History provider filter');
  for (const [value, label] of [['provider', 'This provider'], ['both', 'Both providers']] as const) {
    const option = el('option', '', label);
    option.value = value;
    filter.append(option);
  }
  const status = el('p', 'agent-history-status');
  status.setAttribute('role', 'status');
  const list = el('div', 'agent-history-list');
  sidecar.append(el('strong', '', 'History'), search, filter, status, list);
  let rows: HistoryRow[] = [];
  let meterState: Meter = {};
  let syncing = false;
  const memoryKey = 'orbit.agent-provider-memory';

  function memory() {
    try { return JSON.parse(sessionStorage.getItem(memoryKey) || '{}') as Record<string, string>; }
    catch { return {}; }
  }
  function remember(profileId: string, sessionId: string) {
    const saved = memory();
    saved[profileId] = sessionId;
    try { sessionStorage.setItem(memoryKey, JSON.stringify(saved)); } catch { /* private browsing */ }
  }
  function option(value: string, label: string, disabled = false) {
    const node = el('option', '', label);
    node.value = value;
    node.disabled = disabled;
    return node;
  }
  function currentProfile() {
    const id = state().profile_id || 'default';
    return profiles().find(profile => profile.id === id);
  }
  function paintMeter(data: Meter) {
    meterState = data;
    const used = Number(data.used) || 0;
    const limit = Number(data.window) || 0;
    const level = data.level === 'hot' || data.level === 'warn' ? data.level : 'ok';
    meter.dataset.level = level;
    meter.setAttribute('aria-valuemax', String(limit || 1));
    meter.setAttribute('aria-valuenow', String(Math.min(used, limit || used)));
    const source = data.source === 'reported' ? 'reported' : '≈ estimated';
    const model = data.model ? `${data.model} · ` : '';
    meter.textContent = limit ? `${model}${used} / ${limit} ${source}` : 'Context unavailable';
    tools.hidden = data.tools === false;
    banner.hidden = level !== 'hot';
    if (level === 'hot') banner.textContent = data.provider === 'grok'
      ? 'Context is about 80% of the window (estimate). Compact starts a fresh Grok Bot agent seeded with a summary.'
      : 'Context is about 80% of the window. Hermes already keeps the first 3 turns and the last 20 messages; Compact only runs Hermes compression when that command is available.';
  }
  async function refreshMeter() {
    try {
      const data = await api({ action: 'context_meter' }, true) as Meter;
      paintMeter(data);
    } catch {
      meter.textContent = 'Context unavailable';
      meter.dataset.level = 'ok';
    }
  }
  function renderHistory() {
    const visible = rows.filter(row => matchesHistoryQuery(row, search.value));
    const grouped = groupHistory(visible);
    list.replaceChildren();
    const paint = (label: string, items: HistoryRow[]) => {
      if (!items.length) return;
      const group = el('section', 'agent-history-group');
      group.append(el('h3', '', label));
      for (const row of items) {
        const line = el('div', 'agent-history-row');
        const title = row.title || row.upstream_title || row.session_id;
        const when = row.updated_at ? dateGroup(row.updated_at) : '';
        line.append(el('span', '', `${title}`), el('small', '', `${row.profile_id}${when ? ` · ${when}` : ''}`));
        line.append(button('Open', 'Resume this session', () => { void openRow(row); }, 'small-button'));
        line.append(button('View', 'Read this transcript without switching', () => { void viewRow(row); }, 'small-button'));
        group.append(line);
      }
      list.append(group);
    };
    paint('Pinned', grouped.pinned);
    for (const group of grouped.groups) paint(group.label, group.rows);
    if (!list.childElementCount) list.append(el('p', '', 'No matching sessions.'));
  }
  async function loadHistory() {
    status.textContent = 'Loading sessions…';
    const selected = filter.value === 'both' ? profiles().filter(profile => profile.configured) : profiles().filter(profile => profile.id === (state().profile_id || 'default'));
    const loaded: HistoryRow[] = [];
    try {
      for (const profile of selected) {
        const data = await library(profile.id, { action: 'conversation_library', offset: 0 });
        const conversations = Array.isArray(data.conversations) ? data.conversations : [];
        for (const row of conversations) {
          if (!row || typeof row.session_id !== 'string') continue;
          loaded.push({ ...row, provider: profile.provider || 'hermes' });
        }
        if (data.has_more === true) status.textContent = 'Showing the first page. Older sessions stay on the server.';
      }
      rows = loaded;
      if (!status.textContent.startsWith('Showing')) status.textContent = `${loaded.length} sessions loaded.`;
      renderHistory();
    } catch (error) {
      status.textContent = error instanceof Error ? error.message : 'History unavailable.';
    }
  }
  async function openRow(row: HistoryRow) {
    const preview = await api({ action: 'session_preview', target_profile_id: row.profile_id, target_session_id: row.session_id }, true) as Preview;
    if (preview.resumable === false) {
      status.textContent = preview.note || 'This session cannot be resumed. Use View for the saved text.';
      return;
    }
    remember(state().profile_id || 'default', state().session);
    await switchConversation(row.profile_id, row.session_id);
    remember(row.profile_id, state().session);
  }
  async function viewRow(row: HistoryRow) {
    try {
      const preview = await api({ action: 'session_preview', target_profile_id: row.profile_id, target_session_id: row.session_id }, true) as Preview;
      const dialog = el('dialog', 'hermes-tools-dialog');
      dialog.setAttribute('aria-label', 'Session transcript');
      const body = el('div', 'agent-history-preview');
      const messages = Array.isArray(preview.messages) ? preview.messages : [];
      if (!messages.length) body.append(el('p', '', preview.note || 'No transcript text is available.'));
      for (const message of messages) body.append(el('p', '', `${message.role}: ${message.text}`));
      const resume = button('Resume', 'Open this session in the pane', () => { dialog.close(); void openRow(row); }, 'small-button');
      resume.disabled = preview.resumable === false;
      dialog.append(el('h2', '', row.title || row.upstream_title || row.session_id), body, resume, button('Close', 'Close transcript', () => dialog.close(), 'small-button'));
      dialog.addEventListener('close', () => dialog.remove());
      document.body.append(dialog);
      dialog.showModal();
    } catch (error) { showError(error); }
  }
  function confirmCompact() {
    const dialog = el('dialog', 'hermes-tools-dialog');
    dialog.setAttribute('aria-label', 'Confirm compact');
    const provider = providerOf(state().profile_id || 'default');
    const copy = provider === 'grok'
      ? 'Compact summarizes this Grok Bot conversation and continues in a new agent. The previous session stays in History.'
      : 'Compact asks Hermes for its compression command. If that command is not available, Orbit leaves the session in place because Hermes already keeps the first 3 turns and the last 20 messages.';
    let agreed = false;
    const yes = button('Compact', 'Compact this session', () => { agreed = true; dialog.close(); }, 'small-button');
    dialog.append(el('h2', '', 'Compact session'), el('p', '', copy), yes, button('Cancel', 'Do not compact', () => dialog.close(), 'small-button'));
    dialog.addEventListener('close', () => dialog.remove());
    document.body.append(dialog);
    dialog.showModal();
    return new Promise<boolean>(resolve => dialog.addEventListener('close', () => resolve(agreed)));
  }
  async function compactSession() {
    if (state().run) { showError(Error('Wait for the current run to finish before compacting.')); return; }
    if (!await confirmCompact()) return;
    const previousWindow = Number(meterState.window) || 0;
    try {
      const result = await api({ action: 'compact_session', confirm: true }) as { state?: { session: string; messages: { role: 'user' | 'assistant'; text: string }[] }; note?: string; summary?: string };
      if (result.state) acceptState(result.state);
      const note = el('p', 'agent-switch-note', result.note || result.summary || 'Compact finished.');
      notes.append(note);
      status.textContent = result.note || 'Compact finished.';
      await refreshMeter();
      if (previousWindow && Number(meterState.window) && Number(meterState.window) < previousWindow) banner.hidden = false;
    } catch (error) { showError(error); }
  }
  select.onchange = () => {
    if (syncing) return;
    const next = select.value;
    const current = state();
    const previousId = current.profile_id || 'default';
    if (next === previousId) return;
    const from = profiles().find(profile => profile.id === previousId);
    const to = profiles().find(profile => profile.id === next);
    remember(previousId, current.session);
    const remembered = memory()[next];
    const fromWindow = Number(meterState.window) || 0;
    void switchConversation(next, remembered || undefined).then(() => {
      const now = state();
      if ((now.profile_id || 'default') !== next) { sync(); return; }
      remember(next, now.session);
      const note = providerSwitchNote(from?.label || previousId, to?.label || next, fromWindow, Number(meterState.window) || fromWindow);
      notes.append(el('p', 'agent-switch-note', note.text));
      if (note.suggestCompact) { banner.hidden = false; banner.textContent = note.text; }
      void refreshMeter();
    });
  };
  search.oninput = renderHistory;
  filter.onchange = () => { void loadHistory(); };
  function sync() {
    syncing = true;
    const listProfiles = profiles();
    const hermes = listProfiles.filter(profile => providerOf(profile.id) !== 'grok');
    const grok = listProfiles.filter(profile => providerOf(profile.id) === 'grok');
    select.replaceChildren();
    const add = (label: string, items: Profile[]) => {
      if (!items.length) return;
      const group = document.createElement('optgroup');
      group.label = label;
      for (const profile of items) {
        const window = providerOf(profile.id) === 'grok' ? '128k' : '128k';
        group.append(option(profile.id, `${profile.label}${profile.configured ? '' : ' (unconfigured)'} · ${window}`, !profile.configured));
      }
      select.append(group);
    };
    add('Hermes', hermes);
    add('Grok Bot', grok);
    const id = state().profile_id || 'default';
    if (!listProfiles.some(profile => profile.id === id)) select.append(option(id, id));
    select.value = id;
    const profile = currentProfile();
    health.dataset.state = profile && profile.configured === false ? 'down' : 'up';
    health.title = profile && profile.configured === false ? 'Provider unconfigured' : 'Provider configured';
    compact.disabled = Boolean(state().run);
    syncing = false;
  }
  return { header, sidecar, banner, notes, sync, refreshMeter };
}
