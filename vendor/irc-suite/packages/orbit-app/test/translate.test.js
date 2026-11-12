import { test } from 'node:test';
import assert from 'node:assert/strict';
import { translateEvent, translateCommand, applyCommand, stateSnapshot, RELAYED_EVENTS, STATE_EVENTS } from '../src/translate.js';
import { FakeClient } from './helpers.js';

test('relayed events carry a type field', () => {
  for (const event of ['registered', 'message', 'notice', 'join', 'part', 'quit', 'nick', 'topic', 'names', 'who', 'mode', 'error', 'close']) {
    const relayed = translateEvent(event, {});
    assert.equal(typeof relayed.type, 'string');
    assert.ok(relayed.type.length > 0, `${event} produced an empty type`);
  }
  assert.ok(RELAYED_EVENTS.includes('message'));
  assert.ok(STATE_EVENTS.includes('join'));
});

test('PRIVMSG and ACTION become message objects with nick, target and text', () => {
  const payload = { nick: 'alice', user: 'u', host: 'h', target: '#room', text: 'hi there', isChannel: true };
  const message = translateEvent('message', payload);
  assert.deepEqual(
    { type: message.type, nick: message.nick, target: message.target, text: message.text, channel: message.channel, action: message.action },
    { type: 'message', nick: 'alice', target: '#room', text: 'hi there', channel: '#room', action: false },
  );
  const action = translateEvent('action', { ...payload, isAction: true, text: 'waves' });
  assert.equal(action.type, 'message');
  assert.equal(action.action, true);
  assert.equal(action.text, 'waves');
});

test('join, part, quit, nick, topic, names, who, mode and error keep their fields', () => {
  assert.deepEqual(translateEvent('join', { nick: 'bob', channel: '#c', self: false }), { type: 'join', nick: 'bob', channel: '#c', self: false });
  assert.deepEqual(translateEvent('part', { nick: 'bob', channel: '#c', text: 'bye', self: false }), { type: 'part', nick: 'bob', channel: '#c', text: 'bye', self: false });
  assert.deepEqual(translateEvent('quit', { nick: 'bob', text: 'gone' }), { type: 'quit', nick: 'bob', text: 'gone' });
  assert.deepEqual(translateEvent('nick', { oldNick: 'bob', newNick: 'bobby', self: true }), { type: 'nick', oldNick: 'bob', nick: 'bobby', self: true });
  assert.deepEqual(translateEvent('topic', { channel: '#c', text: 'hello' }), { type: 'topic', channel: '#c', text: 'hello', nick: null, absent: false });
  const names = translateEvent('names', { channel: '#c', users: [{ nick: 'a', prefix: '@', op: true, voice: false }] });
  assert.deepEqual(names.users, [{ nick: 'a', prefix: '@', op: true, voice: false }]);
  const who = translateEvent('who', { mask: '#c', users: [{ nick: 'a', user: 'u', host: 'h', realname: 'A B', op: true, away: false }] });
  assert.equal(who.users[0].realname, 'A B');
  assert.deepEqual(translateEvent('mode', { target: '#c', modes: '+o', params: ['a'] }), { type: 'mode', target: '#c', modes: '+o', params: ['a'] });
  assert.equal(translateEvent('error', { code: '433', text: 'in use' }).error, 'in use');
  assert.equal(translateEvent('close', {}).type, 'close');
});

test('every relayed message is JSON serialisable', () => {
  for (const event of RELAYED_EVENTS) {
    const relayed = translateEvent(event, { nick: 'a', channel: '#c', target: '#c', text: 'x', users: [], params: [], mask: '#c' });
    assert.equal(typeof JSON.parse(JSON.stringify(relayed)), 'object');
  }
});

test('stateSnapshot reports channels, members and the current channel', () => {
  const client = new FakeClient({ nick: 'bob' });
  client.registered = true;
  client.channels.set('#room', {
    name: '#room',
    topic: 'hello',
    users: new Map([['bob', { nick: 'bob', prefix: '@', op: true, voice: false }], ['alice', { nick: 'alice', prefix: '', op: false, voice: true }]]),
  });
  const snapshot = stateSnapshot(client, '#room');
  assert.equal(snapshot.type, 'state');
  assert.equal(snapshot.nick, 'bob');
  assert.equal(snapshot.registered, true);
  assert.equal(snapshot.current, '#room');
  assert.deepEqual(snapshot.channels, [{
    name: '#room',
    topic: 'hello',
    users: [{ nick: 'bob', prefix: '@', op: true, voice: false }, { nick: 'alice', prefix: '', op: false, voice: true }],
  }]);
  assert.deepEqual(stateSnapshot({}, null).channels, []);
});

test('translateCommand validates browser JSON commands', () => {
  assert.deepEqual(translateCommand('{"cmd":"join","channel":"#room"}'), { cmd: 'join', channel: '#room', key: undefined });
  assert.deepEqual(translateCommand('{"cmd":"say","text":"hello"}'), { cmd: 'say', target: undefined, text: 'hello' });
  assert.deepEqual(translateCommand('{"cmd":"say","target":"#other","text":"hi"}'), { cmd: 'say', target: '#other', text: 'hi' });
  assert.deepEqual(translateCommand('{"cmd":"part","channel":"#room","text":"bye"}'), { cmd: 'part', channel: '#room', text: 'bye' });
  assert.deepEqual(translateCommand('{"cmd":"topic","text":"new topic"}'), { cmd: 'topic', channel: undefined, text: 'new topic' });
  assert.deepEqual(translateCommand('{"cmd":"me","text":"waves"}'), { cmd: 'me', target: undefined, text: 'waves' });
  assert.deepEqual(translateCommand('{"cmd":"names","channel":"#room"}'), { cmd: 'names', channel: '#room' });
  assert.deepEqual(translateCommand('{"cmd":"why","mask":"#room"}'), { error: 'unknown cmd: why' });
  assert.deepEqual(translateCommand('{"cmd":"who"}'), { cmd: 'who', mask: undefined });
  assert.deepEqual(translateCommand('{"cmd":"nick","nick":"bob2"}'), { cmd: 'nick', nick: 'bob2' });
  assert.deepEqual(translateCommand('{"cmd":"quit"}'), { cmd: 'quit', text: undefined });

  assert.deepEqual(translateCommand('not json'), { error: 'invalid JSON' });
  assert.deepEqual(translateCommand('[1,2]'), { error: 'expected a JSON object' });
  assert.deepEqual(translateCommand('{"cmd":"frobnicate"}'), { error: 'unknown cmd: frobnicate' });
  assert.deepEqual(translateCommand('{"cmd":"say"}'), { error: 'say needs text' });
  assert.deepEqual(translateCommand('{"cmd":"join"}'), { error: 'join needs a channel' });
  assert.deepEqual(translateCommand('{"cmd":"nick"}'), { error: 'nick needs a nick' });
  assert.deepEqual(translateCommand('{"cmd":"me"}'), { error: 'me needs text' });
  assert.deepEqual(translateCommand('{"cmd":"notice","target":"a"}'), { error: 'notice needs target and text' });
});

test('applyCommand maps commands onto client calls and remembers the channel', () => {
  const client = new FakeClient({ nick: 'bob' });
  const state = { currentChannel: null };

  assert.deepEqual(applyCommand(client, translateCommand('{"cmd":"join","channel":"#room","key":"k"}'), state), { effect: 'join', channel: '#room' });
  assert.equal(state.currentChannel, '#room');
  assert.deepEqual(client.calls.at(-1), ['join', '#room', 'k']);

  applyCommand(client, translateCommand('{"cmd":"say","text":"hello there"}'), state);
  assert.deepEqual(client.calls.at(-1), ['say', '#room', 'hello there']);

  applyCommand(client, translateCommand('{"cmd":"me","text":"waves"}'), state);
  assert.deepEqual(client.calls.at(-1), ['action', '#room', 'waves']);

  applyCommand(client, translateCommand('{"cmd":"topic","text":"new"}'), state);
  assert.deepEqual(client.calls.at(-1), ['topic', '#room', 'new']);
  applyCommand(client, translateCommand('{"cmd":"topic"}'), state);
  assert.deepEqual(client.calls.at(-1), ['topic', '#room', undefined]);

  applyCommand(client, translateCommand('{"cmd":"names"}'), state);
  assert.deepEqual(client.calls.at(-1), ['names', '#room']);
  applyCommand(client, translateCommand('{"cmd":"who","mask":"#room"}'), state);
  assert.deepEqual(client.calls.at(-1), ['who', '#room']);
  applyCommand(client, translateCommand('{"cmd":"notice","target":"alice","text":"psst"}'), state);
  assert.deepEqual(client.calls.at(-1), ['notice', 'alice', 'psst']);
  applyCommand(client, translateCommand('{"cmd":"nick","nick":"bob2"}'), state);
  assert.deepEqual(client.calls.at(-1), ['setNick', 'bob2']);

  assert.deepEqual(applyCommand(client, translateCommand('{"cmd":"part","text":"bye"}'), state), { effect: 'part', channel: '#room' });
  assert.equal(state.currentChannel, null);
  assert.deepEqual(client.calls.at(-1), ['part', '#room', 'bye']);

  applyCommand(client, translateCommand('{"cmd":"quit","text":"bye"}'), state);
  assert.deepEqual(client.calls.at(-1), ['quit', 'bye']);
});

test('say without a channel is refused instead of guessing a target', () => {
  const client = new FakeClient({ nick: 'bob' });
  assert.throws(() => applyCommand(client, translateCommand('{"cmd":"say","text":"hi"}'), { currentChannel: null }), /no channel joined yet/);
  assert.deepEqual(client.calls, []);
});
