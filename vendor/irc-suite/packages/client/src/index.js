// packages/client/src/index.js
// EventEmitter-based IRC client library (RFC 1459 / 2812 subset).
import { EventEmitter } from 'node:events';
import net from 'node:net';
import {
  parseMessage, serializeMessage, splitLines, parsePrefix, ircLower, ircEquals, isChannelName,
} from '../../protocol/src/index.js';

export const DEFAULT_HOST = '127.0.0.1';
export const DEFAULT_PORT = 6667;

const NAME_PREFIXES = { '~': 'owner', '&': 'admin', '@': 'op', '%': 'halfop', '+': 'voice' };

/** Split a NAMES token like '@alice' into { nick, prefix, op, voice }. */
export function parseNamesToken(token) {
  let prefix = '';
  let nick = String(token);
  while (nick.length && NAME_PREFIXES[nick[0]]) { prefix += nick[0]; nick = nick.slice(1); }
  return { nick, prefix, op: prefix.includes('@'), voice: prefix.includes('+') };
}

/** Parse the 352 WHO reply trailing field ("0 Real Name") into a real name. */
export function parseWhoRealname(trailing) {
  return String(trailing ?? '').replace(/^\d+\s*/, '');
}

export class IrcClient extends EventEmitter {
  constructor({ host, port, nick, user, realname, password, autoPong = true } = {}) {
    super();
    if (!nick) throw new Error('nick is required');
    this.host = host || DEFAULT_HOST;
    this.port = port ?? DEFAULT_PORT;
    this.nick = nick;
    this.user = user || nick;
    this.realname = realname || nick;
    this.password = password || null;
    this.autoPong = autoPong;
    this.socket = null;
    this.buffer = '';
    this.registered = false;
    this.serverName = null;
    this.channels = new Map(); // ircLower(channel) -> { name, key, topic, users: Map<key, user> }
    this.pendingNames = new Map();
    this.pendingWho = new Map();
    this.on('error', () => {}); // never let Node throw when the caller ignores 'error'
  }

  /** Connect the socket. Returns this for chaining. Registration completes on 001. */
  connect() {
    if (this.socket) return this;
    const socket = net.createConnection({ host: this.host, port: this.port });
    socket.setEncoding('utf8');
    this.socket = socket;
    socket.on('connect', () => {
      this.emit('connect');
      if (this.password) this.raw({ command: 'PASS', params: [this.password] });
      this.raw({ command: 'NICK', params: [this.nick] });
      this.raw({ command: 'USER', params: [this.user, '0', '*', this.realname] });
    });
    socket.on('data', (chunk) => this._onData(chunk));
    socket.on('error', (err) => this.emit('error', err));
    socket.on('close', () => {
      this.registered = false;
      this.socket = null;
      this.emit('close');
    });
    return this;
  }

  /** Write one already-formed line (CRLF added if missing). */
  send(line) {
    if (!this.socket || this.socket.destroyed) throw new Error('client is not connected');
    const text = String(line);
    this.socket.write(text.endsWith('\r\n') ? text : text + '\r\n');
    return this;
  }

  /** Write a message object via the shared serializer. */
  raw(msg) {
    this.send(serializeMessage(msg));
    return this;
  }

  _onData(chunk) {
    this.buffer += chunk;
    const { lines, rest } = splitLines(this.buffer);
    this.buffer = rest;
    for (const line of lines) {
      try {
        this._handleLine(line);
      } catch (err) {
        this.emit('error', err);
      }
    }
  }

  isMe(nick) {
    return nick != null && ircEquals(nick, this.nick);
  }

  _ensureChannel(name) {
    const key = ircLower(name);
    let channel = this.channels.get(key);
    if (!channel) {
      channel = { name, key, topic: null, users: new Map() };
      this.channels.set(key, channel);
    }
    return channel;
  }

  channel(name) {
    return this.channels.get(ircLower(name)) ?? null;
  }

  _removeUser(nick, reason) {
    const key = ircLower(nick);
    for (const channel of this.channels.values()) {
      if (channel.users.has(key)) {
        channel.users.delete(key);
        this.emit('leave', { nick, channel: channel.name, reason });
      }
    }
  }

  _handleLine(line) {
    const msg = parseMessage(line);
    if (!msg) return;
    this.emit('raw', { line, message: msg });
    const { nick, user, host } = parsePrefix(msg.prefix);
    const p = msg.params;
    const command = msg.command;

    switch (command) {
      case 'PING':
        this.emit('ping', p[0] ?? null);
        if (this.autoPong) this.raw({ command: 'PONG', params: [p[0] ?? this.nick] });
        break;
      case 'PONG':
        this.emit('pong', p[0] ?? null);
        break;
      case '001':
        this.nick = p[0] || this.nick;
        this.serverName = nick || null;
        this.registered = true;
        this.emit('registered', { nick: this.nick, server: this.serverName, welcome: p[1] ?? '', raw: line });
        break;
      case '004':
        this.serverName = p[1] || this.serverName;
        this.emit('serverinfo', { code: command, params: p });
        break;
      case '005':
        this.emit('isupport', { params: p, tokens: Object.fromEntries(p.filter((t) => t.includes('=')).map((t) => t.split('='))) });
        break;
      case 'PRIVMSG': {
        const target = p[0] ?? '';
        const text = p[1] ?? '';
        const isAction = text.startsWith('\u0001ACTION ') && text.endsWith('\u0001');
        const event = {
          nick,
          user,
          host,
          target,
          text: isAction ? text.slice(8, -1) : text,
          isChannel: isChannelName(target),
          isAction,
          raw: line,
        };
        if (isAction) this.emit('action', event);
        this.emit('message', event);
        break;
      }
      case 'NOTICE':
        this.emit('notice', { nick, user, host, target: p[0] ?? '', text: p[1] ?? '', raw: line });
        break;
      case 'JOIN': {
        const channel = p[0] ?? '';
        const self = this.isMe(nick);
        if (nick) this._ensureChannel(channel).users.set(ircLower(nick), { nick, prefix: '', op: self, voice: false });
        this.emit('join', { nick, channel, self, raw: line });
        break;
      }
      case 'PART': {
        const channel = p[0] ?? '';
        const self = this.isMe(nick);
        const chan = this.channel(channel);
        if (chan && nick) chan.users.delete(ircLower(nick));
        if (self) this.channels.delete(ircLower(channel));
        this.emit('part', { nick, channel, text: p[1] ?? null, self, raw: line });
        break;
      }
      case 'KICK': {
        const channel = p[0] ?? '';
        const victim = p[1] ?? '';
        const self = this.isMe(victim);
        const chan = this.channel(channel);
        if (chan && victim) chan.users.delete(ircLower(victim));
        if (self) this.channels.delete(ircLower(channel));
        this.emit('kick', { nick, channel, victim, text: p[2] ?? null, self, raw: line });
        break;
      }
      case 'QUIT':
        this._removeUser(nick, 'quit');
        this.emit('quit', { nick, text: p[0] ?? null, reason: p[0] ?? null, raw: line });
        break;
      case 'NICK': {
        const newNick = p[0] ?? '';
        const self = this.isMe(nick);
        if (self) this.nick = newNick;
        if (nick) {
          const oldKey = ircLower(nick);
          for (const chan of this.channels.values()) {
            if (chan.users.has(oldKey)) {
              const entry = chan.users.get(oldKey);
              chan.users.delete(oldKey);
              entry.nick = newNick;
              chan.users.set(ircLower(newNick), entry);
            }
          }
        }
        this.emit('nick', { oldNick: nick, nick: newNick, newNick, self, raw: line });
        break;
      }
      case 'TOPIC': {
        const channel = p[0] ?? '';
        const text = p[1] ?? '';
        const chan = this.channel(channel);
        if (chan) chan.topic = text;
        this.emit('topic', { channel, text, nick, by: nick, raw: line });
        break;
      }
      case '332': {
        const channel = p[1] ?? '';
        const text = p[2] ?? '';
        const chan = this.channel(channel);
        if (chan) chan.topic = text;
        this.emit('topic', { channel, text, nick: null, raw: line });
        break;
      }
      case '331': {
        const channel = p[1] ?? '';
        const chan = this.channel(channel);
        if (chan) chan.topic = null;
        this.emit('topic', { channel, text: null, nick: null, absent: true, raw: line });
        break;
      }
      case '353': {
        const channel = p[2] ?? '';
        const list = p[3] ?? '';
        const key = ircLower(channel);
        const tokens = this.pendingNames.get(key) ?? [];
        if (!this.pendingNames.has(key)) this.pendingNames.set(key, tokens);
        const chan = this._ensureChannel(channel);
        for (const token of list.split(' ')) {
          if (!token) continue;
          tokens.push(token);
          const entry = parseNamesToken(token);
          if (entry.nick) chan.users.set(ircLower(entry.nick), entry);
        }
        this.emit('namesreply', { channel, names: list.split(' ').filter(Boolean), raw: line });
        break;
      }
      case '366': {
        const channel = p[1] ?? '';
        const key = ircLower(channel);
        const names = this.pendingNames.get(key) ?? [];
        this.pendingNames.delete(key);
        this.emit('names', { channel, names, users: names.map(parseNamesToken), raw: line });
        break;
      }
      case '352': {
        const channel = p[1] ?? '';
        const key = ircLower(channel);
        const entry = {
          user: p[2] ?? '',
          host: p[3] ?? '',
          server: p[4] ?? '',
          nick: p[5] ?? '',
          flags: p[6] ?? '',
          op: (p[6] ?? '').includes('@'),
          away: (p[6] ?? '').includes('G'),
          realname: parseWhoRealname(p[7]),
        };
        const list = this.pendingWho.get(key) ?? [];
        if (!this.pendingWho.has(key)) this.pendingWho.set(key, list);
        list.push(entry);
        this.emit('whoreply', entry);
        break;
      }
      case '315': {
        const mask = p[1] ?? '';
        const list = this.pendingWho.get(ircLower(mask)) ?? [];
        this.pendingWho.delete(ircLower(mask));
        this.emit('who', { mask, users: list, raw: line });
        break;
      }
      case '324':
        this.emit('mode', { target: p[1] ?? '', modes: p[2] ?? '', params: p.slice(3), channel: true, nick: null, raw: line });
        break;
      case '221':
        this.emit('mode', { target: this.nick, modes: p[1] ?? '', params: [], user: true, nick: null, raw: line });
        break;
      case 'MODE':
        this.emit('mode', { target: p[0] ?? '', modes: p[1] ?? '', params: p.slice(2), nick, raw: line });
        break;
      case '433':
        this.emit('nickinuse', { nick: p[1] ?? '', text: p[2] ?? '', raw: line });
        this.emit('error', { code: command, params: p, text: p[p.length - 1] ?? '', raw: line });
        break;
      default:
        if (/^\d{3}$/.test(command)) {
          if (Number(command) >= 400) this.emit('error', { code: command, params: p, text: p[p.length - 1] ?? '', raw: line });
          else this.emit('numeric', { code: command, params: p, raw: line });
        } else {
          this.emit('unknown', { command, params: p, raw: line });
        }
    }
  }

  // --- commands -------------------------------------------------------------

  join(channel, key) {
    return this.raw({ command: 'JOIN', params: key ? [channel, key] : [channel] });
  }

  part(channel, message) {
    return this.raw({ command: 'PART', params: message ? [channel, message] : [channel] });
  }

  say(target, text) {
    return this.raw({ command: 'PRIVMSG', params: [target, text] });
  }

  notice(target, text) {
    return this.raw({ command: 'NOTICE', params: [target, text] });
  }

  /** CTCP ACTION, the /me command. */
  action(target, text) {
    return this.raw({ command: 'PRIVMSG', params: [target, `\u0001ACTION ${text}\u0001`] });
  }

  me(target, text) {
    return this.action(target, text);
  }

  /** topic(channel) queries, topic(channel, text) sets. */
  topic(channel, text) {
    return this.raw({ command: 'TOPIC', params: text === undefined ? [channel] : [channel, text] });
  }

  names(channel) {
    return this.raw({ command: 'NAMES', params: [channel] });
  }

  who(mask) {
    return this.raw({ command: 'WHO', params: [mask] });
  }

  mode(target, modes, ...args) {
    return this.raw({ command: 'MODE', params: modes === undefined ? [target] : [target, modes, ...args] });
  }

  setNick(nick) {
    this.nick = nick;
    return this.raw({ command: 'NICK', params: [nick] });
  }

  /** Send QUIT and close the socket. */
  quit(message) {
    try {
      this.raw({ command: 'QUIT', params: message ? [message] : [] });
    } catch {
      // already closed
    }
    return this.close();
  }

  close() {
    if (this.socket) this.socket.end();
    return this;
  }

  // --- queries --------------------------------------------------------------

  /** Nicknames the client currently believes are in a channel. */
  members(channel) {
    const chan = this.channel(channel);
    return chan ? [...chan.users.values()].map((u) => u.nick) : [];
  }

  channelNames() {
    return [...this.channels.values()].map((c) => c.name);
  }
}

export default IrcClient;
