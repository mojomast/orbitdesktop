# Docking placement persistence

Status: implemented adjunct persistence for the **opt-in** `?renderer=docking`
renderer. It is still not the default renderer, grants no new permission and
does not change the v1 layout schema. The default workspace renderer remains
behaviorally unchanged.

This document is the cross-cutting design. See
[optional docking](OPTIONAL_DOCKING.md) for the renderer UX and
[workspace store](WORKSPACE_STORE.md) for SQLite schema/backup operations.

## What is persisted

A per-workspace **adjunct placement record** (`version: 1`) describing only
Windows/docking placement. It references stable v1 **window** ids (the
`monitors[].id` values). It never contains pane ids, runtime handles,
callbacks, terminal buffers or arbitrary Dockview JSON.

```jsonc
{
  "version": 1,
  "layout": null | { "type": "group", "windows": ["<window-id>", "..."], "active": "<optional-group-tab-id>" }
                 | { "type": "branch", "direction": "horizontal" | "vertical",
                     "ratio": 0.05..0.95,
                     "first": <node>, "second": <node> },
  "floats": [ { "windows": ["<window-id>"], "active": "<optional-group-tab-id>", "frame": { "x": 0, "y": 0, "width": 600, "height": 420 } } ],
  "active": null | "<window-id>"
}
```

Facts:

- Placement is stored **separately** from `record.state` on the server, with its
  own `placement` field and a `placement_revision` marker (the workspace
  revision at which placement last changed). It is never merged into the v1
  `Workspace` object.
- v1 pane identity is untouched. `src/docking-placement.ts` deliberately stores
  window ids only; a placement change can never destroy, rename or reconnect a
  pane or terminal.
- Missing windows are **pruned** group/tree/float members on save and on
  restore; empty groups/branches and empty floats collapse away. Newly added v1
  windows are simply absent, so they default to the ordinary docked
  arrangement.
- The default renderer ignores and preserves the adjunct. It never
  reads it; whole-state `sync` never writes it, so a default renderer cannot
  strip a saved arrangement.

## Validation

`src/docking-placement.ts` is the single strict validator shared by the browser
and the node server (imported by `server/sqlite-workspace-store.mjs` through
`node --experimental-strip-types`, the same way the store imports
`src/model.ts`). It rejects:

- unknown fields at every level (no arbitrary/extra parameters);
- unsupported versions and node types;
- empty/duplicate window ids within a group, a float and across the whole record;
- more than 100 distinct windows, more than 100 floats, tree depth beyond 32;
- non-finite or out-of-bounds float geometry (`x/y` 0–10000, `width` 80–10000,
  `height` 60–10000) and branch ratios outside 0.05–0.95;
- per-group active tabs that are not members of their group;
- references to a window id that is not part of the current v1 workspace.

The JSON Schema (`contracts/workspace-v1.mjs` → generated
`contracts/workspace-v1.json`) enforces the structural portion first in
`server/workspace-contract.mjs`; the semantic bounds above run again in the
store transaction. Unknown fields are rejected, not stripped.

Each binary branch has an explicit axis; it does **not** have to alternate with
depth. Dockview's n-ary siblings are folded into a balanced same-axis binary tree
and flattened back to the same collinear arrangement. Alternating axes while
folding would incorrectly turn three columns into an L shape. Independent active
tabs survive in every group, not just the globally focused group. Ratios are
normalized to nine decimal places to avoid floating-point save feedback.

Regression tests cover three-column geometry through a real served reload,
independent group active tabs, a 100-window conversion without excessive binary
depth, pruning nested branches, and queued gestures arriving during an in-flight
save. The last case drains after the current save rather than silently waiting
for another user gesture.

## Server persistence

- SQLite schema advanced to **4**. Opening a schema 3 database upgrades it
  transactionally under the single writer: it adds `placement_json` to
  `checkpoints` and `revisions`, and backfills the workspace record's
  `placement` to the canonical empty placement with `placement_revision = 0`.
  Old checkpoints therefore restore **empty** placement, never a stale current
  arrangement.
- Older binaries refuse schema 4 at startup (`UPGRADE_REQUIRED`); no
  mixed-version writers are supported. Back up and stop writers before cutover.
- The additive command `placement_save`
  (`{workspace_id, action, base_revision, placement, operation_id, intent}`) uses
  the **same workspace revision CAS and durable receipt machinery** as `sync` /
  `apply` / `restore`. An identical retry returns the recorded result while the
  policy generation is unchanged; a changed payload with a reused operation id
  fails `IDEMPOTENCY_CONFLICT`; a stale `base_revision` fails
  `REVISION_CONFLICT` (read and reconsider). The actor is assigned by the server
  (`owner` or `workspace-controller:<workspace-id>`), never accepted from the
  request. Browser and controller routes share the existing
  authentication/permission checks; the recovery route cannot call it. A
  placement-only change advances the shared revision, so layout and placement
  cannot race with independent counters and lost writes.
- Because placement shares the workspace revision, `observed_revision` /
  `browser_seen` acknowledgement keeps its usual meaning: acknowledgement is
  synchronization, not proof the arrangement rendered.
- Checkpoints copy the **pre-change** placement (like state). Restoring a
  checkpoint restores its state *and* its placement, including through the
  owner-only recovery console. `server/workspace.mjs` `restore` reads the
  checkpoint placement and commits it in the same revision-checked transaction;
  a missing/legacy checkpoint placement restores empty.
- `backup` (SQLite backup API) and `restore` (schema 1–4) carry the adjunct.
  `export-legacy` writes the adjunct inside the record/checkpoint JSON, but old
  binaries and old readers do not understand it; rolling back to such a reader
  loses the arrangement. Keep backups and treat legacy export as an archive, not
  a continuous fallback.

## Client sync

- `src/docking-sync.ts` owns an explicit state machine: unhydrated → hydrate →
  active.
  - **Hydrate** applies the first authoritative snapshot's placement exactly
    once and records its `placement_revision`. It never saves.
  - **Local** changes (drag, autotab, sash resize, float move/resize) are
    debounced and sent through `placement_save` using the workspace-sync
    revision CAS. They are ignored while unhydrated, so a default arrangement is
    never autosaved over a persisted one during initial connect/reload/import.
  - **Remote** changes apply with placement emission suppressed (no feedback
    loop). If a remote placement arrives over unsaved local changes, the conflict
    is shown explicitly rather than silently discarded. A `REVISION_CONFLICT`
    triggers a re-read and a visible conflict status; the UI never claims a save
    that did not commit.
- `src/workspace-sync.ts` carries `placement` / `placement_revision` in
  snapshots and exposes `savePlacement`, serialized with the existing sync loop
  (no concurrent lost writes). Placement saves do not increment the v1 change
  counter.
- Placement saving is ON whenever the docking renderer is enabled. The renderer
  itself remains opt-in through the local URL `?renderer=docking`; nothing
  auto-enables it.
- If no server/token is available, docking still works transiently but cannot
  claim persistence; the sync layer reports the unsaved/uncertain state instead
  of pretending a server save happened.

## Recovery console

`public/recovery.js` shows a saved-placement summary from the ordinary read
snapshot (`N docked groups, M floats, active window, placement revision`) and
restore continues to work without loading Dockview, so recovery does not depend
on the optional renderer or the main page.

## Limitations

- Tailnet networking is **optional and deferred to Hermes per-user**; there is
  no runtime tailnet requirement, and remote acceptance is not claimed here.
- This is a single-owner experiment, not a permission boundary. It is not a
  normalized multi-user surface model.
- Hidden docking tabs hold their last live geometry; only the visible panel is
  fit precisely. A floating window that internally hosts a nested multi-group
  grid is flattened to one float group by design.
- A full page reload reattaches the same tmux shell (detached shell survives)
  but iframe documents are expected to be fresh; placement persistence does not
  preserve iframe document state across a real navigation.
- Measured on Chromium only; no Firefox/WebKit guarantee, no cross-document
  iframe preservation and no accessibility certification.
- The adjunct is a layout convenience, not application/external-effect state;
  it does not persist terminal buffers, conversations, app bytes or grants.

## Verification

Measured on this checkout; see [optional docking](OPTIONAL_DOCKING.md) and
[workspace store](WORKSPACE_STORE.md) for the exact commands. Summary of what
the checks cover:

- strict-invalid/duplicate/depth/stale-reference and prune unit tests, plus a
  Dockview↔adjunct conversion round-trip (ratios, floats, active) that does not
  import `dockview-core`;
- schema 3→4 migration (old checkpoints backfilled to empty, idempotent reopen),
  checkpoint placement round-trip, CAS/receipt conflict behavior, and
  `backup`→`restore` schema 4 retention;
- a real, isolated served-Chromium `?renderer=docking` run against a disposable
  runtime (fresh token/workspace/private tmux socket) that groups and floats a
  window, confirms the server persisted the adjunct, reloads, and checks the
  arrangement/geometry was restored and the tmux shell continued.
