# Independent recovery console

Open `/recovery` on the same authenticated Orbit host. Enter the owner session token
and the exact workspace UUID; do not paste credentials into a conversation or URL.
The page keeps the token in memory only. It does not enumerate workspaces, mount
applications, attach terminals, run Hermes, or import the normal renderer.

The page and its two static assets are served from `public/` directly, independent
of `dist/index.html`. Its API uses the normal owner token plus same-origin checks.
Read/history do not mark a client as having observed or rendered a revision and do
not traverse optional application bundles. No workspace capability is returned.

Choose a checkpoint and explicitly confirm restore, or explicitly confirm disabling
registered apps. Both mutations check the revision and create a pre-change checkpoint.
On conflict read again and reconsider; no automatic retry/overwrite occurs.

## Persistent registered-plugin hold

The console also supports a separately confirmed **recovery hold**. Entering hold
disables registered plugins and stores the policy outside checkpoint layout state.
It persists across server restarts. While held, the server rejects workspace mutations
whose result activates registered plugins, including full-state sync, restore and
controller edits. Ordinary layout edits that leave plugins disabled remain allowed.

Only the owner-authenticated recovery route can change this policy. The scoped
controller capability cannot release it. Release is explicit and does **not** re-enable
anything: review a plugin and enable it separately afterward. A layout checkpoint
cannot clear the hold. Read responses expose policy status and generation without
credentials. A stale command receipt from a previous policy generation is rejected
instead of returning an old active snapshot. Read again; do not automatically mint a
new operation key and repeat the rejected activation.

This is a server-side **registered-plugin activation hold**, not a general process or
network kill switch. The normal page may render cached local content before connecting;
offline clients cannot be remotely stopped. Use this independent console for recovery,
and close unresponsive app tabs separately if necessary.

## Scope and limitations

- The older **Disable all apps** button remains a reversible layout-only action.
  Without the separate hold, later enable or restore can reactivate those plugins.
  Neither action stops already-open disconnected frames, direct app tabs or trusted
  external backend processes. Arbitrary browser windows are not registered plugins.
  Static `/apps/` URLs remain served; there is no broker grant revocation or general
  resource quarantine. The hold must not be presented as a complete safe boot mode.
- The page requires a functioning Node server and readable SQLite workspace store.
  It is not an offline database repair tool. Corrupt records fail closed.
- Restores retain the checkpoint's session identities; they do not recreate process
  state, undo shell effects, restore documents/conversations, or roll back application
  data. Normal rendering still has unproven iframe continuity.
- Layout restore may re-enable a previously disabled plugin when no hold is active.
  There are no broker grants yet. Future revoked grants must remain outside layout.
- Revision, checkpoint, command receipt and metadata event now share a SQLite
  transaction. Existing JSON runtimes require explicit offline migration before
  server startup; this page cannot perform that migration. Never run old JSON
  writers against a migrated runtime. See [Workspace store](WORKSPACE_STORE.md).
- If every window is a registered plugin, disable-all may fail the existing minimum
  one-window invariant. No replacement shell is silently started to bypass that rule.

The source bundle intentionally omits the owner-specific standalone mobile proxy;
its source remains in the repository and is not part of portable recovery.
