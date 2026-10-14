import { spawn as spawnChild } from 'node:child_process';
import { randomUUID } from 'node:crypto';

/** One protocol record may not grow without bound in memory. */
const MAX_RECORD_BYTES = 8 * 1024 * 1024;
const MAX_DIAGNOSTIC_BYTES = 4 * 1024;
const SHUTDOWN_GRACE_MS = 2_000;

function fail(message, code) {
  const error = new Error(message);
  if (code) error.code = code;
  return error;
}

/**
 * Pi in RPC mode: one long-lived child process controlled by JSONL records.
 *
 * Framing is strict. Records are split on LF only, because `readline` would also
 * split on U+2028 and U+2029, which are valid inside JSON strings. Stdout carries
 * protocol records; stderr is diagnostics and is never parsed as protocol data.
 *
 * `request` resolves with a command response's `data` (or null) and rejects when
 * Pi reports `success: false`, when the request times out, or when the child
 * exits with the command still outstanding. Session events go to `onEvent`.
 */
export function createPiRpc({
  binary = 'pi',
  args = [],
  cwd,
  env,
  spawnImpl = spawnChild,
  onEvent = () => {},
  onExit = () => {},
  requestTimeoutMs = 60_000,
  log = () => {},
} = {}) {
  const pending = new Map();
  let child = null;
  let buffer = Buffer.alloc(0);
  let diagnostics = '';
  let counter = 0;
  let stopped = false;
  let exited = false;

  function rememberDiagnostic(chunk) {
    const text = Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk);
    diagnostics = `${diagnostics}${text}`.slice(-MAX_DIAGNOSTIC_BYTES);
  }

  function settleAll(error) {
    for (const [id, entry] of pending) {
      pending.delete(id);
      clearTimeout(entry.timer);
      entry.reject(error);
    }
  }

  function handle(record) {
    if (!record || typeof record !== 'object' || Array.isArray(record)) return;
    if (record.type === 'response') {
      const entry = pending.get(record.id);
      if (!entry) return;
      pending.delete(record.id);
      clearTimeout(entry.timer);
      if (record.success === false) {
        const detail = typeof record.error === 'string' && record.error.trim() ? record.error.trim().slice(0, 400) : 'Pi rejected the command.';
        entry.reject(fail(detail, 'PI_COMMAND_FAILED'));
        return;
      }
      entry.resolve(record.data === undefined ? null : record.data);
      return;
    }
    try {
      onEvent(record);
    } catch (error) {
      log(`Pi event handler failed: ${error instanceof Error ? error.message : 'unknown error'}`);
    }
  }

  function drain() {
    for (;;) {
      const index = buffer.indexOf(0x0a);
      if (index < 0) {
        if (buffer.length > MAX_RECORD_BYTES) {
          stop(fail('Pi sent an oversized protocol record.', 'PI_PROTOCOL_OVERSIZE'));
        }
        return;
      }
      let line = buffer.subarray(0, index);
      buffer = buffer.subarray(index + 1);
      if (line.length && line[line.length - 1] === 0x0d) line = line.subarray(0, line.length - 1);
      if (!line.length) continue;
      let record;
      try {
        record = JSON.parse(line.toString('utf8'));
      } catch {
        log('Pi wrote a protocol record that was not JSON.');
        continue;
      }
      handle(record);
    }
  }

  function attach(process) {
    process.stdout?.on('data', chunk => {
      buffer = Buffer.concat([buffer, Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk))]);
      drain();
    });
    process.stderr?.on('data', rememberDiagnostic);
    process.on('error', error => {
      exited = true;
      settleAll(fail(`Pi could not start: ${error instanceof Error ? error.message : 'unknown error'}`, 'PI_UNAVAILABLE'));
    });
    process.on('exit', (code, signal) => {
      exited = true;
      child = null;
      if (!stopped) settleAll(fail(`Pi stopped before answering (${signal || code || 'no exit code'}).`, 'PI_EXITED'));
      onExit({ code: code ?? null, signal: signal ?? null, diagnostics: diagnostics.trim().slice(0, 1000) });
    });
  }

  function start() {
    if (child) return child;
    if (stopped || exited) throw fail('This Pi session has stopped.', 'PI_STOPPED');
    const process = spawnImpl(binary, args, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    child = process;
    attach(process);
    return process;
  }

  function write(record) {
    const process = start();
    const stdin = process.stdin;
    if (!stdin || stdin.destroyed) throw fail('Pi is not accepting commands.', 'PI_UNAVAILABLE');
    stdin.write(`${JSON.stringify(record)}\n`);
  }

  /** Send one command and resolve with its response data. */
  function request(command, fields = {}) {
    const id = `req-${++counter}-${randomUUID().slice(0, 8)}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(fail('Pi did not answer the command in time.', 'PI_TIMEOUT'));
      }, requestTimeoutMs);
      pending.set(id, { resolve, reject, timer });
      try {
        write({ id, type: command, ...fields });
      } catch (error) {
        pending.delete(id);
        clearTimeout(timer);
        reject(error);
      }
    });
  }

  /** Send a record that has no command response, such as an extension UI answer. */
  function send(record) {
    write(record);
  }

  /** Close stdin for an orderly shutdown, then kill after a grace period. */
  function stop(reason = fail('Pi session stopped.', 'PI_STOPPED')) {
    if (stopped) {
      settleAll(reason);
      return;
    }
    stopped = true;
    settleAll(reason);
    const process = child;
    child = null;
    if (!process) return;
    try {
      process.stdin?.end();
    } catch {}
    const timer = setTimeout(() => {
      try {
        process.kill('SIGKILL');
      } catch {}
    }, SHUTDOWN_GRACE_MS);
    timer.unref?.();
    process.once('exit', () => clearTimeout(timer));
  }

  return {
    request,
    send,
    stop,
    start,
    get diagnostics() {
      return diagnostics;
    },
    get alive() {
      return Boolean(child) && !stopped;
    },
  };
}
