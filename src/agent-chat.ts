import './hermes-tools.css';
import { el, button } from './dom';
import { workspaceId, ensureWorkspaceSynced } from './workspace-sync';

import { archiveChat, validChat, transcript, type Message, type ChatState } from './chat-storage';
export function createAgentChat(body: HTMLElement, paneId: string, getToken: () => string) {
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
  let disposed = false, busy = false, polling = false;
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
    remember(); state = fresh(); save(); render(); status.textContent = 'READY';
    input.value = ''; try { sessionStorage.removeItem(draftKey); } catch {}
  }, 'small-button');
  badge.append(el('span', 'agent-avatar', '✳'), el('div', '', 'Hermes'), status, newChat);
  const messages = el('div', 'chat-messages');
  messages.setAttribute('role', 'log');
  messages.setAttribute('aria-label', 'Hermes conversation');
  const notice = el('div', 'agent-notice', 'Hermes can inspect and change this workspace, build apps, and open their previews here. Host terminals run as your account. Workspace context includes layout and app URLs, not private terminal buffers or iframe contents.');
  const progress = el('div', 'agent-progress');
  progress.setAttribute('role', 'status');
  const approvals = el('div', 'agent-approvals');
  const controls = el('div', 'agent-controls');
  const stop = button('Stop', 'Ask Hermes to stop this run', async () => {
    if (!state.run) return;
    stop.disabled = true;
    try { await api({ action: 'stop', run_id: state.run }); status.textContent = 'STOPPING'; progress.textContent = 'Stop requested. Waiting for Hermes to finish stopping…'; schedule(); }
    catch (e) { showError(e); }
    finally { stop.disabled = false; }
  }, 'small-button');
  const resume = button('Check status', 'Resume checking the active Hermes run', () => { void poll(); }, 'small-button');
  controls.append(stop, resume);
  const form = el('form', 'chat-form');
  const input = el('textarea');
  input.placeholder = 'Ask Hermes…'; input.rows = 2; input.maxLength = 8000;
  input.setAttribute('aria-label', 'Message to Hermes');
  try { input.value = (sessionStorage.getItem(draftKey) || '').slice(0, 8000); } catch {}
  input.addEventListener('input', () => { try { sessionStorage.setItem(draftKey, input.value); } catch {} });
  const tools = button('⋯', 'Hermes tools and conversations', () => openTools(), 'small-button');
  let toolsDialog: HTMLDialogElement | undefined;
  function openTools() {
    toolsDialog?.remove();
    const dialog = document.createElement('dialog'); toolsDialog = dialog;
    dialog.className = 'hermes-tools-dialog'; dialog.setAttribute('aria-label', 'Hermes tools');
    const close = button('Close', 'Close Hermes tools', () => dialog.close());
    dialog.append(el('h2', '', 'Hermes tools'), close);
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
      const title = saved.messages.find(m => m.role === 'user')?.text.slice(0, 80) || saved.session;
      const restore = button(title, `Restore conversation: ${title}`, () => {
        if (busy || state.run) return;
        remember(); state = { session: saved.session, messages: [...saved.messages] }; save(); render();
        progress.textContent = ''; status.textContent = 'RESTORED'; dialog.close();
      });
      restore.disabled = busy || !!state.run; dialog.append(restore);
    }
    dialog.addEventListener('close', () => { dialog.remove(); input.focus(); });
    document.body.append(dialog); dialog.showModal();
  }
  const send = button('↑', 'Send message to Hermes', () => { void submit(); });
  function update() {
    const active = busy || !!state.run;
    send.disabled = active; newChat.disabled = active;
    stop.hidden = !state.run; resume.hidden = !state.run;
    // Allow composing the next message while Hermes works; Send remains disabled.
    input.disabled = false;
  }
  function render() {
    messages.replaceChildren();
    if (!state.messages.length) messages.append(el('div', 'chat-message assistant', 'Hi, I’m Hermes. Connect host with your Orbit token, then send me a message. This pane has its own conversation.'));
    for (const m of state.messages) {
      const node = el('div', `chat-message ${m.role}`);
      node.append(el('small', '', m.role === 'user' ? 'YOU' : 'HERMES'), el('p', '', m.text));
      messages.append(node);
    }
    messages.scrollTop = messages.scrollHeight;
    update();
  }
  async function api(payload: Record<string, unknown>) {
    if (!getToken()) throw Error('Use “Connect host” in the top bar first.');
    const response = await fetch('/api/agent', {
      method: 'POST', headers: { Authorization: `Bearer ${getToken()}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...payload, session_id: state.session, workspace_id: workspaceId }),
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
        state.run = undefined; save(); render(); progress.textContent = '';
        input.focus(); return;
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
  async function submit() {
    const text = input.value.trim();
    if (!text || busy || state.run || disposed) return;
    if (!getToken()) { showError(new Error('Use “Connect host” in the top bar first.')); return; }
    busy = true; update(); status.textContent = 'CONNECTING'; progress.textContent = 'Sending to Hermes…';
    try {
      await ensureWorkspaceSynced();
      const data = await api({ action: 'start', input: text });
      state.run = data.run_id;
      state.messages.push({ role: 'user', text });
      state.messages = state.messages.slice(-100); save();
      if (!disposed) { if (input.value.trim() === text) { input.value = ''; try { sessionStorage.removeItem(draftKey); } catch {} } render(); status.textContent = 'WORKING'; schedule(); }
    } catch (error) { showError(error); }
    finally { busy = false; if (!disposed) update(); }
  }
  form.append(input, tools, send);
  form.onsubmit = e => { e.preventDefault(); void submit(); };
  input.onkeydown = e => { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); void submit(); } };
  body.append(badge, notice, messages, progress, approvals, controls, form);
  render();
  const onUnlock = () => { if (state.run) void poll(); };
  window.addEventListener('orbit-host-connected', onUnlock);
  if (state.run) {
    progress.textContent = 'A saved run may still be active. Connect host to check its status. Closing the pane does not stop Hermes.';
    if (getToken()) void poll();
  }
  return () => { disposed = true; toolsDialog?.remove(); clearTimeout(timer); controller.abort(); window.removeEventListener('orbit-host-connected', onUnlock); };
}
