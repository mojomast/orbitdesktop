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
  "cache_ttl_ms",
  "cache_stale_ms",
]);
const MAX_CACHE_TTL_MS = 10 * 60 * 1000;
const MAX_CACHE_STALE_MS = 60 * 60 * 1000;
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
    // Optional response cache: a short TTL plus a bounded stale-while-revalidate window.
    if (proxy.cache_ttl_ms !== undefined &&
        (!Number.isSafeInteger(proxy.cache_ttl_ms) || proxy.cache_ttl_ms < 1 || proxy.cache_ttl_ms > MAX_CACHE_TTL_MS)) return null;
    if (proxy.cache_stale_ms !== undefined &&
        (proxy.cache_ttl_ms === undefined || !Number.isSafeInteger(proxy.cache_stale_ms) ||
         proxy.cache_stale_ms < 0 || proxy.cache_stale_ms > MAX_CACHE_STALE_MS)) return null;
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
 * One upstream read. Resolves to `{ status, contentType, body }` for a usable response or
 * `{ error: [status, message] }`; it never rejects. The credential lives only in the request.
 */
async function readUpstream(target, method, headers, proxy) {
  let response;
  try {
    response = await fetch(target, {
      method,
      headers,
      redirect: "manual",
      signal: AbortSignal.timeout(proxy.timeout_ms),
    });
  } catch {
    return { error: [502, "extension upstream unavailable"] };
  }
  if (response.status >= 300 && response.status < 400) {
    try { await response.body?.cancel(); } catch { /* already closed */ }
    return { error: [502, "extension upstream redirect refused"] };
  }
  const contentType = responseContentType(response.headers.get("content-type")) || "application/octet-stream";
  if (method === "HEAD") return { status: response.status, contentType, body: null };
  let body;
  try {
    body = await readLimited(response, proxy.max_response_bytes);
  } catch {
    return { error: [502, "extension upstream unavailable"] };
  }
  if (body === null) return { error: [502, "extension response too large"] };
  return { status: response.status, contentType, body };
}

function sendUpstream(res, result, cacheState) {
  if (result.error) {
    const [status, message] = result.error;
    res.writeHead(status, {
      "Content-Type": "text/plain",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      ...(cacheState ? { "X-Orbit-Cache": cacheState } : {}),
    });
    return res.end(message);
  }
  res.writeHead(result.status, {
    "Content-Type": result.contentType,
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    ...(cacheState ? { "X-Orbit-Cache": cacheState } : {}),
  });
  return result.body === null ? res.end() : res.end(result.body);
}

/**
 * Build the `/api/ext/` handler for validated extension manifests. The owner
 * bearer and browser origin are checked before anything touches an upstream
 * or the cache; only declared proxies, methods, paths and queries are forwarded.
 *
 * A proxy that declares `cache_ttl_ms` keeps the last good (HTTP 200) GET
 * response per path in memory (query-string and HEAD requests are never cached).
 * Within the TTL it is served as-is; for `cache_stale_ms` after that it is served
 * stale while one background refresh runs; beyond that the read waits for the
 * upstream, like an uncached proxy. Concurrent misses share one upstream read, and
 * a read whose client went away still fills the cache. The cache entry holds only
 * the status, content type and body, never a credential.
 */
export function createExtensionProxy({ manifests, token, port, devOrigins = [], env = process.env, now = () => performance.now() } = {}) {
  const byId = new Map(
    (Array.isArray(manifests) ? manifests : []).map(manifest => [manifest.id, manifest]),
  );
  const cache = new Map(); // key -> { at, result }
  const inflight = new Map(); // key -> Promise<result>

  function refresh(key, start) {
    let pending = inflight.get(key);
    if (!pending) {
      pending = start().then(result => {
        if (!result.error && result.status === 200) cache.set(key, { at: now(), result });
        return result;
      }).finally(() => inflight.delete(key));
      inflight.set(key, pending);
    }
    return pending;
  }

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
    const start = () => readUpstream(target, req.method, headers, proxy);

    const cacheable = proxy.cache_ttl_ms !== undefined && req.method === "GET" && !request.hasQuery;
    if (!cacheable) return sendUpstream(res, await start());

    // Keyed by everything that selects the upstream response (the credential is not part of it).
    const key = JSON.stringify([request.id, request.proxy, upstream, requestPath, headers.accept || ""]);
    const entry = cache.get(key);
    const age = entry ? now() - entry.at : Infinity;
    if (age < proxy.cache_ttl_ms) return sendUpstream(res, entry.result, "hit");
    if (age < proxy.cache_ttl_ms + (proxy.cache_stale_ms || 0)) {
      void refresh(key, start);
      return sendUpstream(res, entry.result, "stale");
    }
    return sendUpstream(res, await refresh(key, start), "miss");
  };
}
