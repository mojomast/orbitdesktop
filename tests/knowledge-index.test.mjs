import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import http from "node:http";
import {
  createKnowledgeSearch,
  createKnowledgeSearchRoute,
  KNOWLEDGE_MAX_BODY_BYTES,
} from "../server/knowledge-index.mjs";
import { hash } from "../server/knowledge-chunker.mjs";
const ws = "11111111-1111-1111-1111-111111111111",
  other = "22222222-2222-2222-2222-222222222222";
function fixture(t) {
  const root = fs.mkdtempSync("/tmp/opencode/knowledge-index-");
  let service;
  const open = () =>
    (service = createKnowledgeSearch({
      root,
      workspaceRead: (id) => {
        if (![ws, other].includes(id)) throw Error("gone");
        return { id };
      },
    }));
  open();
  t.after(async () => {
    await service.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  return {
    root,
    get service() {
      return service;
    },
    open,
    call: (action, fields = {}, workspace_id = ws) =>
      service.dispatch({ action, workspace_id, ...fields }),
  };
}
const textFields = {
  kind: "owner_text",
  title: "Public test corpus",
  location: "synthetic fixture",
  text: "The observatory telescope sees distant planets.\r\nThe garden contains roses. 🌻",
};
test("strict dispatch scope, exact bytes/citations, idempotency, deletion and restart authority", async (t) => {
  const f = fixture(t);
  await assert.rejects(f.call("status", { unexpected: true }), {
    code: "invalid_request",
  });
  await assert.rejects(
    f.call("status", {}, "33333333-3333-3333-3333-333333333333"),
    { code: "unavailable" },
  );
  const source = await f.call("ingest_text", textFields);
  assert.equal(source.semantic_queued, false);
  assert.equal((await f.call("ingest_text", textFields)).idempotent, true);
  const found = await f.call("search", {
    query: 'planets" OR unknown : *',
    mode: "keyword",
  });
  assert.equal(found.semantic_used, false);
  assert.equal(found.results.length, 1);
  const citation = found.results[0];
  assert.equal(
    citation.snippet,
    textFields.text.slice(citation.char_start, citation.char_end),
  );
  assert.equal(citation.text_sha256, hash(textFields.text));
  const exact = await f.call("get_source", { source_id: source.source_id });
  assert.equal(
    Buffer.from(exact.data_base64, "base64").toString(),
    textFields.text,
  );
  assert.deepEqual(
    (await f.call("search", { query: "planets" }, other)).results,
    [],
  );
  await assert.rejects(
    f.call("get_source", { source_id: source.source_id }, other),
    { code: "unavailable" },
  );
  await assert.rejects(
    f.call("delete_source", {
      source_id: source.source_id,
      base_consent_generation: 1,
    }),
    (e) => e.code === "conflict" && e.current.consent_generation === 0,
  );
  assert.equal(
    (await f.call("reset_index", { confirm: true, base_consent_generation: 0 }))
      .snapshots_preserved,
    true,
  );
  assert.equal(
    (await f.call("get_source", { source_id: source.source_id })).text,
    textFields.text,
  );
  const deleted = await f.call("delete_source", {
    source_id: source.source_id,
    base_consent_generation: 1,
  });
  assert.equal(deleted.logical_exclusion, true);
  assert.equal(deleted.physical_erasure, false);
  await f.service.close();
  f.open();
  assert.equal((await f.call("status")).consent_generation, 2);
  assert.deepEqual((await f.call("search", { query: "planets" })).results, []);
  await assert.rejects(f.call("ingest_text", textFields), { code: "conflict" });
  await assert.rejects(f.call("get_source", { source_id: source.source_id }), {
    code: "unavailable",
  });
});
test("file consent is bytes-only, UTF-8 fatal, bounded and exact BOM/CRLF snapshot", async (t) => {
  const f = fixture(t),
    bytes = Buffer.from("\ufeffName,Value\r\nEarth,1\r\n");
  const s = await f.call("ingest_file", {
    filename: "public.csv",
    media_type: "text/csv",
    data_base64: bytes.toString("base64"),
  });
  assert.equal(s.content_sha256, hash(bytes));
  assert.deepEqual(
    Buffer.from(
      (await f.call("get_source", { source_id: s.source_id })).data_base64,
      "base64",
    ),
    bytes,
  );
  await assert.rejects(
    f.call("ingest_file", {
      filename: "binary.txt",
      media_type: "text/plain",
      data_base64: Buffer.from([0xff]).toString("base64"),
    }),
    { code: "unsupported" },
  );
  await assert.rejects(
    f.call("ingest_file", {
      filename: "binary.txt",
      media_type: "text/plain",
      data_base64: Buffer.from([0]).toString("base64"),
    }),
    { code: "unsupported" },
  );
  await assert.rejects(
    f.call("ingest_file", {
      filename: "file.txt",
      media_type: "text/plain",
      data_base64: "YQ==",
      path: "/etc/passwd",
    }),
    { code: "invalid_request" },
  );
  await assert.rejects(
    f.call("ingest_text", { ...textFields, text: "a".repeat(100001) }),
    { code: "invalid_request" },
  );
  assert.ok(KNOWLEDGE_MAX_BODY_BYTES > 350000);
});
test("changed bytes are new citations; index rebuild preserves originals; purge workspace scoped", async (t) => {
  const f = fixture(t),
    a = await f.call("ingest_text", textFields),
    b = await f.call("ingest_text", {
      ...textFields,
      text: "Different planets snapshot",
    });
  assert.notEqual(a.source_id, b.source_id);
  await f.call("ingest_text", textFields, other);
  await f.call("purge_snapshots", {
    confirm: true,
    base_consent_generation: 0,
  });
  assert.equal((await f.call("list_sources")).sources.length, 0);
  assert.equal((await f.call("list_sources", {}, other)).sources.length, 1);
  await assert.rejects(
    f.call("purge_snapshots", { confirm: false, base_consent_generation: 1 }),
    { code: "invalid_request" },
  );
});
test("symlinks, insecure modes and corrupt/future schemas fail closed without implicit repair", async (t) => {
  const f = fixture(t);
  await f.service.close();
  const dir = path.join(f.root, "knowledge-index");
  fs.mkdirSync(dir, { mode: 0o700 });
  const file = path.join(dir, "snapshots.sqlite");
  fs.writeFileSync(file, "not sqlite", { mode: 0o600 });
  const before = fs.readFileSync(file);
  f.open();
  await assert.rejects(f.call("status"), { code: "unavailable" });
  assert.deepEqual(fs.readFileSync(file), before);
  await f.service.close();
  fs.rmSync(file);
  const db = new Database(file);
  db.pragma("user_version=99");
  db.close();
  fs.chmodSync(file, 0o600);
  f.open();
  await assert.rejects(f.call("status"), { code: "unavailable" });
  await f.service.close();
  fs.rmSync(file);
  f.open();
  await f.call("status");
  await f.service.close();
  fs.chmodSync(file, 0o644);
  f.open();
  await assert.rejects(f.call("status"), { code: "unavailable" });
  assert.equal(
    fs.statSync(file).mode & 0o777,
    0o644,
    "No implicit permission repair",
  );
  await f.service.close();
  fs.rmSync(file);
  fs.symlinkSync("/dev/null", file);
  f.open();
  await assert.rejects(f.call("status"), { code: "unavailable" });
});
test("missing derived index rebuilds from authority; record tampering fails without repair", async (t) => {
  const f = fixture(t),
    s = await f.call("ingest_text", textFields);
  await f.service.close();
  const file = path.join(f.root, "knowledge-index", "knowledge-index.sqlite");
  for (const suffix of ["", "-wal", "-shm"])
    fs.rmSync(file + suffix, { force: true });
  f.open();
  assert.equal(
    (await f.call("search", { query: "planets", mode: "keyword" })).results[0]
      .source_id,
    s.source_id,
  );
  assert.equal(
    (await f.call("get_source", { source_id: s.source_id })).text,
    textFields.text,
  );
  await f.service.close();
  const index = new Database(file);
  index.prepare("UPDATE chunks SET start=999").run();
  index.close();
  f.open();
  await assert.rejects(f.call("search", { query: "planets" }), {
    code: "unavailable",
  });
  await f.service.close();
  const check = new Database(file);
  assert.equal(check.prepare("SELECT start FROM chunks").get().start, 999);
  check.close();
});
test("real owner HTTP route enforces auth/origin/body limits and preserves conflict generation", async (t) => {
  const f = fixture(t);
  let route;
  const server = http.createServer((req, res) => route(req, res));
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const port = server.address().port,
    url = `http://127.0.0.1:${port}/api/search`,
    token = "synthetic-token";
  route = createKnowledgeSearchRoute({
    service: f.service,
    token,
    port,
    reply: (res, status, data) => {
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(data));
    },
  });
  const post = (body, headers = {}) =>
    fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        Origin: `http://127.0.0.1:${port}`,
        ...headers,
      },
      body: JSON.stringify(body),
    });
  let response = await post(
    { action: "status", workspace_id: ws },
    { Authorization: "Bearer wrong" },
  );
  assert.equal(response.status, 403);
  assert.equal(response.headers.get("cache-control"), "no-store");
  response = await post(
    { action: "status", workspace_id: ws },
    { Origin: "https://untrusted.example" },
  );
  assert.equal(response.status, 403);
  response = await post({ action: "status", workspace_id: ws });
  assert.equal(response.status, 200);
  response = await post({
    action: "ingest_text",
    workspace_id: ws,
    ...textFields,
  });
  const s = await response.json();
  assert.equal(response.status, 200);
  response = await post({
    action: "delete_source",
    workspace_id: ws,
    source_id: s.source_id,
    base_consent_generation: 999,
  });
  assert.equal(response.status, 409);
  assert.equal((await response.json()).current.consent_generation, 0);
  response = await post({
    action: "status",
    workspace_id: ws,
    oversize: "x".repeat(KNOWLEDGE_MAX_BODY_BYTES),
  });
  assert.equal(response.status, 413);
});
