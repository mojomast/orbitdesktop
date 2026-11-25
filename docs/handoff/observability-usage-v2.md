# Observability handoff: feat(usage): emit and read bee.usage/v2 for nous/kimi/free/agy; Nous + Kimi price snapshots

Plan-only track. The PR body has the same text.

## Handoff for bees

**Goal:** The orbitdesktop usage ledger stops collapsing Nous, Kimi, free and agy routes to `unknown`. Those routes are emitted as `bee.usage/v2` (open provider labels). Every other record stays byte-identical `bee.usage/v1`. The report, OTLP exporter and ingest service accept both.

### Kyle's decisions that apply (2026-11-24)
- Metrics store: stdlib SQLite on moltussy-1 (no new database service).
- `bee.usage/v2` with open provider labels (`provider_label`), plus Nous and Kimi price tables. `bee.usage/v1` stays frozen.
- Per-request data comes from the OpenCode session harvest only. No OTel spans. Prompt text never leaves the sandbox: counts, timings and bounded labels only.
- Retention, starting SLO targets and 10 s container sampling: the defaults in workflow `observability/METRICS.md`.
- `rizzstack.observability/1` is renamed to `rizzstack.observability/chat-card/1` with a compat note (orbit-control-plane#8, merged).
- Weekly digest: a Hive card plus a Hermes chat message.
- Phoenix and VictoriaMetrics: not now. Ask Kyle later.
- Lanes: Kimi for complex slices, Nous for low-risk ones, OpenCode Go by default. Never temperature 0. The Kimi and Nous providers must keep working.
- Process: one branch and PR per track. Contracts before code, approved RED tests before GREEN. Run gitleaks before every push. No force-push. Merge when green. Never weaken a gate or the sandbox. Mock data only in fixtures and demos.

### Done
- Contract: hyvv#51 (`contract/v1/schemas/usage.v2.json`; only schema_version, provider, route and fallback differ from v1).
- Spec below. No code or tests yet: this PR only carries the plan.

### Remaining steps
- [ ] Coordinator: add `pc-launcher/usage-schema.v2.json` (= local v1, with those 4 properties taken from hyvv v2) and the price snapshots below to `prices.json`, then write approved RED tests `pc-launcher/tests/test_usage_v2.py`.
- [ ] Coordinator, in the same RED commit: update `tests/test_usage_wiring.py::OutboxIngestTests::test_hyvv_sparse_counts_remain_partial_and_unsupported_routes_unknown`. free and agy now become v2 records with route free/agy. `None` and `future` stay v1 unknown. This is a contract change from Kyle's v2 decision, not a weakened gate.
- [ ] Bee (Go): `usage_ledger.py`: add `SCHEMA_V2`, `V2_ROUTES={nous,kimi,free,agy}`. In `infer_route`, `nous:` gives nous/explicit and `kimi:`, `kimi-*` or `k<digit>*` gives kimi/inferred. `_provider_for`: nous→nous, kimi→kimi, agy→agy, free→unknown. Choose the schema version by route. `record_from_hyvv` accepts nous/kimi/free/agy, and its model regex allows `nous:`/`kimi:` prefixes. `_strip_route_prefix` also strips `nous:`/`kimi:`. `_version_for` picks the newest snapshot whose `routes` includes the route. Validate each record against the schema for its version.
- [ ] Bee: `usage_report.py` and `usage_otlp.py` readers accept v1 and v2. `strip_route_prefix` also strips nous/kimi. Treat an explicit `peak_windows_utc: []` as always off_peak in both ledger and report.
- [ ] Bee: `usage_ingest_service.py` validates per record version. Do not change launcher routing: Nous and Kimi must keep working.
- [ ] Verify, run gitleaks, open the PR and merge when green. Deploying the ingest service needs Kyle's yes.

### Spec notes
- Nous snapshot `nous-portal-2026-11-24`. Source: Nous Portal model list, snapshot 2026-11-24. billing_mode metered, routes [nous], `peak_windows_utc: []`, `off_peak` only, per 1M tokens:
  - hy4-flash: cache_miss 0.035, output 0.1405, cache_hit 0.0015
  - deepseek-v4.1-flash-1017: cache_miss 0.03, output 0.12, cache_hit 0.0006
  - hy4-flash-free and longcat-2.5-free: 0 / 0 / 0
- Kimi snapshot `kimi-coding-2026-11-24`: the coding plan subscription. billing_mode subscription_allowance, routes [kimi], `models: {}`. That gives cost null, cost_status unknown and price_table_version set. Never invent a per-token Kimi price.
- Add `active.nous` and `active.kimi`. Existing snapshots stay immutable.

### Acceptance criteria
- v1 records for go/deepseek/zoo/unknown are unchanged (the existing 52 ledger tests plus the wiring, report and otlp suites pass).
- A Nous attempt becomes a v2 record with route=provider=nous, priced from nous-portal-2026-11-24, cost_status estimated.
- A Kimi attempt becomes v2 with route=provider=kimi, billing subscription_allowance and cost null/unknown.
- Report and OTLP read both versions. The ingest service writes both, with invalid_records 0.

### Test commands
```
cd pc-launcher && timeout 900 python3 -m unittest tests.test_usage_v2 tests.test_usage_ledger tests.test_usage_wiring tests.test_usage_report tests.test_usage_otlp tests.test_usage_zoo
```

### Dependency order
1. mojomast/workflow#153: record contracts + METRICS.md (**merged**)
2. mojomast/orbit-control-plane#8: chat-card/1 rename (**merged**)
3. mojomast/hyvv#51: bee.usage/v2 contract (open, auto-merge on)
4. hyvv `bees/obs-harvest`: OpenCode session harvest (needs 1)
5. hyvv `bees/obs-resources`: container resource sampler (needs 1)
6. orbitdesktop `bees/usage-v2`: ledger emits/reads bee.usage/v2 + Nous/Kimi prices (needs 3)
7. workflow `bees/ci-runs`: ci.run/v1 builder (needs 1)
8. hyvv `bees/obs-launcher-wiring`: call harvest + sampler from the launcher, metrics outbox (needs 4, 5)
9. workflow `bees/obs-store`: SQLite store, collector v2 accept, views, SLOs (needs 1, 3, 6, 7, 8)
10. bundlebees `bees/obs-task-outcome`: task.outcome/v1 + insights (needs 1; feeds 9)
11. orbit-control-plane `bees/obs-dashboards-digest`: Orbit tabs, Hive Big picture, weekly digest (needs 9, 10)

### Needs Kyle's typed yes (stop and ask, do not do)
- Any tag, release or deploy: the hyvv launcher on brrrrrrrr, the orbitdesktop ingest service, the moltussy-1 collector/compactor, the orbit-control-plane deploy (#8 only takes effect after it), and installing the Orbit app.
- Any restart of Orbit, moltussy-1 services or the launcher.
- Live canaries: a real Nous or Kimi bee run to check harvest end-to-end.
- Any deletion, and any Google Colab spend.
- Phoenix or VictoriaMetrics (deferred: ask later).

