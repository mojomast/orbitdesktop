import defaultFs from 'node:fs';
import path from 'node:path';

/**
 * OpenCode binary detection.
 *
 * The wizard asks the server what is actually installed instead of guessing from
 * a browser. `which`, the executable test and `exec` are injectable so tests and
 * other callers never need to read a real HOME or touch the network.
 */

export const OPENCODE_COMMAND = 'opencode';
export const OPENCODE_PACKAGE = 'opencode-ai';
export const OPENCODE_INSTALL_COMMAND = Object.freeze({
  command: 'npm',
  args: Object.freeze(['i', '-g', OPENCODE_PACKAGE]),
  display: `npm i -g ${OPENCODE_PACKAGE}`,
});

export function parseOpencodeVersion(value) {
  const text = typeof value === 'string' ? value.trim() : '';
  if (!text) return null;
  try {
    const parsed = JSON.parse(text);
    if (typeof parsed?.version === 'string') return parsed.version.trim().slice(0, 80) || null;
  } catch { /* --version usually prints a plain version line. */ }
  const match = text.match(/\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?/);
  if (match) return match[0].slice(0, 80);
  return text.split(/\r?\n/, 1)[0].trim().slice(0, 80) || null;
}

function defaultExists(file) {
  try {
    const stat = defaultFs.statSync(file);
    if (!stat.isFile() && !stat.isSymbolicLink()) return false;
    defaultFs.accessSync(file, defaultFs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function callExec(exec, command, args, options) {
  const normalise = value => typeof value === 'string' ? { stdout: value } : (value ?? {});
  if (typeof exec !== 'function') return Promise.resolve({});
  if (exec.length >= 4) {
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (error, value) => {
        if (settled) return;
        settled = true;
        if (error) reject(error);
        else resolve(normalise(value));
      };
      try {
        const returned = exec(command, args, options, (error, stdout, stderr) => {
          if (error) finish(error);
          else finish(null, { stdout: String(stdout ?? ''), stderr: String(stderr ?? '') });
        });
        if (returned && typeof returned.then === 'function') returned.then(value => finish(null, value), error => finish(error));
      } catch (error) {
        finish(error);
      }
    });
  }
  return Promise.resolve()
    .then(() => exec(command, args, options))
    .then(normalise);
}

async function executableHit(file, exists) {
  if (typeof file !== 'string' || !path.isAbsolute(file)) return false;
  try {
    return Boolean(await exists(file));
  } catch {
    return false;
  }
}

function candidateDirectories({ env, home }) {
  const dirs = [];
  const pathValue = typeof env?.PATH === 'string' ? env.PATH : '';
  for (const directory of pathValue.split(path.delimiter)) {
    if (directory && path.isAbsolute(directory) && !dirs.includes(directory)) dirs.push(directory);
  }
  for (const directory of ['/usr/local/bin', '/opt/homebrew/bin']) {
    if (!dirs.includes(directory)) dirs.push(directory);
  }
  if (typeof home === 'string' && path.isAbsolute(home)) {
    for (const suffix of [['.opencode', 'bin'], ['.local', 'bin']]) {
      const directory = path.join(home, ...suffix);
      if (!dirs.includes(directory)) dirs.push(directory);
    }
  }
  return dirs;
}

async function pathFromWhich(which) {
  if (typeof which !== 'function') return null;
  let found;
  try {
    found = await which(OPENCODE_COMMAND);
  } catch {
    return null;
  }
  if (typeof found === 'string') return found.trim() || null;
  if (found && typeof found.path === 'string') return found.path.trim() || null;
  return null;
}

/**
 * Detect `opencode` on PATH, an explicit OPENCODE_BIN, or a common install
 * directory, then ask it for its version. A version failure does not turn a
 * present binary into a missing one.
 */
export async function detectOpencode({
  which,
  exec,
  env = {},
  home,
  exists = defaultExists,
  timeoutMs = 5_000,
} = {}) {
  const explicit = typeof env?.OPENCODE_BIN === 'string' ? env.OPENCODE_BIN.trim() : '';
  const explicitHit = explicit && path.isAbsolute(explicit) && await executableHit(explicit, exists) ? explicit : null;
  // A `which` result is already the named tool's answer; tests and callers may
  // inject it without providing a real filesystem. Explicit/common candidates
  // below still have to be executable.
  const fromWhich = await pathFromWhich(which);
  let binary = explicitHit ?? (fromWhich && path.isAbsolute(fromWhich) ? fromWhich : null);
  if (!binary) {
    for (const directory of candidateDirectories({ env, home })) {
      const candidate = path.join(directory, OPENCODE_COMMAND);
      if (await executableHit(candidate, exists)) { binary = candidate; break; }
    }
  }
  if (!binary) return { installed: false, path: null, version: null };
  let version = null;
  if (typeof exec === 'function') {
    try {
      const result = await callExec(exec, binary, ['--version'], { timeout: timeoutMs, maxBuffer: 8192 });
      version = parseOpencodeVersion(result?.stdout ?? '');
    } catch { /* Installed but its version command failed; report presence honestly. */ }
  }
  return { installed: true, path: binary, version };
}
