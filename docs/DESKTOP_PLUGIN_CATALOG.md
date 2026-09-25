# Orbit Desktop plugin catalog

Open Hermes tools → Workspace plugins or Ctrl+Alt+P with parent workspace focus. Reload the frontend once after this source deployment; no backend restart is required. This manager is separate from the Hermes runtime plugin catalog on port 4360.

The trusted built-in manager now provides searchable catalog cards, installed/enabled/disabled/not-installed filters, package metadata, disabled-first installation, enable/disable, configuration, window settings, confirmed removal and advanced manifest import/recovery. Operations use existing authenticated plugins_apply with the current revision and automatic pre-change checkpoints. Conflicts do not automatically replay writes.

Catalog source: public/orbit-plugin-catalog.json. Its 13 entries reference existing locally published content-addressed bundles. It contains manifests and display metadata only, not configurations, secrets or workspace reports. This is a curated local catalog, not a remote marketplace or automatic filesystem index. Add new reviewed API-v1 manifests to this file and rebuild. Installed packages absent from the catalog remain manageable. Existing installed versions are retained; there is no automatic update or dependency installer.

Implementation: src/plugin-manager.ts and src/plugin-manager.css. This must be a trusted built-in because sandboxed app plugins have no lifecycle-management bridge. App sandboxes and existing authentication boundaries are unchanged.

Verification: npm run check passed all 75 tests and the production TypeScript/Vite build; publisher test passed. tests/desktop-plugin-catalog.browser.py passed against the served production frontend with a fresh isolated browser workspace: 13 cards, search, empty state, filters, authenticated install/enable/disable/remove, and no JavaScript errors. No owner plugin or window was changed by this test. Screenshot: .runtime/desktop-plugin-catalog.png.

Workspace checkpoints restore plugin registration/configuration/layout, not this source code, catalog file, app data or bundle bytes. Source rollback requires restoring these source files and rebuilding. Existing content-addressed bundles were not modified. The owner's currently loaded frontend was not forcibly reloaded.
