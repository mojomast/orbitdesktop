import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer as createIrcd } from '../../ircd/src/server.js';
import { IrcClient } from '../../client/src/index.js';
import { createApp } from '../src/server.js';
import { createClient } from '../src/ws.js';
import { fakeClientFactory, waitForEvent, settle } from './helpers.js';
import { reduce, initialState, parseInput } from '../public/app.js';

async function withBridge(t, options = {}) {
  const factory = options.clientFactory ?? fakeClientFactory();
  const app = createApp({ ircd: { host: '127.0.0.1', port: 6667 }, clientFactory: factory, ...options });
  await app.listen(0, '127.0.0.1');
  t.after(async () => {
    await app.close();
  });
  const client = await createClient(app.url('/ws').replace('http', 'ws'));
  t.after(() => client.close());
  return { app, factory, client };
}

test('a JSON say command becomes an IRC PRIVMSG through the bridge', async (t) => {
  const { client, factory } = await withBridge(t);
  await settle();
  const fake = factory.clients[0];

  client.sendJson({ cmd: 'join', channel: '#room' });
  await client.waitFor((m) => m.type === 'ack' && m.effect === 'join');
  assert.deepEqual(fake.calls.at(-1), ['join', '#room', undefined]);

  client.sendJson({ cmd: 'say', text: 'hello from the browser' });
  await client.waitFor((m) => m.type === 'ack' && m.effect === 'say');
  assert.deepEqual(fake.calls.at(-1), ['say', '#room', 'hello from the browser']);

  client.sendJson({ cmd: 'say', target: '#other', text: 'elsewhere' });
  await client.waitFor((m) => m.type === 'ack' && m.target === '#other');
  assert.deepEqual(fake.calls.at(-1), ['say', '#other', 'elsewhere']);

  client.sendJson({ cmd: 'topic', text: 'new topic' });
  await client.waitFor((m) => m.type === 'ack' && m.effect === 'topic');
  assert.deepEqual(fake.calls.at(-1), ['topic', '#room', 'new topic']);

  client.sendJson({ cmd: 'part', channel: '#room', text: 'bye' });
  await client.waitFor((m) => m.type === 'ack' && m.effect === 'part');
  assert.deepEqual(fake.calls.at(-1), ['part', '#room', 'bye']);

  // With no channel joined, say is refused rather than guessed.
  client.sendJson({ cmd: 'say', text: 'into the void' });
  assert.match((await client.waitFor((m) => m.type === 'error' && /no channel/.test(m.error))).error, /no channel/);
});

test('IRC events are relayed to the browser as JSON with a type field', async (t) => {
  const { client, factory } = await withBridge(t);
  await settle();
  const fake = factory.clients[0];

  fake.emit('registered', { nick: 'orbit-web', server: 'orbit.irc' });
  const registered = await client.waitFor((m) => m.type === 'registered');
  assert.equal(registered.nick, 'orbit-web');

  fake.emit('message', { nick: 'alice', user: 'u', host: 'h', target: '#room', text: 'hi there', isChannel: true });
  const message = await client.waitFor((m) => m.type === 'message');
  assert.deepEqual({ nick: message.nick, target: message.target, text: message.text }, { nick: 'alice', target: '#room', text: 'hi there' });

  fake.emit('action', { nick: 'alice', target: '#room', text: 'waves', isAction: true });
  const action = await client.waitFor((m) => m.type === 'message' && m.action === true);
  assert.equal(action.text, 'waves');

  fake.emit('notice', { nick: 'srv', target: 'orbit-web', text: 'maintenance' });
  assert.equal((await client.waitFor((m) => m.type === 'notice')).text, 'maintenance');

  fake.emit('names', { channel: '#room', users: [{ nick: 'bob', prefix: '@', op: true, voice: false }] });
  const names = await client.waitFor((m) => m.type === 'names');
  assert.deepEqual(names.users, [{ nick: 'bob', prefix: '@', op: true, voice: false }]);

  fake.emit('topic', { channel: '#room', text: 'the topic', nick: 'alice' });
  assert.equal((await client.waitFor((m) => m.type === 'topic')).text, 'the topic');

  fake.emit('quit', { nick: 'bob', text: 'gone' });
  assert.equal((await client.waitFor((m) => m.type === 'quit')).text, 'gone');

  fake.emit('error', { code: '401', text: 'No such nick/channel' });
  assert.equal((await client.waitFor((m) => m.type === 'error')).code, '401');
});

test('joining relays a state snapshot with channels and members', async (t) => {
  const { client, factory } = await withBridge(t);
  await settle();
  const fake = factory.clients[0];

  client.sendJson({ cmd: 'join', channel: '#room' });
  const snapshot = await client.waitFor((m) => m.type === 'state' && m.channels.length > 0);
  assert.equal(snapshot.current, '#room');
  assert.equal(snapshot.channels[0].name, '#room');
  assert.deepEqual(snapshot.channels[0].users.map((u) => u.nick), ['orbit-web']);
  assert.equal(snapshot.channels[0].users[0].op, true);
});

test('bad commands come back as an error message and change nothing', async (t) => {
  const { client, factory } = await withBridge(t);
  await settle();
  const fake = factory.clients[0];
  const before = fake.calls.length;

  client.sendText('not json at all');
  assert.match((await client.waitFor((m) => m.type === 'error')).error, /invalid JSON/);

  client.sendJson({ cmd: 'frobnicate' });
  assert.match((await client.waitFor((m) => m.type === 'error' && /unknown cmd/.test(m.error))).error, /frobnicate/);

  client.sendJson({ cmd: 'say' });
  assert.match((await client.waitFor((m) => m.type === 'error' && /say needs text/.test(m.error))).error, /say needs text/);

  assert.equal(fake.calls.length, before, 'a rejected command still reached the client');
});

test('bridge <-> real ircd: browser say arrives as a PRIVMSG and replies come back', async (t) => {
  const ircd = createIrcd({ port: 0, name: 'bridge.test' });
  await ircd.listen();
  const ircdPort = ircd.address().port;

  const peer = new IrcClient({ host: '127.0.0.1', port: ircdPort, nick: 'peer' });
  peer.connect();
  await waitForEvent(peer, 'registered');
  const peerJoined = waitForEvent(peer, 'join');
  peer.join('#room');
  await peerJoined;

  const app = createApp({ ircd: { host: '127.0.0.1', port: ircdPort }, nick: 'orbit-web' });
  await app.listen(0, '127.0.0.1');
  t.after(async () => {
    peer.quit('bye');
    await app.close();
    await ircd.close();
  });

  const browser = await createClient(app.url('/ws').replace('http', 'ws'));
  t.after(() => browser.close());

  await browser.waitFor((m) => m.type === 'registered');
  browser.sendJson({ cmd: 'join', channel: '#room' });
  const joined = await browser.waitFor((m) => m.type === 'state' && m.channels.some((c) => c.name === '#room'));
  assert.equal(joined.current, '#room');
  assert.ok(joined.channels.find((c) => c.name === '#room').users.some((u) => u.nick === 'orbit-web'));

  const peerSawJoin = waitForEvent(peer, 'join');
  const joinEvent = await peerSawJoin;
  assert.equal(joinEvent.nick, 'orbit-web');

  const peerMessage = waitForEvent(peer, 'message');
  browser.sendJson({ cmd: 'say', text: 'hello from the browser' });
  const received = await peerMessage;
  assert.deepEqual([received.nick, received.target, received.text], ['orbit-web', '#room', 'hello from the browser']);

  const relayed = browser.waitFor((m) => m.type === 'message' && m.nick === 'peer');
  peer.say('#room', 'hello back');
  assert.equal((await relayed).text, 'hello back');

  // The channel defaults to +t, so the peer (the op) hands op to the bridge
  // client before the browser sets the topic.
  const bridgeGotOp = browser.waitFor((m) => m.type === 'mode' && m.modes === '+o' && m.params.includes('orbit-web'));
  peer.mode('#room', '+o', 'orbit-web');
  await bridgeGotOp;

  const topicRelay = browser.waitFor((m) => m.type === 'topic' && m.text === 'bridge topic');
  browser.sendJson({ cmd: 'topic', text: 'bridge topic' });
  assert.equal((await topicRelay).text, 'bridge topic');
  const peerTopic = waitForEvent(peer, 'topic');
  peer.topic('#room');
  assert.equal((await peerTopic).text, 'bridge topic');

  const partRelay = browser.waitFor((m) => m.type === 'part');
  peer.part('#room', 'leaving');
  assert.equal((await partRelay).nick, 'peer');

  const namesRelay = browser.waitFor((m) => m.type === 'names' && m.channel === '#room' && m.users.length === 1 && m.users[0].nick === 'orbit-web');
  browser.sendJson({ cmd: 'names', channel: '#room' });
  assert.equal((await namesRelay).users[0].nick, 'orbit-web');
});

test('the UI state reducer renders what the bridge sends', () => {
  let state = initialState();
  assert.equal(state.channels.length, 0);

  state = reduce(state, { type: 'registered', nick: 'orbit-web' });
  assert.equal(state.status, 'connected');
  assert.equal(state.registered, true);

  state = reduce(state, { type: 'state', nick: 'orbit-web', registered: true, current: '#room', channels: [{ name: '#room', topic: 'hi', users: [{ nick: 'bob', op: true, voice: false, prefix: '@' }] }] });
  assert.deepEqual(state.channels.map((c) => c.name), ['#room']);
  assert.deepEqual(state.users.map((u) => u.nick), ['bob']);
  assert.equal(state.current, '#room');

  state = reduce(state, { type: 'message', nick: 'alice', target: '#room', text: 'hello', action: false });
  assert.deepEqual(state.messages.at(-1), { kind: 'message', nick: 'alice', target: '#room', text: 'hello' });
  state = reduce(state, { type: 'message', nick: 'alice', target: '#room', text: 'waves', action: true });
  assert.equal(state.messages.at(-1).kind, 'action');
  state = reduce(state, { type: 'notice', nick: 'srv', text: 'hi' });
  assert.equal(state.messages.at(-1).kind, 'notice');
  state = reduce(state, { type: 'error', error: 'boom' });
  assert.equal(state.messages.at(-1).kind, 'error');
  state = reduce(state, { type: 'close' });
  assert.equal(state.status, 'disconnected');
  assert.equal(state.registered, false);
});

test('the UI input parser turns typing into bridge commands', () => {
  assert.deepEqual(parseInput('hello there'), { cmd: 'say', text: 'hello there' });
  assert.deepEqual(parseInput('/join #room'), { cmd: 'join', channel: '#room', key: undefined });
  assert.deepEqual(parseInput('/msg alice hi there'), { cmd: 'say', target: 'alice', text: 'hi there' });
  assert.deepEqual(parseInput('/me waves'), { cmd: 'me', text: 'waves' });
  assert.deepEqual(parseInput('/topic new topic'), { cmd: 'topic', channel: undefined, text: 'new topic' });
  assert.deepEqual(parseInput('/names'), { cmd: 'names', channel: undefined });
  assert.deepEqual(parseInput('/quit bye'), { cmd: 'quit', text: 'bye' });
  assert.equal(parseInput('   '), null);
  assert.deepEqual(parseInput('/derp'), { cmd: 'error', error: 'unknown command: /derp' });
  assert.deepEqual(parseInput('/join'), { cmd: 'error', error: 'usage: /join #channel' });
});
