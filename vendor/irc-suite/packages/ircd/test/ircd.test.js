import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { createServer } from '../src/server.js';
import { parseMessage } from '../../protocol/src/index.js';

let srv; let port;
const open = [];
before(async () => { srv = createServer({ port: 0, name: 'test.irc' }); await srv.listen(); port = srv.address().port; });
after(async () => { for (const s of open) s.destroy(); await srv.close(); });

function connect() {
  return new Promise((resolve, reject) => {
    const sock = net.connect(port, '127.0.0.1');
    open.push(sock);
    const t = { sock, msgs: [], waiters: [], buf: '' };
    sock.setEncoding('utf8');
    sock.on('data', (d) => {
      t.buf += d;
      const parts = t.buf.split('\r\n'); t.buf = parts.pop();
      for (const l of parts) {
        const m = parseMessage(l);
        if (!m) continue;
        const w = t.waiters.find((x) => x.pred(m));
        if (w) { t.waiters.splice(t.waiters.indexOf(w), 1); w.done(m); } else t.msgs.push(m);
      }
    });
    t.send = (line) => sock.write(line + '\r\n');
    t.waitFor = (pred, ms = 2000) => new Promise((res, rej) => {
      const idx = t.msgs.findIndex(pred);
      if (idx >= 0) return res(t.msgs.splice(idx, 1)[0]);
      const timer = setTimeout(() => rej(new Error('timeout waiting for message')), ms);
      t.waiters.push({ pred, done: (m) => { clearTimeout(timer); res(m); } });
    });
    t.clear = () => { t.msgs.length = 0; };
    sock.on('connect', () => resolve(t));
    sock.on('error', reject);
  });
}
const cmd = (c) => (m) => m.command === c;
async function register(nick) {
  const t = await connect();
  t.send('NICK ' + nick); t.send('USER ' + nick + ' 0 * :' + nick + ' Real');
  await t.waitFor(cmd('001'));
  await t.waitFor(cmd('422'));
  t.clear();
  return t;
}
const settle = (ms = 150) => new Promise((r) => setTimeout(r, ms));

test('two clients register and receive 001', async () => {
  const a = await connect(); const b = await connect();
  a.send('NICK alice'); a.send('USER alice 0 * :Alice A');
  b.send('NICK bob'); b.send('USER bob 0 * :Bob B');
  const wa = await a.waitFor(cmd('001')); const wb = await b.waitFor(cmd('001'));
  assert.equal(wa.params[0], 'alice'); assert.equal(wb.params[0], 'bob');
  for (const code of ['002', '003', '004']) await a.waitFor(cmd(code));
  a.send('QUIT'); b.send('QUIT');
});

test('commands before registration return 451', async () => {
  const t = await connect();
  t.send('JOIN #x');
  await t.waitFor(cmd('451'));
  t.send('QUIT');
});

test('nick collision returns 433, casemap-aware', async () => {
  const a = await register('dupe[1]');
  const b = await connect();
  b.send('NICK DUPE{1}');
  const e = await b.waitFor(cmd('433'));
  assert.equal(e.params[1], 'DUPE{1}');
  b.send('NICK 9bad'); await b.waitFor(cmd('432'));
  b.send('NICK'); await b.waitFor(cmd('431'));
  a.send('QUIT'); b.send('QUIT');
});

test('JOIN broadcasts and returns NAMES; PRIVMSG reaches others not sender', async () => {
  const a = await register('j_a'); const b = await register('j_b');
  a.send('JOIN #room,#other');
  await a.waitFor((m) => m.command === 'JOIN' && m.params[0] === '#room');
  const names = await a.waitFor((m) => m.command === '353' && m.params[2] === '#room');
  assert.equal(names.params[3], '@j_a');
  await a.waitFor((m) => m.command === '366' && m.params[1] === '#other');
  b.send('JOIN #ROOM');
  const seen = await a.waitFor((m) => m.command === 'JOIN' && m.prefix.startsWith('j_b!'));
  assert.equal(seen.params[0], '#room');
  const bn = await b.waitFor(cmd('353'));
  assert.deepEqual(bn.params[3].split(' ').sort(), ['@j_a', 'j_b']);
  await b.waitFor(cmd('366'));
  await settle(); a.clear(); b.clear();
  b.send('PRIVMSG #room :hello room');
  const got = await a.waitFor(cmd('PRIVMSG'));
  assert.equal(got.prefix.split('!')[0], 'j_b');
  assert.deepEqual(got.params, ['#room', 'hello room']);
  await settle();
  assert.equal(b.msgs.filter(cmd('PRIVMSG')).length, 0);
  b.send('NOTICE j_a :psst');
  const n = await a.waitFor(cmd('NOTICE'));
  assert.deepEqual(n.params, ['j_a', 'psst']);
  b.send('PRIVMSG nobody :x'); await b.waitFor(cmd('401'));
  b.send('PART #other'); await b.waitFor(cmd('442'));
  b.send('PART #nope'); await b.waitFor(cmd('403'));
  b.send('PART #room :bye');
  const p = await a.waitFor(cmd('PART'));
  assert.deepEqual(p.params, ['#room', 'bye']);
  a.send('QUIT'); b.send('QUIT');
});

test('PING returns PONG', async () => {
  const a = await register('pinger');
  a.send('PING :tok123');
  const p = await a.waitFor(cmd('PONG'));
  assert.equal(p.params[1], 'tok123');
  a.send('PING'); await a.waitFor(cmd('461'));
  a.send('QUIT');
});

test('TOPIC and MODE: op topic broadcast, +t blocks non-ops with 482, +o grants op', async () => {
  const op = await register('t_op'); const u = await register('t_user');
  op.send('JOIN #topic'); await op.waitFor(cmd('366'));
  u.send('JOIN #topic'); await u.waitFor(cmd('366'));
  await settle(); op.clear(); u.clear();
  op.send('TOPIC #topic :Welcome all');
  const bt = await u.waitFor(cmd('TOPIC'));
  assert.deepEqual(bt.params, ['#topic', 'Welcome all']);
  await op.waitFor(cmd('TOPIC'));
  u.send('TOPIC #topic');
  const q = await u.waitFor(cmd('332'));
  assert.equal(q.params[2], 'Welcome all');
  u.send('TOPIC #topic :hijack');
  const e = await u.waitFor(cmd('482'));
  assert.equal(e.params[1], '#topic');
  u.send('MODE #topic +o t_user'); await u.waitFor(cmd('482'));
  op.send('MODE #topic');
  const modes = await op.waitFor(cmd('324'));
  assert.equal(modes.params[2], '+nt');
  op.send('MODE #topic +o t_user');
  const m = await u.waitFor(cmd('MODE'));
  assert.deepEqual(m.params, ['#topic', '+o', 't_user']);
  u.send('TOPIC #topic :now allowed');
  await op.waitFor((x) => x.command === 'TOPIC' && x.params[1] === 'now allowed');
  u.send('NAMES #topic');
  const nm = await u.waitFor(cmd('353'));
  assert.deepEqual(nm.params[3].split(' ').sort(), ['@t_op', '@t_user']);
  op.send('MODE t_op'); const um = await op.waitFor(cmd('221')); assert.equal(um.params[1], '+');
  op.send('MODE t_user +i'); await op.waitFor(cmd('502'));
  op.send('QUIT'); u.send('QUIT');
});

test('WHO lists channel members', async () => {
  const a = await register('w_a'); const b = await register('w_b');
  a.send('JOIN #who'); await a.waitFor(cmd('366'));
  b.send('JOIN #who'); await b.waitFor(cmd('366'));
  await settle(); b.clear();
  b.send('WHO #who');
  const end = await b.waitFor(cmd('315'));
  assert.equal(end.params[1], '#who');
  const rows = b.msgs.filter(cmd('352'));
  assert.deepEqual(rows.map((r) => r.params[5]).sort(), ['w_a', 'w_b']);
  assert.equal(rows.find((r) => r.params[5] === 'w_a').params[6], 'H@');
  a.send('QUIT'); b.send('QUIT');
});

test('QUIT is broadcast to shared channels and frees the nick', async () => {
  const a = await register('q_a'); const b = await register('q_b');
  a.send('JOIN #q'); await a.waitFor(cmd('366'));
  b.send('JOIN #q'); await b.waitFor(cmd('366'));
  b.send('QUIT :gone fishing');
  const q = await a.waitFor(cmd('QUIT'));
  assert.equal(q.prefix.split('!')[0], 'q_b');
  assert.match(q.params[0], /gone fishing/);
  const c = await register('q_b');
  assert.ok(c);
  a.send('NAMES #q');
  const n = await a.waitFor(cmd('353'));
  assert.equal(n.params[3], '@q_a');
  a.send('QUIT'); c.send('QUIT');
});

test('many clients and channels', async () => {
  const users = await Promise.all(Array.from({ length: 10 }, (_, i) => register('many' + i)));
  users.forEach((u, i) => u.send('JOIN #m' + (i % 3) + ',#all'));
  await Promise.all(users.map((u) => u.waitFor((m) => m.command === '366' && m.params[1] === '#all')));
  await settle(200);
  users.forEach((u) => u.clear());
  users[0].send('PRIVMSG #all :broadcast');
  await Promise.all(users.slice(1).map((u) => u.waitFor((m) => m.command === 'PRIVMSG' && m.params[1] === 'broadcast')));
  users.forEach((u) => u.send('QUIT'));
});
