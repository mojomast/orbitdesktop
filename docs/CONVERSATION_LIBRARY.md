# Conversation library and private drafts

The agent’s **History → Conversation library**, **Conversation settings →
Conversation library**, and shell Conversation library entry browse the configured
Hermes profiles. Search matches loaded upstream titles, Orbit display titles and
session IDs. Pages contain at most 100 upstream entries; **Load more** requests the
next page. This is not transcript/full-content search. Unsupported upstream catalogs
show saved Orbit metadata with an explicit unavailable notice.

**Rename**, **Pin**, and **Archive** are durable, workspace-scoped Orbit metadata.
They do not rename, delete, archive or otherwise mutate Hermes sessions. Archived
entries are hidden until **Show archived** is checked. **Open here** follows the
existing owner-authenticated `select_session` path: upstream session metadata and
bounded history must validate, the pane binding revision must match, and active or
unresolved runs block selection. **New window** requests a new pane from the shell
and selects through the same path after that pane links. Selection failures retain
the original conversation and draft.

## Drafts

Draft identity is `(workspace_id, profile_id, session_id)`, shared across panes and
devices using that exact identity. Drafts are not tied to layout checkpoints and
are never queued or sent merely because they were restored. The composer saves
after a 500 ms debounce using server revision CAS. Ordinary successful sends and
accepted guidance clear only the matching composer text; edits made while a send
is pending are preserved. Draft requests carry their captured conversation identity,
and delayed replies cannot overwrite another binding’s composer.

Each pane has its own namespaced tab recovery cache containing text, the last host
revision/base and whether local changes remain unsaved. Two panes using the same
host conversation can retain different conflicting local drafts. Existing
pane/session draft text takes precedence over the older scope-only recovery key;
that older key is copied as a fallback and is never deleted or changed by migration.
Within one mounted controller, returning X → Y → X reuses X's entry and pending
request, so an older response cannot replace a newer recovery entry. If both the
host and tab changed, the composer keeps the local text and shows
both copies. **Use host draft** restores the reviewed host copy; **Keep my draft**
attempts a CAS against the reviewed host revision. A subsequent concurrent change
can conflict again. Metadata-only revision changes retry without treating unchanged
host draft text as a conflict.

Disposal clears every draft debounce/retry timer and allows at most one final
keepalive write for the active, already-known idle CAS. Pending responses after
disposal cannot update caches/DOM or schedule more requests. Closing/reloading
attempts a keepalive save; normal debounce saves establish
host durability before close. Browsers impose their own keepalive byte budget
(often about 64 KiB), so large drafts must finish their ordinary save before closing
the tab. An outage or abrupt close before a save completes can leave recovery only
in that tab’s cache. The UI reports host-save failure explicitly and retries on
host synchronization. Host-saved drafts survive tab closure and service restart.

Context transfer uses the trusted `registerConversationRecipient` registry, described
in [Context handoff](CONTEXT_HANDOFF.md). Each pane registration captures its exact
binding and is disposed/replaced when that binding changes. After recipient choice,
chat previews the complete appended draft, preserving existing text. Confirmation
checks both the captured binding and original draft again, then appends and saves
normally. It never sends a turn or switches a conversation.

## Private API and persistence

All actions use `POST /api/agent`, existing exact origin/host validation and Orbit
bearer authentication, request byte limits and `Cache-Control: no-store`.
These actions run before requiring an existing pane/session binding, but require
an authoritative existing workspace and a configured profile:

| Action | Request fields beyond `action` | Response |
| --- | --- | --- |
| `conversation_library` | `workspace_id`, `profile_id`, optional `offset` (0–10000) | `conversations`, `supported`, `has_more`, explanatory `note` |
| `draft_read` | workspace/profile/session identity | `record` including draft and revision |
| `draft_write` | identity, `expected_revision`, `text` (≤100,000 characters) | `record`, `conflict` |
| `conversation_metadata` | identity, `expected_revision`, `patch` | public metadata `record`, `conflict` |

Metadata patch keys are limited to `title` (≤200 characters, no control characters),
`pinned` and `archived` (booleans). Unknown fields are rejected. CAS conflicts return
HTTP 409 with `conflict: true` and the current record; metadata responses and library
lists omit draft text. No transcripts are duplicated in this store.

`server/conversation-private-store.mjs` stores SHA-256-keyed JSON records under
`<supplied runtimeDirectory>/conversation-private/`, bounded to 2048 records and
512,000 bytes each. Directory/file permissions are 0700/0600. Writes use exclusive
temporary files, file fsync, atomic rename and directory fsync. Synchronous CAS
assumes one Orbit service writer for this runtime, matching the private submission
journal pattern. The store does not change the primary database schema, layout,
checkpoints or metadata events. Runtime backups contain private draft text and
display metadata.

## Shell interface

`showConversationLibrary(getToken: () => string, targetPaneId?: string)` is exported
from `src/conversation-library.ts`. A missing target disables **Open here**.

- `orbit-open-conversation-library` detail `{paneId}` opens the matching pane’s library.
- Library **Open here** dispatches `orbit-select-conversation` detail
  `{paneId, profileId, sessionId}`. Chat waits for initial binding readiness, then
  invokes existing validated selection; it does not assign state directly.
- **New window** dispatches `orbit-open-conversation` detail `{profileId, sessionId}`.
  The shell creates a pane and sends the targeted selection event.

These are trusted parent-page interfaces, not generated-frame bridges.

## Focused verification

`node --experimental-strip-types --test tests/conversation-library.test.mjs`
uses real isolated HTTP servers and fake Hermes metadata/history, verifies origin/
token/scope checks, request bounds, CAS rejection, restart durability, omission of
draft/transcript content from catalogs and validated selection fences.

`tests/conversation-library.browser.py` runs isolated Vite development sources and a separate full Orbit server,
runtime, browser context and fake Hermes server. It exercises title/ID search,
rename/pin/archive/reopen, close-tab draft restoration, concurrent draft conflicts,
explicit conflict resolution and delayed draft reads during a binding switch. It
also verifies owner edits made before unlocking are preserved, rename CAS retains
typed text, New window performs validated binding without changing the original
pane, two same-scope panes retain distinct conflicting recovery copies after reload,
X → Y → X defers reads/writes without duplicate entries, disposal fences timer
rescheduling, and scope-only migration is copy-only. The shell selected-context
flow previews, appends and durably saves without an upstream turn. It
asserts there are no browser page errors or upstream mutation calls. No live owner
runtime or inference provider is involved. Installed gateway catalog support still
depends on that gateway’s actual API deployment.
