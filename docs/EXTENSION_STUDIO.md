# Extension Studio — first focus-timer profile

Open **Workspace plugins → Extension Studio**. The first profile is a finite local
focus-timer generator selected by the owner. It does not invoke a model, accept
arbitrary HTML/JavaScript, run an installer, or read project files. Hermes-authored
artifacts require a separately reviewed future profile.

## Owner journey

1. Describe the timer with a plugin ID, public title, version, default duration
   (1–180 minutes) and accent color. **Generate draft** publishes three exact,
   content-addressed files through the existing publisher. Titles/source are public
   static assets; never use them for private notes or credentials.
2. **Check and preview** verifies the complete three-file inventory and byte hashes
   against the finite generator. The report is explicitly **structural**, with
   `runtime_tested:false`. Inspect the actual sandboxed timer's Start/Pause/Reset
   behavior; loading a document is separate from testing it or approving it.
3. **Prepare install review** persists the exact proposed layout, workspace
   revision, artifact/check digests, prior release and preserved public configuration.
   It expires after 60 seconds. Existing external-backend plugin identities refuse
   this profile rather than silently changing their integration.
4. **Install reviewed artifact** explicitly confirms the exact preview and artifact
   digests. A new plugin is installed and opened; a release change preserves its
   window/pane IDs, current configuration and enabled/disabled state. Any intervening
   workspace edit refuses with `stale_resource`. Recheck and prepare a new review.
5. Select an earlier retained draft, check it and prepare another review to roll
   back **code only**. Later `config.minutes` values survive. Elapsed countdown state
   is memory-only and resets on iframe reload/disable; this is not durable private
   app storage. M3 notebooks remain separately host-owned.

On an unknown response, **Retry exact request** reuses the same saved key and payload.
The retry survives closing/reopening Studio and page reload. A successful install
receipt can be recovered after its proposal expires without repeating the mutation.
Receipts cannot replay across a recovery-policy generation change.

## Persistence, atomicity and authority

- Owner-only `POST /api/extension-studio`, strict closed request shapes in
  `contracts/extension-studio-v1.mjs`; no controller capability, Hermes tool or
  generated-frame bridge is admitted.
- Immutable drafts, structural reports and proposals live under private
  `extension-studio/<workspace-id>/`. Exclusive atomic publication uses fsync and
  hard-link installation; duplicate operation keys must identify the same request.
  Each record is capped at 256,000 bytes, with at most 128 drafts and 128 proposals
  per workspace; exhaustion refuses new work. No automatic deletion is implemented.
- The publisher retains existing hash directories. Each install rechecks actual
  bytes and inventory, then commits the staged layout, checkpoint and metadata
  response receipt in the existing SQLite transaction. Publication may leave an
  unused public bundle; it never implies approval or activation. Retain old bundles.
- Revocation atomically disables the matching registered plugin and appends a
  `studio-revoke` receipt containing its entry. This ledger is outside layout undo.
  Every store commit refuses enabled registration of a revoked entry, including
  controller enable and checkpoint restore. Re-generating identical bytes under the
  same plugin ID cannot evade revocation. Other hashes require a new review.
- Recovery hold blocks generation/check/preview/install. Connected Studio dialogs
  detach previews when their authorization poll observes hold or revoke. Release
  never re-enables widgets; a new policy generation invalidates old install reviews.
- These are registered-lifecycle controls, not deletion of public assets or a kill
  switch for cached/offline/direct app pages. Already delivered public bytes cannot
  be recalled. The finite timer receives no host token, private data or resource
  grant. Its reviewed template adds restrictive CSP; this is not a general egress
  guarantee for arbitrary v1 plugins.

## Schema and deployment

Schema **11** adds no tables: it fences older schema-10 binaries that cannot enforce
Studio revocations. Existing records and v1 layouts are preserved. Migration tests
use the real archived deployed `a15d7eb` reader, not a rewound database marker.

Back up the entire stopped runtime, including `extension-studio/`, `apps/`, SQLite
and all private journals. SQLite alone omits draft/proposal artifacts. Restoring a
pre-revocation backup is a security-state rollback requiring explicit reconciliation.
Older deployments need matching pre-upgrade backups in separate runtime directories;
never lower `user_version`.

Studio was initially source-only. The separately authorized goal-first rollout
now includes it in schema-11 release `orbit-4fec70f`; existing layouts and plugin
configuration were preserved. Deployment makes the Studio workflow available but
does not install a timer into the owner's workspace. See
[the rollout evidence](MILESTONE_GOAL_FIRST_WORKBENCH.md#deployment-record).

## Verification

`tests/extension-studio.test.mjs` covers exact proposals/receipt recovery,
stale/expired/substituted output refusal, tampering, real schema-10 compatibility,
configuration-preserving rollback, durable revocation and recovery hold.
`tests/extension-studio.browser.py` exercises the real publisher/server/iframe on
Default and Docking in disposable storage: committed-but-lost response recovery,
timer controls, parent/storage/network denial, updates and rollback. These browser
cases join the isolated `tools` CI suite. No paid-provider acceptance is involved.
