# Comet Project Workbench

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
schema, renderer support, unavailable agent-tool binding, and recovery scope.
Server build identity hashes server and contract `.mjs` sources (excluding the
owner-specific mobile proxy); it is not a hash of configuration or credentials.
Worktree content has a separate manifest hash; Git HEAD alone is never represented
as the identity of a dirty candidate.

## Share the work you are looking at

Select file lines and click **Ask agent about this**, or use the diff's sharing
button. For a linked terminal, explicitly adopt it and grant an observe lease
through **Managed…**, then choose **Ask agent about this terminal** in its
Workbench binding. Managed-job results also have an Ask-agent action.

The context tray captures one bounded snapshot, then previews its literal bytes,
hash, provenance and selected profile/conversation. Choose a matching task attempt
when applicable. Remove/narrow and capture again if the selection is wrong. A
changed file is rejected against its expected hash, not silently substituted.
Approval binds the exact snapshot and current recipient binding/configuration;
**Share once** sends those bytes. This is a one-snapshot-per-submission tray, not
an arbitrary multi-resource model browsing grant.

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

The local end-to-end bridge is **owner-reviewed patch application**: an agent can
propose changes in the selected conversation, and the owner applies them through
the expected-hash candidate editor or structured proposal form. Reusable native
agent editing/job tools remain blocked pending secure request-scope integration.
Automatic integration into the original worktree is not implemented; review the
candidate diff and use an explicitly authorized integration procedure. Changed
source targets require fresh review rather than overwriting owner changes.

**Cancel job**, **Stop agent**, **Revoke project access**, and recovery/plugin hold
have distinct meanings. Cancellation is not confirmed termination. Revocation
does not kill a running job or undo prior effects. Restart restores records and
marks lost dispatch/process ownership unknown; it does not reissue approvals or
automatically replay jobs. Unknown-outcome acknowledgement must be explicit.

## Capability matrix

| Capability | Current status / boundary |
| --- | --- |
| Explicit root registration | Owner Bearer + allowed Origin/Host; expiring server-issued preview bound to root inode identity and workspace; no caller actor or `confirm` bypass |
| Revoke project access | Generation-checked, persistent disable of owner Workbench reads; late results fenced; fresh preview required to re-enable |
| Stable projects/resources/bindings | Versioned records in SQLite schema 6; opaque UUIDs; separate from layout v1; whole-workspace sync cannot erase them |
| File tree / literal text / ranges | Implemented with bounded descriptor-relative reads; never rendered as HTML |
| Repository status / readable diff | Bounded private materialization; tracked dirty/deleted and untracked text; explicit exclusions and unsupported states |
| Linked terminals/conversations/browser panes | Metadata-only association with existing pane identity; no mounting, navigation, capture, permission or session change |
| Doctor | Build/schema/support/recovery facts; gateway compatibility not probed without authorized fixture configuration |
| Task/job/artifact shelf | Private SQLite task/attempt/job/evidence records and bounded log artifacts; legacy queue coordinates through the shared dispatch gate |
| Context tray / model disclosure | One-shot recipient-bound review/approval, durable immutable requests and receipts; terminal observe leases are not model-sharing consent |
| Candidate patches / managed jobs / evidence / review | Owner-approved private candidate, expected-hash edits, serial tracked checks, recorder evidence, exact-candidate human decision |
| Agent-managed resource tools / automatic integration | Blocked/unsupported; manual supervised bridge and explicit integration boundary |
| Investigate / Implement / Review recipes | **Slice D pending**; no automatic rearrangement |
| Real Hermes smoke gate | **Pending separately permitted endpoint/credentials/budget**; no mock is claimed as real integration |

This increment adds B/C mechanics but **does not establish real-Hermes tool
acceptance or complete the full Project Workbench mission**. Current verification
and pending gates are tracked in [PROJECT_WORKBENCH_LEDGER.md](PROJECT_WORKBENCH_LEDGER.md).

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
  copied. No package or repository script executes. Linked worktrees whose `.git`
  points elsewhere are conservatively unsupported pending an approved common-dir
  mapping; ordinary document projects remain usable.
- Diff identity binds Git HEAD, captured manifest and returned diff. Excluded
  paths do not enter the diff; absence in an incomplete scan is not a deletion.
  Deleted files have HEAD content, not fictional current bytes. Files/history may
  change after capture; captures are observations, not adversarial attestation.
- `/api/workbench` is owner-only and `no-store`; workspace-controller capabilities
  cannot read it. IDs are not bearer secrets. No file/diff payload enters public
  `/apps`, layout state, generic workspace events, diagnostic logs, or plugins.
- Same-UID host processes can bypass API controls. This is **not a sandbox**, and
  worktrees do not isolate execution. No reusable model tool is enabled by this
  increment. Context sharing requires its own recipient and destination policy.

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
claims are process-local and cannot be restored from layout checkpoints.

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
does not down-convert schema 6. Older schema-5 binaries refuse schema 6. Old and
new writers must not run concurrently. See [DEPLOYMENT.md](DEPLOYMENT.md).

No owner runtime was migrated as part of development. A newly built frontend needs
a reload at its separately authorized test origin; source changes alone are not
deployment acceptance.
