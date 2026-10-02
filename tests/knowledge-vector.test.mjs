import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { openKnowledgeStore } from "../server/knowledge-index-store.mjs";
const ws = "11111111-1111-1111-1111-111111111111";
test("real sqlite-vec ranks workspace-contained vectors and rejects late deleted/reset writes", () => {
  const root = fs.mkdtempSync("/tmp/opencode/knowledge-vector-"),
    db = openKnowledgeStore(root);
  try {
    assert.equal(
      db.vector,
      true,
      "Pinned real sqlite-vec must load on test platform",
    );
    const ingest = (text) =>
      db.ingest(ws, {
        kind: "owner_text",
        title: text,
        location: "fixture",
        bytes: Buffer.from(text),
        text,
      }).row;
    const a = ingest("Astronomy"),
      b = ingest("Gardening");
    const first = new Float32Array(384);
    first[0] = 1;
    const second = new Float32Array(384);
    second[1] = 1;
    const rowsA = db.chunks(ws, a.id),
      rowsB = db.chunks(ws, b.id);
    assert.equal(db.commitVectors(ws, a.id, 0, rowsA, [first]), true);
    assert.equal(db.commitVectors(ws, b.id, 0, rowsB, [second]), true);
    const results = db.search(ws, "no lexical match", 10, first);
    assert.equal(results[0].source_id, a.id);
    assert.equal(results[0].matched, "semantic");
    db.revoke(ws, a.id, 0);
    assert.equal(db.commitVectors(ws, a.id, 0, rowsA, [first]), false);
    assert.ok(
      db.search(ws, "Astronomy", 10, first).every((r) => r.source_id !== a.id),
    );
    db.reset(ws, 1);
    assert.equal(db.commitVectors(ws, b.id, 1, rowsB, [second]), false);
  } finally {
    db.close();
    fs.rmSync(root, { recursive: true });
  }
});
