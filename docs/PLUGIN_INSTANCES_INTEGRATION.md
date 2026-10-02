# Plugin instance integration contract

Implementation: `src/plugins.ts`, `src/model.ts`, `src/workspace-ops.ts`,
`src/plugin-manager.ts`, with shared contracts in `contracts/workspace-v1.mjs`
and authenticated operations in `server/workspace.mjs`.

## Exact contract additions

- Plugin record: optional `instance_id`, UUID string. Unique globally across plugin instance IDs,
  saved window IDs and pane IDs. Omission retains the legacy primary identity.
- At most 32 **instances**, not 32 distinct manifest IDs. Multiple records may
  share manifest.id, but must have exactly the same manifest. At most one record
  without instance_id per manifest.id.
- Existing per-instance operations `plugin_enable`, `plugin_disable`,
  `plugin_remove`, `plugin_configure`, `plugin_patch_config`, `plugin_window`,
  `plugin_backend`: selector is optional `plugin_id` plus optional `instance_id`,
  requiring at least one. plugin_id alone selects ONLY the no-instance legacy
  primary; instance_id alone selects exactly that ID; both must agree.
- New `plugin_duplicate`: same selector and optional `name` (string <=60 chars). Server generates instance,
  window and browser pane IDs. Enabled status follows source. No extra fields.
  No caller-supplied destination ID. Config is always a deep copy. Window
  settings default to public source settings, name defaults to '<name> copy'
  truncated to 60 characters. Only one fresh browser pane is created.
- `plugin_update`: remains definition-wide with required plugin_id and manifest;
  replaces manifest on ALL matching instances, preserves names/config/IDs.
  No instance_id selector. plugin_install remains disabled-first primary install.
- Reject duplication when ANY instance of the definition is backend connected.
  Reject connecting backend while that definition has multiple instances.
- `plugins_apply` admits plugin_duplicate and selectors. Regenerate contract
  JSON/types whenever this source contract changes.

## Integration audit requirements

Recovery/Studio/store checks must iterate all instances by manifest entry and
match windows by window.id, never first manifest.id. Update definition-wide
revocation and disable operations to detach every matching instance. Retention
already must traverse every plugin manifest in states/revisions/checkpoints.
Do not key records/maps only by manifest.id where this loses sibling instances.
Server duplicate/update commits must run existing hold/revocation candidate checks.

Configuration schema integration is implemented: optional
`manifest.configSchema` uses `src/plugin-config-schema.ts`. Present values always
validate; missing required fields without defaults are allowed while disabled,
and effective config must be complete when active. Defaults affect the URL
without overwriting stored config. The manager passes metadata to the editor.
