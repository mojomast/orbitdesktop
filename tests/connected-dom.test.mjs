import assert from "node:assert/strict";
import { test } from "node:test";
import { moveConnected, supportsConnectedMove } from "../src/connected-dom.ts";

function installElementPrototype(moveBefore) {
  const original = globalThis.Element;
  class StubElement {}
  if (moveBefore) StubElement.prototype.moveBefore = moveBefore;
  globalThis.Element = StubElement;
  return () => {
    if (original === undefined) delete globalThis.Element;
    else globalThis.Element = original;
  };
}

function node({ connected = true, nextSibling = null } = {}) {
  return {
    isConnected: connected,
    parentNode: null,
    nextSibling,
  };
}

test("uses native moveBefore for connected elements and parents", () => {
  const calls = [];
  const restore = installElementPrototype(function (...args) {
    calls.push(args);
  });
  try {
    assert.equal(supportsConnectedMove(), true);
    const element = node();
    const before = node();
    const parent = Object.assign(node(), {
      moveBefore(...args) { calls.push(args); },
      appendChild() { assert.fail("unexpected fallback"); },
      insertBefore() { assert.fail("unexpected fallback"); },
    });
    moveConnected(element, parent, before);
    assert.deepEqual(calls, [[element, before]]);
  } finally {
    restore();
  }
});

test('initial disconnected mounts do not emit a misleading continuity warning',()=>{
  const restore=installElementPrototype(undefined),originalWarn=console.warn,warnings=[];
  console.warn=message=>warnings.push(message);
  try {const element=node({connected:false});moveConnected(element,Object.assign(node(),{appendChild:()=>{}}));assert.deepEqual(warnings,[]);}finally {console.warn=originalWarn;restore();}
});

test("falls back for missing native support and warns once", () => {
  const restore = installElementPrototype(undefined);
  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (...args) => warnings.push(args);
  try {
    assert.equal(supportsConnectedMove(), false);
    const element = node();
    const before = node();
    const calls = [];
    const parent = Object.assign(node(), {
      insertBefore(...args) { calls.push(["insert", ...args]); },
      appendChild(...args) { calls.push(["append", ...args]); },
    });
    moveConnected(element, parent, before);
    moveConnected(element, parent);
    assert.deepEqual(calls, [["insert", element, before], ["append", element]]);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0][0], /does not promise to preserve iframe state/);
  } finally {
    console.warn = originalWarn;
    restore();
  }
});

test("does not use native move for a disconnected source", () => {
  const restore = installElementPrototype(function () {
    assert.fail("native move should not be used");
  });
  const originalWarn = console.warn;
  console.warn = () => {};
  try {
    const element = node({ connected: false });
    const parent = Object.assign(node(), {
      appendChild(child) { assert.equal(child, element); },
    });
    moveConnected(element, parent);
  } finally {
    console.warn = originalWarn;
    restore();
  }
});

test("ignores same-parent order no-ops", () => {
  const restore = installElementPrototype(() => assert.fail("unexpected move"));
  try {
    const next = node();
    const element = node({ nextSibling: next });
    const parent = node();
    element.parentNode = parent;
    moveConnected(element, parent, next);
    assert.equal(supportsConnectedMove(), true);
  } finally {
    restore();
  }
});

test('cross-document moves do not invoke a native API that cannot preserve them',()=>{
  const restore=installElementPrototype(()=>assert.fail('Cross-document native move'));
  try {
    const element=Object.assign(node(),{ownerDocument:{}}),calls=[];
    const parent=Object.assign(node(),{ownerDocument:{},appendChild:child=>calls.push(child)});
    moveConnected(element,parent);assert.deepEqual(calls,[element]);
  }finally {restore();}
});
