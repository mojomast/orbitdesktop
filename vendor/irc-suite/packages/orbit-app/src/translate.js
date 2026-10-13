// Pure translation between IrcClient events/commands and the JSON the browser
// speaks. No sockets, no timers, so this is directly unit testable.

/** Client events relayed to the browser. */
export const RELAYED_EVENTS = [
  'registered', 'message', 'action', 'notice', 'join', 'part', 'kick', 'quit',
  'nick', 'topic', 'names', 'who', 'mode', 'error', 'close', 'numeric',
];

/** Events after which the browser should be sent a fresh channel/user snapshot. */
export const STATE_EVENTS = ['registered', 'join', 'part', 'kick', 'quit', 'nick', 'names', 'close'];

function str(value) {
  return typeof value === 'string' ? value : undefined;
}

/** Turn one IrcClient event payload into a JSON-safe message with a type field. */
export function translateEvent(type, payload = {}) {
  const base = { type };
  switch (type) {
    case 'registered':
      return { ...base, nick: str(payload.nick) ?? null, server: str(payload.server) ?? null };
    case 'message':
    case 'action':
      return {
        ...base,
        type: type === 'action' || payload.isAction ? 'message' : 'message',
        action: type === 'action' || payload.isAction === true,
        nick: str(payload.nick) ?? null,
        user: str(payload.user) ?? null,
        host: str(payload.host) ?? null,
        target: str(payload.target) ?? null,
        text: str(payload.text) ?? '',
        channel: str(payload.target)?.startsWith('#') ? payload.target : null,
      };
    case 'notice':
      return { ...base, nick: str(payload.nick) ?? null, target: str(payload.target) ?? null, text: str(payload.text) ?? '' };
    case 'join':
      return { ...base, nick: str(payload.nick) ?? null, channel: str(payload.channel) ?? null, self: payload.self === true };
    case 'part':
      return { ...base, nick: str(payload.nick) ?? null, channel: str(payload.channel) ?? null, text: str(payload.text) ?? null, self: payload.self === true };
    case 'kick':
      return { ...base, nick: str(payload.nick) ?? null, channel: str(payload.channel) ?? null, victim: str(payload.victim) ?? null, text: str(payload.text) ?? null, self: payload.self === true };
    case 'quit':
      return { ...base, nick: str(payload.nick) ?? null, text: str(payload.text) ?? null };
    case 'nick':
      return { ...base, oldNick: str(payload.oldNick) ?? null, nick: str(payload.newNick ?? payload.nick) ?? null, self: payload.self === true };
    case 'topic':
      return { ...base, channel: str(payload.channel) ?? null, text: payload.text === null ? null : str(payload.text) ?? '', nick: str(payload.nick) ?? null, absent: payload.absent === true };
    case 'names':
      return {
        ...base,
        channel: str(payload.channel) ?? null,
        users: Array.isArray(payload.users) ? payload.users.map((u) => ({ nick: str(u.nick) ?? '', prefix: str(u.prefix) ?? '', op: u.op === true, voice: u.voice === true })) : [],
      };
    case 'who':
      return {
        ...base,
        mask: str(payload.mask) ?? null,
        users: Array.isArray(payload.users)
          ? payload.users.map((u) => ({ nick: str(u.nick) ?? '', user: str(u.user) ?? '', host: str(u.host) ?? '', realname: str(u.realname) ?? '', op: u.op === true, away: u.away === true }))
          : [],
      };
    case 'mode':
      return { ...base, target: str(payload.target) ?? null, modes: str(payload.modes) ?? '', params: Array.isArray(payload.params) ? payload.params.map(String) : [] };
    case 'error':
      return { ...base, error: str(payload.text) ?? str(payload.message) ?? 'error', code: str(payload.code) ?? null, params: Array.isArray(payload.params) ? payload.params.map(String) : [] };
    case 'numeric':
      return { ...base, code: str(payload.code) ?? null, params: Array.isArray(payload.params) ? payload.params.map(String) : [] };
    case 'close':
      return { ...base, message: 'disconnected' };
    default:
      return { ...base };
  }
}

/** Snapshot of the channels, members and topic the client currently knows about. */
export function stateSnapshot(client, currentChannel = null) {
  const channels = [];
  try {
    if (client && client.channels && typeof client.channels.forEach === 'function') {
      for (const channel of client.channels.values()) {
        const users = [];
        if (channel.users && typeof channel.users.forEach === 'function') {
          for (const user of channel.users.values()) {
            users.push({ nick: str(user.nick) ?? '', prefix: str(user.prefix) ?? '', op: user.op === true, voice: user.voice === true });
          }
        }
        channels.push({ name: str(channel.name) ?? '', topic: channel.topic ?? null, users });
      }
    }
  } catch {
    // a stub client without channel bookkeeping simply reports no channels
  }
  return {
    type: 'state',
    nick: client?.nick ?? null,
    registered: client?.registered === true,
    current: currentChannel ?? null,
    channels,
  };
}

/** Validate one JSON command from the browser. Returns { cmd, ... } or { error }. */
export function translateCommand(text) {
  let data;
  try {
    data = JSON.parse(String(text));
  } catch {
    return { error: 'invalid JSON' };
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) return { error: 'expected a JSON object' };
  const cmd = String(data.cmd ?? '').toLowerCase();
  const key = str(data.key);
  switch (cmd) {
    case 'join': {
      const channel = str(data.channel) ?? str(data.target);
      if (!channel) return { error: 'join needs a channel' };
      return { cmd, channel, key };
    }
    case 'say': {
      const body = str(data.text);
      if (body === undefined || body === '') return { error: 'say needs text' };
      return { cmd, target: str(data.target) ?? str(data.channel), text: body };
    }
    case 'part': {
      return { cmd, channel: str(data.channel) ?? str(data.target), text: str(data.text) };
    }
    case 'topic': {
      return { cmd, channel: str(data.channel) ?? str(data.target), text: str(data.text) };
    }
    case 'me': {
      const body = str(data.text);
      if (body === undefined || body === '') return { error: 'me needs text' };
      return { cmd, target: str(data.target) ?? str(data.channel), text: body };
    }
    case 'notice': {
      const target = str(data.target) ?? str(data.channel);
      const body = str(data.text);
      if (!target || !body) return { error: 'notice needs target and text' };
      return { cmd, target, text: body };
    }
    case 'names': {
      return { cmd, channel: str(data.channel) ?? str(data.target) };
    }
    case 'who': {
      return { cmd, mask: str(data.mask) ?? str(data.target) };
    }
    case 'mode': {
      const target = str(data.target) ?? str(data.channel);
      if (!target) return { error: 'mode needs a target' };
      return { cmd, target, modes: str(data.modes) ?? str(data.mode) ?? '' };
    }
    case 'nick': {
      const nick = str(data.nick);
      if (!nick) return { error: 'nick needs a nick' };
      return { cmd, nick };
    }
    case 'quit': {
      return { cmd, text: str(data.text) };
    }
    case 'raw': {
      const line = str(data.line);
      if (!line) return { error: 'raw needs a line' };
      return { cmd, line };
    }
    case 'ping': {
      return { cmd, text: str(data.text) };
    }
    default:
      return { error: `unknown cmd: ${data.cmd ?? ''}` };
  }
}

/** Apply a validated command to an IrcClient. Returns a label describing the effect. */
export function applyCommand(client, command, state = {}) {
  const channel = command.channel ?? state.currentChannel ?? null;
  switch (command.cmd) {
    case 'join': {
      client.join(command.channel, command.key);
      state.currentChannel = command.channel;
      return { effect: 'join', channel: command.channel };
    }
    case 'say': {
      const target = command.target ?? state.currentChannel;
      if (!target) throw new Error('no channel joined yet');
      client.say(target, command.text);
      return { effect: 'say', target, text: command.text };
    }
    case 'part': {
      const target = channel;
      if (!target) throw new Error('nothing to part');
      client.part(target, command.text);
      if (state.currentChannel === target) state.currentChannel = null;
      return { effect: 'part', channel: target };
    }
    case 'topic': {
      const target = channel;
      if (!target) throw new Error('no channel for topic');
      client.topic(target, command.text);
      return { effect: 'topic', channel: target, text: command.text ?? null };
    }
    case 'notice': {
      client.notice(command.target, command.text);
      return { effect: 'notice', target: command.target };
    }
    case 'me': {
      const target = command.target ?? state.currentChannel;
      if (!target) throw new Error('no channel joined yet');
      client.action(target, command.text);
      return { effect: 'me', target, text: command.text };
    }
    case 'names': {
      client.names(channel ?? command.channel);
      return { effect: 'names', channel: channel ?? command.channel };
    }
    case 'who': {
      client.who(command.mask ?? state.currentChannel ?? '*');
      return { effect: 'who', mask: command.mask ?? state.currentChannel ?? '*' };
    }
    case 'mode': {
      client.mode(command.target, command.modes || undefined);
      return { effect: 'mode', target: command.target, modes: command.modes };
    }
    case 'nick': {
      client.setNick(command.nick);
      return { effect: 'nick', nick: command.nick };
    }
    case 'quit': {
      client.quit(command.text);
      return { effect: 'quit' };
    }
    case 'raw': {
      client.send(command.line);
      return { effect: 'raw', line: command.line };
    }
    case 'ping': {
      client.send(`PING :${command.text ?? 'ui'}`);
      return { effect: 'ping' };
    }
    default:
      throw new Error(`unsupported command: ${command.cmd}`);
  }
}
