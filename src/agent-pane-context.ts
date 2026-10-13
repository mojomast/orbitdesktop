import { el, button } from './dom';
import { conversationRequest } from './conversation-client';
import { chatProfileId, type ChatState, type Message } from './chat-storage';
import {
  CONTEXT_SYSTEM_TEXT, CONTEXT_TOOLS_TEXT, DATE_GROUP_ORDER, calibrate, contextWindowFor, dateGroup,
  formatTokens, measureContext, meterLabel, meterLevel, shouldAutoCompact, type ContextMeasure,
} from './context-budget';
import './agent-context.css';

type Profile = { id: string; label: string; configured: boolean; provider?: string };
type ProviderRow = { id: string; label: string; provider: string; gateway: string; model: string; health: 'up' | 'down'; context_window: number; tools: boolean };
type HistoryRow = { session_id: string; profile_id: string; provider: string; title: string; updated_at: string; pinned: boolean; revision: number; snippet: string; running: boolean };
export type HistoryPreview = { profileId: string; sessionId: string; title: string; provider: string; model: string; running: boolean; messages: Message[] };

function memoryKey(workspaceId: string, paneId: string) {
  return `orbit-pane-provider:${workspaceId}:${paneId}`;
}
function ratioKey(model: string) {
  return `orbit-token-ratio:${model}`;
}

export function mountAgentPaneContext(options: {
  paneId: string;
  workspaceId: string;
  badge: HTMLElement;
  strip: HTMLElement;
  column: HTMLElement;
  chat: HTMLElement;
  anchor: HTMLElement;
  getToken: () => string;
  api: (payload: Record<string, unknown>, passive?: boolean) => Promise<Record<string, any>>;
  profiles: () => Profile[];
  getState: () => ChatState;
  switchBlocked: () => boolean;
  providerIsGrok: () => boolean;
  showError: (error: unknown) => void;
  applyState: (state: ChatState) => void;
  resume: (profileId: string, sessionId: string) => void;
  setPreview: (preview: HistoryPreview | null) => void;
  getPreview: () => HistoryPreview | null;
}) {
  const providerButton = button('Provider', 'Choose provider and model for this pane', () => {
    menu.hidden = !menu.hidden;
    providerButton.setAttribute('aria-expanded', String(!menu.hidden));
    if (!menu.hidden) {
      const bounds = providerButton.getBoundingClientRect();
      menu.style.top = `${Math.min(bounds.bottom + 4, window.innerHeight - 16)}px`;
      menu.style.left = `${Math.max(8, Math.min(bounds.left, window.innerWidth - 336))}px`;
      void loadProviders();
    }
  }, 'small-button agent-provider-button');
  providerButton.setAttribute('aria-haspopup', 'menu');
  providerButton.setAttribute('aria-expanded', 'false');
  options.badge.append(providerButton);
  const menu = el('div', 'agent-provider-menu');
  menu.hidden = true;
  menu.setAttribute('role', 'menu');
  menu.setAttribute('aria-label', 'Provider and model');
  document.body.append(menu);

  const meter = el('div', 'agent-context-meter');
  meter.dataset.level = 'ok';
  meter.setAttribute('role', 'meter');
  meter.setAttribute('aria-label', 'Context window');
  meter.setAttribute('aria-valuemin', '0');
  const bar = el('span', 'agent-context-bar');
  const fill = el('span');
  bar.append(fill);
  const meterText = el('span', 'agent-context-label', '—');
  meter.append(bar, meterText);
  const compactButton = button('Compact', 'Compact this transcript after confirmation', () => { void compact(false); }, 'small-button');
  const sessionsButton = button('Sessions', 'Open chat history', () => {
    sidecar.hidden = !sidecar.hidden;
    sessionsButton.setAttribute('aria-expanded', String(!sidecar.hidden));
    if (!sidecar.hidden) void loadHistory();
  }, 'small-button');
  sessionsButton.setAttribute('aria-expanded', 'false');
  options.anchor.insertAdjacentElement('afterend', sessionsButton);
  options.strip.append(meter, compactButton);

  const sidecar = el('aside', 'agent-history-sidecar');
  sidecar.hidden = true;
  sidecar.setAttribute('aria-label', 'Chat history');
  const search = el('input');
  search.type = 'search';
  search.placeholder = 'Search titles and messages';
  search.setAttribute('aria-label', 'Search chat history');
  const filter = el('select');
  filter.setAttribute('aria-label', 'Filter history by provider');
  for (const [value, label] of [['', 'All providers'], ['hermes', 'Hermes'], ['grok', 'Grok Bot']]) {
    const option = el('option', '', label);
    option.value = value;
    filter.append(option);
  }
  const historyStatus = el('p');
  historyStatus.setAttribute('role', 'status');
  const list = el('div', 'agent-history-list');
  const more = button('Load more', 'Load the next page of sessions', () => { void loadHistory(true); }, 'small-button');
  more.hidden = true;
  sidecar.append(search, filter, historyStatus, list, more);
  options.chat.prepend(sidecar);

  const banner = el('div', 'agent-readonly-banner');
  banner.hidden = true;
  const bannerText = el('p', '', 'This chat is read-only. Resume continues the same session. Fork starts a new session from the selected message.');
  const forkSelect = el('select');
  forkSelect.setAttribute('aria-label', 'Fork from message');
  const resumeButton = button('Resume', 'Resume this session', () => {
    const preview = options.getPreview();
    if (!preview) return;
    if (preview.running) { options.showError(Error('This session is still running in another pane.')); return; }
    options.resume(preview.profileId, preview.sessionId);
  }, 'small-button');
  const forkButton = button('Fork from here', 'Fork a new session from the selected message', () => { void forkHere(); }, 'small-button');
  const backButton = button('Back to this chat', 'Close the read-only transcript', () => options.setPreview(null), 'small-button');
  const actions = el('div', 'agent-readonly-actions');
  actions.append(forkSelect, resumeButton, forkButton, backButton);
  banner.append(bannerText, actions);
  options.column.prepend(banner);

  let providers: ProviderRow[] = [];
  let rows: HistoryRow[] = [];
  let offset = 0;
  let historySeq = 0;
  let searchTimer: ReturnType<typeof setTimeout> | undefined;
  let reported: number | undefined;
  let autoFor = '';
  let disposed = false;
  let providerAttempts = 0;

  function currentModel() {
    const state = options.getState();
    const profile = options.profiles().find(item => item.id === chatProfileId(state));
    const listed = providers.find(item => item.id === chatProfileId(state));
    return listed?.model || (profile?.provider === 'grok' ? 'grok' : 'gateway model');
  }
  function currentWindow() {
    const listed = providers.find(item => item.id === chatProfileId(options.getState()));
    return listed?.context_window || contextWindowFor(currentModel(), options.providerIsGrok() ? 'grok' : 'hermes');
  }
  function toolsText() {
    const listed = providers.find(item => item.id === chatProfileId(options.getState()));
    return listed?.tools ? CONTEXT_TOOLS_TEXT : '';
  }
  function storedRatio() {
    try {
      const value = Number(localStorage.getItem(ratioKey(currentModel())));
      return Number.isFinite(value) && value > 0 ? value : null;
    } catch { return null; }
  }
  function orbitOwned() {
    return (options.getState() as ChatState & { orbit_owned?: boolean }).orbit_owned === true;
  }
  function measure(): ContextMeasure {
    const preview = options.getPreview();
    return measureContext({
      messages: preview?.messages || options.getState().messages,
      system: CONTEXT_SYSTEM_TEXT,
      tools: toolsText(),
      reported,
      ratio: storedRatio(),
    });
  }

  function paintMeter() {
    const reading = measure();
    const window = currentWindow();
    const level = meterLevel(reading.used, window);
    meter.dataset.level = level;
    meter.setAttribute('aria-valuemax', String(window));
    meter.setAttribute('aria-valuenow', String(Math.min(reading.used, window)));
    meterText.textContent = meterLabel(reading, window);
    fill.style.width = `${Math.max(0, Math.min(100, window ? (reading.used / window) * 100 : 0))}%`;
    const parts = reading.breakdown;
    const source = reading.source === 'reported'
      ? 'Total is reported by the gateway. Breakdown is estimated.'
      : '≈ estimated from characters (prose ÷ 4, code ÷ 3), calibrated after a reported reply.';
    meter.title = `${source} System ${formatTokens(parts.system)}, tools ${formatTokens(parts.tools)}, history ${formatTokens(parts.history)}, files ${formatTokens(parts.files)}.`;
    const hermes = !options.providerIsGrok() && !orbitOwned();
    compactButton.title = hermes
      ? 'Hermes compresses this session on the gateway. Orbit will not compact it again.'
      : 'Compact this Orbit transcript. Raw text stays on disk.';
    if (!options.getPreview() && shouldAutoCompact(reading.used, window) && (options.providerIsGrok() || orbitOwned())) {
      const key = `${chatProfileId(options.getState())}:${options.getState().session}`;
      if (autoFor !== key) { autoFor = key; void compact(true); }
    }
  }

  function paintProvider() {
    const state = options.getState();
    const profile = options.profiles().find(item => item.id === chatProfileId(state));
    const listed = providers.find(item => item.id === chatProfileId(state));
    const name = listed ? `${listed.provider === 'grok' ? 'Grok Bot' : 'Hermes'} › ${listed.model}` : (profile?.label || chatProfileId(state));
    providerButton.textContent = name;
    try { localStorage.setItem(memoryKey(options.workspaceId, options.paneId), chatProfileId(state)); } catch { /* Preference is optional. */ }
  }

  function paintBanner() {
    const preview = options.getPreview();
    banner.hidden = !preview;
    if (!preview) return;
    bannerText.textContent = preview.running
      ? 'Read-only. This session is still running in another pane, so Resume stays closed. Fork copies up to the selected message.'
      : 'Read-only. Resume continues the same session. Fork starts a new session from the selected message. A different provider forks with a summary.';
    resumeButton.disabled = preview.running;
    forkSelect.replaceChildren();
    preview.messages.forEach((message, index) => {
      const option = el('option', '', `${index + 1}. ${message.role === 'user' ? 'You' : 'Agent'}: ${message.text.slice(0, 60)}`);
      option.value = String(index);
      forkSelect.append(option);
    });
    if (forkSelect.options.length) forkSelect.selectedIndex = forkSelect.options.length - 1;
  }

  async function loadProviders() {
    try {
      const data = await options.api({ action: 'provider_menu' }, true);
      if (disposed) return;
      providers = Array.isArray(data.providers) ? data.providers : [];
      paintMenu();
      paintProvider();
      paintMeter();
    } catch (error) {
      if (!disposed) menu.replaceChildren(el('p', '', error instanceof Error ? error.message : 'Providers unavailable.'));
    }
  }

  function paintMenu() {
    menu.replaceChildren();
    const groups = new Map<string, ProviderRow[]>();
    for (const row of providers) {
      const list = groups.get(row.gateway) || [];
      list.push(row);
      groups.set(row.gateway, list);
    }
    const current = chatProfileId(options.getState());
    for (const [gateway, entries] of groups) {
      const group = el('div', 'agent-provider-group');
      group.setAttribute('role', 'group');
      group.setAttribute('aria-label', gateway);
      group.append(el('h3', '', gateway));
      for (const row of entries) {
        const option = button('', `${row.label} ${row.model}`, () => { void pick(row); }, 'agent-provider-option');
        option.setAttribute('role', 'menuitem');
        option.disabled = row.health !== 'up';
        option.setAttribute('aria-current', String(row.id === current));
        const dot = el('span', 'agent-health-dot');
        dot.dataset.health = row.health;
        dot.title = row.health === 'up' ? 'Gateway up' : 'Gateway down';
        option.replaceChildren(dot, el('span', '', `${row.provider === 'grok' ? 'Grok Bot' : 'Hermes'} › ${row.model}`), el('span', 'agent-window-badge', formatTokens(row.context_window)), el('span', 'agent-tools-badge', row.tools ? 'tools' : 'no tools'));
        group.append(option);
      }
      menu.append(group);
    }
    if (!providers.length) menu.append(el('p', '', 'No providers are configured.'));
  }

  function ask(title: string, body: string, choices: [string, string][]): Promise<string | null> {
    return new Promise(resolve => {
      const dialog = document.createElement('dialog');
      dialog.className = 'hermes-tools-dialog';
      dialog.setAttribute('aria-label', title);
      let settled = false;
      const finish = (value: string | null) => { if (settled) return; settled = true; resolve(value); dialog.close(); };
      const form = el('form');
      form.append(el('h2', '', title), el('p', '', body));
      for (const [value, label] of choices) form.append(button(label, label, () => finish(value)));
      form.append(button('Cancel', 'Cancel', () => finish(null)));
      dialog.append(form);
      dialog.addEventListener('cancel', event => { event.preventDefault(); finish(null); });
      dialog.addEventListener('close', () => { dialog.remove(); finish(null); });
      document.body.append(dialog);
      dialog.showModal();
    });
  }

  async function pick(row: ProviderRow) {
    menu.hidden = true;
    providerButton.setAttribute('aria-expanded', 'false');
    if (row.health !== 'up') return;
    if (options.switchBlocked()) { options.showError(Error('Finish the current run, queue, or approval before switching provider.')); return; }
    if (row.id === chatProfileId(options.getState())) return;
    options.setPreview(null);
    try {
      const decision = await options.api({ action: 'switch_provider', target_profile_id: row.id });
      if (decision.suggest_compact) {
        const choice = await ask(
          'Smaller context window',
          decision.hermes
            ? `The new window (${formatTokens(decision.context_window)}) is smaller than the current context (${formatTokens(decision.used)}, ${decision.source === 'reported' ? 'reported' : '≈ estimated'}). Hermes compresses its own session. Switching forks a new session with a summary.`
            : `The new window (${formatTokens(decision.context_window)}) is smaller than the current context (${formatTokens(decision.used)}, ${decision.source === 'reported' ? 'reported' : '≈ estimated'}). Compact this transcript first, or switch with a summary.`,
          decision.hermes ? [['switch', 'Switch with summary']] : [['compact', 'Compact and switch'], ['switch', 'Switch with summary']],
        );
        if (!choice) return;
        if (choice === 'compact') await options.api({ action: 'compact_transcript', confirm: true });
        const done = await options.api({ action: 'switch_provider', target_profile_id: row.id, acknowledge_smaller: true });
        if (done.state) options.applyState(done.state as ChatState);
        return;
      }
      if (decision.switched && decision.state) options.applyState(decision.state as ChatState);
    } catch (error) { options.showError(error); }
  }

  async function compact(automatic: boolean) {
    if (!automatic) {
      const hermes = !options.providerIsGrok() && !orbitOwned();
      const choice = await ask('Compact conversation', hermes
        ? 'Hermes compresses this session on the gateway from reported usage. Orbit will show that state and will not compact the same transcript again.'
        : 'Orbit will prune old tool output, keep the first request and the last 10 turns, and replace the middle with a summary. The raw transcript stays on disk.',
      [['compact', hermes ? 'Show Hermes state' : 'Compact']]);
      if (choice !== 'compact') return;
    }
    try {
      const result = await options.api({ action: 'compact_transcript', ...(automatic ? { automatic: true } : { confirm: true }) });
      if (result.compacted && result.state) options.applyState(result.state as ChatState);
      else if (result.note) meter.title = String(result.note);
      paintMeter();
    } catch (error) { if (!automatic) options.showError(error); }
  }

  function renderHistory() {
    const groups = new Map<string, HistoryRow[]>();
    const pinned = rows.filter(row => row.pinned);
    if (pinned.length) groups.set('Pinned', pinned);
    for (const row of rows) {
      const name = dateGroup(row.updated_at);
      const bucket = groups.get(name) || [];
      bucket.push(row);
      groups.set(name, bucket);
    }
    list.replaceChildren();
    for (const name of DATE_GROUP_ORDER) {
      const entries = groups.get(name);
      if (!entries?.length) continue;
      const group = el('section', 'agent-history-group');
      group.append(el('h3', '', name));
      for (const row of entries) group.append(historyRow(row));
      list.append(group);
    }
    if (!rows.length) list.append(el('p', '', 'No matching conversations.'));
  }

  function historyRow(row: HistoryRow) {
    const item = el('article', 'agent-history-row');
    item.dataset.session = row.session_id;
    const title = el('p', '', `${row.pinned ? '★ ' : ''}${row.title || row.session_id}`);
    const mark = el('span', 'agent-provider-mark', row.provider === 'grok' ? 'G' : 'H');
    mark.title = row.provider === 'grok' ? 'Grok Bot' : 'Hermes';
    const line = el('p');
    line.append(mark, document.createTextNode(` ${row.provider === 'grok' ? 'Grok Bot' : 'Hermes'}${row.snippet ? ` · ${row.snippet}` : ''}`));
    const rowActions = el('div', 'agent-history-actions');
    rowActions.append(
      button('Open', 'Open this conversation read-only', () => { void openRow(row); }, 'small-button'),
      button(row.pinned ? 'Unpin' : 'Pin', 'Pin or unpin this conversation', () => { void mutate(row, { pinned: !row.pinned }); }, 'small-button'),
      button('Rename', 'Rename the Orbit display title', () => rename(row), 'small-button'),
    );
    item.append(title, line, rowActions);
    return item;
  }

  function rename(row: HistoryRow) {
    const name = el('input');
    name.maxLength = 200;
    name.value = row.title || '';
    name.setAttribute('aria-label', 'Conversation name');
    const save = button('Save name', 'Save conversation name', () => { void mutate(row, { title: name.value.trim() }); }, 'small-button');
    const item = Array.from(list.querySelectorAll<HTMLElement>('[data-session]')).find(node => node.dataset.session === row.session_id);
    const form = el('div', 'agent-history-actions');
    form.append(name, save, button('Cancel', 'Cancel rename', () => renderHistory(), 'small-button'));
    (item || list).append(form);
    name.focus();
  }

  async function mutate(row: HistoryRow, patch: Record<string, unknown>) {
    try {
      const result = await conversationRequest(options.getToken, {
        action: 'conversation_metadata', workspace_id: options.workspaceId, profile_id: row.profile_id, session_id: row.session_id, expected_revision: row.revision, patch,
      });
      if (disposed) return;
      row.revision = result.record?.revision ?? row.revision + 1;
      if ('pinned' in patch) row.pinned = patch.pinned === true;
      if ('title' in patch && typeof patch.title === 'string') row.title = patch.title;
      if (result.conflict) historyStatus.textContent = 'That name changed elsewhere. Refresh history and try again.';
      renderHistory();
    } catch (error) { historyStatus.textContent = error instanceof Error ? error.message : 'Could not save conversation metadata.'; }
  }

  async function loadHistory(append = false) {
    const seq = ++historySeq;
    const next = append ? offset + 100 : 0;
    historyStatus.textContent = 'Loading conversations…';
    try {
      const data = await options.api({ action: 'history_search', query: search.value, provider: filter.value || undefined, offset: next }, true);
      if (disposed || seq !== historySeq) return;
      const incoming = Array.isArray(data.conversations) ? data.conversations as HistoryRow[] : [];
      rows = append ? [...rows, ...incoming] : incoming;
      offset = next;
      more.hidden = data.has_more !== true;
      historyStatus.textContent = data.partial ? String(data.note || 'Partial results.') : `${rows.length} conversation${rows.length === 1 ? '' : 's'}.`;
      renderHistory();
    } catch (error) { if (!disposed && seq === historySeq) historyStatus.textContent = error instanceof Error ? error.message : 'History unavailable.'; }
  }

  async function openRow(row: HistoryRow) {
    try {
      const data = await options.api({ action: 'history_transcript', target_profile_id: row.profile_id, target_session_id: row.session_id }, true);
      if (disposed) return;
      const state = options.getState();
      if (data.profile_id === chatProfileId(state) && data.session_id === state.session) { options.setPreview(null); return; }
      options.setPreview({
        profileId: String(data.profile_id),
        sessionId: String(data.session_id),
        title: String(data.title || row.title),
        provider: String(data.provider || row.provider),
        model: String(data.model || ''),
        running: data.running === true || row.running === true,
        messages: Array.isArray(data.messages) ? data.messages : [],
      });
    } catch (error) { options.showError(error); }
  }

  async function forkHere() {
    const preview = options.getPreview();
    if (!preview) return;
    if (options.switchBlocked()) { options.showError(Error('Finish the current run before forking.')); return; }
    const upto = Number(forkSelect.value);
    try {
      const result = await options.api({
        action: 'fork_transcript',
        source_profile_id: preview.profileId,
        source_session_id: preview.sessionId,
        target_profile_id: chatProfileId(options.getState()),
        upto,
      });
      if (result.state) {
        options.setPreview(null);
        options.applyState(result.state as ChatState);
      }
    } catch (error) { options.showError(error); }
  }

  search.addEventListener('input', () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => { if (!sidecar.hidden) void loadHistory(); }, 300);
  });
  filter.addEventListener('change', () => { void loadHistory(); });
  const onPointer = (event: PointerEvent) => {
    if (!menu.hidden && !menu.contains(event.target as Node) && !providerButton.contains(event.target as Node)) {
      menu.hidden = true;
      providerButton.setAttribute('aria-expanded', 'false');
    }
  };
  document.addEventListener('pointerdown', onPointer);

  return {
    sync() {
      if (disposed) return;
      paintProvider();
      paintBanner();
      paintMeter();
      if (!providers.length && providerAttempts < 3 && options.getToken()) { providerAttempts += 1; void loadProviders(); }
    },
    noteUsage(tokens: number) {
      const estimated = measureContext({ messages: options.getState().messages, system: CONTEXT_SYSTEM_TEXT, tools: toolsText() }).estimated;
      const ratio = calibrate(estimated, tokens);
      if (ratio) { try { localStorage.setItem(ratioKey(currentModel()), String(ratio)); } catch { /* optional */ } }
      reported = tokens;
      paintMeter();
    },
    onBinding() { reported = undefined; autoFor = ''; paintProvider(); paintMeter(); },
    dispose() { disposed = true; clearTimeout(searchTimer); menu.remove(); document.removeEventListener('pointerdown', onPointer); },
  };
}
