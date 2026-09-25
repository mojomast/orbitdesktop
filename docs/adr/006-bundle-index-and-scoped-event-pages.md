# ADR 006: Indexed bundles and finite scoped event pages

Status: implemented; evidence and remaining gates are in ORBIT_EVOLUTION_HANDOFF.md.

## Decisions

1. Advance database schema to 3 without changing the layout or manifest format.
   Bundle metadata belongs to the authoritative workspace database, not a second
   Python-written database. Publication invokes a local Node refresh only when the
   runtime already has a compatible initialized store.
2. Keep file scanning explicit at startup/refresh. Normal workspace reads return
   indexed versions. New or newly activated relative hash references require a valid
   index entry; existing broken refs do not block unrelated recovery. This is not
   continuous filesystem verification: hash-addressed serving separately checks the
   exact bytes returned against per-file digests.
3. Retain references from current records, every retained revision and checkpoints.
   Inventory is dry-run only. Do not ship destructive cleanup until final reference
   checking, publication, active serving and filesystem rename/deletion have a reviewed
   coordination protocol. A candidate is not permission to delete.
4. Deliver existing atomic outbox metadata as finite authenticated POST pages, scoped
   before query limit. Keep a bounded replay horizon and explicit reset response.
   Use in-memory browser cursors and coalesced sync hints; preserve ordinary polling.
   This avoids server subscription queues and bearer credentials in EventSource URLs.
   SSE/push is not required to prove durable replay and is not claimed here.

## Boundaries

Hashes identify content, not a trusted publisher. Legacy folders are unverified.
Absolute URLs can conservatively retain local slugs but are not verified as remote
content. SQLite backup does not include app bytes. Old writers must stop before schema
upgrade; already-open legacy connections cannot be fenced retroactively by startup
version checks. Neither event delivery nor acknowledgements prove rendered success,
and callbacks must not execute metadata as instructions. Browser cache/frame/PTY
continuity and permission revocation remain separate product gates.
