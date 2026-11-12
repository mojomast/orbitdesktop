import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from '../packages/ircd/src/server.js';
import { IrcClient } from '../packages/client/src/index.js';

function once(emitter, event, pred = () => true, ms = 3000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { emitter.off(event, fn); reject(new Error('timeout waiting for ' + event)); }, ms);
    function fn(payload) { if (pred(payload)) { clearTimeout(timer); emitter.off(event, fn); resolve(payload); } }
    emitter.on(event, fn);
  });
}

test('two IrcClients talk through the real ircd: register, join, message, topic, quit', async (t) => {
  const srv = createServer({ port: 0, name: 'int.irc' });
  await srv.listen();
  const port = srv.address().port;
  const alice = new IrcClient({ host: '127.0.0.1', port, nick: 'alice', realname: 'Alice' });
  const bob = new IrcClient({ host: '127.0.0.1', port, nick: 'bob', realname: 'Bob' });
  t.after(async () => { alice.close(); bob.close(); await srv.close(); });

  const ra = once(alice, 'registered'); const rb = once(bob, 'registered');
  alice.connect(); bob.connect();
  await ra; await rb;
  assert.equal(alice.registered, true);
  assert.equal(bob.registered, true);

  const aNames = once(alice, 'names', (p) => p.channel === '#int');
  alice.join('#int');
  await aNames;
  const seenJoin = once(alice, 'join', (p) => p.nick === 'bob');
  const bNames = once(bob, 'names', (p) => p.channel === '#int');
  bob.join('#int');
  await seenJoin;
  const names = await bNames;
  const nicks = names.users.map((u) => u.nick).sort();
  assert.deepEqual(nicks, ['alice', 'bob']);
  assert.equal(names.users.find((u) => u.nick === 'alice').op, true);

  const gotMsg = once(alice, 'message', (p) => p.text === 'hi alice');
  bob.say('#int', 'hi alice');
  const msg = await gotMsg;
  assert.equal(msg.nick, 'bob');
  assert.equal(msg.target, '#int');

  const gotPriv = once(bob, 'message', (p) => p.text === 'psst');
  alice.say('bob', 'psst');
  assert.equal((await gotPriv).nick, 'alice');

  const gotTopic = once(bob, 'topic', (p) => p.text === 'integration works');
  alice.topic('#int', 'integration works');
  const topic = await gotTopic;
  assert.equal(topic.channel, '#int');

  const gotQuit = once(alice, 'quit', (p) => p.nick === 'bob');
  bob.quit('bye now');
  const q = await gotQuit;
  assert.match(q.text || '', /bye now/);
  assert.equal(alice.members('#int').map((u) => u.nick).includes('bob'), false);
});
