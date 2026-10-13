import { test } from 'node:test';
import assert from 'node:assert/strict';
import { IrcClient, parseNamesToken, parseWhoRealname, DEFAULT_HOST } from '../src/index.js';
import { startFakeServer, waitFor, waitForEvent } from './helpers.js';

/** Start a fake server, connect a client, wait for the registration lines. */
async function connected(t, options = {}) {
  const server = await startFakeServer();
  const client = new IrcClient({ host: '127.0.0.1', port: server.port, nick: 'bob', ...options });
  t.after(async () => {
    client.close();
    await server.close();
  });
  client.connect();
  await waitFor(() => server.state.lines.length >= 2, { label: 'NICK and USER' });
  return { server, client };
}

test('connect sends NICK and USER and emits registered on 001', async (t) => {
  const { server, client } = await connected(t, { nick: 'bob', realname: 'Bob D' });
  assert.deepEqual(server.state.lines.slice(0, 2), ['NICK bob', 'USER bob 0 * :Bob D']);

  const registered = waitForEvent(client, 'registered');
  server.send(':srv 001 bob :Welcome to the network');
  const info = await registered;

  assert.equal(info.nick, 'bob');
  assert.equal(info.server, 'srv');
  assert.equal(client.registered, true);
  assert.equal(client.nick, 'bob');
});

test('a client can register with a PASS password and a custom user', async (t) => {
  const { server, client } = await connected(t, { nick: 'bob', user: 'bobby', realname: 'Bob D', password: 'sekret' });
  assert.deepEqual(server.state.lines.slice(0, 3), ['PASS sekret', 'NICK bob', 'USER bobby 0 * :Bob D']);
  assert.equal(client.user, 'bobby');
});

test('client auto-replies PONG to PING', async (t) => {
  const { server } = await connected(t);
  server.send('PING :ping-token');
  assert.equal(await server.waitForLine(/^PONG /), 'PONG ping-token');
});

test('autoPong can be turned off', async (t) => {
  const { server } = await connected(t, { autoPong: false });
  server.send('PING :ignored');
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.equal(server.state.lines.filter((l) => l.startsWith('PONG')).length, 0);
});

test('say() sends a correctly formatted PRIVMSG', async (t) => {
  const { server, client } = await connected(t);
  client.say('#chan', 'hello world');
  client.say('#chan', 'single');
  await server.waitForLine(/^PRIVMSG #chan :hello world$/);
  await server.waitForLine(/^PRIVMSG #chan single$/);
  assert.ok(server.state.lines.includes('PRIVMSG #chan :hello world'));
  assert.ok(server.state.lines.includes('PRIVMSG #chan single'));
});

test('incoming PRIVMSG emits message with nick, target and text', async (t) => {
  const { server, client } = await connected(t);
  const message = waitForEvent(client, 'message');
  server.send(':alice!u@h PRIVMSG #chan :hi there');

  const event = await message;
  assert.equal(event.nick, 'alice');
  assert.equal(event.user, 'u');
  assert.equal(event.host, 'h');
  assert.equal(event.target, '#chan');
  assert.equal(event.text, 'hi there');
  assert.equal(event.isChannel, true);
  assert.equal(event.isAction, false);
});

test('a CTCP ACTION emits action and message', async (t) => {
  const { server, client } = await connected(t);
  const action = waitForEvent(client, 'action');
  const message = waitForEvent(client, 'message');
  server.send(':alice!u@h PRIVMSG #chan :\u0001ACTION waves\u0001');

  const [event, msg] = await Promise.all([action, message]);
  assert.equal(event.text, 'waves');
  assert.equal(event.isAction, true);
  assert.equal(msg.text, 'waves');
});

test('NOTICE emits notice', async (t) => {
  const { server, client } = await connected(t);
  const notice = waitForEvent(client, 'notice');
  server.send(':srv NOTICE bob :server maintenance');
  const event = await notice;
  assert.equal(event.nick, 'srv');
  assert.equal(event.target, 'bob');
  assert.equal(event.text, 'server maintenance');
});

test('names event gives the parsed member list from 353/366', async (t) => {
  const { server, client } = await connected(t);
  const names = waitForEvent(client, 'names');
  server.send(':srv 353 bob = #chan :@bob +alice carol');
  server.send(':srv 366 bob #chan :End of /NAMES list.');

  const event = await names;
  assert.equal(event.channel, '#chan');
  assert.deepEqual(event.names, ['@bob', '+alice', 'carol']);
  assert.deepEqual(event.users, [
    { nick: 'bob', prefix: '@', op: true, voice: false },
    { nick: 'alice', prefix: '+', op: false, voice: true },
    { nick: 'carol', prefix: '', op: false, voice: false },
  ]);
  assert.deepEqual(client.members('#chan'), ['bob', 'alice', 'carol']);
});

test('tracked membership follows JOIN, PART, KICK, QUIT and NICK', async (t) => {
  const { server, client } = await connected(t);
  const joined = waitForEvent(client, 'join');
  server.send(':bob!u@h JOIN #chan');
  assert.equal((await joined).self, true);
  assert.deepEqual(client.channelNames(), ['#chan']);

  const other = waitForEvent(client, 'join');
  server.send(':alice!u@h JOIN #chan');
  assert.equal((await other).self, false);
  assert.deepEqual(client.members('#chan'), ['bob', 'alice']);

  const renamed = waitForEvent(client, 'nick');
  server.send(':alice!u@h NICK alice2');
  assert.equal((await renamed).newNick, 'alice2');
  assert.deepEqual(client.members('#chan'), ['bob', 'alice2']);

  const part = waitForEvent(client, 'part');
  server.send(':alice2!u@h PART #chan :bye now');
  const partEvent = await part;
  assert.equal(partEvent.text, 'bye now');
  assert.equal(partEvent.self, false);
  assert.deepEqual(client.members('#chan'), ['bob']);

  const quit = waitForEvent(client, 'quit');
  server.send(':bob!u@h QUIT :gone');
  assert.equal((await quit).text, 'gone');
  assert.deepEqual(client.members('#chan'), []);
});

test('parting a channel yourself stops tracking it', async (t) => {
  const { server, client } = await connected(t);
  const joined = waitForEvent(client, 'join');
  server.send(':bob!u@h JOIN #chan');
  await joined;
  assert.deepEqual(client.channelNames(), ['#chan']);

  const part = waitForEvent(client, 'part');
  server.send(':bob!u@h PART #chan');
  assert.equal((await part).self, true);
  assert.deepEqual(client.channelNames(), []);
  assert.equal(client.channel('#chan'), null);
});

test('topic is tracked from both the broadcast and the 332/331 replies', async (t) => {
  const { server, client } = await connected(t);
  const joined = waitForEvent(client, 'join');
  server.send(':bob!u@h JOIN #chan');
  await joined;

  const set = waitForEvent(client, 'topic');
  server.send(':alice!u@h TOPIC #chan :new topic');
  assert.equal((await set).text, 'new topic');

  const queried = waitForEvent(client, 'topic');
  server.send(':srv 332 bob #chan :new topic');
  assert.equal((await queried).text, 'new topic');
  assert.equal(client.channel('#chan').topic, 'new topic');

  const absent = waitForEvent(client, 'topic');
  server.send(':srv 331 bob #chan :No topic is set.');
  const absentEvent = await absent;
  assert.equal(absentEvent.text, null);
  assert.equal(absentEvent.absent, true);
});

test('who collects 352 rows until 315', async (t) => {
  const { server, client } = await connected(t);
  const who = waitForEvent(client, 'who');
  server.send(':srv 352 bob #chan u h srv alice H@ :0 Alice B');
  server.send(':srv 315 bob #chan :End of /WHO list.');

  const event = await who;
  assert.equal(event.mask, '#chan');
  assert.equal(event.users.length, 1);
  assert.deepEqual(event.users[0], {
    user: 'u', host: 'h', server: 'srv', nick: 'alice', flags: 'H@', op: true, away: false, realname: 'Alice B',
  });
});

test('error numerics and nick collisions are reported', async (t) => {
  const { server, client } = await connected(t);
  const collision = waitForEvent(client, 'nickinuse');
  const error = waitForEvent(client, 'error');
  server.send(':srv 433 * bob :Nickname is already in use.');

  assert.equal((await collision).nick, 'bob');
  assert.equal((await error).code, '433');

  const notFound = waitForEvent(client, 'error');
  server.send(':srv 401 bob nosuch :No such nick/channel');
  const err = await notFound;
  assert.equal(err.code, '401');
  assert.equal(err.text, 'No such nick/channel');
});

test('mode replies and broadcasts emit mode', async (t) => {
  const { server, client } = await connected(t);
  const channelMode = waitForEvent(client, 'mode');
  server.send(':srv 324 bob #chan +nt');
  assert.equal((await channelMode).modes, '+nt');

  const userMode = waitForEvent(client, 'mode');
  server.send(':srv 221 bob +i');
  assert.equal((await userMode).modes, '+i');

  const change = waitForEvent(client, 'mode');
  server.send(':alice!u@h MODE #chan +o bob');
  const event = await change;
  assert.equal(event.target, '#chan');
  assert.equal(event.nick, 'alice');
});

test('library commands produce the expected wire lines', async (t) => {
  const { server, client } = await connected(t);
  client.join('#a');
  client.part('#a', 'bye now');
  client.notice('alice', 'psst');
  client.topic('#a');
  client.topic('#a', 'new topic');
  client.names('#a');
  client.who('#a');
  client.mode('#a', '+o', 'alice');
  client.action('#a', 'waves');
  client.setNick('bob2');

  await waitFor(() => server.state.lines.length >= 12, { label: 'all command lines' });
  const sent = server.state.lines.slice(2);
  assert.deepEqual(sent, [
    'JOIN #a',
    'PART #a :bye now',
    'NOTICE alice psst',
    'TOPIC #a',
    'TOPIC #a :new topic',
    'NAMES #a',
    'WHO #a',
    'MODE #a +o alice',
    'PRIVMSG #a :\u0001ACTION waves\u0001',
    'NICK bob2',
  ]);
  assert.equal(client.nick, 'bob2');
});

test('quit sends QUIT and closes the socket', async (t) => {
  const { server, client } = await connected(t);
  const closed = waitForEvent(client, 'close');
  client.quit('bye');
  // A single param needs no trailing colon, so the wire form is 'QUIT bye'.
  assert.equal(await server.waitForLine(/^QUIT /), 'QUIT bye');
  await closed;
  assert.equal(client.registered, false);
});

test('send() refuses to write when not connected', () => {
  const client = new IrcClient({ nick: 'bob' });
  assert.throws(() => client.say('#chan', 'hi'), /not connected/);
});

test('constructor requires a nick and defaults host/port', () => {
  assert.throws(() => new IrcClient({}), /nick is required/);
  const client = new IrcClient({ nick: 'bob' });
  assert.equal(client.host, DEFAULT_HOST);
  assert.equal(client.port, 6667);
  assert.equal(client.user, 'bob');
});

test('helpers parse NAMES tokens and WHO realnames', () => {
  assert.deepEqual(parseNamesToken('@alice'), { nick: 'alice', prefix: '@', op: true, voice: false });
  assert.deepEqual(parseNamesToken('+bob'), { nick: 'bob', prefix: '+', op: false, voice: true });
  assert.deepEqual(parseNamesToken('carol'), { nick: 'carol', prefix: '', op: false, voice: false });
  assert.equal(parseWhoRealname('0 Alice B'), 'Alice B');
  assert.equal(parseWhoRealname(''), '');
});
