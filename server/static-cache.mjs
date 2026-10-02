// Immutable caching policy for the built client, and nothing else.
//
// Only files emitted by the Vite build into the served `<root>/assets/` directory
// are eligible, and only when their names carry Vite's content hash. The build
// contract is Vite's default `assetFileNames` (`assets/[name]-[hash][extname]`,
// where `[hash]` is derived from file content). An index.html check avoids enabling
// this policy for an absent build; it does not independently verify hashes.
// The trusted build-owned asset set is enumerated once from
// that built output; a rebuild that changes hashed names is picked up on the next
// server start.
//
// Everything else stays `no-store`, including `index.html`/`/`, API/auth routes,
// recovery assets, unhashed public resources (`/icons/...`, `/wallpapers/...`),
// and the sandboxed app handler under `/apps/` (a separate handler with its own
// `no-store`). A hash-shaped filename is never enough on its own: the path must
// resolve to an entry enumerated from the build's own `assets/` directory.
//
// Residual limitation: a file manually dropped into `dist/assets/` matching the
// hash shape would be treated as an emitted artifact. `dist` is build-owned and
// the workspace never writes there; deployments restart the server after a build.

import { readdir, stat } from 'node:fs/promises';
import path from 'node:path';

export const IMMUTABLE_CACHE_CONTROL = 'public, max-age=31536000, immutable';
export const ASSETS_PREFIX = '/assets/';
const HASHED_ASSET_NAME = /^[^/]+-[A-Za-z0-9_-]{8,}\.[A-Za-z0-9]+$/;

/** True only when `name` matches Vite's content-hashed asset naming policy. */
export function isContentHashedAssetName(name) {
  return typeof name === 'string' && HASHED_ASSET_NAME.test(name);
}

/**
 * Cache-Control for a decoded static pathname. Immutable only for a pathname that
 * was enumerated from the build's own `assets/` output; `no-store` otherwise.
 */
export function assetCacheControl(pathname, manifest) {
  return manifest instanceof Set && manifest.has(pathname) ? IMMUTABLE_CACHE_CONTROL : 'no-store';
}

/**
 * Enumerate the immutable manifest from a built client root. Returns an empty set
 * (immutable caching disabled) when the root is not a production build or the
 * assets directory is unavailable; it never throws into request handling.
 */
export async function loadImmutableAssetManifest(root) {
  const manifest = new Set();
  try {
    const index = await stat(path.join(root, 'index.html'));
    if (!index.isFile()) return manifest;
    const entries = await readdir(path.join(root, 'assets'), { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isFile() || !isContentHashedAssetName(entry.name)) continue;
      manifest.add(ASSETS_PREFIX + entry.name);
    }
  } catch { return manifest; }
  return manifest;
}
