import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import * as sqliteVec from "sqlite-vec";
import { assertPrivatePath } from "./knowledge-model.mjs";
import { hash, chunk, EXTRACTOR } from "./knowledge-chunker.mjs";
export const LIMITS = {
  sourceBytes: 262144,
  textChars: 100000,
  sources: 128,
  totalBytes: 16777216,
  chunks: 16384,
  tombstones: 4096,
  results: 50,
};
export const fail = (code, extra = {}) =>
  Object.assign(Error(code), { code, ...extra });
export function openKnowledgeStore(root) {
  assertPrivatePath(root, true);
  const dir = path.join(root, "knowledge-index");
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { mode: 0o700 });
  assertPrivatePath(dir, true);
  function open(name, schema) {
    const file = path.join(dir, name),
      exists = fs.existsSync(file);
    for (const suffix of ["", "-wal", "-shm"])
      if (fs.existsSync(file + suffix)) assertPrivatePath(file + suffix);
    let db;
    try {
      if (!exists) {
        const fd = fs.openSync(file, "wx", 0o600);
        fs.closeSync(fd);
      }
      db = new Database(file);
      db.pragma("busy_timeout=2000");
      const version = db.pragma("user_version", { simple: true });
      if (exists && version !== 1) throw fail("unavailable");
      if (!exists)
        db.transaction(() => {
          db.exec(schema);
          db.pragma("user_version=1");
        })();
      if (db.pragma("quick_check", { simple: true }) !== "ok")
        throw fail("unavailable");
      db.pragma("journal_mode=WAL");
      db.pragma("synchronous=FULL");
      return db;
    } catch (error) {
      db?.close();
      throw fail("unavailable");
    }
  }
  const authority = open(
    "snapshots.sqlite",
    `
    CREATE TABLE ledger(workspace TEXT PRIMARY KEY,generation INTEGER NOT NULL);
    CREATE TABLE sources(id TEXT PRIMARY KEY,workspace TEXT NOT NULL,kind TEXT NOT NULL,title TEXT NOT NULL,location TEXT NOT NULL,bytes BLOB NOT NULL,text TEXT NOT NULL,content_hash TEXT NOT NULL,text_hash TEXT NOT NULL,created INTEGER NOT NULL);
    CREATE INDEX source_workspace ON sources(workspace);
    CREATE TABLE tombstones(id TEXT PRIMARY KEY,workspace TEXT NOT NULL,deleted INTEGER NOT NULL);
  `,
  );
  let index;
  try {
    index = open(
      "knowledge-index.sqlite",
      `
    CREATE TABLE chunks(id INTEGER PRIMARY KEY,source TEXT NOT NULL,workspace TEXT NOT NULL,start INTEGER NOT NULL,end INTEGER NOT NULL,text TEXT NOT NULL);
    CREATE INDEX chunk_source ON chunks(source);
    CREATE INDEX chunk_workspace ON chunks(workspace);
    CREATE VIRTUAL TABLE fts USING fts5(text);
  `,
    );
  } catch (error) {
    authority.close();
    throw error;
  }
  let vector = false;
  try {
    sqliteVec.load(index);
    index.exec(
      "CREATE VIRTUAL TABLE IF NOT EXISTS vectors USING vec0(id INTEGER PRIMARY KEY,embedding float[384])",
    );
    vector = true;
  } catch {}
  const generation = (workspace) => {
    authority
      .prepare("INSERT OR IGNORE INTO ledger VALUES (?,0)")
      .run(workspace);
    const value = authority
      .prepare("SELECT generation FROM ledger WHERE workspace=?")
      .get(workspace).generation;
    if (
      !Number.isSafeInteger(value) ||
      value < 0 ||
      value >= Number.MAX_SAFE_INTEGER
    )
      throw fail("unavailable");
    return value;
  };
  const sources = (workspace) => {
    const rows = authority
      .prepare(
        "SELECT id source_id,kind,title,location,content_hash content_sha256,text_hash text_sha256,created created_at FROM sources WHERE workspace=? ORDER BY created DESC,id LIMIT ?",
      )
      .all(workspace, LIMITS.sources + 1);
    if (rows.length > LIMITS.sources) throw fail("unavailable");
    return rows;
  };
  function source(workspace, id) {
    const size = authority
      .prepare(
        "SELECT length(bytes) bytes,length(text) chars FROM sources WHERE workspace=? AND id=?",
      )
      .get(workspace, id);
    if (
      !size ||
      size.bytes > LIMITS.sourceBytes ||
      size.chars > LIMITS.textChars
    )
      throw fail("unavailable");
    const row = authority
      .prepare("SELECT * FROM sources WHERE workspace=? AND id=?")
      .get(workspace, id);
    if (!row) throw fail("unavailable");
    if (
      !["owner_text", "selected_text", "conversation_excerpt", "file"].includes(
        row.kind,
      ) ||
      typeof row.title !== "string" ||
      !row.title.length ||
      row.title.length > 200 ||
      typeof row.location !== "string" ||
      row.location.length > 200 ||
      /[\u0000-\u001f\u007f]/.test(row.title + row.location) ||
      !Buffer.isBuffer(row.bytes) ||
      typeof row.text !== "string" ||
      row.text.length > LIMITS.textChars ||
      !row.text.trim() ||
      !Number.isSafeInteger(row.created) ||
      row.created < 0
    )
      throw fail("unavailable");
    if (
      hash(row.bytes) !== row.content_hash ||
      hash(row.text) !== row.text_hash
    )
      throw fail("unavailable");
    if (
      hash(
        JSON.stringify([
          workspace,
          row.kind,
          row.location,
          row.content_hash,
          EXTRACTOR,
        ]),
      ) !== row.id
    )
      throw fail("unavailable");
    return row;
  }
  function drop(id) {
    const rows = index.prepare("SELECT id FROM chunks WHERE source=?").all(id);
    index.transaction(() => {
      for (const row of rows) {
        index.prepare("DELETE FROM fts WHERE rowid=?").run(row.id);
        if (vector)
          index.prepare("DELETE FROM vectors WHERE id=?").run(BigInt(row.id));
      }
      index.prepare("DELETE FROM chunks WHERE source=?").run(id);
    })();
  }
  function build(row) {
    drop(row.id);
    index.transaction(() => {
      for (const part of chunk(row.text)) {
        const id = index
          .prepare(
            "INSERT INTO chunks(source,workspace,start,end,text) VALUES (?,?,?,?,?)",
          )
          .run(
            row.id,
            row.workspace,
            part.start,
            part.end,
            part.text,
          ).lastInsertRowid;
        index
          .prepare("INSERT INTO fts(rowid,text) VALUES (?,?)")
          .run(id, part.text);
      }
    })();
  }
  function reconcile(workspace) {
    for (const { source: id } of index
      .prepare("SELECT DISTINCT source FROM chunks WHERE workspace=?")
      .all(workspace))
      if (
        !authority
          .prepare("SELECT 1 FROM sources WHERE workspace=? AND id=?")
          .get(workspace, id)
      )
        drop(id);
    for (const { source_id: id } of sources(workspace)) {
      const row = source(workspace, id);
      const parts = chunk(row.text);
      const rows = chunks(workspace, id);
      if (!rows.length) {
        build(row);
        continue;
      }
      if (rows.length !== parts.length) throw fail("unavailable");
      for (let i = 0; i < rows.length; i++) {
        const c = rows[i],
          part = parts[i];
        if (
          c.start !== part.start ||
          c.end !== part.end ||
          c.text !== part.text ||
          index.prepare("SELECT text FROM fts WHERE rowid=?").get(c.id)
            ?.text !== part.text
        )
          throw fail("unavailable");
      }
    }
  }
  function ingest(workspace, { kind, title, location, bytes, text }) {
    const contentHash = hash(bytes),
      textHash = hash(text),
      id = hash(
        JSON.stringify([workspace, kind, location, contentHash, EXTRACTOR]),
      );
    if (
      authority
        .prepare("SELECT 1 FROM tombstones WHERE workspace=? AND id=?")
        .get(workspace, id)
    )
      throw fail("conflict", {
        detail:
          "This exact source was deleted. Change its explicit location label to authorize a distinct new snapshot.",
      });
    const existing = authority
      .prepare("SELECT * FROM sources WHERE workspace=? AND id=?")
      .get(workspace, id);
    if (existing) return { row: source(workspace, id), fresh: false };
    const count = authority
      .prepare(
        "SELECT count(*) n,coalesce(sum(length(bytes)),0) bytes FROM sources WHERE workspace=?",
      )
      .get(workspace);
    if (
      count.n >= LIMITS.sources ||
      count.bytes + bytes.length > LIMITS.totalBytes
    )
      throw fail("limit_exceeded");
    const row = {
      id,
      workspace,
      kind,
      title,
      location,
      bytes,
      text,
      content_hash: contentHash,
      text_hash: textHash,
      created: Date.now(),
    };
    authority
      .prepare(
        "INSERT INTO sources VALUES (@id,@workspace,@kind,@title,@location,@bytes,@text,@content_hash,@text_hash,@created)",
      )
      .run(row);
    build(row);
    return { row, fresh: true };
  }
  function revoke(workspace, id, base, purge = false) {
    const current = generation(workspace);
    if (base !== current)
      throw fail("conflict", { current: { consent_generation: current } });
    const ids = purge
      ? sources(workspace).map((s) => s.source_id)
      : [source(workspace, id).id];
    const existing = authority
      .prepare("SELECT count(*) n FROM tombstones WHERE workspace=?")
      .get(workspace).n;
    if (existing + ids.length > LIMITS.tombstones)
      throw fail("limit_exceeded", {
        detail:
          "Deletion ledger full; administrative offline retention review required.",
      });
    authority.transaction(() => {
      authority
        .prepare("UPDATE ledger SET generation=generation+1 WHERE workspace=?")
        .run(workspace);
      for (const sid of ids) {
        authority
          .prepare("INSERT OR IGNORE INTO tombstones VALUES (?,?,?)")
          .run(sid, workspace, Date.now());
        authority
          .prepare("DELETE FROM sources WHERE workspace=? AND id=?")
          .run(workspace, sid);
      }
    })();
    for (const sid of ids) drop(sid);
    return {
      consent_generation: current + 1,
      deleted: ids.length,
      logical_exclusion: true,
      physical_erasure: false,
    };
  }
  function reset(workspace, base) {
    const current = generation(workspace);
    if (base !== current)
      throw fail("conflict", { current: { consent_generation: current } });
    authority
      .prepare("UPDATE ledger SET generation=generation+1 WHERE workspace=?")
      .run(workspace);
    for (const s of sources(workspace)) build(source(workspace, s.source_id));
    return { consent_generation: current + 1, snapshots_preserved: true };
  }
  function commitVectors(workspace, id, fence, rows, vectors) {
    return index.transaction(() => {
      if (
        generation(workspace) !== fence ||
        !authority
          .prepare("SELECT 1 FROM sources WHERE workspace=? AND id=?")
          .get(workspace, id)
      )
        return false;
      for (const row of rows)
        if (
          !index
            .prepare(
              "SELECT 1 FROM chunks WHERE workspace=? AND source=? AND id=?",
            )
            .get(workspace, id, row.id)
        )
          return false;
      for (let i = 0; i < rows.length; i++) {
        const v = vectors[i];
        if (v?.length !== 384 || !v.every(Number.isFinite))
          throw fail("unavailable");
        index.prepare("DELETE FROM vectors WHERE id=?").run(BigInt(rows[i].id));
        index
          .prepare("INSERT INTO vectors(id,embedding) VALUES (?,?)")
          .run(
            BigInt(rows[i].id),
            Buffer.from(v.buffer, v.byteOffset, v.byteLength),
          );
      }
      return true;
    })();
  }
  function chunks(workspace, id) {
    return index
      .prepare(
        "SELECT * FROM chunks WHERE workspace=? AND source=? ORDER BY id",
      )
      .all(workspace, id);
  }
  function needsEmbedding(workspace, id) {
    return (
      vector &&
      !!index
        .prepare(
          "SELECT 1 FROM chunks c LEFT JOIN vectors v ON v.id=c.id WHERE c.workspace=? AND c.source=? AND v.id IS NULL LIMIT 1",
        )
        .get(workspace, id)
    );
  }
  function stats(workspace) {
    return {
      chunk_count: index
        .prepare("SELECT count(*) n FROM chunks WHERE workspace=?")
        .get(workspace).n,
      semantic_chunk_count: vector
        ? index
            .prepare(
              "SELECT count(*) n FROM chunks c JOIN vectors v ON v.id=c.id WHERE c.workspace=?",
            )
            .get(workspace).n
        : 0,
    };
  }
  function search(workspace, query, limit, embedding, filters = {}) {
    const allowed = sources(workspace)
      .filter(
        (s) =>
          (!filters.kinds?.length || filters.kinds.includes(s.kind)) &&
          (filters.source_ids === undefined ||
            filters.source_ids.includes(s.source_id)),
      )
      .map((s) => s.source_id);
    if (!allowed.length) return [];
    const restriction = ` AND c.source IN (${allowed.map(() => "?").join(",")})`;
    const terms = query.match(/[\p{L}\p{N}_]+/gu)?.slice(0, 32) ?? [];
    // Scoped searches must not use global FTS/BM25 corpus statistics: even an
    // excluded source must not affect rank or crowd out an admitted passage.
    const keyword = filters.source_ids !== undefined
      ? index.prepare('SELECT c.* FROM chunks c WHERE c.workspace=?'+restriction).all(workspace,...allowed)
          .map(row=>({...row,rank:terms.reduce((score,term)=>score+(row.text.toLocaleLowerCase().includes(term.toLocaleLowerCase())?1:0),0)}))
          .filter(row=>row.rank>0).sort((a,b)=>b.rank-a.rank||a.id-b.id).slice(0,500)
      : terms.length
      ? index
          .prepare(
            "SELECT c.*,bm25(fts) rank FROM fts JOIN chunks c ON c.id=fts.rowid WHERE fts MATCH ? AND c.workspace=?" +
              restriction +
              " ORDER BY rank LIMIT 500",
          )
          .all(terms.map((t) => `"${t}"`).join(" OR "), workspace, ...allowed)
      : [];
    // Exact vector distance on a bounded workspace-only candidate set avoids global KNN starvation.
    const semantic =
      embedding && vector
        ? index
            .prepare(
              "SELECT c.*,vec_distance_cosine(v.embedding,?) distance FROM vectors v JOIN chunks c ON c.id=v.id WHERE c.workspace=?" +
                restriction +
                " ORDER BY distance LIMIT 500",
            )
            .all(
              Buffer.from(
                embedding.buffer,
                embedding.byteOffset,
                embedding.byteLength,
              ),
              workspace,
              ...allowed,
            )
        : [];
    const scores = new Map(),
      verified = new Map();
    for (const [type, list] of [
      ["keyword", keyword],
      ["semantic", semantic],
    ])
      for (let rank = 0; rank < list.length; rank++) {
        const row = list[rank];
        let s;
        try {
          s = verified.get(row.source) ?? source(workspace, row.source);
          verified.set(row.source, s);
        } catch {
          continue;
        }
        if (
          (filters.kinds?.length && !filters.kinds.includes(s.kind)) ||
          (filters.source_ids !== undefined && !filters.source_ids.includes(s.id))
        )
          continue;
        let item = scores.get(row.id);
        if (!item) {
          item = {
            chunk_id: row.id,
            source_id: s.id,
            source_kind: s.kind,
            title: s.title,
            location: s.location,
            content_sha256: s.content_hash,
            text_sha256: s.text_hash,
            extractor_version: EXTRACTOR,
            version: 1,
            char_start: row.start,
            char_end: row.end,
            snippet: s.text.slice(row.start, row.end),
            score: 0,
            matched: type,
          };
          scores.set(row.id, item);
        } else item.matched = "both";
        item.score += 1 / (60 + rank + 1);
      }
    return [...scores.values()]
      .sort((a, b) => b.score - a.score || a.chunk_id - b.chunk_id)
      .slice(0, limit);
  }
  return {
    dir,
    vector,
    generation,
    sources,
    source,
    ingest,
    revoke,
    reset,
    reconcile,
    chunks,
    needsEmbedding,
    stats,
    commitVectors,
    search,
    close() {
      index.close();
      authority.close();
    },
  };
}
