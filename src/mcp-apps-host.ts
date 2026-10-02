import './mcp-apps-host.css';
import { workspaceId, ensureWorkspaceSynced } from './workspace-sync';
// @ts-expect-error Shared runtime contract is JavaScript, validated at the API boundary.
import { validateMcpSnapshot } from '../contracts/mcp-apps-v1.mjs';

export function mountMcpApps(host: HTMLElement, token: () => string, _options?: { paneId?: string }) {
  const abort = new AbortController();
  let bindingAbort = new AbortController(), bindingEpoch = 0, boundToken = '', boundWorkspace = workspaceId;
  let refreshing: number | undefined;
  let needsRefresh = true;
  let disposed = false, revision = '', generation = 0, release: (() => void) | undefined;
  const root = document.createElement('section'); root.className = 'mcp-apps-host';
  const heading = document.createElement('h2'); heading.textContent = 'MCP Apps · imported snapshots';
  const help = document.createElement('p'); help.textContent = 'Import exact self-contained HTML, ui:// resource identity, tool arguments and result. Render/theme/resize/logging only. Apps requiring tools, model access, links or downloads are incompatible.';
  const status = document.createElement('p'); status.setAttribute('role', 'status');
  const log = document.createElement('output'); log.setAttribute('aria-label', 'Latest app log');
  const draft = document.createElement('textarea'); draft.setAttribute('aria-label', 'MCP App snapshot JSON'); draft.placeholder = '{"title":"…","resource_uri":"ui://…","html":"…","arguments":{},"result":{"content":[]}}';
  const save = button('Import snapshot'), refresh = button('Refresh saved snapshots'), cancel = button('Cancel app'), stop = button('Close app');
  const list = document.createElement('div'), view = document.createElement('div'); view.className = 'mcp-apps-view';
  root.append(heading, help, draft, save, refresh, cancel, stop, status, log, list, view); host.append(root);
  let sandboxOrigin = '', bridge: import('@modelcontextprotocol/ext-apps/app-bridge').AppBridge | undefined;
  function button(label: string) { const element = document.createElement('button'); element.textContent = label; return element; }
  function liveBinding() {
    let credential = '', scope = workspaceId;
    try { credential = token(); } catch { /* Locked host. */ }
    try { scope = localStorage.getItem('orbit.workspace.id') || workspaceId; } catch {}
    return { credential, scope };
  }
  function syncBinding() {
    const live = liveBinding();
    if (live.credential === boundToken && live.scope === boundWorkspace) return false;
    bindingAbort.abort(); bindingAbort = new AbortController(); bindingEpoch++; generation++;
    needsRefresh = true;
    boundToken = live.credential; boundWorkspace = live.scope;
    release?.(); revision = ''; sandboxOrigin = ''; list.replaceChildren(); log.textContent = ''; save.disabled = true;
    return true;
  }
  function assertBinding(own: number) {
    syncBinding();
    if (disposed || own !== bindingEpoch) throw Object.assign(Error('Host binding changed during request.'), { code: 'stale_binding' });
  }
  async function api(action: string, fields = {}, own = bindingEpoch) {
    assertBinding(own);
    if (boundWorkspace !== workspaceId) throw Error('Workspace binding changed; reopen this workspace before using its saved library.');
    if (!boundToken) throw Error('Connect host to enable workspace control.');
    const credential = boundToken, signal = AbortSignal.any([abort.signal, bindingAbort.signal, AbortSignal.timeout(15000)]);
    await new Promise<void>((resolve, reject) => {
      const interrupted = () => reject(signal.reason);
      signal.addEventListener('abort', interrupted, { once: true });
      if (signal.aborted) interrupted();
      else void ensureWorkspaceSynced().then(resolve, reject).finally(() => signal.removeEventListener('abort', interrupted));
    });
    assertBinding(own);
    const response = await fetch('/api/mcp-apps', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${credential}` }, signal, body: JSON.stringify({ action, workspace_id: workspaceId, ...fields }) });
    assertBinding(own);
    const result = await response.json(); assertBinding(own);
    if (!response.ok) throw Error(result.error || 'MCP Apps request failed'); return result;
  }
  const report = (error: unknown, own = bindingEpoch) => {
    if (!disposed) syncBinding();
    if (disposed || own !== bindingEpoch || (error as {name?: string; code?: string})?.name === 'AbortError' || (error as {code?: string})?.code === 'stale_binding') return;
    status.textContent = error instanceof Error ? error.message : String(error);
  };
  async function open(id: string, own = bindingEpoch) {
    assertBinding(own);
    const attempt = ++generation;
    release?.();
    const { snapshot } = await api('get', { id }, own); validateMcpSnapshot(snapshot);
    if (disposed || attempt !== generation) return;
    if (!sandboxOrigin || sandboxOrigin === location.origin) throw Error('A separate sandbox origin is required.');
    const { AppBridge, PostMessageTransport } = await import('@modelcontextprotocol/ext-apps/app-bridge');
    assertBinding(own);
    if (disposed || attempt !== generation) return;
    const iframe = document.createElement('iframe'); iframe.title = snapshot.title; iframe.referrerPolicy = 'no-referrer';
    const nonce = crypto.randomUUID();
    const appOrigin = sandboxOrigin;
    iframe.src = `${appOrigin}/mcp-apps/proxy#${new URLSearchParams({ host: location.origin, nonce })}`;
    // Connect synchronously in this task before navigation can emit sandbox-ready;
    // do not retain a load-event promise for a frame that may be detached early.
    view.replaceChildren(iframe);
    const source = iframe.contentWindow!;
    const channel = new MessageChannel();
    const validatedSource = channel.port1;
    const guard = (event: MessageEvent) => {
      if (event.source !== source) return;
      event.stopImmediatePropagation();
      if (event.origin !== appOrigin || event.data?.orbitNonce !== nonce) return;
      const { orbitNonce: _nonce, ...message } = event.data;
      window.dispatchEvent(new MessageEvent('message', { data: message, origin: appOrigin, source: validatedSource }));
    };
    window.addEventListener('message', guard, true);
    const target = { postMessage(message: object) { source.postMessage({ ...message, orbitNonce: nonce }, appOrigin); } } as unknown as Window;
    const current = new AppBridge(null, { name: 'Orbit Desktop', version: '1.0.0' }, { logging: {} }, { hostContext: { theme: matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light', displayMode: 'inline' } });
    bridge = current;
    let active = true;
    const appActive = () => { syncBinding(); return active && !disposed && own === bindingEpoch; };
    const appReport = (error: unknown) => report(error, own);
    const timeout = setTimeout(() => { if (appActive()) status.textContent = 'App did not initialize. It must use the MCP Apps SDK protocol and a self-contained inline bundle; external network dependencies are blocked.'; }, 10000);
    current.addEventListener('sandboxready', () => { if (appActive()) void current.sendSandboxResourceReady({ html: snapshot.html, sandbox: 'allow-scripts' }).catch(appReport); });
    current.addEventListener('initialized', () => {
      if (!appActive()) return;
      clearTimeout(timeout);
      status.textContent = `Initialized: ${snapshot.title} · logging only`;
      void current.sendToolInput({ arguments: snapshot.arguments }).then(() => { if (appActive()) return current.sendToolResult(snapshot.result); }).catch(appReport);
    });
    current.addEventListener('sizechange', size => { if (appActive() && typeof size.height === 'number') iframe.style.height = `${Math.max(120, Math.min(1600, size.height))}px`; });
    current.addEventListener('loggingmessage', message => { if (appActive()) log.textContent = `${message.level}: ${String(JSON.stringify(message.data)).slice(0, 2000)}`; });
    const media = matchMedia('(prefers-color-scheme: dark)');
    const theme = () => { if (appActive()) void current.sendHostContextChange({ theme: media.matches ? 'dark' : 'light' }); };
    media.addEventListener('change', theme);
    release = () => {
      if (!active) return; active = false;
      clearTimeout(timeout);
      media.removeEventListener('change', theme);
      // Keep the bound transport alive briefly for the actual SDK teardown reply.
      void Promise.race([current.teardownResource({}), new Promise(resolve => setTimeout(resolve, 300))]).catch(() => {}).finally(() => {
        void current.close(); channel.port1.close(); channel.port2.close(); window.removeEventListener('message', guard, true); iframe.remove();
      });
      if (bridge === current) bridge = undefined;
    };
    await current.connect(new PostMessageTransport(target, validatedSource));
    if (appActive() && !status.textContent?.startsWith('Initialized:')) status.textContent = 'Waiting for MCP App initialization…';
  }
  async function reload(own = bindingEpoch) {
    const data = await api('list', {}, own); assertBinding(own); revision = data.revision; list.replaceChildren();
    for (const item of data.items) {
      const row = document.createElement('div'), show = button(`Open ${item.title}`), remove = button(`Delete ${item.title}`);
      show.onclick = () => { void open(item.id, own).catch(error => report(error, own)); };
      remove.onclick = () => { void api('delete', { id: item.id }, own).then(() => reload(own)).catch(error => report(error, own)); };
      row.append(show, remove); list.append(row);
    }
  }
  save.onclick = () => { const own = bindingEpoch; void (async () => { const snapshot = validateMcpSnapshot(JSON.parse(draft.value)); const result = await api('import', { snapshot, expected_revision: revision }, own); await reload(own); await open(result.id, own); })().catch(error => report(error, own)); };
  refresh.onclick = () => { void reconnect(true); };
  cancel.onclick = () => { syncBinding(); const own = bindingEpoch; if (bridge) void bridge.sendToolCancelled({ reason: 'Owner cancelled' }).catch(error => report(error, own)); };
  stop.onclick = () => { generation++; release?.(); status.textContent = 'App closed'; };
  async function reconnect(force = false) {
    const changed = syncBinding(), own = bindingEpoch;
    if (disposed || refreshing === own || (!force && !changed && !needsRefresh)) return;
    refreshing = own;
    needsRefresh = false;
    try {
      const capabilities = await api('capabilities', {}, own); assertBinding(own);
      sandboxOrigin = capabilities.sandbox_origin; save.disabled = !capabilities.available;
      if (!bridge) status.textContent = capabilities.available ? 'Ready to import a self-contained MCP App snapshot.' : capabilities.reason;
      await reload(own);
    } catch (error) { report(error, own); }
    finally { if (refreshing === own) refreshing = undefined; }
  }
  save.disabled = true;
  window.addEventListener('orbit-host-connected', () => { void reconnect(true); }, { signal: abort.signal });
  window.addEventListener('storage', event => { if (event.key === 'orbit.workspace.id') void reconnect(true); }, { signal: abort.signal });
  const bindingTimer = window.setInterval(() => { void reconnect(); }, 500);
  void reconnect(true);
  return { dispose() { if (disposed) return; disposed = true; generation++; clearInterval(bindingTimer); bindingAbort.abort(); abort.abort(); release?.(); root.hidden = true; setTimeout(() => root.remove(), 350); } };
}
