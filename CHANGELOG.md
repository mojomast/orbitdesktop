# Changelog

## 2026-11-25

- Re-pin the Hive snapshot validator to Workflow `97210a8688a7f63f465f3700519cf0fc690d7ef7` (snapshot schema SHA-256 `5325e375de0e9d007c63fcfe515978b7f6d3ebff72583e02252e3dcd66b7a2b9`, common schema unchanged) for the additive DEPLOY-METRIC `bottlenecks.deploy_debt` four-surface deploy-parity observation and independent `bottlenecks.open_prs` count. Regenerate the standalone validator, content-addressed Hive entry, and portable source archive.
- Materialize a missing Git index before loading the bundle tests so verify sandboxes check the complete tracked source archive.
- Update the Hive snapshot validator to Workflow `71cf42c323d393ab8d342c33269e4b0dea54ce32` (snapshot schema SHA-256 `6d65b5e5fbbf4d2dd4158c4ce4c55474eca5965cb0f0cce5a852127af4dd2eee`, common schema unchanged) and project the additive BU2 usage observations. The usage pane now includes a non-null tokens-per-verified-patch headline, a coordinator/worker split naming both sources, and worker model/repository rows timestamped with the usage collection time; null costs remain `null (unknown)`, legacy snapshots keep their prior projection, and malformed optional structures degrade only usage. The standalone validator and portable source archive were regenerated with their repository scripts.
