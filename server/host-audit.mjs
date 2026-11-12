import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

/**
 * Append-only, hash-chained audit log for host commands.
 *
 * One JSONL file per host lives at <runtime>/audit/hosts/<hostId>.jsonl. The
 * file is 0600 inside a 0700 directory and is opened with O_APPEND | O_CREAT |
 * O_NOFOLLOW so a symlink can never redirect a write outside the runtime.
 *
 * Secrets are redacted before serialization. The chain is prev_sha256 over a
 * canonical record; read() re-computes every hash and reports the first broken
 * entry instead of silently trusting the file.
 */

const HOST_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const MAX_ARGV = 64;
const MAX_ARG_LENGTH = 2048;
const MAX_TAIL = 4096;
export const AUDIT_GENESIS = '0'.repeat(64);

function auditError(code, message) {
  const error = new Error(message || code);
  error.code = code;
  return error;
}

function assertHostId(hostId) {
  if (typeof hostId !== 'string' || !HOST_ID.test(hostId) || hostId === '.' || hostId === '..') {
    throw auditError('invalid_host', 'Invalid host id.');
  }
  return hostId;
}

function numberOrNull(value) {
  return Number.isFinite(value) ? Math.trunc(value) : null;
}

function nonNegative(value) {
  return Number.isFinite(value) && value > 0 ? Math.trunc(value) : 0;
}

/** Redact private keys, bearer tokens, common secret assignments and tailcat addresses. */
export function redactAuditText(value) {
  let text = typeof value === 'string' ? value : String(value ?? '');
  text = text.replace(/-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?-----END [^-]*PRIVATE KEY-----/g, '[redacted-private-key]');
  text = text.replace(/\b(Bearer)\s+[A-Za-z0-9._~+/=-]{4,}/gi, '$1 [redacted]');
  text = text.replace(
    /\b([A-Za-z0-9_]*(?:TOKEN|SECRET|PASSWORD|PASSWD|PASS|API[_-]?KEY|PAIRING[_-]?CODE|AUTH)[A-Za-z0-9_]*)\s*=\s*(?:'[^']*'|"[^"]*"|[^\s'";]+)/gi,
    '$1=[redacted]',
  );
  text = text.replace(
    /(--?[A-Za-z0-9-]*(?:token|secret|password|passwd|pass|api[_-]?key|pairing[_-]?code|authorization))(=|\s+)(?:'[^']*'|"[^"]*"|[^\s'";]+)/gi,
    '$1$2[redacted]',
  );
  text = text.replace(
    /("(?:[A-Za-z0-9_]*)(?:token|secret|password|passwd|api[_-]?key|pairing[_-]?code)(?:[A-Za-z0-9_]*)"\s*:\s*)"[^"]*"/gi,
    '$1"[redacted]"',
  );
  text = text.replace(/\btc[a-z0-9]{8,}\b/gi, '[redacted-tailcat]');
  return text;
}

function redactArgv(argv) {
  return argv.slice(0, MAX_ARGV).map(value => redactAuditText(String(value)).slice(0, MAX_ARG_LENGTH));
}

function canonical(record) {
  return {
    version: 1,
    time: record.time,
    agent: record.agent,
    host: record.host,
    argv: record.argv,
    approvalId: record.approvalId,
    exitCode: record.exitCode,
    durationMs: record.durationMs,
    outputBytes: record.outputBytes,
    outputTail: record.outputTail,
    status: record.status,
    prev_sha256: record.prev_sha256,
  };
}

function hashOf(record) {
  return createHash('sha256').update(JSON.stringify(canonical(record))).digest('hex');
}

function fsyncDir(dir) {
  let fd;
  try {
    fd = fs.openSync(dir, fs.constants.O_RDONLY);
    fs.fsyncSync(fd);
  } catch {
    // Directory fsync is best effort on platforms that refuse it.
  } finally {
    if (fd !== undefined) try { fs.closeSync(fd); } catch {}
  }
}

export function createHostAudit({ runtimeDir, now = () => Date.now(), fileName = 'hosts' } = {}) {
  if (typeof runtimeDir !== 'string' || !runtimeDir) throw auditError('invalid_runtime', 'runtimeDir is required.');
  const root = path.join(runtimeDir, 'audit');
  const dir = path.join(root, fileName);

  function ensureDir(target) {
    fs.mkdirSync(target, { recursive: true, mode: 0o700 });
    const stat = fs.lstatSync(target);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw auditError('audit_unavailable', 'Audit directory is not a directory.');
    try { fs.chmodSync(target, 0o700); } catch {}
  }
  ensureDir(root);
  ensureDir(dir);

  function fileFor(hostId) {
    return path.join(dir, `${assertHostId(hostId)}.jsonl`);
  }

  function readLines(file) {
    let stat;
    try { stat = fs.lstatSync(file); }
    catch (error) {
      if (error.code === 'ENOENT') return [];
      throw error;
    }
    if (!stat.isFile() || stat.isSymbolicLink()) throw auditError('audit_corrupt', 'Audit log is not a regular file.');
    let fd;
    try {
      fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
      return fs.readFileSync(fd, 'utf8').split('\n').filter(Boolean);
    } finally {
      if (fd !== undefined) try { fs.closeSync(fd); } catch {}
    }
  }

  function loadHead(hostId) {
    const file = fileFor(hostId);
    let head = AUDIT_GENESIS;
    try {
      const stat = fs.lstatSync(file);
      if (!stat.isFile() || stat.isSymbolicLink()) throw auditError('audit_corrupt', 'Audit log is not a regular file.');
      if (stat.size > 0) {
        const raw = fs.readFileSync(file, 'utf8');
        if (!raw.endsWith('\n')) throw auditError('audit_corrupt', 'Audit log does not end with a newline.');
        const lines = raw.split('\n').filter(Boolean);
        const last = JSON.parse(lines.at(-1));
        if (!last || typeof last.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(last.sha256)) {
          throw auditError('audit_corrupt', 'Audit log tail has no valid hash.');
        }
        head = last.sha256;
      }
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    return head;
  }

  function append(input = {}, maybeRecord) {
    let payload = input && typeof input === 'object' ? input : {};
    let hostOverride;
    if (typeof input === 'string') {
      hostOverride = input;
      payload = maybeRecord && typeof maybeRecord === 'object' ? maybeRecord : {};
    }
    const hostId = assertHostId(payload.host ?? payload.hostId ?? hostOverride);
    if (!Array.isArray(payload.argv)) throw auditError('invalid_record', 'argv must be an array.');
    const prevSha256 = loadHead(hostId);
    const record = {
      version: 1,
      time: typeof payload.time === 'string' ? payload.time : new Date(now()).toISOString(),
      agent: String(payload.agent ?? 'unknown').slice(0, 120),
      host: hostId,
      argv: redactArgv(payload.argv),
      approvalId: typeof payload.approvalId === 'string' && payload.approvalId ? payload.approvalId.slice(0, 200) : null,
      exitCode: numberOrNull(payload.exitCode),
      durationMs: nonNegative(payload.durationMs),
      outputBytes: nonNegative(payload.outputBytes),
      outputTail: redactAuditText(String(payload.outputTail ?? '')).slice(-MAX_TAIL),
      status: typeof payload.status === 'string' ? payload.status.slice(0, 32) : 'ok',
      prev_sha256: prevSha256,
    };
    record.sha256 = hashOf(record);

    const file = fileFor(hostId);
    let fd;
    try {
      fd = fs.openSync(file, fs.constants.O_WRONLY | fs.constants.O_APPEND | fs.constants.O_CREAT | fs.constants.O_NOFOLLOW, 0o600);
      fs.fchmodSync(fd, 0o600);
      fs.writeSync(fd, `${JSON.stringify(record)}\n`, null, 'utf8');
      fs.fsyncSync(fd);
    } finally {
      if (fd !== undefined) try { fs.closeSync(fd); } catch {}
    }
    fsyncDir(dir);
    return { ...record, prevSha256: record.prev_sha256 };
  }

  function read(hostId) {
    const id = assertHostId(hostId);
    const file = fileFor(id);
    let lines;
    try { lines = readLines(file); }
    catch (error) {
      if (error.code === 'audit_corrupt' || error.code === 'ELOOP') {
        return { host: id, entries: [], valid: false, ok: false, brokenAt: 0, head: null, error: 'Audit log is not a regular file.' };
      }
      throw error;
    }
    const entries = [];
    let prev = AUDIT_GENESIS;
    for (let index = 0; index < lines.length; index += 1) {
      let entry;
      try { entry = JSON.parse(lines[index]); }
      catch {
        return { host: id, entries, valid: false, ok: false, brokenAt: index, head: entries.at(-1)?.sha256 ?? null, error: `Entry ${index} is not valid JSON.` };
      }
      if (!entry || typeof entry !== 'object' || entry.host !== id) {
        return { host: id, entries, valid: false, ok: false, brokenAt: index, head: entries.at(-1)?.sha256 ?? null, error: `Entry ${index} has the wrong host.` };
      }
      const expected = hashOf(entry);
      if (entry.prev_sha256 !== prev) {
        entries.push(entry);
        return { host: id, entries, valid: false, ok: false, brokenAt: index, head: entries.at(-2)?.sha256 ?? null, error: `Entry ${index} does not link to the previous hash.` };
      }
      if (entry.sha256 !== expected) {
        entries.push(entry);
        return { host: id, entries, valid: false, ok: false, brokenAt: index, head: entries.at(-2)?.sha256 ?? null, error: `Entry ${index} was modified after it was written.` };
      }
      entries.push(entry);
      prev = entry.sha256;
    }
    const result = { host: id, entries, valid: true, ok: true, brokenAt: null, head: entries.at(-1)?.sha256 ?? null, error: null };
    for (const entry of entries) entry.prevSha256 = entry.prev_sha256;
    return result;
  }

  return { dir, fileFor, pathFor: fileFor, append, write: append, read, list: read };
}
