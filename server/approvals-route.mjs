// Isolated legacy-format approval store. NOT the BundleBees authorization API.
// No production mount: see docs/SECURITY.md. No ambient key or storage root.
import fs from 'node:fs';
import path from 'node:path';
import { createHash, createHmac, randomBytes } from 'node:crypto';
import { allowedRequest, tokenMatches } from './security.mjs';

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const LOOPBACK = ['127.0.0.1', '::1', '::ffff:127.0.0.1'];
const MAX_BODY = 65536;
const MAX_NOTE = 2000;
const PREVIEW_MAX = 240;
const DECISION_FIELDS = new Set(['decision', 'note', 'binding']);
const HASH = /^[a-f0-9]{64}$/;
const MAX_JOURNAL = 8 * 1024 * 1024;
const { O_NOFOLLOW, O_RDONLY, O_NONBLOCK, O_APPEND, O_CREAT, O_WRONLY } = fs.constants;

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

function invalidStore() { throw Error('Invalid approval store'); }

function optional(read, absent) {
  try { return read(); } catch (e) { if (e.code === 'ENOENT') return absent; throw e; }
}

function namesIn(dir) {
  const st = optional(() => fs.lstatSync(dir), null);
  if (!st) return [];
  if (!st.isDirectory()) invalidStore();
  return fs.readdirSync(dir);
}

function readText(file, limit) {
  const fd = optional(() => fs.openSync(file, O_RDONLY | O_NOFOLLOW | O_NONBLOCK), null);
  if (fd === null) return null;
  try {
    const st = fs.fstatSync(fd);
    if (!st.isFile() || st.size > limit) invalidStore();
    return new TextDecoder('utf-8', {fatal:true}).decode(fs.readFileSync(fd));
  } finally { fs.closeSync(fd); }
}

function readJson(file) {
  const text = readText(file, MAX_BODY);
  if (text === null) return null;
  const value = JSON.parse(text);
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalidStore();
  return value;
}

function syncDir(dir) {
  const fd = fs.openSync(dir, O_RDONLY | O_NOFOLLOW | fs.constants.O_DIRECTORY);
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}

// Link a complete fsynced receipt into place exclusively: never replace evidence.
function publishOnce(file, text) {
  const dir = path.dirname(file);
  const tmp = path.join(dir, `.${path.basename(file)}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`);
  const fd = fs.openSync(tmp, 'wx', 0o600);
  try {
    try { fs.writeFileSync(fd, text); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    fs.linkSync(tmp, file);
  } finally { fs.unlinkSync(tmp); }
  syncDir(dir);
}

export function createApprovalsRoute(options = {}) {
  const { root, token, port, key, now = () => new Date() } = options;
  if (!root || !path.isAbsolute(root)) throw Error('A private per-workspace store is required');
  const pendingDir = path.join(root, 'pending');
  const decidedDir = path.join(root, 'decisions');
  const journal = path.join(decidedDir, 'journal.jsonl');
  const writer = path.join(root, '.approval-writer');

  const listPending = () => {
    const names = namesIn(pendingDir);
    const out = [];
    for (const name of names.sort()) {
      if (!name.endsWith('.json')) continue;
      const request = readJson(path.join(pendingDir, name));
      const id = name.slice(0, -'.json'.length);
      if (!validRequest(request, id)) invalidStore();
      out.push(request);
    }
    return out;
  };

  function validRequest(request, id) {
    return ID_PATTERN.test(id) && request?.id === id && request.job && typeof request.job === 'object' &&
      !Array.isArray(request.job) && Number.isFinite(Date.parse(request.expires_at));
  }

  // Validate both sides before reads as well as mutations. Never present a
  // corrupt/missing receipt as pending, or a store with missing history as new.
  function history(holdingLock = false) {
    if (!holdingLock && optional(() => fs.lstatSync(writer), null)) invalidStore();
    const names = namesIn(decidedDir);
    const receipts = new Map();
    const text = readText(journal, MAX_JOURNAL);
    if (text && !text.endsWith('\n')) invalidStore();
    for (const line of (text || '').split('\n').slice(0, -1)) {
      const e = JSON.parse(line);
      if (!e || Object.keys(e).sort().join(',') !== 'approval_id,at,binding,decision' ||
          typeof e.approval_id !== 'string' || !ID_PATTERN.test(e.approval_id) ||
          !['approved','declined'].includes(e.decision) || typeof e.binding !== 'string' || !HASH.test(e.binding) || typeof e.at !== 'string' ||
          !Number.isFinite(Date.parse(e.at)) || receipts.has(e.approval_id)) invalidStore();
      const record = readJson(path.join(decidedDir, `${e.approval_id}.json`));
      if (!record || record.approval_id !== e.approval_id || record.binding !== e.binding ||
          record.decision !== e.decision || record.decided_at !== e.at ||
          Object.keys(record).some(k => !['approval_id','binding','decided_at','decision','note','signature'].includes(k)) ||
          (Object.hasOwn(record, 'note') && (typeof record.note !== 'string' || record.note.length > MAX_NOTE))) invalidStore();
      if (record.decision === 'approved') {
        const {signature, ...fields} = record;
        if (!key || !HASH.test(signature) || !tokenMatches(signature, sign(fields))) invalidStore();
      } else if (Object.hasOwn(record, 'signature')) invalidStore();
      receipts.set(e.approval_id, record);
    }
    if (names.some(n => n.endsWith('.json') && !receipts.has(n.slice(0, -5)))) invalidStore();
    return receipts;
  }

  function sign(fields) {
    return createHmac('sha256', key).update(canonicalJson(fields), 'utf8').digest('hex');
  }

  const previewOf = (request) => {
    const raw = typeof request.preview === 'string' && request.preview.trim()
      ? request.preview
      : request.job === undefined ? '' : JSON.stringify(request.job);
    return String(raw).slice(0, PREVIEW_MAX);
  };

  const itemView = (request, record) => {
    const expires = Date.parse(request.expires_at);
    const binding = bindingDigest(request);
    if (record && record.binding !== binding) invalidStore();
    return {
      id: request.id,
      created_at: request.created_at,
      expires_at: request.expires_at,
      preview: previewOf(request),
      binding,
      state: record?.decision || 'pending',
      expired: expires <= now().getTime(),
    };
  };

  const listResponse = () => {
    const records = history();
    const items = listPending().map(request => itemView(request, records.get(request.id)));
    items.sort((a, b) => (a.expires_at < b.expires_at ? -1 : a.expires_at > b.expires_at ? 1 : a.id < b.id ? -1 : 1));
    return { approvals: items, count: items.length, generated_at: now().toISOString() };
  };

  const sendDetail = (id, send) => {
    const request = readJson(path.join(pendingDir, `${id}.json`));
    const record = history().get(id);
    if (request && !validRequest(request, id)) invalidStore();
    if (!request && !record) return send(404, { error: 'not_found' });
    const detail = request
      ? { ...itemView(request, record), job: request.job }
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

  const readBody = async (req) => {
    let bytes = 0;
    const chunks = [];
    for await (const chunk of req) {
      bytes += Buffer.byteLength(chunk);
      if (bytes > MAX_BODY) return { error: [413, { error: 'too_large' }] };
      chunks.push(Buffer.from(chunk));
    }
    try {
      const text = new TextDecoder('utf-8', {fatal:true}).decode(Buffer.concat(chunks));
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
    fields.signature = sign(fields);
    return fields;
  };

  const appendJournal = (entry) => {
    const row = Buffer.from(`${JSON.stringify(entry)}\n`);
    const fd = fs.openSync(journal, O_WRONLY | O_CREAT | O_APPEND | O_NOFOLLOW | O_NONBLOCK, 0o600);
    try {
      const st = fs.fstatSync(fd);
      if (!st.isFile() || st.size + row.length > MAX_JOURNAL) invalidStore();
      if (fs.writeSync(fd, row) !== row.length) invalidStore();
      fs.fsyncSync(fd);
    } finally { fs.closeSync(fd); }
    syncDir(decidedDir);
  };

  const decide = (id, body, publish) => {
    const decision = body.decision;
    if (decision !== 'approve' && decision !== 'decline') return [400, { error: 'invalid_request' }];
    for (const field of Object.keys(body)) {
      if (!DECISION_FIELDS.has(field)) return [400, { error: 'invalid_request' }];
    }
    let note = null;
    if (body.note !== undefined) {
      if (typeof body.note !== 'string') return [400, { error: 'invalid_request' }];
      note = body.note.trim();
      if (note.length > MAX_NOTE) return [400, { error: 'invalid_request' }];
      if (!note) note = null;
    }
    const request = readJson(path.join(pendingDir, `${id}.json`));
    if (!validRequest(request, id)) {
      return [409, { error: 'invalid_record' }];
    }
    const existing = history(true).get(id);
    const binding = bindingDigest(request);
    if (existing && existing.binding !== binding) invalidStore();
    if (existing) {
      return [409, {
        error: 'already_decided',
        state: existing.decision === 'approved' ? 'approved' : 'declined',
        decided_at: existing.decided_at,
      }];
    }
    const at = now();
    if (Date.parse(request.expires_at) <= at.getTime()) return [410, { error: 'approval_expired', expired: true }];
    if (request.binding !== undefined && request.binding !== binding) {
      return [409, { error: 'binding_mismatch' }];
    }
    if (body.binding !== binding) return [409, { error: 'binding_mismatch' }];
    const decidedAt = at.toISOString();
    if (decision === 'approve' && (!key || Buffer.byteLength(key) < 32)) return [503, { error: 'signing_unavailable' }];
    const record = decision === 'approve' ? buildReceipt({id, binding, decidedAt, note}) :
      { approval_id: id, binding, decided_at: decidedAt, decision: 'declined', ...(note ? {note} : {}) };
    // Never expose a consumable receipt until its history is durable. A crash
    // between files is intentionally unavailable, not an excuse to re-sign.
    publish(record);
    return [200, { ok: true, state: record.decision, [decision === 'approve' ? 'receipt' : 'record']: record }];
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
      const auth = req.headers.authorization;
      if (typeof token !== 'string' || token.length < 32 || !allowedRequest(req, port) ||
          typeof auth !== 'string' || !auth.startsWith('Bearer ') || !tokenMatches(auth.slice(7), token))
        return send(403, { error: 'permission_denied' });
      // The fixture binds exactly one pre-provisioned root; no caller-chosen
      // workspace, directory or actor. Refuse directory symlinks before I/O.
      const rootStat = fs.lstatSync(root);
      if (fs.realpathSync(root) !== root || !rootStat.isDirectory() || (rootStat.mode & 0o077) !== 0) invalidStore();
      for (const dir of [pendingDir, decidedDir]) {
        const stat = optional(() => fs.lstatSync(dir), null);
        if (stat && !stat.isDirectory()) invalidStore();
      }
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
      const body = await readBody(req);
      if (body.error) return send(body.error[0], body.error[1]);
      // Serialize the history check, journal append and receipt publication
      // across cooperating processes. Do not steal a crashed writer's lock.
      fs.mkdirSync(writer, {mode:0o700});
      let response;
      let uncertain = false;
      try {
        fs.mkdirSync(decidedDir, {recursive:true, mode:0o700});
        syncDir(root);
        response = decide(id, body.value, record => {
          uncertain = true;
          appendJournal({at:record.decided_at, approval_id:id, decision:record.decision, binding:record.binding});
          publishOnce(path.join(decidedDir, `${id}.json`), `${canonicalJson(record)}\n`);
          uncertain = false;
        });
      } finally {
        if (!uncertain) { fs.rmdirSync(writer); syncDir(root); }
      }
      return send(...response);
    } catch {
      return send(503, { error: 'approval_store_unavailable' });
    }
  }

  return { handle, root, bindingDigest, canonicalJson };
}
