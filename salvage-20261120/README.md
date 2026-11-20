# Salvage from a dirty working folder (2026-11-20)

Source: local folder for branch `feat/local-workers` at 18bef9b, with uncommitted changes.

Most of this work already landed in mojomast/hyvv main (the launcher moved there):
agy_cua_mcp.py, brief.schema.json, setup-agy-cua.ps1, cleanup-sandboxes.ps1 and test_agy_cua.py match hyvv main
(only trivial diffs). The launcher.py dirty diff (295 added lines) is also present in hyvv's launcher.py.

Kept here because it is not on hyvv main:
- `test_go_free.py`: a small test for opencode Go-routed free models (model_spec / FREE_POOL / fallback).
- `dirty-tracked-diff.patch`: the full tracked diff of pc-launcher/ for reference.

Not kept: `*.bak-*` files (old snapshots), node_modules.
No PR. Do not merge.
