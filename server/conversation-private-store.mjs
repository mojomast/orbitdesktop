import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

const fail = (status, message) => Object.assign(Error(message), { status });
// Single service writer, synchronous CAS and rename/fsync, matching the private
// submission journal. No content enters the workspace DB or metadata events.
export function createConversationPrivateStore(directory) {
  try {
    const root = fs.lstatSync(directory);
    if (root.isSymbolicLink() || !root.isDirectory()) throw fail(409, 'Private conversation directory unavailable.');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  }
  const root = fs.lstatSync(directory);
  if (root.isSymbolicLink() || !root.isDirectory()) throw fail(409, 'Private conversation directory unavailable.');
  fs.chmodSync(directory, 0o700);
  const key = scope => createHash('sha256').update(JSON.stringify([scope.workspace_id, scope.profile_id, scope.session_id])).digest('hex');
  const fields = new Set(['workspace_id', 'profile_id', 'session_id', 'revision', 'title', 'pinned', 'archived', 'draft', 'updated_at']);
  function validateRecord(record, filename) {
    if (!record || typeof record !== 'object' || Array.isArray(record) ||
        Object.keys(record).some(field => !fields.has(field)) ||
        ['workspace_id', 'profile_id', 'session_id'].some(field => typeof record[field] !== 'string') ||
        !Number.isSafeInteger(record.revision) || record.revision < 0 ||
        typeof record.title !== 'string' || record.title.length > 200 || /[\x00-\x1f\x7f]/.test(record.title) ||
        typeof record.draft !== 'string' || record.draft.length > 100000 ||
        typeof record.pinned !== 'boolean' || typeof record.archived !== 'boolean' ||
        ('updated_at' in record && (typeof record.updated_at !== 'string' || record.updated_at.length > 100)) ||
        `${key(record)}.json` !== filename) throw fail(409, 'Private conversation record is invalid or does not match its key.');
    return record;
  }
  function readFile(filename) {
    const file = path.join(directory, filename), stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 512000) throw fail(409, 'Private conversation record unavailable.');
    let record;
    try { record = JSON.parse(fs.readFileSync(file, 'utf8')); }
    catch (error) { if (error.code === 'ENOENT') throw error; throw fail(409, 'Private conversation record is invalid.'); }
    return validateRecord(record, filename);
  }
  function read(scope) {
    try {
      const record = readFile(`${key(scope)}.json`);
      if (record.workspace_id !== scope.workspace_id || record.profile_id !== scope.profile_id || record.session_id !== scope.session_id) throw fail(409, 'Private conversation record does not match its scope.');
      return record;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      return { workspace_id: scope.workspace_id, profile_id: scope.profile_id, session_id: scope.session_id, revision: 0, title: '', pinned: false, archived: false, draft: '' };
    }
  }
  function write(scope, revision, patch) {
    const record = read(scope);
    if (record.revision !== revision) return { conflict: true, record };
    if (record.revision === Number.MAX_SAFE_INTEGER) throw fail(409, 'Private conversation revision limit reached.');
    if (record.revision === 0 && fs.readdirSync(directory).length >= 2048) throw fail(409, 'Private conversation store is full.');
    const next = { ...record, ...patch, revision: record.revision + 1, updated_at: new Date().toISOString() };
    validateRecord(next, `${key(scope)}.json`);
    const bytes = JSON.stringify(next);
    if (Buffer.byteLength(bytes) > 512000) throw fail(413, 'Private conversation record exceeds its limit.');
    const temp = path.join(directory, `${randomUUID()}.tmp`);
    const fd = fs.openSync(temp, 'wx', 0o600);
    try {
      try { fs.writeFileSync(fd, bytes); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
      fs.renameSync(temp, path.join(directory, `${key(scope)}.json`));
      const dir = fs.openSync(directory, 'r');
      try { fs.fsyncSync(dir); } finally { fs.closeSync(dir); }
    } finally { try { fs.unlinkSync(temp); } catch {} }
    return { conflict: false, record: next };
  }
  function list(workspace_id, profile_id) {
    return fs.readdirSync(directory).filter(name => /^[a-f0-9]{64}\.json$/.test(name)).slice(0, 2048).flatMap(name => {
      const record = readFile(name);
      return record.workspace_id === workspace_id && record.profile_id === profile_id ? [record] : [];
    });
  }
  return { read, write, list };
}
