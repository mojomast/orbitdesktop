// Orbit IRC browser UI. Plain ES module, no build step: the same reduce() and
// parseInput() functions used here are the ones the tests exercise under node.
export const MAX_MESSAGES = 500;

export function initialState() {
  return {
    nick: null,
    registered: false,
    status: 'disconnected',
    current: null,
    channels: [],
    users: [],
    messages: [],
  };
}

/** Turn one line of input into a bridge command ({ cmd, ... }) or null when handled locally. */
export function parseInput(line, state = initialState()) {
  const text = String(line ?? '').trim();
  if (!text) return null;
  if (!text.startsWith('/')) return { cmd: 'say', text };
  const [word, ...rest] = text.slice(1).split(/\s+/);
  const command = word.toLowerCase();
  const joined = rest.join(' ');
  const channelArg = rest[0] && rest[0].startsWith('#') ? rest[0] : undefined;
  switch (command) {
    case 'join':
      return rest[0] ? { cmd: 'join', channel: rest[0], key: rest[1] } : { cmd: 'error', error: 'usage: /join #channel' };
    case 'part':
      return { cmd: 'part', channel: channelArg, text: channelArg ? rest.slice(1).join(' ') || undefined : joined || undefined };
    case 'msg':
    case 'query': {
      const [target, ...body] = rest;
      if (!target || !body.length) return { cmd: 'error', error: 'usage: /msg <target> <text>' };
      return { cmd: 'say', target, text: body.join(' ') };
    }
    case 'me':
      return joined ? { cmd: 'me', text: joined } : { cmd: 'error', error: 'usage: /me <text>' };
    case 'topic':
      return { cmd: 'topic', channel: channelArg, text: channelArg ? rest.slice(1).join(' ') || undefined : joined || undefined };
    case 'names':
      return { cmd: 'names', channel: channelArg };
    case 'who':
      return { cmd: 'who', mask: rest[0] };
    case 'nick':
      return rest[0] ? { cmd: 'nick', nick: rest[0] } : { cmd: 'error', error: 'usage: /nick <nick>' };
    case 'quit':
      return { cmd: 'quit', text: joined || undefined };
    case 'help':
    case 'clear':
      return null;
    default:
      return { cmd: 'error', error: `unknown command: /${command}` };
  }
}

function push(state, entry) {
  const messages = [...state.messages, entry];
  if (messages.length > MAX_MESSAGES) messages.splice(0, messages.length - MAX_MESSAGES);
  return messages;
}

function usersOf(channels, name) {
  const channel = channels.find((c) => c.name === name);
  return channel ? channel.users : [];
}

/** Fold one bridge message into the UI state. Pure: same input, same output. */
export function reduce(state, message) {
  if (!message || typeof message !== 'object') return state;
  switch (message.type) {
    case 'state': {
      const channels = Array.isArray(message.channels) ? message.channels : [];
      const current = message.current ?? state.current;
      return {
        ...state,
        nick: message.nick ?? state.nick,
        registered: message.registered === true,
        current: current ?? null,
        channels,
        users: usersOf(channels, current),
      };
    }
    case 'registered':
      return {
        ...state,
        nick: message.nick ?? state.nick,
        registered: true,
        status: 'connected',
        messages: push(state, { kind: 'system', text: `* connected as ${message.nick ?? 'unknown'}` }),
      };
    case 'message':
      return {
        ...state,
        messages: push(state, {
          kind: message.action ? 'action' : 'message',
          nick: message.nick ?? '?',
          target: message.target ?? null,
          text: message.text ?? '',
        }),
      };
    case 'notice':
      return { ...state, messages: push(state, { kind: 'notice', nick: message.nick ?? 'server', text: message.text ?? '' }) };
    case 'join':
      return {
        ...state,
        messages: push(state, { kind: 'system', text: `* ${message.nick} ${message.self ? 'joined (you)' : 'joined'} ${message.channel}` }),
      };
    case 'part':
      return {
        ...state,
        messages: push(state, { kind: 'system', text: `* ${message.nick} left ${message.channel}${message.text ? ` (${message.text})` : ''}` }),
      };
    case 'quit':
      return { ...state, messages: push(state, { kind: 'system', text: `* ${message.nick} quit${message.text ? ` (${message.text})` : ''}` }) };
    case 'nick':
      return { ...state, messages: push(state, { kind: 'system', text: `* ${message.oldNick} is now ${message.nick}` }) };
    case 'topic':
      return {
        ...state,
        channels: state.channels.map((c) => (c.name === message.channel ? { ...c, topic: message.text } : c)),
        messages: push(state, { kind: 'system', text: `* topic for ${message.channel}: ${message.text ?? '(none)'}` }),
      };
    case 'who':
      return { ...state, messages: push(state, { kind: 'system', text: `* WHO ${message.mask}: ${(message.users ?? []).map((u) => u.nick).join(' ')}` }) };
    case 'error':
      return { ...state, messages: push(state, { kind: 'error', text: `! ${message.error ?? message.code ?? 'error'}` }) };
    case 'ack':
      return state;
    case 'close':
      return { ...state, status: 'disconnected', registered: false, messages: push(state, { kind: 'system', text: '* disconnected' }) };
    default:
      return state;
  }
}

/** Minimal DOM renderer: three panes plus the status line. */
export function render(state, els) {
  els.status.textContent = state.status;
  els.nick.textContent = state.nick ? state.nick : 'not connected';

  els.channels.replaceChildren(...state.channels.map((channel) => {
    const li = document.createElement('li');
    li.textContent = channel.name + (channel.users.length ? ` (${channel.users.length})` : '');
    if (channel.name === state.current) li.className = 'current';
    return li;
  }));

  els.users.replaceChildren(...state.users.map((user) => {
    const li = document.createElement('li');
    if (user.op) {
      const badge = document.createElement('span');
      badge.className = 'op';
      badge.textContent = '@';
      li.append(badge, document.createTextNode(user.nick));
    } else {
      li.textContent = user.nick;
    }
    return li;
  }));

  els.messages.replaceChildren(...state.messages.map((entry) => {
    const li = document.createElement('li');
    li.className = entry.kind;
    if (entry.nick) {
      const who = document.createElement('span');
      who.className = 'who';
      who.textContent = entry.kind === 'action' ? `* ${entry.nick} ` : `<${entry.nick}> `;
      li.append(who, document.createTextNode(entry.text));
    } else {
      li.textContent = entry.text;
    }
    return li;
  }));

  const current = state.channels.find((c) => c.name === state.current);
  els.messagesTitle.textContent = current ? `${current.name}${current.topic ? ` - ${current.topic}` : ''}` : 'Messages';
}

/** Wire the UI to the bridge. Only runs in a browser. */
export function mount(url = `ws://${location.host}/ws`) {
  const els = {
    status: document.getElementById('status'),
    nick: document.getElementById('nick'),
    channels: document.getElementById('channels'),
    users: document.getElementById('users'),
    messages: document.getElementById('messages'),
    messagesTitle: document.getElementById('messages-title'),
  };
  let state = initialState();
  const draw = () => render(state, els);

  const socket = new WebSocket(url);
  socket.addEventListener('open', () => {
    state = { ...state, status: 'connected' };
    draw();
  });
  socket.addEventListener('close', () => {
    state = reduce(state, { type: 'close' });
    draw();
  });
  socket.addEventListener('message', (event) => {
    let payload;
    try {
      payload = JSON.parse(event.data);
    } catch {
      return;
    }
    state = reduce(state, payload);
    draw();
  });

  document.getElementById('composer').addEventListener('submit', (event) => {
    event.preventDefault();
    const input = document.getElementById('input');
    const raw = input.value;
    const command = parseInput(raw, state);
    input.value = '';
    if (!command) {
      state = reduce(state, { type: 'error', error: `ignored: ${raw}` });
      draw();
      return;
    }
    if (command.cmd === 'error') {
      state = reduce(state, { type: 'error', error: command.error });
      draw();
      return;
    }
    if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(command));
  });

  draw();
  return { state: () => state, socket };
}

if (typeof document !== 'undefined' && typeof WebSocket !== 'undefined') {
  mount();
}
