import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { validateMcpSnapshot, MCP_APPS_LIMITS } from '../contracts/mcp-apps-v1.mjs';

const ID = /^[a-f0-9]{64}$/;
const WORKSPACE = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const ACTIONS = Object.freeze({ capabilities: [], list: [], get: ['id'], import: ['snapshot', 'expected_revision'], delete: ['id'] });
function failure(code, message) { return Object.assign(new Error(message), { code }); }
function unavailable(message = 'Unsafe or corrupt private MCP Apps storage') { return failure('unavailable', message); }
function syncDirectory(dir) {
  const fd = fs.openSync(dir, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}

export function createMcpApps({ root, workspaceRead, sandboxOrigin = '' }) {
  if (sandboxOrigin) {
    const url = new URL(sandboxOrigin);
    if (!['http:', 'https:'].includes(url.protocol) || url.origin !== sandboxOrigin || url.username || url.password) throw Error('Sandbox must be an exact HTTP(S) origin');
  }
  const storageRoot = path.resolve(root);
  // Check each path component: lstat on the final directory alone would still
  // follow a symlink in an ancestor. Never chmod an existing owner directory.
  function directory(target, create = false) {
    let current = path.parse(target).root;
    for (const component of target.slice(current.length).split(path.sep).filter(Boolean)) {
      current = path.join(current, component);
      let stat;
      try { stat = fs.lstatSync(current); }
      catch (error) {
        if (error.code !== 'ENOENT') throw error;
        if (!create) return false;
        if (current !== storageRoot && !current.startsWith(storageRoot + path.sep)) throw unavailable('Private storage parent is missing');
        fs.mkdirSync(current, { mode: 0o700 });
        syncDirectory(path.dirname(current));
        stat = fs.lstatSync(current);
      }
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw unavailable('Private storage path must contain only real directories');
      if (current === storageRoot || current.startsWith(storageRoot + path.sep)) {
        if ((stat.mode & 0o777) !== 0o700 || (process.getuid && stat.uid !== process.getuid())) throw unavailable('Private storage directories must be owner-owned mode 0700');
      }
    }
    return true;
  }
  function folder(workspace) {
    if (typeof workspace !== 'string' || !WORKSPACE.test(workspace)) throw failure('invalid_request', 'Invalid workspace identity');
    if (!workspaceRead(workspace)) throw failure('permission_denied', 'Unknown workspace');
    const dir = path.join(storageRoot, 'mcp-apps', workspace);
    directory(dir);
    return dir;
  }
  function read(dir, id) {
    if (typeof id !== 'string' || !ID.test(id)) throw failure('invalid_request', 'Invalid snapshot identity');
    if (!directory(dir)) throw unavailable('Snapshot unavailable');
    // O_NONBLOCK also makes a malicious FIFO fail at fstat instead of hanging
    // before the regular-file check. Allocate only after the descriptor is checked.
    const fd = fs.openSync(path.join(dir, `${id}.json`), fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    try {
      const stat = fs.fstatSync(fd);
      if (!stat.isFile() || stat.nlink !== 1 || (stat.mode & 0o777) !== 0o600 || (process.getuid && stat.uid !== process.getuid()) || stat.size < 1 || stat.size > MCP_APPS_LIMITS.bytes) throw unavailable();
      const bytes = Buffer.alloc(stat.size);
      let offset = 0;
      while (offset < bytes.length) {
        const length = fs.readSync(fd, bytes, offset, bytes.length - offset, offset);
        if (!length) throw unavailable();
        offset += length;
      }
      const after = fs.fstatSync(fd);
      if (fs.readSync(fd, Buffer.alloc(1), 0, 1, offset) !== 0 || after.size !== stat.size || after.mtimeMs !== stat.mtimeMs || after.ctimeMs !== stat.ctimeMs || after.nlink !== 1) throw unavailable();
      if (createHash('sha256').update(bytes).digest('hex') !== id) throw unavailable('Corrupt snapshot');
      try { return validateMcpSnapshot(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))); }
      catch { throw unavailable('Corrupt snapshot'); }
    } finally { fs.closeSync(fd); }
  }
  function listing(dir) {
    if (!directory(dir)) return [];
    const handle = fs.opendirSync(dir), ids = [];
    try {
      let entry;
      while ((entry = handle.readSync())) {
        if (!/^[a-f0-9]{64}\.json$/.test(entry.name) || !entry.isFile()) throw unavailable('Unexpected private storage entry');
        if (ids.length >= MCP_APPS_LIMITS.snapshots) throw unavailable('Private snapshot retention bound exceeded');
        ids.push(entry.name.slice(0, -5));
      }
    } finally { handle.closeSync(); }
    return ids.sort();
  }
  function dispatch(body) {
    if (!body || typeof body !== 'object' || Array.isArray(body) || !Object.hasOwn(body, 'action') || typeof body.action !== 'string' || !Object.hasOwn(ACTIONS, body.action)) throw failure('invalid_request', 'Invalid request');
    const fields = ACTIONS[body.action];
    if (Object.keys(body).some(key => !['action', 'workspace_id', ...fields].includes(key)) || !Object.hasOwn(body, 'workspace_id') || fields.some(key => !Object.hasOwn(body, key))) throw failure('invalid_request', 'Invalid request fields');
    if (fields.includes('id') && (typeof body.id !== 'string' || !ID.test(body.id))) throw failure('invalid_request', 'Invalid snapshot identity');
    if (body.action === 'import' && (typeof body.expected_revision !== 'string' || !ID.test(body.expected_revision))) throw failure('invalid_request', 'Invalid collection revision');
    const dir = folder(body.workspace_id);
    if (body.action === 'capabilities') return { available: Boolean(sandboxOrigin), sandbox_origin: sandboxOrigin, capabilities: { logging: {} }, reason: sandboxOrigin ? '' : 'Configure ORBIT_MCP_APPS_SANDBOX_ORIGIN and a separate sandbox proxy.' };
    const ids = listing(dir);
    // A corrupt record must not be silently filtered out or bypassed by a write.
    const items = ids.map(id => ({ id, title: read(dir, id).title }));
    const revision = createHash('sha256').update(JSON.stringify(ids)).digest('hex');
    if (body.action === 'list') return { items, count: ids.length, revision };
    if (body.action === 'get') return { id: body.id, snapshot: read(dir, body.id) };
    if (body.action === 'delete') {
      // An immutable identity already absent has the same successful outcome.
      if (ids.includes(body.id)) {
        fs.unlinkSync(path.join(dir, `${body.id}.json`));
        syncDirectory(dir);
      } else if (directory(dir)) syncDirectory(dir); // retry after unlink/fsync failure
      return { deleted: body.id };
    }
    let snapshot;
    try { snapshot = validateMcpSnapshot(body.snapshot); }
    catch (error) { throw failure('invalid_request', error.message); }
    const bytes = JSON.stringify(snapshot), id = createHash('sha256').update(bytes).digest('hex');
    if (ids.includes(id)) { syncDirectory(dir); return { id, count: ids.length }; }
    if (body.expected_revision !== revision) throw failure('conflict', 'Snapshot collection changed; refresh before importing');
    if (ids.length >= MCP_APPS_LIMITS.snapshots) throw failure('limit_exceeded', '64 snapshot retention limit; delete an unused snapshot');
    directory(dir, true);
    const temporary = path.join(dir, `.${randomUUID()}`);
    let fd;
    try {
      fd = fs.openSync(temporary, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
      fs.writeFileSync(fd, bytes);
      fs.fsyncSync(fd);
      fs.closeSync(fd); fd = undefined;
      fs.linkSync(temporary, path.join(dir, `${id}.json`));
    } finally {
      try { if (fd !== undefined) fs.closeSync(fd); }
      finally { try { fs.unlinkSync(temporary); } catch (error) { if (error.code !== 'ENOENT') throw error; } }
    }
    syncDirectory(dir);
    return { id, count: ids.length + 1 };
  }
  return { dispatch(body) {
    try { return dispatch(body); }
    catch (error) {
      if (['invalid_request', 'permission_denied', 'conflict', 'limit_exceeded', 'unavailable'].includes(error.code)) throw error;
      throw unavailable('Private snapshot storage unavailable');
    }
  } };
}
