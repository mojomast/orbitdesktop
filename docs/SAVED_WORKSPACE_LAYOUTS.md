# Saved workspace layouts

Named presets save existing-window geometry, order, selected window, Windows/Spatial
view and validated Docking placement. They never save pane content, URLs, split
trees, plugins, shell commands, capabilities or conversation drafts. Applying a
preset preserves current window and pane identities and contents; it does not
create or close anything. Font sizes, names, appearance, sidebar state and other
current settings remain current. Spatial camera/arc are not captured.

## Owner interface

The host export is `showSavedWorkspaceLayouts(token, viewport)` from
`src/saved-workspace-layouts.ts`. Both arguments are callbacks: credentials remain
host-owned and viewport measurements remain current. The dialog supports save,
list, rename, delete and read-only preview before applying. Preview reports missing
stable window IDs and provides explicit replacement selectors. Existing stable IDs
always bind first; names are display labels, never matching heuristics. Missing
windows block apply until every missing ID has an explicit, distinct current target.

The default arranger keeps its existing accessible names and classes. Docking Grid
and Compare use the new pure placement compiler; Focus keeps the existing select-only
operation. Grid/Compare commit geometry and Docking placement together.

## Server integration and request shapes

`createWorkspaceLayouts({store, token, port, devOrigins, reply, root})` returns
`.handle(req,res)` and a trusted `.dispatch(body)` testing interface. Mount the
handler at `/api/workspace-layouts`. Requests are owner-only POSTs with the existing
Bearer token and allowed Host/Origin checks; there is no controller or generated
frame route. Bodies are bounded to 128 KiB with finite strict action field lists.
Every request includes `workspace_id` and `action`:

| Action | Other fields |
| --- | --- |
| `list` | none |
| `capture` | `name`, `viewport`, `base_revision` |
| `rename` | `layout_id`, `name` |
| `delete` | `layout_id` |
| `preview` | `layout_id`, `viewport`, optional `replacements` |
| `arrange_preview` | `window_ids`, `mode` (`grid`/`compare`), `columns`, `viewport`, `base_revision` |
| `apply` | `layout`, `viewport`, `replacements`, `base_revision`, `operation_id`, `intent` |

`viewport` is `{width,height}`. `replacements` maps missing saved IDs to explicit
current IDs. Preview returns the layout definition, current-base candidate state,
placement, missing IDs, bindings and measured viewport. Preview never writes workspace
state or a checkpoint. Candidate metadata is not a rendered app preview.

Apply carries the exact layout definition rather than depending on the continued
existence of the named catalog entry. The finite compiler merges only geometry,
matched order slots, view and selection into the current state after receipt lookup
and revision CAS. Unmatched windows retain geometry/order; unrelated placement
groups/floats are retained, and matched saved placement is combined with them.
Frames scale to the measured desktop with contract bounds/minimums. Too-small
viewports and invalid grids fail closed. New revision, both state and placement,
pre-change checkpoint, receipt and event use one synchronous `store.commit`.
Recovery-generation replay fencing, activation hold and Studio revocation checks
remain in that existing transaction. This never restores an old whole workspace.

## Durability and uncertain outcomes

Definitions live in `root/saved-workspace-layouts/<workspace UUID>.json`, outside
the primary database schema. Catalogs allow 32 presets, 100 windows per preset,
80-character names and 1 MiB per workspace file. Directories use 0700, files 0600;
file type/symlink checks precede reads. Writes use private temporary files, fsync,
atomic rename and directory fsync. Include this private directory in a stopped-writer
runtime backup; SQLite-only backup does not include definitions. Catalog writes are
synchronous single-service operations; separate concurrent catalog writers are not
supported.

Before apply, the UI retains and verifies the exact finite payload in workspace-scoped
sessionStorage. Unknown outcomes retain that payload through close/reopen/reload.
Retry never regenerates an operation ID or changes viewport or mappings. Catalog
rename/delete does not invalidate an existing apply receipt. Workspace changes
reject unseen stale commands; recovery-generation changes fence old receipts.
Close and Escape remain available during requests. Late responses cannot initiate
another apply. Cleanup compares the returned command's operation/workspace identity
and canonical complete envelope before clearing storage. Late response X cannot clear
a newer retained Y after close/reopen/discard. Explicit discard captures its envelope
before the state read and compares again immediately before removal. A mismatch is
reported and current storage remains intact. Explicit discard requires reading authoritative state and does not
roll back or prove the earlier outcome. Storage corruption/unavailability blocks
dispatch rather than issuing an unretained mutation.

## Focused verification

```sh
node --experimental-strip-types --test tests/saved-workspace-layouts.test.mjs \
  tests/workspace-arrange-plan.test.mjs tests/workspace-arrange-pending.test.mjs
PLAYWRIGHT_BROWSERS_PATH=/tmp/opencode/orbit-evolution-browsers \
  /tmp/opencode/orbit-evolution-browser-venv/bin/python \
  tests/saved-workspace-layouts.browser.py --renderer default
# Repeat the browser command with --renderer docking.
```

The real-server browser fixture builds only a disposable source copy and uses a fresh
runtime, HOME, token and workspace. It checks read-only preview, lost-response exact
replay across reopen/reload, and connected iframe element/document plus draft
continuity before reload. Reload creates fresh documents. Docking additionally checks
an atomic Compare commit through the real placement renderer. No provider or owner
runtime is contacted. Browser evidence is Chromium-specific.
