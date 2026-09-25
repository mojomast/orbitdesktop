# ADR 003: strict legacy contract before schema migration

Status: accepted; durable receipts and v2 migration remain outstanding.

Use Ajv 8.20.0 (MIT), pinned in the lockfile, with strict mode and without coercion,
defaults, property removal, remote schema loading or `$data`. The dependency works
on the declared Node >=22.12 runtime; no Node version increase is introduced.
The initially evaluated 8.17.1 has an npm advisory and was not retained. Current
`npm audit` reports zero known vulnerabilities; that is not a security guarantee.

`contracts/workspace-v1.mjs` constructs trusted draft-07 JSON Schemas. Its generator
emits JSON, TypeScript operation types, Python limit blocks and the operation reference.
`npm run check` rejects stale generated artifacts. The server validates every workspace
request, including legacy full snapshots, before semantic/resource checks. Unknown
fields previously ignored now fail explicitly. Existing valid identity bindings and
disabled-plugin/backend/spatial fields are retained. Hermes may advertise a simplified
operation schema, but it cannot bypass server validation.

This is not a v2 model migration. The JSON store boundary retains the record format
and uses unique temporary files for atomic replacement; it does not solve multi-record
crash consistency or cross-process writes. Future-version records reject mutation by
this server rather than accepting a lossy v1 downgrade. No durable idempotency guarantee
is advertised until revision/checkpoint/receipt/outbox commits are transactional.
