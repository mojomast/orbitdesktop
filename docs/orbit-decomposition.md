# Orbit decomposition — keep, extract, retire (inventory + plan only)

Base: `da8201617a55f8187642f7e03d6b30b6c3c294e5` (main). This document and
`orbit-inventory.json` are **plan-only**: nothing was removed, disabled,
rewired or redeployed by this task. Every RETIRE/EXTRACT below is a proposal
that becomes real only when the owner ticks it in the decision checklist
(§8). The deployed Observatory and the campaign surfaces (rails proxy,
decision queue) are protected; §2.3 shows why the plan cannot break them.

Companion machine-readable inventory: `docs/orbit-inventory.json`
(`orbit-decomposition/inventory-v1`), validated against the real tree by
`tests/test_orbit_decomposition.py`.

## 1. Scope and method

**Objective.** Decide what to keep and what not to keep across the whole
orbitdesktop corpus, with evidence, without deleting anything.

**Corpus covered.** 151 server modules (`server/` — 149 `.mjs` + 2 `.py`,
37,581 LOC), 4 apps (`apps/`), 226 `src/` modules (28,332 LOC) in six areas,
131 docs (≈82.5k lines), 35 contract modules (`contracts/`, 13,108 LOC), 361
test files (≈59.8k LOC), plus `scripts/`, `deploy/`, `hermes-plugin/`,
`pc-launcher/`, `vendor/`, `packages/`, `extensions/`, `contrib/`,
`plugin-catalog/`, `examples/`, `experiments/`, `skills/`, `bin/`, `config/`,
`public/` and root tooling.

**Evidence per classification** (recorded per module in the JSON):

- *Usage where observable* — route wiring in `server/index.mjs` (the
  composition root), lazy `import()` mounting, env gates
  (`ORBIT_LOCAL_WORKERS`, `ORBIT_MCP_APPS`, `ORBIT_BROWSER_EXECUTABLE`,
  `ORBIT_NATIVE_HERMES_*`, `ORBIT_WORKBENCH_GVISOR_*`, `router.enabled`),
  built-in-app installation (`server/builtin-apps.mjs`), frontend reachability
  (`src/host-surfaces.ts` surface table, `docs/AGENT_GUIDE.md`), deploy units
  (`deploy/*.service` all run the same `server/index.mjs`), and the portable
  bundle policy (`scripts/bundle_hermes.py`, which already excludes
  `server/mobile-proxy.mjs` as deployment-specific).
- *Coupling* — computed import closure of `index.mjs` (what breaks if
  removed), reverse consumers across `server/ src/ tests/ scripts/`,
  `workbenchData` subscription fan-out, and shared-helper usage.
- *Mass* — exact LOC per module, per family, per area.
- *Tests/docs* — dedicated test files and reviewed contract documents.

**No live runtime was inspected on this machine**: the deployed host
(`/home/mojo/.hermes-instances/fresh/workspace/orbitdesktop`, systemd units in
`deploy/`) is not mounted here. Usage evidence is therefore wiring-, gate-,
deploy-manifest- and ledger-based, not process-based; §9 records this limit.

**Classes.**

| Class | Meaning |
| --- | --- |
| KEEP-CORE | The operator mission: workbench, terminals, catalog+app serving, owner-auth API, approvals, Observatory, rails/snapshot/decision surfaces. |
| KEEP-PLATFORM | Load-bearing infrastructure the core needs (contracts, stores, routes, tooling). Stays in the core codebase. |
| RETIRE-PROPOSAL | Evidence says dead weight, superseded or out of mission. Removed only on explicit owner approval (§8). |
| EXTRACT-PROPOSAL | Real and load-bearing, but belongs behind a service boundary per the umbrella modularity profiles (§6). Extraction, not deletion. |

## 2. What is load-bearing

### 2.1 The mission chain (what must never break)

1. **Owner auth + composition root** — `server/security.mjs` (token/origin)
   and `server/index.mjs` (all routes, PTY websocket, shutdown). Six deployed
   systemd units (`deploy/orbitdesktop-*.service`, ports 4328–4333) all boot
   this one file.
2. **Workspace state authority** — `server/workspace.mjs` +
   `server/sqlite-workspace-store.mjs` (schema 12: revisions, checkpoints,
   receipts, outbox, bundles, workbench/project-tool records),
   `workspace-contract/diff/description/events/layouts/arrangements/jev`,
   plus `public/recovery.*` (independent recovery console served separately of
   `dist/`).
3. **Terminals** — `/api/terminal` websocket → `server/local-host.mjs`
   (node-pty, tmux `orbit-persistent`), with the managed-terminal family
   (`managed-terminal-{ledger,provider,broker,routes,contract}`,
   `terminal-resource-registry.mjs`) providing attach-only adoption of
   existing shells and the legacy-attach fence.
4. **Catalog + app serving** — `server/builtin-apps.mjs`,
   `server/bundle-registry.mjs` (content-addressed, exact-byte verified) and
   `workspace.mjs` `/apps/*` serving; publishing via
   `scripts/plugin_publish.py`; community catalog in `plugin-catalog/`.
5. **Agent bridge + approvals** — `server/agent.mjs` (runs, history,
   approvals, stop/steer, catalog, jobs), `gateway-chat.mjs`,
   `shared-agents.mjs`/`shared-chats.mjs`, discovery/providers/profiles, and
   the Workbench gate (`workbench-gate.mjs`, `workbench-owner-route.mjs`) +
   resource authority (`resource-delegation.mjs`) as the approval surfaces;
   Collab (`collab.mjs`) as the board/approval flow for multi-agent work.
6. **Project Workbench** — the 33-module `workbench` family (7,502 LOC) plus
   `project-tools*` and `extension-studio*`: task execution, candidates,
   checks, context, setup, live activity. This is the current development
   candidate (schema 12) per `docs/PROJECT_WORKBENCH_LEDGER.md`.
7. **Observatory + campaign surfaces** — see §2.3.

### 2.2 Mass picture (code LOC, tracked files)

| Area | Files | LOC | Read |
| --- | --- | --- | --- |
| server/ | 151 | 37,581 | the product backend |
| src/ | 226 | 28,332 | the product frontend |
| contracts/ | 35 | 13,108 | the reviewed API surface |
| docs/ | 131 | ≈82,556 | contracts + history |
| tests/ | 361 | ≈59,805 | regression corpus |
| scripts/ | 37 | 3,866 | build/publish/release tooling |
| pc-launcher/ | 26 | ≈7,543 | campaign launcher + usage ledger (host tooling) |
| vendor/irc-suite | 35 | ≈3,731 | vendored ircd |
| apps/ | 6 | ≈2,206 | 4 app bundles |
| public/ | 202 | ≈285 code | recovery console + assets |
| deploy/, config/, hermes-plugin/, packages/, extensions/, contrib/, plugin-catalog/, examples/, experiments/, skills/, bin/ | ≈83 | ≈4,600 | platform + campaign infra |

The bloat is not the product core (server 37.6k + src 28.3k is a full
workspace product); it is (a) runtime-dead code (~1.4k server LOC, §5.3),
(b) one entertainment subsystem (~1.2k LOC, §5.2), (c) eight in-process
service families that the umbrella plan wants as standalone services
(§6), and (d) an operator-host tooling tail (`pc-launcher`, token export,
mobile proxy) that must not ship in the portable bundle.

### 2.3 Protected surfaces and the Observatory dependency analysis

- **Deployed Observatory** (`apps/rizzstack-observatory/`, source in
  `extensions/rizzstack-observatory/`): a static, catalog-admissible bundle
  rendering `rizzstack.observability/snapshot/1`. Its only runtime
  dependencies are (a) static serving of the bundle
  (`/apps/<slug>/…` or a content-addressed published URL), (b) the
  operator-configured snapshot URL + bearer token (in-app setting /
  plugin config), and (c) the catalog admission/publisher rules that let it
  stay installed. It calls **no** Orbit API route. Therefore every wave in
  §7 leaves the workspace app-serving chain
  (`workspace.mjs` `/apps/*`, `bundle-registry.mjs`, `builtin-apps.mjs`,
  `scripts/plugin_publish.py`, `plugin-catalog/schema.json`) untouched, and
  the Observatory survives all retirements and extractions by construction.
- **Rails proxy and decision queue**: campaign surfaces operated by the
  rizzstack workflow *outside this repository* (see
  `docs/ACDD_EVIDENCE.md` §Campaign closeout and the Observatory's
  pipeline/backlog sections it mirrors). A string scan of `server/`, `src/`
  and `apps/` at base `da82016` finds **no** in-repo rails-proxy or
  decision-queue implementation — the plan treats them as external and
  protected by abstention: no wave touches campaign ingestion
  (`contrib/rizzstack-observability/`, `pc-launcher/scripts/usage_*`),
  ACDD evidence display (`server/acdd-evidence*.mjs`), or the Observatory.
- `server/grokbots-activity.mjs` redaction is shared by the Observatory-
  adjacent ACDD evidence view; it is KEEP-PLATFORM and extracted never.

## 3. Inventory

Full per-module records (loc, family, classification, reachability, consumers,
tests, docs, gates) live in `docs/orbit-inventory.json`. Summary:

### 3.1 Server families (151 modules, 37,581 LOC)

| Family | Modules | LOC | Disposition |
| --- | --- | --- | --- |
| workbench | 33 | 7,502 | KEEP-CORE (+5 KEEP-PLATFORM gated helpers) |
| agent-runtime | 18 | 7,137 | KEEP-CORE; pi-gateway/pi-rpc EXTRACT |
| technology-surfaces | 25 | 2,729 | EXTRACT (services) or RETIRE (2 dead route files) |
| config-onboarding | 6 | 2,671 | KEEP-CORE |
| ssh-hosts | 7 | 2,662 | KEEP-PLATFORM; host-api/host-recipes/ssh-bootstrap RETIRE |
| collab | 4 | 2,646 | KEEP-CORE board+approvals; orchestrator EXTRACT |
| terminals | 7 | 1,806 | KEEP-CORE |
| workspace-state | 14 | 1,583 | KEEP-CORE; 2 legacy files RETIRE |
| grokbots | 8 | 1,513 | EXTRACT (app backend service); activity projection KEEP-PLATFORM |
| agent-ops-surfaces | 4 | 1,395 | KEEP-CORE/PLATFORM (outputs, status, ACDD evidence) |
| colab | 3 | 1,354 | EXTRACT |
| host-core | 7 | 1,168 | KEEP-CORE |
| router | 2 | 912 | EXTRACT |
| entertainment | 3 | 873 | RETIRE |
| local-workers | 3 | 534 | EXTRACT |
| irc | 1 | 494 | EXTRACT (with vendor/irc-suite) |
| resource-authority | 2 | 336 | KEEP-CORE |
| extension-studio | 2 | 175 | KEEP-CORE |
| mobile | 2 | 91 | RETIRE |

### 3.2 Apps (4)

| App | LOC | Class | Evidence |
| --- | --- | --- | --- |
| `apps/rizzstack-observatory` | 1,504 | KEEP-CORE **protected** | Deployed Observatory; static snapshot viewer; no Orbit API calls |
| `apps/grokbots` | 685 | KEEP-CORE | Built-in app installed at boot by `builtin-apps.mjs`; multi-agent chat |
| `apps/hermes-live-tools` | 11 | KEEP-CORE | Live tool feed consumed by `src/tool-feed.ts` in Activity panes |
| `apps/hermes-token-stats` | 5 | KEEP-PLATFORM | Served with `usage.json` written by `scripts/token_widget_export.py` (operator-host script, hardcoded DB path — extraction candidate for owner tooling) |

### 3.3 Top-level areas

All 24 tracked top-level areas are listed in the JSON `areas` section with
classification and a one-line reason. Highlights: `contracts/` KEEP-CORE (the
API surface); `public/` KEEP-CORE (independent recovery console);
`hermes-plugin/` KEEP-CORE (the distribution vehicle: Hermes plugin + pinned
`orbit-source.tar.gz`, parity-tested); `pc-launcher/`, `contrib/`, `vendor/`
KEEP-PLATFORM (campaign/host infra, outside the portable bundle);
`experiments/` KEEP-PLATFORM (isolated docking research, not runtime);
`docs/` KEEP-PLATFORM with archival candidates noted in §5.4.

### 3.4 src/ areas (226 files, 28,332 LOC)

| Area | Files | LOC | Class |
| --- | --- | --- | --- |
| renderer/pane-core | 22 | 4,441 | KEEP-CORE |
| workspace-state | 7 | 698 | KEEP-CORE |
| agent-chat | 29 | 4,122 | KEEP-CORE |
| workbench | 30 | 7,763 | KEEP-CORE |
| desktop-chrome | 61 | 8,495 | KEEP-PLATFORM |
| technology-surfaces UI | 44 | 4,267 | EXTRACT-PROPOSAL (follows its services; lazy-loaded, low removal risk) |
| other (integrations/shared) | 33 | 5,550 | MIXED — see JSON |

Three `src/` orphans found by import scan: `browser-copilot-pane.ts` (a
2-line re-export shim nobody imports), `saved-workspace-layouts-grid.ts`
(dead docking-grid compiler), `agent-context.css` (rules duplicated in
`style.css`). All three are RETIRE-PROPOSALs in the JSON `src_areas`.

## 4. Classification

**Counts: KEEP-CORE: 69 · KEEP-PLATFORM: 29 · EXTRACT-PROPOSAL: 41 · RETIRE-PROPOSAL: 12** (151 total).

Key evidence clusters behind the counts:

- **12 RETIRE-PROPOSALs (2,285 LOC)** — every one cites a hard signal:
  unreachable from `index.mjs` with test-only consumers
  (`host-api.mjs` 843, `host-recipes.mjs` 291, `ssh-bootstrap.mjs` 149,
  `browser-copilot-route.mjs`, `run-traces-route.mjs`), legacy code that
  refuses to run under SQLite (`checkpoints.mjs` — zero importers;
  `workspace-store.mjs` — test-only), personal deployment bindings
  (`mobile-proxy.mjs` + `mobile-security.mjs` — hardcoded workspace UUID,
  tailnet origin, Pixel node id; already excluded from the portable bundle),
  or out-of-mission entertainment (`kitty-doom.mjs` + 2 demo scripts).
- **41 EXTRACT-PROPOSALs (≈7,000 server LOC)** — all load-bearing *today*
  (wired, tested) but owned by a service boundary per §6: the eight
  technology-surface services, the grokbots app backend, colab, IRC, pi
  gateway, local workers, the router, and the collab subagent orchestrator.
- **KEEP-CORE (69)** — host core, workspace state, terminals, agent runtime,
  config/onboarding, the workbench chain, extension studio, resource
  authority, collab board/approvals, output library, plus the Observatory.
- **KEEP-PLATFORM (29)** — contracts-adjacent primitives
  (`command-identity.mjs`, `jev.mjs`, `static-cache.mjs`,
  `feature-readiness.mjs`, `release-identity.mjs`), route seams
  (`technology-owner-route.mjs`, `workbench-owner-route.mjs`), gated
  workbench helpers (`workbench-sandbox-provider.mjs`,
  `workbench-native-runtime.mjs`, `workbench-environments.mjs`,
  `workbench-registry-profile.mjs`, `workbench-publication.mjs`,
  `workbench-legacy-state.mjs`), SSH hosts UI, host audit, agent status,
  grokbots-activity, ACDD evidence, conversation private store, automation,
  build queue, run-trace tee, OpenAI-compat gateway, setup agent,
  opencode-detect, collab store/board.

## 5. Bloat report

### 5.1 Agent integrations

| Integration | Server LOC | Wiring evidence | Verdict |
| --- | --- | --- | --- |
| **Grok Bots** (`grokbots-*` ×8 + app) | 1,513 + 685 | `/api/grokbots-app{,/launch,/upload}` wired; app installed at boot (`builtin-apps.mjs`); groups engine reuses `shared-agents.mjs`; `agent-discovery.mjs` surfaces a default `grok` profile; AGENT_GUIDE/Start list it | **Load-bearing.** Keep the app + shared-room engine in core; the app backend is an EXTRACT candidate (service), and `grokbots-activity.mjs` must stay (shared with agent-status + ACDD evidence) |
| **Google Colab** (`colab-*` ×3) | 1,354 | `/api/colab-runtime` wired unconditionally; detached job-worker process; AGENT_GUIDE lists the surface | **Experiment, wired.** EXTRACT to a standalone runtime service; nothing else imports it (coupling: index.mjs only) |
| **Collab orchestrator** (`collab.mjs`, `collab-store.mjs`, `collab-orchestrator.mjs`, `collab-board.mjs`) | 2,646 | Largest server module (2,081 LOC); 7 test files; approvals (`shell.write`, review verdicts), budget gates, subagent tree; AGENT_GUIDE + WORKSPACE_USABILITY document it | **Load-bearing** — the operator approval flow. The orchestrator half (`collab-orchestrator.mjs`) is EXTRACTable; board/persistence stay |
| **Pi** (`pi-gateway.mjs`, `pi-rpc.mjs`) | 1,098 | Hosted in-process only when a Pi harness is discovered; else the profile stays out of the menu; 2 test files | **Load-bearing-lite.** EXTRACT to a standalone gateway process (profile contract unchanged) |
| **Cloud agents / remote workers** (`local-workers*.mjs` ×3) | 534 | Off unless `ORBIT_LOCAL_WORKERS=1`; Cua/OpenCode workers on a tailnet PC; feeds `collab-board` system posters | **Experiment, gated.** EXTRACT as a worker-fleet service |
| **Browser copilot** (`browser-copilot*.mjs` ×4) | 245 + 17 dead | Gated on `ORBIT_BROWSER_EXECUTABLE` + allowed origins; `/api/browser-copilot` served via `technologyOwnerRoute`; `browser-copilot-route.mjs` is an unwired duplicate | **Experiment.** EXTRACT the service; RETIRE the duplicate route file |

### 5.2 Entertainment

**Kitty DOOM** (`server/kitty-doom.mjs` 615 + `kitty-graphics-demo.py` 148 +
`kitty-terminal-probe.py` 110 + `src/kitty-doom.ts/.css` + root
`verify-kitty-doom-live.mjs` 226 ≈ **1,200 LOC total**): a DOOM bridge over
the Kitty graphics protocol, wired unconditionally (`/api/kitty-doom` HTTP +
WS upgrade) and listed in Start (`src/host-surfaces.ts`), with **no contract
document** and no feature-capability entry. It is the single clearest
out-of-mission subsystem; RETIRE-PROPOSAL (owner call, §8 D-7).

### 5.3 Auxiliary systems

| System | Evidence | Verdict |
| --- | --- | --- |
| **Uploads** (`grokbots-uploads.mjs`, 92 LOC) | Bounded uploads for the Grok Bots app; 2 test files | Load-bearing for that app; travels with the app extraction |
| **Submissions** (`conversation-private-store.mjs` 77; Workbench submission records in `workbench-data.mjs`/`agent.mjs`) | Fsynced private journals; receipts gate run recovery (`agent.mjs` `submission_status`) | **Load-bearing core** (receipt/unknown-outcome fencing) — keep |
| **Checkpoints** | SQLite checkpoints are schema-native and core; `server/checkpoints.mjs` (legacy fs store) has zero importers and refuses writes under SQLite | Core kept; legacy file RETIRE |
| **Build queue** (`build-queue.mjs` 138 + `workbench-legacy-state.mjs`) | Pinned disabled at boot (`state.enabled=false`); unknown-outcome snapshot feeds `workbench-gate` fencing | **Load-bearing for gate safety** until legacy-lane migration completes; then RETIRE with the legacy lane |
| **Mobile proxy** (`mobile-proxy.mjs`, `mobile-security.mjs`) | Hardcoded private workspace/tailnet/Pixel bindings; standalone TLS service never imported by `index.mjs`; explicitly excluded from the portable bundle | **Orphaned personal tooling** — RETIRE |
| **Host API** (`host-api.mjs`, `host-recipes.mjs`) | 1,134 LOC agent-facing hosts.run/put/deploy API reachable **only from its own tests**; real host actions flow through `ssh-hosts.mjs` under `/api/hosts` | **Orphaned** — RETIRE (fold any wanted verbs into ssh-hosts first if ever needed) |

### 5.4 Documentation tail

`docs/` holds 131 files. The reviewed feature contracts, AGENT_GUIDE and
WORKSPACE_* / PROJECT_WORKBENCH_* ledgers are load-bearing (the agent guide is
injected into workspace-aware requests). Historical research and handoff docs
(`ORBIT_EVOLUTION_*.md`, `ROUTER-RESEARCH.md`, `DOCKING_EVALUATION.md`,
`MILESTONE_*`, `WORKBENCH_CONVERSATIONAL_UX_RESEARCH.md`, …) are archival
candidates: move to `docs/archive/` (never delete) in the same wave that
regenerates `hermes-plugin/orbit-source.tar.gz`, since docs ship in the
portable archive.

## 6. Extraction plan (umbrella modularity profiles)

The umbrella modularity plan is an incremental boundary program: a small
trusted core, reversible changes, and services extracted behind tested
interfaces (ROADMAP §"finish the modular boundary"; ADRs 001/005/006/008
already define the store, recovery, bundle and resource-authority
boundaries). Four profiles share one core:

| Profile | Needs on top of the observer core |
| --- | --- |
| **P0 `observer`** — the minimal Orbit | Windows/Spatial/Focus renderer; workspace store + checkpoints + recovery + events; terminals (tmux + managed attach); catalog + app serving + sandboxed plugin lifecycle; owner-auth API + onboarding/settings; agent bridge (Hermes + configured gateways) with approvals; Outputs surface; **Observatory + campaign surfaces** |
| **P1 `workbench`** | + Project Workbench chain (execution, candidates, checks, context, setup, live, project tools, studio) |
| **P2 `studio`** | + technology surfaces as extracted services: knowledge search, documents/canvas, data lab, interactive results, voice, run traces, browser copilot, MCP Apps (+ their `/vendor/*` asset service) |
| **P3 `fleet`** | + multi-agent operations as services: collab orchestrator, Grok Bots app backend, local workers, Colab, IRC, Pi gateway, token router |

### 6.1 The seam already exists

Every extractable service is already mounted as a lazy `import()` behind one
owner-authenticated dispatch wrapper (`server/technology-owner-route.mjs` /
`server/workbench-owner-route.mjs`) with a bounded request/response contract
in `contracts/`:

```js
'/api/search': lazyTechnologyService(async () => (await import('./knowledge-index.mjs')).createKnowledgeSearch(technologyOptions)),
```

(`server/index.mjs` §technologyServices). Each service receives only
`{root, runtimeRoot, workspaceRead}` and speaks a POST-dispatch contract —
there is **no shared mutable state** between families. Extraction is
therefore a *process* boundary, not a rewrite:

1. Lift the service module + its private helpers into a standalone process
   (same dispatch schema, same owner bearer token, loopback bind).
2. Keep the Orbit route path and byte budgets identical; replace the lazy
   in-process service with an HTTP client at the same route (feature flags
   via env, defaulting to in-process until validated).
3. The frontend (`src/technology-surfaces.ts` lazy panes) and
   `featureCapabilities` need no changes — routes and contract names persist.
4. Each extraction is separately shippable and reversible; the deployed
   Observatory never calls these routes, so it cannot notice.

### 6.2 Extraction targets

| Service (standalone) | Modules that move | LOC | Notes |
| --- | --- | --- | --- |
| `orbit-search` | knowledge-index, knowledge-index-store, knowledge-embedder, knowledge-embed-worker, knowledge-chunker, knowledge-model, voice-model-assets* | 1,183 | *voice assets belong to the voice surface; keyword search needs no model |
| `orbit-documents` | documents-store, documents-canvas-assets | 171 | includes canvas assets |
| `orbit-datalab` | data-recipes, data-engine-assets | 152 | DuckDB assets provision with the service |
| `orbit-results` | interactive-results | 306 | A2UI v0.9 |
| `orbit-traces` | run-traces, run-traces-store, run-trace-project | 205 | run-trace-tee stays in core (in-process with agent runs) |
| `orbit-copilot` | browser-copilot, browser-copilot-driver, browser-copilot-evidence, browser-copilot-records | 345 | disposable browser; env-gated |
| `orbit-mcp` | mcp-apps, mcp-apps-sandbox | 179 | separate-origin proxy keeps its own loopback port |
| `orbit-assets` | technology-assets | 47 | `/vendor/*` static assets for browser engines |
| `orbit-ircd` | irc.mjs + `vendor/irc-suite` | 494 + 3,731 | loopback ircd; agent posts keep owner approval |
| `orbit-colab` | colab-orchestrator, colab-plan, colab-job-worker | 1,354 | detached worker already process-shaped |
| `orbit-pi` | pi-gateway, pi-rpc | 1,098 | gateway process; Orbit discovers `apiUrl` only |
| `orbit-workers` | local-workers, local-workers-route, local-worker-artifact | 534 | worker fleet; env-gated |
| `orbit-router` | router-supervisor, router-render + `compose.router.yml` | 912 | already compose-profile-shaped |
| `orbit-orchestrator` | collab-orchestrator (+ app backends below) | 231 | subagent spawn/limits/cost against the same board API |
| `orbit-grokbots` | grokbots-app, grokbots-groups, grokbots-prefs, grokbots-uploads, grokbots-controls-{grok,hermes,pi} | 1,325 | app backend service; **`grokbots-activity.mjs` stays in core** (shared redaction) |

Total EXTRACT mass: 41 modules ≈ 7,000 server LOC + 3,731 vendored LOC. The
native Hermes adapter (`workbench-native-runtime.mjs`) and the gVisor
sandbox provider (`workbench-sandbox-provider.mjs`) are KEEP-PLATFORM until
their gates are exercised in production; both are already process-shaped
(FD3/FD4 adapter; runsc child) and can follow the same pattern later.

### 6.3 Invariants for every extraction

- Same route path, same `contracts/*-v1` schemas, same byte budgets, same
  owner-auth (bearer + origin), loopback-only binds.
- No credentials move: services receive tokens via private runtime files, as
  today.
- Workspace store stays the only layout authority; extracted services keep
  reading via the same `workspaceRead` projection over an authenticated
  internal call, never direct DB access.
- `npm run check` plus the per-service contract tests must stay green before
  and after each move; the route smoke list (§7 guards) is part of each wave.

## 7. Retirement sequence (never breaks the deployed Observatory)

**Wave 0 — this task (done):** inventory + plan only; `tests/test_orbit_decomposition.py` guards the tree; nothing removed.

**Wave 1 — dead code (owner-approved, one PR per item group, no behavior change):**

1. `server/host-api.mjs` + `server/host-recipes.mjs` (unreachable; test-only). Move any test fixtures that still want the API shape into the test file or drop them with the tests.
2. `server/browser-copilot-route.mjs`, `server/run-traces-route.mjs` (unwired duplicates of `technologyOwnerRoute` paths; update the two test fixtures to the live seam).
3. `server/checkpoints.mjs`, `server/workspace-store.mjs` (legacy stores). Precondition: re-verify the legacy export path once (`sqlite-workspace-store.exportLegacy`) and archive the legacy migration docs.
4. `server/ssh-bootstrap.mjs` (test-only; hosts UI never sends it).
5. `server/mobile-proxy.mjs` + `server/mobile-security.mjs` (personal bindings; already outside the portable bundle).
6. Kitty DOOM (owner decision D-7): `server/kitty-doom.mjs`, the two `.py` helpers, `src/kitty-doom.ts/.css`, `verify-kitty-doom-live.mjs`, and the Start/menu entries in `src/host-surfaces.ts`/`desktop-icons.ts`.
7. `src/` orphans: `browser-copilot-pane.ts`, `saved-workspace-layouts-grid.ts`, `agent-context.css`.

**Wave-1 guards (run for every PR):** `npm run check`; route smoke — `/api/health`, `/api/auth`, `/api/workspace`, `/api/terminal` upgrade, `/apps/rizzstack-observatory/index.html` (or its published URL), one `/api/agent` POST; `python3 -m pytest tests/test_orbit_decomposition.py -q` (updates expected unreachable set as items leave); regenerate `hermes-plugin/orbit-source.tar.gz` via `scripts/bundle_hermes.py` after any server/docs change.

**Wave 2 — extraction (one service per PR, §6 mechanics):** order by
risk/value: `orbit-traces` (smallest consumer set) → `orbit-assets` →
`orbit-datalab` → `orbit-results` → `orbit-documents` → `orbit-search` →
`orbit-mcp` → `orbit-copilot` → `orbit-ircd` → `orbit-colab` → `orbit-pi` →
`orbit-workers` → `orbit-router` → `orbit-orchestrator` → `orbit-grokbots`.
The Observatory is untouched throughout (it depends only on static app
serving and its own snapshot URL).

**Wave 3 — optional slimming (owner decisions D-12/D-13):** archival docs
move; `pc-launcher` + `token_widget_export.py` + `contrib/` stay
owner-host-only (already outside the portable bundle); legacy build-queue
lane retires only after Workbench serial dispatch completes its migration
gates.

**Rollback story:** each wave is an independent revert; the Observatory's
bundle stays published under its content address, so checkpoint-referenced
assets are never invalidated (retention already protects them).

## 8. Owner decision checklist

Each line is an explicit **approve / keep** decision. Approving a RETIRE
schedules its Wave-1 PR; approving an EXTRACT schedules its Wave-2 service
PR. Nothing moves without a tick. (All 53 proposals are listed; the
`server/…` names match `docs/orbit-inventory.json`.)

**Retire proposals**

- D-1 `server/host-api.mjs` — approve retire / keep
- D-2 `server/host-recipes.mjs` — approve retire / keep (with D-1)
- D-3 `server/browser-copilot-route.mjs` — approve retire / keep
- D-4 `server/run-traces-route.mjs` — approve retire / keep
- D-5 `server/checkpoints.mjs` — approve retire / keep
- D-6 `server/workspace-store.mjs` — approve retire / keep (after export-parity re-verification)
- D-7 `server/kitty-doom.mjs` + `server/kitty-graphics-demo.py` + `server/kitty-terminal-probe.py` (+ src/verify tail) — approve retire / keep
- D-8 `server/mobile-proxy.mjs` + `server/mobile-security.mjs` — approve retire / keep
- D-9 `server/ssh-bootstrap.mjs` — approve retire / keep
- D-10 `src/browser-copilot-pane.ts`, `src/saved-workspace-layouts-grid.ts`, `src/agent-context.css` — approve retire / keep

**Extract proposals (services)**

- E-1 `server/knowledge-index.mjs`, `server/knowledge-index-store.mjs`, `server/knowledge-embedder.mjs`, `server/knowledge-embed-worker.mjs`, `server/knowledge-chunker.mjs`, `server/knowledge-model.mjs` → `orbit-search` — approve / keep in-process
- E-2 `server/documents-store.mjs`, `server/documents-canvas-assets.mjs` → `orbit-documents` — approve / keep
- E-3 `server/data-recipes.mjs`, `server/data-engine-assets.mjs` → `orbit-datalab` — approve / keep
- E-4 `server/interactive-results.mjs` → `orbit-results` — approve / keep
- E-5 `server/run-traces.mjs`, `server/run-traces-store.mjs`, `server/run-trace-project.mjs` → `orbit-traces` — approve / keep
- E-6 `server/browser-copilot.mjs`, `server/browser-copilot-driver.mjs`, `server/browser-copilot-evidence.mjs`, `server/browser-copilot-records.mjs` → `orbit-copilot` — approve / keep
- E-7 `server/mcp-apps.mjs`, `server/mcp-apps-sandbox.mjs` → `orbit-mcp` — approve / keep
- E-8 `server/technology-assets.mjs` → `orbit-assets` — approve / keep
- E-9 `server/voice-model-assets.mjs` → travels with the voice surface — approve / keep
- E-10 `server/irc.mjs` (+ `vendor/irc-suite`) → `orbit-ircd` — approve / keep
- E-11 `server/colab-orchestrator.mjs`, `server/colab-plan.mjs`, `server/colab-job-worker.mjs` → `orbit-colab` — approve / keep
- E-12 `server/pi-gateway.mjs`, `server/pi-rpc.mjs` → `orbit-pi` — approve / keep
- E-13 `server/local-workers.mjs`, `server/local-workers-route.mjs`, `server/local-worker-artifact.mjs` → `orbit-workers` — approve / keep
- E-14 `server/router-supervisor.mjs`, `server/router-render.mjs` (+ `compose.router.yml`) → `orbit-router` — approve / keep
- E-15 `server/collab-orchestrator.mjs` → `orbit-orchestrator` — approve / keep
- E-16 `server/grokbots-app.mjs`, `server/grokbots-groups.mjs`, `server/grokbots-prefs.mjs`, `server/grokbots-uploads.mjs`, `server/grokbots-controls-grok.mjs`, `server/grokbots-controls-hermes.mjs`, `server/grokbots-controls-pi.mjs` → `orbit-grokbots` — approve / keep

**Keep decisions confirmed by this inventory** (no action needed, listed for
completeness): the workbench family, terminals family, workspace-state
family, agent runtime family, config/onboarding family, resource authority,
collab board/approvals, extension studio, output library, ACDD evidence view,
agent status, `apps/grokbots`, `apps/hermes-live-tools`,
`apps/hermes-token-stats`, and everything in `contracts/`, `public/recovery.*`,
`hermes-plugin/`.

**Protected (out of scope for any wave):** `apps/rizzstack-observatory/`,
`extensions/rizzstack-observatory/`, `contrib/rizzstack-observability/`,
`pc-launcher/scripts/usage_*`, the external rails proxy and decision queue.

## 9. Verification, limits, open issues

- `python3 -m pytest tests/test_orbit_decomposition.py -q` — validates the
  inventory against the live tree: 151-module set equality, exact LOC,
  recomputed `index.mjs` import closure vs. the claimed unreachable set,
  route wiring, protected-surface presence, family sums, and full
  RETIRE/EXTRACT coverage in this document.
- **Limit:** no live deployment was inspected (not mounted here); usage
  evidence is wiring/gate/deploy-manifest based. Before Wave 1, re-run the
  route smoke on the deployed host and confirm no process imports the
  retired modules at runtime.
- **Open issues:** (1) `agent-context.mjs` (398 LOC) has no dedicated test —
  add one before any agent-runtime change; (2) the collab surface note in the
  JSON lists its pane identity rather than an HTTP route (collab is reached
  via `orbit://surface/collab` + agent APIs); (3) Wave-1 item 6 requires a
  Start/menu edit outside `server/` — coordinate with a `src/` test refresh;
  (4) `tests/test_orbit_decomposition.py` pins `EXPECTED_SERVER_COUNT = 151`
  and must be updated in the same PR as any accepted retirement.
