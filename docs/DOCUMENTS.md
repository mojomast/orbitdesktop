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

### Close and recover

Closing a document pane/window through the shell offers **Save and close**,
**Keep editing**, or **Retain draft and close**. Save-and-close refuses to close
when the outcome is unknown, a conflict occurs, or newer edits remain. An
unresolved save can be retained, but is never labelled saved. Failed recovery
storage blocks deliberate retain-and-close; export while the pane is still open.
Remote layout replacement/disposal still retains the cache without pretending
that a local close dialog can veto a server workspace operation.
This also applies to **Close pane** inside a split window. After the asynchronous
review, the shell rechecks the original monitor, pane signature and mounted view.
Moving, replacing or rebinding the pane while review is open invalidates that
close approval rather than closing the replacement view.

Open **Document library → Recoverable drafts · this browser tab** (or Refresh
documents if the library was already open). Each entry identifies the document,
original pane UUID, base revision, and unknown-save status. Recovery restores the
original pane identity: this is necessary for exact-save receipt replay. A normal
saved-document reopen may create a new pane; recovering the older pane does not
overwrite that new pane or merge its edits. Two divergent drafts stay separate.
If the original UUID is occupied by a different surface, recovery refuses rather
than replacing it. Recovery remains same-tab storage, not a server draft archive.

### Reviewed imports, results and co-editing

The library's **Review new document from content** accepts plain text, finite
Markdown, canonical Lexical JSON and supported `.excalidraw` JSON. Existing panes
offer **Import / review replacement**, including an owner-picked file. Validation
precedes engine admission. Markdown is converted using the pinned Lexical
transformers and then the same document validator; HTML imports are rejected.
Unknown nodes, binary files and unsupported canvas fonts remain rejected.

Review shows both whole snapshots as literal structured content, including scene
element identities and properties. **Apply reviewed draft** changes only the
editor draft. It does not Save. New-content creation first receipts an empty
document and retains the reviewed content in the original-pane cache; opening
the editor and saving its body are distinct operations. **Before dispatch**, both
reviewed-content creation and the ordinary empty-document Create action retain
their exact request and content in a private same-tab creation journal. Storage
failure refuses dispatch. An unknown response preserves that journal across page
reload; it never licenses a new document UUID or operation ID for a retry.

After reload, open **Document library → Pending document creations · exact
recovery**. Review the retained snapshot and choose **Apply reviewed draft** to
replay the exact original creation. A committed creation returns its original
receipt; a request that never reached the server creates that same reserved
document. The original pane UUID and reviewed bytes become a recoverable unsaved
draft. Existing newer pane drafts and pending saves are preserved. Only after
draft recovery storage succeeds is the creation journal cleared. Save of the body
remains explicit. A stale CAS base against a document subsequently saved elsewhere
uses the ordinary retained-draft conflict flow.

Cancelling an uncertain creation leaves its journal discoverable; cancellation
does not imply rollback of the empty server document. A window-capacity failure
leaves the imported draft available for recovery. A source invalidated **after**
dispatch likewise leaves the committed draft recoverable without opening it into
the changed source context.

Journal keys are `orbit.document-create.v1:<workspace UUID>:<operation UUID>`.
Each version-1 envelope binds that workspace, an original pane UUID, the complete
immutable create request (document UUID, operation UUID, kind, title, intent), and
validated document data. The envelope is capped at **4 MiB UTF-8 after JSON
serialization**, including escaping, with **8 unresolved entries per workspace**.
Existing richtext/scene body limits still apply. Reads validate key/envelope scope
and reject unknown fields, malformed content and mismatched kinds. Reusing an
operation key with changed bytes is refused; cleanup compares the retained exact
envelope before removal. Credentials and source callbacks are never stored.
Browser session quota may be lower than the aggregate bound. These are private
same-origin sessionStorage records, not durable server snapshots: tab closure or
clearing storage can remove them. Resolve outstanding creations before capacity
is exhausted. A reload recovery is a fresh explicit owner review of retained
bytes, not resurrection of the original conversation's source authority.

The trusted producer seam is `requestDocumentFromResult(completeReply, isCurrent?)` in
`src/document-artifacts.ts`. It accepts exactly this sole-key JSON object, optionally
inside one whole-reply `orbit-document` fence:

```json
{"document":{"title":"Report","kind":"richtext","format":"lexical","content":"<serialized editor-state JSON>"}}
```

Canvas uses `kind: "scene"`, `format: "excalidraw"`. Prose around the envelope,
unsupported schemas and oversized inputs are refused. Up to eight independent
parent-memory reviews can be outstanding; deliveries never overwrite a singleton
pending slot. The returned acknowledgement is `created-draft`, `cancelled`, or
`rejected`; `created-draft` includes document/pane IDs and means record creation
plus draft retention, **not editor visibility or a saved imported body**. The
shell event is trusted-parent-only, not a generated-frame capability. Newly
completed Normal replies and available completed Workbench results expose a
**Create document from result** action when this exact adapter accepts them.
No model is invoked by review or creation.
Normal and Workbench callers supply a live source-binding predicate covering their
recipient/result and credential identity. It is checked after lazy module loading,
before review and again at the final mutation boundary after workspace flushing.
Changing recipient, disposing the source or changing credentials before dispatch
refuses creation. The predicate is parent-memory-only and is not a capability or
a request field sent to the document server.

**Share selected content** captures the native Lexical text selection or selected
Excalidraw elements. Its literal text includes document/pane IDs, base revision,
draft SHA-256 and a saved-base/unsaved snapshot label. Only the selected content
is included; no whole-document read is implied. Select fewer items if the complete
payload with provenance exceeds 20,000 characters. The existing recipient review
inserts into one chosen conversation draft and never sends a turn. This is a fixed
captured excerpt, not a live selection that changes while the transfer is open.

A proposed whole-document replacement can be imported using **proposal** format:

```json
{"base_revision":2,"base_digest":"<SHA-256 of exact current draft content>","data":{"kind":"richtext","format":"lexical","content":"<replacement editor-state JSON>"}}
```

The proposal must match both saved base revision and current draft digest.
Applying rechecks the live saved revision, exact draft and local edit generation.
Typing, drawing, Undo, reload, rebase or Save while review is open invalidates it;
unresolved saves block replacement. Save still performs authoritative server CAS,
so another pane saving after the review check produces the normal retained-draft
conflict. Accepted replacements use native editor history, not load/reset history.
Lexical runtime node keys are not durable serialized IDs: this first version does
whole-snapshot replacement, not invented key-addressed block patches. The store
retains only the current body and bounded receipts, not historical revision bodies.

## Exact routes and integration

`src/document-library.ts` exports:

```ts
mountDocumentLibrary(host, token, options?: {paneId?: string}): {dispose(): void}
```

It dispatches `window` event **`orbit-open-document`**, detail `{id, name, paneId?}`. The
parent validates the UUID/title and opens `kind: 'browser'` with the standard
window operation. Optional `paneId` restores the exact original recovery identity.
Content, credentials and file paths never enter that event.

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
## Agent-created new briefs

An explicitly granted dedicated local resource adapter can atomically create a
new rich-text document with content and a receipt. This authority does not include
library reads or edits to existing documents. Results distinguish saved from opened
and browser acknowledgement. See [Resource delegation](RESOURCE_DELEGATION.md).
