// Shared browser/server admission policy. This is not a replacement A2UI renderer.
export const CATALOG_ID =
  "https://a2ui.org/specification/v0_9/catalogs/basic/catalog.json";
export const ALLOWED_COMPONENTS = Object.freeze([
  "Text",
  "Card",
  "Row",
  "Column",
  "Button",
  "TextField",
  "CheckBox",
  "ChoicePicker",
  "Slider",
  "Divider",
  "List",
  "Tabs",
]);
export const LIMITS = Object.freeze({
  bytes: 262144,
  messages: 256,
  nodes: 2000,
  depth: 32,
  string: 16384,
  documents: 128,
  receipts: 4096,
});
export function fail(code, message, path = "$") {
  const error = new Error(message);
  error.code = code;
  error.path = path;
  throw error;
}
export function canonical(value) {
  if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
  if (value && typeof value === "object")
    return (
      "{" +
      Object.keys(value)
        .sort()
        .map((k) => JSON.stringify(k) + ":" + canonical(value[k]))
        .join(",") +
      "}"
    );
  return JSON.stringify(value);
}
export function exact(value, required, optional = []) {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    required.some((k) => !Object.hasOwn(value, k)) ||
    Object.keys(value).some(
      (k) => !required.includes(k) && !optional.includes(k),
    )
  )
    fail("invalid_request", "Unexpected request fields");
}
export function pointer(value) {
  if (
    typeof value !== "string" ||
    !/^\/(?:[^~]|~[01])*$/.test(value) ||
    value.length > 256 ||
    value
      .split("/")
      .some((p) =>
        ["__proto__", "constructor", "prototype"].includes(
          p.replace(/~1/g, "/").replace(/~0/g, "~"),
        ),
      )
  )
    fail("invalid_request", "Invalid absolute data path");
  return value;
}
export function validateResult(messages, userValues = {}) {
  let nodes = 0;
  function walk(v, path, depth) {
    if (++nodes > LIMITS.nodes || depth > LIMITS.depth)
      fail("limit_exceeded", "Result is too complex", path);
    if (typeof v === "string") {
      if (v.length > LIMITS.string)
        fail("limit_exceeded", "Text is too long", path);
      // Ban URL schemes even embedded in markdown; no renderer is configured for markdown.
      if (
        /(?:[a-z][a-z0-9+.-]*:\/\/|javascript\s*:|data\s*:|vbscript\s*:)/i.test(
          v,
        ) &&
        !(
          /^\$\.messages\.\d+\.createSurface\.catalogId$/.test(path) &&
          v === CATALOG_ID
        )
      )
        fail("invalid_request", "URLs are not allowed in result data", path);
    } else if (v && typeof v === "object") {
      for (const [k, x] of Object.entries(v)) {
        if (
          [
            "__proto__",
            "constructor",
            "prototype",
            "functionCall",
            "call",
            "expression",
            "checks",
            "validationRegexp",
            "markdown",
            "markdownRenderer",
            "html",
            "style",
            "theme",
            "catalog",
            "catalogs",
          ].includes(k)
        )
          fail(
            "invalid_request",
            "Executable/custom content is not allowed",
            path + "." + k,
          );
        if (k === "path") pointer(x);
        walk(x, path + "." + k, depth + 1);
      }
    } else if (v !== null && !["boolean", "number"].includes(typeof v))
      fail("invalid_request", "Invalid data", path);
    if (typeof v === "number" && !Number.isFinite(v))
      fail("invalid_request", "Invalid number", path);
  }
  if (
    !Array.isArray(messages) ||
    !messages.length ||
    messages.length > LIMITS.messages
  )
    fail("limit_exceeded", "Expected 1–256 messages");
  walk(messages, "$.messages", 0);
  walk(userValues, "$.userValues", 0);
  if (
    new TextEncoder().encode(canonical({ messages, userValues })).length >
    LIMITS.bytes
  )
    fail("limit_exceeded", "Result exceeds 256 KiB");
  const components = new Map();
  let surfaceId;
  for (const [i, m] of messages.entries()) {
    const path = "$.messages[" + i + "]";
    const kind = [
      "createSurface",
      "updateComponents",
      "updateDataModel",
    ].filter((k) => Object.hasOwn(m, k));
    if (m.version !== "v0.9" || kind.length !== 1)
      fail(
        "invalid_request",
        "Only A2UI v0.9 create/update messages are supported",
        path,
      );
    exact(m, ["version", kind[0]]);
    const payload = m[kind[0]];
    if (kind[0] === "createSurface") {
      exact(payload, ["surfaceId", "catalogId"]);
      if (
        surfaceId ||
        payload.catalogId !== CATALOG_ID ||
        typeof payload.surfaceId !== "string" ||
        !/^[a-zA-Z0-9_-]{1,80}$/.test(payload.surfaceId)
      )
        fail("invalid_request", "Expected one reviewed-catalog surface", path);
      surfaceId = payload.surfaceId;
    } else {
      if (!surfaceId || payload.surfaceId !== surfaceId)
        fail("invalid_request", "Surface identity changed", path);
      if (kind[0] === "updateDataModel") {
        exact(payload, ["surfaceId"], ["path", "value"]);
        if (payload.path !== undefined) pointer(payload.path);
      } else {
        exact(payload, ["surfaceId", "components"]);
        if (
          !Array.isArray(payload.components) ||
          !payload.components.length ||
          payload.components.length > 128
        )
          fail("limit_exceeded", "Invalid component batch", path);
        for (const c of payload.components) {
          if (
            !c ||
            !ALLOWED_COMPONENTS.includes(c.component) ||
            typeof c.id !== "string" ||
            !/^[a-zA-Z0-9_-]{1,80}$/.test(c.id)
          )
            fail(
              "invalid_request",
              "Component is outside the reviewed catalog",
              path,
            );
          if (Object.hasOwn(c, "catalogId"))
            fail(
              "invalid_request",
              "Component catalog injection is forbidden",
              path,
            );
          if (c.action) {
            exact(c.action, ["event"]);
            exact(c.action.event, ["name"], ["context"]);
            if (c.action.event.name !== "prepare_summary")
              fail("invalid_request", "Unknown action", path);
          }
          if (
            ["TextField", "CheckBox", "ChoicePicker", "Slider"].includes(
              c.component,
            )
          ) {
            exact(c.value, ["path"]);
            pointer(c.value.path);
          }
          components.set(c.id, c);
        }
      }
    }
  }
  if (!components.has("root"))
    fail("invalid_request", "Result requires a root component");
  // Static child lists only: finite tree, no recursive/dynamic templates.
  let visits = 0;
  function visit(id, ancestors) {
    if (++visits > LIMITS.nodes || ancestors.size > LIMITS.depth)
      fail("limit_exceeded", "Component tree exceeds render bounds");
    if (ancestors.has(id)) fail("invalid_request", "Cyclic component tree");
    const c = components.get(id);
    if (!c) fail("invalid_request", "Missing child component");
    const next = new Set(ancestors);
    next.add(id);
    const children = [
      ...(c.child ? [c.child] : []),
      ...(c.children || []),
      ...(c.tabs || []).map((t) => t.child),
    ];
    if (!Array.isArray(c.children || []) || children.length > 128)
      fail("invalid_request", "Only static children are supported");
    for (const child of children) {
      if (typeof child !== "string")
        fail("invalid_request", "Only static children are supported");
      visit(child, next);
    }
  }
  visit("root", new Set());
  exact(userValues, [], Object.keys(userValues));
  const bindings = new Set(
    [...components.values()]
      .filter((c) =>
        ["TextField", "CheckBox", "ChoicePicker", "Slider"].includes(
          c.component,
        ),
      )
      .map((c) => c.value.path),
  );
  for (const [path, value] of Object.entries(userValues)) {
    pointer(path);
    if (
      !bindings.has(path) ||
      !(
        typeof value === "string" ||
        typeof value === "boolean" ||
        typeof value === "number" ||
        (Array.isArray(value) &&
          value.length <= 128 &&
          value.every((x) => typeof x === "string"))
      )
    )
      fail("invalid_request", "Invalid saved user field", path);
  }
  return { surfaceId, components, bindings };
}

export function parseMessages(text) {
  if (
    typeof text !== "string" ||
    new TextEncoder().encode(text).length > LIMITS.bytes
  )
    fail("limit_exceeded", "Import exceeds 256 KiB");
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    try {
      value = text
        .trim()
        .split(/\r?\n/)
        .map((line) => JSON.parse(line));
    } catch {
      fail("invalid_request", "Expected JSON or one JSON message per line");
    }
  }
  const messages = Array.isArray(value)
    ? value
    : value?.a2ui
      ? Array.isArray(value.a2ui)
        ? value.a2ui
        : [value.a2ui]
      : [value];
  validateResult(messages);
  return messages;
}
