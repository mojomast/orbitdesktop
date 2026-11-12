// Coordinator-only worker artifact reads for POST /api/local-workers {op:'artifact'} (contract OA1-artifact).
//
// Threat model: the result manifest on disk was produced by the launcher from a worker sandbox, so every
// field inside it is untrusted. Orbit never takes a path from the request or the manifest: it derives
// <runtime>/local-workers/<attempt_id>.result.json from a validated attempt id, refuses symlinks and
// non-regular files, bounds the size before parsing, binds the artifact to the attempt id and the
// coordinator's source_rev from the ledger, and pins the first-read sha256 in the ledger so a later
// substitution is refused. Raw patches are returned only in this response and never logged.
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, realpathSync } from 'node:fs';
import { createHash, timingSafeEqual } from 'node:crypto';
import path from 'node:path';

export const ARTIFACT_VERSION = 'orbit.worker-artifact/1';
export const ATTEMPT_ID = /^att_[0-9a-f]{16}$/;
export const DEFAULT_MAX_BYTES = 8 * 1024 * 1024;
const RESULT_STATES = new Set(['succeeded', 'failed', 'accepted', 'rejected']);
const PENDING_STATES = new Set(['queued', 'dispatching', 'launcher_queued', 'starting', 'running', 'backoff', 'reconnecting', 'outcome_unknown', 'cancel_requested']);
const USAGE_KEYS = ['inputTokens', 'outputTokens', 'thoughtTokens', 'cachedReadTokens', 'cachedWriteTokens', 'totalTokens', 'cost', 'costUsd'];

export class ArtifactError extends Error {
  constructor(status, code, message, extra = {}) { super(message); this.status = status; this.code = code; this.extra = extra; }
}
const sha256 = (data) => createHash('sha256').update(data).digest('hex');

/** Read <dir>/<id>.result.json safely; null when it does not exist. */
export function readResultFile(dir, id, maxBytes = DEFAULT_MAX_BYTES) {
  if (!ATTEMPT_ID.test(id)) throw new ArtifactError(400, 'invalid_attempt_id', 'attempt_id must look like att_ followed by 16 hex digits');
  const file = path.join(dir, `${id}.result.json`);
  let st;
  try { st = lstatSync(file); } catch (e) { if (e.code === 'ENOENT') return null; throw new ArtifactError(500, 'artifact_unreadable', 'the result file could not be read'); }
  if (st.isSymbolicLink() || !st.isFile()) throw new ArtifactError(409, 'artifact_unsafe', 'the result is not a regular file; refusing to follow it');
  if (path.dirname(realpathSync(file)) !== realpathSync(dir)) throw new ArtifactError(409, 'artifact_unsafe', 'the result file is outside the results directory');
  if (st.size > maxBytes) throw new ArtifactError(413, 'artifact_oversized', `the result is ${st.size} bytes; the limit is ${maxBytes}`);
  let fd;
  try { fd = openSync(file, constants.O_RDONLY | (constants.O_NOFOLLOW || 0)); }
  catch (e) { throw new ArtifactError(e.code === 'ELOOP' ? 409 : 500, e.code === 'ELOOP' ? 'artifact_unsafe' : 'artifact_unreadable', 'the result file could not be opened safely'); }
  try {
    const size = fstatSync(fd).size;
    if (size > maxBytes) throw new ArtifactError(413, 'artifact_oversized', `the result is ${size} bytes; the limit is ${maxBytes}`);
    const buf = Buffer.alloc(size); let off = 0;
    while (off < size) { const n = readSync(fd, buf, off, size - off, off); if (!n) break; off += n; }
    return buf.subarray(0, off);
  } finally { closeSync(fd); }
}

function parseUsage(raw) {
  let u = raw;
  if (typeof u === 'string') { try { u = JSON.parse(u); } catch { return null; } }
  if (!u || typeof u !== 'object') return null;
  const out = {};
  for (const k of USAGE_KEYS) if (typeof u[k] === 'number' && Number.isFinite(u[k])) out[k] = u[k];
  return Object.keys(out).length ? { ...out, source: 'launcher_reported' } : null;
}

function pickObserved(o) {
  o = o && typeof o === 'object' ? o : {};
  const files = (Array.isArray(o.files) ? o.files : []).filter((f) => f && typeof f.path === 'string')
    .map((f) => ({ path: f.path, sha256: typeof f.sha256 === 'string' ? f.sha256 : null, change: f.change ?? null, in_assigned_scope: f.in_assigned_scope ?? null }));
  const str = (v) => (typeof v === 'string' ? v : null);
  return { run_id: str(o.run_id), sandbox_id: str(o.sandbox_id), local_base_rev: str(o.local_base_rev), status: str(o.status),
    stop_reason: str(o.stop_reason), tool_calls: Number.isFinite(o.tool_calls) ? o.tool_calls : null, files };
}

/** Build the artifact response from the attempt (coordinator ledger) and the raw manifest bytes. */
export function buildArtifact(attempt, buf) {
  let m;
  try { m = JSON.parse(buf.toString('utf8')); } catch { throw new ArtifactError(502, 'artifact_malformed', 'the result is not valid JSON'); }
  if (!m || typeof m !== 'object' || Array.isArray(m) || m.schema !== 'orbit.local-worker.result/v1') throw new ArtifactError(502, 'artifact_malformed', 'the result is not an orbit.local-worker.result/v1 manifest');
  if (m.attempt_id !== attempt.attempt_id) throw new ArtifactError(409, 'artifact_mismatch', 'the result names a different attempt');
  const declaredRaw = m.source && m.source.repo_rev;
  if (typeof declaredRaw !== 'string' || !declaredRaw || !attempt.source_rev) throw new ArtifactError(409, 'revision_missing', 'the result and the dispatch must both name a source_rev');
  const declared = declaredRaw.toLowerCase();
  if (declared !== String(attempt.source_rev).toLowerCase()) throw new ArtifactError(409, 'artifact_mismatch', 'the result was made from a different source_rev than the coordinator dispatched');
  let diff = null;
  if (m.patch != null) {
    diff = typeof m.patch === 'string' ? m.patch : (m.patch && typeof m.patch.diff === 'string' ? m.patch.diff : undefined);
    if (diff === undefined) throw new ArtifactError(502, 'artifact_malformed', 'the result patch is not a unified diff string');
  }
  const observed = pickObserved(m.observed);
  return {
    artifact_version: ARTIFACT_VERSION, attempt_id: attempt.attempt_id, state: attempt.state,
    source_rev: attempt.source_rev || null, model: (m.source && m.source.model) || attempt.model_used || attempt.model || null,
    launcher: (m.source && m.source.launcher) || null,
    patch: diff, patch_sha256: diff == null ? null : sha256(diff), result_sha256: sha256(buf), observed,
    usage: parseUsage(m.observed && m.observed.usage), worker_claims_untrusted: m.worker_claims ?? null,
  };
}

/** The whole op: validation, state handling, restart refetch, integrity pinning. Returns [status, body]. */
export async function workerArtifact(lw, dir, body, { maxBytes = DEFAULT_MAX_BYTES, log = () => {} } = {}) {
  const id = body && body.attempt_id;
  if (typeof id !== 'string' || !ATTEMPT_ID.test(id)) throw new ArtifactError(400, 'invalid_attempt_id', 'attempt_id must look like att_ followed by 16 hex digits');
  const a = lw.get(id);
  if (!a) throw new ArtifactError(404, 'unknown_attempt', 'Orbit has no attempt with this id');
  const storedSha = typeof a.capability_sha256 === 'string' ? a.capability_sha256 : null;
  if (!storedSha) throw new ArtifactError(403, 'capability_required', 'this attempt has no artifact capability; recreate it');
  const capability = body && body.capability;
  // Ownership is the per-attempt capability only; the coordinator name in the body is a label, never authority.
  if (typeof capability !== 'string' || !capability) throw new ArtifactError(403, 'capability_required', 'send the attempt artifact_capability from create');
  const got = Buffer.from(sha256(capability), 'hex');
  const want = Buffer.from(storedSha, 'hex');
  if (got.length !== want.length || !timingSafeEqual(got, want)) throw new ArtifactError(403, 'not_owner', 'this attempt capability does not own the attempt');
  if (a.state === 'disconnected') throw new ArtifactError(503, 'worker_disconnected', 'the launcher is unreachable; retry when it reconnects', { state: a.state });
  if (PENDING_STATES.has(a.state)) throw new ArtifactError(409, 'result_pending', 'the attempt has not finished yet', { state: a.state });
  if (!RESULT_STATES.has(a.state)) throw new ArtifactError(409, 'no_result_for_state', `a ${a.state} attempt has no result`, { state: a.state });
  if (a.result_error === 'oversized') throw new ArtifactError(413, 'artifact_oversized', 'the launcher result exceeded the artifact size limit while streaming');
  let buf = readResultFile(dir, id, maxBytes);
  if (buf === null) {
    const got = await lw.refetchResult(id);
    if (got === 'oversized') throw new ArtifactError(413, 'artifact_oversized', 'the launcher result exceeded the artifact size limit while streaming');
    if (got === 'unreachable') throw new ArtifactError(503, 'launcher_unreachable', 'the result is not on disk and the launcher is unreachable');
    buf = got === 'ok' ? readResultFile(dir, id, maxBytes) : null;
    if (buf === null) throw new ArtifactError(404, 'result_missing', 'the launcher has no result for this attempt');
  }
  const art = buildArtifact(a, buf);
  const pinned = a.artifact;
  if (pinned && pinned.result_sha256 !== art.result_sha256) throw new ArtifactError(409, 'artifact_changed', 'the result changed after it was first read; refusing a substituted artifact');
  if (!pinned) lw.pinArtifact(id, { result_sha256: art.result_sha256, patch_sha256: art.patch_sha256 });
  log(`local-workers artifact ${id} served (patch_sha256 ${art.patch_sha256 || 'none'})`);
  return [200, art];
}
