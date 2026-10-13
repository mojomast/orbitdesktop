import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseMessage, serializeMessage, ircLower, ircEquals, parsePrefix, splitLines, isValidNick, isChannelName, RPL, ERR } from '../src/index.js';

test('parses prefix, params, trailing', () => {
  const m = parseMessage(':nick!user@host PRIVMSG #chan :hello world :)\r\n');
  assert.deepEqual(m, { tags: {}, prefix: 'nick!user@host', command: 'PRIVMSG', params: ['#chan', 'hello world :)'] });
});

test('parses without prefix and with empty trailing', () => {
  assert.deepEqual(parseMessage('TOPIC #a :'), { tags: {}, prefix: null, command: 'TOPIC', params: ['#a', ''] });
  assert.deepEqual(parseMessage('ping srv').params, ['srv']);
  assert.equal(parseMessage('ping srv').command, 'PING');
  assert.equal(parseMessage('   '), null);
});

test('parses tags', () => {
  const m = parseMessage('@id=a\\sb;flag :s 001 me :hi');
  assert.deepEqual(m.tags, { id: 'a b', flag: true });
  assert.equal(m.command, '001');
});

test('serialize round-trips parse', () => {
  for (const line of [':nick!u@h PRIVMSG #c :hello there', 'NICK bob', ':srv 353 bob = #c :bob @alice', 'TOPIC #c :', '@k=v :p NOTICE x :y z']) {
    const m = parseMessage(line);
    assert.equal(serializeMessage(m), line + '\r\n');
    assert.deepEqual(parseMessage(serializeMessage(m)), m);
  }
});

test('serialize enforces 512 bytes and strips CRLF', () => {
  const s = serializeMessage({ command: 'PRIVMSG', params: ['#c', 'x'.repeat(1000)] });
  assert.equal(Buffer.byteLength(s), 512);
  assert.ok(s.endsWith('\r\n'));
  assert.equal(serializeMessage({ command: 'PRIVMSG', params: ['#c', 'a\r\nQUIT'] }), 'PRIVMSG #c aQUIT\r\n');
  assert.throws(() => serializeMessage({ command: 'X', params: ['a b', 'c'] }));
});

test('rfc1459 casemap', () => {
  assert.equal(ircLower('NICK[]\\~'), 'nick{}|^');
  assert.ok(ircEquals('Foo[x]', 'foo{X}'));
  assert.ok(ircEquals('a\\b~', 'A|B^'));
});

test('helpers', () => {
  assert.deepEqual(parsePrefix('n!u@h'), { nick: 'n', user: 'u', host: 'h' });
  assert.deepEqual(splitLines('a\r\nb\nc'), { lines: ['a', 'b'], rest: 'c' });
  assert.ok(isValidNick('bob_[1]'));
  assert.ok(!isValidNick('1bob'));
  assert.ok(isChannelName('#chan'));
  assert.ok(!isChannelName('chan'));
  assert.equal(RPL.WELCOME, '001');
  assert.equal(ERR.NICKNAMEINUSE, '433');
});
