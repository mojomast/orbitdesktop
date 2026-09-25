# COCS Developer SDK 0.1

A source-grounded developer-tool core, plus a separate Orbit host adapter. This
is an initial SDK, not the full game engine or a portable one-click installation
of every existing lab. It is not published to npm or the Hermes plugin catalog.

## Portable core

Requires Node 22+, a COCS checkout, and a dependency directory containing installed
`esbuild` and `three`. Model validation additionally requires Python 3 with
Playwright and an explicitly selected Chromium executable. Nothing installs or
executes a repository package script. Three/esbuild must be trusted dependencies.

`node index.mjs /path/to/cocs /path/to/source-index.json`

Indexes selected game mechanics modules, imports, exported symbols and line
numbers. Links are pinned to the checkout's actual HEAD. The default branch label
is feat/fieldwork-plan; indexSource accepts another branch label. Draft source
may differ from HEAD; pinned GitHub links show the baseline, not uncommitted edits.

`node bundle.mjs /path/to/cocs lattice-adapter.mjs /tmp/lattice.html /path/to/deps`

Builds the actual Lattice helpers and Match engine into a network-denied standalone
browser probe. Requires the Lattice modules (present on feat/fieldwork-plan, not
older main). Exposes window.latticeSDK and window.probeResult. Probe coverage:
authored adjacency, income, cut/repair and D1–D4 wave-plan construction. The host
adapter additionally steps real PvP and Operations Match instances for 60 ticks.
These are smoke checks, not a substitute for requested-behavior/gameplay tests.

`python validate.py /path/to/draft BASE_COMMIT --deps /path/to/deps --chromium /path/to/chromium --output /tmp/compatibility.json`

Extracts baseline game source from Git and runs baseline/draft model construction
in separate Chromium pages. The bundler permits only game modules and trusted
Three.js; draft code is never imported into Node/Python. Chromium has no network
access. It runs with --no-sandbox in this deployment; this is not an OS security
boundary against a hostile Chromium exploit. Do not validate untrusted arbitrary
code as though this were a hardened multi-tenant service.

Model contract v1 covers Puma/Hornet, all exported characters and weapons in the
source data tables. Checks vehicle kind/vehicle/wheels/turret/guns/flashUntil,
Object3D references in userData (including barrels and rig/weapon parts), attached
references, finite positions and baseline static draw counts. Rejects any static
mesh-count growth, more than eight total extra meshes, or triangle growth beyond
max(25%,500). Existing inefficient geometry is grandfathered: it does NOT
retroactively batch meshes or prove visual equivalence, rig pose correctness,
all vehicle kinds, performance under gameplay, or every possible runtime contract.
Budget-changing optimizations need a separate reviewed policy change.

`scenario.schema.json` and `change-brief.schema.json` describe versioned exported
experiments. Owner overrides are laboratory setup, not legal capture actions.
Importing a recipe into the actual game is not implemented. The UI's source graph
is a code index, not a dynamic profiler or an exhaustive call graph.

Run `npm test` for the indexer's portable fixture tests. Runtime model regression
and real browser integration tests are in the Orbit adapter's tests directory.

## Orbit adapter (separate from this package)

Orbit source: extensions/cocs-workshop, extensions/cocs-lattice-lab,
apps/cocs-lattice-lab, scripts/build_lattice.py and scripts/package_cocs_sdk.py.

The adapter owns authentication, private persistence, Hermes Runs API inference,
isolated Git clones, diff hashing, review and explicit push/PR confirmation.
It currently contains deployment-specific paths, Tailscale URLs and owner identity.
No credentials are packaged. Configure these adapters for another deployment;
do not distribute .env, runtime drafts, screenshots, secrets or capability tokens.

Lattice PRs target feat/fieldwork-plan. Asset Workshop continues targeting main.
Lattice automatic edits are limited to existing mechanics/config game modules;
UI, model, rendering and network source need their own review workflow. Map and
navigation edits are fail-closed pending trusted traversal acceptance. There is
no automatic merge. Previous validation policies cannot publish without rechecking.

The shipped UI has source topology, capture/supply experiments, a wave/Director
planner, objective economy, searchable wiring, deterministic engine stepping and
scenario+brief export. In-memory experiments reset on reload; drafts persist on
the host. Baseline is a build-time source snapshot; draft creation fetches the
current named branch. A workspace checkpoint cannot undo host files or GitHub
side effects. Services use manual health-gated version promotion, not automatic
reboot supervision.
