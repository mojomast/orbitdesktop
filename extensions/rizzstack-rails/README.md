# Rizzstack Rails in Orbit

Connect the Orbit host, choose **Rizzstack Rails** in Start or the command palette,
enter a public attempt, job, campaign, session, or event ID, and choose **Inspect**.
Alternatively, choose **Rails** beside an attempt or job in [Observatory](../rizzstack-observatory/README.md).
The row preselects the ID; the shell waits for Inspect before reading. Close Rails
to return focus to that row. No ID or snapshot schema extension is required on
rows that do not support drill-down.

The signed-in shell reads the bounded `rizzstack.rails-view/1` projection. Select
a timeline mark (or use the event table) to inspect its origin event, evidence
references and available timing. The shell fetches its safe event detail by ID.
**Next page** follows a snapshot cursor; **Latest** returns to the first page.
Source freshness, partial coverage, unchecked integrity, a failed tool and a
verifier's acceptance evidence are different observations. Neither a green mark
nor a successful HTTP response establishes product acceptance.

## Authority and configuration

Orbit's `/api/rizzstack/rails/` prefix accepts owner-authenticated GETs only for
`health`, `events`, `view`, `stream`, and `feedback/export`. The shell uses its
in-memory host credential. The proxy checks Orbit's Host/Origin policy (including
browser-supplied same-origin Fetch Metadata for GET without Origin). It reads a
distinct private, regular credential file and connects to one server-configured
numeric loopback port. A browser cannot choose a backend or supply its credential.
Reader configuration for an independently authorized installation:

| Orbit server setting | Meaning |
|---|---|
| `ORBIT_RAILS_PORT` | Port of the R12 service on IPv4 loopback |
| `ORBIT_RAILS_READ_TOKEN_FILE` | Absolute path to its private reader file (owner-only permissions) |

See the [R12 service contract](../../contrib/rails_server/README.md) for the
separate ledger/reader configuration. Without it the shell reports unavailable.
GETs do not initialize, ingest, retry or attach to a terminal. The existing
`/obs-snapshot` collector proxy is **not** the Rails authorization boundary.

The reviewed static timeline is served directly from release source at
`/rails-pane/index.html` in an opaque, scripts-only frame with `connect-src 'none'`.
A document-bound channel carries only the validated projection and mark selection.
Runtime/catalog apps cannot become this renderer by choosing its slug. Observatory
frames may request navigation and receive a close notification, never owner data
or credentials. A standalone copy of the Rails static bundle published with ID
`rizzstack-rails` offers **Open Rails in Orbit** to open an empty shell chooser;
opening it outside Orbit explains the host requirement. It does not display
fixture data on failure.

Only the shell can preview a quality rating. Typed prose appears as `[redacted]`
in its review and is never posted. This read-service revision has no authenticated
owner feedback writer or verified fenced queue submission attachment. An authorized
POST for `feedback` or `interventions` returns `503 capability_unavailable`;
append is not exposed. There is no optimistic success, automatic retry, or direct
rewind. A draft is discarded on close or target change.

## Reproduction

Use Node 22.12+ with Orbit dependencies, Python 3 and an installed Playwright
Chromium (`CHROMIUM_EXECUTABLE` may name a compatible local browser).

```
node --test tests/rails-ui.test.mjs tests/rails-proxy.test.mjs tests/rails-feedback.test.mjs
python3 tests/rails-live.browser.py
```

The browser fixture builds to scratch, opens a new profile and boots disposable
Orbit and R12 servers with synthetic credentials and ledger records. It checks
owner refusal, frame isolation, selected event identity, stream invalidation,
reader restart/revocation and focus restoration. This proves local integration,
not production proxy configuration or Windows worker coverage.
