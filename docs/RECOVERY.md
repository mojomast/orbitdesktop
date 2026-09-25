# Independent layout recovery

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

## Scope and limitations

- This is **not persistent safe mode** or permission revocation. Disabling apps removes
  registered plugin windows from layout; later explicit enable or restore can restore
  them. Already-open disconnected frames, direct app tabs and trusted external backend
  processes are not stopped. Arbitrary browser windows are not registered plugins.
- The page requires a functioning Node server and readable workspace/checkpoint JSON.
  It is not an offline database repair tool. Corrupt records fail closed.
- Restores retain the checkpoint's session identities; they do not recreate process
  state, undo shell effects, restore documents/conversations, or roll back application
  data. Normal rendering still has unproven iframe continuity.
- Layout restore may re-enable a previously disabled plugin under the legacy model.
  There are no broker grants yet. Future revoked grants must remain outside layout.
- Separate JSON renames are not one transaction across revision and checkpoint.
  Do not run multiple writable server processes over this store. No SQLite migration
  has happened; see the evolution plan for that remaining gate.
- If every window is a registered plugin, disable-all may fail the existing minimum
  one-window invariant. No replacement shell is silently started to bypass that rule.

The source bundle intentionally omits the owner-specific standalone mobile proxy;
its source remains in the repository and is not part of portable recovery.
