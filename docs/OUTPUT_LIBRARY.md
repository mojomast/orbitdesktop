# Published output library

The Outputs surface (`orbit://surface/outputs`) lists deliberately published app
folders and files from the private runtime `apps` directory. This round adds
owner-visible aliases, pins, tags, search, type filtering and a bounded
"send a reference to the conversation" action. It does not move, rename or
rewrite any published file.

## What is indexed

`server/workspace.mjs` keeps its existing `shelf` action and bounded scan (up to
100 app folders / 300 files). The Outputs view fetches those entries unchanged.
Nothing is indexed automatically from elsewhere, and no owner files outside the
published `apps` tree are exposed.

## Durable owner metadata

`server/output-library.mjs` is a separate, owner-only service mounted at
`/api/output-library`. It stores only three owner fields per published file:

- `alias` — a display name shown in the library and in references;
- `pinned` — a boolean that floats the item to the top and enables Pinned-only;
- `tags` — up to 12 bounded labels.

It never stores or serves file bytes, private paths or credentials. A record's
`url` is the same public `/apps/...` path already returned by the shelf action.

Storage is one small private JSON file per workspace at
`<runtime>/output-library/<workspace_id>.json` (mode `0600`). Writes use a
random temp file, `fsync`, atomic `rename` and directory `fsync`; the file,
directory and destination are refused if they are symlinks. This is deliberately
**not** a SQLite schema migration: the primary workspace store, layout,
checkpoints, revisions and bundle registry are untouched. Metadata is bounded to
500 items, 256 KiB per file and is validated on every read; a corrupt or
unexpected file fails closed rather than being reset.

### Revision compare-and-swap

Every committed change increments a per-workspace `revision`. A `set` request
carries the `base_revision` the client last saw. A stale value is rejected with
HTTP 409 and the current revision plus records, so the browser keeps the owner's
draft and can retry explicitly against the fresh revision. Aliases, pins and
tags are therefore last-writer-explicit, never a silent overwrite.

Content-addressed publication slugs include a 24-hex content hash. Metadata is
keyed by the **exact canonical resource path**
(`/apps/<full content-addressed slug>/<relative>`), so each published release is
its own immutable resource. Multiple releases of the same logical app are listed
concurrently and are distinct rows: an alias, pin or tag set on an older report
never silently attaches to a changed report, and a republish does not inherit the
old release's metadata. There is deliberately **no logical-id migration**: the
service does not rewrite or reinterpret older keys, and an unrecognized stored
shape fails closed. Metadata never modifies bundle/artifact bytes; an alias is not
a rename. A legacy, non-content-addressed path retains its existing mutability;
library metadata does not make that file immutable.

The request schema has no `operation_id`/`intent` fields and the service does not
claim request-id idempotency: every `set` is a fresh compare-and-swap.

Stored records are validated strictly and returned as a copy of known fields.
Unexpected field types or a mismatched item identity fail closed (`unavailable`)
rather than being silently repaired or coerced. When `workspaceRead` is not
supplied, `store.read` is used with its `this` binding preserved.

## Route contract

`POST /api/output-library` with the owner `Bearer` token, an allowed Origin and
one of two strictly validated, unknown-property-rejecting bodies:

```json
{"action":"list","workspace_id":"<uuid>"}
{"action":"set","workspace_id":"<uuid>","url":"/apps/<slug>/<file>","base_revision":0,"patch":{"alias":"Name","pinned":true,"tags":["draft"]}}
```

`set.patch` requires at least one field; `alias: null` clears an alias; `tags`
replaces the list. The workspace must already exist
(`workspaceRead`/`store.read`); the service never creates a workspace. Requests
are bounded to 32 KiB and responses to 512 KiB (including the snapshot and changed
item); the persisted metadata file remains limited to 256 KiB.

## Search and filtering

The browser filters the joined shelf entries case-insensitively across display
title, published title, alias, tags and URL, plus a type filter
(`all` / `app/report` / `output`) and a Pinned-only toggle. The chosen filter is
kept in this browser's local storage. All untrusted text (titles, aliases, tags,
workspace-supplied strings) is assigned with `textContent`; no library field is
ever interpreted as HTML.

## Preview and sandbox

Preview is unchanged: the published file opens in an `<iframe sandbox="allow-scripts
allow-forms allow-downloads">` inside a modal, with a plain download link. The
library grants no host permission bridge, no token to the frame, and never
exposes the runtime filesystem path.

## Conversation references

**Send to conversation** calls
`requestConversationContext({text, title?, source?})` from
`src/conversation-transfer.ts` (owned by the context-handoff round; see
[CONTEXT_HANDOFF.md](CONTEXT_HANDOFF.md)). The text is a bounded (~600 character)
human-readable reference containing the display title, public URL, kind and
tags. It explicitly states that file contents were not fetched. Nothing is sent
automatically: the helper opens a host dialog where the owner must choose one
registered, available conversation and press **Insert into draft**. The status
line reports the returned outcome (inserted, cancelled, no recipient, rejected
or stale). No URL is fetched and no model run is started by the transfer.

## Provenance limitation

No verified conversation or task provenance exists for published files. The
library therefore **omits** any source link rather than guessing one, and shows
this limitation next to the list. Opening the source pane is not offered; the
Preview action opens the output itself. A future round may add server-derived
provenance only when it can be verified.

## Verification

- `tests/output-library.test.mjs` covers the shared helpers (exact immutable
  resource ids, raw-segment decode/URL hardening, filtering, bounded references)
  and the real metadata service (authorization, strict schemas, CAS conflicts,
  persistence across restart, bounds, atomic private files, `store.read`
  binding, revision-overflow and strict stored-shape failure).
- `tests/output-library.browser.py` runs the real Vite renderer with a mocked
  shelf response and the **real** metadata service over HTTP. It checks reload
  persistence, exact-resource keying across a republish, search/type/pin
  filtering, `textContent` rendering of a malicious title, CAS conflict drafts,
  duplicate-save suppression, late-save-after-disposal, the sandboxed preview
  and the real conversation-transfer dialog.

Metadata is per-workspace and per-host-runtime. Authorized browsers opening the
same workspace read the same saved metadata; Refresh retrieves another browser's
changes. Metadata is not replicated to other host runtimes, exported in workspace
checkpoints, or included in the v1 layout. Include `output-library/` in a complete
stopped-writer runtime backup; a workspace SQLite backup alone does not include it.
