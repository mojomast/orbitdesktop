#!/usr/bin/env node
// Start the Orbit IRC web app: static UI plus the websocket bridge to the ircd.
// Usage: node bin/orbit-app.js [--port 8080] [--host 127.0.0.1] [--ircd-host 127.0.0.1] [--ircd-port 6667] [--nick orbit-web] [--channel '#general']
import { createApp } from '../src/server.js';

const args = process.argv.slice(2);
const opt = (name, fallback) => {
  const index = args.indexOf(`--${name}`);
  if (index >= 0) return args[index + 1];
  return process.env[`ORBIT_APP_${name.toUpperCase().replace(/-/g, '_')}`] ?? fallback;
};

const app = createApp({
  ircd: {
    host: opt('ircd-host', '127.0.0.1'),
    port: Number(opt('ircd-port', 6667)),
    nick: opt('nick', 'orbit-web'),
  },
  nick: opt('nick', 'orbit-web'),
  channel: opt('channel', null),
});

await app.listen(Number(opt('port', 8080)), opt('host', '127.0.0.1'));
const address = app.address();
console.log(`orbit-app serving the UI on http://${address.address}:${address.port}/`);
console.log(`websocket bridge on ws://${address.address}:${address.port}/ws -> ircd ${opt('ircd-host', '127.0.0.1')}:${Number(opt('ircd-port', 6667))}`);

const stop = () => app.close().then(() => process.exit(0));
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
