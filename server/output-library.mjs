// Owner-only durable metadata for the published-output library.
//
// The shelf itself stays in server/workspace.mjs and enumerates immutable
// bundles/artifacts; this service never renames, deletes or rewrites those
// files. It only persists bounded owner aliases/pins/tags in small private JSON
// files under `<root>/output-library/<workspace_id>.json` (atomic temp+rename,
// fsync, mode 0600). No SQLite migration is added and no JSON runtime is touched.
//
// Records are keyed by the canonical immutable resource URL
// (`/apps/<full content-addressed slug>/<relative>`). Multiple releases of the
// same logical app are distinct resources: an alias/pin for an old report never
// attaches to a changed report. There is no logical-id migration.
//
// Revision compare-and-swap: every committed change increments a per-workspace
// revision. A stale `base_revision` is rejected with the current revision and
// records so the client can keep its draft and resolve explicitly. There is no
// request-id idempotency layer.
import fs from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import Ajv from 'ajv';
import {allowedRequest, tokenMatches} from './security.mjs';
import {
  OUTPUT_LIBRARY_LIMITS,
  isWorkspaceId,
  shelfItemId,
} from '../src/output-library-helpers.ts';

export const OUTPUT_LIBRARY_FILE_BYTES = 256 * 1024;
const CONTROL = /[\u0000-\u001f\u007f]/;

const requestSchema = {
  type: 'object',
  oneOf: [
    {
      type: 'object',
      additionalProperties: false,
      required: ['action', 'workspace_id'],
      properties: { action: { const: 'list' }, workspace_id: { type: 'string' } },
    },
    {
      type: 'object',
      additionalProperties: false,
      required: ['action', 'workspace_id', 'url', 'base_revision', 'patch'],
      properties: {
        action: { const: 'set' },
        workspace_id: { type: 'string' },
        url: { type: 'string', minLength: 1, maxLength: 1024 },
        base_revision: { type: 'integer', minimum: 0, maximum: Number.MAX_SAFE_INTEGER },
        patch: {
          type: 'object',
          additionalProperties: false,
          minProperties: 1,
          properties: {
            alias: { type: ['string', 'null'], maxLength: OUTPUT_LIBRARY_LIMITS.maxAliasLength },
            pinned: { type: 'boolean' },
            tags: {
              type: 'array',
              maxItems: OUTPUT_LIBRARY_LIMITS.maxTagsPerItem,
              items: {
                type: 'string',
                minLength: 1,
                maxLength: OUTPUT_LIBRARY_LIMITS.maxTagLength,
                pattern: '^[^\\u0000-\\u001f\\u007f]*$',
              },
            },
          },
        },
      },
    },
  ],
};

const emptyRecord = workspace_id => ({ version: 1, workspace_id, revision: 0, items: {} });
const fail = (code, extra) => Object.assign(Error(code), { code }, extra);
const conflict = (snapshot, requested) => fail('conflict', { current: { ...snapshot, requested: requested?.item_id ?? null } });

// Stored records are validated strictly and returned as a defensive copy of
// known fields. Nothing is coerced, trimmed or repaired: an unexpected shape
// fails closed as `unavailable` rather than silently normalizing.
function validateStored(workspace_id, value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw fail('unavailable');
  if (value.version !== 1 || value.workspace_id !== workspace_id) throw fail('unavailable');
  if (!Number.isSafeInteger(value.revision) || value.revision < 0) throw fail('unavailable');
  if (!value.items || typeof value.items !== 'object' || Array.isArray(value.items)) throw fail('unavailable');
  const entries = Object.entries(value.items);
  if (entries.length > OUTPUT_LIBRARY_LIMITS.maxItems) throw fail('unavailable');
  const items = {};
  for (const [item_id, record] of entries) {
    if (typeof item_id !== 'string' || item_id.length > OUTPUT_LIBRARY_LIMITS.maxUrlLength) throw fail('unavailable');
    if (!record || typeof record !== 'object' || Array.isArray(record)) throw fail('unavailable');
    if (typeof record.url !== 'string' || shelfItemId(record.url) !== item_id) throw fail('unavailable');
    if (!(record.alias === null || (typeof record.alias === 'string' && record.alias.length > 0 && record.alias.length <= OUTPUT_LIBRARY_LIMITS.maxAliasLength && !CONTROL.test(record.alias)))) throw fail('unavailable');
    if (record.pinned !== true && record.pinned !== false) throw fail('unavailable');
    if (!Array.isArray(record.tags) || record.tags.length > OUTPUT_LIBRARY_LIMITS.maxTagsPerItem) throw fail('unavailable');
    for (const tag of record.tags) {
      if (typeof tag !== 'string' || tag.length === 0 || tag.length > OUTPUT_LIBRARY_LIMITS.maxTagLength || CONTROL.test(tag)) throw fail('unavailable');
    }
    if (!Number.isSafeInteger(record.updated_at) || record.updated_at < 0) throw fail('unavailable');
    items[item_id] = { url: record.url, alias: record.alias, pinned: record.pinned, tags: [...record.tags], updated_at: record.updated_at };
  }
  return { version: 1, workspace_id, revision: value.revision, items };
}

/**
 * @param {object} options
 * @param {string} options.root private runtime root (metadata lives under it)
 * @param {string} options.token owner Orbit token
 * @param {number} options.port listening port for origin/host checks
 * @param {string[]} [options.devOrigins]
 * @param {Function} options.reply shared JSON reply helper
 * @param {Function} [options.workspaceRead] id => workspace record (throws ENOENT when absent)
 * @param {object} [options.store] workspace store; `store.read` is used when workspaceRead is absent
 * @param {number} [options.now]
 */
export function createOutputLibrary({ root, token, port, devOrigins = [], reply, workspaceRead = null, store = null, now = Date.now }) {
  const valid = new Ajv({ strict: true, allErrors: false, allowUnionTypes: true }).compile(requestSchema);
  const readWorkspace = typeof workspaceRead === 'function' ? workspaceRead : (typeof store?.read === 'function' ? store.read.bind(store) : null);
  const maxBodyBytes = 32 * 1024;
  // A set response contains the bounded snapshot plus the changed item. Keep
  // headroom so a valid committed file cannot produce a post-commit 413.
  const maxResponseBytes = 2 * OUTPUT_LIBRARY_FILE_BYTES;

  function assertWorkspace(workspace_id) {
    if (!isWorkspaceId(workspace_id)) throw fail('invalid_request');
    if (!readWorkspace) throw fail('unavailable');
    try {
      readWorkspace(workspace_id);
    } catch (error) {
      if (error?.code === 'ENOENT' || error?.category === 'RESOURCE_GONE') throw fail('unavailable');
      throw error;
    }
  }

  function directory() {
    const dir = path.join(root, 'output-library');
    if (fs.existsSync(dir)) {
      const stat = fs.lstatSync(dir);
      if (stat.isSymbolicLink() || !stat.isDirectory()) throw fail('unavailable');
    } else {
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    }
    return dir;
  }

  function fileFor(workspace_id) {
    return path.join(directory(), `${workspace_id}.json`);
  }

  function read(workspace_id) {
    const file = fileFor(workspace_id);
    if (!fs.existsSync(file)) return emptyRecord(workspace_id);
    const stat = fs.lstatSync(file);
    if (stat.isSymbolicLink() || !stat.isFile() || stat.size > OUTPUT_LIBRARY_FILE_BYTES) throw fail('unavailable');
    let parsed;
    try {
      parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
      throw fail('unavailable');
    }
    return validateStored(workspace_id, parsed);
  }

  function write(record) {
    const dir = directory();
    const file = path.join(dir, `${record.workspace_id}.json`);
    if (fs.existsSync(file) && fs.lstatSync(file).isSymbolicLink()) throw fail('unavailable');
    const bytes = JSON.stringify(record);
    if (Buffer.byteLength(bytes) > OUTPUT_LIBRARY_FILE_BYTES) throw fail('limit_exceeded');
    const temporary = path.join(dir, `.write-${randomUUID()}`);
    let fd;
    try {
      fd = fs.openSync(temporary, 'wx', 0o600);
      fs.writeFileSync(fd, bytes);
      fs.fsyncSync(fd);
      fs.closeSync(fd);
      fd = undefined;
      fs.renameSync(temporary, file);
      const directoryFd = fs.openSync(dir, 'r');
      try {
        fs.fsyncSync(directoryFd);
      } finally {
        fs.closeSync(directoryFd);
      }
    } finally {
      if (fd !== undefined) {
        try { fs.closeSync(fd); } catch {}
      }
      try { fs.rmSync(temporary, { force: true }); } catch {}
    }
  }

  function snapshot(record, item_id) {
    return {
      workspace_id: record.workspace_id,
      revision: record.revision,
      items: record.items,
      ...(item_id && record.items[item_id] ? { metadata: record.items[item_id] } : {}),
    };
  }

  function applyPatch(previous, patch) {
    const next = previous
      ? { url: previous.url, alias: previous.alias, pinned: previous.pinned, tags: [...previous.tags], updated_at: previous.updated_at }
      : { url: '', alias: null, pinned: false, tags: [], updated_at: 0 };
    if (Object.hasOwn(patch, 'alias')) next.alias = typeof patch.alias === 'string' && patch.alias.trim() ? patch.alias.trim().slice(0, OUTPUT_LIBRARY_LIMITS.maxAliasLength) : null;
    if (Object.hasOwn(patch, 'pinned')) next.pinned = patch.pinned === true;
    if (Object.hasOwn(patch, 'tags')) {
      const seen = new Set();
      next.tags = [];
      for (const raw of patch.tags ?? []) {
        const tag = String(raw).trim().slice(0, OUTPUT_LIBRARY_LIMITS.maxTagLength);
        if (!tag || seen.has(tag.toLowerCase())) continue;
        seen.add(tag.toLowerCase());
        next.tags.push(tag);
        if (next.tags.length >= OUTPUT_LIBRARY_LIMITS.maxTagsPerItem) break;
      }
    }
    return next;
  }

  async function dispatch(body) {
    assertWorkspace(body.workspace_id);
    if (body.action === 'list') {
      const record = read(body.workspace_id);
      return snapshot(record);
    }
    const item_id = shelfItemId(body.url);
    if (!item_id) throw fail('invalid_request');
    const record = read(body.workspace_id);
    if (body.base_revision !== record.revision) throw conflict(snapshot(record, item_id), { item_id });
    if (!Number.isSafeInteger(record.revision + 1)) throw fail('limit_exceeded');
    const previous = record.items[item_id];
    const next = applyPatch(previous, body.patch);
    next.url = body.url;
    next.updated_at = now();
    const items = { ...record.items, [item_id]: next };
    if (Object.keys(items).length > OUTPUT_LIBRARY_LIMITS.maxItems) throw fail('limit_exceeded');
    const committed = { version: 1, workspace_id: body.workspace_id, revision: record.revision + 1, items };
    write(committed);
    return { ...snapshot(committed, item_id), item_id };
  }

  function statusFor(code) {
    return { invalid_request: 400, permission_denied: 403, unavailable: 404, conflict: 409, limit_exceeded: 413, busy: 503 }[code] ?? 503;
  }

  async function handle(req, res) {
    res.setHeader('Cache-Control', 'no-store');
    if (req.method !== 'POST') return reply(res, 405, { ok: false, code: 'invalid_request', error: 'POST required' });
    const auth = req.headers.authorization ?? '';
    if (!allowedRequest(req, port, devOrigins) || !auth.startsWith('Bearer ') || !tokenMatches(auth.slice(7), token))
      return reply(res, 403, { ok: false, code: 'permission_denied', error: 'Owner authentication required' });
    try {
      let bytes = 0;
      const chunks = [];
      for await (const chunk of req) {
        bytes += Buffer.byteLength(chunk);
        if (bytes > maxBodyBytes) throw fail('limit_exceeded');
        chunks.push(Buffer.from(chunk));
      }
      let body;
      try {
        body = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)));
      } catch {
        throw fail('invalid_request');
      }
      if (!valid(body)) throw fail('invalid_request');
      let result;
      try {
        result = await dispatch(body);
      } catch (error) {
        if (error?.code === 'conflict' && error.current) {
          const payload = { ok: false, code: 'conflict', error: 'Metadata changed; review the current values and retry', ...error.current };
          return reply(res, 409, payload);
        }
        throw error;
      }
      const payload = { ok: true, ...result };
      if (Buffer.byteLength(JSON.stringify(payload)) > maxResponseBytes) throw fail('limit_exceeded');
      return reply(res, 200, payload);
    } catch (error) {
      const raw = typeof error?.code === 'string' ? error.code : '';
      const known = Object.hasOwn({ invalid_request: 1, permission_denied: 1, unavailable: 1, conflict: 1, limit_exceeded: 1, busy: 1 }, raw)
        ? raw
        : raw.startsWith('SQLITE_') ? 'busy' : 'unavailable';
      return reply(res, statusFor(known), { ok: false, code: known, error: known });
    }
  }

  return { handle, read, directory, itemId: shelfItemId, limits: OUTPUT_LIBRARY_LIMITS };
}
