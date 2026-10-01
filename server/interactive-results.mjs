import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import {
  canonical,
  exact,
  fail,
  LIMITS,
  validateResult,
} from "../contracts/interactive-results-v1.mjs";

const hash = (value) =>
  createHash("sha256").update(canonical(value)).digest("hex");
const id = (value) => {
  if (typeof value !== "string" || !/^[a-f0-9-]{36}$/.test(value))
    fail("invalid_request", "Invalid identifier");
  return value;
};
const digest = (record) =>
  hash({
    policy: 1,
    protocol: "v0.9",
    source: record.source,
    messages: record.messages,
    user_values: record.user_values,
  });
function check(record) {
  exact(record, [
    "version",
    "id",
    "workspace_id",
    "revision",
    "title",
    "protocol",
    "messages",
    "user_values",
    "source",
    "pinned",
    "created_at",
    "updated_at",
    "policy_digest",
  ]);
  id(record.id);
  id(record.workspace_id);
  exact(record.source, ["id", "version"]);
  if (
    record.version !== 1 ||
    record.protocol !== "v0.9" ||
    !Number.isSafeInteger(record.revision) ||
    record.revision < 1 ||
    typeof record.title !== "string" ||
    !record.title.trim() ||
    record.title.length > 60 ||
    typeof record.pinned !== "boolean" ||
    Object.values(record.source).some(
      (v) => typeof v !== "string" || !v || v.length > 128,
    ) ||
    !Number.isFinite(Date.parse(record.created_at)) ||
    !Number.isFinite(Date.parse(record.updated_at))
  )
    fail("unavailable", "Invalid saved result metadata");
  validateResult(record.messages, record.user_values);
  if (record.policy_digest !== digest(record))
    fail("unavailable", "Saved result integrity mismatch");
  return record;
}
const metadata = (r) => ({
  id: r.id,
  revision: r.revision,
  title: r.title,
  pinned: r.pinned,
  source: r.source,
  created_at: r.created_at,
  updated_at: r.updated_at,
});

/** Private adjunct, outside workspace layouts/checkpoints. Construction performs no IO. */
export function createInteractiveResults({ root, workspaceRead }) {
  const base = path.resolve(root, "interactive-results");
  let closed = false;
  async function dispatch(body) {
    if (closed) fail("unavailable", "Result service closed");
    exact(
      body,
      ["action", "workspace_id"],
      [
        "id",
        "op_id",
        "expected_revision",
        "title",
        "messages",
        "user_values",
        "source",
        "pinned",
      ],
    );
    const workspace = id(body.workspace_id);
    try {
      if (!(await workspaceRead(workspace)))
        fail("unavailable", "Workspace unavailable");
    } catch {
      fail("unavailable", "Workspace unavailable");
    }
    const shapes = {
      list: [[], []],
      read: [["id"], []],
      create: [
        ["op_id", "title", "messages", "user_values", "source"],
        ["pinned"],
      ],
      update: [
        [
          "id",
          "op_id",
          "expected_revision",
          "title",
          "messages",
          "user_values",
          "source",
          "pinned",
        ],
        [],
      ],
    };
    if (!Object.hasOwn(shapes, body.action))
      fail("invalid_request", "Unknown result operation");
    const shape = shapes[body.action];
    exact(body, ["action", "workspace_id", ...shape[0]], shape[1]);
    if (body.id) id(body.id);
    const dir = path.join(base, workspace),
      file = path.join(dir, "library.json");
    let state;
    function safePath(target, directory = false) {
      try {
        const stat = fs.lstatSync(target);
        if (
          stat.isSymbolicLink() ||
          (directory ? !stat.isDirectory() : !stat.isFile())
        )
          fail("unavailable", "Invalid private result path");
      } catch (e) {
        if (e.code !== "ENOENT") throw e;
      }
    }
    function load() {
      safePath(base, true);
      safePath(dir, true);
      safePath(file);
      try {
        const stat = fs.statSync(file);
        if (stat.size > 64 * 1024 * 1024)
          fail("limit_exceeded", "Library exceeds bound");
        state = JSON.parse(fs.readFileSync(file, "utf8"));
        if (
          state.version !== 1 ||
          !state.documents ||
          !state.receipts ||
          Object.keys(state.documents).length > LIMITS.documents ||
          Object.keys(state.receipts).length > LIMITS.receipts
        )
          fail("unavailable", "Invalid result library");
      } catch (e) {
        if (e.code === "ENOENT")
          state = { version: 1, documents: {}, receipts: {} };
        else throw e;
      }
    }
    if (["list", "read"].includes(body.action)) {
      load();
      for (const record of Object.values(state.documents))
        if (record.workspace_id !== workspace)
          fail("unavailable", "Saved workspace scope mismatch");
      if (body.action === "list")
        return {
          items: Object.values(state.documents)
            .map((r) => metadata(check(r)))
            .sort(
              (a, b) =>
                Number(b.pinned) - Number(a.pinned) ||
                b.updated_at.localeCompare(a.updated_at),
            ),
          workspace_id: workspace,
        };
      const record = state.documents[body.id];
      if (!record) fail("unavailable", "Result not found");
      return { record: check(record) };
    }
    id(body.op_id);
    if (
      typeof body.title !== "string" ||
      !body.title.trim() ||
      body.title.length > 60 ||
      typeof (body.pinned ?? false) !== "boolean"
    )
      fail("invalid_request", "Invalid result title/pin");
    exact(body.source, ["id", "version"]);
    for (const value of Object.values(body.source))
      if (
        typeof value !== "string" ||
        !value ||
        value.length > 128 ||
        /[\u0000-\u001f]/.test(value)
      )
        fail("invalid_request", "Invalid source identity/version");
    validateResult(body.messages, body.user_values);
    safePath(base, true);
    safePath(dir, true);
    safePath(file);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    fs.chmodSync(base, 0o700);
    fs.chmodSync(dir, 0o700);
    const lock = path.join(dir, ".write-lock");
    let lockFd;
    try {
      lockFd = fs.openSync(lock, "wx", 0o600);
    } catch (e) {
      if (e.code === "EEXIST") fail("busy", "Another result write is active");
      throw e;
    }
    let temp;
    try {
      load();
      const requestHash = hash(body),
        receipt = state.receipts[body.op_id];
      if (receipt) {
        if (receipt.hash !== requestHash)
          fail("conflict", "Operation key payload changed");
        return receipt.response;
      }
      if (Object.keys(state.receipts).length >= LIMITS.receipts)
        fail("limit_exceeded", "Result receipt limit reached");
      const previous =
        body.action === "update" ? state.documents[body.id] : undefined;
      if (body.action === "update") {
        if (!previous) fail("unavailable", "Result not found");
        check(previous);
        if (
          !Number.isSafeInteger(body.expected_revision) ||
          previous.revision !== body.expected_revision
        )
          fail("stale_resource", "Saved result changed; reopen before saving");
        if (
          canonical(previous.source) !== canonical(body.source) ||
          body.messages.length < previous.messages.length ||
          canonical(body.messages.slice(0, previous.messages.length)) !==
            canonical(previous.messages)
        )
          fail(
            "conflict",
            "Source version or existing stream changed; import as a new result",
          );
      } else if (Object.keys(state.documents).length >= LIMITS.documents)
        fail("limit_exceeded", "Result library has 128 documents");
      const now = new Date().toISOString();
      const record = {
        version: 1,
        id: previous?.id ?? randomUUID(),
        workspace_id: workspace,
        revision: (previous?.revision ?? 0) + 1,
        title: body.title.trim(),
        protocol: "v0.9",
        messages: body.messages,
        user_values: body.user_values,
        source: body.source,
        pinned: body.pinned ?? false,
        created_at: previous?.created_at ?? now,
        updated_at: now,
      };
      record.policy_digest = digest(record);
      state.documents[record.id] = record;
      // Record and retry receipt commit together: no crash window between them.
      const response = { record };
      state.receipts[body.op_id] = { hash: requestHash, response };
      temp = path.join(dir, "." + randomUUID() + ".tmp");
      const fd = fs.openSync(temp, "wx", 0o600);
      try {
        const bytes = JSON.stringify(state);
        if (Buffer.byteLength(bytes) > 64 * 1024 * 1024)
          fail("limit_exceeded", "Private library exceeds 64 MiB");
        fs.writeFileSync(fd, bytes);
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
      fs.renameSync(temp, file);
      temp = undefined;
      const directory = fs.openSync(dir, "r");
      try {
        fs.fsyncSync(directory);
      } finally {
        fs.closeSync(directory);
      }
      return response;
    } finally {
      if (temp) fs.rmSync(temp, { force: true });
      fs.closeSync(lockFd);
      fs.rmSync(lock, { force: true });
    }
  }
  return {
    dispatch,
    close() {
      closed = true;
    },
  };
}
