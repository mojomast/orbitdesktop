import { workspaceExtensions } from './workspace-extensions';
import { watchToolFeed } from './tool-feed';
import { createInlineTools } from './inline-tools';
import { registerActivity, openAgentOverview } from './agent-activity';
import './hermes-tools.css';
import './agent-toolbar.css';
import { el, button } from './dom';
import { workspaceId, ensureWorkspaceSynced } from './workspace-sync';

import { archiveChat, validChat, transcript, type Message, type ChatState } from './chat-storage';
export function createAgentChat(body: HTMLElement, paneId: string, getToken: () => string, toolbar?: HTMLElement) {
  const storageKey = `orbit-hermes-chat:${paneId}`;
  const archiveKey = `${storageKey}:archive`, draftKey = `${storageKey}:draft`;
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
    if (saved && /^orbit-[0-9a-f-]{36}$/.test(saved.session) && Array.isArray(saved.messages)) {
      state = { session: saved.session, messages: saved.messages.filter((m: Message) => ['user', 'assistant'].includes(m.role) && typeof m.text === 'string').slice(-100), run: typeof saved.run === 'string' ? saved.run : undefined };
    }
  } catch { /* Storage is optional. */ }
  try {
    const saved = JSON.parse(sessionStorage.getItem(storageKey) || 'null');
    if (saved?.session === state.session) {
      state.title = typeof saved.title === 'string' ? saved.title.slice(0, 100) : undefined;
      state.color = /^#[0-9a-f]{6}$/i.test(saved.color) ? saved.color : undefined;
      state.queue = Array.isArray(saved.queue) ? saved.queue.filter((s: unknown) => typeof s === 'string' && s.length <= 100000).slice(0, 20) : [];
    }
  } catch {}

  let disposed = false, busy = false, polling = false, queuePaused = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const controller = new AbortController();
  const save = () => {
    try { sessionStorage.setItem(storageKey, JSON.stringify(state)); } catch { /* Private browsing/storage limit. */ }
  };
  body.classList.add('chat-body');
  const badge = el('div', 'agent-meta');
  const status = el('span', 'agent-status', 'READY');
  status.setAttribute('role', 'status');
  const newChat = button('New chat', 'Start a separate Hermes conversation', () => {
    if (busy || state.run) return;
    void switchConversation(fresh()); status.textContent = 'READY';
    input.value = ''; try { sessionStorage.removeItem(draftKey); } catch {}
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
    const dialog = document.createElement('dialog');
    dialog.className = 'hermes-tools-dialog'; dialog.setAttribute('aria-label', 'Rename agent conversation');
    const name = el('input'); name.maxLength = 100; name.value = state.title || '';
    name.placeholder = 'Hermes'; name.setAttribute('aria-label', 'New conversation name');
    const form = el('form');
    const commit = button('Save name', 'Save conversation name', () => {}); commit.type = 'submit';
    form.append(el('h2', '', 'Rename agent conversation'),
      el('p', '', 'This changes the display name for this conversation, not the underlying agent or model.'),
      name, commit, button('Cancel', 'Cancel rename', () => dialog.close()));
    form.onsubmit = event => { event.preventDefault(); state.title = name.value.trim(); save(); render(); dialog.close(); };
    dialog.append(form); dialog.addEventListener('close', () => dialog.remove());
    document.body.append(dialog); dialog.showModal(); name.focus(); name.select();
  }, 'small-button');
  badge.append(el('span', 'agent-avatar', '✳'), titleInput, colorInput, rename, status, newChat, notificationButton);
  const queueList = el('div', 'agent-queue');
  const drainButton = button('Send next queued', 'Resume sending queued messages', () => { void drainQueue(); }, 'small-button');
  async function drainQueue() {
    if (disposed || busy || state.run || !state.queue?.length) return;
    queuePaused = false;
    await submit(state.queue[0]);
  }
  const messages = el('div', 'chat-messages');
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
  });
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
      if (input.value.trim() === text) { input.value = ''; try { sessionStorage.removeItem(draftKey); } catch {} }
      progress.textContent = 'Guidance accepted by Hermes. It will be consumed at a safe point; already-running tool actions are not undone.';
    } catch (error) { showError(error); }
    finally { steer.disabled = false; }
  }, 'small-button');
  controls.append(stop, resume, steer);
  const form = el('form', 'chat-form');
  const input = el('textarea');
  input.placeholder = 'Ask Hermes… (up to 100,000 characters)'; input.rows = 2; input.maxLength = 100000;
  input.setAttribute('aria-label', 'Message to Hermes');
  try { input.value = (sessionStorage.getItem(draftKey) || '').slice(0, 100000); } catch {}
  input.addEventListener('input', () => { try { sessionStorage.setItem(draftKey, input.value); } catch {} });
  const tools = button('⋯', 'Hermes tools and conversations', () => openTools(), 'small-button');
  let toolsDialog: HTMLDialogElement | undefined;
  function openTools() {
    toolsDialog?.remove();
    const dialog = document.createElement('dialog'); toolsDialog = dialog;
    dialog.className = 'hermes-tools-dialog'; dialog.setAttribute('aria-label', 'Hermes tools');
    const close = button('Close', 'Close Hermes tools', () => dialog.close());
    dialog.append(el('h2', '', 'Hermes tools'), close);
    for (const extension of workspaceExtensions) dialog.append(button(extension.title, extension.label, () => {
      dialog.close(); void extension.activate({token:getToken,api}).catch(error=>window.alert(`Module ${extension.id} could not open: ${String(error)}`));
    }));
    const live = button('Live activity', 'Open live Hermes activity', () => { if (state.run) { dialog.close(); const run = state.run; void import('./hermes-surfaces').then(m => m.showLive(getToken, state.session, run)).catch(e => window.alert(String(e))); } });
    live.disabled = true; dialog.append(live);
    if (state.run) void api({action:'capabilities'}).then(data => { live.disabled = !data.features?.run_events_sse; }).catch(() => { live.title = 'Streaming unavailable; use Tool activity'; });
    const activity = el('div', 'hermes-activity');
    let activitySnapshot = '';
    let activityTimer: ReturnType<typeof setTimeout> | undefined;
    async function loadActivity() {
      try {
        const result = await api({ action: 'activity' });
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
      } catch (error) { if (dialog.open) activity.textContent = error instanceof Error ? error.message : 'Activity unavailable'; }
      if (dialog.open && !disposed) activityTimer = setTimeout(() => { void loadActivity(); }, 3000);
    }
    dialog.append(button('Tool activity', 'Inspect actual Hermes tool calls and results', () => { clearTimeout(activityTimer); void loadActivity(); }), activity);
    dialog.addEventListener('close', () => clearTimeout(activityTimer));
    dialog.append(el('p', '', 'History and drafts stay in this browser tab. Exports may contain private conversation content.'));
    dialog.append(button('Export conversation', 'Download this Hermes conversation', () => {
      const blob = new Blob([transcript(state)], { type: 'text/plain;charset=utf-8' });
      const url = URL.createObjectURL(blob); const a = document.createElement('a');
      a.href = url; a.download = `${state.session}.txt`; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
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
    const archived = history.filter(s => s.session !== state.session);
    if (!archived.length) dialog.append(el('p', '', 'Completed conversations appear here after New chat.'));
    for (const saved of archived) {
      const title = saved.title || saved.messages.find(m => m.role === 'user')?.text.slice(0, 80) || saved.session;
      const restore = button(title, `Restore conversation: ${title}`, () => {
        if (busy || state.run || state.queue?.length) return;
        void switchConversation({ ...saved, messages: [...saved.messages] });
        progress.textContent = ''; status.textContent = 'RESTORED'; dialog.close();
      });
      restore.disabled = busy || !!state.run || !!state.queue?.length; dialog.append(restore);
    }
    dialog.addEventListener('close', () => { dialog.remove(); input.focus(); });
    document.body.append(dialog); dialog.showModal();
  }
  const send = button('↑', 'Send message to Hermes', () => { void submit(); });
  function update() {
    const active = busy || !!state.run;
    send.disabled = busy; newChat.disabled = active || !!state.queue?.length;
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
    inlineTools.sync(state.session, state.run);
    // Keep the live trace in the conversation, immediately before the final reply.
    const last = messages.lastElementChild;
    if (!state.run && state.messages.at(-1)?.role === 'assistant' && last) messages.insertBefore(inlineTools.root, last);
    else messages.append(inlineTools.root);
    messages.scrollTop = messages.scrollHeight;
    update();
  }
  async function api(payload: Record<string, unknown>) {
    if (!getToken()) throw Error('Use “Connect host” in the top bar first.');
    const response = await fetch('/api/agent', {
      method: 'POST', headers: { Authorization: `Bearer ${getToken()}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...payload, session_id: state.session, workspace_id: workspaceId, pane_id: paneId }),
      signal: AbortSignal.any([controller.signal, AbortSignal.timeout(30000)]),
    });
    const data = await response.json();
    if (!response.ok) throw Error(data.error || `Request failed (${response.status}).`);
    return data;
  }
  function showError(error: unknown) {
    if (disposed) return;
    status.textContent = 'ATTENTION';
    progress.textContent = error instanceof Error ? error.message : 'Connection failed.';
    update();
  }
  function schedule() {
    clearTimeout(timer);
    if (!disposed && state.run) timer = setTimeout(() => { void poll(); }, 1500);
  }
  async function poll() {
    if (disposed || polling || !state.run) return;
    clearTimeout(timer); polling = true;
    try {
      const data = await api({ action: 'status', run_id: state.run });
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
            try { await api({ action: 'approval', run_id: state.run, choice }); approvals.replaceChildren(); schedule(); }
            catch (e) { showError(e); }
          }, 'small-button'));
        } else approvals.append(el('p', '', 'Approval details unavailable. Check the Hermes dashboard or stop this run.'));
      }
      update(); schedule();
    } catch (error) { showError(error); }
    finally { polling = false; }
  }
  async function submit(queuedText?: string) {
    const text = queuedText ?? input.value.trim();
    if (!text || busy || disposed) return;
    if (state.run) {
      if (queuedText) return;
      if ((state.queue?.length || 0) >= 20) { showError(Error('Queue is full (20 messages).')); return; }
      (state.queue ||= []).push(text); save(); input.value = '';
      try { sessionStorage.removeItem(draftKey); } catch {}
      render(); return;
    }
    if (!getToken()) { showError(new Error('Use “Connect host” in the top bar first.')); return; }
    busy = true; update(); status.textContent = 'CONNECTING'; progress.textContent = 'Sending to Hermes…';
    try {
      await ensureWorkspaceSynced();
      const data = await api({ action: 'start', input: text });
      state.run = data.run_id;
      if (queuedText) state.queue?.shift();
      state.messages.push({ role: 'user', text });
      state.messages = state.messages.slice(-100); save();
      if (!disposed) { if (!queuedText && input.value.trim() === text) { input.value = ''; try { sessionStorage.removeItem(draftKey); } catch {} } render(); status.textContent = 'WORKING'; schedule(); }
    } catch (error) { showError(error); }
    finally { busy = false; if (!disposed) render(); }
  }
  form.append(input, tools, send);
  form.onsubmit = e => { e.preventDefault(); void submit(); };
  input.onkeydown = e => { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); void submit(); } };
  body.append(badge, strip, notice, messages, progress, approvals, controls, queueList, form);
  if (toolbar) {
    toolbar.classList.add('agent-pane-head');
    badge.classList.add('agent-toolbar-meta');
    toolbar.insertBefore(badge, toolbar.children[1] || null);
  }
  render();
  let sharing = false;
  async function syncShared() {
    if (sharing || busy || polling || disposed || !getToken()) return;
    sharing = true;
    try {
      const data = await api({action:'shared_chat', ...(document.documentElement.dataset.mobile === 'true' ? {} : {initial:state})});
      if (disposed || busy || polling) return;
      if (!data.state) { progress.textContent = 'Open this chat on the desktop and reload once to link its existing conversation.'; return; }
      if (validChat(data.state)) {
        const next = data.state as ChatState;
        if (next.session !== state.session || JSON.stringify(next.messages) !== JSON.stringify(state.messages) || next.run !== state.run) {
          state = {...state, session:next.session,messages:next.messages,run:next.run}; save(); render();
          if(state.run) schedule();
        }
      }
    } catch (e) { showError(e); } finally { sharing = false; }
  }
  async function switchConversation(next: ChatState) {
    try {
      await api({action:'shared_chat',replace:true,initial:next});
      remember(); state = next; save(); render();
    } catch(e) {showError(e);}
  }
  const sharedTimer = setInterval(() => {void syncShared();}, 1800);
  void syncShared();
  const onUnlock = () => { void syncShared(); if (state.run) void poll(); };
  window.addEventListener('orbit-host-connected', onUnlock);
  if (state.run) {
    progress.textContent = 'A saved run may still be active. Connect host to check its status. Closing the pane does not stop Hermes.';
    if (getToken()) void poll();
  }
  return () => { statusObserver.disconnect(); activity.dispose(); clearInterval(sharedTimer); stopToolFeed(); inlineTools.dispose(); disposed = true; toolsDialog?.remove(); clearTimeout(timer); controller.abort(); window.removeEventListener('orbit-host-connected', onUnlock); };
}
