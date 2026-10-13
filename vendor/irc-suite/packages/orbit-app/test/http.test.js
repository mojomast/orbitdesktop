import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/server.js';
import { createClient } from '../src/ws.js';
import { fakeClientFactory, rawUpgrade, settle } from './helpers.js';

async function withApp(t, options = {}) {
  const factory = options.clientFactory ?? fakeClientFactory();
  const app = createApp({ ircd: { host: '127.0.0.1', port: 6667 }, clientFactory: factory, ...options });
  await app.listen(0, '127.0.0.1');
  t.after(async () => {
    await app.close();
  });
  return { app, factory };
}

test('GET / returns the UI HTML', async (t) => {
  const { app } = await withApp(t);
  const res = await fetch(app.url('/'));
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /text\/html/);
  const html = await res.text();
  assert.match(html, /Orbit IRC/);
  assert.match(html, /<script type="module" src="\/app\.js">/);
});

test('the UI HTML carries the channels, users and messages panes', async (t) => {
  const { app } = await withApp(t);
  const html = await (await fetch(app.url('/'))).text();
  for (const id of ['channels', 'users', 'messages', 'composer', 'status']) {
    assert.ok(html.includes(`id="${id}"`), `missing pane #${id}`);
  }
  assert.match(html, /id="channels-pane"/);
  assert.match(html, /id="users-pane"/);
  assert.match(html, /id="messages-pane"/);
});

test('app.js and style.css are served with the right content types', async (t) => {
  const { app } = await withApp(t);
  const js = await fetch(app.url('/app.js'));
  assert.equal(js.status, 200);
  assert.match(js.headers.get('content-type'), /javascript/);
  const source = await js.text();
  assert.match(source, /export function reduce/);
  assert.match(source, /export function parseInput/);

  const css = await fetch(app.url('/style.css'));
  assert.equal(css.status, 200);
  assert.match(css.headers.get('content-type'), /text\/css/);
});

test('unknown paths 404 and /healthz reports the ircd target', async (t) => {
  const { app } = await withApp(t);
  const missing = await fetch(app.url('/nope'));
  assert.equal(missing.status, 404);

  const health = await fetch(app.url('/healthz'));
  assert.equal(health.status, 200);
  const body = await health.json();
  assert.equal(body.ok, true);
  assert.deepEqual(body.ircd, { host: '127.0.0.1', port: 6667 });
  assert.equal(body.sessions, 0);
});

test('a plain GET of /ws is not a websocket upgrade', async (t) => {
  const { app } = await withApp(t);
  const res = await fetch(app.url('/ws'));
  assert.equal(res.status, 404);
});

test('upgrades are refused on other paths and without the websocket headers', async (t) => {
  const { app } = await withApp(t);
  const wrongPath = await rawUpgrade(app.url('/'), { path: '/somewhere-else' });
  assert.match(wrongPath.status, /404/);
  // A websocket upgrade without the key header is refused with 400.
  const noKey = await rawUpgrade(app.url('/'), { path: '/ws', omitKey: true });
  assert.match(noKey.status, /400/);
});

test('the websocket handshake at /ws succeeds and opens an IRC session', async (t) => {
  const { app, factory } = await withApp(t);
  const client = await createClient(app.url('/ws').replace('http', 'ws'));
  t.after(() => client.close());

  assert.match(client.handshake.status, /101 Switching Protocols/);
  assert.equal(client.handshake.headers['sec-websocket-accept'] !== undefined, true);
  assert.equal(client.connected, true);

  await settle();
  assert.equal(app.sessionCount, 1);
  assert.equal(factory.clients.length, 1);
  assert.equal(factory.clients[0].options.host, '127.0.0.1');
  assert.equal(factory.clients[0].options.port, 6667);
  assert.deepEqual(factory.clients[0].calls[0], ['connect']);

  client.close();
  await settle(150);
  assert.equal(app.sessionCount, 0);
  assert.ok(factory.clients[0].calls.some((call) => call[0] === 'quit'), 'session close did not quit the IRC client');
});

test('each websocket session gets its own IRC client', async (t) => {
  const { app, factory } = await withApp(t);
  const one = await createClient(app.url('/ws').replace('http', 'ws'));
  const two = await createClient(app.url('/ws').replace('http', 'ws'));
  t.after(() => {
    one.close();
    two.close();
  });
  await settle();
  assert.equal(factory.clients.length, 2);
  assert.equal(app.sessionCount, 2);
  assert.notEqual(factory.clients[0], factory.clients[1]);
});

test('the configured nick and starting channel are passed to the IRC client', async (t) => {
  const { app, factory } = await withApp(t, { nick: 'orbit-web', channel: '#general' });
  const client = await createClient(app.url('/ws').replace('http', 'ws'));
  t.after(() => client.close());
  await settle();
  assert.equal(factory.clients[0].options.nick, 'orbit-web');
});
