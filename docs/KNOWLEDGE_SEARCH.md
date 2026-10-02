# Local source search

**Preview passage into draft** includes the selected excerpt and its full opaque
source ID, extractor version, content/text SHA-256 and exact UTF-16 offsets in
the actual draft text. The source is reread and verified again at final insertion;
removal or changed bytes keeps the reviewed draft unchanged. This is an included
snapshot excerpt, not a promise to retrieve changed upstream content. Later source
deletion does not retract copies already inserted into drafts.

The reviewed `orbit://surface/search` host surface searches **explicitly ingested
owner snapshots**, scoped to the current existing workspace. Paste text, a
selection or a conversation excerpt, or choose a small UTF-8 `.txt`, `.md`, `.csv`
or `.json` file. This is consent to store the provided snapshot, not permission to
crawl conversations, terminals, directories, URLs or arbitrary owner files.

FTS5 keyword search works without a model. Hybrid search combines FTS5 ranks and
real sqlite-vec cosine-distance ranks using reciprocal rank fusion (`k=60`). Vector
distance is computed over workspace/filter-contained candidates before ranking;
there is no global KNN shortlist that can starve a smaller workspace. There are no
fabricated embeddings, remote inference calls or automatic model downloads.
Semantic inference uses pinned MiniLM q8 on CPU only. The surface displays semantic
on/off, embedding progress, per-source index status and actionable errors. A model
failure falls back to keyword search. This is a bounded exact scan, not ANN or a
large-corpus retrieval system.

## Exact sources and deliberate sharing

Every source identity hashes workspace, source kind, explicit location label,
original-byte SHA256 and extractor version (`utf8-plain-v1`). Changed bytes create
a new identity; old citations never follow a changed upstream file. Text snapshots
are encoded as UTF-8; malformed Unicode is rejected. File bytes, including BOM and
CRLF, are preserved exactly. Extraction is fatal UTF-8 decoding with BOM retained,
not JSON/CSV interpretation, HTML rendering or normalization. NUL/binary and
non-UTF-8 files are rejected.

Citations include source identity, original and extracted SHA256, extractor
version and exact half-open **UTF-16 character offsets**. The visible passage is
derived from the hash-checked authoritative text. **Open exact snapshot** displays
the ingested version and **Download original bytes** exports its original bytes;
neither opens a changed filesystem path. Source location labels are never fetched.
All untrusted strings render with `textContent` or textarea values.

Select characters in a result passage and choose **Preview passage into draft**.
With no character selection, the whole displayed passage is previewed. The source
is revalidated at transfer time. The existing trusted conversation-transfer dialog
requires one available existing recipient and explicit insertion. It inserts into
that draft only; it does not send a model request, create a conversation, or expose
a host token/bridge to generated frames. Conversation excerpts are owner-supplied
snapshots with no invented upstream message identity or verified provenance.

Published-output ingestion is intentionally unsupported in this implementation:
there is no unvalidated `path.join` reader, URL fetch or provenance guess. A future
addition must use the bundle registry's validated indexed-byte read boundary and
its exact hash/version validation. Paste or explicitly choose an exported text
file instead.

## Persistence, revocation and backups

The service opens lazily, outside `workspace.sqlite`, under the private runtime:

| Path                                              | Authority and retention                                                                                                                                                            |
| ------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `knowledge-index/snapshots.sqlite`, WAL/SHM       | **Authoritative** ingested original bytes, exact text, source identities, workspace generations and content-free deletion tombstones. Include in complete private runtime backups. |
| `knowledge-index/knowledge-index.sqlite`, WAL/SHM | **Derived** chunks, FTS5 and sqlite-vec embeddings. Rebuildable only from authoritative snapshots.                                                                                 |
| `knowledge-index/model/`                          | Independently provisioned, reviewed public model assets; optional and never shipped in Git/static archives.                                                                        |

Both databases have independent schema-1 fences, private 0600 files, WAL and
`synchronous=FULL`; the directory is 0700. This changes neither the core schema-12
writer fence nor workspace layout/checkpoints. Construction does no IO. Corrupt,
insecure-mode or symlinked records and unknown database versions fail closed at
feature access; there is no implicit repair or JSON fallback. Existing invalid
databases are not overwritten. Corruption recovery requires explicit offline
backup/review; a corrupt authoritative snapshot cannot be reconstructed from a
vector. A missing derived database is rebuilt on workspace access from verified
snapshots. A missing/corrupt authority is never silently recovered from the index.

Deletion commits a content-free tombstone and bumps the workspace generation in
the authority transaction **before** removing the source and derived rows. Reads
require current authoritative source membership. Queries capture the generation
before asynchronous inference and reject a changed generation with a conflict.
Every vector-commit transaction rechecks generation, workspace/source membership
and chunk identity. Late inference results cannot resurrect a deleted source or
write into a rebuilt generation. Startup reconciliation removes orphaned index
rows and resumes missing embeddings from current snapshots.

**Rebuild derived index** requires confirmation and the current generation, keeps
snapshots/tombstones, bumps the fence and rebuilds keyword/vector data.
**Purge ingested snapshots** requires separate confirmation and current generation,
deletes this workspace's snapshots and index content, and retains content-free
tombstones. It never deletes original picked files, published outputs or chat
drafts. Exact revoked identities cannot be reingested under the same label; an
explicit distinct location label creates a new consent identity. File identities
use the selected filename as their location.

Deletion and purge report `logical_exclusion:true, physical_erasure:false`. SQLite
free pages/WAL, earlier backups, process/native allocations and OS/storage caches
may retain old bytes. No `VACUUM`, secure-erase or false physical-erasure promise is
made. Deliberate offline secure-retention policy must include both databases and
WAL/SHM plus backups. Restoring an older **complete runtime backup** can restore
old authority/consent; layout checkpoints alone do not. Tombstones are bounded at
4096 per workspace and cannot be silently evicted; exhaustion requires explicit
offline retention review. If content removal fails after authoritative revocation,
the source is still excluded; inspect current sources/generation before retrying.

## Provisioning the local model

Dependencies are exact `sqlite-vec@0.1.9` and `@huggingface/transformers@4.3.0`.
Transformers and ONNX stay server-side, never imported by the frontend. The reviewed
model is Apache-2.0 `Xenova/all-MiniLM-L6-v2`, fixed revision
`751bff37182d3f1213fa05d7196b954e230abad9`, 384 dimensions, mean pooling,
normalization, maximum 256 model tokens per passage/query. Chunking preserves all
text for keyword search and citations; semantic inference truncates at that token
limit. This can reduce semantic recall for long or token-dense passages.

Only the explicit operator command downloads the six allowlisted artifacts,
including the 22,972,370-byte quantized ONNX file. Each has a fixed reviewed size
and SHA256 in `server/knowledge-model.mjs`. Downloads are bounded, fixed-revision,
time-limited, SHA-verified before publication and atomically published with file
and directory fsync. Existing mismatched model directories are never overwritten.

```sh
node scripts/knowledge-model.mjs provision /absolute/private/runtime
node scripts/knowledge-model.mjs verify /absolute/private/runtime
```

Provisioning is a public artifact download, not paid inference. Service verification
uses local files only; a missing/unverified model leaves semantics disabled.
Provision before first feature access; model verification is cached for the service
lifetime, so a later provision requires a new service instance. The inference
process sets `allowRemoteModels=false`, disables filesystem caching, and uses the
verified local model path only. No arbitrary model/path comes from requests.

Inference is a serialized, reusable **child-process worker**, not a Node worker
thread. Real tests found that terminating ONNX inference in a worker thread could
raise a native `Napi::Error` and SIGABRT the parent. A killed/exited child instead
rejects pending requests and leaves Orbit/FTS available. Cancellation terminates
the child; generation fencing remains the authority, not successful termination.
The child has a 256 MiB JS heap limit and ONNX CPU thread counts of 2/1. Native
allocations are not covered by that JS heap limit; this is not a hard OS memory
sandbox. Requests are bounded to 16 texts per batch, 8 pending calls, 128 queued
sources and a 120-second timeout. Core HTTP processing never performs inference.

The worker and queue are shared across workspaces. Deletion, purge or rebuild in
one workspace cancels the shared child and therefore may interrupt another
workspace's pending embeddings or hybrid query. That query returns explicit
keyword fallback; retry it for semantic results. Interrupted indexing resumes
from current authoritative snapshots on the affected workspace's next request
(including its surface's status refresh). The shared 128-source queue can also
delay another workspace. This is bounded cross-workspace scheduling interference,
not a weakening of workspace filtering or generation fences.

Limits: 256 KiB original bytes, 100,000 extracted UTF-16 characters, 128 sources
and 16 MiB original bytes per workspace; maximum 50 returned passages, 500 query
characters, 200-character titles/location labels, 1200-character exact chunks.
The route accepts at most **409,600 bytes (400 KiB)**, allowing JSON/base64 upload
overhead. Snapshot responses include bounded text plus base64 original bytes.

## Parent integration contract

Owned new files only: `server/knowledge-*.mjs`, `scripts/knowledge-model.mjs`,
`src/search-*.ts/.css`, focused `tests/knowledge-*`, and this document. Parent owns
packages/lockfile, server routing/shutdown, surface allowlist, discovery and common
docs/build configuration.

```js
import {
  createKnowledgeSearch,
  createKnowledgeSearchRoute,
} from "./knowledge-index.mjs";
const knowledge = createKnowledgeSearch({ root: RUNTIME_ROOT, workspaceRead });
const searchRoute = createKnowledgeSearchRoute({
  service: knowledge,
  token: OWNER_TOKEN,
  port: PORT,
  devOrigins,
  reply,
});
// POST /api/search: call searchRoute(req, res) before generic /api/ 404.
// Shutdown: await knowledge.close().
```

`workspaceRead(id)` must resolve an existing workspace or throw/return absent. The
factory returns `{dispatch(body), maxBodyBytes:409600, close()}` and checks strict
action schemas/workspace scope internally. Dispatch throws errors with `code`,
and conflicts may carry `current:{consent_generation}` or a public `detail`.
The optional supplied route adapter checks owner Bearer token + existing exact
host/origin policy, sets `Cache-Control:no-store`, bounds/fatal-decodes the body and
preserves conflict detail. If parent supplies its own route, it **must** preserve
`current` and `detail`; the existing generic Workbench helper drops them. Statuses:
400 invalid_request, 403 permission_denied, 404 unavailable, 409 conflict,
413 limit_exceeded, 422 unsupported, 429 busy. No controller capability is admitted.

Host integration:

```ts
import { mountSearchSurface } from "./search-surface";
const view = mountSearchSurface(host, liveOwnerToken, { paneId });
// view.dispose() aborts requests, clears timer and removes owned DOM.
```

Allowlist exactly `orbit://surface/search`, lazy-load the module, pass a live token
callback, and add command/Start discovery. The URL carries no token or code/path.
The client uses current `workspaceId` and `ensureWorkspaceSynced`. Request failures
and generation conflicts retain source edits. On a conflict, a validated reported
generation is adopted immediately and source metadata is refreshed without
replaying the mutation or clearing pending title/text/file/query inputs. If that
refresh fails, the reported generation remains available for an explicit retry.
The UI fits a narrow resizable pane.

Actions (all require `action,workspace_id`; unknown fields are rejected):

| Action                           | Additional fields                                                                            |
| -------------------------------- | -------------------------------------------------------------------------------------------- |
| `status`, `list_sources`         | none                                                                                         |
| `ingest_text`                    | `kind` = owner_text/selected_text/conversation_excerpt, `title`, `text`, optional `location` |
| `ingest_file`                    | `filename`, allowlisted `media_type`, canonical `data_base64`; no paths/URLs                 |
| `search`                         | `query`; optional keyword/hybrid `mode`, `limit`, `kinds`, `source_ids`                      |
| `get_source`                     | `source_id`; returns exact text/base64 plus citation hashes                                  |
| `delete_source`                  | `source_id`, `base_consent_generation`                                                       |
| `reset_index`, `purge_snapshots` | `confirm:true`, `base_consent_generation`                                                    |

## Verification evidence and limits

Verified in disposable `/tmp/opencode` runtimes with synthetic/public text:

```sh
ORBIT_TEST_MODEL_DIR=/tmp/opencode/orbit-knowledge-model-test-20260930/knowledge-index/model \
  node --test tests/knowledge-*.test.mjs
PLAYWRIGHT_BROWSERS_PATH=/tmp/opencode/orbit-evolution-browsers \
  /tmp/opencode/orbit-evolution-browser-venv/bin/python tests/knowledge-search.browser.py
```

Nine targeted Node tests passed with the real downloaded/hash-verified MiniLM
model, real sqlite-vec and FTS5. Tests exercise exact original bytes/BOM/CRLF,
citation offsets, scope, schema rejection, idempotency, retained snapshots on
rebuild, purge/deletion/restart, corruption/symlink fences, real owner HTTP auth and
origin/body limits, conflict detail, late vector commits, actual inference/query
cancellation and deletion-during-query fencing. Without the model environment
variable, the real-model test is explicitly skipped, never replaced by embeddings.

Measured on this Linux/Node 22 host, five public synthetic passages, MiniLM q8 CPU:
207 ms cold embedding initialization/call, 4 ms warm embedding, 232 ms corpus
ingestion plus indexing, 5 ms hybrid query. These are a small-fixture latency
observation, **not** a performance/quality promise. The nonlexical query “Dogs
frolic outdoors” retrieved “A canine plays with a ball in the park.” first via
actual vector similarity. Model artifacts stayed in a disposable test runtime.

Real Playwright Chromium testing passed: narrow pane, explicit text/file ingest,
FTS result and exact original-byte download, literal malicious markup without
execution, selected-passage preview and chosen-draft delivery, preserved edits on
conflict, deletion, rebuild, purge and disposal. The focused conflict regression
advances the real service generation from another owner request, disables the
10-second UI poll, deliberately fails metadata refresh, and verifies that an
explicit deletion retry uses the reported generation immediately. Pending title,
text, chosen-file and query inputs remain intact. Its workspace-sync response and
agent API are synthetic fixtures; its search HTTP service, renderer and Normal
chat recipient are real. Final insertion revalidation is exercised after review.
This does not establish a live owner workspace/browser acknowledgement.

The parent reported its integrated combined check passing 946 of 956 tests with
10 skips before this focused UI follow-up. This agent reran the real browser test
for the conflict change; it did not repeat the combined check. Offline `npm ci`, non-Linux native packaging,
large-corpus recall/memory, complete-runtime backup/secure erasure and live
deployment/restart have not been verified by this feature agent.
## Selected-source delegation

The Knowledge surface has an explicit selected-source grant/revoke panel for
linked Normal conversations using the configured pinned local gateway, plus a
dedicated-local adapter fallback. Normal grants bind the selected conversation's
next accepted run, not all turns or profile users. See [Resource delegation](RESOURCE_DELEGATION.md)
for exact scopes, destination disclosure, budgets, citations and restart behavior.
