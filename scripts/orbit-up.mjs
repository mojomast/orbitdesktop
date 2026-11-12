#!/usr/bin/env node
// Start Orbit on this computer with one command. This launcher only uses local
// files: no package changes, no network discovery, no overlay-network helpers. The
// server owns the generated owner token and keeps it 0600 in the runtime dir.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MIN_NODE_MAJOR = 22;
const PROGRESS_INTERVAL_MS = 10 * 60 * 1000;

class LauncherError extends Error {}

function usage() {
  return [
    'Usage: npm run up -- [options]',
    '',
    'Options:',
    '  --port <number>       Loopback port (default 4318, or PORT)',
    '  --runtime-dir <path>  Private runtime directory (default .runtime in this checkout)',
    '  --print-login-url     Read the owner token from the private runtime and print login details',
    '  --dry-run             Print the plan without installing, building, starting or reading a token',
    '  --help                Show this message',
  ].join('\n');
}

function takeValue(argv, index, flag) {
  if (index >= argv.length || argv[index] === undefined) throw new LauncherError(`${flag} requires a value.`);
  return argv[index];
}

function parseArgs(argv) {
  const options = {
    port: Number(process.env.PORT || 4318),
    runtimeDir: process.env.ORBIT_RUNTIME_DIR || path.join(REPO_ROOT, '.runtime'),
    printLoginUrl: false,
    dryRun: false,
    help: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--port') options.port = Number(takeValue(argv, ++i, arg));
    else if (arg === '--runtime-dir') options.runtimeDir = takeValue(argv, ++i, arg);
    else if (arg === '--print-login-url') options.printLoginUrl = true;
    else if (arg === '--dry-run') options.dryRun = true;
    else if (arg === '--help' || arg === '-h') options.help = true;
    else throw new LauncherError(`Unknown argument: ${arg}`);
  }
  if (!Number.isInteger(options.port) || options.port < 1024 || options.port > 65535)
    throw new LauncherError('Port must be an integer from 1024 to 65535.');
  if (typeof options.runtimeDir !== 'string' || options.runtimeDir.trim() === '')
    throw new LauncherError('Runtime directory must be a nonempty path.');
  options.runtimeDir = path.resolve(options.runtimeDir);
  return options;
}

function nodeMajor() {
  return Number(String(process.versions.node).split('.')[0]);
}

function ensureNode() {
  if (!Number.isInteger(nodeMajor()) || nodeMajor() < MIN_NODE_MAJOR)
    throw new LauncherError(`Orbit requires Node ${MIN_NODE_MAJOR} or newer; this is ${process.versions.node}.`);
}

function exists(target) {
  try {
    fs.lstatSync(target);
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

function plan(options) {
  return {
    url: `http://127.0.0.1:${options.port}`,
    runtimeDir: options.runtimeDir,
    dependencies: exists(path.join(REPO_ROOT, 'node_modules')) ? 'present' : 'install with npm ci',
    build: exists(path.join(REPO_ROOT, 'dist', 'index.html')) ? 'present' : 'build from source',
  };
}

function printPlan(options) {
  const steps = plan(options);
  console.log('Orbit local launcher (dry run)');
  console.log(`  Node:              v${process.versions.node}`);
  console.log(`  URL:               ${steps.url}`);
  console.log(`  Runtime directory: ${steps.runtimeDir}`);
  console.log(`  Dependencies:      ${steps.dependencies}`);
  console.log(`  UI build:          ${steps.build}`);
  console.log('  Server:            node --experimental-strip-types server/index.mjs');
  console.log('  Login token:       only read after startup, never printed by this dry run');
  console.log('No process was started, no directory was created, and no token was read or printed.');
}

function runCommand(command, args, {cwd, env, timeoutMs, label, capture = false}) {
  return new Promise((resolve, reject) => {
    console.log(`Orbit: ${label}`);
    const child = spawn(command, args, {
      cwd,
      env,
      stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
    });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const started = Date.now();
    if (capture) {
      child.stdout?.on('data', chunk => { stdout += chunk; });
      child.stderr?.on('data', chunk => { stderr += chunk; });
    }
    const progress = setInterval(() => {
      const minutes = Math.max(1, Math.round((Date.now() - started) / 60000));
      console.error(`Orbit: ${label} still running after ${minutes} minute${minutes === 1 ? '' : 's'}...`);
    }, PROGRESS_INTERVAL_MS);
    progress.unref?.();
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      setTimeout(() => { try { child.kill('SIGKILL'); } catch {} }, 5000).unref?.();
    }, timeoutMs);
    timer.unref?.();
    child.once('error', error => {
      clearInterval(progress);
      clearTimeout(timer);
      reject(new LauncherError(`${label} could not start: ${error.message}`));
    });
    child.once('exit', (code, signal) => {
      clearInterval(progress);
      clearTimeout(timer);
      resolve({code, signal, stdout, stderr, timedOut});
    });
  });
}

async function ensureDependencies() {
  if (exists(path.join(REPO_ROOT, 'node_modules'))) return;
  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  const result = await runCommand(npm, ['ci'], {
    cwd: REPO_ROOT,
    env: {...process.env, npm_config_update_notifier: 'false'},
    timeoutMs: 30 * 60 * 1000,
    label: 'installing locked dependencies (npm ci)',
  });
  if (result.code !== 0)
    throw new LauncherError(result.timedOut ? 'npm ci timed out.' : 'npm ci failed; see the output above.');
}

function parseBuildResult(stdout) {
  const lines = String(stdout).trim().split(/\r?\n/).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const value = JSON.parse(lines[i]);
      if (value && typeof value === 'object') return value;
    } catch {}
  }
  return null;
}

async function ensureBuild() {
  const destination = path.join(REPO_ROOT, 'dist');
  if (exists(path.join(destination, 'index.html'))) return;
  const scratchRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-up-build-'));
  try {
    const result = await runCommand(process.execPath, [path.join(REPO_ROOT, 'scripts', 'isolated_build.mjs'), '--json'], {
      cwd: REPO_ROOT,
      env: {...process.env, ORBIT_BUILD_SCRATCH: scratchRoot},
      timeoutMs: 30 * 60 * 1000,
      label: 'building the UI from source',
      capture: true,
    });
    const built = parseBuildResult(result.stdout);
    if (result.code !== 0 || !built?.ok || typeof built.destination !== 'string')
      throw new LauncherError(`UI build failed${built?.message ? `: ${built.message}` : '; see the build output.'}`);
    fs.rmSync(destination, {recursive: true, force: true});
    fs.cpSync(built.destination, destination, {recursive: true});
    if (!exists(path.join(destination, 'index.html'))) throw new LauncherError('UI build produced no index.html.');
  } finally {
    fs.rmSync(scratchRoot, {recursive: true, force: true});
  }
}

function loadLoginToken(runtimeDir) {
  if (process.env.ORBIT_TOKEN) {
    const token = process.env.ORBIT_TOKEN;
    if (token.length < 32) throw new LauncherError('ORBIT_TOKEN must have at least 32 characters.');
    return {token, source: 'ORBIT_TOKEN environment'};
  }
  const file = path.join(runtimeDir, 'session-token');
  let status;
  try {
    status = fs.lstatSync(file);
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
  if (!status.isFile()) throw new LauncherError('The private runtime token path is not a regular file.');
  if (process.platform !== 'win32' && (status.mode & 0o077) !== 0)
    throw new LauncherError('The private runtime token file permissions are too broad; refusing to read it.');
  const token = fs.readFileSync(file, 'utf8').trim();
  if (token.length < 32) throw new LauncherError('The private runtime token file is invalid.');
  return {token, source: 'private runtime session-token file'};
}

function printLogin(options) {
  let found;
  try {
    found = loadLoginToken(options.runtimeDir);
  } catch (error) {
    if (error instanceof LauncherError) throw error;
    throw new LauncherError('The private runtime token could not be read.');
  }
  if (!found)
    throw new LauncherError('No generated token is available yet. Start Orbit first, then run this command again.');
  console.log(`Orbit login: http://127.0.0.1:${options.port}`);
  console.log(`Token source: ${found.source}`);
  console.log(`One-time token: ${found.token}`);
  console.log('Paste the token into "Connect host" in the Orbit window. It is not stored by this command.');
}

function startServer(options) {
  fs.mkdirSync(options.runtimeDir, {recursive: true, mode: 0o700});
  const env = {
    ...process.env,
    PORT: String(options.port),
    ORBIT_HOST: '127.0.0.1',
    ORBIT_RUNTIME_DIR: options.runtimeDir,
  };
  console.log(`Orbit: starting on http://127.0.0.1:${options.port}`);
  console.log(`Orbit: runtime directory ${options.runtimeDir}`);
  console.log('Orbit: use --print-login-url in a second terminal after startup to read the one-time token.');
  const child = spawn(process.execPath, ['--experimental-strip-types', path.join(REPO_ROOT, 'server', 'index.mjs')], {
    cwd: REPO_ROOT,
    env,
    stdio: 'inherit',
  });
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'])
    process.on(signal, () => { try { child.kill(signal); } catch {} });
  child.once('error', error => {
    console.error(`Orbit: server could not start: ${error.message}`);
    process.exitCode = 1;
  });
  child.once('exit', (code, signal) => {
    process.exitCode = typeof code === 'number' ? code : (signal ? 0 : 1);
  });
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(usage());
    return;
  }
  ensureNode();
  if (options.dryRun) {
    printPlan(options);
    return;
  }
  if (options.printLoginUrl) {
    printLogin(options);
    return;
  }
  await ensureDependencies();
  await ensureBuild();
  startServer(options);
}

main().catch(error => {
  console.error(error instanceof LauncherError ? `Orbit: ${error.message}` : 'Orbit: launcher failed.');
  process.exitCode = 1;
});
