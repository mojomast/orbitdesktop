import test from "node:test";
import assert from "node:assert/strict";
import {
  initial,
  validate,
  leaves,
  replace,
  remove,
  pane,
  dimensions,
} from "../src/model.ts";
test("layout validation preserves valid workspace and rejects corrupt geometry", () => {
  const state = initial();
  assert.equal(validate(structuredClone(state)).monitors.length, 3);
  const bad = structuredClone(state);
  bad.monitors[0].height = Infinity;
  assert.throws(() => validate(bad), /Invalid monitor/);
  const duplicate = structuredClone(state);
  duplicate.monitors[1].id = duplicate.monitors[0].id;
  assert.throws(() => validate(duplicate), /duplicate/);
  assert.throws(() => validate({ version: 99 }), /Expected/);
});
test("nested split and removal retain surviving pane identities", () => {
  let l = pane();
  const original = leaves(l)[0].id;
  l = replace(l, original, (p) => ({
    type: "split",
    axis: "row",
    ratio: 0.5,
    first: { type: "pane", pane: p },
    second: pane("browser"),
  }));
  const second = leaves(l)[1].id;
  l = replace(l, second, (p) => ({
    type: "split",
    axis: "column",
    ratio: 0.3,
    first: { type: "pane", pane: p },
    second: pane("agent"),
  }));
  assert.equal(leaves(l).length, 3);
  l = remove(l, second);
  assert.equal(leaves(l).length, 2);
  assert.equal(leaves(l)[0].id, original);
});
test("aspect dimensions and maximum pane bounds", () => {
  const s = initial();
  s.monitors[0].aspect = "9:16";
  const { w, h } = dimensions(s.monitors[0]);
  assert(h > w);
  let l = s.monitors[0].layout;
  for (let i = 0; i < 8; i++) {
    const pid = leaves(l).at(-1).id;
    l = replace(l, pid, (p) => ({
      type: "split",
      axis: "row",
      ratio: 0.5,
      first: { type: "pane", pane: p },
      second: pane(),
    }));
  }
  s.monitors[0].layout = l;
  assert.throws(() => validate(s), /layout|panes/);
});
