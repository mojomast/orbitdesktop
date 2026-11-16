# rizzstack-observability

Usage wiring for the merged `bee.usage/v1` ledger: the systemd user unit
`usage-ingest.service` keeps a ledger on the launcher host fed from the pc-launcher's
real attempt receipts (`~/.orbit-launcher/attempts/<attempt_id>.json` plus the
matching `<attempt_id>.result.json` sidecar written by the launcher when an
attempt finishes). Every record is produced by
`pc-launcher/scripts/usage_ledger.py` and appended by the schema-validated,
key-dedupe, append-only writer, so re-running an ingest cycle is idempotent.
`pc-launcher/scripts/usage_report.py` reads the same ledger for rollups and
warn-only budget alerts.

## Files

- `usage-ingest.service` — hardened systemd user unit (runs the service in
  `run` mode every 15 minutes)
- `pc-launcher/scripts/usage_ingest_service.py` — ingest service with
  `backfill`, `once` and `run` modes
- `pc-launcher/scripts/usage_ledger.py` — record building, receipt pair
  reading (`receipt_pairs`, `record_from_receipt`) and the ledger writer

## Install on the launcher host

The paths below assume the orbitdesktop checkout lives at
`~/work/orbitdesktop` and the launcher keeps its default data dir
(`~/.orbit-launcher`, attempts in `~/.orbit-launcher/attempts`). If the
checkout or the launcher data dir live elsewhere, adjust the paths in the
`ExecStart=` line of `usage-ingest.service` before installing.

1. Backfill the ledger once with everything already on disk:

   ```
   python3 ~/work/orbitdesktop/pc-launcher/scripts/usage_ingest_service.py backfill \
     --attempts ~/.orbit-launcher/attempts \
     --ledger ~/.local/state/bee/usage.jsonl \
     --prices ~/work/orbitdesktop/pc-launcher/prices.json
   ```

   The command prints one JSON status line (`added`, `skipped`,
   `invalid_records`, `ledger_records`, `sources`). Exit code 0 with
   `"sources": {"launcher_attempts": "missing"}` means the receipts directory
   does not exist yet; create it or point `--attempts` at the real one.
   Receipts whose `.result.json` is still being written are reported as
   `parse_errors` and are picked up on the next cycle, never crash the run.

2. Install and enable the user unit:

   ```
   mkdir -p ~/.config/systemd/user
   cp ~/work/orbitdesktop/contrib/rizzstack-observability/usage-ingest.service ~/.config/systemd/user/
   systemd-analyze --user verify ~/.config/systemd/user/usage-ingest.service
   systemctl --user daemon-reload
   systemctl --user enable --now usage-ingest.service
   loginctl enable-linger   # keep ingesting after logout
   journalctl --user -u usage-ingest.service -f
   ```

   `systemd-analyze --user verify` must print nothing and exit 0.

3. Read the ledger:

   ```
   python3 ~/work/orbitdesktop/pc-launcher/scripts/usage_report.py \
     --ledger ~/.local/state/bee/usage.jsonl --today
   ```

## prices.json is loaded once at start

The service loads the pricing snapshot (`prices.json`) once at startup and
keeps it in memory for all cycles. A pricing snapshot update therefore needs a
service restart to take effect:

```
systemctl --user restart usage-ingest.service
```

Backfill runs started by hand always read the current snapshot from disk.

## Hardening and failure semantics

- `ProtectSystem=strict` with `ProtectHome=read-only`: the whole filesystem
  including the receipts, the checkout and `prices.json` is read-only to the
  service; only `~/.local/state/bee` is writable via `ReadWritePaths=`.
  Enforcement note (systemd 255 user unit; probed where stated):
  - Verified enforced: RestrictAddressFamilies=AF_UNIX
    (AF_INET/AF_INET6 socket() fail with EAFNOSUPPORT inside the
    service sandbox) and NoNewPrivileges.
  - Declared but NOT enforced in a user unit on 255:
    ProtectSystem=strict, ProtectHome=read-only, ReadWritePaths= and
    PrivateTmp= are silently inert here (probed: / and $HOME
    writable). The read-only posture of receipts/code therefore
    rests on the service code touching only the paths it needs, not
    on mount enforcement.
  - Not individually probed: the seccomp-level restrictions
    (RestrictRealtime, RestrictSUIDSGID, LockPersonality,
    MemoryDenyWriteExecute, ProtectClock, RestrictNamespaces) are
    filter-based and generally apply without privileges, but this
    note does not claim them as verified.
  - PrivateDevices= was removed: with a user manager on 255 it
    aborts the unit with exit 218 (EXIT_NAMESPACE) before
    ExecStart, so the documented install could not start at all.
- Torn `.result.json` writes are parse failures: the attempt is skipped,
  listed under `parse_errors` in the status JSON, and retried on the next
  cycle. A missing receipts directory is recorded as
  `"sources": {"launcher_attempts": "missing"}` instead of failing the cycle.
- The status JSON of the last cycle is written to
  `~/.local/state/bee/usage-ingest-status.json` (same content as each
  journalctl line).
