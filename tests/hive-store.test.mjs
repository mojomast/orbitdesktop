import test from "node:test";
import assert from "node:assert/strict";
import { createStore } from "../apps/rizzstack-hive/store.js";
import { confirmedChanges } from "../apps/rizzstack-hive/transitions.js";
const view = (minute, state = "running") => ({
  generatedAt: `2026-11-17T12:${minute}:00Z`,
  health: "live",
  metrics: { active: 1 },
  sections: [],
  attempts: [{ id: "bee-1", state }],
  stations: [],
  attention: [],
  records: [],
});
test("old pages and reconnect duplicates cannot rewind or create achievements", () => {
  const s = createStore();
  assert.equal(s.hydrate(view("01")), "new");
  s.select("attempt", "bee-1");
  assert.equal(s.hydrate(view("01")), "duplicate");
  assert.equal(s.hydrate(view("00", "failed")), "old");
  assert.equal(s.current.view.attempts[0].state, "running");
  assert.deepEqual(s.current.selection, { kind: "attempt", id: "bee-1" });
});
test("incompatible observations at the same collector time require reconciliation", () => {
  const s = createStore();
  s.hydrate(view("01"));
  assert.equal(s.hydrate(view("01", "failed")), "conflict");
  assert.equal(s.current.status, "conflict");
  s.transport("loading");
  s.hydrate(view("01"));
  s.transport("connected");
  assert.equal(s.current.status, "conflict");
  assert.equal(s.current.view.attempts[0].state, "running");
  s.hydrate(view("02", "failed"));
  assert.equal(s.current.view.attempts[0].state, "failed");
});
test("only the same fresh attempt with an advancing origin time can pulse across continuous reads", () => {
  const a = view("01"),
    b = view("02", "succeeded");
  for (const v of [a, b])
    Object.assign(v.attempts[0], {
      at: v.generatedAt,
      quality: "live",
      source: "fleet",
    });
  assert.deepEqual([...confirmedChanges(a, b, true)], ["bee-1"]);
  assert.equal(confirmedChanges(a, b, false).size, 0);
  b.attempts[0].quality = "stale";
  assert.equal(confirmedChanges(a, b, true).size, 0);
});
test("revoke erases prior data and private selection, transport loss retains explicitly historical state", () => {
  const s = createStore();
  s.hydrate(view("01"));
  s.select("attempt", "bee-1");
  s.transport("disconnected");
  assert.ok(s.current.view);
  s.transport("unauthorized");
  assert.equal(s.current.view, null);
  assert.deepEqual(s.current.selection, { kind: "station", id: "build" });
});
