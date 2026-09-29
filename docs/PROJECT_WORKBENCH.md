# Comet Project Workbench

## Locked TypeScript test profile

The RouteTok-compatible profile preserves the project's npm v3 lock and includes
exactly the declared development toolchain (`tsx`, `typescript`, `@types/node`).
It supports `tsx --test "test/**/*.test.ts"`, without root runtime dependencies,
workspaces, overrides, peer/optional/bundled root dependencies, or install hooks.
Every locked artifact must have SHA-512 integrity and resolve to HTTPS
`registry.npmjs.org`. Transitive platform-optional packages are selected by npm.

Preparation requires a dedicated owner-provisioned mode-0700 npm cache selected
by `ORBIT_WORKBENCH_NPM_CACHE`. Cache provisioning/download is a separate operator
operation, not a worker tool. Only `_cacache` is copied into a private preparation
directory. The approved command is `npm ci --include=dev --offline --ignore-scripts
--no-audit --no-fund --no-package-lock=false`, under the existing timeout. Cache
misses fail; there is no online fallback, ambient HOME/npmrc, or shared dependency
mount. Lifecycle scripts stay disabled, including esbuild's install script; its
locked platform binary is used directly. The preview identifies the complete
artifact list, lock and toolchain hashes, cache path and exact command.

The managed Node runner discovers `test/**/*.test.ts` and imports tsx only from
the verified candidate execution view. Its structured test protocol and complete
required-file checks remain authoritative. Transpile caching is disabled; no
generated candidate outputs are permitted. Executable bits are retained for the
locked esbuild binary and included in dependency identity. This lane permits
16 MiB dependency files and 128 MiB total dependency bytes; source-capture limits
are unchanged. The older local-tarball lane retains its previous limits.

After preparing dependencies, preview and approve **Required checks** to bind the
profile before baseline execution. Create fresh tasks after deployment: a check
definition binds the installed runner, so old acceptance contracts may be stale.
This remains trusted-host execution, not an OS sandbox or arbitrary npm-script
support. Type checking/building are not implied by the test profile.

## Project inspection, one-shot sharing, and supervised candidate checks

Open **Project Workbench** from the normal Orbit menu / workspace tools. No special
URL or docking flag is required. Unlock the host, select **Register project**,
enter an explicit absolute root and name, and review the bounded observation
policy. Registration requires a second owner action against an expiring preview.
It does not run a package script, connect a terminal, or send anything to Hermes.

Select the registered project to see its bounded file list, worktree manifest,
Git status/diff, content identities and timestamps. Select a file for literal text
and a line range; refresh explicitly when you need a newer capture. A changed file
is marked stale relative to its prior resource content. Binary/large/unsupported
files have explicit unavailable/exclusion states, not an executable preview.
Link an existing pane as metadata without replacing its terminal, iframe or chat.
The link is not permission to capture output or disclose it to a model.
**Revoke project access** blocks future Workbench reads and fences late inspection
results. It invalidates pending registration previews and persists across restart;
previously displayed bytes cannot be recalled. Restore owner observation only with
a fresh registration preview/confirmation. Files, panes, jobs and layout are not
changed. This registration policy is not a reusable model grant.

The Doctor panel reports frontend index and server-source build hashes, store
schema, renderer support, native adapter configuration, dispatch health and recovery scope.
Server build identity hashes server and contract `.mjs` sources (excluding the
owner-specific mobile proxy); it is not a hash of configuration or credentials.
Worktree content has a separate manifest hash; Git HEAD alone is never represented
as the identity of a dirty candidate.

## Share the work you are looking at

Select file lines and click **Ask agent about this**, or use the diff's sharing
button. For a linked terminal, explicitly adopt it and grant an observe lease
through **Managed…**, then choose **Ask agent about this terminal** in its
Workbench binding. Managed-job results also have an Ask-agent action.

The context tray captures bounded snapshots, then previews their literal bytes,
hash, provenance and selected profile/conversation. Choose a matching task attempt
when applicable. Remove/narrow and capture again if the selection is wrong. A
changed file is rejected against its expected hash, not silently substituted.
Approval binds the exact snapshot and current recipient binding/configuration;
**Share once** sends those bytes. Use **Choose more sources** and **Add snapshot**
to combine up to eight captured file ranges, a diff and job results. Enter a
**Task or question**; the packet structurally separates that owner request from
untrusted source content. Duplicate identical captures are removed, aggregate
byte limits apply, and preview never rereads changed source bytes. This remains
bounded disclosure, not ambient project access.

An observe lease only authorizes owner capture. Disclosure is separate. The
configured Hermes gateway controls downstream provider routing; this is trusted
host execution, not a sandbox or a promise of a fixed downstream provider. The
preview states the destination policy. Context is data, never approval to execute
commands embedded in a log. No reusable agent resource/job tool is enabled without
a securely authenticated runtime-request binding.

**Activity and disclosures** shows receipt/submission states, reconciliation and
**Stop agent**. Unknown upstream outcomes stay unknown; a missing run does not
authorize replay. Stop is a request until upstream confirms a terminal state.
Revocation blocks future delivery; it cannot recall content already retained in a
conversation. Intervention remains available after project revocation.

## Work on an approved candidate and review observed evidence

In **Managed execution**, create a task with a profile/session and versioned
acceptance statement plus an allowlisted check definition. Preview and approve a
private candidate copy of the bounded project manifest. Edits apply only inside
that candidate, against an expected file hash; the original project is not edited.
The selected profile/session on a task is an owner-declared target, not authority:
sharing additionally resolves and checks the actual live conversation binding.

Preview the exact check, candidate identity, limits and acceptance version, then
explicitly run it. Jobs are serial and use real owned subprocesses rather than
typing into interactive terminals. Available checks include a Node test invocation
and a host-owned synthetic `math.js` sum regression. The latter demonstrates the
known-defect acceptance lane; it is not a general test oracle for every project.

Recorded exit results, candidate hashes, check-definition hashes, timestamps,
bounded log artifacts and environment fingerprints form evidence. A completion
phrase is never evidence. Changed candidates, revoked late results and unknown
process outcomes do not become verified. Review acceptance/rejection is bound to
the exact candidate and evidence set; accepting does not merge or deploy.

The native path uses **Task authority and execution environment**. Create a bound
attempt for the selected candidate/conversation, capture its task packet, then
preview and approve bounded candidate reads/edits, exact context reads and approved
checks. **Start native Hermes attempt** launches a dedicated pinned runtime with
only the Workbench toolset. Private authenticated channel scope is supplied outside
model arguments; the model cannot select a project/attempt, grant authority or run
an arbitrary shell command. Multi-file create/change/delete uses expected hashes
and copy-on-write publication. The manual proposal bridge remains compatibility UI.

**Start check in background** returns a durable job ID; closing the panel does not
own execution. **Run check** retains the older awaited compatibility path. Node
tests use a separate structured runner channel, not printed summaries. Empty,
skipped-only, missing, malformed or truncated results cannot pass. **Select complete
current evidence** selects the latest matching result for every required check;
the server rejects incomplete or stale sets even if the client selects old passes.

After exact human review, **Preview integration** / **Approve integration** creates
a new private two-commit Git repository and branch: captured source base followed
by the reviewed candidate. This is an independent integration artifact, **not an
ancestry-preserving branch in the original repository**. Its path and commit IDs
are returned to the owner. Original-worktree writes, merge, publication and
deployment remain separate and unavailable from this action. Changed source targets
require fresh review; unrelated original changes are never overwritten.

**Cancel job**, **Stop agent**, **Revoke project access**, and recovery/plugin hold
have distinct meanings. Cancellation is not confirmed termination. Revocation
does not kill a running job or undo prior effects. Restart restores records and
marks lost dispatch/process ownership unknown; it does not reissue approvals or
automatically replay jobs. Unknown-outcome acknowledgement must be explicit.

## Capability matrix

### Trusted candidate Review view

The normal project execution panel has **Open candidate Review view**. This
explicit owner action creates one browser-kind workspace pane, or selects the
existing pane bound to that project. It does not create another terminal or
agent session. Its fixed `orbit://workbench-review` URL carries no credentials,
project identifiers or permissions: the host resolves the durable
`candidate_diff` binding in the current authenticated workspace. An unbound pane
shows a binding prompt; revoked bindings do not disclose review content.

The trusted view presents the recorded candidate comparison, required checks,
human decision and literal worker explanation as separate areas. Source and
candidate identities remain explicit. Refresh revalidates the scope and recorded
identities; model text is never evidence. A verified patch export is a separate
owner action and does not authorize modifying or merging into the original tree.

| Capability | Current status / boundary |
| --- | --- |
| Explicit root registration | Owner Bearer + allowed Origin/Host; expiring server-issued preview bound to root inode identity and workspace; no caller actor or `confirm` bypass |
| Revoke project access | Generation-checked, persistent disable of owner Workbench reads; late results fenced; fresh preview required to re-enable |
| Stable projects/resources/bindings | Versioned records in SQLite schema 10; opaque UUIDs; separate from layout v1; whole-workspace sync cannot erase them |
| File tree / literal text / ranges | Implemented with bounded descriptor-relative reads; never rendered as HTML |
| Repository status / readable diff | Bounded private materialization; tracked dirty/deleted and untracked text; explicit exclusions and unsupported states |
| Linked terminals/conversations/browser panes | Metadata-only association with existing pane identity; no mounting, navigation, capture, permission or session change |
| Doctor | Build/schema/support/recovery facts; gateway compatibility not probed without authorized fixture configuration |
| Task/job/artifact shelf | Private SQLite task/attempt/job/evidence records and bounded log artifacts; legacy queue coordinates through the shared dispatch gate |
| Native worker explanation | Bounded public Hermes `final_response` over a separate versioned channel; durable owner-scoped receipt, typed unavailable states, DB-only recovery; never inferred from stdout or a completion marker |
| Check provenance | Authenticated initiator, approval authority and service recorder are distinct; legacy uncertainty remains explicit; explanation claims cannot change recorded verdicts |
| Conversation result delivery | Explicit owner action creates a host-authored, recipient-bound card outside chat history; no model request; retained cards survive reload subject to current scope and retention |
| Per-pane Normal / Workbench views | Persistent presentation preference in both renderers; independent conversation and supervised-worker timelines; view switches preserve DOM/session/draft and grant identity without dispatching inference |
| Conversation task handoff | Explicit frozen preview of selected excerpts and task statement; private snapshot and selectable context packet; binding/hash revalidation; no automatic whole-conversation disclosure |
| Private live activity | Owner-authenticated fetch-SSE, bounded sidecar projection, monotonic cursors and retained replay; incomplete history labelled; observability never authorizes execution |
| Live output and exact references | Focused inode-pinned bounded job tail is unverified; retained generation/hash comparisons, structured recorder counts, human review and artifact verification remain distinct |
| Shared lane and hidden activity | Server-derived busy/unknown state blocks conflicting immediate dispatch; drafts and read-only inspection remain available; no automatic cross-mode queue or replay |
| Recorded result references | Only same-scope, server-resolved evidence links; exact retained candidate versions are read by generation/hash, with no substitution of newer content |
| Context tray / model disclosure | One-shot recipient-bound review/approval, durable immutable requests and receipts; terminal observe leases are not model-sharing consent |
| Candidate patches / managed jobs / evidence / review | Owner-approved private candidate, expected-hash edits, serial tracked checks, recorder evidence, exact-candidate human decision |
| Linked worktrees | Explicit owner-reviewed visible root, worktree Git directory and common directory; relationships revalidated; private read-only metadata copy |
| Native agent tools | Dedicated pinned Hermes process, private authenticated attempt channel and existing candidate/check providers; validated local endpoint or the specifically authorized DeepSeek endpoint/model, never arbitrary providers |
| Dependency-bearing Node projects | Approved offline lockfile-v3/local-tarball preparation, lifecycle scripts disabled, private copied dependencies; no arbitrary package command or online install |
| Required check aggregation | Versioned complete set; latest matching structured results for exact candidate/profile; acceptance revision explicitly approved |
| Integration | Explicit independent private two-commit repository/branch; in-place original integration unavailable |
| Reviewed patch transfer | Private authenticated Git-compatible diff plus source/candidate/review/check/mode manifest; disposable exact-base round trip and separate frozen artifact checks before publication, including approved prepared dependency profiles; unsupported modes and binary changes fail explicitly |
| Dependency-backed artifact execution | Fresh private view of patch-applied source plus copied, revalidated prepared dependencies; independent recorder evidence binds profile, toolchain, dependency, acceptance and artifact identities; no export-time installation or online fallback |
| Acceptance readiness | Read-only server validation exposes changed definitions and stale profiles before admission; no automatic migration of historical acceptance |
| Investigate / Implement recipes | Explicit role-prioritized window-order preview/apply and revision-checked return |
| Review arrangement | Explicit measured-viewport preview/apply for the project-bound trusted Review window; updates its frame and Docking float placement, preserving unrelated placements; Return restores the prior arrangement only at the exact applied revision |
| Actual Hermes / simulated model | Pinned runtime/plugin/private bridge/provider journey tested; model-protocol fixture does not establish model reasoning |
| Real-model and live deployment gates | The separately authorized isolated RouteTok repair/export passed; live-view acceptance is a separate exact-release gate. Existing owner deployments are not implicitly upgraded. See [real-project evidence](REAL_PROJECT_EVALUATION.md) |

Current verification, remaining scope limits and release gates are tracked in
[WORKBENCH_AGENT_LOOP_LEDGER.md](WORKBENCH_AGENT_LOOP_LEDGER.md). Source completion,
deterministic acceptance, real-model acceptance and live deployment are distinct.

### Durable workspace arrangements (schema 9 backend)

The Project Inspector also exposes [persistent project tools](PROJECT_TOOLS.md):
trusted notebook instances and recorded checks/review cards. Their additive
schema-10 storage and owner-only route are separate from arrangements and native
worker authority. Saving notes changes private data revisions, not layout state.

Schema-9 durable arrangement proposals and portable role recipes are implemented in
the backend. `recipe_preview` stages an exact output state and placement, binds the
preview digest to its source/target scope, live bindings and measured viewport, and
returns a semantic diff. The owner workflow uses owner bearer/origin authentication;
the Normal route uses the workspace-scoped controller capability. The route assigns
the actor, never accepts one from the request, and the target project must be active
in the authorized workspace. `recipe_apply` revalidates authorization and versions and
commits workspace state, placement, pre-change checkpoint, proposal status and
actor-scoped receipt in one transaction. Exact same-actor retries replay the saved
result; different actors do not share receipts. `Return` restores the precise
checkpointed state and placement only when workspace revision still equals the
source arrangement's committed revision.

Saved definitions contain only name, roles, layout and renderer. Source-project
ownership is retained; a saved recipe can be reused in another project only by
resolving roles against that target's actual bindings, with explicit choices for
ambiguity. Roles/layouts remain data-free arrangement constraints; they do not
authorize resource access or expose resource contents. Direct small workspace
operations remain available. Limits are 32 recipes per workspace, 200 proposals
per project with newest-first pagination of 32, and 512 append-only actor-scoped
recipe-save receipts per workspace. See [Workspace arrangements API](WORKSPACE_ARRANGEMENTS_API.md)
for request, authorization, expiry, viewport, geometry and retry semantics.

The backend contract is implemented; frontend/browser acceptance remains a
separate gate. Legacy-layout import is only window-order-to-role-order constraint
conversion, not exact geometry migration. It reports omissions for pixel frames,
scaling, minimized/selected state and camera, keeps the original local layout, and
requires preview plus durable save before marking import successful. This helper
does not establish a completed UI import journey.

## Confinement, bounds and privacy

- Linux `/proc` descriptor paths plus `O_NOFOLLOW` on every path component are
  required. No realpath-precheck/unchecked-reopen fallback. Reads revalidate the
  complete path chain before releasing bytes. Symlinks, multiply linked files,
  special files and replaced root identities fail closed.
  Names containing the UTF-8 replacement character are conservatively excluded
  so malformed byte names cannot alias a different identified resource.
  Device/inode identity detects ordinary replacement but is not proof against
  inode reuse (ABA) or a privileged adversary. It is not filesystem isolation.
- Limits: 512 enumerated entries per directory, 2048 entries / 128 directories
  globally per capture, 512 captured files, depth 12,
  256 KiB per file, 8 MiB total file bytes. Exclusions and incomplete capture are
  visible. Capture rechecks included file hashes; a concurrent change can reject
  the whole capture as stale rather than report a coherent snapshot falsely.
- Defaults exclude `.git` from previews, `.env`/`.env.*`, key/certificate files,
  `.runtime`, `.ssh`, `.aws`, `.gnupg`, dependency/build/cache directories. These
  exclusions are **not a secret scanner**; project text can still be sensitive.
- Git runs only in a private, bounded copy (32 MiB Git metadata / 4096 entries,
  depth 20), with no inherited credentials. Fixed raw-object Git reads—not
  `git status` or `git diff`—plus `/usr/bin/diff` produce content-only status and
  unified diffs. `.gitattributes`, index staging and executable-bit changes are
  excluded explicitly. Oversized historical blobs are not read, and both old
  and new binary contents are withheld even if attributes request a text diff.
  `/usr/bin/prlimit` is required: each helper has a 256 MiB address-space limit,
  5 CPU seconds and 64 open descriptors. The whole repository observation has
  a 10-second deadline, at most 5 seconds per command, 128 compared paths and
  256 KiB diff output. Missing required helpers disables repository inspection,
  not ordinary file previews. At most two inspections run concurrently; HTTP
  responses are bounded to 2 MiB. These are not filesystem or network sandboxes.
  Git config, hooks, object alternates and filter/textconv configuration are not
  copied. No package or repository script executes during inspection. Linked
  worktrees require both metadata directories in the owner registration preview;
  unapproved `.git` mappings remain unsupported. Sparse/submodule/LFS/reftable
  metadata is rejected rather than reported as a normal complete repository.
- Diff identity binds Git HEAD, captured manifest and returned diff. Excluded
  paths do not enter the diff; absence in an incomplete scan is not a deletion.
  Deleted files have HEAD content, not fictional current bytes. Files/history may
  change after capture; captures are observations, not adversarial attestation.
- `/api/workbench` is owner-only and `no-store`; workspace-controller capabilities
  cannot read it. IDs are not bearer secrets. No file/diff payload enters public
  `/apps`, layout state, generic workspace events, diagnostic logs, or plugins.
- Same-UID host processes can bypass API controls. This is **not a sandbox**, and
  worktrees do not isolate execution. Native tools enforce attempt scope at the
  API boundary; dedicated runtime toolsets disable bypass tools, not host syscall
  access. Context sharing requires its own recipient and destination policy.

### Execution and retention limits

The approved managed-check lane is **trusted host execution**: Node tests and
imported project modules execute code as the service UID. They can bypass API
confinement through ordinary host filesystem/network access. A private candidate
and hashes do not provide adversarial attestation. The host-owned check cannot be
changed through the candidate-edit API, but hostile same-UID code is outside that
guarantee. Do not label the lane sandboxed.

Check definitions publish their enforced duration, output/preview limits and
serial-concurrency limit. A fixed external timeout supervisor bounds the command
while it waits, even if the recorder disconnects. Detached descendants can outlive
the leader: detected group survival is inconclusive and never a confirmed cancel
or pass; arbitrary escaped host processes are not contained. Bounded recorder
output is not a filesystem quota on project code, nor CPU/memory/network isolation.
Unknown child ownership is never silently attached to or signalled through a
reused PID. Private temporary cleanup is descriptor-relative and budgeted; files
can be retained when safe cleanup cannot complete.

Context payload retention defaults to 24 hours, configurable with
`ORBIT_CONTEXT_RETENTION_MS` within bounded limits. Expired payloads are removed
from active records while hashes/receipts remain. This does not recall sent
conversation content or cryptographically erase old SQLite pages, WALs or backups.
Treat all runtime backups as private. Previews, approvals and runtime execution
claims are process-local and cannot be restored from layout checkpoints. Durable
native consent records are fenced after restart rather than reissued. Retention
inventory exposes reference counts and a dry-run plan; automatic artifact deletion
is not implemented. Native homes, copied dependency environments and integration
stages remain private retained artifacts, including incomplete/unknown operations.

### Explicit local Hermes configuration

The shipped adapter pins Hermes commit
`d0288be5b3330d2442e3907185b8e9d0958297bb` (Python 3.14.3 in deterministic tests).
Bootstrap the pinned source using its `uv.lock` with
`uv sync --frozen --python 3.14 --no-default-groups`. Configure only an isolated
authorized instance with `ORBIT_NATIVE_HERMES_SOURCE`, `ORBIT_NATIVE_HERMES_PYTHON`,
`ORBIT_NATIVE_HERMES_MODEL_URL` (numeric-loopback HTTP endpoint, or exactly
`https://api.deepseek.com/v1` for explicitly authorized hosted inference),
`ORBIT_NATIVE_HERMES_PROFILE`, optional `ORBIT_NATIVE_HERMES_MODEL`, and optional
`ORBIT_NATIVE_HERMES_API_KEY_FILE` for a private endpoint credential. Hosted
DeepSeek requires that file and explicit model `deepseek-flash`; fixture defaults
cannot authorize remote inference. Consent identifies the hosted destination and
binds the credential fingerprint. Provider charges and packet/tool-result
disclosure require owner authorization; task budgets are not monetary caps. The file
must be an absolute path to a same-UID regular single-linked file with no
symlink path component, mode denying all group/other access, and 1–4096 bytes
of UTF-8 text (one final newline is allowed). The service snapshots it once at
startup for both consent identity and runtime authentication. Editing the file
does not change a running service's binding; restart after an authorized rotation
and obtain fresh consent to bind the new secret fingerprint. An invalid selected
file fails configuration rather than falling back to the fixture key. The secret
is sent only through the private FD3 runtime input, not arguments, environment,
consent metadata or logs. Without the file the local fixture key remains the
default; no real endpoint credential is assumed.
The selected ordinary pane binding must match that profile/session. The native
adapter uses a fresh private Hermes database, not that gateway's existing history.
Its endpoint/model/configuration hash is shown in consent. Only explicitly granted
context is read; no owner bearer token is given to Hermes. A loopback endpoint is
not proof that the service behind it has no external billing or network access.

For dependency-bearing checks, approve/prepare the offline environment, then
**Preview required checks** and **Approve required checks** to bind it to the full
versioned acceptance set. Lock-stable source edits can reuse prepared dependencies;
changed lockfile/toolchain/dependency inputs require new approval. This lane supports
source-contained locked tarballs and no generated source outputs. Required inputs
outside bounded capture, online registries, arbitrary package scripts and general
build-output profiles are explicit unsupported cases, not verified reproduction.

Configured owner tokens are no longer printed at startup. If no token is supplied,
the generated bootstrap credential is written to the private runtime `session-token`
file (0600), not the journal. Existing exposed credentials still require an
operator-authorized rotation; changing logging does not rotate deployed tokens.

## Storage, upgrade and rollback

Schema 4 → 5 added `wb_projects`, `wb_resources`, and `wb_bindings`; schema 5 → 6
adds private task, attempt, context, disclosure, submission, candidate, job,
evidence and review tables transactionally in that same database. Opaque IDs
remain stable. Context payloads and immutable submission requests are private
application records, not layout fields. Candidate files and job logs live under
the private runtime; SQLite backup alone does not copy those external artifacts.
Back them up consistently when preserving complete job evidence.
Schema 6 → 7 added grants/tool calls/profiles/integrations/annotations and unique
operation indexes. Existing conflicting job operation keys fail migration rather
than deleting historical receipts. Restore a copy for operator investigation.
Backup scope includes candidate generations, check/finalization journals,
dependency environments, native private homes and integration stages alongside
SQLite; exclusions must be explicit. Native channel credentials must not be
reactivated from backups.

Layout checkpoints neither restore these records nor grant permissions or replay
tasks. Whole-workspace sync cannot erase the new tables. The legacy queue remains
its existing durable writer behind a shared dispatch gate; pending/unknown tasks
are preserved, not silently imported into a competing scheduler. Completion
markers are annotations, and completion pauses for review rather than establishing
verification or automatically advancing the next task.

Stop writers only under a separately authorized session-preserving operator plan.
Back up the compatible pre-upgrade database before upgrade; test a copy. SQLite backup includes
the new tables after upgrade. To return to the older binary, restore the compatible
pre-upgrade backup into a **new** runtime with `restore --preserve-schema`. This
does not down-convert schema 7. This is a historical upgrade note: the current
source baseline is schema 10, with schema 9 the immediately preceding baseline.
Older binaries refuse newer schemas. Old and new writers must not run concurrently.
See [DEPLOYMENT.md](DEPLOYMENT.md).

No owner runtime was migrated as part of development. A newly built frontend needs
a reload at its separately authorized test origin; source changes alone are not
deployment acceptance.
## Hermes pane live view

Hermes panes expose persistent Normal / Workbench view selection. Workbench mode
supervises a separate restricted Hermes runtime; it does not turn the ordinary
conversation into that worker. Context disclosure, native authority, review and
artifact verification retain their independent approvals and identities.

See [Hermes live view](HERMES_LIVE_VIEW.md) for the authority labels, explicit
conversation snapshots, private replay transport, detail boundaries and recovery
semantics. Visual mode and selected durable IDs are browser presentation state,
not a grant or a replacement for server freshness checks.
