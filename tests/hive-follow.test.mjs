import test from 'node:test';
import assert from 'node:assert/strict';
import {HiveFollow} from '../src/hive-follow.ts';

// Same canonical encoding as contrib/rails_server/stream.py. These positions
// are ledger-wide, not a count of selected events.
const ledger='cd7286e5-2586-46e3-8480-ac73d0afd496';
const scope='b'.repeat(64);
const cursor=(seq,id=ledger,digest=scope)=>Buffer.from(JSON.stringify([id,digest,seq])).toString('base64url');
const frame=(event,id)=>`id: ${id}\nevent: ${event}\ndata: {}`;

test('only an exact snapshot/ready handoff observes; a position jump can cover unrelated arrivals',t=>{
  t.mock.timers.enable({apis:['setTimeout']});
  const seen=[],f=new HiveFollow(s=>seen.push(s));
  assert.equal(f.begin('not-a-cursor'),false);
  assert.equal(f.begin(cursor(30)),true);
  assert.equal(f.frame(frame('invalidate',cursor(31))),'gap');
  assert.deepEqual(seen,[]);
  f.begin(cursor(42));f.frame(frame('ready',cursor(42)));
  assert.deepEqual(seen,['following']);
  for(const id of [cursor(15),cursor(42),cursor(101,ledger,'a'.repeat(64))])
    assert.equal(f.frame(frame('invalidate',id)),'skip');
  assert.equal(f.frame(': heartbeat'),'skip');
  assert.equal(f.frame(frame('invalidate',cursor(900))),'invalidate');
  f.changed();assert.equal(f.covered(cursor(902)),true);
  assert.equal(f.frame(frame('invalidate',cursor(901))),'skip');
  for(let pos=903;pos<1000;pos++){assert.equal(f.frame(frame('invalidate',cursor(pos))),'invalidate');f.changed();}
  assert.deepEqual(seen,['following']);t.mock.timers.tick(1000);
  assert.deepEqual(seen,['following','invalidated']);
});

test('gap/reconnect/close retire pending changes; no raw stream field or replay crosses the callback',t=>{
  t.mock.timers.enable({apis:['setTimeout']});
  const seen=[],f=new HiveFollow((...args)=>seen.push(args));
  f.begin(cursor(1));f.frame(frame('ready',cursor(1)));
  f.frame(frame('invalidate',cursor(2)));f.changed();
  assert.equal(f.frame(frame('invalidate',cursor(3)).replace('{}','{"private":"x"}')),'gap');
  f.disconnected();t.mock.timers.tick(1000);assert.deepEqual(seen,[['following'],['gap']]);
  f.begin(cursor(9));f.frame(frame('ready',cursor(9)));assert.equal(f.frame(frame('invalidate',cursor(2))),'skip');
  f.disconnected();f.disconnected();f.begin(cursor(17));f.frame(frame('ready',cursor(17)));
  assert.equal(f.frame(frame('invalidate',cursor(18))),'invalidate');f.changed();f.close();
  t.mock.timers.tick(1000);assert.deepEqual(seen,[['following'],['gap'],['following'],['reconnecting'],['following'],['idle']]);
});
