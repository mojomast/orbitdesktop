# Rails reader rollout: coordinator host

Run the read-only Rails reader (`contrib/rails_server`) as a loopback user unit over
the ledger that bundlebees' scheduled ingest fills. Point Orbit's Rails proxy at it.

## Already prepared on the host (2026-11-24)

- The ledger `~/.local/state/rizzstack-rails/ledger.sqlite3` (0600) is filled by
  `bundlebees-rails-ingest` (see bundlebees `docs/ops/obs-rails-rollout.md`).
- The read token `~/.config/orbitdesktop/rails-read.token` (0600, 43 bytes base64url)
  is distinct from the Orbit token; this was checked by digest only.
- `~/.config/orbitdesktop/rails-reader.env` (0600) sets `RIZZSTACK_RAILS_DB` to the
  ledger, `ORBIT_RAILS_BIND=127.0.0.1`, `ORBIT_RAILS_PORT=4332` (free when checked) and
  `ORBIT_RAILS_READ_TOKEN_FILE` to the token.
- Nothing is installed or restarted yet.

## Remaining steps

1. Install `contrib/rails_server/rails.service` as `~/.config/systemd/user/orbit-rails-reader.service`
   with `WorkingDirectory=%h/orbitdesktop-deploy`. Keep every hardening line.
   Enable and start it.
2. Check `curl -H "Authorization: Bearer $(cat token)" http://127.0.0.1:4332/v1/health`
   and expect 200 (run the curl in-shell and never echo the token).
3. Back up `~/.config/orbitdesktop.env`, then append
   `ORBIT_RAILS_PORT=4332` and
   `ORBIT_RAILS_READ_TOKEN_FILE=$HOME/.config/orbitdesktop/rails-read.token`
   (an absolute path).
4. `systemctl --user restart orbitdesktop`. Verify it is active and Orbit health is OK.
   If it fails, restore the env backup and restart again.
