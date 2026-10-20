# Orbit community plugin catalog

A GitHub-backed, maintainer-reviewed catalog of desktop apps. Inspired by the [Hermes catalog admission model](https://github.com/NousResearch/hermes-agent/tree/main/plugin-catalog): one entry per app, reviewed PRs, exact commit pins, reviewed updates and a removal list. Static UIs are sandboxed by default. Optional trusted Python backends require a separate review, staging and explicit host-code activation; these are not Hermes runtime plugins. See [trusted backend setup](../docs/CATALOG_BACKENDS.md).

## Submit an app

1. Commit a ready-to-serve static app to your public GitHub repository. Its folder must contain `index.html`, use relative assets, and stay within 20 MB / 500 files. No build or install scripts run on a user's host. Vendor executable dependencies; remote scripts/modules, self-updaters, hidden files, symlinks and special files are not accepted.
2. Fork Orbit and copy `examples/catalog/notes.json` to `plugin-catalog/<your-id>.json`. Replace every field with real metadata. `sha` is a full lowercase 40-character commit SHA, never a branch/tag. `path` is the committed static bundle directory (`.` for root). IDs use `[a-z][a-z0-9-]{0,25}`, versions use `x.y.z`. No local paths, credentials, private reports or local integrations belong in the public catalog.
3. Run `python3 scripts/orbit_catalog.py validate --sources`. No dependencies are needed beyond Python 3.11+. CI validates JSON, pins and static bundle safety. It downloads but never executes plugin code.
4. Open a PR using the catalog template: `https://github.com/mojomast/orbitdesktop/compare?template=catalog.md`. Supply authorship, license, capability declarations, screenshots and actual sandbox test evidence.
5. A maintainer reviews the pinned source and merges. Approval alone is not publication: merge into `main` admits the entry. There is no self-service upload or auto-merge bot.

`capabilities.network` and `.storage` document behavior for human review; they do not grant privileges or enforce network isolation. Orbit's iframe sandbox grants no host tokens/parent DOM/host bridge, but currently permits network access. CI cannot prove JavaScript benign or verify every capability declaration. Human source and behavior review remains mandatory.

## Updates and removal

Updates are new PRs changing the exact SHA and version. Include the old-to-new source comparison; reviewers repeat admission review. Apps may not fetch replacement executable code themselves. Installed apps are not silently upgraded.

For security removal, delete the entry and add `{ "id": "…", "repo": "https://github.com/owner/repo", "reason": "…", "date": "YYYY-MM-DD" }` to `removed.json`. A blocked ID or repository cannot be admitted by the validator. Ordinary delisting just deletes an entry. Next successful sync removes it from available community listings, but retains published files for checkpoints and does NOT disable existing installations. Removal is not a remote kill switch, and stale/offline installations must be handled by their owner.

## Sync reviewed GitHub entries into Orbit

Run from the Orbit repository:

```
python3 scripts/orbit_catalog.py sync
npm run build
```

The sync command resolves upstream `main` to one immutable catalog commit, downloads entries from that snapshot, validates them, downloads each app at its reviewed SHA, and uses Orbit's existing content-addressed publisher. It atomically writes `public/orbit-community-catalog.json` only when every app succeeds. Existing catalogs survive network/validation failures. It neither installs workspace registrations nor enables anything. No third-party build commands are executed.

The Plugin Manager combines this feed with the optional local catalog. Community entries win ID collisions and show source/pin/capabilities. Clicking Install uses the existing checkpointed disabled-first lifecycle. Updating an installed app is explicit. Local-only tools are never submitted or uploaded by sync.

In development Vite serves the refreshed public file immediately. Production deployments must rebuild and deploy the new static output (or copy this generated JSON to the deployed static root using their normal deployment process). A new frontend load is required once for the manager integration. Sync is deliberately operator-triggered: merging a PR makes it available upstream; existing desktops refresh on their next sync/deployment, not through an always-on polling service. `--catalog PATH` supports reviewed local checkouts and tests; it is not proof of upstream admission.

GitHub public API rate limits and network failures can block refresh. Existing published apps continue working. Retained files are not garbage-collected. Bundle SHA pins are not signatures, code safety proofs or filesystem-enforced immutability.

## Repository settings required

The included workflow runs with read-only permissions on pull requests, never `pull_request_target`, and never runs plugin code. CODEOWNERS requests `@mojomast` review. A repository administrator must enable branch protection/rulesets on `main`: require PRs, code-owner approval, the `catalog` check, dismiss stale approvals, and disallow bypass/direct pushes as appropriate. Files in a PR cannot enforce these GitHub settings on their own.

## Maintainer verification

```
python3 tests/orbit-catalog.test.py
python3 scripts/orbit_catalog.py validate --sources
python3 scripts/orbit_catalog.py sync --catalog plugin-catalog
npm run check
```

Orbit Live Telemetry is the first proposed listing, pinned to a portable host-metrics package; it is admitted only when this PR merges. Its license is `NOASSERTION` because this repository has no project license file; redistribution terms remain unspecified and should be settled before promoting it as an openly licensed package. Workspace Workshop is an additional proposed listing in the same change, pinned to an exact commit that already exists in this public repository. A Devplan Interview listing (the static Studio plus the adaptive interview UI and its tool-free Python backend) was drafted but is deferred: its conversational path has no passing end-to-end model test yet, so it is not proposed for admission at this time. The Notes example remains a test fixture, not an approved listing. COCS, OmniVoice, private infrastructure and deployment-specific local tools are not seeded into this public catalog.
