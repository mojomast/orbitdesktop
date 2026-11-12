// Shared test helpers: a recording fake IRC client, a raw upgrade probe and a
// small event waiter.
import { EventEmitter } from 'node:events';
import net from 'node:net';
import { makeKey } from '../src/ws.js';

/** IrcClient-shaped stand-in: records calls and can be driven to emit events. */
export class FakeClient extends EventEmitter {
  constructor(options = {}) {
    super();
    this.options = options;
    this.calls = [];
    this.nick = options.nick ?? 'fake';
    this.registered = false;
    this.channels = new Map();
    this.on('error', () => {});
  }

  _record(name, ...args) {
    this.calls.push([name, ...args]);
    return this;
  }

  connect() { return this._record('connect'); }

  join(channel, key) {
    this._record('join', channel, key);
    this.channels.set(String(channel).toLowerCase(), {
      name: channel,
      topic: null,
      users: new Map([[this.nick, { nick: this.nick, prefix: '@', op: true, voice: false }]]),
    });
    this.emit('join', { nick: this.nick, channel, self: true });
    return this;
  }

  part(channel, text) {
    this._record('part', channel, text);
    this.channels.delete(String(channel).toLowerCase());
    return this;
  }

  say(target, text) { return this._record('say', target, text); }
  notice(target, text) { return this._record('notice', target, text); }
  action(target, text) { return this._record('action', target, text); }
  topic(channel, text) { return this._record('topic', channel, text); }
  names(channel) { return this._record('names', channel); }
  who(mask) { return this._record('who', mask); }
  mode(target, modes) { return this._record('mode', target, modes); }
  send(line) { return this._record('send', line); }
  setNick(nick) { this._record('setNick', nick); this.nick = nick; return this; }
  quit(text) { return this._record('quit', text); }
  close() { return this._record('close'); }
}

/** Factory that keeps every client it made so tests can drive them. */
export function fakeClientFactory(store = []) {
  const factory = (options) => {
    const client = new FakeClient(options);
    store.push(client);
    return client;
  };
  factory.clients = store;
  return factory;
}

/** Open a raw TCP connection and send a websocket upgrade request by hand. */
export function rawUpgrade(url, { path = '/ws', key = makeKey(), omitUpgrade = false, omitKey = false } = {}) {
  const parsed = new URL(url);
  const port = Number(parsed.port || 80);
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, parsed.hostname);
    let buffer = '';
    socket.setEncoding('utf8');
    socket.on('data', (chunk) => {
      buffer += chunk;
      if (buffer.includes('\r\n\r\n') || /^HTTP\/1\.1 \d+/.test(buffer) === false) {
        socket.destroy();
        resolve({ status: buffer.split('\r\n')[0], headers: buffer });
      }
    });
    socket.on('error', reject);
    const lines = [
      `GET ${path} HTTP/1.1`,
      `Host: ${parsed.hostname}:${port}`,
      ...(omitUpgrade ? [] : ['Upgrade: websocket', 'Connection: Upgrade']),
      ...(omitKey ? [] : [`Sec-WebSocket-Key: ${key}`]),
      'Sec-WebSocket-Version: 13',
      '',
      '',
    ];
    socket.write(lines.join('\r\n'));
  });
}

/** Wait for the next emission of an event. */
export function waitForEvent(emitter, event, timeout = 3000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      emitter.removeListener(event, handler);
      reject(new Error(`timeout waiting for ${event}`));
    }, timeout);
    function handler(...args) {
      clearTimeout(timer);
      resolve(args.length > 1 ? args : args[0]);
    }
    emitter.once(event, handler);
  });
}

export const settle = (ms = 80) => new Promise((resolve) => setTimeout(resolve, ms));
