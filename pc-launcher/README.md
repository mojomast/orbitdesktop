# Usage from Hyvv landed events

Point `scripts/usage_ingest_service.py once --outbox <dir> --ledger <file>`
at a local outbox containing `rizzstack.bee.landed.v1` JSON events. The
`data` object identifies the attempt; the optional `rizzstackusage` object
is its **envelope sibling**. `data.result` can be just an artifact reference:
the reader does not need to open it.

`input`, `output`, `cache_read`, `cache_write` and `reasoning` populate the
matching ledger and `gen_ai.usage.*` fields. `usage_raw` preserves those
reported counts plus `thinking` and `total`, which have no dedicated v1
fields. Counts must be JSON integers from 0 to 999,999,999. Missing or
invalid values remain absent from `usage_raw` and null in mapped fields.
A total of zero alone is a partial observation; `tool_calls` or other
metadata alone is not usage. Missing buckets are never derived from totals.

The reader accepts explicit `go`, `deepseek` and `zoo` routes. `free`, `agy`,
missing and unrecognized routes have unknown provider and billing identity
in `bee.usage/v1`. Extension-only records have no cost estimate: the counts
do not specify billing or whether cache/thinking are included in I/O. Only
bounded `tool_calls`, recognized stop reasons and short model identifiers are
considered from the extension in addition to the route and token counts.

Without valid extension counts, legacy nested receipt-style usage still uses
the receipt normalizer. With `--attempts <dir>` in the same scan, a receipt
pair takes precedence. The ledger is append-only and keyed by `attempt_id`:
replay adds nothing, and a later receipt does not replace an earlier row.
