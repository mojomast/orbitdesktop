// HTTP server for the Orbit app: serves the static UI and upgrades /ws to the
// websocket bridge. No dependencies beyond node:http + the packages in this repo.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { acceptValue, createServerConnection } from './ws.js';
import { createSession, defaultClientFactory } from './bridge.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_PUBLIC_DIR = path.join(here, '..', 'public');

const ROUTES = {
  '/': 'index.html',
  '/index.html': 'index.html',
  '/app.js': 'app.js',
  '/style.css': 'style.css',
};

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
};

export function createApp({
  ircd = {},
  publicDir = DEFAULT_PUBLIC_DIR,
  clientFactory = defaultClientFactory,
  nick = 'orbit-web',
  channel = null,
  log = () => {},
} = {}) {
  const sessions = new Set();
  const openSockets = new Set();
  const ircdTarget = { host: ircd.host ?? '127.0.0.1', port: ircd.port ?? 6667, nick: ircd.nick ?? nick, user: ircd.user, realname: ircd.realname };

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');

    if (url.pathname === '/healthz') {
      const body = JSON.stringify({ ok: true, sessions: sessions.size, ircd: { host: ircdTarget.host, port: ircdTarget.port } });
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(body) });
      res.end(body);
      return;
    }

    const file = ROUTES[url.pathname];
    if (!file) {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('not found');
      return;
    }

    fs.readFile(path.join(publicDir, file), (err, data) => {
      if (err) {
        log('static read failed', file, err.message);
        res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
        res.end('static file unavailable');
        return;
      }
      res.writeHead(200, {
        'content-type': MIME[path.extname(file)] ?? 'application/octet-stream',
        'content-length': data.length,
        'cache-control': 'no-store',
      });
      res.end(data);
    });
  });

  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url, 'http://localhost');
    const key = req.headers['sec-websocket-key'];
    const upgrade = String(req.headers.upgrade ?? '').toLowerCase();

    if (url.pathname !== '/ws') {
      socket.write('HTTP/1.1 404 Not Found\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
      socket.destroy();
      return;
    }
    if (upgrade !== 'websocket' || !key) {
      socket.write('HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
      socket.destroy();
      return;
    }

    socket.write([
      'HTTP/1.1 101 Switching Protocols',
      'Upgrade: websocket',
      'Connection: Upgrade',
      `Sec-WebSocket-Accept: ${acceptValue(key)}`,
      '',
      '',
    ].join('\r\n'));

    openSockets.add(socket);
    socket.on('close', () => openSockets.delete(socket));
    socket.on('error', () => openSockets.delete(socket));

    let session = null;
    const conn = createServerConnection(socket, {
      head,
      onError: (err) => log('ws error', err.message),
      onClose: () => {
        if (session) sessions.delete(session);
        session?.close();
      },
    });

    session = createSession({
      conn,
      ircd: ircdTarget,
      nick,
      channel,
      clientFactory,
      log,
    });
    sessions.add(session);
  });

  return {
    server,
    get sessionCount() {
      return sessions.size;
    },
    listen(port = 0, host = '127.0.0.1') {
      return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, host, () => {
          server.off('error', reject);
          resolve(this);
        });
      });
    },
    address() {
      return server.address();
    },
    url(pathname = '/') {
      const address = server.address();
      if (!address) throw new Error('server is not listening');
      const host = address.address === '::' || address.address === '0.0.0.0' ? '127.0.0.1' : address.address;
      return `http://${host}:${address.port}${pathname}`;
    },
    close() {
      for (const session of sessions) session.close();
      sessions.clear();
      for (const socket of openSockets) socket.destroy();
      openSockets.clear();
      return new Promise((resolve) => server.close(() => resolve()));
    },
  };
}
