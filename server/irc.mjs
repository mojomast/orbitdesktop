import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { WebSocketServer } from 'ws';
import { tokenMatches, allowedRequest } from './security.mjs';

const PACKAGE_DIRS = [
  ['protocol', 'packages/protocol'],
  ['ircd', 'packages/ircd'],
  ['client', 'packages/client'],
  ['orbitApp', 'packages/orbit-app'],
];

function fail(message, status = 400) {
  const error = new Error(message);
  error.status = status;
  return error;
}

export function ircBind(env = process.env) {
  const host = String(env?.ORBIT_IRC_HOST || '127.0.0.1').trim() || '127.0.0.1';
  if (host !== '127.0.0.1' && host !== '::1') throw fail('ORBIT_IRC_HOST must be 127.0.0.1 or ::1.', 400);
  const raw = env?.ORBIT_IRC_PORT;
  const port = raw === undefined || raw === '' ? 6667 : Number(raw);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw fail('ORBIT_IRC_PORT must be an integer from 1024 to 65535.', 400);
  return { host, port };
}

export function ircSourceRoot(env = process.env, repoRoot) {
  const raw = String(env?.ORBIT_IRC_SOURCE || '').trim();
  if (raw) return path.resolve(repoRoot, raw);
  return path.join(repoRoot, 'vendor', 'irc-suite');
}

function isDirectory(dir) {
  try { return fs.statSync(dir).isDirectory(); }
  catch { return false; }
}

function insideRoot(root, target) {
  try {
    const realRoot = fs.realpathSync(root);
    const realTarget = fs.realpathSync(target);
    return realTarget === realRoot || realTarget.startsWith(`${realRoot}${path.sep}`);
  } catch { return false; }
}

function ircdEntry(root) {
  const dir = path.join(root, 'packages', 'ircd');
  let pkg = {};
  try { pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')); }
  catch { pkg = {}; }
  let declared = '';
  if (typeof pkg.bin === 'string') declared = pkg.bin;
  else if (pkg.bin && typeof pkg.bin === 'object') declared = Object.values(pkg.bin).find(value => typeof value === 'string') || '';
  if (!declared && typeof pkg.main === 'string') declared = pkg.main;
  const candidates = [declared, 'server.js', 'index.js', 'src/server.js', 'src/index.js', 'bin/ircd.js'].filter(Boolean);
  for (const candidate of candidates) {
    if (typeof candidate !== 'string' || !candidate || candidate.includes('\0') || path.isAbsolute(candidate) || candidate.split(/[/\\]/).includes('..')) continue;
    const file = path.resolve(dir, candidate);
    if (!insideRoot(root, file)) continue;
    try { if (!fs.statSync(file).isFile()) continue; }
    catch { continue; }
    return file;
  }
  return '';
}

export function inspectIrcSource(root) {
  const packages = {};
  for (const [key, rel] of PACKAGE_DIRS) packages[key] = isDirectory(path.join(root, rel));
  const present = PACKAGE_DIRS.every(([key]) => packages[key]);
  return { root, present, packages, ircdEntry: present ? ircdEntry(root) : '' };
}

export function parseIrcLine(raw) {
  let line = String(raw || '').replace(/\r$/, '');
  if (!line) return null;
  let prefix = '';
  if (line.startsWith(':')) {
    const space = line.indexOf(' ');
    if (space === -1) return null;
    prefix = line.slice(1, space);
    line = line.slice(space + 1);
  }
  let trailing = '';
  const cut = line.indexOf(' :');
  if (cut !== -1) {
    trailing = line.slice(cut + 2);
    line = line.slice(0, cut);
  }
  const parts = line.split(' ').filter(Boolean);
  const command = String(parts.shift() || '').toUpperCase();
  if (!command) return null;
  return { prefix, nick: prefix.split('!')[0] || '', command, args: parts, trailing };
}

function cleanText(value, max) {
  const text = String(value || '').replace(/[\u0000-\u001f\u007f]/g, '').trim();
  return text.length > max ? '' : text;
}

function validNick(nick) {
  return /^[A-Za-z][A-Za-z0-9_[\]\\`^{}|-]{0,29}$/.test(nick);
}

function validChannel(channel) {
  return /^[#&][^\s,:]{1,48}$/.test(channel);
}

function validTarget(target) {
  return validChannel(target) || validNick(target);
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function canConnect(host, port) {
  return new Promise(resolve => {
    const socket = net.connect({ host, port });
    const done = ok => {
      socket.removeAllListeners();
      socket.destroy();
      resolve(ok);
    };
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
  });
}

export function createIrcService({ token, orbitPort, devOrigins = [], reply, repoRoot, env = process.env, spawnImpl = spawn } = {}) {
  let configError = '';
  let defaults = { host: '127.0.0.1', port: 6667 };
  try { defaults = ircBind(env); }
  catch (error) { configError = error.message; }
  const sourceRoot = ircSourceRoot(env, repoRoot);
  let child = null;
  let stderr = '';
  let runState = 'stopped';
  let runError = '';
  let active = { ...defaults };
  const sockets = new Set();
  const bridge = new WebSocketServer({ noServer: true, maxPayload: 16 * 1024, perMessageDeflate: false });

  function snapshot() {
    const source = inspectIrcSource(sourceRoot);
    const status = configError ? 'error' : (!source.present || !source.ircdEntry) && runState !== 'running' ? 'missing' : runState;
    return {
      status,
      host: active.host,
      port: active.port,
      source: source.root,
      packages: source.packages,
      entry: source.ircdEntry ? path.relative(source.root, source.ircdEntry) : '',
      error: configError || runError || (status === 'missing' ? `IRC sources are not installed. Expected packages/protocol, packages/ircd, packages/client, and packages/orbit-app under ${source.root}.` : ''),
    };
  }

  function stopProcess() {
    const current = child;
    child = null;
    if (!current) {
      runState = 'stopped';
      return;
    }
    runState = 'stopped';
    try { current.kill('SIGTERM'); } catch { /* already gone */ }
    const timer = setTimeout(() => { try { current.kill('SIGKILL'); } catch { /* already gone */ } }, 2000);
    timer.unref?.();
    current.once('exit', () => clearTimeout(timer));
  }

  async function startProcess(requestedPort) {
    if (configError) throw fail(configError, 400);
    if (child) return snapshot();
    const source = inspectIrcSource(sourceRoot);
    if (!source.present) {
      runState = 'missing';
      runError = '';
      throw fail(snapshot().error, 409);
    }
    if (!source.ircdEntry) throw fail('The ircd package has no entry point.', 409);
    const host = defaults.host;
    const port = requestedPort === undefined ? defaults.port : Number(requestedPort);
    if (!Number.isInteger(port) || port < 1024 || port > 65535) throw fail('IRC port must be an integer from 1024 to 65535.', 400);
    active = { host, port };
    stderr = '';
    runError = '';
    runState = 'starting';
    const spawned = spawnImpl(process.execPath, [source.ircdEntry, '--host', host, '--port', String(port)], {
      cwd: path.join(sourceRoot, 'packages', 'ircd'),
      env: {
        PATH: process.env.PATH || '',
        HOME: process.env.HOME || '',
        LANG: process.env.LANG || 'C.UTF-8',
        TMPDIR: process.env.TMPDIR || '/tmp',
        USER: process.env.USER || '',
        NODE_PATH: [path.join(sourceRoot, 'packages'), path.join(sourceRoot, 'node_modules')].join(path.delimiter),
        ORBIT_IRC_HOST: host,
        ORBIT_IRC_PORT: String(port),
        IRC_HOST: host,
        IRC_PORT: String(port),
        IRCD_HOST: host,
        IRCD_PORT: String(port),
      },
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    child = spawned;
    spawned.stderr?.on('data', chunk => {
      stderr = `${stderr}${chunk.toString()}`.slice(-500);
    });
    spawned.once('exit', code => {
      if (child === spawned) child = null;
      if (runState === 'starting' || runState === 'running') {
        runState = 'error';
        runError = stderr.trim() || `ircd exited (${code ?? 'signal'}).`;
      }
    });
    const ready = await waitUntilReady(spawned, host, port);
    if (!ready) {
      stopProcess();
      runState = 'error';
      runError = runError || stderr.trim() || 'ircd did not accept connections.';
      throw fail(runError, 502);
    }
    runState = 'running';
    runError = '';
    return snapshot();
  }

  async function waitUntilReady(spawned, host, port) {
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      if (spawned.exitCode !== null || child !== spawned) return false;
      if (await canConnect(host, port)) return true;
      await delay(40);
    }
    return false;
  }

  function openBridge(ws) {
    let irc = null;
    let buffer = '';
    let nick = '';
    let closed = false;
    const channels = new Map();
    const send = payload => {
      if (ws.readyState === 1) ws.send(JSON.stringify(payload));
    };
    const sendLine = line => {
      if (irc && !irc.destroyed) irc.write(`${line}\r\n`);
    };
    const closeIrc = () => {
      if (closed) return;
      closed = true;
      try { irc?.destroy(); } catch { /* already closed */ }
    };
    const noteUsers = (channel, users) => {
      channels.set(channel, users);
      send({ type: 'names', channel, users });
    };
    const onLine = raw => {
      const parsed = parseIrcLine(raw);
      if (!parsed) return;
      if (parsed.command === 'PING') {
        sendLine(`PONG :${parsed.trailing || parsed.args[0] || ''}`);
        return;
      }
      if (parsed.command === '001') {
        send({ type: 'welcome', nick });
        return;
      }
      if (parsed.command === 'JOIN') {
        const channel = parsed.args[0] || parsed.trailing;
        if (!validChannel(channel)) return;
        const users = channels.get(channel) || [];
        if (parsed.nick && !users.includes(parsed.nick)) users.push(parsed.nick);
        channels.set(channel, users);
        send({ type: 'join', channel, nick: parsed.nick });
        return;
      }
      if (parsed.command === 'PART' || parsed.command === 'QUIT') {
        const channel = parsed.command === 'PART' ? (parsed.args[0] || '') : '';
        const affected = channel ? [channel] : [...channels.keys()];
        for (const name of affected) {
          const users = (channels.get(name) || []).filter(user => user !== parsed.nick);
          noteUsers(name, users);
          send({ type: 'part', channel: name, nick: parsed.nick });
        }
        return;
      }
      if (parsed.command === '353') {
        const channel = parsed.args.find(validChannel) || '';
        if (!channel) return;
        const last = parsed.args.at(-1) || '';
        const listed = parsed.trailing || (last !== channel ? last : '');
        const users = listed.split(' ').map(name => name.replace(/^[@+%&~]/, '')).filter(Boolean);
        noteUsers(channel, users);
        return;
      }
      if (parsed.command === 'PRIVMSG') {
        const target = parsed.args[0] || '';
        const text = parsed.trailing || parsed.args.slice(1).join(' ');
        if (!validTarget(target) || !text) return;
        send({ type: 'message', channel: validChannel(target) ? target : (parsed.nick || target), from: parsed.nick || target, text });
      }
    };
    const session = {
      handle(message) {
        if (!message || typeof message !== 'object') return;
        if (message.type === 'nick') {
          const next = cleanText(message.nick, 30);
          if (!validNick(next)) return send({ type: 'error', message: 'Nick must start with a letter and stay under 30 characters.' });
          if (irc) return send({ type: 'error', message: 'Nick is already set for this connection.' });
          nick = next;
          irc = net.connect({ host: active.host, port: active.port });
          irc.setEncoding('utf8');
          irc.on('connect', () => {
            sendLine(`NICK ${nick}`);
            sendLine(`USER ${nick} 0 * :Orbit`);
          });
          irc.on('data', chunk => {
            buffer = `${buffer}${chunk}`.slice(-8192);
            const lines = buffer.split(/\r?\n/);
            buffer = lines.pop() || '';
            for (const line of lines) onLine(line);
          });
          irc.on('error', () => send({ type: 'error', message: 'The IRC server is not running.' }));
          irc.on('close', () => send({ type: 'closed' }));
          return;
        }
        if (!irc) return send({ type: 'error', message: 'Set a nick before joining.' });
        if (message.type === 'join' || message.type === 'part') {
          const channel = cleanText(message.channel, 50);
          if (!validChannel(channel)) return send({ type: 'error', message: 'Use a channel such as #orbit.' });
          sendLine(`${message.type === 'join' ? 'JOIN' : 'PART'} ${channel}`);
          return;
        }
        if (message.type === 'privmsg') {
          const target = cleanText(message.target, 50);
          const text = cleanText(message.text, 400);
          if (!validTarget(target) || !text) return send({ type: 'error', message: 'Choose a channel and write a message.' });
          sendLine(`PRIVMSG ${target} :${text}`);
          send({ type: 'message', channel: target, from: nick, text, self: true });
        }
      },
      close: closeIrc,
    };
    ws.on('close', closeIrc);
    ws.on('error', closeIrc);
    return session;
  }

  bridge.on('connection', ws => {
    sockets.add(ws);
    let authed = false;
    let session = null;
    const timer = setTimeout(() => { try { ws.close(1008, 'Authentication timeout'); } catch { /* already closed */ } }, 5000);
    timer.unref?.();
    const finish = () => {
      clearTimeout(timer);
      sockets.delete(ws);
      session?.close();
    };
    ws.on('close', finish);
    ws.on('error', finish);
    ws.on('message', raw => {
      let message;
      try { message = JSON.parse(raw.toString()); }
      catch { ws.close(1008, 'Invalid JSON'); return; }
      if (!authed) {
        if (!message || message.type !== 'auth' || !tokenMatches(message.token, token)) {
          ws.close(1008, 'Authentication rejected');
          return;
        }
        clearTimeout(timer);
        authed = true;
        session = openBridge(ws);
        if (ws.readyState === 1) ws.send(JSON.stringify({ type: 'ready', ...snapshot() }));
        return;
      }
      session?.handle(message);
    });
  });

  async function readBody(req) {
    const chunks = [];
    let bytes = 0;
    for await (const part of req) {
      bytes += part.length;
      if (bytes > 4096) throw fail('Request too large.', 413);
      chunks.push(part);
    }
    try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
    catch { throw fail('Invalid JSON.', 400); }
  }

  async function handle(req, res) {
    if (req.method !== 'POST' || !allowedRequest(req, orbitPort, devOrigins)) return reply(res, 403, { error: 'Origin rejected' });
    const auth = req.headers.authorization || '';
    if (!auth.startsWith('Bearer ') || !tokenMatches(auth.slice(7), token)) return reply(res, 401, { error: 'Use Connect host with the Orbit session token first.' });
    try {
      const body = await readBody(req);
      const action = body?.action;
      if (action === 'status') return reply(res, 200, snapshot());
      if (action === 'start') return reply(res, 200, await startProcess(body.port));
      if (action === 'stop') {
        stopProcess();
        runError = '';
        active = { ...defaults };
        return reply(res, 200, snapshot());
      }
      return reply(res, 400, { error: 'Unknown IRC action.' });
    } catch (error) {
      const status = error.status || 400;
      return reply(res, status, { error: error.message || 'IRC request failed.', ...snapshot(), status: snapshot().status });
    }
  }

  function upgrade(req, socket, head) {
    const pathOnly = String(req.url || '').split('?')[0];
    if (pathOnly !== '/api/irc' || !allowedRequest(req, orbitPort, devOrigins)) {
      socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
      return;
    }
    bridge.handleUpgrade(req, socket, head, ws => bridge.emit('connection', ws));
  }

  function close() {
    stopProcess();
    for (const ws of sockets) { try { ws.terminate(); } catch { /* already closed */ } }
    try { bridge.close(); } catch { /* already closed */ }
  }

  return { handle, upgrade, close, snapshot };
}
