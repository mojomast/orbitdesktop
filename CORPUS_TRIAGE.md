# Corpus triage: what ships where

Written 2026-09-25 for the 0.2.7 reconciliation. Covers the development-line
corpus that does not exist on the release line: 15 app folders (1489 files),
11 extension folders (99 files), 3 projects and 1 SDK folder, plus docs and
tests.

Evidence is inline per item. Nothing here is inferred from names; every
private endpoint, size and screenshot reference was read from the files.

## The admission rule

From `plugin-catalog/README.md`: a catalog entry must be a committed static
bundle with `index.html` and relative assets, under 20 MB / 500 files, with
no build scripts, local paths, credentials, private reports or local
integrations. The iframe sandbox grants no host tokens, parent DOM or host
bridge. Optional Python backends are allowed but need a separate review, a
declared permission list and explicit host-code activation
(`docs/CATALOG_BACKENDS.md`). COCS, OmniVoice, private infrastructure and
deployment-specific local tools are named in that README as things that are
not seeded publicly.

## Bucket 1 — owner infrastructure, stays on-host (never release line, never catalog)

Hardcoded private endpoints confirmed by reading the files:

| Item | Private endpoint |
| --- | --- |
| `apps/cocs-graphics-wrapper` | `kimi:10447` |
| `apps/cocs-lattice-wrapper` | `kimi:10448` |
| `apps/cocs-workshop-wrapper` | `kimi:10446` |
| `apps/shared-desktop` | `kimi:4346` |
| `apps/omnivoice-bench`, `extensions/omnivoice-bench` | `kimi:10445`, `127.0.0.1:3900` |
| `apps/supra2-studio` variants, `extensions/supra2-studio` | `kimi:4325`, `kimi:4363`, `127.0.0.1:4334` |
| `extensions/mimo-bench` | `kimi:4325`, `kimi:4366` |
| `extensions/orbit-telemetry` | `kimi:4325`, `kimi:4365`, `127.0.0.1:49374` |
| `extensions/orbit-secrets` | `kimi:4325`, vault at `kimi:4364` |

`orbit-telemetry` also refuses any request unless the Tailscale login header
equals the owner identity. It is the private edition; the portable public
derivative already exists upstream as `packages/orbit-live-telemetry`, and
that is the real catalog listing. `orbit-secrets` is a vault client and must
never leave the host.

The three COCS `*-wrapper` apps are one-file iframes pointing at private
COCS services. The release line's Xpra launcher system supersedes them
entirely, so they are droppable as well as unpublishable.

## Bucket 2 — COCS family, excluded by policy

`apps/cocs-dev-lab`, `apps/cocs-graphics-lab`, `apps/cocs-lattice-lab`,
`apps/cocs-studio`, `apps/cocs-viewer`, `extensions/cocs-graphics-lab`,
`extensions/cocs-lattice-lab`, `extensions/cocs-workshop`.

All reference private COCS endpoints (`kimi:10446-10448`). `cocs-viewer` is
disqualified twice over: 75 MB and 1489 files against a 20 MB / 500 file cap,
and it ships personal project screenshots (`map-blood-gulch.png`,
`character-chatgpt.png`, `vehicle-preview.png`, `weapon-0.png` and others,
8 PNGs). It alone is almost the entire weight of `apps/`. These stay in the
private worktree.

## Bucket 3 — ported to the release line

- `apps/hermes-live-tools` — **ported** (commit 59f9f7b). One 5 KB static
  `index.html`, no external URLs, no credentials, no host bridge. The release
  line already ships `src/tool-feed.ts`, which posts `orbit:tool-feed`
  messages to this widget's published frames, but the source was missing —
  so this restores parity rather than adding a new capability. Kept as an
  app source: `tests/test_orbit_bundle.py` deliberately excludes `apps/` from
  the hermes-plugin tarball, so it is published through the normal
  content-addressed publisher instead of shipping inside the plugin bundle.
- `extensions/plugin-catalog` — **not ported**. Revised from the earlier
  triage after reading the code: its own docstring declares it a "Private,
  owner-authenticated Hermes catalog browser", and it runs a standard-library
  service with `bridge.py`. It only reads the public Hermes catalog API
  (`hermes-agent.nousresearch.com/docs/api/plugin-catalog.json`), so it is
  not a leak risk, but it is owner tooling rather than a shipped feature.
  It would be a reasonable *future* catalog backend (public API, no private
  endpoints); no entry is proposed for it here.

## Bucket 4 — catalog listings

- `plugin-catalog/devplan-interview.json` — **proposed** (commit d372bf2).
  The more complete of the two Devplan artifacts: the static Studio plus the
  adaptive interview UI (`interview.js`) and its tool-free Python backend
  (`main.py`, `worker.py`, `extension.json`). Pinned to
  `348e1072f9a8f99965a8f87ae39e050f1308d7bf`, `path` and `backend.path` both
  `extensions/devplan-interview`, with five declared host-access permissions.
- `plugin-catalog/workspace-workshop.json` — **proposed** (commit d372bf2).
  The one generic, credential-free static app in the corpus: two files,
  12 KB, no `fetch`, no `localStorage`, no host bridge. Declared
  `network: false`, `storage: false`.

## Excluded by owner decision

- `extensions/hermes-doom` — excluded. `jev.py` calls `api.typesafe.ai`
  with a runtime-entered, consent-gated key. Not shipped, not catalogued.
- `apps/orbit-observatory` — excluded (owner does not want it). Its renderer
  is generic but it fetches
  `/apps/orbit-observatory-data/snapshot.json`; a public listing would need a
  neutral example snapshot instead of real mission data.
- `apps/hermes-token-stats` and `apps/devplan-studio` — not carried by this
  triage. `hermes-token-stats` already exists upstream. `devplan-studio` is
  subsumed by the Devplan Interview catalog listing.

## Devplan: out of the project, into the catalog

Commit a7a4c90 removes Devplan from the main project entirely: the static
app, the interview extension and backend, the setup script, the docs, the two
browser tests, and every integration point —
`src/workspace-extensions.ts`, `src/main.ts`, `src/panes.ts` (two sites),
`src/desktop-icons.ts`, `server/index.mjs`, `scripts/bundle_hermes.py` and
`tests/test_orbit_bundle.py`, plus the README sections. The committed
`hermes-plugin/orbit-source.tar.gz` was rebuilt so the bundle matches tracked
source. Devplan now lives only as the optional catalog listing above.

`hermes-plugin/orbit-source.tar.gz` was also regenerated after the removal;
`tests/test_orbit_bundle.py` passes (2 tests).

## Verification (real execution)

- `npm run build` — tsc strict + vite, green after the removal.
- `npm test` — 77/78. The one failure,
  `tests/agent.test.mjs` "unconfigured bridge fails closed", is pre-existing
  and fails identically on a clean `origin/main` checkout; it is unrelated to
  any change here.
- `python3 scripts/orbit_catalog.py validate --sources` — downloads all
  three pins from the real GitHub repository and passes:
  `devplan-interview@348e107` 8 static + 8 backend files,
  `workspace-workshop@348e107` 2 static files,
  `orbit-live-telemetry` 2 static + 5 backend files. Backend files are
  validated, never executed.
- `python3 tests/orbit-catalog.test.py` — 18 tests OK.
- `python3 tests/test_orbit_bundle.py` — 2 tests OK.

## Open items and limitations

- **Devplan Interview is not end-to-end verified.** `docs/DEVPLAN_INTERVIEW.md`
  records that the real two-turn success test has never passed — the
  configured provider returned HTTP 401 `token_expired`. The static UI,
  unlock, export/import and bounds were tested with real browser runs; the
  model turn was not. **Do not merge the Devplan Interview catalog listing
  until `tests/devplan-interview.browser.py` passes with a working provider.**
- Catalog pins point at `348e1072f9a8f99965a8f87ae39e050f1308d7bf`, which
  exists in the public repository on `origin/agent/orbit-menu-theming` but not
  on `main`. A reviewer may prefer a pin on `main`; that requires the
  reconciliation branch to be pushed and merged first.
- The `plugin-catalog` extension is left on-host; if it should be shipped, it
  needs its own entry and review.
- This document covers only the corpus triage. It does not re-decide the
  core src/server reconciliation (see `PORT_LOG.md`).
