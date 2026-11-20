import fs from "node:fs";
import path from "node:path";
import { tokenMatches, allowedRequest } from "./security.mjs";

const ROUTE_PREFIX = "/api/ext/";
const NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,62}$/;
const ENV_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
const ROOT_KEYS = new Set(["id", "title", "version", "proxies"]);
const PROXY_KEYS = new Set([
  "upstream_env",
  "default_upstream",
  "token_env",
  "methods",
  "paths",
  "allow_query",
  "max_response_bytes",
  "timeout_ms",
]);
const ALLOWED_METHODS = new Set(["GET", "HEAD"]);
const ALLOWED_CONTENT_TYPES = new Set([
  "application/json",
  "text/plain",
  "text/html",
]);
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "::1", "localhost"]);
const CONTROL_CHARACTERS = /[\x00-\x1f\x7f]/;

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasOnlyKeys(value, allowed) {
  return Object.keys(value).every(key => allowed.has(key));
}

function validEnvName(value) {
  return typeof value === "string" && ENV_NAME_PATTERN.test(value);
}

function validateManifest(raw, directoryName) {
  if (!isPlainObject(raw) || !hasOnlyKeys(raw, ROOT_KEYS)) return null;
  if (typeof raw.id !== "string" || !NAME_PATTERN.test(raw.id)) return null;
  if (raw.id !== directoryName) return null;
  if (typeof raw.title !== "string" || raw.title.length === 0 || raw.title.length > 200) return null;
  if (!Number.isInteger(raw.version) || raw.version < 1) return null;
  if (!isPlainObject(raw.proxies) || Object.keys(raw.proxies).length === 0) return null;

  const proxies = {};
  for (const [name, proxy] of Object.entries(raw.proxies)) {
    if (!NAME_PATTERN.test(name)) return null;
    if (!isPlainObject(proxy) || !hasOnlyKeys(proxy, PROXY_KEYS)) return null;
    if (!validEnvName(proxy.upstream_env) || !validEnvName(proxy.token_env)) return null;
    if (typeof proxy.default_upstream !== "string" || proxy.default_upstream.length === 0) return null;
    if (!Array.isArray(proxy.methods) || proxy.methods.length === 0) return null;
    if (!proxy.methods.every(method => ALLOWED_METHODS.has(method))) return null;
    if (!Array.isArray(proxy.paths) || proxy.paths.length === 0) return null;
    if (!proxy.paths.every(value => typeof value === "string" && value.startsWith("/"))) return null;
    if (typeof proxy.allow_query !== "boolean") return null;
    if (!Number.isSafeInteger(proxy.max_response_bytes) || proxy.max_response_bytes < 1 || proxy.max_response_bytes > 64 * 1024 * 1024) return null;
    if (!Number.isSafeInteger(proxy.timeout_ms) || proxy.timeout_ms < 1 || proxy.timeout_ms > 120000) return null;
    proxies[name] = {
      ...proxy,
      methods: [...new Set(proxy.methods)],
      paths: [...new Set(proxy.paths)],
    };
  }

  return { id: raw.id, title: raw.title, version: raw.version, proxies };
}

/**
 * Read and strictly validate every `extensions/<id>/orbit-extension.json` under
 * `dir`. An invalid manifest is skipped with one warning naming its file; file
 * contents (which may contain operator configuration) are never echoed.
 */
export function loadExtensionManifests(dir) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }

  const manifests = [];
  const ordered = [...entries].sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of ordered) {
    if (!entry.isDirectory()) continue;
    const file = path.join(dir, entry.name, "orbit-extension.json");
    let raw;
    try {
      raw = JSON.parse(fs.readFileSync(file, "utf8"));
    } catch (error) {
      if (error && error.code !== "ENOENT") {
        console.warn(`Ignoring invalid extension manifest ${file}`);
      }
      continue;
    }
    const manifest = validateManifest(raw, entry.name);
    if (!manifest) {
      console.warn(`Ignoring invalid extension manifest ${file}`);
      continue;
    }
    manifests.push(manifest);
  }
  return manifests;
}

function parseExtensionRequest(rawUrl) {
  if (typeof rawUrl !== "string" || !rawUrl.startsWith(ROUTE_PREFIX)) return null;
  const queryIndex = rawUrl.indexOf("?");
  const rawPath = queryIndex === -1 ? rawUrl : rawUrl.slice(0, queryIndex);
  const query = queryIndex === -1 ? "" : rawUrl.slice(queryIndex + 1);
  const remainder = rawPath.slice(ROUTE_PREFIX.length);

  const idEnd = remainder.indexOf("/");
  if (idEnd <= 0) return null;
  const id = remainder.slice(0, idEnd);
  const tail = remainder.slice(idEnd + 1);

  const proxyEnd = tail.indexOf("/");
  if (proxyEnd <= 0) return null;
  const proxy = tail.slice(0, proxyEnd);
  const requestPath = tail.slice(proxyEnd);

  return { id, proxy, path: requestPath, query, hasQuery: queryIndex !== -1 };
}

function parseUpstream(value) {
  if (typeof value !== "string" || value.length === 0) return null;
  let url;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== "http:") return null;
  if (url.username || url.password) return null;
  if (url.pathname !== "/" || url.search || url.hash) return null;
  const hostname = url.hostname.replace(/^\[|\]$/g, "");
  if (!LOOPBACK_HOSTS.has(hostname)) return null;
  return url.origin;
}

function sendText(res, status, message) {
  res.writeHead(status, {
    "Content-Type": "text/plain",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  });
  res.end(message);
}

function responseContentType(value) {
  if (typeof value !== "string") return null;
  const mediaType = value.split(";")[0].trim().toLowerCase();
  return ALLOWED_CONTENT_TYPES.has(mediaType) ? value : null;
}

async function readLimited(response, limit) {
  if (!response.body) return Buffer.alloc(0);
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > limit) {
        try { await reader.cancel(); } catch { /* already closed */ }
        return null;
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock?.();
  }
  return Buffer.concat(chunks, total);
}

/**
 * Build the `/api/ext/` handler for validated extension manifests. The owner
 * bearer and browser origin are checked before anything touches an upstream;
 * only declared proxies, methods, paths and queries are forwarded.
 */
export function createExtensionProxy({ manifests, token, port, devOrigins = [], env = process.env } = {}) {
  const byId = new Map(
    (Array.isArray(manifests) ? manifests : []).map(manifest => [manifest.id, manifest]),
  );

  return async function extensionProxy(req, res) {
    const request = parseExtensionRequest(req.url);
    if (!request) return sendText(res, 404, "Not found");

    const manifest = byId.get(request.id);
    const proxy = manifest?.proxies?.[request.proxy];
    if (!manifest || !proxy) return sendText(res, 404, "Not found");

    const suppliedToken = String(req.headers.authorization || "").replace(/^Bearer /, "");
    if (!tokenMatches(suppliedToken, token) || !allowedRequest(req, port, devOrigins)) {
      return sendText(res, 403, "Forbidden");
    }

    if (!proxy.methods.includes(req.method)) return sendText(res, 405, "Method not allowed");

    const requestPath = request.path;
    if (
      requestPath.includes("%") ||
      requestPath.includes("..") ||
      requestPath.includes("//") ||
      requestPath.includes("\\") ||
      CONTROL_CHARACTERS.test(requestPath)
    ) {
      return sendText(res, 404, "Not found");
    }
    if (!proxy.paths.includes(requestPath)) return sendText(res, 404, "Not found");

    if (request.hasQuery && (!proxy.allow_query || request.query.length > 2048)) {
      return sendText(res, 404, "Not found");
    }

    const upstream = parseUpstream(env?.[proxy.upstream_env] || proxy.default_upstream);
    if (!upstream) return sendText(res, 503, "extension upstream not allowed");

    const credential = env?.[proxy.token_env];
    if (typeof credential !== "string" || credential.length === 0) {
      return sendText(res, 503, "extension proxy not configured");
    }

    const target = upstream + requestPath + (request.hasQuery ? `?${request.query}` : "");
    const headers = { authorization: `Bearer ${credential}` };
    if (typeof req.headers.accept === "string" && req.headers.accept.length > 0) {
      headers.accept = req.headers.accept;
    }

    let response;
    try {
      response = await fetch(target, {
        method: req.method,
        headers,
        redirect: "manual",
        signal: AbortSignal.timeout(proxy.timeout_ms),
      });
    } catch {
      return sendText(res, 502, "extension upstream unavailable");
    }

    if (response.status >= 300 && response.status < 400) {
      try { await response.body?.cancel(); } catch { /* already closed */ }
      return sendText(res, 502, "extension upstream redirect refused");
    }

    const responseHeaders = {
      "Content-Type": responseContentType(response.headers.get("content-type")) || "application/octet-stream",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    };

    if (req.method === "HEAD") {
      res.writeHead(response.status, responseHeaders);
      return res.end();
    }

    let body;
    try {
      body = await readLimited(response, proxy.max_response_bytes);
    } catch {
      return sendText(res, 502, "extension upstream unavailable");
    }
    if (body === null) return sendText(res, 502, "extension response too large");

    res.writeHead(response.status, responseHeaders);
    return res.end(body);
  };
}
