// Deployment configuration is readable, hermetic verification: the compose
// stack publishes only loopback, the image builds its own UI in a builder stage
// and runs unprivileged, and the local launcher can describe its plan without
// starting a process or exposing a credential.
import test from 'node:test';
import assert from 'node:assert/strict';
import {chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const REPO = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const read = name => readFileSync(path.join(REPO, name), 'utf8');
const tempRoot = () => mkdtempSync(path.join(os.tmpdir(), 'orbit-deploy-'));

// Only the tiny YAML subset this compose file uses: mapping keys, block
// sequences and scalar values. Anything ambiguous is rejected rather than
// guessed, so a malformed compose file cannot silently satisfy a test.
function parseYamlSubset(source) {
  const lines = source.split(/\r?\n/)
    .map(line => line.replace(/^#\s?/, ''))
    .filter(line => line.trim() !== '' && !line.trim().startsWith('#'));
  const root = {};
  const stack = [{indent: -1, value: root, parent: null, key: null}];
  for (const raw of lines) {
    const indent = raw.length - raw.trimStart().length;
    const text = raw.trim();
    while (stack.length > 1 && indent <= stack[stack.length - 1].indent) stack.pop();
    const frame = stack[stack.length - 1];
    if (text.startsWith('- ')) {
      if (!Array.isArray(frame.value)) {
        if (frame.parent && frame.key && Object.keys(frame.value).length === 0) {
          const sequence = [];
          frame.parent[frame.key] = sequence;
          frame.value = sequence;
        } else {
          throw Error(`sequence item outside a sequence: ${text}`);
        }
      }
      frame.value.push(scalar(text.slice(2)));
      continue;
    }
    const match = /^([A-Za-z0-9_.-]+):(?:\s+(.*))?$/.exec(text);
    if (!match) throw Error(`unsupported YAML line: ${text}`);
    const [, key, rawValue] = match;
    const value = rawValue === undefined ? {} : scalar(rawValue);
    frame.value[key] = value;
    if (rawValue === undefined) stack.push({indent, value, parent: frame.value, key});
  }
  return root;
}
function scalar(value) {
  const text = String(value).trim();
  if (text === '' || text === '{}') return {};
  if (text.startsWith('[') && text.endsWith(']'))
    return text.slice(1, -1).split(',').map(item => scalar(item)).filter(item => item !== '');
  if ((text.startsWith('"') && text.endsWith('"')) || (text.startsWith("'") && text.endsWith("'")))
    return text.slice(1, -1);
  return text;
}
function compose() {
  return parseYamlSubset(read('docker-compose.yml'));
}

test('Dockerfile builds the UI in a builder stage and runs unprivileged', () => {
  const dockerfile = read('Dockerfile');
  assert.match(dockerfile, /^FROM\s+node:22[^\s]*\s+AS\s+build/mi, 'Node 22 builder stage');
  assert.match(dockerfile, /npm ci/m, 'builder installs locked dependencies');
  assert.match(dockerfile, /npm run build/m, 'builder runs the project build');
  const stages = dockerfile.split(/^FROM\s+/m).slice(1);
  assert.ok(stages.length >= 2, 'multi-stage build');
  assert.match(dockerfile, /COPY\s+--from=build\b[^\n]*\/app\/dist|COPY\s+--from=build\b[^\n]*\.\/dist/i,
    'runtime copies the builder dist, not a host dist');
  assert.doesNotMatch(dockerfile, /^COPY\s+(?:--[^\s]+\s+)*dist\b/mi, 'no prebuilt host dist is copied');
  assert.match(dockerfile, /^USER\s+node\s*$/mi, 'runtime uses the non-root node user');
  assert.doesNotMatch(dockerfile, /^USER\s+root\s*$/mi, 'never runs as root');
  assert.match(dockerfile, /^EXPOSE\s+4318\s*$/mi, 'documents the server port');
  assert.doesNotMatch(dockerfile, /\bORBIT_TOKEN\s*=\s*\S+|sk-[A-Za-z0-9]{8,}|ghp_[A-Za-z0-9]{8,}/,
    'no token or vendor secret is baked into the image');
});

test('.dockerignore excludes local state, secrets and build output', () => {
  const ignored = new Set(read('.dockerignore').split(/\r?\n/).map(line => line.trim()).filter(line => line && !line.startsWith('#')));
  for (const pattern of ['node_modules', 'dist*', '*.bak-*', '.runtime', '.env*', 'games/'])
    assert.ok(ignored.has(pattern), `.dockerignore must contain ${pattern}`);
});

test('docker compose publishes only loopback with an unprivileged volume-backed service', () => {
  const config = compose();
  const orbit = config.services?.orbit;
  assert.ok(orbit, 'services.orbit exists');
  assert.equal(orbit.build?.context ?? orbit.build, '.', 'builds from the checkout context');
  assert.equal(orbit.user, 'node', 'runs as the non-root node user');
  const ports = Array.isArray(orbit.ports) ? orbit.ports.map(String) : [String(orbit.ports)];
  assert.ok(ports.includes('127.0.0.1:4318:4318'), 'publishes 127.0.0.1:4318:4318');
  assert.ok(ports.every(port => port.startsWith('127.0.0.1:')), 'every published port is loopback-only');
  assert.ok(ports.every(port => !port.startsWith('0.0.0.0') && !/^4318:4318$/.test(port)), 'never publishes on all interfaces');
  assert.equal(orbit.network_mode, undefined, 'no host networking');
  assert.notEqual(orbit.privileged, 'true', 'not privileged');
  const volumes = Array.isArray(orbit.volumes) ? orbit.volumes.map(String) : [String(orbit.volumes)];
  assert.ok(volumes.some(volume => /^orbit-runtime:\/home\/node\/\.orbit-runtime:?/.test(volume)), 'persists runtime in a named volume');
  assert.ok(config.volumes?.['orbit-runtime'], 'declares the named volume');
  const env = orbit.environment;
  const envText = Array.isArray(env) ? env.join('\n') : JSON.stringify(env ?? {});
  assert.doesNotMatch(envText, /ORBIT_TOKEN/i, 'the token is never fixed in the compose environment');
  assert.doesNotMatch(envText, /sk-[A-Za-z0-9]{8,}|ghp_[A-Za-z0-9]{8,}/, 'no vendor secret in the service environment');
});

test('compose documents the private first-login command and no maintainer infrastructure', () => {
  const source = read('docker-compose.yml');
  assert.match(source, /docker compose exec orbit node scripts\/orbit-up\.mjs --print-login-url/,
    'documents the one-time login URL command');
  assert.doesNotMatch(source, /\b100\.\d{1,3}\.\d{1,3}\.\d{1,3}\b|network_mode:\s*host|privileged:\s*true/i,
    'no maintainer infrastructure or host networking');
  assert.doesNotMatch(source, /\/home\/(?!node)[A-Za-z0-9_-]+|\/Users\/|mojo/i, 'no personal or private host paths');
});

test('orbit-up --dry-run prints the plan without starting anything or printing a token', () => {
  const root = tempRoot();
  const runtime = path.join(root, 'runtime');
  const token = `local-dry-run-secret-${'x'.repeat(40)}`;
  try {
    const result = spawnSync(process.execPath, [
      path.join(REPO, 'scripts/orbit-up.mjs'),
      '--dry-run',
      '--port', '4320',
      '--runtime-dir', runtime,
      '--print-login-url',
    ], {
      cwd: REPO,
      encoding: 'utf8',
      timeout: 20000,
      env: {...process.env, HOME: path.join(root, 'home'), ORBIT_TOKEN: token},
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.match(result.stdout, /127\.0\.0\.1:4320/, 'prints the loopback URL');
    assert.match(result.stdout, /dry run/i, 'labels the plan as dry run');
    assert.match(result.stdout, /runtime/i, 'names the runtime directory');
    assert.ok(!result.stdout.includes(token) && !result.stderr.includes(token), 'never prints the token');
    assert.equal(existsSync(runtime), false, 'does not create the runtime directory');
  } finally {
    rmSync(root, {recursive: true, force: true});
  }
});

test('orbit-up --dry-run rejects an invalid port and remains token-free', () => {
  const root = tempRoot();
  const token = `local-dry-run-secret-${'y'.repeat(40)}`;
  try {
    for (const port of ['0', '80', '70000', 'not-a-port']) {
      const result = spawnSync(process.execPath, [
        path.join(REPO, 'scripts/orbit-up.mjs'), '--dry-run', '--port', port, '--runtime-dir', path.join(root, 'runtime'),
      ], {
        cwd: REPO,
        encoding: 'utf8',
        timeout: 20000,
        env: {...process.env, HOME: path.join(root, 'home'), ORBIT_TOKEN: token},
      });
      assert.notEqual(result.status, 0, `port ${port} is refused`);
      assert.ok(!result.stdout.includes(token) && !result.stderr.includes(token), 'never prints the token');
    }
  } finally {
    rmSync(root, {recursive: true, force: true});
  }
});

test('orbit-up --print-login-url reads only the private runtime token file', () => {
  const root = tempRoot();
  const runtime = path.join(root, 'runtime');
  const token = `local-login-secret-${'z'.repeat(40)}`;
  const env = {...process.env, HOME: path.join(root, 'home')};
  delete env.ORBIT_TOKEN;
  try {
    mkdirSync(runtime, {recursive: true, mode: 0o700});
    const file = path.join(runtime, 'session-token');
    writeFileSync(file, `${token}\n`, {mode: 0o600});
    const read = spawnSync(process.execPath, [
      path.join(REPO, 'scripts/orbit-up.mjs'), '--print-login-url', '--port', '4321', '--runtime-dir', runtime,
    ], {cwd: REPO, encoding: 'utf8', timeout: 20000, env});
    assert.equal(read.status, 0, read.stderr || read.stdout);
    assert.match(read.stdout, /127\.0\.0\.1:4321/, 'prints the loopback login URL');
    assert.ok(read.stdout.includes(token), 'prints the explicitly requested one-time token');
    chmodSync(file, 0o644);
    const refused = spawnSync(process.execPath, [
      path.join(REPO, 'scripts/orbit-up.mjs'), '--print-login-url', '--port', '4321', '--runtime-dir', runtime,
    ], {cwd: REPO, encoding: 'utf8', timeout: 20000, env});
    assert.notEqual(refused.status, 0, 'refuses a token file readable by other users');
    assert.ok(!refused.stdout.includes(token) && !refused.stderr.includes(token), 'never prints a token it refuses to use');
  } finally {
    rmSync(root, {recursive: true, force: true});
  }
});
