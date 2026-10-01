import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { createInteractiveResults } from "../server/interactive-results.mjs";
import {
  validateResult,
  parseMessages,
  CATALOG_ID,
} from "../contracts/interactive-results-v1.mjs";
import { extractInteractiveResult } from "../src/interactive-result-adapter.ts";
const messages = [
  {
    version: "v0.9",
    createSurface: { surfaceId: "main", catalogId: CATALOG_ID },
  },
  {
    version: "v0.9",
    updateComponents: {
      surfaceId: "main",
      components: [
        { id: "root", component: "Column", children: ["text", "field"] },
        { id: "text", component: "Text", text: "Actual protocol" },
        {
          id: "field",
          component: "TextField",
          label: "Notes",
          value: { path: "/notes" },
        },
      ],
    },
  },
  {
    version: "v0.9",
    updateDataModel: { surfaceId: "main", value: { notes: "producer" } },
  },
];
test("closed policy admits protocol; blocks markdown URLs, executable functions, hostile pointers and recursion", () => {
  validateResult(messages, { "/notes": "owner" });
  for (const mutate of [
    (m) => (m[1].updateComponents.components[1].component = "Image"),
    (m) =>
      (m[1].updateComponents.components[1].text =
        "[click](javascript:alert(1))"),
    (m) =>
      (m[1].updateComponents.components[1].text = "[click](https://bad.test)"),
    (m) =>
      (m[1].updateComponents.components[2].value = {
        functionCall: { name: "eval" },
      }),
    (m) => (m[1].updateComponents.components[2].value.path = "/__proto__/x"),
    (m) => (m[1].updateComponents.components[0].children = ["root"]),
    (m) => (m[0].createSurface.theme = { markdownRenderer: "evil" }),
    (m) =>
      (m[1].updateComponents.components[1].action = {
        event: { name: "send" },
      }),
  ]) {
    const copy = structuredClone(messages);
    mutate(copy);
    assert.throws(() => validateResult(copy));
  }
  assert.throws(() => validateResult(messages, { "/missing": "edit" }));
  assert.throws(() => parseMessages("x"));
});
test("text adapter is explicit and producer-neutral", () => {
  assert.equal(
    extractInteractiveResult("ordinary Hermes result").status,
    "unavailable",
  );
  assert.deepEqual(
    extractInteractiveResult(JSON.stringify({ a2ui: messages })).messages,
    messages,
  );
  const fence = "```a2ui\n" + JSON.stringify(messages) + "\n```";
  assert.equal(extractInteractiveResult(fence).status, "ok");
  assert.equal(
    extractInteractiveResult(fence + "\n" + fence).status,
    "unavailable",
  );
  assert.equal(
    extractInteractiveResult("x".repeat(65537)).status,
    "unavailable",
  );
});
test("bounds fail closed before renderer work", () => {
  assert.throws(() => validateResult(Array(257).fill(messages[0])), {
    code: "limit_exceeded",
  });
  const copy = structuredClone(messages);
  copy[2].updateDataModel.value.notes = "x".repeat(16385);
  assert.throws(() => validateResult(copy), { code: "limit_exceeded" });
  let nested = {};
  for (let i = 0; i < 33; i++) nested = { child: nested };
  copy[2].updateDataModel.value = nested;
  assert.throws(() => validateResult(copy), { code: "limit_exceeded" });
  assert.throws(() => parseMessages(" ".repeat(262145)), {
    code: "limit_exceeded",
  });
});
test("private library commits CAS and exact retry receipts; source identity/stream fences and reload", async () => {
  const root = fs.mkdtempSync(path.join("/tmp/opencode", "interactive-store-")),
    workspace = randomUUID();
  const service = createInteractiveResults({
    root,
    workspaceRead: (id) => (id === workspace ? { id } : null),
  });
  const body = {
    action: "create",
    workspace_id: workspace,
    op_id: randomUUID(),
    title: "Comparison",
    messages,
    user_values: { "/notes": "owner" },
    source: { id: "tool-result-1", version: "exact-1" },
    pinned: true,
  };
  try {
    const saved = await service.dispatch(body);
    assert.deepEqual(await service.dispatch(body), saved);
    await assert.rejects(service.dispatch({ ...body, title: "Changed" }), {
      code: "conflict",
    });
    await assert.rejects(
      service.dispatch({ ...body, workspace_id: randomUUID() }),
      { code: "unavailable" },
    );
    await assert.rejects(service.dispatch({ ...body, extra: "injected" }), {
      code: "invalid_request",
    });
    const update = {
      ...body,
      action: "update",
      id: saved.record.id,
      expected_revision: 1,
      op_id: randomUUID(),
      user_values: { "/notes": "independently saved" },
    };
    const newer = await service.dispatch(update);
    assert.equal(newer.record.revision, 2);
    assert.deepEqual(await service.dispatch(update), newer);
    await assert.rejects(service.dispatch({ ...update, op_id: randomUUID() }), {
      code: "stale_resource",
    });
    await assert.rejects(
      service.dispatch({
        ...update,
        op_id: randomUUID(),
        expected_revision: 2,
        source: { id: "other", version: "exact-1" },
      }),
      { code: "conflict" },
    );
    const changed = structuredClone(messages);
    changed[2].updateDataModel.value.notes = "silently changed";
    await assert.rejects(
      service.dispatch({
        ...update,
        op_id: randomUUID(),
        expected_revision: 2,
        messages: changed,
      }),
      { code: "conflict" },
    );
    service.close();
    const reopened = createInteractiveResults({
      root,
      workspaceRead: () => ({}),
    });
    const record = (
      await reopened.dispatch({
        action: "read",
        workspace_id: workspace,
        id: saved.record.id,
      })
    ).record;
    assert.deepEqual(record.messages, messages);
    assert.equal(record.user_values["/notes"], "independently saved");
    const dir = path.join(root, "interactive-results", workspace),
      file = path.join(dir, "library.json");
    assert.equal(fs.statSync(dir).mode & 0o777, 0o700);
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    const state = JSON.parse(fs.readFileSync(file));
    state.documents[record.id].user_values["/notes"] = "tampered";
    fs.writeFileSync(file, JSON.stringify(state));
    await assert.rejects(
      reopened.dispatch({
        action: "read",
        workspace_id: workspace,
        id: record.id,
      }),
      { code: "unavailable" },
    );
    reopened.close();
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
test("independent writers serialize revision CAS, enforce library limit and refuse symlink paths", async () => {
  const root = fs.mkdtempSync(path.join("/tmp/opencode", "interactive-cas-")),
    workspace = randomUUID();
  const make = () =>
    createInteractiveResults({ root, workspaceRead: () => ({}) });
  const a = make(),
    b = make();
  const create = () => ({
    action: "create",
    workspace_id: workspace,
    op_id: randomUUID(),
    title: "Result",
    messages,
    user_values: {},
    source: { id: "source", version: "1" },
    pinned: false,
  });
  try {
    const { record } = await a.dispatch(create());
    const update = {
      ...create(),
      action: "update",
      id: record.id,
      expected_revision: 1,
    };
    const outcomes = await Promise.allSettled([
      a.dispatch({ ...update, op_id: randomUUID() }),
      b.dispatch({ ...update, op_id: randomUUID() }),
    ]);
    assert.equal(outcomes.filter((o) => o.status === "fulfilled").length, 1);
    assert.equal(
      outcomes.find((o) => o.status === "rejected").reason.code,
      "stale_resource",
    );
    for (let i = 1; i < 128; i++) await a.dispatch(create());
    await assert.rejects(a.dispatch(create()), { code: "limit_exceeded" });
    assert.equal(
      (await a.dispatch({ action: "list", workspace_id: workspace })).items
        .length,
      128,
    );
    const file = path.join(
        root,
        "interactive-results",
        workspace,
        "library.json",
      ),
      outside = path.join(root, "external.json");
    fs.renameSync(file, outside);
    fs.symlinkSync(outside, file);
    await assert.rejects(
      a.dispatch({ action: "read", workspace_id: workspace, id: record.id }),
      { code: "unavailable" },
    );
    await assert.rejects(a.dispatch(create()), { code: "unavailable" });
  } finally {
    a.close();
    b.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
