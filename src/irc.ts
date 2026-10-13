import { button, el } from './dom';

type IrcStatus = {
  status?: string;
  host?: string;
  port?: number;
  source?: string;
  error?: string;
  entry?: string;
  pending_posts?: PendingPost[];
};

type PendingPost = { id: string; target: string; text: string; by: string };

type IrcMessage = { channel: string; from: string; text: string; self?: boolean };

export function mountIrc(options: { request: (body: Record<string, unknown>) => Promise<IrcStatus>; token: () => string }) {
  const element = el('section', 'irc');
  element.setAttribute('aria-label', 'IRC');
  const status = el('p', 'irc-status', 'Loading IRC…');
  status.setAttribute('role', 'status');
  const head = el('div', 'irc-head');
  const title = el('h2', '', 'IRC');
  const bind = el('p', 'irc-bind', '');
  const portInput = el('input');
  portInput.type = 'number';
  portInput.min = '1024';
  portInput.max = '65535';
  portInput.value = '6667';
  portInput.setAttribute('aria-label', 'IRC server port');
  const start = button('Start server', 'Start the IRC server', () => { void run('start'); });
  const stop = button('Stop server', 'Stop the IRC server', () => { void run('stop'); });
  head.append(title, bind, portInput, start, stop);

  const nickInput = el('input');
  nickInput.maxLength = 30;
  nickInput.placeholder = 'nick';
  nickInput.setAttribute('aria-label', 'Nick');
  nickInput.value = sessionStorage.getItem('orbit.irc.nick') || '';
  const setNick = button('Set nick', 'Connect with this nick', () => connectNick());
  const nickRow = el('div', 'irc-row');
  nickRow.append(nickInput, setNick);

  const joinInput = el('input');
  joinInput.maxLength = 50;
  joinInput.placeholder = '#orbit';
  joinInput.value = '#orbit';
  joinInput.setAttribute('aria-label', 'Channel to join');
  const joinButton = button('Join', 'Join this channel', () => send({ type: 'join', channel: joinInput.value.trim() }));
  const partButton = button('Part', 'Leave the selected channel', () => { if (selected) send({ type: 'part', channel: selected }); });
  const channelRow = el('div', 'irc-row');
  channelRow.append(joinInput, joinButton, partButton);
  const channelList = el('div', 'irc-channels');
  channelList.setAttribute('role', 'listbox');
  channelList.setAttribute('aria-label', 'Channels');
  const side = el('aside', 'irc-side');
  side.append(el('h3', '', 'Channels'), channelRow, channelList);

  const log = el('div', 'irc-log');
  log.setAttribute('role', 'log');
  log.setAttribute('aria-label', 'Messages');
  const policy = el('p', 'irc-note', 'Channel text stays in this window. It is never sent to an agent as an instruction.');
  const pendingList = el('div', 'irc-pending');
  const refreshPosts = button('Refresh agent posts', 'Load agent posts waiting for approval', () => { void run('status'); });
  const composer = el('form', 'irc-composer');
  const draft = el('input');
  draft.maxLength = 400;
  draft.placeholder = 'Message';
  draft.setAttribute('aria-label', 'Message');
  const sendButton = button('Send', 'Send the message', () => {});
  sendButton.type = 'submit';
  composer.append(draft, sendButton);
  composer.addEventListener('submit', event => {
    event.preventDefault();
    const text = draft.value.trim();
    if (!selected || !text) return;
    send({ type: 'privmsg', target: selected, text });
    draft.value = '';
  });
  const main = el('div', 'irc-main');
  main.append(log, policy, pendingList, refreshPosts, composer);

  const users = el('ul', 'irc-users');
  users.setAttribute('aria-label', 'Users');
  const people = el('aside', 'irc-people');
  people.append(el('h3', '', 'Users'), users);

  const body = el('div', 'irc-body');
  body.append(side, main, people);
  element.append(status, head, nickRow, body);

  let disposed = false;
  let socket: WebSocket | null = null;
  let selected = '';
  let server: IrcStatus = {};
  const messages: IrcMessage[] = [];
  const members = new Map<string, string[]>();
  const pending = new Map<string, PendingPost>();

  function paint() {
    const state = server.status || 'stopped';
    status.textContent = server.error && state !== 'running' ? server.error : `Server ${state}`;
    bind.textContent = server.host && server.port ? `${server.host}:${server.port}` : '';
    if (server.port) portInput.value = String(server.port);
    const running = state === 'running';
    start.disabled = running;
    stop.disabled = !running;
    portInput.disabled = running;
    channelList.replaceChildren();
    const names = [...members.keys()];
    if (!names.length) channelList.append(el('p', 'irc-empty', 'No channels yet.'));
    for (const name of names) {
      const item = button(name, `Show ${name}`, () => { selected = name; paint(); });
      item.setAttribute('role', 'option');
      if (name === selected) item.setAttribute('aria-current', 'true');
      channelList.append(item);
    }
    log.replaceChildren();
    const visible = messages.filter(item => !selected || item.channel === selected).slice(-200);
    if (!visible.length) log.append(el('p', 'irc-empty', selected ? 'No messages yet.' : 'Join a channel to see messages.'));
    for (const item of visible) {
      const line = el('p', item.self ? 'irc-self' : 'irc-line', `${item.from}: ${item.text}`);
      log.append(line);
    }
    log.scrollTop = log.scrollHeight;
    users.replaceChildren();
    const peopleHere = selected ? members.get(selected) || [] : [];
    if (!peopleHere.length) users.append(el('li', 'irc-empty', 'Nobody here.'));
    for (const name of peopleHere) users.append(el('li', '', name));
    draft.disabled = !selected;
    sendButton.disabled = !selected;
    pendingList.replaceChildren();
    if (!pending.size) pendingList.append(el('p', 'irc-empty', 'No agent posts are waiting.'));
    for (const post of pending.values()) {
      const row = el('div', 'irc-row');
      row.append(el('span', '', `${post.by} → ${post.target}: ${post.text}`));
      row.append(button('Approve', 'Send this agent post to IRC', () => { void decide('approve_post', post.id); }));
      row.append(button('Reject', 'Drop this agent post', () => { void decide('reject_post', post.id); }));
      pendingList.append(row);
    }
  }

  function takePending(list: PendingPost[] | undefined) {
    if (!Array.isArray(list)) return;
    pending.clear();
    for (const post of list) {
      if (post && typeof post.id === 'string' && typeof post.text === 'string') pending.set(post.id, post);
    }
  }

  async function decide(action: 'approve_post' | 'reject_post', id: string) {
    try {
      server = await options.request({ action, id });
      takePending(server.pending_posts);
      if (!disposed) paint();
    } catch (error) {
      if (disposed) return;
      status.textContent = error instanceof Error ? error.message : 'IRC request failed.';
    }
  }

  async function run(action: 'start' | 'stop' | 'status') {
    try {
      const body: Record<string, unknown> = { action };
      if (action === 'start') body.port = Number(portInput.value);
      server = await options.request(body);
      takePending(server.pending_posts);
      if (action === 'stop') closeSocket();
      if (!disposed) paint();
    } catch (error) {
      if (disposed) return;
      status.textContent = error instanceof Error ? error.message : 'IRC request failed.';
    }
  }

  function closeSocket() {
    const current = socket;
    socket = null;
    try { current?.close(); } catch { /* already closed */ }
  }

  function send(payload: Record<string, unknown>) {
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      status.textContent = 'Set a nick after the server is running.';
      return;
    }
    socket.send(JSON.stringify(payload));
  }

  function connectNick() {
    const nick = nickInput.value.trim();
    if (!/^[A-Za-z][A-Za-z0-9_[\]\\`^{}|-]{0,29}$/.test(nick)) {
      status.textContent = 'Nick must start with a letter and stay under 30 characters.';
      return;
    }
    sessionStorage.setItem('orbit.irc.nick', nick);
    if (server.status !== 'running') {
      status.textContent = 'Start the IRC server first.';
      return;
    }
    closeSocket();
    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const next = new WebSocket(`${protocol}//${location.host}/api/irc`);
    socket = next;
    next.addEventListener('open', () => next.send(JSON.stringify({ type: 'auth', token: options.token() })));
    next.addEventListener('message', event => {
      if (disposed || socket !== next) return;
      let payload: Record<string, unknown> = {};
      try { payload = JSON.parse(String(event.data)); } catch { return; }
      if (payload.type === 'ready') {
        next.send(JSON.stringify({ type: 'nick', nick }));
        return;
      }
      if (payload.type === 'welcome') {
        status.textContent = `Connected as ${String(payload.nick || nick)}`;
        return;
      }
      if (payload.type === 'join' && typeof payload.channel === 'string') {
        const list = members.get(payload.channel) || [];
        if (typeof payload.nick === 'string' && payload.nick && !list.includes(payload.nick)) list.push(payload.nick);
        members.set(payload.channel, list);
        if (!selected) selected = payload.channel;
        paint();
        return;
      }
      if (payload.type === 'names' && typeof payload.channel === 'string' && Array.isArray(payload.users)) {
        members.set(payload.channel, payload.users.filter((name): name is string => typeof name === 'string'));
        if (!selected) selected = payload.channel;
        paint();
        return;
      }
      if (payload.type === 'part' && typeof payload.channel === 'string') {
        const left = members.get(payload.channel) || [];
        members.set(payload.channel, left.filter(name => name !== payload.nick));
        if (payload.nick === nick && payload.channel === selected) selected = [...members.keys()][0] || '';
        paint();
        return;
      }
      if (payload.type === 'agent_post' && payload.post && typeof payload.post === 'object') {
        const post = payload.post as PendingPost;
        if (typeof post.id === 'string' && typeof post.text === 'string') pending.set(post.id, post);
        paint();
        return;
      }
      if (payload.type === 'message' && typeof payload.text === 'string') {
        messages.push({ channel: String(payload.channel || ''), from: String(payload.from || ''), text: payload.text, self: payload.self === true });
        if (messages.length > 200) messages.shift();
        paint();
        return;
      }
      if (payload.type === 'error' || payload.type === 'closed') status.textContent = String(payload.message || 'Disconnected from IRC.');
    });
    next.addEventListener('close', () => {
      if (socket === next) socket = null;
    });
  }

  void run('status');
  paint();
  return {
    element,
    dispose() {
      disposed = true;
      closeSocket();
      element.remove();
    },
  };
}
