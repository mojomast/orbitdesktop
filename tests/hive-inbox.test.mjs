import test from "node:test";
import assert from "node:assert/strict";
import { inboxItems, emptyInbox } from "../apps/rizzstack-hive/inbox.js";
import { fixtures, fixtureTime } from '../apps/rizzstack-hive/fixtures.js';
import { project } from '../apps/rizzstack-hive/snapshot-adapter.js';

const dense = () => project(fixtures.dense, {now: fixtureTime});
test('only aliases of a single measured observation group; job, CI and verifier symptoms stay separate', () => {
  const v = dense();
  const dwell = v.attention.find(a => a.id === 'bottleneck:verify');
  v.attention.push({...dwell, id:'section:dwell', detail:dwell.id});
  const owner = v.records.find(r => r.kind === 'decision' && r.state === 'pending');
  const other = {...owner,id:'decision:other',title:'A separate question'};
  v.records.push(other);
  v.attention.push({...v.attention.find(a => a.id === owner.id), id:other.id});
  const rows = inboxItems(v);
  assert.equal(rows.filter(r => r.target.id === dwell.id).length, 1);
  assert.equal(rows.find(r => r.target.id === dwell.id).signalCount, 2);
  assert.deepEqual(new Set(rows.filter(r => r.owner).map(r => r.title)),new Set([owner.title,other.title]));
  const symptoms = rows.filter(r => ['section:failed-tasks','section:failing-ci','section:verifier-failure'].includes(r.id));
  assert.equal(symptoms.length, 3);
  for (const r of symptoms) {
    for (const key of ['shortCategory','impact','cause','severity','recovery','next']) assert.ok(r[key], key);
    assert.match(r.recovery,/unknown|not established/i);
    assert.doesNotMatch(r.impact,/pending review|recovered|ready to merge/i);
  }
});

test('a broken or ambiguous evidence pointer is never promoted into an owner question', () => {
  const v = dense(), a = v.attention.find(a => a.id.startsWith('decision:'));
  v.attention = [{...a, detail:'decision:missing'}];
  assert.deepEqual(inboxItems(v)[0].target, {kind:'attention',id:a.id});
  v.attention = [{...a,detail:'decision:gate_window'}];
  assert.deepEqual(inboxItems(v)[0].target, {kind:'attention',id:a.id});
  v.attention = [a];
  v.records.push({...v.records.find(r=>r.id===a.id)});
  assert.equal(inboxItems(v)[0].owner, false);
  const interrupted = inboxItems(dense(),true);
  for (const r of interrupted) {
    assert.equal(r.owner,false); assert.equal(r.shortCategory,'History');
    assert.match(r.impact,/unknown|unconfirmed/i);
  }
});
test('a fresh decision section alone does not establish an empty current queue',()=>{
  const v={generatedAt:'2026-11-18T00:00:00Z',sections:['decisions','alerts','failures','bottlenecks','ci','pipeline','backlog','fleet'].map(id=>({id,state:'live'})),stations:[{id:'receiver',quality:'unknown',depth:null}]};
  assert.match(emptyInbox(v),/Incomplete coverage: current owner requests/);v.stations[0]={id:'receiver',quality:'live',depth:0};assert.match(emptyInbox(v),/^No active attention/);
});
test("only the matching, fresh, genuinely pending decision is classified as requiring the owner", () => {
  const at = "2026-11-17T11:00:00Z",
    source = "snapshot/1:decisions",
    v = {
      generatedAt: at,
      sections: [{ id: "decisions", state: "live" }],
      records: [
        {
          kind: "decision",
          source,
          id: "decision:a",
          title: "Release read gate",
          state: "pending",
        },
      ],
      attention: [
        { id: "decision:a", source, at, level: "gate" },
        { id: "decision:b", source, at, level: "gate" },
      ],
    };
  assert.deepEqual(
    inboxItems(v).map((x) => x.owner),
    [true, false],
  );
  assert.equal(inboxItems(v, true)[0].owner, false);
  v.records[0].source = "other";
  assert.equal(inboxItems(v)[0].target.kind, "attention");
  assert.match(emptyInbox(v), /Incomplete coverage/);
});
