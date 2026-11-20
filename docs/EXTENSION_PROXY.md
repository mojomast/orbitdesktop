# Extension proxy

`/api/ext/` is the generic, owner-authenticated route that lets an installed
extension reach a loopback service declared in its own manifest. It replaces
per-feature hard-coded proxies one at a time. The Orbit Hive host and the
Observatory pane's trusted host (`src/observatory-host.ts`) read the collector
snapshot through this proxy. The old unauthenticated `/obs-snapshot` route has
been removed (it now returns 404).

## Route shape

```
/api/ext/<extension-id>/<proxy-name><declared-path>[?query]
```

For the Observatory that is:

```
/api/ext/rizzstack-observatory/snapshot/snapshot
```

The extension id and proxy name are matched exactly against loaded manifests.
A declared path is forwarded byte-for-byte; the proxy never rewrites a request
into an undeclared one.

## Manifest

Manifests live at `extensions/<extension-id>/orbit-extension.json` and are
loaded once at startup. The Observatory manifest is
`extensions/rizzstack-observatory/orbit-extension.json`.

Top-level fields: `id`, `title`, `version`, `proxies`. Each entry in `proxies`
declares:

| Field | Meaning |
| --- | --- |
| `upstream_env` | Environment variable holding the upstream origin (may be absent) |
| `default_upstream` | Loopback default used when `upstream_env` is unset |
| `token_env` | Environment variable holding the server-side upstream credential |
| `methods` | Allowed methods, restricted to `GET` and `HEAD` |
| `paths` | Exact forwarded paths, each starting with `/` |
| `allow_query` | Whether a query string may be forwarded |
| `max_response_bytes` | Response body ceiling |
| `timeout_ms` | Upstream fetch timeout |
| `cache_ttl_ms` | Optional. Serve the last good response from memory for this long (1 ms–10 min) |
| `cache_stale_ms` | Optional, needs `cache_ttl_ms`. After the TTL, serve it stale for this long while one background refresh runs (0–60 min) |

Validation is strict. Ids and proxy names must match
`/^[a-z0-9][a-z0-9-]{0,62}$/`, the manifest id must equal its directory name,
methods may only be `GET`/`HEAD`, paths must be exact strings beginning with
`/`, and unknown keys reject the manifest. An invalid manifest is skipped with
one warning naming its file; values are never echoed because they may contain
operator configuration.

## Response cache (optional)

A slow upstream can opt into a small in-memory cache. The Observatory collector
computes each snapshot on request (including live CI reads) in about 10 s, which
is the same as the Hive host's read deadline, so the Observatory manifest sets
`cache_ttl_ms: 15000` and `cache_stale_ms: 120000`.

- Only `GET` requests without a query string, answered with HTTP 200, are cached.
  Errors, redirects, oversize bodies, `HEAD` and query requests always go to the
  upstream and are never stored.
- Within the TTL the cached body is served (`X-Orbit-Cache: hit`). For the stale
  window after that it is served immediately (`stale`) while **one** background
  refresh runs; a failed refresh keeps the last good entry. Past the stale window
  the read waits for the upstream like an uncached proxy (`miss`), so an
  unavailable upstream is reported, not hidden.
- Concurrent misses share one upstream read, and a read whose client gave up
  still fills the cache for the next reader.
- Owner authentication and origin checks run before the cache is consulted. The
  entry stores only status, content type and body (never a credential), and
  responses stay `Cache-Control: no-store`. The snapshot document carries its own
  observation times, so a stale copy is labeled by its content.
- The cache is per Orbit process and is empty after a restart; the first read
  after a restart, or after the stale window has lapsed, is a full upstream read.

## Authentication and headers

Every proxied request requires both:

- the Orbit owner bearer token (`Authorization: Bearer …`), checked with
  `tokenMatches`, and
- a request accepted by `allowedRequest` for the Orbit origin.

Both are checked before the upstream is contacted. The browser's
`Authorization`, `Cookie` and every other header are dropped. Only the
server-side credential from `token_env` is sent upstream as
`Authorization: Bearer …`, plus the client's `Accept` header when present.
Responses never carry `Access-Control-*` or `Set-Cookie`; they are marked
`Cache-Control: no-store` and `X-Content-Type-Options: nosniff`.

The same-origin-GET exception in `allowedRequest` covers `GET`/`HEAD` requests
whose path starts with `/api/ext/` under the same conditions as the read-only
evidence route: no `Origin` header, `sec-fetch-site: same-origin`, and a
`Referer` whose origin is allowed and whose host equals `Host`. The one
exception is a `Referer` origin that is exactly `ORBIT_PUBLIC_ORIGIN`: a reverse
or framing proxy in front of Orbit rewrites `Host` to the loopback upstream, so
that origin may differ from `Host`. The owner bearer is still required.

## Fail-closed rules

- Unknown extension id or proxy name → `404`.
- Missing or wrong owner token, or a disallowed origin → `403`.
- Method not declared for the proxy → `405`.
- A path containing `%`, `..`, `//`, a backslash or a control character, or
  any path not declared exactly → `404`.
- A query when `allow_query` is false, or longer than 2048 characters → `404`.
- An upstream that is not `http:` loopback (`127.0.0.1`, `::1`, `localhost`),
  has credentials, or has a path other than `/` → `503`.
- A missing upstream credential → `503`.
- An upstream `3xx`, network error, timeout, or response over
  `max_response_bytes` → `502`.

Redirects are never followed. Only `application/json`, `text/plain` and
`text/html` upstream content types are preserved; everything else is served as
`application/octet-stream`.

## Migration

Done. The Hive host and the Observatory pane host use
`/api/ext/rizzstack-observatory/snapshot/snapshot` with the owner bearer.
`/obs-snapshot` and `serveObsSnapshot` were removed after the proxy was
verified against the live collector (loopback and public origin). The
Observatory pane is a sandboxed catalog app and never holds a credential: when
Orbit opens the exact reviewed entry (`OBSERVATORY_ENTRY`), it pairs over a
private MessagePort and the trusted host performs the authenticated read
(`tests/cleanup-obs3-retire-legacy.test.mjs`).
