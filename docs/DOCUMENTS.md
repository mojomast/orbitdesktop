# Private documents

The **Document library** (`orbit://surface/documents`) creates independent rich
documents and canvases in an ordinary workspace. It needs the owner host
connection, and has no Workbench/project prerequisite. Existing plain-text
notebooks are independent records and are not migrated.

## Editor and owner workflow

Rich documents use the actual pinned **Lexical 0.52.0** vanilla editor. The
toolbar supports paragraph/heading/quote/code blocks, bold/italic/underline,
inline code, numbered and bullet lists, undo/redo. Native typing, selection,
Enter/Backspace, Markdown shortcuts and keyboard undo remain editor-owned.
Pasting inserts plain text, keeping arbitrary HTML and styles outside the finite
document schema. Canonical export is editor-state JSON; Markdown export derives
from the current editor state, including unsaved edits.

Choose **Save document** explicitly. There is no background autosave. New edits
made while a save is pending remain dirty after that earlier save succeeds. A
conflict retains the draft; **Keep draft on current revision** changes its CAS
base only, then a separate Save explicitly replaces the current revision.
**Reload saved document** requires confirmation before discarding dirty edits.

An uncertain save retains its exact operation ID, revision and body. **Retry
exact save** recovers the original receipt; it does not replace the payload with
later edits or silently create a new operation. Another save and explicit reload
remain disabled until that outcome is resolved. Export is still available.

Drafts and unresolved saves are cached by `(workspace, pane, document)` in private
same-tab `sessionStorage` and memory. They survive reload/conflicts and connected
DOM moves; saved bytes survive a server restart. Recovery does not merge concurrent
edits automatically. Browser storage quota failures are displayed; export the draft
before reloading in that case. Closing a tab or clearing site/session storage can
remove unsaved drafts. An invalid or oversized cached record is never passed to an
editor engine. Session storage contains private document bytes and is accessible
to reviewed same-origin parent code; it is not an encrypted vault.

## Exact routes and integration

`src/document-library.ts` exports:

```ts
mountDocumentLibrary(host, token, options?: {paneId?: string}): {dispose(): void}
```

It dispatches `window` event **`orbit-open-document`**, detail `{id, name}`. The
parent validates the UUID/title and opens `kind: 'browser'` with the standard
window operation. Content, credentials and file paths never enter that event.

`src/document-host.ts` exports:

```ts
documentId(url: string): string | null
documentUrl(id: string): string
mountDocumentHost(host, id, token, {paneId}): {dispose(): void}
```

Only the exact lowercase UUID URL `orbit://document/<uuid>` resolves. Queries,
fragments, extra path components and arbitrary `orbit://` routes do not. A
stable pane preserves the native editor/island across Windows↔Spatial and
focus moves. A real pane close or navigation disposes the editor, requests,
polling and connection listeners. Pending save recovery survives disposal in its
pane cache; a disposed callback cannot repopulate DOM. Two panes viewing one
document have independent drafts and contend through CAS.

## Owner API and authority

`contracts/documents-v1.mjs` is the strict request contract for owner-authenticated
same-origin **POST `/api/documents`**. Generated frames, model/controller callers
and plugins receive no document token or bridge.

| Action | Required selectors and data | Result |
| --- | --- | --- |
| `list` | workspace | bounded metadata and limits; no body |
| `create` | workspace, document UUID, kind, title, op_id, intent | revision metadata; permitted before placement |
| `resolve` | workspace, document, live pane | metadata after exact binding validation |
| `read` | workspace, document, optional pane | body and independent revision |
| `save` | workspace, document, live pane, expected_revision, data, op_id, intent | metadata-only receipt |
| `rename` | same binding/CAS and title, op_id, intent | metadata-only receipt |
| `receipt` | workspace, document, live pane, op_id | `found` and saved revision metadata only |

The owner library may read a document **without a pane** for management/export.
Whenever a pane selector is supplied, including on a receipt replay, it must exist
in the current workspace, be a browser pane, and have the exact document URL.
Saves and rename always require that live binding. UUIDs alone authorize nothing.
All dispatches revalidate workspace existence, including direct service calls.
The existing plugin activation recovery hold does **not** block manual owner
document creation, reads or writes; documents are not plugin activation.

Kinds/formats are immutable: `richtext/lexical` (256 KiB UTF-8 content) or
`scene/excalidraw` (512 KiB). Parsing rejects unknown node/element types, prototype
keys, unsupported styles/binary files, excessive nesting and object counts before
invoking an engine. Limits also include 32 nesting levels, 12,000 visited JSON
values, 2,000 scene elements, 256 documents/workspace, 160-character titles, and
128 retained receipts/document. JSON escaping is covered by a 4 MiB route request
cap. Layout/checkpoint limits remain independent.

CAS failure returns `conflict` and the current `revision`, never current private
body bytes. Successful exact retries are keyed per document by owner operation
UUID and a SHA-256 digest of the entire validated request. Changing body, pane,
revision or intent under the same operation key is refused. Retention of 128
receipts is finite; an evicted old save remains fenced by its stale CAS revision.

## Private persistence and backup

`createDocumentsService({root, workspaceRead})` performs no construction-time IO.
Data is kept under:

```text
<runtime root>/documents/<workspace UUID>/<document UUID>.json
```

Each record contains metadata, body, independent revision and metadata-only
receipt entries. Receipts store operation UUID/digest/result, **not duplicated
content**. Body and receipt commit in one synchronous writer's atomic temp-file,
fsync, rename, directory-fsync operation. Directories use 0700 and files 0600;
symlinks, oversized/corrupt files and filename/record identity mismatches fail
closed. One service writer per root is supported; multiple processes sharing the
same filesystem directory are not a cross-process transactional store.

Include `documents/` in complete **private runtime backups**. It must not enter
static/source archives. No SQLite schema migration is required. Document bytes,
drafts and receipts do not enter v1 layout state, localStorage, checkpoints,
workspace events, Workbench tables, `/apps/` publications or generic workspace
receipts. Restoring a layout changes placement only, not document content. There
is no deletion or automatic data garbage collection in v1; closing a pane leaves
its saved document available in the library.

## Verification

- `node --experimental-strip-types --test tests/documents.test.mjs`: live binding,
  independent docs, CAS races/conflicts, durable metadata-only exact replay after
  restart, malicious bounded JSON, private modes and symlink refusal.
- `tests/documents.browser.py`: real Lexical + full private Node server + real
  desktop, structured editing, JSON/Markdown exports, conflicts, page-reload draft
  recovery, a genuinely committed save with its response dropped, exact retry,
  newer edits retained, connected renderer/focus identity and disposal cleanup.
- `tests/canvas.browser.py`: the same acceptance journey with real Excalidraw
  rectangle/ellipse drawing and local font assets. See [Canvas](CANVAS.md).

Fixtures use disposable source/runtime/HOME/private tmux socket, no terminal
panes or provider calls. The only HTTP interception induces uncertain responses
or delayed binding responses; it does not mock either rendering engine or the
document store. Full combined checks and distribution asset/license packaging
are integration-owned.
