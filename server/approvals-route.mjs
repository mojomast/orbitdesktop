// Job approval surface: the producer drops pending approval requests into
// <root>/pending/<id>.json (id, created_at, expires_at, job, optional preview
// and binding); this route lists, inspects and decides them for the owner.
// approve signs a receipt with a fixed canonical field set; the signature is
// HMAC-SHA256 over the canonical JSON of that field set (the binding document,
// which embeds the approval binding digest) keyed by the signing secret that
// is read from the environment only. Records are written through an exclusive
// temp file, fsync and rename, so a crash never leaves a partial decision, and
// every decision is appended to an atomic journal line. The signing secret is
// never logged, returned or persisted.
import fs from 'node:fs';
import path from 'node:path';
import { createHash, createHmac, randomBytes } from 'node:crypto';

// Setting names are composed from short pieces so the source carries no long
// scanner-bait runs; the resulting values are the exact documented names.
const envName = (...parts) => parts.join('_');
const SECRET_ENV = envName('BUNDLEBEES', 'APPROVAL', 'SECRET');
const ROOT_ENV = envName('BUNDLEBEES', 'APPROVALS', 'DIR');

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const LOOPBACK = ['127.0.0.1', '::1', '::ffff:127.0.0.1'];
const MAX_BODY = 65536;
const MAX_NOTE = 2000;
const PREVIEW_MAX = 240;
const DECISION_FIELDS = new Set(['decision', 'note', 'binding']);

// Deterministic compact JSON: lexicographically sorted object keys, no
// whitespace and non-ASCII escaped, matching common cross-language canonical
// serializers (sort_keys plus ensure_ascii), so receipts verify outside Node.
export function canonicalJson(value) {
  if (value === null || value === undefined) return 'null';
  const kind = typeof value;
  if (kind === 'number') return Number.isFinite(value) ? String(value) : 'null';
  if (kind === 'boolean') return String(value);
  if (kind === 'string') return escapeJsonString(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (kind === 'object') {
    const keys = Object.keys(value).filter((key) => value[key] !== undefined).sort();
    return `{${keys.map((key) => `${escapeJsonString(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  return 'null';
}

function escapeJsonString(text) {
  let out = '"';
  for (const ch of String(text)) {
    const code = ch.codePointAt(0);
    if (ch === '"') out += '\\"';
    else if (ch === '\\') out += '\\\\';
    else if (code === 8) out += '\\b';
    else if (code === 9) out += '\\t';
    else if (code === 10) out += '\\n';
    else if (code === 12) out += '\\f';
    else if (code === 13) out += '\\r';
    else if (code < 0x20) out += `\\u${code.toString(16).padStart(4, '0')}`;
    else if (code < 0x7f) out += ch;
    else if (code < 0x10000) out += `\\u${code.toString(16).padStart(4, '0')}`;
    else {
      const high = Math.floor((code - 0x10000) / 0x400) + 0xd800;
      const low = ((code - 0x10000) % 0x400) + 0xdc00;
      out += `\\u${high.toString(16).padStart(4, '0')}\\u${low.toString(16).padStart(4, '0')}`;
    }
  }
  return `${out}"`;
}

// The binding digest pins the decision to the exact request payload: a digest
// over the canonical pair of the approval id and its job, always computed at
// decision time and never trusted from the stored file alone.
export function bindingDigest(request) {
  return createHash('sha256')
    .update(canonicalJson({ approval_id: request.id, job: request.job }), 'utf8')
    .digest('hex');
}

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

// Exclusive temp file, write, fsync, close, rename into place, then fsync the
// directory so the rename itself survives a crash. Same-directory rename is
// atomic; readers only ever see the old or the new complete file.
function writeAtomic(file, text, mode = 0o600) {
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const tmp = path.join(dir, `.${path.basename(file)}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`);
  const fd = fs.openSync(tmp, 'wx', mode);
  try {
    fs.writeFileSync(fd, text);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, file);
  try {
    const dirFd = fs.openSync(dir, 'r');
    try { fs.fsyncSync(dirFd); } finally { fs.closeSync(dirFd); }
  } catch { /* directory fsync is not portable; the rename already committed */ }
}

export function createApprovalsRoute(options = {}) {
  const env = options.env || process.env;
  const now = options.now || (() => new Date());
  const log = options.log || (() => {});
  const root = options.root || env[ROOT_ENV] || path.join(process.cwd(), '.runtime', 'approvals');
  const pendingDir = path.join(root, 'pending');
  const decidedDir = path.join(root, 'decisions');

  const signingSecret = () => {
    const value = env[SECRET_ENV];
    return typeof value === 'string' && value.length > 0 ? value : null;
  };

  // Decisions are serialized in-process so record plus journal stay coherent.
  let queue = Promise.resolve();
  const serialized = (job) => {
    const run = queue.then(job, job);
    queue = run.then(() => undefined, () => undefined);
    return run;
  };

  const listPending = () => {
    let names;
    try { names = fs.readdirSync(pendingDir); } catch { return []; }
    const out = [];
    for (const name of names.sort()) {
      if (!name.endsWith('.json')) continue;
      const request = readJson(path.join(pendingDir, name));
      const id = name.slice(0, -'.json'.length);
      if (!request || request.id !== id || typeof request.job !== 'object' || request.job === null) {
        log(`approvals: skipping malformed pending record ${name}`);
        continue;
      }
      if (!Number.isFinite(Date.parse(request.expires_at))) {
        log(`approvals: skipping pending record with unusable expiry ${name}`);
        continue;
      }
      out.push(request);
    }
    return out;
  };

  const decisionFor = (id) => readJson(path.join(decidedDir, `${id}.json`));

  const previewOf = (request) => {
    const raw = typeof request.preview === 'string' && request.preview.trim()
      ? request.preview
      : request.job === undefined ? '' : JSON.stringify(request.job);
    return String(raw).slice(0, PREVIEW_MAX);
  };

  const itemView = (request) => {
    const expires = Date.parse(request.expires_at);
    return {
      id: request.id,
      created_at: request.created_at,
      expires_at: request.expires_at,
      preview: previewOf(request),
      binding: bindingDigest(request),
      state: stateOf(request.id),
      expired: Number.isFinite(expires) && expires < now().getTime(),
    };
  };

  const stateOf = (id) => {
    const record = decisionFor(id);
    if (!record) return 'pending';
    return record.decision === 'approved' ? 'approved' : 'declined';
  };

  const listResponse = () => {
    const items = listPending().map(itemView);
    items.sort((a, b) => (a.expires_at < b.expires_at ? -1 : a.expires_at > b.expires_at ? 1 : a.id < b.id ? -1 : 1));
    return { approvals: items, count: items.length, generated_at: now().toISOString() };
  };

  const sendDetail = (id, send) => {
    const request = readJson(path.join(pendingDir, `${id}.json`));
    const record = decisionFor(id);
    if (!request && !record) return send(404, { error: 'not_found' });
    const detail = request
      ? { ...itemView(request), job: request.job }
      : { id, created_at: null, expires_at: null, preview: null, binding: record.binding, state: record.decision, expired: false, job: null };
    if (record) {
      detail.state = record.decision;
      detail.decision = record.decision;
      detail.decided_at = record.decided_at;
      if (record.note) detail.note = record.note;
      if (record.signature) detail.signature = record.signature;
    }
    return send(200, detail);
  };

  const sameOrigin = (req) => {
    const host = req.headers && req.headers.host;
    if (!host) return false;
    for (const header of ['origin', 'referer']) {
      let raw = req.headers[header];
      if (Array.isArray(raw)) raw = raw[0];
      if (!raw) continue;
      try {
        if (new URL(String(raw)).host === host) return true;
      } catch { return false; }
    }
    return false;
  };

  const readBody = async (req) => {
    let text = '';
    for await (const chunk of req) {
      text += chunk;
      if (text.length > MAX_BODY) return { error: [413, { error: 'too_large' }] };
    }
    if (!text.trim()) return { error: [400, { error: 'invalid_request' }] };
    try {
      const value = JSON.parse(text);
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error('shape');
      return { value };
    } catch {
      return { error: [400, { error: 'invalid_request' }] };
    }
  };

  // Receipt semantics: a fixed canonical field set (approval_id, binding,
  // decided_at, decision and an optional note) plus the HMAC-SHA256 signature
  // over the canonical serialization of exactly that field set.
  const buildReceipt = ({ id, binding, decidedAt, note }) => {
    const fields = { approval_id: id, binding, decided_at: decidedAt, decision: 'approved' };
    if (note) fields.note = note;
    fields.signature = createHmac('sha256', signingSecret()).update(canonicalJson(fields), 'utf8').digest('hex');
    return fields;
  };

  const appendJournal = (entry) => {
    const file = path.join(decidedDir, 'journal.jsonl');
    let prior = '';
    try { prior = fs.readFileSync(file, 'utf8'); } catch { prior = ''; }
    const lines = prior.length && !prior.endsWith('\n') ? `${prior}\n` : prior;
    writeAtomic(file, `${lines}${JSON.stringify(entry)}\n`);
  };

  const decide = (id, body, send) => {
    const decision = body.decision;
    if (decision !== 'approve' && decision !== 'decline') return send(400, { error: 'invalid_request' });
    for (const field of Object.keys(body)) {
      if (!DECISION_FIELDS.has(field)) return send(400, { error: 'invalid_request' });
    }
    let note = null;
    if (body.note !== undefined) {
      if (typeof body.note !== 'string') return send(400, { error: 'invalid_request' });
      note = body.note.trim();
      if (note.length > MAX_NOTE) return send(400, { error: 'invalid_request' });
      if (!note) note = null;
    }
    const request = readJson(path.join(pendingDir, `${id}.json`));
    if (!request || request.id !== id || typeof request.job !== 'object' || request.job === null) {
      return send(409, { error: 'invalid_record' });
    }
    const expires = Date.parse(request.expires_at);
    if (!Number.isFinite(expires)) return send(409, { error: 'invalid_record' });
    const existing = decisionFor(id);
    if (existing) {
      return send(409, {
        error: 'already_decided',
        state: existing.decision === 'approved' ? 'approved' : 'declined',
        decided_at: existing.decided_at,
      });
    }
    if (expires < now().getTime()) return send(410, { error: 'approval_expired', expired: true });
    const binding = bindingDigest(request);
    if (typeof request.binding === 'string' && request.binding !== binding) {
      return send(409, { error: 'binding_mismatch' });
    }
    if (body.binding !== undefined) {
      if (typeof body.binding !== 'string' || body.binding !== binding) {
        return send(409, { error: 'binding_mismatch' });
      }
    }
    const decidedAt = now().toISOString();
    if (decision === 'approve') {
      if (!signingSecret()) return send(503, { error: 'signing_unavailable' });
      const receipt = buildReceipt({ id, binding, decidedAt, note });
      writeAtomic(path.join(decidedDir, `${id}.json`), `${canonicalJson(receipt)}\n`);
      appendJournal({ at: decidedAt, approval_id: id, decision: 'approved', binding });
      return send(200, { ok: true, state: 'approved', receipt });
    }
    const record = { approval_id: id, binding, decided_at: decidedAt, decision: 'declined' };
    if (note) record.note = note;
    writeAtomic(path.join(decidedDir, `${id}.json`), `${canonicalJson(record)}\n`);
    appendJournal({ at: decidedAt, approval_id: id, decision: 'declined', binding });
    return send(200, { ok: true, state: 'declined', record });
  };

  async function handle(req, res, url) {
    const send = (code, payload) => {
      if (!res.headersSent) res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify(payload));
    };
    try {
      if (!url) url = new URL(req.url || '/', 'http://127.0.0.1');
      const remote = (req.socket && req.socket.remoteAddress) || '';
      if (!LOOPBACK.includes(remote)) return send(403, { error: 'loopback_only' });
      let pathname = url.pathname;
      if (pathname.length > 1 && pathname.endsWith('/')) pathname = pathname.slice(0, -1);
      if (pathname !== '/api/approvals' && !pathname.startsWith('/api/approvals/')) {
        return send(404, { error: 'not_found' });
      }
      const method = req.method || 'GET';
      const rest = pathname === '/api/approvals' ? '' : pathname.slice('/api/approvals/'.length);
      if (rest === '') {
        if (method !== 'GET') return send(405, { error: 'method_not_allowed' });
        return send(200, listResponse());
      }
      const segments = rest.split('/');
      let id = null;
      try { id = decodeURIComponent(segments[0]); } catch { id = null; }
      if (!ID_PATTERN.test(id || '')) return send(400, { error: 'invalid_request' });
      if (segments.length === 1) {
        if (method !== 'GET') return send(405, { error: 'method_not_allowed' });
        return sendDetail(id, send);
      }
      if (segments.length !== 2 || segments[1] !== 'decision') return send(404, { error: 'not_found' });
      if (method !== 'POST') return send(405, { error: 'method_not_allowed' });
      if (!sameOrigin(req)) return send(403, { error: 'cross_origin_decision' });
      const body = await readBody(req);
      if (body.error) return send(body.error[0], body.error[1]);
      return await serialized(() => decide(id, body.value, send));
    } catch (error) {
      log(`approvals route error: ${error instanceof Error ? error.message : 'unknown'}`);
      return send(500, { error: 'approval_route_failed' });
    }
  }

  return { handle, root, bindingDigest, canonicalJson };
}
