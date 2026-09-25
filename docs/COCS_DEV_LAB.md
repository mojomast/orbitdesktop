# COCS Dev Lab

Sandboxed plugin `cocs-dev-lab`, separate from the existing Asset Workshop. Source: `apps/cocs-dev-lab/`. Uses actual bundled game/data.mjs from snapshot e79fcc048d7d97e7418d2e6fdbdd304b69362fa0, not a live GitHub feed.

Weapon balance: edit damage, pellet count, interval and range for ten weapons. Change target health/distance/full-splash assumption, compare idealized DPS and TTK against baseline, download CSV. First shot occurs at t=0; falloff is a linear approximation. No accuracy, armor, reload or travel-time simulation; not a substitute for game playtests.

Loadout inspector: nine characters, seven harnesses using the real validLoadout function, five powerups and global rules. Character stats are read-only. Claude's harness restriction is enforced by the upstream function.

Change review: field-level before/after display, JSON proposal export and validated import, and a downloadable Hermes implementation brief. Import requires matching schema, repository, commit and original values; rejects duplicate/unknown fields and invalid numbers. Import does not restore simulation settings. Edits are session-only; export before reload. No automatic source writes, model requests, shared Workshop drafts or PR creation. Provide the brief to Hermes for a separately reviewed implementation.

Build: `node_modules/.bin/esbuild apps/cocs-dev-lab/source.js --bundle --outfile=apps/cocs-dev-lab/app.js` then publish a new immutable plugin version. Upstream data has four duplicate impact keys reported by esbuild; this lab does not consume those cosmetic fields. Never overwrite published bundles.

Test: `.runtime/browser-venv/bin/python tests/cocs-dev-lab.browser.py`. Verified the published opaque sandbox, real data, DPS edits, review, proposal download/import and rejection, brief/CSV download, compatibility and out-of-range calculations, without JS errors. `npm run check` passed build and 67 tests; publisher tests passed.

Installed at workspace revision 792, observed_revision 792, browser_applied true. The scoped operation preserved the existing Asset Workshop and other windows. Automatic pre-change checkpoint covers plugin/layout metadata only, not session experiments or downloaded files. Disable/remove this plugin to remove the window; it has no backend service.
