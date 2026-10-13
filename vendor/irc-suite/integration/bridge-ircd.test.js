import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from '../packages/ircd/src/server.js';
import { IrcClient } from '../packages/client/src/index.js';
import { createApp } from '../packages/orbit-app/src/server.js';
import { createClient } from '../packages/orbit-app/src/ws.js';

function once(emitter, event, pred = () => true, ms = 3000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { emitter.off(event, fn); reject(new Error('timeout waiting for ' + event)); }, ms);
    function fn(payload) { if (pred(payload)) { clearTimeout(timer); emitter.off(event, fn); resolve(payload); } }
    emitter.on(event, fn);
  });
}

test('websocket bridge and a plain IrcClient exchange messages through the real ircd', async (t) => {
  const srv = createServer({ port: 0, name: 'bridge.irc' });
  await srv.listen();
  const port = srv.address().port;
  const app = createApp({ ircd: { host: '127.0.0.1', port, nick: 'webby' }, nick: 'webby' });
  await app.listen(0, '127.0.0.1');
  const carol = new IrcClient({ host: '127.0.0.1', port, nick: 'carol' });
  let ws = null;
  t.after(async () => { if (ws) ws.close(); carol.close(); await app.close(); await srv.close(); });

  const reg = once(carol, 'registered');
  carol.connect();
  await reg;
  const cNames = once(carol, 'names', (p) => p.channel === '#bridge');
  carol.join('#bridge');
  await cNames;

  ws = await createClient(app.url('/ws').replace('http', 'ws'));
  await ws.waitFor((m) => m.type === 'registered', 3000);
  const webJoined = once(carol, 'join', (p) => p.nick === 'webby');
  ws.sendJson({ cmd: 'join', channel: '#bridge' });
  await ws.waitFor((m) => m.type === 'join' && m.channel === '#bridge', 3000);
  await webJoined;

  const toIrc = once(carol, 'message', (p) => p.text === 'hello from the web');
  ws.sendJson({ cmd: 'say', text: 'hello from the web' });
  const got = await toIrc;
  assert.equal(got.nick, 'webby');
  assert.equal(got.target, '#bridge');

  carol.say('#bridge', 'hello from irc');
  const back = await ws.waitFor((m) => m.type === 'message' && m.text === 'hello from irc', 3000);
  assert.equal(back.nick, 'carol');
  assert.equal(back.channel, '#bridge');
});
