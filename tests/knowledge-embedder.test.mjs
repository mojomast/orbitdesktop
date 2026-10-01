import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { performance } from "node:perf_hooks";
import { createEmbedder } from "../server/knowledge-embedder.mjs";
import { createKnowledgeSearch } from "../server/knowledge-index.mjs";
import { verifyModel } from "../server/knowledge-model.mjs";
test("absent model means useful explicit semantic-off status and no remote fetch", async () => {
  const embedder = createEmbedder({
    modelDir: "/tmp/opencode/nonexistent-knowledge-model",
  });
  assert.equal(embedder.status().present, false);
  await assert.rejects(embedder.embed(["test"]));
  await embedder.dispose();
});
const modelDir = process.env.ORBIT_TEST_MODEL_DIR;
test(
  "real offline MiniLM worker + cancellation + sqlite-vec public-corpus retrieval latency",
  { skip: !modelDir },
  async (t) => {
    const embedder = createEmbedder({ modelDir });
    t.after(() => embedder.dispose());
    assert.equal(embedder.status().present, true);
    let start = performance.now();
    const vectors = await embedder.embed([
      "A canine plays with a ball.",
      "The observatory studies planets.",
    ]);
    const cold = performance.now() - start;
    assert.equal(vectors[0].length, 384);
    assert.ok(Math.abs(Math.hypot(...vectors[0]) - 1) < 0.001);
    start = performance.now();
    await embedder.embed(["A happy dog is playing outside."]);
    const warm = performance.now() - start;
    const pending = embedder.embed(["A dog plays."]);
    const rejected = assert.rejects(pending);
    await embedder.cancel();
    await rejected;
    const root = fs.mkdtempSync("/tmp/opencode/knowledge-real-model-");
    fs.mkdirSync(root + "/knowledge-index", { mode: 0o700 });
    // fs.cpSync creates destination directories using the process umask, not
    // the source directory modes. Keep this private fixture valid on CI's 0022.
    fs.mkdirSync(root + "/knowledge-index/model", { mode: 0o700 });
    fs.mkdirSync(root + "/knowledge-index/model/onnx", { mode: 0o700 });
    fs.cpSync(modelDir, root + "/knowledge-index/model", { recursive: true });
    assert.equal(verifyModel(root + "/knowledge-index/model"), true);
    const svc = createKnowledgeSearch({ root, workspaceRead: () => ({}) }),
      workspace_id = "11111111-1111-1111-1111-111111111111";
    const call = (action, fields = {}) =>
      svc.dispatch({ action, workspace_id, ...fields });
    try {
      const corpus = [
        "A canine plays with a ball in the park.",
        "The telescope observes a distant galaxy.",
        "Tomatoes need sunshine and regular watering.",
        "A chef prepares fresh bread in the kitchen.",
        "The train carries commuters into the city.",
      ];
      start = performance.now();
      for (let i = 0; i < corpus.length; i++)
        await call("ingest_text", {
          kind: "owner_text",
          title: `Public synthetic ${i}`,
          text: corpus[i],
        });
      const deadline = Date.now() + 120000;
      while ((await call("status")).indexing) {
        assert.ok(Date.now() < deadline);
        await new Promise((r) => setTimeout(r, 100));
      }
      const ingestMs = performance.now() - start;
      start = performance.now();
      const search = await call("search", {
        query: "Dogs frolic outdoors",
        mode: "hybrid",
      });
      const queryMs = performance.now() - start;
      assert.equal(search.semantic_used, true);
      assert.equal(search.results[0].title, "Public synthetic 0");
      assert.equal(search.results[0].matched, "semantic");
      t.diagnostic(
        JSON.stringify({
          engine: "real MiniLM q8 CPU + sqlite-vec",
          corpus: corpus.length,
          coldEmbeddingMs: Math.round(cold),
          warmEmbeddingMs: Math.round(warm),
          ingestAndIndexMs: Math.round(ingestMs),
          queryMs: Math.round(queryMs),
        }),
      );
      // Deletion during an actual asynchronous query fences the response, even if native inference finishes late.
      const id = search.results[0].source_id;
      const racing = call("search", {
        query: "Dogs frolic outdoors",
        mode: "hybrid",
      });
      const rejected = assert.rejects(racing, { code: "conflict" });
      await call("delete_source", {
        source_id: id,
        base_consent_generation: 0,
      });
      await rejected;
      assert.ok(
        (
          await call("search", { query: "canine", mode: "keyword" })
        ).results.every((r) => r.source_id !== id),
      );
    } finally {
      await svc.close();
      fs.rmSync(root, { recursive: true });
    }
  },
);
