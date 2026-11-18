import test from "node:test";
import assert from "node:assert/strict";
import { inboxItems, emptyInbox } from "../apps/rizzstack-hive/inbox.js";
test('a fresh decision section alone does not establish an empty current queue',()=>{
  const v={generatedAt:'2026-11-18T00:00:00Z',sections:['decisions','alerts','failures','bottlenecks'].map(id=>({id,state:'live'})),stations:[{id:'receiver',quality:'unknown',depth:null}]};
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
