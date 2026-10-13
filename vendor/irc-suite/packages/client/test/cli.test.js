import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseCommandLine, dispatch, parseArgs, HELP } from '../src/cli.js';
import { IrcClient } from '../src/index.js';
import { startFakeServer, waitFor } from './helpers.js';

/** Client-shaped recorder: every method pushes its arguments. */
function fakeClient() {
  const calls = [];
  const record = (name) => (...args) => calls.push([name, ...args]);
  return {
    calls,
    join: record('join'),
    part: record('part'),
    say: record('say'),
    notice: record('notice'),
    action: record('action'),
    topic: record('topic'),
    names: record('names'),
    who: record('who'),
    mode: record('mode'),
    setNick: record('setNick'),
    quit: record('quit'),
  };
}

test('parseCommandLine splits commands, arguments and plain text', () => {
  assert.deepEqual(parseCommandLine('/join #chan key'), { type: 'command', command: 'JOIN', args: ['#chan', 'key'], text: '#chan key' });
  assert.deepEqual(parseCommandLine('/msg alice hi there'), { type: 'command', command: 'MSG', args: ['alice', 'hi', 'there'], text: 'alice hi there' });
  assert.deepEqual(parseCommandLine('  /JOIN   #chan  '), { type: 'command', command: 'JOIN', args: ['#chan'], text: '#chan' });
  assert.deepEqual(parseCommandLine('/join'), { type: 'command', command: 'JOIN', args: [], text: '' });
  assert.deepEqual(parseCommandLine('hello there'), { type: 'text', text: 'hello there' });
  assert.deepEqual(parseCommandLine('   '), { type: 'empty' });
  assert.deepEqual(parseCommandLine(''), { type: 'empty' });
});

test('/join sets the current channel and plain text goes there', () => {
  const client = fakeClient();
  const state = { currentChannel: null };

  assert.deepEqual(dispatch(client, state, '/join #room'), { action: 'join', channel: '#room' });
  assert.equal(state.currentChannel, '#room');
  assert.deepEqual(dispatch(client, state, 'hello there'), { action: 'say', target: '#room', text: 'hello there' });
  assert.deepEqual(client.calls, [['join', '#room', undefined], ['say', '#room', 'hello there']]);
});

test('/msg sends a private message without changing the channel', () => {
  const client = fakeClient();
  const state = { currentChannel: '#room' };
  assert.deepEqual(dispatch(client, state, '/msg alice hi there'), { action: 'say', target: 'alice', text: 'hi there' });
  assert.equal(state.currentChannel, '#room');
  assert.deepEqual(client.calls, [['say', 'alice', 'hi there']]);
});

test('/me, /notice and /topic map onto library calls', () => {
  const client = fakeClient();
  const state = { currentChannel: '#room' };

  assert.deepEqual(dispatch(client, state, '/me waves at everyone'), { action: 'action', target: '#room', text: 'waves at everyone' });
  assert.deepEqual(dispatch(client, state, '/notice alice psst'), { action: 'notice', target: 'alice', text: 'psst' });
  assert.deepEqual(dispatch(client, state, '/topic'), { action: 'topic', channel: '#room', text: undefined });
  assert.deepEqual(dispatch(client, state, '/topic fresh topic'), { action: 'topic', channel: '#room', text: 'fresh topic' });
  assert.deepEqual(dispatch(client, state, '/topic #other elsewhere'), { action: 'topic', channel: '#other', text: 'elsewhere' });

  assert.deepEqual(client.calls, [
    ['action', '#room', 'waves at everyone'],
    ['notice', 'alice', 'psst'],
    ['topic', '#room', undefined],
    ['topic', '#room', 'fresh topic'],
    ['topic', '#other', 'elsewhere'],
  ]);
});

test('/names, /who, /mode, /nick, /part and /quit map onto library calls', () => {
  const client = fakeClient();
  const state = { currentChannel: '#room' };

  assert.deepEqual(dispatch(client, state, '/names'), { action: 'names', channel: '#room' });
  assert.deepEqual(dispatch(client, state, '/names #other'), { action: 'names', channel: '#other' });
  assert.deepEqual(dispatch(client, state, '/who'), { action: 'who', mask: '#room' });
  assert.deepEqual(dispatch(client, state, '/mode #room +o alice'), { action: 'mode', target: '#room', modes: '+o alice' });
  assert.deepEqual(dispatch(client, state, '/nick bob2'), { action: 'nick', nick: 'bob2' });
  assert.deepEqual(dispatch(client, state, '/part bye'), { action: 'part', channel: '#room', text: 'bye' });
  assert.equal(state.currentChannel, null);
  assert.deepEqual(dispatch(client, state, '/quit later'), { action: 'quit', text: 'later' });

  assert.deepEqual(client.calls, [
    ['names', '#room'],
    ['names', '#other'],
    ['who', '#room'],
    ['mode', '#room', '+o alice'],
    ['setNick', 'bob2'],
    ['part', '#room', 'bye'],
    ['quit', 'later'],
  ]);
});

test('unknown commands, usage errors and missing channels are reported', () => {
  const client = fakeClient();
  const state = { currentChannel: null };

  assert.deepEqual(dispatch(client, state, '/frobnicate'), { action: 'unknown', command: 'FROBNICATE' });
  assert.deepEqual(dispatch(client, state, '/join'), { action: 'usage', command: 'JOIN' });
  assert.deepEqual(dispatch(client, state, '/msg alice'), { action: 'usage', command: 'MSG' });
  assert.deepEqual(dispatch(client, state, '/me waves'), { action: 'no-channel' });
  assert.deepEqual(dispatch(client, state, 'hello'), { action: 'no-channel', text: 'hello' });
  assert.deepEqual(dispatch(client, state, '   '), { action: 'none' });
  assert.equal(dispatch(client, state, '/help').action, 'help');
  assert.deepEqual(client.calls, []);
  assert.match(HELP, /\/join/);
  assert.match(HELP, /\/quit/);
});

test('parseArgs reads the flags the CLI documents', () => {
  const opts = parseArgs(['--nick', 'bob', '--port', '7777', '--channel', '#room', '--realname', 'Bob']);
  assert.equal(opts.nick, 'bob');
  assert.equal(opts.port, 7777);
  assert.equal(opts.channel, '#room');
  assert.equal(opts.realname, 'Bob');
  assert.equal(opts.host, '127.0.0.1');
  assert.equal(parseArgs(['--help']).help, true);
});

test('CLI input reaches the wire through the library', async (t) => {
  const server = await startFakeServer();
  const client = new IrcClient({ host: '127.0.0.1', port: server.port, nick: 'bob' });
  t.after(async () => {
    client.close();
    await server.close();
  });
  client.connect();
  await waitFor(() => server.state.lines.length >= 2, { label: 'registration' });

  const state = { currentChannel: null };
  dispatch(client, state, '/join #room');
  await server.waitForLine(/^JOIN #room$/);
  dispatch(client, state, 'hello world');
  await server.waitForLine(/^PRIVMSG #room :hello world$/);
  dispatch(client, state, '/msg alice direct');
  await server.waitForLine(/^PRIVMSG alice direct$/);
  dispatch(client, state, '/quit bye');
  await server.waitForLine(/^QUIT bye$/);
});
