import { workspaceExtensions } from './workspace-extensions';
import { watchToolFeed } from './tool-feed';
import { createInlineTools } from './inline-tools';
import { registerActivity, openAgentOverview } from './agent-activity';
import './hermes-tools.css';
import './agent-toolbar.css';
import { el, button } from './dom';
import { workspaceId, ensureWorkspaceSynced } from './workspace-sync';

import { archiveChat, validChat, transcript, chatProfileId, chatBindingKey, type ChatState } from './chat-storage';
export function createAgentChat(body: HTMLElement, paneId: string, getToken: () => string, toolbar?: HTMLElement) {
  const storageKey = `orbit-hermes-chat:${paneId}`;
  const archiveKey = `${storageKey}:archive`, legacyDraftKey = `${storageKey}:draft`;
  const draftKey = () => `${legacyDraftKey}:${chatBindingKey(state)}`;
  function saveDraft() { try { sessionStorage.setItem(draftKey(), input.value); } catch {} }
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
  const fresh = (): ChatState => ({ session: `orbit-${crypto.randomUUID()}`, messages: [] });
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
  let generation = 0, pending = 0;
  class StaleRequest extends Error {}
  const scope = () => ({ session_id: state.session, profile_id: chatProfileId(state), workspace_id: workspaceId, pane_id: paneId, generation, revision: state.binding_revision });
  type Scope = ReturnType<typeof scope>;
  const current = (s: Scope) => !disposed && s.generation === generation && s.workspace_id === workspaceId && s.session_id === state.session && s.profile_id === chatProfileId(state) && s.revision === state.binding_revision;
  const switchBlocked = () => disposed || busy || polling || sharing || switching || pending > 0 || !!state.run || !!state.queue?.length || approvals.childElementCount > 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const controller = new AbortController();
  let liveController: AbortController | undefined;
  const save = () => {
    try { sessionStorage.setItem(storageKey, JSON.stringify(state)); } catch { /* Private browsing/storage limit. */ }
  };
  body.classList.add('chat-body');
  const badge = el('div', 'agent-meta');
  const status = el('span', 'agent-status', 'READY');
  status.setAttribute('role', 'status');
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
  titleInput.addEventListener('input', () => { state.title = titleInput.value; save(); });
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
    form.onsubmit = event => { event.preventDefault(); if (current(requested)) { state.title = name.value.trim(); save(); render(); } dialog.close(); };
    dialog.append(form); dialog.addEventListener('close', () => dialog.remove());
    document.body.append(dialog); dialog.showModal(); name.focus(); name.select();
  }, 'small-button');
  badge.append(el('span', 'agent-avatar', '✳'), titleInput, colorInput, rename, status, newChat, notificationButton);
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
    } catch (error) { if (current(requested) && sequence === metadataSequence) bindingNote.textContent = error instanceof Error ? error.message : 'Sessions unavailable.'; }
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
    } catch (error) { if (current(requested)) bindingNote.textContent = error instanceof Error ? error.message : 'Profiles unavailable.'; }
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
    if (disposed || busy || state.run || !state.queue?.length) return;
    queuePaused = false;
    await submit(state.queue[0]);
  }
  const messages = el('div', 'chat-messages');
  // Host-authored task receipts are deliberately outside ChatState.messages:
  // displaying one must never add an assistant turn or trigger model inference.
  const taskCards = el('section', 'agent-task-results');
  taskCards.setAttribute('aria-label', 'Supervised worker task results');
  taskCards.hidden = true;
  let cardsLoading = false, cardsDigest = '';
  async function refreshTaskCards() {
    if (disposed || cardsLoading || switching) return;
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
      const digest = JSON.stringify(cards);
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
    } catch {
      if (current(requested)) { taskCards.replaceChildren(); taskCards.hidden = true; cardsDigest = ''; }
    } finally { cardsLoading = false; }
  }
  const inlineTools = createInlineTools(paneId, messages, () => api({action:'activity'}));
  badge.append(inlineTools.toggle);
  const activity = registerActivity(paneId, () => {
    window.dispatchEvent(new CustomEvent('orbit-focus-agent', {detail:paneId}));
    body.scrollIntoView({block:'nearest'}); input.focus();
  });
  let toolStatus = '', streamStatus = '';
  const strip = el('div','agent-activity-strip');
  const activityButton = button('Ready','Show live tool details',()=>inlineTools.show(),'small-button');
  strip.append(activityButton,button('Workspace agents','Overview of all open agents',openAgentOverview,'small-button'));
  function refreshActivity() {
    const runStatus = status.textContent || 'READY';
    const label = !getToken() ? 'Host disconnected' : runStatus === 'ATTENTION' ? 'Needs attention · check status' : runStatus === 'WAITING FOR APPROVAL' ? 'Waiting for you' : state.run ? (streamStatus || toolStatus || 'Working · awaiting tool events') : runStatus === 'COMPLETED' ? 'Finished' : runStatus === 'FAILED' ? 'Failed' : runStatus === 'CANCELLED' ? 'Cancelled' : 'Ready';
    activityButton.textContent = label;
    activity.update({title:state.title || 'Hermes',task:state.messages.filter(m=>m.role==='user').at(-1)?.text.slice(0,200) || 'No task yet',status:label});
  }
  const statusObserver = new MutationObserver(refreshActivity);
  statusObserver.observe(status,{childList:true,characterData:true,subtree:true});
  const stopToolFeed = watchToolFeed(paneId, () => state, getToken, {
    enabled:()=>true,
    event(raw,run) { inlineTools.event(raw,run); streamStatus=''; toolStatus=inlineTools.summary(); refreshActivity(); },
    status(text) { inlineTools.status(text); streamStatus=/unavailable|ended/.test(text) ? 'Tool stream disconnected · status polling continues' : /Connecting/.test(text) ? 'Connecting to activity stream' : ''; refreshActivity(); }
  }, workspaceId);
  messages.setAttribute('role', 'log');
  messages.setAttribute('aria-label', 'Hermes conversation');
  const notice = el('div', 'agent-notice', 'Hermes can inspect and change this workspace, build apps, and open their previews here. Host terminals run as your account. Workspace context includes layout and app URLs, not private terminal buffers or iframe contents.');
  const progress = el('div', 'agent-progress');
  progress.setAttribute('role', 'status');
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
  const form = el('form', 'chat-form');
  const input = el('textarea');
  input.placeholder = 'Ask Hermes… (up to 100,000 characters)'; input.rows = 2; input.maxLength = 100000;
  input.setAttribute('aria-label', 'Message to Hermes');
  loadDraft();
  input.addEventListener('input', saveDraft);
  const tools = button('⋯', 'Hermes tools and conversations', () => openTools(), 'small-button');
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
    dialog.append(el('p', '', 'History and drafts stay in this browser tab. Exports may contain private conversation content.'));
    dialog.append(button('Export conversation', 'Download this Hermes conversation', () => {
      const blob = new Blob([transcript(state)], { type: 'text/plain;charset=utf-8' });
      const url = URL.createObjectURL(blob); const a = document.createElement('a');
      a.href = url; a.download = `${chatProfileId(state)}-${state.session}.txt`; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
    }));
    dialog.append(el('h3', '', 'Workspace requests'));
    for (const [label, prompt] of [
      ['Inspect workspace', 'Inspect this workspace using the workspace controller. Summarize its current windows, panes, layout, and available controls. Do not change anything yet.'],
      ['Organize windows', 'Inspect this workspace and organize the existing windows for readability. Preserve all pane IDs, conversations, and running shells. Use live workspace controls and verify the browser acknowledgement.'],
      ['Build an app', 'Build and publish an app inside this workspace. First ask me what the app should do, then use the workspace publishing workflow to open it here.'],
      ['Change appearance', 'Help me change the workspace appearance. First ask what look I want. Use the no-reload appearance workflow in docs/WORKSPACE_CONTROL.md, preserve unrelated customizations, and do not restart services.'],
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
  const send = button('↑', 'Send message to Hermes', () => { void submit(); });
  function update() {
    send.disabled = busy || switching || sharing; newChat.disabled = switchBlocked();
    profileSelect.disabled = switchBlocked() || !getToken() || !metadataReady;
    sessionSelect.disabled = switchBlocked() || !getToken() || !sessionsReady;
    applyBinding.disabled = switchBlocked() || !getToken() || !metadataReady || !sessionsReady;
    refreshBindings.disabled = switchBlocked() || !getToken();
    refreshBindings.title = getToken() ? 'Load available Hermes profiles and sessions' : 'Connect host first to load profiles';
    send.textContent = state.run ? 'Queue' : '↑';
    send.title = state.run ? 'Queue message after the current turn' : 'Send message to Hermes';
    stop.hidden = !state.run; resume.hidden = !state.run; steer.hidden = !state.run;
    // Allow composing the next message while Hermes works; Send remains disabled.
    input.disabled = false;
  }
  function render() {
    if(!state.run) {toolStatus='';streamStatus='';}
    refreshActivity();
    titleInput.value = state.title || '';
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
    messages.replaceChildren();
    if (!state.messages.length) messages.append(el('div', 'chat-message assistant', 'Hi, I’m Hermes. Connect host with your Orbit token, then send me a message. This pane has its own conversation.'));
    for (const m of state.messages) {
      const node = el('div', `chat-message ${m.role}`);
      node.append(el('small', '', m.role === 'user' ? 'YOU' : 'HERMES'), el('p', '', m.text));
      messages.append(node);
    }
    inlineTools.sync(chatBindingKey(state), state.run);
    // Keep the live trace in the conversation, immediately before the final reply.
    const last = messages.lastElementChild;
    if (!state.run && state.messages.at(-1)?.role === 'assistant' && last) messages.insertBefore(inlineTools.root, last);
    else messages.append(inlineTools.root);
    messages.scrollTop = messages.scrollHeight;
    update();
  }
  async function api(payload: Record<string, unknown>, requested = scope()) {
    if (!current(requested)) throw new StaleRequest();
    const token = getToken();
    if (!token) throw Error('Use “Connect host” in the top bar first.');
    pending++; update();
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
    } finally { pending--; if (!disposed) update(); }
  }
  function showError(error: unknown) {
    if (disposed || error instanceof StaleRequest) return;
    status.textContent = 'ATTENTION';
    progress.textContent = error instanceof Error ? error.message : 'Connection failed.';
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
        state.run = undefined; save(); render(); progress.textContent = '';
        notifyReply(finishedRun, data.status === 'completed');
        if (data.status === 'completed' && !queuePaused) void drainQueue();
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
    if (!text || busy || disposed || switching || sharing) return;
    const requested = scope();
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
      state.run = data.run_id;
      if (queuedText) state.queue?.shift();
      state.messages.push({ role: 'user', text });
      state.messages = state.messages.slice(-100); save();
      if (!disposed) { if (!queuedText && input.value.trim() === text) { input.value = ''; saveDraft(); } render(); status.textContent = 'WORKING'; schedule(); }
    } catch (error) { showError(error); }
    finally { busy = false; if (!disposed) render(); }
  }
  form.append(input, tools, send);
  form.onsubmit = e => { e.preventDefault(); void submit(); };
  input.onkeydown = e => { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); void submit(); } };
  body.append(badge, bindingControls, strip, notice, messages, taskCards, progress, approvals, controls,recovery, queueList, form);
  if (toolbar) {
    toolbar.classList.add('agent-pane-head');
    badge.classList.add('agent-toolbar-meta');
    toolbar.insertBefore(badge, toolbar.children[1] || null);
  }
  render();
  async function syncShared() {
    if (sharing || switching || pending || busy || polling || disposed || !getToken()) return;
    const requested = scope();
    sharing = true; update();
    try {
      await ensureWorkspaceSynced();
      const data = await api({action:'shared_chat', ...(document.documentElement.dataset.mobile === 'true' ? {} : {initial:state})}, requested);
      if (disposed || busy || polling) return;
      if (!data.state) { progress.textContent = 'Open this chat on the desktop and reload once to link its existing conversation.'; return; }
      if (validChat(data.state)) {
        const next = data.state as ChatState;
        if (chatBindingKey(next) !== chatBindingKey(state) && (state.run || state.queue?.length)) {
          showError(Error('This pane changed binding elsewhere while a run or queue was pending. Finish or remove pending work before refreshing.')); return;
        }
        if (chatBindingKey(next) === chatBindingKey(state)) {
          next.queue = state.queue;
          next.title = state.title ?? next.title;
          next.color = state.color ?? next.color;
        }
        if (JSON.stringify(next) !== JSON.stringify(state)) {
          acceptState(next);
          if(state.run) schedule();
        }
        if (!catalogRequested) void loadProfiles();
      } else throw Error('The backend returned an invalid chat binding. The current conversation is preserved.');
    } catch (e) { showError(e); } finally { sharing = false; if (!disposed) update(); }
  }
  function acceptState(next: ChatState) {
    const changed = chatBindingKey(next) !== chatBindingKey(state) || next.binding_revision !== state.binding_revision;
    if (changed) {
      saveDraft(); generation++; clearTimeout(timer); toolsDialog?.close(); liveController?.abort(); approvals.replaceChildren();
      taskCards.replaceChildren(); taskCards.hidden = true; cardsDigest = '';
      queuePaused = true; toolStatus = ''; streamStatus = '';
    }
    state = next;
    if (changed) { loadDraft(); resetBindingControls(); status.textContent = state.run ? 'WORKING' : 'READY'; progress.textContent = ''; }
    save(); render();
  }
  async function switchConversation(targetProfile: string, targetSession?: string) {
    if (switchBlocked()) { showError(Error('Wait for pending work, approvals, and queued messages before switching.')); return; }
    if (!Number.isSafeInteger(state.binding_revision)) { showError(Error('Session switching is unsupported until the backend supplies an authoritative binding revision. Refresh the connection first.')); return; }
    const requested = scope();
    switching = true; update();
    try {
      const data = await api({action:'select_session',target_profile_id:targetProfile,...(targetSession ? {target_session_id:targetSession} : {}),expected_binding_revision:requested.revision}, requested);
      if (!validChat(data.state) || !Number.isSafeInteger(data.state.binding_revision) || chatProfileId(data.state) !== targetProfile || (targetSession && data.state.session !== targetSession)) throw Error('Session switching is unsupported: the backend did not return the requested authoritative binding. Refresh before any further actions.');
      remember(); acceptState(data.state);
      if (state.run) schedule();
    } catch(e) {showError(e);} finally { switching = false; if (!disposed) { update(); if (!catalogRequested) void loadProfiles(); } }
  }
  const sharedTimer = setInterval(() => {void syncShared(); void refreshTaskCards();}, 1800);
  void syncShared();
  const onUnlock = () => { void syncShared(); if (state.run) void poll(); };
  window.addEventListener('orbit-host-connected', onUnlock);
  if (state.run) {
    progress.textContent = 'A saved run may still be active. Connect host to check its status. Closing the pane does not stop Hermes.';
    if (getToken()) void poll();
  }
  return () => { saveDraft(); disposed = true; generation++; statusObserver.disconnect(); activity.dispose(); clearInterval(sharedTimer); stopToolFeed(); inlineTools.dispose(); toolsDialog?.close(); liveController?.abort(); clearTimeout(timer); controller.abort(); window.removeEventListener('orbit-host-connected', onUnlock); window.removeEventListener('orbit-open-hermes-tools', onOpenTools); };
}
