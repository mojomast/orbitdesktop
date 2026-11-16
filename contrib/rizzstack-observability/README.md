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
  `backfill`, `once` and `run` modes and composable sources (`receipts`,
  `outbox`)
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

## Coordinator outbox source (split topology)

On the split topology (native Windows launcher host plus a coordinator host
running Hermes) the launcher receipts exist only on the launcher host. The
coordinator does receive durable `rizzstack.bee.landed.v1` events in its local
Hermes outbox (`~/.hermes/plugin-data/bundlebees/events/outbox/`), so the
ingest service can also feed the ledger from there. The deployed collector
keeps reading the same ledger path unchanged.

```
python3 ~/work/orbitdesktop/pc-launcher/scripts/usage_ingest_service.py once \
  --attempts ~/.orbit-launcher/attempts \
  --source outbox \
  --outbox ~/.hermes/plugin-data/bundlebees/events/outbox \
  --ledger ~/.local/state/bee/usage.jsonl \
  --prices ~/work/orbitdesktop/pc-launcher/prices.json
```

- `--source` selects sources: `receipts` (the `--attempts` behavior, the
  default) and `outbox`. Sources compose: `--attempts ... --source outbox`
  runs both in one cycle; `--outbox` alone implies the outbox source, so a
  coordinator-only host needs no `--attempts`. `--outbox` defaults to
  `~/.hermes/plugin-data/bundlebees/events/outbox`.
- Each `*.json` file in the outbox holds one JSON event object (or an array
  of events). Only `rizzstack.bee.landed.v1` events are ingested; other types
  are skipped with a counted `unrelated_type` reason.
- Landed events are CloudEvents envelopes: `data`, `datacontenttype`, `id`,
  `source`, `specversion`, `time` and `type` at the top level, with the landed
  facts (`attempt_id`, `backend`, `lease`, `result`, `state`, `task_id`,
  `feature_id`, `job_id`, `schema`, `source_rev`) inside `data`. The reader
  parses `data` first (a top-level `payload` object stays supported as a
  compatibility fallback), so a usage payload inside `data` is ingested:
  `backend.model`/`backend.fallback` drive route and provider identity exactly
  like launcher receipts, `task_id`/`feature_id`/`job_id` fill the record
  identity, and `data.state` (`landed`/`failed`) is mapped as a plain string.
  Events without a usage payload are skipped with a counted
  `no_usage_payload` reason and never fabricated into ledger records. Events
  with usage but without an attempt id are skipped with `missing_attempt_id`
  (a record without identity cannot be keyed honestly).
- Records are built through the same receipt code path
  (`usage_ledger.record_from_receipt`), so Zoo/DeepSeek/fallback provider
  identity and unknown-preserving semantics are identical to launcher
  receipts: unknown costs stay `null` and Zoo/unknown routes are never priced
  from the DeepSeek table.
- De-duplication is by ledger key (`attempt:<attempt_id>`) across sources and
  the first record written for a key wins; later duplicates of that key are
  skipped. Within a single cycle with both sources enabled, receipts are built
  before outbox records, so a receipt already present at scan time is the one
  recorded and nothing is double counted; a key already appended by an
  earlier outbox-only cycle stays as it was and a later receipts cycle adds
  nothing for it. Replaying an outbox backfill adds nothing. Unreadable or
  non-JSON event files are parse failures listed under `parse_errors` and
  retried on the next cycle.
- Whenever the outbox source is enabled, the status JSON gains `outbox` in
  `sources` plus `outbox_dir`, `outbox_files`, `outbox_events`,
  `outbox_records` and `outbox_skipped` (per-reason counts).

## prices.json is loaded once at start

The service loads the pricing snapshot (`prices.json`) once at startup and
keeps it in memory for all cycles. A pricing snapshot update therefore needs a
service restart to take effect:

```
systemctl --user restart usage-ingest.service
```

Backfill runs started by hand always read the current snapshot from disk.

## Hardening and failure semantics

- `ProtectSystem=strict`, `ProtectHome=read-only` and
  `ReadWritePaths=%h/.local/state/bee` are DECLARED so the service is
  intended to write only the ledger state directory. On a systemd 255 user
  manager these mount protections are inert (see the enforcement note
  below), so the read-only posture of receipts, the checkout and
  `prices.json` rests on the service code touching only the paths it
  needs, not on kernel enforcement.
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
    MemoryDenyWriteExecute, RestrictNamespaces) are
    filter-based and generally apply without privileges, but this
    note does not claim them as verified.
  - Removed as unit-fatal on 255 user managers (each aborts the unit
    with exit 218, CAPABILITIES, before ExecStart; probed
    individually): PrivateDevices=, ProtectKernelLogs=,
    ProtectKernelModules=, ProtectClock=. The documented install could
    not start with them present.
- Torn `.result.json` writes are parse failures: the attempt is skipped,
  listed under `parse_errors` in the status JSON, and retried on the next
  cycle. A missing receipts directory is recorded as
  `"sources": {"launcher_attempts": "missing"}` instead of failing the cycle
  (a missing outbox directory is recorded as `"outbox": "missing"` the same
  way).
- The status JSON of the last cycle is written to
  `~/.local/state/bee/usage-ingest-status.json` (same content as each
  journalctl line).
