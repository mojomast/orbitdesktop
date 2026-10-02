# Local Data Lab

`mountDataWorkbench(host, token, {paneId?})` is a reviewed parent-page surface.
It loads the exact stable `@duckdb/duckdb-wasm@1.32.0` EH worker lazily and uses
one thread without COOP/COEP or SharedArrayBuffer. It is not a generated plugin.

Pick up to 16 uniquely named CSV, JSON/NDJSON or Parquet files (50 MiB total).
The UI shows each exact SHA-256, byte size and assigned `input_1`, `input_2`, …
table. Run a SELECT or WITH … SELECT using those table names. Inputs are imported
into memory (one million rows maximum per file). No file bytes are uploaded or
stored in layouts, checkpoints or private recipes. JSON and Parquet require the
independently provisioned local extension assets below; missing assets fail visibly.

### Agent-authored published CSV inputs

An agent with publication and workspace-layout authority can open the existing Data
workbench with one exact **already-public** CSV preloaded, without a browser file
picker or Desktop browser-control connection:

```text
orbit://surface/data?input=<content-addressed-bundle-slug>/<filename.csv>&sha256=<64-lowercase-hex>
```

Publish through `scripts/plugin_publish.py` (see [Plugins](PLUGINS.md)), retain the
immutable bundle, compute the SHA-256 of the actual CSV bytes, and use `add_window`
with `kind: "browser"` and that URL. Reuse an existing matching pane; replacing a
different Data pane disposes its in-memory analysis, so prefer a new window when
its contents are unknown. The slug is a lowercase alphanumeric/hyphen prefix (up
to 80 characters) followed by `-` and the publisher's 24-hex suffix. The filename
starts with an ASCII alphanumeric, has at most 120 ASCII alphanumeric/underscore/
hyphen characters before `.csv`, and has no subdirectories. Parameter order and
spelling are exact; escapes, extra parameters and fragments are unsupported.

The trusted surface downloads only `/apps/<slug>/<filename.csv>` on the same
origin, with credentials omitted and redirects refused. It bounds the streamed
response to **5 MiB**, checks the full SHA-256 before engine admission, and loads
the verified bytes as `input_1` in the existing local DuckDB worker. The pane shows
the publication path and expected/loaded hashes. A missing file, changed digest,
oversize response or cancellation fails without importing it. **Reload published
CSV** retries explicitly; choosing local files cancels a pending publication load.
Opening/restoring the pinned route reloads its public input, but does not run the
SQL editor, save a recipe, share results, grant sources or send a message. Recipes
still contain metadata only. Closing a pane terminates the download and worker.

This route is for data the owner requested to publish/use; it does not read private
host paths, crawl directories, import Knowledge sources, or give generated frames
an owner API bridge. Local file-picker inputs remain browser-only. A publication
is an independently retained public bundle, not private layout-checkpoint content.

Queries are parsed by DuckDB as derived SELECTs, limited to one statement and
5,001 engine result rows. The UI retains at most 5,000 rows / 2 MiB, marks
truncation, pages 100 rows and sorts only the retained result. Downloads explicitly
export that bounded result; recipe + result exports are capped at 5 MiB.
Big integers and decimals are displayed/exported as exact strings. Dates are ISO
strings. A result hash covers the displayed columns and rows, not the source data.
The memory setting is 256 MiB; this is a DuckDB allocator limit, **not** a measured
total-browser-memory bound. A 30-second operation deadline or Cancel terminates the
worker. Choose files again after cancellation or an engine error.
Preflight statement-validation errors preserve the selected files and engine;
correct the SQL and run again. The conservative statement scanner supports normal
single/double-quoted literals and SQL comments, but dollar-quoted literals containing
semicolons are currently rejected; use normal single-quoted strings instead.

## Confinement

Trusted import code registers generated file names before disabling external
access, materializes tables, and removes the file registrations. It disables
extension auto-install/autoload before import. Only the explicitly allowlisted
JSON/Parquet extensions can be loaded, from same-origin fixed URLs, before user
SQL is accepted. After import it sets `enable_external_access=false` and
`lock_configuration=true`. Filesystem and HTTP table functions are consequently
denied by the actual engine. User text cannot execute SET/LOAD/COPY or another
statement: the single-statement scanner and DuckDB derived-table parser both apply.
The host CSP also requires `connect-src 'self'`, `script-src 'self'
'wasm-unsafe-eval'`, `worker-src 'self' blob:` on document and worker responses.

## Private recipes and recovery

Parent wires owner-authenticated, allowed-Origin **POST `/api/data-recipes`** to
`createDataRecipes({root, workspaceRead}).dispatch(body)`. Dispatch validates exact
request shapes and workspace existence itself. Authentication/origin checks and
HTTP body bounds belong to the parent route. Successful responses are direct JSON.
Map `invalid_request` to 400, `unavailable` to 404/503, `conflict` and
`operation_mismatch` to 409, and `limit_exceeded` to 413. Preserve `error.current`
on CAS conflicts. Request schema lives in `contracts/data-recipes-v1.mjs`.

List/get use `workspace_id` and optionally `recipe_id`; save/delete additionally
require `base_revision` and UUID `op_id`. Save includes `recipe`; delete includes
`recipe_id`. The service keeps the last 64 exact operation digests so retries
recover a lost response without duplicate writes. An expired receipt does not
re-execute against a stale base revision. CAS is single-process (one service
factory per runtime); this is not a cross-process locking protocol.

Files live at `<root>/data-recipes/<workspace_id>.json`, 0600, atomic fsynced
replacement, strict fail-closed validation, symlink refusal, 500 recipes and
256 KiB per workspace. Existing recipe directories must already be 0700 and files
0600; insecure permissions fail closed and are never implicitly repaired. Include **data-recipes/** in complete private runtime
backups. Records are private but not encrypted. They contain exact SQL, input
hashes/sizes/table bindings and the real engine identity (`v1.4.3`). No recipe is
an assertion of correctness or original provenance.

Refresh and choose a recipe after reload, or import exported recipe JSON. The
workbench labels inputs missing/changed/verified by exact bytes, format and table
binding, blocks reruns on input or engine mismatch and never restores files from
recipe metadata. Re-select files in the recipe's original order: reversing two
compatible CSVs is a binding mismatch, even when every file hash still matches. Start new
analysis is the explicit escape for changed files. A CAS conflict retains the SQL
and chosen files; refresh/resolve explicitly. An uncertain save retains its exact
request in the mounted pane for **Retry exact save**. That retry draft does not
survive disposal/reload; inspect saved recipes afterward.

## Selected evidence and SQL proposals

Choose explicit row and column checkboxes, then **Share selected result rows**.
The final draft includes actual typed columns/values, zero-based retained-row
indices, recipe/input fingerprint, full retained-result hash and a separate
selected-payload hash. Decimal and bigint strings remain exact. Result truncation
and omitted retained rows are separate fields; an oversized share is refused
without truncating its JSON/evidence. Sorting changes display order only. SQL,
input, query, cancellation or selection changes fence an open transfer.

**Ask about schema** shares loaded table/column/type metadata and input hashes,
with no sample rows. The schema payload includes the exact proposal format:
`{"inputHash":"…","sql":"SELECT …"}`. Paste it into **SQL proposal JSON**
and choose **Stage SQL proposal**. Only a matching loaded-input fingerprint and
bounded SELECT are accepted; the editor is populated without running. Review
then **Run SELECT** explicitly. Neither handoff submits a model request.

## Parent asset integration (required)

The client uses Vite `?url` imports for these npm-owned local build assets:

- `@duckdb/duckdb-wasm/dist/duckdb-browser-eh.worker.js`
- `@duckdb/duckdb-wasm/dist/duckdb-eh.wasm`

JSON and Parquet are **not bundled in npm**. Provision these reviewed MIT DuckDB
extensions explicitly outside Git:

```sh
node scripts/provision_data_engine.mjs --extensions-root .runtime/engines/duckdb
```

With no arguments the script uses `.runtime/engines/duckdb`. It downloads only
the two fixed upstream v1.4.3 / wasm_eh URLs, refuses redirects, checks exact size
and SHA-256, rejects symlink ancestors/destinations, writes private 0600 files via
fsync + atomic rename, and reports each file. Re-running verifies existing bytes
without making any network requests. Changed, truncated or oversized existing
files fail instead of being silently replaced. Back up the provisioned directory
or run this explicit provisioning step when installing a fresh runtime. No
binaries belong in Git or public source archives.

Parent creates the assets helper once (construction performs no IO):

```js
const dataEngineAssets = createDataEngineAssets({
  extensionsRoot: process.env.ORBIT_DUCKDB_EXTENSIONS_ROOT
    || path.join(runtimeRoot, 'engines', 'duckdb'),
});
// Inside the parent's exact /vendor/duckdb/ asset branch:
return dataEngineAssets.handle(req, res, url.pathname);
```

Import the factory from `server/data-engine-assets.mjs`. Keep the npm EH worker/
WASM URLs on the parent build's asset branch; this helper serves only the extension
and status paths. It accepts GET/HEAD and revalidates size/hash before every
response, rejects symlinks and hardlinks, uses descriptor reads bounded to the
pinned byte count plus one sentinel, returns verified assets as `application/wasm`
with immutable cache headers and hash ETags, and returns fixed 404/405/503 responses
without SPA fallback. The worker and document still need the parent's WASM CSP.

| App URL | Bytes | SHA-256 |
| --- | ---: | --- |
| `/vendor/duckdb/v1.4.3/wasm_eh/json.duckdb_extension.wasm` | 820646 | `b997276c8e15cc3ebdeda340d73d15dc1c4f4755ad281280451cb0a2f79302e9` |
| `/vendor/duckdb/v1.4.3/wasm_eh/parquet.duckdb_extension.wasm` | 3045039 | `22765c8f7dc741cda2b571a66ac7bb355295d7d69a6c37e5315b265672984f55` |

Upstream provisioning source is
`https://extensions.duckdb.org/v1.4.3/wasm_eh/<name>.duckdb_extension.wasm`.
These are downloaded by the explicit script, not the application. The helper also
accepts the exact short aliases `json.wasm` and `parquet.wasm` under the same
version/platform prefix. Both aliases map to the same verified pinned bytes.
`GET /vendor/duckdb/v1.4.3/status` returns public engine/platform metadata,
`ready`/`missing`/`invalid` extension statuses and the provisioning command;
the factory's trusted `status()` returns the same object. Private paths are never
included in responses. The UI checks each needed asset with HEAD and presents an
actionable provisioning error when it is missing/invalid; choosing CSV alone does
not request either extension.

The isolated browser test reads the provisioned root from
`ORBIT_DUCKDB_EXTENSIONS_ROOT` or `/tmp/opencode/orbit-duckdb-extensions/` and
serves it through this actual helper. It never downloads extensions.

## Evidence

`node --experimental-strip-types --test tests/data-workbench.test.mjs` checks
private persistence, CAS race, exact retry/mismatch, strict schema, fingerprint
changes, deletion, corrupt/symlink refusal and query boundary helpers.

`PLAYWRIGHT_BROWSERS_PATH=/tmp/opencode/orbit-evolution-browsers
/tmp/opencode/orbit-evolution-browser-venv/bin/python tests/data-workbench.browser.py`
uses the real EH worker under WASM CSP and a real recipe service in a disposable
Vite fixture, including actual `createDataEngineAssets` HTTP responses. It
generates synthetic Parquet with real DuckDB, joins CSV/JSON/
Parquet to exact golden aggregates, verifies external filesystem/HTTP denials and
configuration lock directly in the engine, denies all external browser requests,
runs SQL while browser networking is offline, checks bounded export/paging,
cancellation, recipe reload/changed files, and a 390px viewport. It does not prove
the parent production authentication route or measure peak worker memory/performance.

`node --test tests/data-workbench-assets.test.mjs` checks fixed provisioning URLs,
wrong/oversized bytes, symlinks, real pinned-byte installation, offline reverify,
private file mode, actual GET/HEAD HTTP bytes, MIME/CSP/cache headers, aliases,
status, unknown paths/methods and changed/missing/symlink asset failures. The
real-byte case explicitly skips if neither provisioned fixture root is available;
provisioning failures and security cases do not require binaries.
