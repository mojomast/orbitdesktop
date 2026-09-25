# Workspace command contract v1 (generated)

Run `node scripts/generate-workspace-contract.mjs --check` to verify parity.

Authoritative validation: strict JSON Schema plus existing semantic/resource checks. Unknown fields and type coercion are rejected. Request bytes include the full UTF-8 envelope.

- maxOperations: 32
- maxRequestBytes: 150000
- maxResponseBytes: 2000000
- maxLabelCharacters: 120

Legacy mutations are revision checked but do **not** yet have durable idempotency receipts. Preview is structural and generated IDs remain provisional. This registry does not complete the transactional migration.

| Operation | Required fields (besides action) | Optional fields | Effect |
|---|---|---|---|
| set_spatial_camera | camera |  | layout |
| arrange_spatial |  | window_ids, mode, columns, gap | layout |
| reset_appearance | keys |  | layout |
| set_arc | arc |  | layout |
| reorder_windows | window_ids |  | layout |
| swap_panes | window_id, pane_id, other_window_id, other_pane_id |  | layout |
| layout_panes | window_id, layout |  | layout |
| arrange_windows | width, height | window_ids, columns, gap | layout |
| set_workspace | state |  | layout |
| patch_appearance | patch |  | layout |
| set_appearance | appearance |  | layout |
| update_split | window_id, path | ratio, axis, swap | layout |
| set_view | view |  | layout |
| sidebar | hidden |  | layout |
| select | window_id |  | layout |
| add_window |  | name, kind, url, frame | layout |
| update_window | window_id | name, diagonal, aspect, height, distance, pitch, yaw, offset, fontSize, spatialFontSize, opacity, frame, spatial | layout |
| close_window | window_id |  | layout |
| set_pane | window_id, pane_id | kind, url | layout |
| split_pane | window_id, pane_id | kind, axis, ratio | layout |
| close_pane | window_id, pane_id |  | layout |
| plugin_install | manifest | config | plugin-registration |
| plugin_backend | plugin_id, endpoint, confirm_host_access |  | trusted-backend |
| plugin_enable | plugin_id |  | plugin-registration |
| plugin_disable | plugin_id |  | plugin-registration |
| plugin_remove | plugin_id |  | plugin-registration |
| plugin_patch_config | plugin_id, patch |  | plugin-registration |
| plugin_window | plugin_id, settings |  | plugin-registration |
| plugin_configure | plugin_id, config |  | plugin-registration |
| plugin_update | plugin_id, manifest |  | plugin-registration |
| plugin_disable_all |  |  | plugin-registration |
