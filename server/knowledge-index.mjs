import path from "node:path";
import Ajv from "ajv";
import { openKnowledgeStore, LIMITS, fail } from "./knowledge-index-store.mjs";
import { decode, EXTRACTOR } from "./knowledge-chunker.mjs";
import { createEmbedder } from "./knowledge-embedder.mjs";
import { allowedRequest, tokenMatches } from "./security.mjs";
export const KNOWLEDGE_MAX_BODY_BYTES = 400 * 1024;
// Optional parent integration adapter: preserves CAS detail, unlike the generic Workbench wrapper.
export function createKnowledgeSearchRoute({
  service,
  token,
  port,
  devOrigins = [],
  reply,
}) {
  return async (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    if (req.method !== "POST")
      return reply(res, 405, { ok: false, code: "invalid_request" });
    const auth = req.headers.authorization ?? "";
    if (
      !allowedRequest(req, port, devOrigins) ||
      !auth.startsWith("Bearer ") ||
      !tokenMatches(auth.slice(7), token)
    )
      return reply(res, 403, { ok: false, code: "permission_denied" });
    try {
      const chunks = [];
      let size = 0;
      for await (const part of req) {
        size += Buffer.byteLength(part);
        if (size > KNOWLEDGE_MAX_BODY_BYTES) throw fail("limit_exceeded");
        chunks.push(Buffer.from(part));
      }
      let body;
      try {
        body = JSON.parse(
          new TextDecoder("utf-8", { fatal: true }).decode(
            Buffer.concat(chunks),
          ),
        );
      } catch {
        throw fail("invalid_request");
      }
      const result = await service.dispatch(body);
      return reply(res, 200, result);
    } catch (error) {
      const statuses = {
        invalid_request: 400,
        permission_denied: 403,
        unavailable: 404,
        conflict: 409,
        limit_exceeded: 413,
        busy: 429,
        unsupported: 422,
      };
      const code = Object.hasOwn(statuses, error.code)
        ? error.code
        : "unavailable";
      return reply(res, statuses[code], {
        ok: false,
        code,
        ...(code === "conflict" && error.current
          ? { current: error.current }
          : {}),
        ...(typeof error.detail === "string"
          ? { detail: error.detail.slice(0, 500) }
          : {}),
      });
    }
  };
}
const label = {
  type: "string",
  minLength: 1,
  maxLength: 200,
  pattern: "^[^\\u0000-\\u001f\\u007f]*$",
};
const sid = { type: "string", pattern: "^[a-f0-9]{64}$" };
const base = { type: "integer", minimum: 0, maximum: Number.MAX_SAFE_INTEGER };
const shapes = {
  status: {},
  list_sources: {},
  search: {
    query: { type: "string", minLength: 1, maxLength: 500 },
    mode: { enum: ["keyword", "hybrid"] },
    limit: { type: "integer", minimum: 1, maximum: 50 },
    kinds: {
      type: "array",
      maxItems: 4,
      items: {
        enum: ["owner_text", "selected_text", "conversation_excerpt", "file"],
      },
    },
    source_ids: { type: "array", maxItems: 128, items: sid },
  },
  ingest_text: {
    kind: { enum: ["owner_text", "selected_text", "conversation_excerpt"] },
    title: label,
    text: { type: "string", minLength: 1, maxLength: LIMITS.textChars },
    location: label,
  },
  ingest_file: {
    filename: label,
    media_type: {
      enum: ["text/plain", "text/markdown", "text/csv", "application/json"],
    },
    data_base64: {
      type: "string",
      maxLength: 349528,
      pattern:
        "^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$",
    },
  },
  get_source: { source_id: sid },
  delete_source: { source_id: sid, base_consent_generation: base },
  reset_index: { confirm: { const: true }, base_consent_generation: base },
  purge_snapshots: { confirm: { const: true }, base_consent_generation: base },
};
const required = {
  search: ["query"],
  ingest_text: ["kind", "title", "text"],
  ingest_file: ["filename", "media_type", "data_base64"],
  get_source: ["source_id"],
  delete_source: ["source_id", "base_consent_generation"],
  reset_index: ["confirm", "base_consent_generation"],
  purge_snapshots: ["confirm", "base_consent_generation"],
};
const valid = new Ajv({ strict: true }).compile({
  oneOf: Object.entries(shapes).map(([action, properties]) => ({
    type: "object",
    additionalProperties: false,
    required: ["action", "workspace_id", ...(required[action] ?? [])],
    properties: {
      action: { const: action },
      workspace_id: {
        type: "string",
        pattern:
          "^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$",
      },
      ...properties,
    },
  })),
});
export function createKnowledgeSearch({ root, workspaceRead }) {
  let store = null,
    embedder = null,
    closed = false,
    running = false;
  const queue = [],
    seen = new Set(),
    jobs = new Set();
  function open() {
    if (closed) throw fail("unavailable");
    if (!store) {
      store = openKnowledgeStore(root);
      embedder = createEmbedder({ modelDir: path.join(store.dir, "model") });
    }
    return store;
  }
  function enqueue(workspace, id) {
    if (
      !store.vector ||
      !embedder.status().present ||
      seen.has(id) ||
      queue.length >= 128
    )
      return false;
    seen.add(id);
    queue.push({ workspace, id, fence: store.generation(workspace) });
    if (!running) {
      const job = drain();
      jobs.add(job);
      void job.finally(() => jobs.delete(job));
    }
    return true;
  }
  async function drain() {
    running = true;
    try {
      while (queue.length && !closed) {
        const item = queue.shift();
        try {
          const rows = store.chunks(item.workspace, item.id);
          for (let i = 0; i < rows.length; i += 16) {
            if (closed || store.generation(item.workspace) !== item.fence)
              break;
            const batch = rows.slice(i, i + 16),
              vectors = await embedder.embed(batch.map((r) => r.text));
            if (
              closed ||
              !store.commitVectors(
                item.workspace,
                item.id,
                item.fence,
                batch,
                vectors,
              )
            )
              break;
          }
        } catch {
        } finally {
          seen.delete(item.id);
        }
      }
    } finally {
      running = false;
    }
  }
  async function dispatch(body) {
    if (!valid(body)) throw fail("invalid_request");
    const ws = body.workspace_id;
    if (typeof workspaceRead !== "function") throw fail("unavailable");
    try {
      if (!(await workspaceRead(ws))) throw fail("unavailable");
    } catch {
      throw fail("unavailable");
    }
    const db = open();
    db.reconcile(ws);
    // Resume interrupted/missing derived embeddings only from current authoritative snapshots.
    if (embedder.status().present)
      for (const s of db.sources(ws))
        if (db.needsEmbedding(ws, s.source_id)) enqueue(ws, s.source_id);
    const ok = (data) => ({ ok: true, workspace_id: ws, ...data });
    switch (body.action) {
      case "status":
        return ok({
          source_count: db.sources(ws).length,
          ...db.stats(ws),
          consent_generation: db.generation(ws),
          semantic: { ...embedder.status(), vector_available: db.vector },
          index_schema: 1,
          limits: LIMITS,
          indexing: running,
        });
      case "list_sources":
        return ok({
          sources: db
            .sources(ws)
            .map((s) => ({
              ...s,
              status:
                db.vector && !db.needsEmbedding(ws, s.source_id)
                  ? "semantic_ready"
                  : "keyword_ready",
            })),
          consent_generation: db.generation(ws),
        });
      case "ingest_text":
      case "ingest_file": {
        const bytes =
          body.action === "ingest_file"
            ? Buffer.from(body.data_base64, "base64")
            : Buffer.from(body.text, "utf8");
        if (!bytes.length || bytes.length > LIMITS.sourceBytes)
          throw fail("limit_exceeded");
        let text;
        try {
          text = decode(bytes);
        } catch {
          throw fail("unsupported");
        }
        if (body.action === "ingest_text" && text !== body.text)
          throw fail("unsupported");
        if (text.length > LIMITS.textChars || !text.trim())
          throw fail("limit_exceeded");
        if (
          body.action === "ingest_file" &&
          bytes.toString("base64") !== body.data_base64
        )
          throw fail("invalid_request");
        const { row, fresh } = db.ingest(ws, {
          kind: body.action === "ingest_file" ? "file" : body.kind,
          title: body.title ?? body.filename,
          location: body.location ?? body.filename ?? "",
          bytes,
          text,
        });
        return ok({
          source_id: row.id,
          content_sha256: row.content_hash,
          text_sha256: row.text_hash,
          extractor_version: EXTRACTOR,
          version: 1,
          chunks: db.chunks(ws, row.id).length,
          idempotent: !fresh,
          semantic_queued: enqueue(ws, row.id),
        });
      }
      case "get_source": {
        const s = db.source(ws, body.source_id);
        return ok({
          source_id: s.id,
          title: s.title,
          kind: s.kind,
          location: s.location,
          text: s.text,
          data_base64: s.bytes.toString("base64"),
          content_sha256: s.content_hash,
          text_sha256: s.text_hash,
          extractor_version: EXTRACTOR,
        });
      }
      case "search": {
        const fence = db.generation(ws);
        let embedding = null;
        if (body.mode !== "keyword" && db.vector && embedder.status().present) {
          try {
            [embedding] = await embedder.embed([body.query]);
          } catch {}
        }
        if (closed) throw fail("unavailable");
        if (db.generation(ws) !== fence)
          throw fail("conflict", {
            current: { consent_generation: db.generation(ws) },
          });
        const results = db.search(
          ws,
          body.query,
          body.limit ?? 20,
          embedding,
          body,
        );
        return ok({
          query: body.query,
          mode: embedding ? "hybrid" : "keyword",
          semantic_used: !!embedding,
          results,
          note: embedding
            ? "Local MiniLM + FTS reciprocal rank fusion"
            : "FTS keyword fallback; semantic unavailable or explicitly off",
        });
      }
      case "delete_source":
      case "purge_snapshots":
      case "reset_index": {
        const data =
          body.action === "reset_index"
            ? db.reset(ws, body.base_consent_generation)
            : db.revoke(
                ws,
                body.source_id,
                body.base_consent_generation,
                body.action === "purge_snapshots",
              );
        for (let i = queue.length - 1; i >= 0; i--)
          if (queue[i].workspace === ws) {
            seen.delete(queue[i].id);
            queue.splice(i, 1);
          }
        await embedder.cancel();
        if (body.action === "reset_index") {
          await Promise.allSettled([...jobs]);
          for (const s of db.sources(ws)) enqueue(ws, s.source_id);
        }
        return ok(data);
      }
    }
  }
  return {
    dispatch,
    maxBodyBytes: KNOWLEDGE_MAX_BODY_BYTES,
    async close() {
      closed = true;
      queue.length = 0;
      await embedder?.dispose();
      await Promise.allSettled([...jobs]);
      store?.close();
      store = null;
    },
  };
}
