// Missing native binding/source is a test failure, never a green skip gate.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {SqliteWorkspaceStore} from '../../server/sqlite-workspace-store.mjs';
export async function loadSqliteWorkspaceStore() {return SqliteWorkspaceStore;}

/**
 * Create a unique disposable root directory. Prefer /tmp/opencode when present,
 * otherwise fall back to the OS temp directory. Callers must remove only the
 * roots they created (see `removeRoot`).
 */
export function tempRoot(prefix = 'orbit-sqlite-') {
  const base = fs.existsSync('/tmp/opencode') ? '/tmp/opencode' : os.tmpdir();
  fs.mkdirSync(base, { recursive: true });
  return fs.mkdtempSync(path.join(base, prefix));
}

/** Remove only a directory previously created by `tempRoot`. */
export function removeRoot(root) {
  if (typeof root === 'string' && root.length > 0) {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

/**
 * The store reports structured failures. REVISION_CONFLICT / IDEMPOTENCY_CONFLICT
 * / MIGRATION_REQUIRED are specified as `error.category`; for "not found" accept
 * either `category` or the legacy `code` used by server/workspace.mjs.
 */
export function errorCategory(error) {
  // A missing workspace is signalled with the legacy `code: 'ENOENT'` (which
  // server/workspace.mjs relies on) while the HTTP-style `category` is
  // RESOURCE_GONE. "missing ENOENT" is therefore satisfied by either channel.
  if (error?.code === 'ENOENT') return 'ENOENT';
  return error?.category ?? error?.code ?? null;
}
