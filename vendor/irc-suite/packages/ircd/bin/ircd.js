#!/usr/bin/env node
// Usage: node bin/ircd.js [--port 6667] [--host 127.0.0.1] [--name orbit.irc]
import { createServer } from '../src/server.js';

const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf('--' + k); return i >= 0 ? args[i + 1] : (process.env['IRCD_' + k.toUpperCase()] || d); };
const srv = createServer({ port: Number(opt('port', 6667)), host: opt('host', '127.0.0.1'), name: opt('name', 'orbit.irc') });
await srv.listen();
const a = srv.address();
console.log('ircd listening on ' + a.address + ':' + a.port);
const stop = () => srv.close().then(() => process.exit(0));
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
