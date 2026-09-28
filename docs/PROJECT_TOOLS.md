# Project tools (schema 10)

Status: **additive M3 increment, schema 10, not deployed.** This document is the
frozen contract for finite, trusted, host-rendered project tools. It does not
authorize an owner runtime migration, deployment, a model call, or any general
extension/broker behavior. Read [Workspace store](WORKSPACE_STORE.md),
[Plugins](PLUGINS.md) and [Resource authority proposal](RESOURCE_AUTHORITY_PROPOSAL.md)
for the surrounding boundaries. The broader extension vision in
[Dynamic workspace plan](DYNAMIC_WORKSPACE_PLAN.md) remains separate.

## Scope

M3 adds exactly two closed tool kinds:

- `notebook` — private, independently revisioned plain-text notes owned by the
  host.
- `evidence_checks` — a read-only, sanitized projection of existing recorded
  Workbench evidence/review facts; it never authors a new verdict.

Both are **finite trusted host modules**, not generated app bundles. They are
rendered by host-owned code (`src/project-tool-host.ts`,
`src/project-tool-manager.ts`) reached through an ordinary browser pane whose URL
is `orbit://project-tool/<instance-uuid>`. Consequences:

- No content-addressed `/apps/` bundle is created or referenced, so the bundle
  registry and its retention plan are unchanged.
- No arbitrary code, no downloaded/tested third-party publication, no generic
  frame bridge, general capability grant, model access or public data path is implied.
- No Normal/controller operation and no Hermes tool is added. `describe` keeps
  reporting the legacy-v1 `extension_compatibility` flags truthfully; project
  tools are documented here, not advertised as legacy-v1 plugin capabilities.

M4 (exact-output Studio) and any general broker/egress gateway are **not**
implemented. Nothing here should be read as a resource grant.

## Owner journey

Open **Project Workbench**, select a registered project, then expand **Create
project tool** under **Project tools**. Choose Notebook or Recorded evidence,
name it, inspect the semantic preview, and apply the exact proposal. The notebook
renders in a trusted host pane; **Save notebook** persists its private text.

Each project can have independent instances of the same definition. The manager
offers Configure, Release, Disable/Enable, Revoke and Open. Renderer v2 can show
notebook character counts; switching either direction retains the current note.
The checks card shows recorded verdicts and exact evidence/review identities,
folds supersession annotations, and refreshes without starting any check.

Unsaved drafts are memory-only. Conflicts keep the draft, including an empty
draft; **Reload saved note** explicitly discards it. An uncertain save exposes
**Retry the exact save** with the retained operation key/payload, never automatic
resubmission. Edits made while saving remain dirty after the earlier save completes.
Saved notes survive reload and restart; layout undo does not undo notebook data.

## Root references and authority

The serialized workspace layout remains **v1**. A project tool is rooted only by:

1. a browser pane whose exact current URL is `orbit://project-tool/<instance-uuid>`, and
2. the authoritative `wb_tool_bindings` row `(workspace_id, project_id, instance_id, pane_id)`.

The pane URL and the binding are placement/display handles, never authorization.
`resolve` and every `data_read` revalidate the exact current pane URL against
`wb_tool_bindings`, the live active project, `enabled === true`,
`revoked === false`, and the absence of a recovery hold. A copied, retyped,
restored or re-navigated pane fails closed until it is re-resolved. A pane ID or
instance ID alone authorizes nothing.

## Schema 10 data model

Schema 10 is a single additive migration (`server/project-tools-data.mjs`,
`projectToolsSchemaSql`). Existing workspaces, checkpoints, receipts, bundles,
Workbench records and legacy v1 plugin registrations are untouched. All tables
start empty on migration.

| Table | Grain | Notes |
| --- | --- | --- |
| `wb_tool_definitions` | per workspace, per kind | idempotently seeded, never updated |
| `wb_tool_releases` | per definition, per release | unique `(definition_id, release)` |
| `wb_tool_instances` | per workspace/project | revision CAS, `enabled`/`revoked` in `record_json` |
| `wb_tool_grants` | one row per instance (`UNIQUE(instance_id)`) | separate finite host-only grants; not layout state; see below |
| `wb_tool_bindings` | per workspace/project/instance | `UNIQUE(workspace_id, pane_id)`; the authoritative pane binding |
| `wb_tool_data` | one row per instance | private notebook body and its own revision |
| `wb_tool_receipts` | `(workspace_id, actor, op_id)` | metadata-only results and policy generation |
| `wb_tool_proposals` | per workspace/project | exact staged create-proposal with a digest and TTL |

Definitions and releases are **workspace-scoped**; instances, bindings, data and
proposals are **project-scoped**. Data is **not** a release: repinning a release
does not move or rewrite the private instance data.

### Finite host releases

Each kind has two closed host release descriptors, `1` and `2`, carrying a
`render_version` (1 or 2) and a `data_schema_version` of `1`. The stored
`host_digest` binds the exact finite host rendering descriptor (component, kind,
render/data versions, exposed features). It is deliberately **not** a claim about
arbitrary executable bytes or a tested third-party publication. There is no code
publication path in this increment.

### Host-only grants (separate, finite)

Grants live in their own `wb_tool_grants` table with an independent lifetime.
They are **not** layout/checkpoint state, not an instance's `enabled` flag, and
never enter `state`, `describe` or workspace receipts. A grant is unique per
instance.

- **Finite scopes only:** `notebook.read` and `notebook.write` for the private notebook, and
  `evidence.read` for the read-only evidence projection. There is no wildcard,
  workspace-wide or pane-derived scope. The request/action surface, if it
  changes, must land in `contracts/project-tools-v1.mjs`; no action is invented
  here.
- **Project-generation fence:** a grant is bound to the project generation under
  which it was created. Revoking a project and re-registering it increments
  `wb_projects.generation`; a grant captured before re-registration can **never**
  be revived by the new registration or by a layout restore.
- **No generic broker:** a grant authorizes only these finite host-rendered tool
  operations. It is not consent for a pane, terminal/history, shared browser,
  native app, model, generated frame, filesystem or network access, and it does
  not turn an ID into an authorization.
- **Revocation is separate from the hold:** instance `revoke` is permanent and
  turns grants off; `repin` never restores them. Entering the recovery hold
  disables instances (revision bump) but does not itself mint or revoke grants;
  because every read requires `enabled && !revoked && !hold`, grants stay inert
  while held and after release until the instance is explicitly re-enabled.
  Releasing the hold never re-enables an instance.

The grant table is part of the additive schema-10 migration. Service-side scope
checks and the project-generation fence have dedicated regressions, including
independent grant revocation while the instance projection still says enabled.

### Legacy v1 plugin projection (read-only)

Existing `workspace.state.plugins[]` registrations are **not** migrated into the
new tables and are **not** duplicated into a second writable store. They remain
the authoritative v1 layout records, and `metadata_list` returns a read-only
`legacy_plugins` projection (id, version, title, enabled, window identity). The
projection never writes definitions, instances or bindings, and does not rewrite
or renumber existing plugin IDs or bundle references. This preserves existing
IDs and content-addressed bundles.

## Owner requests

All requests are served only on the owner-authenticated
`POST /api/workbench/tools` route (owner Bearer token plus same-origin checks,
via the shared owner-route wrapper). The request contract is
`contracts/project-tools-v1.mjs`; the server validator is compiled from that
exact object. IDs are selectors, not authorizers. Bounded limits include 16
definitions, 8 releases, 64 instances, 200 proposals, 1024 receipts, 4096-byte
config and 256 KiB data per save, a 60-second proposal TTL and at most 32
evidence checks.

Reads:

- `metadata_list` — `{workspace_id, project_id?}` → `definitions`, `releases`,
  `instances`, `grants`, `legacy_plugins`, `limits`.
- `resolve` — revalidate a pane/instance pair.
- `data_read` — read one instance's private data after full pane/binding/project
  and `enabled && !revoked && !hold` checks.

Writes (`op_id` + `intent` required, durable actor-scoped receipt):

- `data_save` — notebook body, revision CAS, metadata-only receipt.
- `configure` — bounded config only: `font_size` and `show_counts`.
- `set_enabled` — `true`/`false`.
- `revoke` — permanent for the instance.
- `repin` — the same data schema only.
- `create_commit` — commit an exact persisted layout/placement proposal,
  revalidated under the store transaction.

`create_preview` stages the proposal and returns its digest and expiry; it does
not require a write operation key. All committed write receipts are fenced by
recovery-policy generation. Within the same generation, exact retries recover the
original metadata-only result after later edits or preview expiry. A changed
payload, including a changed pane selector, cannot reuse the operation key.

## Lifecycle and recovery hold

- `enabled` and `revoked` are independent. `revoke` turns grants off permanently;
  a later `set_enabled(true)` cannot restore a revoked instance.
- `repin` may move an instance between the two finite releases **only when the
  data schema matches** and never reverts later notes. An incompatible
  `data_schema_version` is refused. Direct reads/writes also refuse unsupported
  persisted data schemas; a save cannot silently downgrade them. Closed release
  descriptors are checked against the host's supported descriptor digests.
- Entering the recovery hold durably sets `enabled = false` and increments the
  revision of every affected instance in the same transaction as the policy
  change. It does not delete instances or grants. Releasing the hold **never**
  re-enables an instance.
- While held, the generic store refuses any mutation that introduces or changes a
  `orbit://project-tool/<uuid>` pane URL. Existing disabled or inert project-tool
  panes are left alone; ordinary layout edits that do not activate a tool remain
  allowed.

## Privacy

- Notebook text (up to 256 KiB, `{text}`, schema 1, revision CAS) lives only in
  `wb_tool_data`. It never enters layout/v1 state, checkpoints, workspace events,
  generic workspace receipts, `wb_tool_receipts`, `/apps/` URLs or `describe`
  output. A `data_save` receipt records metadata only.
- Notes and detailed evidence are never forwarded to network-capable generated
  frames, the Normal controller, Hermes tools or model endpoints. Evidence checks
  expose a sanitized projection of already-recorded facts.
- `show_counts` is a bounded presentation preference, not a metric claim. This
  document makes **no** subscription-count, event-count or latency claims; any
  such number must be independently measured before it is stated.

## Migration, backup and rollback

- A schema-9 database upgrades transactionally on open to schema 10 with all new
  tables empty. Workspace/checkpoint/receipt/bundle/Workbench records and legacy
  v1 plugins are preserved.
- A real archived **schema-9 reader refuses schema 10**; the current reader
  refuses schema 11. Mixed-version writers remain unsupported.
- SQLite backup/restore carries the schema-10 tables. `restore --preserve-schema`
  copies an older artifact untouched (for example a genuine schema-9 backup stays
  schema 9) and never down-converts.
- Version numbers, `--schema-min`/`--schema-max` and release packaging for a
  schema-10 runtime are operator decisions owned by the release process; no
  owner deployment was performed by this increment.

## Verification

`tests/project-tools-migration.test.mjs` covers the additive empty migration,
new-table shape, backup round-trip, schema-9 reader refusal / schema-11 refusal
and the read-only `legacy_plugins` projection. The new-table check derives table
names from `projectToolsSchemaSql`, so an added table such as `wb_tool_grants`
is covered automatically without hardcoding its name. Existing schema assertions
were bumped to 10 (and future to 11) across the Node suite, and the Project
Workbench browser doctor fixture now expects `schema_version: 10`. The backend
service, its grant scope/generation checks and its own behavior tests are owned
separately (`server/project-tools.mjs`, `tests/project-tools.test.mjs`); the owner
route and new UI are owned by the integration and frontend increments
respectively.

`tests/project-tools.browser.py` exercises both renderers against disposable real
servers: two-project isolation, edit/conflict/reload, in-flight edits, exact retry,
release update/revert without note rollback, disable/configure/enable, hold/release,
placement undo and delayed-response revocation fencing. Checks-card facts are
explicit synthetic records in the private fixture database, not provider evidence.
Server revocation is detected by the host's one-second polling and local
invalidation events; already-delivered bytes cannot be recalled.

No deployment, paid provider call or owner runtime migration is part of this
document.
