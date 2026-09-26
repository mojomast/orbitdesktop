# Comet Project Workbench

## Current increment: Slice A — project inspection

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

## Capability matrix

| Capability | Current status / boundary |
| --- | --- |
| Explicit root registration | Owner Bearer + allowed Origin/Host; expiring server-issued preview bound to root inode identity and workspace; no caller actor or `confirm` bypass |
| Revoke project access | Generation-checked, persistent disable of owner Workbench reads; late results fenced; fresh preview required to re-enable |
| Stable projects/resources/bindings | Versioned records in SQLite schema 5; opaque UUIDs; separate from layout v1; whole-workspace sync cannot erase them |
| File tree / literal text / ranges | Implemented with bounded descriptor-relative reads; never rendered as HTML |
| Repository status / readable diff | Bounded private materialization; tracked dirty/deleted and untracked text; explicit exclusions and unsupported states |
| Linked terminals/conversations/browser panes | Metadata-only association with existing pane identity; no mounting, navigation, capture, permission or session change |
| Doctor | Build/schema/support/recovery facts; gateway compatibility not probed without authorized fixture configuration |
| Task/job/artifact shelf | Honest empty/not-enabled state in this slice; existing Hermes serial queue is not represented as recorder-verified work |
| Context tray / model disclosure | **Not enabled — Slice B pending**; terminal observe leases are not model-sharing consent |
| Candidate patches / managed jobs / evidence / review | **Not enabled — Slice C pending**; no unconnected second scheduler |
| Investigate / Implement / Review recipes | **Slice D pending**; no automatic rearrangement |
| Real Hermes smoke gate | **Pending separately permitted endpoint/credentials/budget**; no mock is claimed as real integration |

This is the first integrated slice, **not completion of the full Project Workbench
mission**. The current ledger is [PROJECT_WORKBENCH_LEDGER.md](PROJECT_WORKBENCH_LEDGER.md).

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
  slice. Pending context sharing requires its own recipient and destination policy.

## Storage, upgrade and rollback

Schema 4 → 5 adds `wb_projects`, `wb_resources`, and `wb_bindings` transactionally
inside the existing workspace database. IDs remain stable across restart. These
tables are authoritative project metadata, not another workspace store; no file
body is persisted here. File contents remain in the approved provider root.
Bindings are metadata only; layout checkpoints neither restore nor revoke them.
They never grant access or replay a task. No grants exist for this slice.

Stop writers only under a separately authorized session-preserving operator plan.
Back up the schema-4 database before upgrade; test a copy. SQLite backup includes
the new tables after upgrade. To return to the older binary, restore the compatible
pre-upgrade backup into a **new** runtime with `restore --preserve-schema`. This
does not down-convert schema 5. Older schema-4 binaries refuse schema 5. Old and
new writers must not run concurrently. See [DEPLOYMENT.md](DEPLOYMENT.md).

No owner runtime was migrated as part of development. A newly built frontend needs
a reload at its separately authorized test origin; source changes alone are not
deployment acceptance.
