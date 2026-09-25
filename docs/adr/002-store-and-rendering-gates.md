# ADR 002: evidence before store and renderer replacement

Status: accepted gates; specific binding and renderer decisions pending.

SQLite is preferred, but do not use experimental node:sqlite or raise Node's minimum
silently. Check distribution/install compatibility before choosing a binding. Use
short transactions and one logical mutation writer; external APIs/files are not in
the database transaction. Live backup must account for WAL.

No docking dependency is selected yet. Stable connected hosts are the baseline
candidate; benchmark them against exact-version Dockview and Golden Layout in an
isolated browser. Require real iframe document identity and connection evidence.
moveBefore is an optional optimization, not a universal fallback guarantee.
