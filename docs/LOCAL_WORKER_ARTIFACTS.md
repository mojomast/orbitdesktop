# Local-worker artifact API (coordinator-only)

`POST /api/local-workers` with `{"op": "artifact", "attempt_id": "att_…", "coordinator": "<name>"}` returns a
finished worker's patch to the coordinator that dispatched it. It is the supported way for bundlebees (or any
coordinator) to retrieve a patch. Coordinators must not read hyvv (formerly the PC launcher) or Orbit
runtime files directly.

Auth is the same as every other local-workers op: loopback only, `Authorization: Bearer <collab-board key>`.
On top of that the request must name the attempt's coordinator (the `coordinator` sent at `create`, default
`MR.INDIA`).

## Response (`orbit.worker-artifact/1`)

| field | source | trusted? |
|---|---|---|
| `attempt_id`, `state`, `source_rev` | Orbit ledger (source_rev is the brief's, not the worker's) | yes |
| `patch`, `patch_sha256` | hyvv result manifest; sha256 of the exact patch text | content untrusted, hash exact |
| `result_sha256` | sha256 of the stored result manifest, pinned on first read | yes |
| `observed` | launcher-observed run facts (base rev, tool calls, stop reason, files and scope flags) | launcher-reported |
| `usage` | launcher usage counters, `source: "launcher_reported"`; `null` when not reported (never a fake 0) | launcher-reported |
| `worker_claims_untrusted` | the worker's own summary | no, never evidence |

The response never contains host names, Orbit runtime paths or launcher work-dir paths.

## Errors

| HTTP | `code` | meaning |
|---|---|---|
| 400 | `invalid_attempt_id`, `coordinator_required` | bad id (incl. traversal) or no coordinator |
| 401 | — | wrong key |
| 403 | `not_owner` | another coordinator's attempt |
| 404 | `unknown_attempt`, `result_missing` | no such attempt; result gone and the launcher no longer has it |
| 409 | `result_pending`, `no_result_for_state` | still running; ended without a result (cancelled, not started) |
| 409 | `artifact_mismatch`, `artifact_changed`, `artifact_unsafe` | result for another attempt or source_rev; changed since first read; symlink or non-regular file |
| 413 | `artifact_oversized` | over `ORBIT_WORKER_ARTIFACT_MAX_BYTES` (default 8 MiB) |
| 502 | `artifact_malformed` | not a valid `orbit.local-worker.result/v1` manifest |
| 503 | `worker_disconnected`, `launcher_unreachable` | retryable |

## Guarantees

- **Idempotent.** Repeat reads return byte-identical artifacts. The first-read hash is stored in the ledger, so
  it survives an Orbit restart, and any later substitution of the result file is refused (`artifact_changed`).
- **Missing result recovery.** If the stored result file is gone, Orbit refetches it once from the launcher.
- **File safety.** Result files are written with mode 0600 through a temp-file rename. They are read with
  `O_NOFOLLOW` after an `lstat`, a regular-file check and a realpath check against the results directory.
- **No patch elsewhere.** `get`, `list` and the logs never carry patch text or runtime paths. `result.available`
  and `log_available` say whether there is something to fetch. Orbit's own log line names only the attempt id
  and patch sha256.

No change to hyvv (formerly the PC launcher) is needed. Orbit already stores hyvv's result manifest
(`GET /v1/attempts/{id}/result`) when an attempt finishes.

## hyvv and the thin-proxy path

hyvv owns the versioned `/v1` worker API. It plans to add `GET /v1/attempts/{id}/artifact` using the same
acceptance-criterion ids (OA1 AC-001 to AC-009) and error codes as this op, and to advertise it as the
`artifact_fetch` capability. The coordinator-facing contract above is designed to stay the same when that
lands:

- **Today:** Orbit builds the artifact from its stored copy of the hyvv result manifest.
- **Once hyvv advertises `artifact_fetch`:** Orbit can forward the request to hyvv and act as a thin proxy.
  It keeps the parts only Orbit can do: the loopback key, the coordinator ownership check (Orbit's ledger),
  `source_rev` from the ledger, and the first-read hash pin. It re-checks hyvv's `patch_sha256` against the
  patch it relays. Codes and fields pass through unchanged, so coordinators such as bundlebees need no change.
- A hyvv error code that is not in the table above should be returned as `502 artifact_malformed` rather than
  passed through as an unknown code.
