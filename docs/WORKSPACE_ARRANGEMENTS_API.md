# Workspace arrangements API (v1)

Status: implemented on the owner-authenticated Workbench workflow route and the
Normal-controller arrangement adapter. Layout state remains v1; proposals and
saved recipes are additive SQLite schema 9 tables, never layout/checkpoint
content. No frontend is specified here; this is the frozen server surface.

## Factory

```js
import {createWorkspaceArrangements} from './server/workspace-arrangements.mjs';
const arrangements = createWorkspaceArrangements({store, records, data, now});
await arrangements.dispatch(body, {actor}); // actor defaults to 'owner'
```

- `store` — `SqliteWorkspaceStore` (required).
- `records` — `WorkbenchStore` (required).
- `data` — `WorkbenchData` (optional); constructed internally when omitted so the
  Normal-controller adapter can call `createWorkspaceArrangements({store,records})`.
- `now` — clock injection for tests.

`dispatch` returns an object or throws an `Error` carrying `code`
(`invalid_request`, `permission_denied`, `expired`, `stale_resource`,
`conflict`, `unsupported`, `limit_exceeded`, `busy`, `unavailable`). Scope is
always `{workspace_id, project_id}` and the actor is assigned by the
authenticated route, never by a model.

## Identity, authority and durability

- **Operation identity.** A commit command hashes the exact `proposal_id`,
  `preview_digest`, `recipe`, `project_id`, staged `operations`, `base_revision`
  and `viewport` in addition to the workspace and `op_id`. Two distinct
  proposals with identical operations can never collide on one receipt.
- **Actor scope.** The committing actor is persisted as `committed_actor`, and
  the unique operation index is `(workspace_id, project_id, op_id,
  committed_actor)`. Receipt replay (`byOp`) is actor-scoped, so a receipt is
  never replayed across actors. A single-owner deployment may preview as one
  actor and commit as another, but that commit creates its own receipt.
- **In-transaction revalidation.** `recipe_apply` revalidates project generation,
  recovery-policy generation, full binding identity (including each resource's
  generation), the proposal's current status/revision and the saved-recipe
  revision inside `store.commit`'s synchronous `authorize` callback — under the
  same `BEGIN IMMEDIATE` transaction and *before* the receipt lookup. Nothing
  that protects correctness relies on a read taken outside the transaction.
- **Atomic commit.** Committed metadata (`status`, `op_id`, `committed_actor`,
  `committed_intent`, `committed_revision`, `committed_viewport`,
  `return_checkpoint_id`) is written from inside the commit response callback;
  state, checkpoint and receipt roll back together if it fails.
- **Recipe save receipts.** `recipe_save` is a layout-only mutation that never
  uses `store.commit`. It runs one `IMMEDIATE` SQLite transaction: current
  project auth, a read of the append-only `wb_recipe_receipts` row keyed
  `(workspace_id, actor, op_id)`, the recipe create/update, and the receipt
  insert. The receipt stores the canonical full normalized request hash and the
  original result, so an exact retry after later edits returns the original
  version/result, a changed `expected_version`/name/intent/project payload on the
  same key is `conflict`, and a different actor key is independent. A failure
  anywhere rolls back the recipe and the receipt together.
- **Coherent preview.** `recipe_preview` compiles and persists the staged
  proposal inside one `IMMEDIATE` transaction, so the snapshot cannot straddle
  another connection's write.
- **Receipt-first retry.** `op_id` is resolved before expiry/base checks and
  replays the durable receipt (`idempotent:true`). Expiry is rechecked under the
  acquired write lock in `authorize`. A changed payload on the same key is
  `conflict`; a different key for a committed proposal is `stale_resource` and
  never reapplies.

## Actions

### `recipe_list`

Request: `{action:'recipe_list', workspace_id, project_id}`

Response includes every recipe visible in the workspace (reusable across the
workspace's projects), the *target project's* live bindings, and capabilities:

```json
{
  "recipes": [{"id":"…","project_id":"<source>","version":2,"name":"Files first","roles":["project_files"],"layout":"prioritize","renderer":"windows"}],
  "bindings": [{"id":"…","resource_id":"…","pane_id":"…","role":"project_files","resource_generation":1}],
  "capabilities": {
    "roles": ["primary_agent","active_terminal","preview","candidate_diff","project_files"],
    "layouts": ["prioritize","columns","rows"],
    "renderers": ["windows","spatial","docking"],
    "max_recipes": 32, "max_proposals": 200, "max_recipe_receipts": 512, "ttl_ms": 60000,
    "measured_geometry": false, "portable_constraints_only": true,
    "cross_project_recipes": true,
    "retention": "Committed proposals and their receipts are retained for the project lifetime; expired uncommitted previews may be pruned. No committed receipt is deleted."
  }
}
```

`version` is the record CAS revision. `project_id` is the owning (source)
project; recipes are compiled against the target project's bindings.

### `recipe_save`

Request:
`{action:'recipe_save', workspace_id, project_id, name, roles:string[], layout:'prioritize'|'columns'|'rows', renderer:'windows'|'spatial'|'docking', recipe_id?, expected_version?, op_id, intent?}`

- Create when `recipe_id` is absent; update when present (requires
  `expected_version`). Updates must target the **owning (source) project**: a
  different `project_id` is `stale_resource`, so cross-project reuse is
  preview-only and edit scope stays with the source.
- Only portable constraints are stored: name, roles, layout and renderer — never
  UUIDs or project content. `roles` is a unique subset of the five portable
  roles; names are unique across the workspace.
- **Lost-response safety.** The required `op_id` lets an exact retry reconcile from the
  append-only receipt and returns the original version/result even after later
  edits (`idempotent:true`); a changed `name`/`roles`/`layout`/`renderer`/
  `recipe_id`/`expected_version`/`intent`/`project_id` on the same key is
  `conflict`. Missing keys are rejected before mutation. This is a new API,
  so there is no unreceipted legacy-save path.
- Duplicate name → `conflict`; stale `expected_version` → `stale_resource`; over
  `max_recipes` or a full receipt table → `limit_exceeded`.
  Retained recipes in revoked source projects still count toward the workspace
  budget and reserve their names; revocation never deletes their definitions.

### `recipe_preview`

Request (base): `{action:'recipe_preview', workspace_id, project_id, recipe:'project_focus'|'investigate'|'implement'|'review'|'return'}`

Optional extensions: `recipe_id` (a recipe from any project in the same
workspace, compiled here against this project's bindings), `role_choices`
(`{role: binding_id}`), `renderer`, `width`, `height`.

Behaviour:

- Built-in `review` requires a measured `width`/`height`, a unique bound
  `orbit://workbench-review` window and a `primary_agent` anchor. Built-in
  `investigate`/`implement` refuse an ambiguous role (multiple bindings) with
  `conflict` rather than silently ordering one.
- A saved recipe resolves its roles against the target's live bindings: an
  explicit choice must name a real binding of that role; a choice for a role the
  recipe does not use is `invalid_request`; ambiguity without a choice is
  `conflict`; zero candidates — or a binding whose pane no longer exists — is
  reported in `unbound`. No binding is ever created.
- `layout:'prioritize'` reorders only. `layout:'columns'` / `'rows'` emit
  distinct measured shapes: `columns` prefers one row of columns and narrows
  toward stacked rows until the minimum frame width fits; `rows` prefers one
  column and shortens until the minimum height fits. When the measured viewport
  cannot hold the bound windows at the minimum frame size, `geometry` is
  `"deferred"` and the warning says so.
- `renderer:'windows'` writes measured window frames. `renderer:'docking'`
  writes the same measured frames as Docking floats for the chosen windows only,
  preserving unrelated groups/floats exactly. `renderer:'spatial'` supports
  `prioritize` only; `columns`/`rows` are refused `unsupported`.
- `recipe:'return'` compiles an inverse proposal whose operation is the exact
  normalized `set_workspace` restore of the checkpoint captured by the most
  recent committed non-return proposal. It requires the current revision to equal
  that proposal's `committed_revision`; any intervening edit is `stale_resource`.
  The phantom `restore_review_arrangement` label no longer exists.

Response:

```json
{
  "preview_id": "…", "preview_digest": "…", "expires_at": 0, "base_revision": 7,
  "operations": [{"action":"reorder_windows","window_ids":["…"]}],
  "changed": true,
  "semantic_diff": [{"kind":"order","summary":"Window order changed"}],
  "unbound": [], "role_choices": {"project_files":"…"},
  "roles": ["project_files"], "layout": "prioritize", "renderer": "windows",
  "recipe_id": null, "recipe_project_id": null, "geometry": "none",
  "viewport": null, "rendered": false, "tested": false, "warning": "…"
}
```

`preview_id` is the durable proposal record ID. The measured `viewport` and
`renderer` are part of the preview identity/digest and are persisted; two
previews of the same recipe at different viewports have different digests.
`semantic_diff` entries are `{kind, summary, window_id?}` with `kind ∈ {order,
geometry, select, view, placement, restore}`. `rendered`/`tested` are
independent facts and always false on this surface.

### `recipe_apply`

Request:
`{action:'recipe_apply', workspace_id, project_id, recipe, preview_id, preview_digest, op_id, intent?, viewport?}`

`viewport` is optional and strict when supplied: it must equal the previewed
viewport or the commit is `stale_resource` (`reason:'viewport_changed'`); the
effective (staged) viewport is bound into the receipt identity either way.
`intent` is optional and honored: when supplied it is bound into the receipt
identity and surfaced; when omitted it normalizes to `Recipe <recipe>`. A retry
with a different effective intent on the same key is `conflict`.

Resolution order:

1. Authenticate scope; the caller's project must be active.
2. Find a proposal with this `op_id` **and** `committed_actor === actor` whose
   effective intent matches. A matching request replays the store receipt
   (`idempotent:true`) before any expiry/base check, with current project
   authorization revalidated inside `authorize` before the receipt lookup. A
   same-key different payload is `conflict`; another actor cannot replay.
3. Otherwise load the proposal by `preview_id` (missing → `expired`). It must be
   `previewed` and match digest/recipe/scope; expiry and viewport are checked
   here, and the remaining authority checks (including expiry recheck under the
   write lock) run inside the commit transaction.
4. Commit through `store.commit`. Response:
   `{workspace, recipe, idempotent, status:'committed', preview_id, preview_digest, viewport, intent, rendered:false, tested:false}`.

A different `op_id` for a committed proposal is `stale_resource` and never
reapplies.

### `proposal_list` / `proposal_get` / `proposal_reject`

- `proposal_list`: `{…, recipe?, after_id?}` → a stable newest-first page of 32
  summaries (`created_at`/`id` order) with `{proposals, truncated, next_after_id,
  total_count}`. An unknown `after_id` is `stale_resource`; the staged
  state/placement is omitted.
- `proposal_get`: full `{…summary, operations, bindings, staged_state,
  staged_placement, warning}`.
- `proposal_reject`: CAS-marks a `previewed` proposal `rejected` without touching
  workspace state.

Statuses: `previewed` → `committed` | `rejected`; `stale` marks a preview
invalidated by drift detected during a failed apply.

## HTTP surfaces

- Workbench owner route: `POST /api/workbench/workflow` (owner bearer +
  origin check).
- Normal controller: `POST /api/workspace` action `arrangement` with
  `request:{…}`; the adapter assigns the actor and forwards to the same compiler.
- Read-only Hermes tools may call `recipe_list`, `proposal_list` and
  `proposal_get`; every mutation requires the profile's `allow_mutations`.

## Limits and retention

`max_recipes:32` (workspace-wide), `max_roles:5`, `role_choices ≤ 5`,
proposal encode ≤ 2 MiB, proposal TTL 60 s (expiry gates new applies only, and is
rechecked under the write lock; committed receipt replay is not time-limited),
proposals ≤ 200 per project, recipe receipts ≤ 512 per workspace.
Committed proposals, their checkpoints and their receipts are retained for the
project lifetime. Expired `previewed` proposals with no `op_id` are pruned to
make room; recipe receipts are append-only and no committed receipt is deleted.
A full recipe-receipt table refuses new `op_id` saves with `limit_exceeded`
rather than deleting history.

## Deliberate limits

- Measured relative geometry is not persisted with a saved recipe;
  `columns`/`rows` need an explicit measured viewport per preview and report
  `deferred` otherwise.
- A proposal stages one exact result; it is not a general layout designer and
  does not change pane identity or content.
- `renderer:'spatial'` does not write window frames or Docking placement.
- Persisted plan and browser acknowledgement do not establish browser rendering.
