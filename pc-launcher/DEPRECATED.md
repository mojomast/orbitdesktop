# DEPRECATED: `pc-launcher/launcher.py`

`pc-launcher/launcher.py` is frozen at **0.1.9** (last changed 2026-11-12). The
maintained worker host is **`hyvv/launcher.py`** in
[mojomast/hyvv](https://github.com/mojomast/hyvv) (imported as 0.1.15 on
2026-11-12; every function here also exists there). Fix or extend the launcher
in hyvv, not here.

The directory stays for now because other things still use it:

- Orbit's test double: `tests/local-workers.test.mjs` runs
  `pc-launcher/launcher.py serve --backend fake` and
  `pc-launcher/tests/test_sdk_contract.py`;
- the usage pipeline: `scripts/usage_ingest_service.py`, `usage_ledger.py`,
  `usage_report.py`, `usage_otlp.py` and `prices.json`.

**Guard.** CI (`legacy-launcher-guard` in `.github/workflows/test.yml`) fails any
pull request that changes `pc-launcher/launcher.py` or `pc-launcher/scripts/*.ps1`
unless it carries the `legacy-launcher-ok` label. Add the label only for a
deliberate change, then re-run the job. Other files here are not guarded.

**Later (option C, its own yes).** Move the usage scripts to a new home, replace
the test double, then retire this launcher. Moving the usage-ingest service path
changes a running service, so it is a deploy-class step that needs the owner's
typed yes.
