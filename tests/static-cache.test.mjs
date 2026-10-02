import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { mkdir, mkdtemp, rm, cp, symlink, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import {
  ASSETS_PREFIX,
  IMMUTABLE_CACHE_CONTROL,
  assetCacheControl,
  isContentHashedAssetName,
  loadImmutableAssetManifest,
} from '../server/static-cache.mjs';

const REPO = path.resolve(fileURLToPath(new URL('..', import.meta.url)));

test('only Vite-shaped content-hashed asset names qualify', () => {
  for (const name of ['index-xiRixi7L.js', 'index-DpbFgL55.css', 'main.esm-BGKzgTMx.js', 'project-workbench-DkO2Xcd-.js', 'chunk-1a2B3c4D5e6F.woff2'])
    assert.equal(isContentHashedAssetName(name), true, name);
  for (const name of ['index.js', 'app-1234567.js', 'unhashed.css', 'icon-abcdefgh', 'sub/dir-file-abcdefgh.js', ''])
    assert.equal(isContentHashedAssetName(name), false, name);
});

test('manifest enumerates only hashed files from the build assets directory', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'orbit-static-cache-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, 'assets'), { recursive: true });
  await mkdir(path.join(root, 'icons'), { recursive: true });
  await writeFile(path.join(root, 'index.html'), '<script type="module" src="/assets/index-abc12345.js"></script>');
  await writeFile(path.join(root, 'assets', 'index-abc12345.js'), 'export {}');
  await writeFile(path.join(root, 'assets', 'index-DpbFgL55.css'), 'body{}');
  await writeFile(path.join(root, 'assets', 'app.js'), 'export {}');
  await writeFile(path.join(root, 'icons', 'glyph-abcdefgh.svg'), '<svg/>');
  const manifest = await loadImmutableAssetManifest(root);
  assert.deepEqual([...manifest].sort(), [
    ASSETS_PREFIX + 'index-DpbFgL55.css',
    ASSETS_PREFIX + 'index-abc12345.js',
  ]);
});

test('a root without index.html disables immutable caching', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'orbit-static-cache-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, 'assets'), { recursive: true });
  await writeFile(path.join(root, 'assets', 'index-abc12345.js'), 'export {}');
  assert.equal((await loadImmutableAssetManifest(root)).size, 0);
});

test('cache-control is immutable only for enumerated build assets', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'orbit-static-cache-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, 'assets'), { recursive: true });
  await writeFile(path.join(root, 'index.html'), '<html></html>');
  await writeFile(path.join(root, 'assets', 'index-abc12345.js'), 'export {}');
  const manifest = await loadImmutableAssetManifest(root);
  assert.equal(assetCacheControl('/assets/index-abc12345.js', manifest), IMMUTABLE_CACHE_CONTROL);
  for (const pathname of [
    '/', '/index.html', '/assets/app.js', '/assets/nested/index-abc12345.js',
    '/icons/glyph-abcdefgh.svg', '/apps/some-app-abcdefgh/index.html',
    '/api/workspace', '/api/health', '/recovery', '/wallpapers/classic.svg',
  ]) assert.equal(assetCacheControl(pathname, manifest), 'no-store', pathname);
});

// Transport: run the real server against a handcrafted build so the actual HTTP
// header composition is verified without paying for a Vite build.
let base;
let child;
let isolatedRoot;

before(async () => {
  isolatedRoot = await mkdtemp(path.join(os.tmpdir(), 'orbit-static-cache-server-'));
  const home = path.join(isolatedRoot, 'home');
  const cwd = path.join(isolatedRoot, 'cwd');
  const runtime = path.join(isolatedRoot, 'runtime');
  await Promise.all([home, cwd, runtime].map((dir) => mkdir(dir)));
  const app = path.join(isolatedRoot, 'app');
  await mkdir(app);
  for (const name of ['server', 'src', 'contracts', 'scripts', 'public', 'docs'])
    await cp(path.join(REPO, name), path.join(app, name), { recursive: true });
  for (const name of ['index.html', 'package.json', 'package-lock.json', 'tsconfig.json', 'vite.config.js'])
    await cp(path.join(REPO, name), path.join(app, name));
  await symlink(path.join(REPO, 'node_modules'), path.join(app, 'node_modules'), 'dir');
  await mkdir(path.join(app, 'dist', 'assets'), { recursive: true });
  await mkdir(path.join(app, 'dist', 'icons'), { recursive: true });
  await writeFile(path.join(app, 'dist', 'index.html'), '<!doctype html><script type="module" src="/assets/index-abc12345.js"></script>');
  await writeFile(path.join(app, 'dist', 'assets', 'index-abc12345.js'), 'export {}');
  await writeFile(path.join(app, 'dist', 'assets', 'theme-deadbeef.js'), 'export {}');
  await writeFile(path.join(app, 'dist', 'assets', 'app.js'), 'export {}');
  await writeFile(path.join(app, 'dist', 'icons', 'glyph-abcdefgh.svg'), '<svg/>');
  const { createServer } = await import('node:net');
  const port = await new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const assigned = probe.address().port;
      probe.close((error) => error ? reject(error) : resolve(assigned));
    });
  });
  base = `http://127.0.0.1:${port}`;
  child = spawn(process.execPath, ['--experimental-strip-types', 'server/index.mjs'], {
    cwd: app,
    env: { PATH: process.env.PATH, HOME: home, TMPDIR: os.tmpdir(), PORT: String(port),
      ORBIT_TOKEN: `orbit-static-cache-${process.pid}-${Date.now()}`, ORBIT_RUNTIME_DIR: runtime, ORBIT_CWD: cwd },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let errors = '';
  child.stderr.on('data', (d) => (errors += d));
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(base + '/api/health')).ok) return; } catch {}
    if (child.exitCode !== null) throw Error(errors);
    await delay(50);
  }
  throw Error('Server startup timeout');
});

after(async () => {
  if (child && child.exitCode === null) {
    const exited = new Promise((resolve) => child.once('exit', resolve));
    child.kill('SIGTERM');
    await Promise.race([exited, delay(3000)]);
    if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await exited; }
  }
  await rm(isolatedRoot, { recursive: true, force: true });
});

test('built content-hashed assets are immutable with unchanged security headers', async () => {
  const r = await fetch(base + '/assets/index-abc12345.js');
  assert.equal(r.status, 200);
  assert.equal(await r.text(), 'export {}');
  assert.equal(r.headers.get('cache-control'), IMMUTABLE_CACHE_CONTROL);
  assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(r.headers.get('x-frame-options'), 'DENY');
  assert.equal(r.headers.get('referrer-policy'), 'no-referrer');
  assert.match(r.headers.get('content-security-policy'), /frame-ancestors 'none'/);
  const css = await fetch(base + '/assets/theme-deadbeef.js');
  assert.equal(css.headers.get('cache-control'), IMMUTABLE_CACHE_CONTROL);
});

test('index, API and unhashed/out-of-directory resources stay no-store', async () => {
  for (const pathname of ['/', '/index.html', '/assets/app.js', '/icons/glyph-abcdefgh.svg', '/api/health', '/recovery']) {
    const r = await fetch(base + pathname);
    assert.equal(r.headers.get('cache-control'), 'no-store', pathname);
  }
});
