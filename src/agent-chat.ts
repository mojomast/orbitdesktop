import { workspaceExtensions } from './workspace-extensions';
import { watchToolFeed } from './tool-feed';
import { createInlineTools } from './inline-tools';
import { registerActivity, openAgentOverview } from './agent-activity';
import './hermes-tools.css';
import './agent-toolbar.css';
import './chat-message.css';
import { createChatMessageRenderer } from './chat-message-renderer';
import { el, button } from './dom';
import { workspaceId, ensureWorkspaceSynced } from './workspace-sync';
import { readPanePrefs, writePanePrefs, type PaneMode, type PaneWorkbenchPrefs } from './pane-prefs';
import { mountPaneWorkbench, type PaneWorkbenchBadge } from './pane-workbench';
import { createLiveTimeline } from './agent-live-timeline';
import { createNormalLiveAdapter } from './agent-live-normal';
import type { LiveItem } from './agent-live-types';
import { createAgentInspector } from './agent-inspector';
import { experimentalEnabled, subscribeExperimental } from './experimental';
import { showOrbitSettings } from './orbit-settings';
import { showConversationLibrary } from './conversation-library';
import { createConversationDraft } from './conversation-draft';
import { conversationRequest } from './conversation-client';
import { registerConversationRecipient, type ConversationRecipientHandle } from './conversation-transfer';

import { archiveChat, validChat, transcript, chatProfileId, chatBindingKey, type ChatState } from './chat-storage';
export function createAgentChat(body: HTMLElement, paneId: string, getToken: () => string, toolbar?: HTMLElement) {
  const storageKey = `orbit-hermes-chat:${paneId}`;
  const archiveKey = `${storageKey}:archive`, legacyDraftKey = `${storageKey}:draft`;
  const draftKey = () => `${legacyDraftKey}:${chatBindingKey(state)}`;
  function saveDraft() { try { sessionStorage.setItem(draftKey(), input.value); } catch {} durableDraft?.edit(); }
  function loadDraft() { try {
    if (chatProfileId(state) === 'default') {
      const legacy = sessionStorage.getItem(legacyDraftKey);
      if (legacy !== null) {
        if (sessionStorage.getItem(draftKey()) === null) sessionStorage.setItem(draftKey(), legacy.slice(0, 100000));
        sessionStorage.removeItem(legacyDraftKey);
      }
    }
    input.value = (sessionStorage.getItem(draftKey()) || '').slice(0, 100000);
  } catch { input.value = ''; } }
  let history: ChatState[] = [];
  try { const raw = JSON.parse(sessionStorage.getItem(archiveKey) || '[]'); if (Array.isArray(raw)) history = raw.filter(validChat).filter(s => !s.run).slice(0, 10); } catch {}
  function remember() {
    history = archiveChat(history, state);
    try { sessionStorage.setItem(archiveKey, JSON.stringify(history)); } catch { progress.textContent = 'Browser storage is full; export the conversation before closing.'; }
  }
  const fresh = (): ChatState => ({ session: `orbit-${crypto.randomUUID()}`, messages: [], create_new: true });
  let state = fresh();
  try {
    const saved = JSON.parse(sessionStorage.getItem(storageKey) || 'null');
    if (validChat(saved)) state = saved;
  } catch { /* Storage is optional. */ }
  try {
    const saved = JSON.parse(sessionStorage.getItem(storageKey) || 'null');
    if (saved?.session === state.session) {
      state.title = typeof saved.title === 'string' ? saved.title.slice(0, 100) : undefined;
      state.color = /^#[0-9a-f]{6}$/i.test(saved.color) ? saved.color : undefined;
      state.queue = Array.isArray(saved.queue) ? saved.queue.filter((s: unknown) => typeof s === 'string' && s.length <= 100000).slice(0, 20) : [];
    }
  } catch {}

  let disposed = false, busy = false, polling = false, queuePaused = false, sharing = false, switching = false;
  let generation = 0, pending = 0, sharedEpoch = 0;
  // A cached revision is not proof that this mount has linked to the host.
  let bindingReady = false;
  let conversationRecipient: ConversationRecipientHandle | undefined, recipientBinding = '';
  class StaleRequest extends Error {}
  const scope = () => ({ session_id: state.session, profile_id: chatProfileId(state), workspace_id: workspaceId, pane_id: paneId, generation, revision: state.binding_revision });
  type Scope = ReturnType<typeof scope>;
  const current = (s: Scope) => !disposed && s.generation === generation && s.workspace_id === workspaceId && s.session_id === state.session && s.profile_id === chatProfileId(state) && s.revision === state.binding_revision;
  const switchBlocked = () => disposed || !bindingReady || busy || polling || switching || pending > 0 || !!state.run || !!state.queue?.length || approvals.childElementCount > 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const controller = new AbortController();
  let liveController: AbortController | undefined;
  const save = () => {
    try { sessionStorage.setItem(storageKey, JSON.stringify(state)); } catch { /* Private browsing/storage limit. */ }
  };
  body.classList.add('chat-body');
  // Persistent Normal/Workbench siblings. Mode switching only toggles `hidden`;
  // the Normal conversation DOM (messages, composer, queue) is never rebuilt, so
  // the chat session, draft and queue survive a view change.
  const chatNormal = el('div', 'agent-chat-normal');
  const workbenchHost = el('div', 'agent-workbench-host');
  workbenchHost.hidden = true;
  // Independent timelines retain their DOM and subscriptions while hidden.
  const normalTimelineHost = el('div', 'agent-live-host');
  let panePrefs: PaneWorkbenchPrefs = readPanePrefs(workspaceId, paneId);
  let paneMode: PaneMode = panePrefs.mode;
  // The stored pane preference is preserved while the experimental surface is
  // off; only the rendered view is gated, so re-enabling restores this pane.
  const workbenchAvailable = () => experimentalEnabled('workbench');
  const activeMode = (): PaneMode => (workbenchAvailable() ? paneMode : 'normal');
  let workbenchStatus = '';
  let workbenchBadge: PaneWorkbenchBadge = { mode: 'workbench', pending: 0, results: 0, laneBusy: false, status: 'Idle' };
  let workbench: ReturnType<typeof mountPaneWorkbench> | undefined;
  // Shared-lane signals are tracked per source so a fresh read from one source
  // never clears another source's unknown state. The Workbench pane live lane and
  // the shared_chat execution_lane are independent read-only observations.
  let wbLane = { agent_busy: false, job_busy: false, unknown: false, observed: false };
  let sharedLane = { agent_busy: false, job_busy: false, unknown: false };
  let sharedLanePresent = false;
  let workbenchLaneActive = false;
  let laneUnknown = false;
  const badge = el('div', 'agent-meta');
  const heading = el('span', 'agent-pane-title', 'Hermes');
  const status = el('span', 'agent-status', 'READY');
  status.setAttribute('role', 'status');
  const humanStatus = button('Ready', 'Inspect agent status and activity', () => {
    if (laneUnknown) { recovery.open = true; openPanel('troubleshooting', humanStatus); }
    else if (['ATTENTION','FAILED','WAITING FOR APPROVAL'].includes(status.textContent || '')) { setMode('normal'); progress.focus(); }
    else openPanel('activity', humanStatus);
  }, 'agent-status agent-human-status');
  humanStatus.setAttribute('aria-live', 'polite');
  status.className = 'agent-runtime-status';
  const newChat = button('New chat', 'Start a separate Hermes conversation', () => {
    void switchConversation(chatProfileId(state));
  }, 'small-button');
  const notificationKey = 'orbit-agent-reply-notifications';
  const notificationsEnabled = () => { try { return localStorage.getItem(notificationKey) !== 'off'; } catch { return true; } };
  const notificationButton = button('Notifications', 'Enable desktop reply notifications', async () => {
    if (!('Notification' in window)) { progress.textContent = 'Desktop notifications are not supported by this browser.'; return; }
    if (Notification.permission === 'granted' && notificationsEnabled()) {
      try { localStorage.setItem(notificationKey, 'off'); } catch {}
    } else {
      try {
        const permission = await Notification.requestPermission();
        if (permission === 'granted') { localStorage.setItem(notificationKey, 'on'); progress.textContent = 'Desktop reply notifications enabled. Keep Orbit open to receive them.'; }
        else progress.textContent = 'Notifications are blocked or not allowed. Allow notifications for Orbit in your browser site settings.';
      } catch { progress.textContent = 'Could not enable notifications. Check browser site permissions.'; }
    }
    updateNotifications();
  }, 'small-button');
  function updateNotifications() {
    const enabled = 'Notification' in window && Notification.permission === 'granted' && notificationsEnabled();
    notificationButton.textContent = enabled ? 'Notifications on' : 'Enable notifications';
    notificationButton.setAttribute('aria-pressed', String(enabled));
  }
  function notifyReply(run: string, completed: boolean) {
    if (!('Notification' in window) || Notification.permission !== 'granted' || !notificationsEnabled()) return;
    try {
      const notification = new Notification(completed ? 'Hermes replied' : 'Hermes run ended', {
        body: 'Open Orbit to read your agent chat.', tag: `orbit-agent-${run}`,
      });
      notification.onclick = () => { window.focus(); body.scrollIntoView({ block: 'nearest' }); input.focus(); notification.close(); };
    } catch { /* OS/browser policy must not interrupt saving replies. */ }
  }
  updateNotifications();
  const titleInput = el('input'); titleInput.placeholder = 'Hermes'; titleInput.maxLength = 100;
  titleInput.setAttribute('aria-label', 'Conversation title');
  async function saveConversationTitle(title:string) {
    const requested=scope(), identity={workspace_id:requested.workspace_id,profile_id:requested.profile_id,session_id:requested.session_id};
    try {
      const {record}=await conversationRequest(getToken,{action:'draft_read',...identity});
      if(!current(requested))return;
      const result=await conversationRequest(getToken,{action:'conversation_metadata',...identity,expected_revision:record.revision,patch:{title}});
      if(!current(requested))return;
      if(result.conflict)throw Error('Conversation metadata changed. Refresh the library before renaming again.');
      state.title=title;save();render();
    }catch(error){if(current(requested))showError(error);}
  }
  titleInput.addEventListener('change', () => { void saveConversationTitle(titleInput.value.trim()); });
  const colorInput = el('input'); colorInput.type = 'color'; colorInput.title = 'Conversation color theme';
  colorInput.setAttribute('aria-label', 'Conversation color theme');
  colorInput.addEventListener('input', () => { state.color = colorInput.value; save(); render(); });
  const rename = button('Rename', 'Rename this agent conversation', () => {
    const requested = scope();
    const dialog = document.createElement('dialog');
    dialog.className = 'hermes-tools-dialog'; dialog.setAttribute('aria-label', 'Rename agent conversation');
    const name = el('input'); name.maxLength = 100; name.value = state.title || '';
    name.placeholder = 'Hermes'; name.setAttribute('aria-label', 'New conversation name');
    const form = el('form');
    const commit = button('Save name', 'Save conversation name', () => {}); commit.type = 'submit';
    form.append(el('h2', '', 'Rename agent conversation'),
      el('p', '', 'This changes the display name for this conversation, not the underlying agent or model.'),
      name, commit, button('Cancel', 'Cancel rename', () => dialog.close()));
    form.onsubmit = event => { event.preventDefault(); if (current(requested)) void saveConversationTitle(name.value.trim()); dialog.close(); };
    dialog.append(form); dialog.addEventListener('close', () => dialog.remove());
    document.body.append(dialog); dialog.showModal(); name.focus(); name.select();
  }, 'small-button');
  // Segmented Normal/Workbench control in the pane header. Both buttons stay
  // visible with their own live status text; the inactive mode's status keeps
  // updating. Changing the view never dispatches work. Stable accessible names
  // ("Normal Hermes mode" / "Workbench Hermes mode") are used by tests.
  // A span (not a div): compact-window styling hides direct div children of
  // .agent-meta, which previously collapsed this control.
  const modeControl = el('span', 'agent-mode-control');
  modeControl.setAttribute('role', 'group');
  modeControl.setAttribute('aria-label', 'Pane mode');
  const modeOrder: PaneMode[] = ['normal', 'workbench'];
  const modeButtons = new Map<PaneMode, { button: HTMLButtonElement; status: HTMLElement }>();
  function roveMode(event: KeyboardEvent, mode: PaneMode) {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const index = modeOrder.indexOf(mode);
    const nextIndex = event.key === 'Home' ? 0
      : event.key === 'End' ? modeOrder.length - 1
      : event.key === 'ArrowRight' ? (index + 1) % modeOrder.length
      : (index - 1 + modeOrder.length) % modeOrder.length;
    const next = modeOrder[nextIndex];
    modeButtons.get(next)?.button.focus();
    setMode(next);
  }
  for (const mode of modeOrder) {
    const control = button('', `${mode === 'normal' ? 'Normal' : 'Workbench'} Hermes mode`, () => setMode(mode), 'agent-mode-button');
    control.dataset.mode = mode;
    control.setAttribute('aria-label', `${mode === 'normal' ? 'Normal' : 'Workbench'} Hermes mode`);
    control.setAttribute('aria-pressed', String(mode === paneMode));
    const label = el('span', 'agent-mode-button-label', mode === 'normal' ? 'Normal' : 'Workbench');
    const statusText = el('span', 'agent-mode-button-status', mode === 'normal' ? 'READY' : 'Idle');
    statusText.setAttribute('aria-live', 'polite');
    control.replaceChildren(label, statusText);
    control.addEventListener('keydown', (event) => roveMode(event, mode));
    modeButtons.set(mode, { button: control, status: statusText });
    modeControl.append(control);
  }
  const overflow = button('⋯', 'Agent pane menu', () => {
    overflowMenu.hidden = !overflowMenu.hidden;
    overflow.setAttribute('aria-expanded', String(!overflowMenu.hidden));
    if (!overflowMenu.hidden) {
      const bounds = overflow.getBoundingClientRect();
      overflowMenu.style.top = `${Math.min(bounds.bottom + 5, window.innerHeight - 10)}px`;
      overflowMenu.style.right = `${Math.max(5, window.innerWidth - bounds.right)}px`;
      overflowMenu.style.maxHeight = `${Math.max(80, window.innerHeight - 20)}px`;
      overflowMenu.style.top = `${Math.max(5, Math.min(bounds.bottom + 5, window.innerHeight - overflowMenu.scrollHeight - 8))}px`;
      overflowMenu.querySelector('button')?.focus();
    }
  }, 'small-button agent-menu-trigger');
  overflow.setAttribute('aria-expanded', 'false');
  overflow.setAttribute('aria-haspopup', 'menu');
  const overflowMenu = el('div', 'agent-overflow-menu'); overflowMenu.hidden = true;
  overflowMenu.setAttribute('role', 'menu');
  document.body.append(overflowMenu);
  const inspector = createAgentInspector({ title: 'Hermes inspector' });
  inspector.element.dataset.paneId = paneId;
  function openPanel(id: string, trigger?: HTMLElement) {
    overflowMenu.hidden = true; overflow.setAttribute('aria-expanded', 'false');
    if (id === 'tools') { inspector.close(); setMode('normal'); inlineTools.show(); return; }
    inspector.open(id, trigger);
  }
  const menuEntry = (label: string, action: () => void) => {
    const entry = button(label, label, action, 'small-button');
    entry.setAttribute('role', 'menuitem'); overflowMenu.append(entry);
    return entry;
  };
  menuEntry('Conversation settings', () => openPanel('settings', overflow));
  const setUpTaskEntry = menuEntry('Set up task', () => { overflowMenu.hidden = true; overflow.setAttribute('aria-expanded', 'false'); setMode('workbench'); ensureWorkbench()?.openHandoff({ statement: input.value }); });
  menuEntry('Activity', () => openPanel('activity', overflow));
  menuEntry('Saved tools', () => openPanel('tools', overflow));
  menuEntry('Troubleshooting', () => openPanel('troubleshooting', overflow));
  menuEntry('Hermes tools and conversations', () => { overflowMenu.hidden = true; overflow.setAttribute('aria-expanded', 'false'); openTools(); });
  overflowMenu.addEventListener('keydown', event => {
    if (event.key === 'Escape') { event.preventDefault(); overflowMenu.hidden = true; overflow.setAttribute('aria-expanded', 'false'); overflow.focus(); }
    if (['ArrowDown','ArrowUp','Home','End'].includes(event.key)) {
      event.preventDefault(); const entries=Array.from(overflowMenu.querySelectorAll<HTMLButtonElement>('button:not(:disabled)'));
      const index=entries.indexOf(document.activeElement as HTMLButtonElement);
      entries[event.key==='Home'?0:event.key==='End'?entries.length-1:(index+(event.key==='ArrowDown'?1:-1)+entries.length)%entries.length]?.focus();
    }
  });
  const onOutsideMenu = (event: PointerEvent) => {
    if (!overflow.contains(event.target as Node) && !overflowMenu.contains(event.target as Node)) {
      overflowMenu.hidden = true; overflow.setAttribute('aria-expanded', 'false');
      if (overflowMenu.contains(document.activeElement)) overflow.focus();
    }
  };
  document.addEventListener('pointerdown', onOutsideMenu);
  badge.append(heading, humanStatus, modeControl, overflow);
  const bindingControls = el('div', 'agent-binding-controls');
  const profileSelect = el('select'); profileSelect.setAttribute('aria-label', 'Profile');
  const sessionSelect = el('select'); sessionSelect.setAttribute('aria-label', 'Session');
  const bindingNote = el('span', 'agent-binding-note'); bindingNote.setAttribute('role', 'status');
  let profiles: { id: string; label: string; configured: boolean }[] = [];
  let metadataReady = false, sessionsReady = false, metadataSequence = 0, catalogRequested = false;
  function option(value: string, label: string, disabled = false) {
    const node = el('option', '', label); node.value = value; node.disabled = disabled; return node;
  }
  function resetBindingControls() {
    metadataSequence++; metadataReady = false; sessionsReady = false; catalogRequested = false;
    delete overflow.dataset.attention; overflow.title = 'Agent pane menu';
    profileSelect.replaceChildren(option(chatProfileId(state), chatProfileId(state)));
    sessionSelect.replaceChildren(option(state.session, state.title || state.session));
    bindingNote.textContent = `Bound: ${chatProfileId(state)} · ${state.session}`;
  }
  async function loadSessions() {
    const requested = scope(), sequence = ++metadataSequence, target = profileSelect.value;
    sessionsReady = false; sessionSelect.replaceChildren(option('', 'Loading sessions…')); update();
    try {
      if (!profiles.some(p => p.id === target && p.configured)) throw Error('The selected profile is missing or unconfigured. Configure it before applying.');
      const data = await api({ action: 'sessions', target_profile_id: target }, requested);
      if (!current(requested) || sequence !== metadataSequence) return;
      const list = Array.isArray(data.sessions) ? data.sessions : Array.isArray(data.sessions?.data) ? data.sessions.data : null;
      if (data.supported === false || !list) throw Error(data.note || 'Session selection is unsupported for this profile.');
      sessionSelect.replaceChildren(option('', 'New conversation'));
      for (const item of list) {
        const id = item.session_id ?? item.id;
        if (typeof id === 'string' && validChat({session:id,messages:[]})) sessionSelect.append(option(id, String(item.title || item.label || id)));
      }
      if (target === chatProfileId(state)) {
        if (!Array.from(sessionSelect.options).some(o => o.value === state.session)) sessionSelect.append(option(state.session, `${state.title || state.session} (current, not in catalog)`, true));
        sessionSelect.value = state.session;
      }
      sessionsReady = true; bindingNote.textContent = target === chatProfileId(state) && sessionSelect.value === state.session
        ? `Bound: ${profiles.find(p => p.id === target)?.label || target} · ${state.title || state.session}`
        : 'Selection is staged. Press Apply to switch.';
      delete overflow.dataset.attention; overflow.title = 'Agent pane menu';
    } catch (error) { if (current(requested) && sequence === metadataSequence) { bindingNote.textContent = error instanceof Error ? error.message : 'Sessions unavailable.'; overflow.dataset.attention = 'true'; overflow.title = `Conversation settings: ${bindingNote.textContent}`; } }
    finally { if (current(requested)) update(); }
  }
  async function loadProfiles() {
    catalogRequested = true;
    const requested = scope(), sequence = ++metadataSequence;
    metadataReady = false; sessionsReady = false; update();
    try {
      const data = await api({ action: 'profiles' }, requested);
      if (sequence !== metadataSequence) return;
      if (!Array.isArray(data.profiles)) throw Error('Profile selection is unsupported by this backend.');
      profiles = data.profiles.flatMap((p: { id?: string; profile_id?: string; label?: string; name?: string; configured?: boolean }) => {
        const id = p.profile_id ?? p.id;
        return typeof id === 'string' && validChat({session:'orbit-placeholder',profile_id:id,messages:[]}) ? [{ id, label: String(p.label || p.name || id), configured: p.configured !== false }] : [];
      });
      profileSelect.replaceChildren(...profiles.map(p => option(p.id, `${p.label}${p.configured ? '' : ' (unconfigured)'}`, !p.configured)));
      const bound = profiles.find(p => p.id === chatProfileId(state));
      if (!bound) profileSelect.prepend(option(chatProfileId(state), `${chatProfileId(state)} (missing)`, true));
      profileSelect.value = chatProfileId(state); metadataReady = true;
      if (!bound?.configured) throw Error('The bound profile is missing or unconfigured. Select a configured profile explicitly.');
      await loadSessions();
    } catch (error) { if (current(requested)) { bindingNote.textContent = error instanceof Error ? error.message : 'Profiles unavailable.'; overflow.dataset.attention = 'true'; overflow.title = `Conversation settings: ${bindingNote.textContent}`; } }
    finally { if (current(requested)) update(); }
  }
  profileSelect.onchange = () => { void loadSessions(); };
  sessionSelect.onchange = () => { bindingNote.textContent = 'Selection is staged. Press Apply to switch.'; };
  const applyBinding = button('Apply', 'Apply selected profile and session', () => {
    if (!metadataReady || !sessionsReady || sessionSelect.selectedOptions[0]?.disabled || !profiles.some(p => p.id === profileSelect.value && p.configured)) { showError(Error('Select a configured profile and a listed session or New conversation first.')); return; }
    void switchConversation(profileSelect.value, sessionSelect.value || undefined);
  }, 'small-button');
  const refreshBindings = button('Refresh profiles', 'Load available Hermes profiles and sessions', () => { void loadProfiles(); }, 'small-button');
  bindingControls.append(el('span', '', 'Profile'), profileSelect, el('span', '', 'Session'), sessionSelect, applyBinding, refreshBindings, bindingNote);
  resetBindingControls();
  const queueList = el('div', 'agent-queue');
  const drainButton = button('Send next queued', 'Resume sending queued messages', () => { void drainQueue(); }, 'small-button');
  async function drainQueue() {
    // The native/runtime lane is server-authoritative and single. While another
    // pane's Workbench task occupies it (or its outcome is unknown) never send,
    // even on an explicit drain. Otherwise this is the explicit user send that
    // releases the held queue.
    if (disposed || busy || state.run || laneBlocked() || !state.queue?.length) return;
    queuePaused = false;
    await submit(state.queue[0]);
  }
  const messages = el('div', 'chat-messages');
  const messageRenderer = createChatMessageRenderer(messages);
  // Host-authored task receipts are deliberately outside ChatState.messages:
  // displaying one must never add an assistant turn or trigger model inference.
  const taskCards = el('section', 'agent-task-results');
  taskCards.setAttribute('aria-label', 'Supervised worker task results');
  taskCards.hidden = true;
  let cardsLoading = false, cardsDigest = '';
  async function refreshTaskCards() {
    if (disposed || cardsLoading || switching) return;
    if (!workbenchAvailable()) { taskCards.replaceChildren(); taskCards.hidden = true; cardsDigest = ''; return; }
    const token = getToken();
    if (!token) { taskCards.replaceChildren(); taskCards.hidden = true; cardsDigest = ''; return; }
    const requested = scope();
    cardsLoading = true;
    try {
      const response = await fetch('/api/workbench/native', {
        method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({action:'cards_list',workspace_id:requested.workspace_id,pane_id:requested.pane_id,profile_id:requested.profile_id,session_id:requested.session_id}),
        signal: controller.signal,
      });
      if (!current(requested) || getToken() !== token) return;
      if (!response.ok) throw Error('Task results unavailable');
      const data = await response.json();
      if (!current(requested) || getToken() !== token) return;
      const cards = Array.isArray(data.cards) ? data.cards.slice(0, 100) : [];
      const digest = JSON.stringify({cards,truncated:data.truncated===true});
      if (digest === cardsDigest) return;
      cardsDigest = digest;
      taskCards.replaceChildren();
      taskCards.hidden = cards.length === 0;
      for (const card of cards) {
        const item = el('details');
        item.dataset.resultId = String(card.result_id || '');
        item.append(el('summary', '', 'Comet task result · supervised worker'));
        item.append(el('p', '', 'Host-delivered result from a separate worker. This has not been sent to this conversation’s model.'));
        const text = el('pre', 'workbench-result-text');
        text.style.whiteSpace = 'pre-wrap'; text.style.overflowWrap = 'anywhere';
        text.textContent = card.availability === 'available' && typeof card.text === 'string'
          ? card.text : 'Agent explanation unavailable. Recorded checks and human review remain separate.';
        item.append(text, el('p', '', `Task ${String(card.task_id || '')} · Attempt ${String(card.attempt_id || '')}`));
        item.append(el('p', '', 'The worker’s explanation is untrusted text. Consult Recorded checks and Human review in Project Workbench for verification and acceptance.'));
        taskCards.append(item);
      }
      if(data.truncated===true)taskCards.append(el('p','','Showing a bounded page of retained task results. Open Project Workbench to select another task result.'));
    } catch {
      if (current(requested)) { taskCards.replaceChildren(); taskCards.hidden = true; cardsDigest = ''; }
    } finally { cardsLoading = false; }
  }
  // Two independent renderer instances, never one shared history. The Normal
  // instance is bound to this chat/session (tool-feed + saved metadata); the
  // Workbench instance is bound to the selected project/attempt. Reconnecting or
  // resetting one never clears or changes the other.
  const timeline = createLiveTimeline({
    storageKey: `orbit-live-timeline:${workspaceId}:${paneId}:normal`,
    onOpenReference: (item: LiveItem) => {
      if (item.reference?.kind === 'normal-tool') openPanel('tools');
    },
  });
  normalTimelineHost.append(timeline.element);
  inspector.register('activity', 'Live activity', normalTimelineHost);
  const workbenchTimeline = createLiveTimeline({
    storageKey: `orbit-live-timeline:${workspaceId}:${paneId}:workbench`,
    onOpenReference: (item: LiveItem) => workbench?.openLiveReference(item),
  });
  const normalLive = createNormalLiveAdapter(timeline);
  normalLive.reset(chatBindingKey(state));
  normalLive.connection(getToken() ? 'connecting' : 'unavailable', getToken() ? undefined : 'Unlock the local host to inspect activity');
  const inlineTools = createInlineTools(paneId, null, async () => {
    const data = await api({action:'activity'});
    normalLive.saved(Array.isArray(data.activity) ? data.activity : []);
    return data;
  });
  // One retained tool view in the conversation, not a duplicate subscription.
  // Its existing per-pane preference controls visibility, never execution.
  inlineTools.toggle.classList.add('agent-tools-toggle');
  // Cross-mode status plumbing; the activity registry now carries these fields.
  const activity = registerActivity(paneId, () => {
    window.dispatchEvent(new CustomEvent('orbit-focus-agent', {detail:paneId}));
    body.scrollIntoView({block:'nearest'});
    if (activeMode() !== 'normal') setMode('normal');
    input.focus();
  }, { focusMode: (mode) => setMode(mode), modesAvailable: () => workbenchAvailable() });
  let toolStatus = '', streamStatus = '';
  const strip = el('div','agent-activity-strip');
  // On attention, reveal the actual error instead of opening inline tools. With
  // an active run the click performs a read-only status poll; otherwise it just
  // focuses the error/progress area.
  const onActivityAction = () => {
    const runStatus = status.textContent || 'READY';
    if (runStatus === 'ATTENTION') {
      progress.scrollIntoView({ block: 'nearest' });
      progress.focus();
      if (state.run) void poll();
      return;
    }
    openPanel('activity', activityButton);
  };
  const activityButton = button('Ready','Show live tool details',onActivityAction,'small-button');
  const conversations = button('History', 'Open recent Hermes conversations', () => openTools(), 'small-button');
  strip.append(newChat, conversations, inlineTools.toggle, activityButton);
  // Shown only when this pane's stored mode is Workbench while the experimental
  // surface is off. Normal chat remains fully usable here and the preference is
  // restored when the owner enables the feature.
  const experimentalNotice = el('div', 'agent-experimental-notice');
  experimentalNotice.hidden = true;
  experimentalNotice.setAttribute('role', 'status');
  experimentalNotice.append(
    el('span', '', 'Project Workbench is experimental and off. This pane was last used in Workbench mode; enable it in Orbit settings to restore that surface.'),
    button('Enable in Orbit settings', 'Enable in Orbit settings', () => showOrbitSettings(), 'small-button'),
  );
  const workspaceAgents = button('Workspace agents','Overview of all open agents',openAgentOverview,'small-button');
  function refreshActivity() {
    const runStatus = status.textContent || 'READY';
    const attention = runStatus === 'ATTENTION';
    const label = !getToken() ? 'Host disconnected' : attention ? (state.run ? 'Needs attention · check status' : 'Needs attention · view error') : runStatus === 'WAITING FOR APPROVAL' ? 'Waiting for you' : state.run ? (streamStatus || toolStatus || 'Working · awaiting tool events') : runStatus === 'COMPLETED' ? 'Finished' : runStatus === 'FAILED' ? 'Failed' : runStatus === 'CANCELLED' ? 'Cancelled' : 'Ready';
    activityButton.textContent = label;
    activityButton.title = attention
      ? (state.run ? 'Poll the active run status and reveal the error' : 'Reveal the error and focus the status area')
      : 'Show live tool details';
    const observed = normalLive.counts();
    activityButton.textContent = attention ? label : observed.failures ? `${observed.failures} activity warning${observed.failures === 1 ? '' : 's'} · View` : state.run && streamStatus ? streamStatus.replace('Tool stream disconnected', 'Live updates disconnected') : `Activity · ${observed.events} events`;
    activityButton.hidden = !attention && !observed.events && !(state.run && streamStatus);
    activity.update({title:state.title || 'Hermes',task:state.messages.filter(m=>m.role==='user').at(-1)?.text.slice(0,200) || 'No task yet',status:label,mode:activeMode(),normalStatus:label,workbenchStatus});
    normalLive.status({ status: label, run: state.run, at: Date.now() });
    updateModeBadge();
  }
  const statusObserver = new MutationObserver(refreshActivity);
  statusObserver.observe(status,{childList:true,characterData:true,subtree:true});
  const stopToolFeed = watchToolFeed(paneId, () => state, getToken, {
    enabled:()=>true,
    event(raw,run) { inlineTools.event(raw,run); normalLive.event(raw); streamStatus=''; toolStatus=inlineTools.summary(); refreshActivity(); },
    status(text) {
      inlineTools.status(text);
      normalLive.connection(/unavailable|ended|disconnect/i.test(text) ? 'disconnected' : /connect/i.test(text) ? 'connecting' : 'connected', text);
      streamStatus=/unavailable|ended/.test(text) ? 'Tool stream disconnected · status polling continues' : /Connecting/.test(text) ? 'Connecting to activity stream' : '';
      refreshActivity();
    }
  }, workspaceId);
  messages.setAttribute('role', 'log');
  messages.setAttribute('aria-label', 'Hermes conversation');
  const notice = el('div', 'agent-notice', 'Hermes can inspect and change this workspace, build apps, and open their previews here. Host terminals run as your account. Workspace context includes layout and app URLs, not private terminal buffers or iframe contents.');
  const progress = el('div', 'agent-progress');
  progress.setAttribute('role', 'status');
  progress.tabIndex = -1;
  const historyRecovery = button('New chat', 'Start a new chat after unavailable history', () => { void switchConversation(chatProfileId(state)); }, 'small-button agent-history-recovery');
  historyRecovery.hidden = true;
  const syncNotice = el('div', 'agent-sync-notice');
  syncNotice.setAttribute('role', 'status');
  const setSyncNotice = (text: string) => { if (syncNotice.textContent !== text) syncNotice.textContent = text; };
  const approvals = el('div', 'agent-approvals');
  const controls = el('div', 'agent-controls');
  const stop = button('Stop', 'Ask Hermes to stop this run', async () => {
    if (!state.run) return;
    stop.disabled = true; queuePaused = true;
    try { await api({ action: 'stop', run_id: state.run }); status.textContent = 'STOPPING'; progress.textContent = 'Stop requested. Waiting for Hermes to finish stopping…'; schedule(); }
    catch (e) { showError(e); }
    finally { stop.disabled = false; }
  }, 'small-button');
  const resume = button('Check status', 'Resume checking the active Hermes run', () => { void poll(); }, 'small-button');
  const steer = button('Send guidance', 'Send composer text to the active Hermes run', async () => {
    const text = input.value.trim(); if (!state.run || !text) return;
    steer.disabled = true;
    try {
      const result = await api({ action: 'steer', run_id: state.run, input: text });
      if (!result.accepted) throw Error('Hermes did not accept this guidance. Your draft is preserved.');
      state.messages.push({ role: 'user', text: `[Guidance to active run] ${text}` }); save(); render();
       if (input.value.trim() === text) { input.value = ''; saveDraft(); }
      progress.textContent = 'Guidance accepted by Hermes. It will be consumed at a safe point; already-running tool actions are not undone.';
    } catch (error) { showError(error); }
    finally { steer.disabled = false; }
  }, 'small-button');
  controls.append(stop, resume, steer);
  const recovery=el('details','agent-submission-recovery'),receiptView=el('pre'),investigated=el('input');
  investigated.type='checkbox';investigated.setAttribute('aria-label','I investigated the original upstream and confirmed no run remains active');
  let receiptHash='';
  const recoveryLabel=el('label','','I investigated the original upstream and confirmed no run remains active');recoveryLabel.append(investigated);
  recovery.append(el('summary','','Submission receipt and recovery'),button('Inspect submission receipt','Read the durable submission receipt without resending',async()=>{try{const result=await api({action:'submission_status'});receiptHash=typeof result.payload_hash==='string'?result.payload_hash:'';receiptView.textContent=JSON.stringify(result,null,2);}catch(error){showError(error);}}),receiptView,recoveryLabel,button('Acknowledge unknown submission','Clear only the exact investigated unknown submission; never replay it',async()=>{if(!receiptHash||!investigated.checked)return;try{receiptView.textContent=JSON.stringify(await api({action:'acknowledge_submission_unknown',payload_hash:receiptHash,upstream_investigated:true}),null,2);receiptHash='';investigated.checked=false;}catch(error){showError(error);}}));
  const settings = el('div', 'agent-settings');
  const titleSettings = el('div', 'agent-settings-row'); titleSettings.append(titleInput, rename, colorInput);
  settings.append(el('h3', '', 'Conversation'), titleSettings, notificationButton,
    el('h3', '', 'Profile and session'), bindingControls, workspaceAgents, notice);
  settings.append(button('Conversation library', 'Browse saved conversations', () => showConversationLibrary(getToken, paneId), 'small-button'));
  inspector.register('settings', 'Settings', settings);
  const troubleshooting = el('div', 'agent-troubleshooting'); troubleshooting.append(status, recovery);
  const inspectWorkbench = button('Inspect Workbench execution', 'Open Workbench checks and recovery without acknowledging or replaying anything', () => { inspector.close(); setMode('workbench'); workbenchHost.querySelector<HTMLButtonElement>('[aria-label="Checks workbench view"]')?.click(); }, 'small-button');
  troubleshooting.append(el('p', '', 'Unknown execution is not replayed automatically. A shared-lane warning may belong to a Workbench worker or check; inspect its authoritative record before using any recovery acknowledgement.'), inspectWorkbench);
  inspector.register('troubleshooting', 'Troubleshooting', troubleshooting);
  const unknownAction = button('Execution outcome unknown — no automatic replay · Inspect recovery', 'Open submission receipt and recovery', () => {
    recovery.open = true; openPanel('troubleshooting', unknownAction);
  }, 'small-button agent-unknown-action');
  unknownAction.hidden = true;
  const form = el('form', 'chat-form');
  const input = el('textarea');
  let durableDraft: ReturnType<typeof createConversationDraft> | undefined;
  let draftLinked = false, draftEditedBeforeLink = false;
  input.placeholder = 'Ask Hermes… (up to 100,000 characters)'; input.rows = 2; input.maxLength = 100000;
  input.setAttribute('aria-label', 'Message to Hermes');
  loadDraft();
  const draftStatus = el('div', 'conversation-draft-status'); draftStatus.setAttribute('role', 'status');
  durableDraft = createConversationDraft({cacheNamespace:paneId,token:getToken,value:()=>input.value,
    restore:text=>{input.value=text;try{sessionStorage.setItem(draftKey(),text);}catch{}sizeComposer();},
    status:(text,conflict)=>{
      draftStatus.replaceChildren(el('span','',text));
      if(conflict) {
        const preview=el('details');preview.append(el('summary','','Compare preserved drafts'),el('h4','','This tab'),el('pre','',conflict.local),el('h4','','Host'),el('pre','',conflict.remote));
        draftStatus.append(preview,button('Use host draft','Replace composer with host draft',conflict.useRemote),button('Keep my draft','Save this tab draft over reviewed host draft',conflict.keepLocal));
      }
    },
  });
  const selectDraft = () => {
    durableDraft?.select({workspace_id:workspaceId,profile_id:chatProfileId(state),session_id:state.session},input.value,draftEditedBeforeLink);
    draftLinked=true;draftEditedBeforeLink=false;
  };
  function sizeComposer() {
    input.style.height = '64px';
    input.style.height = `${Math.min(96, Math.max(64, input.scrollHeight))}px`;
  }
  input.addEventListener('input', () => { if(!draftLinked)draftEditedBeforeLink=true; saveDraft(); sizeComposer(); });
  let toolsDialog: HTMLDialogElement | undefined;
  function openTools() {
    toolsDialog?.close();
    const requested = scope();
    const scopedApi = (payload: Record<string, unknown>) => api(payload, requested);
    const dialog = document.createElement('dialog'); toolsDialog = dialog;
    dialog.className = 'hermes-tools-dialog'; dialog.setAttribute('aria-label', 'Hermes tools');
    const close = button('Close', 'Close Hermes tools', () => dialog.close());
    dialog.append(el('h2', '', 'Hermes tools'), close);
    for (const extension of workspaceExtensions) dialog.append(button(extension.title, extension.label, () => {
      dialog.close(); void extension.activate({token:getToken,api:scopedApi}).catch(error=>{ if (current(requested)) window.alert(`Module ${extension.id} could not open: ${String(error)}`); });
    }));
    const live = button('Live activity', 'Open live Hermes activity', () => { if (current(requested) && state.run) { dialog.close(); const run = state.run; liveController?.abort(); liveController = new AbortController(); const signal = liveController.signal; void import('./hermes-surfaces').then(m => { if (current(requested) && !signal.aborted) return m.showLive(getToken, requested.session_id, run, requested.profile_id, requested.pane_id, signal, requested.revision ?? 0); }).catch(e => { if (current(requested)) window.alert(String(e)); }); } });
    live.disabled = true; dialog.append(live);
    if (state.run) void scopedApi({action:'capabilities'}).then(data => { if (current(requested)) live.disabled = !data.features?.run_events_sse; }).catch(() => { if (current(requested)) live.title = 'Streaming unavailable; use Tool activity'; });
    const activity = el('div', 'hermes-activity');
    let activitySnapshot = '';
    let activityTimer: ReturnType<typeof setTimeout> | undefined;
    async function loadActivity() {
      try {
        const result = await scopedApi({ action: 'activity' });
        if (!dialog.open || disposed) return;
        if (activitySnapshot === JSON.stringify(result)) { activityTimer = setTimeout(() => { void loadActivity(); }, 3000); return; }
        activitySnapshot = JSON.stringify(result);
        activity.replaceChildren(el('p', '', result.note));
        if (!result.activity?.length) activity.append(el('p', '', 'No persisted tool calls yet.'));
        for (const item of result.activity || []) {
          const detail = document.createElement('details');
          detail.append(el('summary', '', `${item.kind === 'call' ? 'CALL' : 'RESULT'} · ${item.name}`), el('pre', '', item.detail));
          activity.append(detail);
        }
      } catch (error) { if (dialog.open && current(requested)) activity.textContent = error instanceof Error ? error.message : 'Activity unavailable'; }
      if (dialog.open && current(requested)) activityTimer = setTimeout(() => { void loadActivity(); }, 3000);
    }
    dialog.append(button('Tool activity', 'Inspect actual Hermes tool calls and results', () => { clearTimeout(activityTimer); void loadActivity(); }), activity);
    dialog.addEventListener('close', () => clearTimeout(activityTimer));
    dialog.append(el('h3', '', 'Hermes conversation history'),
      el('p', '', 'Open the conversation library for Hermes titles and IDs, Orbit names, pins and archives. Drafts save privately on the host with a tab recovery cache. Recent transcripts below are tab-local. Exports may contain private conversation content.'),
      button('Conversation library', 'Browse durable Hermes sessions by profile', () => { dialog.close(); showConversationLibrary(getToken,paneId); }));
    dialog.append(button('Export conversation', 'Download this Hermes conversation', () => {
      const blob = new Blob([transcript(state)], { type: 'text/plain;charset=utf-8' });
      const url = URL.createObjectURL(blob); const a = document.createElement('a');
      a.href = url; a.download = `${chatProfileId(state)}-${state.session}.txt`; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
    }));
    dialog.append(el('h3', '', 'Workspace requests'));
    for (const [label, prompt] of [
      ['Inspect workspace', 'Inspect this workspace using the workspace controller. Summarize its current windows, panes, layout, and available controls. Do not change anything yet.'],
      ['Organize windows', 'Inspect this workspace and organize the existing windows for readability. Preserve all pane IDs, conversations, and running shells. Use live workspace controls and verify the browser acknowledgement.'],
      ['Explore built-in tools', 'Help me choose from Orbit’s built-in search, interactive results, voice transcript, Data workbench, document library, run traces and optional browser/MCP Apps surfaces. Use docs/TECHNOLOGY_FEATURES.md and ask what I want to accomplish if it is not yet clear. Explain configuration prerequisites and explicit import/draft steps; do not claim you can read private contents from layout context.'],
      ['Build an app', 'Help me build a tool in this workspace. Use my stated goal, or ask what it should do if that is missing. Reuse a suitable built-in surface when possible; otherwise build, test and publish a content-addressed sandboxed plugin. Preserve existing windows and use independent widget instances when appropriate.'],
      ['Change appearance', 'Help me change the workspace appearance. Use my stated preferences, or ask what look I want if that is missing. Use the no-reload appearance workflow in docs/WORKSPACE_CONTROL.md, preserve unrelated customizations, and do not restart services.'],
    ]) dialog.append(button(label, label, () => { input.value = prompt; input.dispatchEvent(new Event('input')); dialog.close(); input.focus(); }));
    dialog.append(el('p', '', 'Shortcuts prepare a draft; nothing is sent until you press Send.'));
    dialog.append(el('h3', '', 'Recent conversations'));
    const archived = history.filter(s => chatBindingKey(s) !== chatBindingKey(state));
    if (!archived.length) dialog.append(el('p', '', 'Completed conversations appear here after New chat.'));
    for (const saved of archived) {
      const title = saved.title || saved.messages.find(m => m.role === 'user')?.text.slice(0, 80) || saved.session;
      const restore = button(title, `Restore conversation: ${title}`, () => {
        if (!current(requested) || switchBlocked()) return;
        void switchConversation(chatProfileId(saved), saved.session);
      });
      restore.disabled = switchBlocked(); dialog.append(restore);
    }
    dialog.addEventListener('close', () => { dialog.remove(); input.focus(); });
    document.body.append(dialog); dialog.showModal();
  }
  // The orbit menu can open this pane's tools and conversations directly.
  const onOpenTools = (event: Event) => {
    if ((event as CustomEvent<{ paneId?: string }>).detail?.paneId === paneId) openTools();
  };
  window.addEventListener('orbit-open-hermes-tools', onOpenTools);
  const onOpenLibrary = (event:Event) => {if((event as CustomEvent<{paneId?:string}>).detail?.paneId===paneId)showConversationLibrary(getToken,paneId);};
  let requestedSelection: {profileId:string;sessionId:string} | undefined;
  const applyRequestedSelection = () => {
    if(!requestedSelection || !bindingReady || disposed || pending || busy || polling || switching)return;
    const target=requestedSelection;requestedSelection=undefined;
    void switchConversation(target.profileId,target.sessionId);
  };
  const onSelectConversation = (event:Event) => {
    const detail=(event as CustomEvent<{paneId?:string;profileId?:string;sessionId?:string}>).detail;
    if(detail?.paneId!==paneId || typeof detail.profileId!=='string' || typeof detail.sessionId!=='string')return;
    requestedSelection={profileId:detail.profileId,sessionId:detail.sessionId};applyRequestedSelection();
  };
  const flushDraft = () => durableDraft?.flush();
  window.addEventListener('orbit-open-conversation-library',onOpenLibrary);
  window.addEventListener('orbit-select-conversation',onSelectConversation);
  window.addEventListener('pagehide',flushDraft);
  const send = button('↑', 'Send message to Hermes', () => { void submit(); });
  function update() {
    // The single native/runtime lane is global: while it is held by another
    // pane's Workbench task (or its outcome is unknown) this pane must not send
    // or drain, unless this pane's own normal run owns the current state.
    const blocked = laneBlocked();
    send.disabled = busy || switching || !bindingReady || blocked;
    newChat.disabled = switchBlocked() || !getToken();
    historyRecovery.disabled = newChat.disabled;
    newChat.title = !getToken() ? 'Connect host to start a new chat' : !bindingReady ? 'Connecting this conversation to the host' : switchBlocked() ? 'Finish pending work, approvals and queued messages before starting a new chat' : 'Start a separate Hermes conversation';
    profileSelect.disabled = switchBlocked() || !getToken() || !metadataReady;
    sessionSelect.disabled = switchBlocked() || !getToken() || !sessionsReady;
    applyBinding.disabled = switchBlocked() || !getToken() || !metadataReady || !sessionsReady;
    refreshBindings.disabled = switchBlocked() || !getToken();
    refreshBindings.title = getToken() ? 'Load available Hermes profiles and sessions' : 'Connect host first to load profiles';
    const sendLabel = state.run ? 'Queue' : 'Send';
    if (send.textContent !== sendLabel) send.textContent = sendLabel;
    send.title = !bindingReady ? 'Connect host and wait for this conversation to link' : blocked ? laneReason() || 'Shared agent lane is busy.' : state.run ? 'Queue message after the current turn' : 'Send message to Hermes';
    drainButton.disabled = blocked;
    stop.hidden = !state.run; resume.hidden = !state.run; steer.hidden = !state.run;
    // Allow composing the next message while Hermes works; Send remains disabled.
    input.disabled = false;
    refreshConversationRecipient();
  }
  // Stable, recognizable recipient identity, used identically on registration,
  // update and the confirmation dialog. The pane discriminator leads so the
  // registry's 200-character title bound can never clip it, and every segment is
  // bounded so duplicate window names or conversation titles stay distinguishable.
  function conversationRecipientLabel() {
    const windowName = (body.closest('.monitor')?.querySelector('.monitor-bar strong')?.textContent ?? '').trim().slice(0, 24);
    const conversation = (state.title || state.session).slice(0, 36);
    const profile = chatProfileId(state).slice(0, 20);
    // Imported pane IDs can share prefixes; retain the complete validated ID
    // (at most 100 characters), with the full label still below 200 characters.
    return [`pane ${paneId}`, windowName || 'chat pane', conversation, profile].join(' · ');
  }
  function refreshConversationRecipient() {
    const key=JSON.stringify(scope());
    const available=!disposed && bindingReady && !!getToken() && !switching && !busy && !pending;
    if(!conversationRecipient || recipientBinding!==key) {
      conversationRecipient?.dispose();recipientBinding=key;
      const requested=scope();
      conversationRecipient=registerConversationRecipient({id:`chat:${workspaceId}:${paneId}`,title:conversationRecipientLabel(),available,
        receive:delivery=>{
          if(!current(requested) || !bindingReady || switching || busy || pending || !getToken())return {accepted:false,reason:'The conversation binding changed or is busy.'};
          const original=input.value;
          const appended=original ? `${original}\n\n${delivery.text}` : delivery.text;
          if(appended.length>100000)return {accepted:false,reason:'Appending would exceed the draft limit. Shorten the draft first.'};
          return new Promise(resolve=>{
            const dialog=el('dialog','hermes-tools-dialog');dialog.setAttribute('aria-label','Preview conversation draft');
            const preview=el('pre','',appended);preview.style.whiteSpace='pre-wrap';preview.style.maxHeight='50vh';preview.style.overflow='auto';
            let accepted=false;
            dialog.append(el('h2','','Preview draft insertion'),el('p','',`Recipient: ${conversationRecipientLabel()}. Existing text is preserved; nothing will be sent.`),preview,
              button('Append to draft','Confirm append to conversation draft',()=>{
                if(!current(requested) || switching || busy || pending || input.value!==original || !getToken()){dialog.close();return;}
                input.value=appended;saveDraft();sizeComposer();accepted=true;setMode('normal');dialog.close();
              }),button('Cancel','Cancel draft insertion',()=>dialog.close()));
            const abort=()=>dialog.close();controller.signal.addEventListener('abort',abort,{once:true});
            dialog.addEventListener('close',()=>{controller.signal.removeEventListener('abort',abort);dialog.remove();resolve(accepted?{accepted:true}:{accepted:false,reason:'Insertion cancelled or recipient draft/binding changed.'});if(accepted)input.focus();},{once:true});
            document.body.append(dialog);dialog.showModal();
          });
        }});
    }else conversationRecipient.update({title:conversationRecipientLabel(),available});
  }
  function laneBlocked() {
    // The shared native lane is global; when it is held by another pane's
    // Workbench task (or its outcome is unknown) this pane must not send, unless
    // this pane's own normal run actually owns the current state.
    return (workbenchLaneActive || laneUnknown) && !state.run;
  }
  function laneReason() {
    if (laneUnknown) return 'Execution outcome unknown · the shared agent lane is fenced until the owner reconciles it.';
    if (workbenchLaneActive) return 'Shared agent lane is busy.';
    return '';
  }
  function recomputeLane() {
    // The Workbench pane contributes only when it actually observed a lane read.
    // An unobserved pane lane is never a fence; the shared_chat execution_lane
    // stays authoritative and is only cleared by an explicit server value.
    const wbObserved = wbLane.observed === true;
    const agentBusy = (wbObserved && wbLane.agent_busy) || (sharedLanePresent && sharedLane.agent_busy);
    const jobBusy = (wbObserved && wbLane.job_busy) || (sharedLanePresent && sharedLane.job_busy);
    laneUnknown = (wbObserved && wbLane.unknown) || (sharedLanePresent && sharedLane.unknown);
    workbenchLaneActive = (agentBusy && !state.run) || jobBusy;
    // The queue is held, never auto-drained, until the owner sends explicitly.
    if (workbenchLaneActive || laneUnknown) queuePaused = true;
    unknownAction.hidden = !laneUnknown;
    activityButton.hidden = status.textContent !== 'ATTENTION' && !normalLive.counts().events && !(state.run && streamStatus);
    updateModeBadge();
    update();
  }
  function updateModeBadge() {
    // Both statuses stay visible; the hidden mode's status keeps updating.
    const normalStatusText = status.textContent || 'READY';
    const workbenchHumanStatus = wbLane.job_busy ? 'Running check' : ({Running:'Working',Waiting:'Waiting',Failed:'Needs attention','Stop requested':'Stopping','Result pending':'Result pending'} as Record<string,string>)[workbenchBadge.status] || (workbenchLaneActive ? 'Working' : 'Ready');
    humanStatus.textContent = laneUnknown ? 'Unknown outcome' : normalStatusText === 'WAITING FOR APPROVAL' ? 'Needs approval' : ['ATTENTION','FAILED'].includes(normalStatusText) ? 'Needs attention' : activeMode() === 'workbench' ? workbenchHumanStatus : state.run || busy ? 'Working' : 'Ready';
    humanStatus.title = humanStatus.textContent;
    humanStatus.setAttribute('aria-label', `${humanStatus.textContent} · Inspect agent status and activity`);
    // Prefer the explicit Workbench state (Running/Waiting/Failed/Stopped/
    // Result pending/counts). Only fall back to the lane wording when no specific
    // state is known, so a live run is never shown as a generic "Lane busy".
    const definiteWorkbench = ['Running', 'Waiting', 'Failed', 'Stop requested', 'Stopped', 'Result pending', 'Execution outcome unknown'];
    const explicitWorkbench = definiteWorkbench.includes(workbenchBadge.status) ? workbenchBadge.status : '';
    const workbenchLabel = explicitWorkbench
      || (laneUnknown ? 'Execution outcome unknown' : (workbenchBadge.laneBusy || workbenchLaneActive ? 'Lane busy' : (workbenchBadge.status || 'Idle')));
    const count = workbenchBadge.pending + workbenchBadge.results;
    const normal = modeButtons.get('normal');
    const workbench = modeButtons.get('workbench');
    if (normal) normal.status.textContent = ['ATTENTION', 'WAITING FOR APPROVAL', 'FAILED'].includes(normalStatusText) ? normalStatusText : '';
    if (workbench) workbench.status.textContent = count && workbenchLabel === 'Idle'
      ? [workbenchBadge.pending && `${workbenchBadge.pending} pending`, workbenchBadge.results && `${workbenchBadge.results} results`].filter(Boolean).join(' · ')
      : definiteWorkbench.includes(workbenchLabel) || workbenchLabel === 'Lane busy' ? workbenchLabel : '';
    for (const [mode, entry] of modeButtons) entry.button.setAttribute('aria-pressed', String(mode === activeMode()));
    modeControl.title = `Normal: ${normalStatusText} · Workbench: ${workbenchLabel}`
      + (workbenchBadge.pending ? ` · ${workbenchBadge.pending} pending` : '')
      + (workbenchBadge.results ? ` · ${workbenchBadge.results} result(s)` : '')
      + (laneBlocked() ? ` · ${laneReason()}` : '');
    modeControl.dataset.lane = laneUnknown ? 'unknown' : workbenchLaneActive ? 'busy' : 'idle';
    // Cross-mode hidden badge: annotate the inactive button with pending counts.
    const inactive = modeButtons.get(activeMode() === 'normal' ? 'workbench' : 'normal');
    if (inactive) inactive.button.dataset.badge = String(inactive.button.dataset.mode === 'workbench' ? count : state.queue?.length ?? 0);
  }
  function ensureWorkbench() {
    if (workbench || disposed) return workbench;
    workbench = mountPaneWorkbench({
      paneId,
      body: workbenchHost,
      workspaceId,
      getToken,
      binding: () => ({ profileId: chatProfileId(state), sessionId: state.session, bindingRevision: state.binding_revision ?? 0 }),
      messages: () => state.messages.map((message, index) => ({ id: String(index), role: message.role, text: message.text })),
      prefs: panePrefs,
      onPrefs: (patch) => { panePrefs = writePanePrefs(workspaceId, paneId, patch); },
      onBadge: (next) => {
        workbenchBadge = next;
        workbenchStatus = next.status;
        updateModeBadge();
        refreshActivity();
        update();
      },
      // The Workbench pane's own live lane observation. Combined with (but never
      // overriding) the shared_chat execution_lane signal.
      onLane: (lane) => {
        wbLane = { agent_busy: lane.agent_busy === true, job_busy: lane.job_busy === true, unknown: lane.unknown === true, observed: lane.observed === true };
        recomputeLane();
      },
      timeline: workbenchTimeline,
      onOpenNormal: () => {
        // Focus the paired Normal chat, or create one explicitly from here; never
        // silently replace the original.
        window.dispatchEvent(new CustomEvent('orbit-open-normal-window', { detail: { fromPaneId: paneId } }));
      },
      onError: showError,
    });
    return workbench;
  }
  // View toggle only: it never starts, stops, queues or drains any work. Normal
  // DOM is hidden by attribute, so the same nodes, session, draft and queue persist.
  // While Project Workbench is disabled the stored preference above is retained
  // and only the rendered view falls back to Normal.
  function setMode(next: PaneMode, persist = true) {
    if (disposed) return;
    paneMode = next;
    if (persist) panePrefs = writePanePrefs(workspaceId, paneId, { mode: next });
    const view = activeMode();
    chatNormal.hidden = view !== 'normal';
    workbenchHost.hidden = view !== 'workbench';
    for (const [mode, entry] of modeButtons) entry.button.setAttribute('aria-pressed', String(mode === view));
    // Two persistent, independent timeline hosts. Switching only toggles
    // `hidden`; neither instance is moved, rebuilt, reset or reconnected.
    if (view === 'workbench') ensureWorkbench()?.setVisible(true);
    else workbench?.setVisible(false);
    updateModeBadge();
    update();
  }
  function render() {
    if(!state.run) {toolStatus='';streamStatus='';}
    refreshActivity();
    titleInput.value = state.title || '';
    heading.textContent = state.title || 'Hermes';
    colorInput.value = state.color || '#b5f268';
    body.style.setProperty('--accent', state.color || '');
    body.style.background = state.color ? `color-mix(in srgb, ${state.color} 12%, #10141c)` : '';
    badge.style.borderBottom = state.color ? `2px solid ${state.color}` : '';
    queueList.replaceChildren();
    for (const [index, text] of (state.queue || []).entries()) {
      const row = el('div');
      row.append(el('span', '', `${index + 1}. ${text.slice(0, 160)}`), button('Remove', 'Remove queued message', () => { if (busy) return; state.queue?.splice(index, 1); save(); render(); }, 'small-button'));
      queueList.append(row);
    }
    if (state.queue?.length) {
      queueList.prepend(el('small', '', 'Queued in order · keep this tab open. Errors or Stop pause delivery.'));
      if (!state.run && !busy) queueList.append(drainButton);
    }
    messageRenderer.render(state.messages, chatBindingKey(state));
    inlineTools.sync(chatBindingKey(state), state.run);
    sizeComposer();
    update();
  }
  async function api(payload: Record<string, unknown>, requested = scope(), passive = false) {
    if (!current(requested)) throw new StaleRequest();
    const token = getToken();
    if (!token) throw Error('Use “Connect host” in the top bar first.');
    // Foreground operations supersede any earlier shared-state snapshot, even
    // when the operation finishes before that snapshot's response arrives.
    if (!passive) { sharedEpoch++; pending++; update(); }
    try {
    const response = await fetch('/api/agent', {
      method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...payload, session_id: requested.session_id, profile_id: requested.profile_id, workspace_id: requested.workspace_id, pane_id: requested.pane_id, expected_binding_revision: requested.revision ?? 0 }),
      signal: AbortSignal.any([controller.signal, AbortSignal.timeout(30000)]),
    });
    const data = await response.json();
    if (!current(requested)) throw new StaleRequest();
    if (!response.ok) {
      if (['profiles', 'sessions', 'select_session'].includes(String(payload.action)) && (response.status === 404 || response.status === 501 || /unknown action|unsupported action|invalid action/i.test(String(data.error)))) throw Error('Profile/session selection is unsupported by this backend. The current conversation is preserved.');
      throw Error(data.error || `Request failed (${response.status}).`);
    }
    return data;
    } catch (error) {
      if (!current(requested)) throw new StaleRequest();
      throw error;
    } finally { if (!passive) { pending--; if (!disposed) update(); } }
  }
  function showError(error: unknown) {
    if (disposed || error instanceof StaleRequest) return;
    status.textContent = 'ATTENTION';
    progress.textContent = error instanceof Error ? error.message : 'Connection failed.';
    historyRecovery.hidden = !/Conversation history is unavailable/.test(progress.textContent);
    update();
  }
  function schedule() {
    clearTimeout(timer);
    const requested = scope();
    if (!disposed && state.run) timer = setTimeout(() => { if (current(requested)) void poll(); }, 1500);
  }
  async function poll() {
    if (disposed || polling || !state.run) return;
    const requested = scope(), run = state.run;
    clearTimeout(timer); polling = true; update();
    try {
      const data = await api({ action: 'status', run_id: run }, requested);
      if (disposed) return;
      status.textContent = String(data.status || 'working').replaceAll('_', ' ').toUpperCase();
      approvals.replaceChildren();
      if (['completed', 'failed', 'cancelled', 'interrupted'].includes(data.status)) {
        state.messages.push({ role: 'assistant', text: data.output || (data.status === 'completed' ? 'Hermes finished without a text reply.' : data.error || `Run ${data.status}.`) });
        state.messages = state.messages.slice(-100);
        const finishedRun = state.run;
        state.run = undefined; save(); render();
        progress.textContent = data.status === 'completed' ? '' : String(data.error || `Run ${data.status}. Check the conversation and troubleshooting details.`);
        notifyReply(finishedRun, data.status === 'completed');
        // Ordinary normal-run completion may auto-drain only when the shared lane
        // is idle and not unknown. A Workbench-held queue stays held until the
        // owner sends explicitly.
        if (data.status === 'completed' && !queuePaused && !workbenchLaneActive && !laneUnknown) void drainQueue();
        return;
      }
      progress.textContent = data.status === 'waiting_for_approval' ? 'Hermes needs your permission before continuing.' : 'Hermes is working. You can stop the run. Replies appear when the turn completes.';
      if (data.status === 'waiting_for_approval') {
        for (const a of data.approvals || []) approvals.append(el('pre', '', `${a.command}\n${a.reason}`));
        // No blind approval when details are unavailable.
        if (data.approvals?.length) {
          for (const [label, choice] of [['Allow once', 'once'], ['Deny', 'deny']]) approvals.append(button(label, `${label} for the pending tool action`, async () => {
            if (!current(requested) || state.run !== run) return;
            try { await api({ action: 'approval', run_id: run, choice }, requested); approvals.replaceChildren(); schedule(); }
            catch (e) { showError(e); }
          }, 'small-button'));
        } else approvals.append(el('p', '', 'Approval details unavailable. Check the Hermes dashboard or stop this run.'));
      }
      update(); schedule();
    } catch (error) { showError(error); }
    finally { polling = false; if (!disposed) update(); }
  }
  async function submit(queuedText?: string) {
    const text = queuedText ?? input.value.trim();
    if (!text || busy || disposed || switching) return;
    if (!bindingReady) { showError(Error('Connect host and wait for this conversation to link. Your draft is preserved.')); return; }
    // Explicit guard before any queue or draft mutation: the Enter path must not
    // dispatch into a shared lane held by another pane's Workbench task.
    if (laneBlocked()) { showError(new Error(laneReason() || 'Shared agent lane is busy.')); return; }
    const requested = scope();
    sharedEpoch++;
    if (state.run) {
      if (queuedText) return;
      if ((state.queue?.length || 0) >= 20) { showError(Error('Queue is full (20 messages).')); return; }
      (state.queue ||= []).push(text); save(); input.value = '';
      saveDraft();
      render(); return;
    }
    if (!getToken()) { showError(new Error('Use “Connect host” in the top bar first.')); return; }
    busy = true; update(); status.textContent = 'CONNECTING'; progress.textContent = 'Sending to Hermes…';
    try {
      await ensureWorkspaceSynced();
      const data = await api({ action: 'start', input: text }, requested);
      historyRecovery.hidden = true;
      state.run = data.run_id;
      if (queuedText) state.queue?.shift();
      state.messages.push({ role: 'user', text });
      state.messages = state.messages.slice(-100); save();
      if (!disposed) { if (!queuedText && input.value.trim() === text) { input.value = ''; saveDraft(); } render(); status.textContent = 'WORKING'; schedule(); }
    } catch (error) { showError(error); }
    finally { busy = false; if (!disposed) render(); }
  }
  // Visible Normal-mode entry point into the Workbench handoff. It copies the
  // current draft in memory to the handoff preview and switches the view only;
  // the Normal composer is untouched and nothing is captured, queued or created.
  const workbenchTask = button('Set up task', 'Open goal-first Workbench setup with your current draft; nothing is created until you confirm', () => {
    const statement = input.value;
    setMode('workbench');
    ensureWorkbench()?.openHandoff({ statement });
  }, 'small-button');
  workbenchTask.setAttribute('aria-label', 'Create Workbench task');
  // Prominent separate-window action: creates/focuses a dedicated Workbench pane
  // in its own window without changing this pane, its draft or its conversation.
  const openWorkbenchWindow = button('Open Workbench window', 'Open a separate Workbench window beside this chat; nothing is copied or sent', () => {
    window.dispatchEvent(new CustomEvent('orbit-open-workbench-window', { detail: { paneId } }));
  }, 'small-button');
  settings.append(openWorkbenchWindow);
  // Experimental surface gate. The Workbench switch, goal handoff, separate
  // window and task-result cards stay hidden until the owner enables Project
  // Workbench in Orbit settings. Disabling never deletes durable tasks,
  // candidates or results and never overwrites this pane's stored mode.
  function applyExperimentalGates() {
    if (disposed) return;
    const on = workbenchAvailable();
    modeControl.hidden = !on;
    setUpTaskEntry.hidden = !on;
    workbenchTask.hidden = !on;
    openWorkbenchWindow.hidden = !on;
    inspectWorkbench.hidden = !on;
    experimentalNotice.hidden = on || panePrefs.mode !== 'workbench';
    if (on) void refreshTaskCards();
    else { taskCards.replaceChildren(); taskCards.hidden = true; cardsDigest = ''; }
    setMode(paneMode, false);
  }
  const unsubscribeExperimental = subscribeExperimental(applyExperimentalGates);
  send.classList.add('chat-send');
  workbenchTask.classList.add('chat-composer-action');
  openWorkbenchWindow.classList.add('chat-composer-action');
  form.append(input, workbenchTask, send);
  form.onsubmit = e => { e.preventDefault(); void submit(); };
  input.onkeydown = e => { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); void submit(); } };
  chatNormal.append(strip, experimentalNotice, inlineTools.root, messages, messageRenderer.latest, taskCards, syncNotice, progress, historyRecovery, approvals, unknownAction, controls, queueList, draftStatus, form);
  body.append(chatNormal, workbenchHost);
  if (toolbar) {
    toolbar.classList.add('agent-pane-head');
    badge.classList.add('agent-toolbar-meta');
    toolbar.insertBefore(badge, toolbar.children[1] || null);
  } else {
    chatNormal.prepend(badge);
  }
  render();
  // Restore the persisted view after the DOM exists, honoring the experimental
  // gate. This only reads host state (owner read APIs); it never starts a run or
  // drains the queue.
  applyExperimentalGates();
  async function syncShared() {
    if (sharing || switching || pending || busy || polling || disposed || !getToken()) return;
    const requested = scope(), epoch = sharedEpoch;
    sharing = true;
    if (!bindingReady) setSyncNotice('Connecting conversation…');
    try {
      await ensureWorkspaceSynced();
      const data = await api({action:'shared_chat', ...(document.documentElement.dataset.mobile === 'true' ? {} : {initial:state})}, requested, true);
      if (!current(requested) || epoch !== sharedEpoch || busy || polling || switching) return;
      // Optional global lane signal carried by the existing shared_chat read.
      // No extra polling loop and no upstream call: an absent field (older
      // backend or test mock) is not treated as idle-confirmation and does not
      // globally disable sending; the authenticated backend fence stays authoritative.
      if (data?.execution_lane && typeof data.execution_lane === 'object') {
        sharedLane = {
          agent_busy: data.execution_lane.agent_busy === true,
          job_busy: data.execution_lane.job_busy === true,
          unknown: data.execution_lane.unknown === true,
        };
        sharedLanePresent = true;
        recomputeLane();
      }
      if (!data.state) { setSyncNotice('Open this chat on the desktop and reload once to link its existing conversation. Your draft is preserved.'); return; }
      if (validChat(data.state)) {
        bindingReady = Number.isSafeInteger(data.state.binding_revision);
        setSyncNotice(bindingReady ? '' : 'This backend did not supply a conversation revision. Reconnect to a supported host.');
        const next = data.state as ChatState;
        if (chatBindingKey(next) !== chatBindingKey(state) && (state.run || state.queue?.length)) {
          showError(Error('This pane changed binding elsewhere while a run or queue was pending. Finish or remove pending work before refreshing.')); return;
        }
        if (chatBindingKey(next) === chatBindingKey(state)) {
          next.queue = state.queue;
          next.title = next.title ?? state.title;
          next.color = state.color ?? next.color;
        }
        if (JSON.stringify(next) !== JSON.stringify(state)) {
          acceptState(next);
          if(state.run) schedule();
        }
        selectDraft(); durableDraft?.retry(); applyRequestedSelection();
        if (!catalogRequested && !switching) void loadProfiles();
      } else throw Error('The backend returned an invalid chat binding. The current conversation is preserved.');
    } catch (e) {
      if (current(requested) && epoch === sharedEpoch && !(e instanceof StaleRequest)) {
        setSyncNotice(bindingReady ? 'Conversation refresh unavailable. Your draft is saved; sending still checks the current conversation with the host.' : 'Could not link this conversation. Check the host connection; your draft is preserved.');
      }
    } finally { sharing = false; if (!disposed) update(); }
  }
  function acceptState(next: ChatState) {
    const changed = chatBindingKey(next) !== chatBindingKey(state) || next.binding_revision !== state.binding_revision;
    if (changed) {
      saveDraft(); generation++; clearTimeout(timer); toolsDialog?.close(); liveController?.abort(); approvals.replaceChildren();
      taskCards.replaceChildren(); taskCards.hidden = true; cardsDigest = '';
      queuePaused = true; toolStatus = ''; streamStatus = '';
    }
    state = next;
    if (changed) {
      workbench?.invalidateBinding();
      loadDraft(); resetBindingControls(); status.textContent = state.run ? 'WORKING' : 'READY'; progress.textContent = ''; historyRecovery.hidden = true;
      selectDraft();
      // A binding change resets the shared timeline (Normal feed and idle Workbench scope).
      normalLive.reset(chatBindingKey(state));
    }
    save(); render();
  }
  async function switchConversation(targetProfile: string, targetSession?: string) {
    if (switchBlocked()) { showError(Error('Wait for pending work, approvals, and queued messages before switching.')); return; }
    if (!Number.isSafeInteger(state.binding_revision)) { showError(Error('Session switching is unsupported until the backend supplies an authoritative binding revision. Refresh the connection first.')); return; }
    const requested = scope();
    switching = true; sharedEpoch++; update();
    try {
      const data = await api({action:'select_session',target_profile_id:targetProfile,...(targetSession ? {target_session_id:targetSession} : {}),expected_binding_revision:requested.revision}, requested);
      if (!validChat(data.state) || !Number.isSafeInteger(data.state.binding_revision) || chatProfileId(data.state) !== targetProfile || (targetSession && data.state.session !== targetSession)) throw Error('Session switching is unsupported: the backend did not return the requested authoritative binding. Refresh before any further actions.');
      remember(); acceptState(data.state);
      if (state.run) schedule();
    } catch(e) {showError(e);} finally { switching = false; if (!disposed) { update(); if (!catalogRequested) void loadProfiles(); } }
  }
  const sharedTimer = setInterval(() => {void syncShared(); void refreshTaskCards();}, 1800);
  void syncShared();
  const onUnlock = () => {
    void syncShared();
    if (state.run) void poll();
    if (getToken()) normalLive.connection('connecting', 'Connecting to activity stream');
    // A remembered Workbench project/attempt reconnects read-only lane/badge
    // monitoring while Normal is selected, without mounting execution controls,
    // and only while the experimental surface is enabled.
    if (getToken() && panePrefs.projectId && workbenchAvailable()) ensureWorkbench()?.setVisible(paneMode === 'workbench');
  };
  window.addEventListener('orbit-host-connected', onUnlock);
  if (state.run) {
    progress.textContent = 'A saved run may still be active. Connect host to check its status. Closing the pane does not stop Hermes.';
    if (getToken()) void poll();
  }
  return () => { messageRenderer.dispose(); saveDraft(); durableDraft?.dispose(); disposed = true; conversationRecipient?.dispose(); generation++; unsubscribeExperimental(); statusObserver.disconnect(); activity.dispose(); clearInterval(sharedTimer); stopToolFeed(); inlineTools.dispose(); workbench?.dispose(); timeline.dispose(); workbenchTimeline.dispose(); inspector.dispose(); overflowMenu.remove(); toolsDialog?.close(); liveController?.abort(); clearTimeout(timer); controller.abort(); document.removeEventListener('pointerdown', onOutsideMenu); window.removeEventListener('orbit-host-connected', onUnlock); window.removeEventListener('orbit-open-hermes-tools', onOpenTools); window.removeEventListener('orbit-open-conversation-library',onOpenLibrary);window.removeEventListener('orbit-select-conversation',onSelectConversation);window.removeEventListener('pagehide',flushDraft); };
}
