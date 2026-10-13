import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { WebSocket } from 'ws';
import { createIrcService, inspectIrcSource, ircBind, ircSourceRoot, parseIrcLine } from '../server/irc.mjs';

const token = 'orbit-irc-test-token-orbit-irc-test';

function reply(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      server.close(() => resolve(port));
    });
  });
}

function writeFixture(root, portFile) {
  fs.mkdirSync(path.join(root, 'packages', 'protocol'), { recursive: true });
  fs.mkdirSync(path.join(root, 'packages', 'client'), { recursive: true });
  fs.mkdirSync(path.join(root, 'packages', 'orbit-app'), { recursive: true });
  const ircd = path.join(root, 'packages', 'ircd');
  fs.mkdirSync(ircd, { recursive: true });
  fs.writeFileSync(path.join(ircd, 'package.json'), JSON.stringify({ name: 'ircd', main: 'server.js' }));
  fs.writeFileSync(path.join(ircd, 'server.js'), `
    const net = require('net');
    const host = process.env.ORBIT_IRC_HOST || '127.0.0.1';
    const port = Number(process.env.ORBIT_IRC_PORT);
    require('fs').writeFileSync(${JSON.stringify(portFile)}, String(port));
    const server = net.createServer(socket => {
      let nick = 'guest';
      socket.on('data', buf => {
        for (const line of buf.toString().split(/\\r?\\n/).filter(Boolean)) {
          const parts = line.split(' ');
          const command = parts[0].toUpperCase();
          if (command === 'NICK') nick = parts[1];
          else if (command === 'USER') socket.write(':fixture 001 ' + nick + ' :Welcome\\r\\n');
          else if (command === 'JOIN') {
            const channel = parts[1];
            socket.write(':' + nick + '!' + nick + '@orbit JOIN ' + channel + '\\r\\n');
            socket.write(':fixture 353 ' + nick + ' = ' + channel + ' :' + nick + ' fixture\\r\\n');
          } else if (command === 'PRIVMSG') {
            const text = parts.slice(2).join(' ').replace(/^:/, '');
            socket.write(':fixture!fixture@orbit PRIVMSG ' + parts[1] + ' :' + text + '\\r\\n');
          } else if (command === 'PING') socket.write('PONG :orbit\\r\\n');
        }
      });
    });
    server.listen(port, host);
  `);
}

test('irc bind defaults to loopback 6667 and rejects other hosts', () => {
  assert.deepEqual(ircBind({}), { host: '127.0.0.1', port: 6667 });
  assert.deepEqual(ircBind({ ORBIT_IRC_PORT: '6700', ORBIT_IRC_HOST: '::1' }), { host: '::1', port: 6700 });
  assert.throws(() => ircBind({ ORBIT_IRC_HOST: '0.0.0.0' }), /127\.0\.0\.1/);
  assert.throws(() => ircBind({ ORBIT_IRC_PORT: '80' }), /1024/);
  assert.equal(ircSourceRoot({}, '/repo/orbit'), '/repo/orbit/apps/irc');
  assert.equal(ircSourceRoot({ ORBIT_IRC_SOURCE: 'vendor/irc' }, '/repo/orbit'), '/repo/orbit/vendor/irc');
});

test('parseIrcLine reads prefix, command, and trailing text', () => {
  const ping = parseIrcLine('PING :orbit.local');
  assert.equal(ping.command, 'PING');
  assert.equal(ping.trailing, 'orbit.local');
  const names = parseIrcLine(':fixture 353 kyle = #orbit :kyle fixture');
  assert.equal(names.command, '353');
  assert.equal(names.args.at(-1), '#orbit');
  assert.equal(names.trailing, 'kyle fixture');
  assert.equal(parseIrcLine(''), null);
});

test('a missing source is reported and does not start a process', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-irc-missing-'));
  const orbitPort = await freePort();
  const irc = createIrcService({
    token, orbitPort, devOrigins: [], reply, repoRoot: root,
    env: { ORBIT_IRC_SOURCE: 'apps/irc' },
  });
  t.after(() => irc.close());
  const view = inspectIrcSource(path.join(root, 'apps', 'irc'));
  assert.equal(view.present, false);
  assert.equal(view.packages.ircd, false);
  const server = http.createServer((req, res) => { void irc.handle(req, res); });
  await new Promise(resolve => server.listen(orbitPort, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const origin = `http://127.0.0.1:${orbitPort}`;
  const status = await fetch(`${origin}/api/irc`, {
    method: 'POST',
    headers: { Origin: origin, Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'status' }),
  });
  const body = await status.json();
  assert.equal(status.status, 200);
  assert.equal(body.status, 'missing');
  assert.match(body.error, /packages\/ircd/);
  assert.match(body.source, /apps\/irc$/);
  const started = await fetch(`${origin}/api/irc`, {
    method: 'POST',
    headers: { Origin: origin, Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'start' }),
  });
  assert.equal(started.status, 409);
  const denied = await fetch(`${origin}/api/irc`, {
    method: 'POST',
    headers: { Origin: origin, 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'status' }),
  });
  assert.equal(denied.status, 401);
  const foreign = await fetch(`${origin}/api/irc`, {
    method: 'POST',
    headers: { Origin: 'http://evil.example', Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'status' }),
  });
  assert.equal(foreign.status, 403);
});

test('the bundled ircd starts, the websocket bridge relays a channel, and stop shuts it down', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-irc-live-'));
  const source = path.join(root, 'apps', 'irc');
  const portFile = path.join(root, 'port.txt');
  writeFixture(source, portFile);
  const orbitPort = await freePort();
  const ircPort = await freePort();
  const irc = createIrcService({
    token, orbitPort, devOrigins: [], reply, repoRoot: root,
    env: { ORBIT_IRC_SOURCE: source, ORBIT_IRC_PORT: String(ircPort) },
  });
  const server = http.createServer((req, res) => { void irc.handle(req, res); });
  server.on('upgrade', (req, socket, head) => irc.upgrade(req, socket, head));
  await new Promise(resolve => server.listen(orbitPort, '127.0.0.1', resolve));
  t.after(async () => {
    irc.close();
    await new Promise(resolve => server.close(resolve));
  });
  const origin = `http://127.0.0.1:${orbitPort}`;
  const headers = { Origin: origin, Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
  const started = await fetch(`${origin}/api/irc`, { method: 'POST', headers, body: JSON.stringify({ action: 'start' }) });
  const running = await started.json();
  assert.equal(started.status, 200, JSON.stringify(running));
  assert.equal(running.status, 'running');
  assert.equal(running.host, '127.0.0.1');
  assert.equal(running.port, ircPort);
  assert.equal(fs.readFileSync(portFile, 'utf8'), String(ircPort));
  const outside = path.join(root, 'outside.js');
  fs.writeFileSync(outside, 'process.exit(0)\n');
  fs.writeFileSync(path.join(source, 'packages', 'ircd', 'package.json'), JSON.stringify({ main: '../../../outside.js' }));
  const escaped = inspectIrcSource(source);
  assert.equal(escaped.ircdEntry.includes(`${path.sep}outside.js`), false);
  assert.equal(escaped.ircdEntry.startsWith(`${source}${path.sep}`), true);

  const messages = [];
  const ws = new WebSocket(`ws://127.0.0.1:${orbitPort}/api/irc`, { headers: { Origin: origin } });
  await new Promise((resolve, reject) => {
    ws.once('open', resolve);
    ws.once('error', reject);
  });
  ws.on('message', data => messages.push(JSON.parse(data.toString())));
  ws.send(JSON.stringify({ type: 'nick', nick: 'Kyle' }));
  await new Promise(resolve => ws.once('close', resolve));
  assert.equal(ws.readyState, WebSocket.CLOSED);

  const client = new WebSocket(`ws://127.0.0.1:${orbitPort}/api/irc`, { headers: { Origin: origin } });
  const inbox = [];
  client.on('message', data => inbox.push(JSON.parse(data.toString())));
  await new Promise((resolve, reject) => {
    client.once('open', resolve);
    client.once('error', reject);
  });
  const waitFor = type => new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(Error(`no ${type}: ${JSON.stringify(inbox)}`)), 3000);
    const pull = () => {
      const found = inbox.find(item => item.type === type);
      if (!found) return;
      clearTimeout(timer);
      resolve(found);
    };
    pull();
    client.on('message', pull);
  });
  client.send(JSON.stringify({ type: 'auth', token }));
  const ready = await waitFor('ready');
  assert.equal(ready.status, 'running');
  client.send(JSON.stringify({ type: 'nick', nick: 'Kyle' }));
  const welcome = await waitFor('welcome');
  assert.equal(welcome.nick, 'Kyle');
  client.send(JSON.stringify({ type: 'join', channel: '#orbit' }));
  const names = await waitFor('names');
  assert.equal(names.channel, '#orbit');
  assert.deepEqual(names.users, ['Kyle', 'fixture']);
  client.send(JSON.stringify({ type: 'privmsg', target: '#orbit', text: 'hello orbit' }));
  const echoed = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(Error(JSON.stringify(inbox))), 3000);
    const pull = () => {
      const found = inbox.find(item => item.type === 'message' && item.from === 'fixture' && item.text === 'hello orbit');
      if (!found) return;
      clearTimeout(timer);
      resolve(found);
    };
    pull();
    client.on('message', pull);
  });
  assert.equal(echoed.channel, '#orbit');
  client.close();

  const stopped = await fetch(`${origin}/api/irc`, { method: 'POST', headers, body: JSON.stringify({ action: 'stop' }) });
  const after = await stopped.json();
  assert.equal(stopped.status, 200);
  assert.equal(after.status, 'stopped');
  await new Promise((resolve, reject) => {
    const socket = net.connect({ host: '127.0.0.1', port: ircPort });
    socket.once('connect', () => { socket.destroy(); reject(Error('ircd still accepting')); });
    socket.once('error', () => resolve());
  });
});
