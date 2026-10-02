import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

export const DATA_ENGINE_VERSION = 'v1.4.3';
export const DATA_ENGINE_PLATFORM = 'wasm_eh';
export const DATA_ENGINE_FILES = Object.freeze({
  json: Object.freeze({ file: 'json.duckdb_extension.wasm', bytes: 820646, sha256: 'b997276c8e15cc3ebdeda340d73d15dc1c4f4755ad281280451cb0a2f79302e9' }),
  parquet: Object.freeze({ file: 'parquet.duckdb_extension.wasm', bytes: 3045039, sha256: '22765c8f7dc741cda2b571a66ac7bb355295d7d69a6c37e5315b265672984f55' }),
});
export function assertDataEnginePath(file) {
  let current = path.resolve(file);
  while (true) {
    const stat = fs.lstatSync(current);
    if (stat.isSymbolicLink()) throw Error('Refusing symlink in DuckDB asset path');
    if (current === path.dirname(current)) break;
    current = path.dirname(current);
  }
}
export function verifyDataEngineBytes(bytes, expected) {
  return bytes.length === expected.bytes && createHash('sha256').update(bytes).digest('hex') === expected.sha256;
}
export function createDataEngineAssets({ extensionsRoot }) {
  const root = path.resolve(extensionsRoot);
  function read(kind) {
    const expected = DATA_ENGINE_FILES[kind], file = path.join(root, DATA_ENGINE_VERSION, DATA_ENGINE_PLATFORM, expected.file);
    assertDataEnginePath(file);
    const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    try {
      const stat = fs.fstatSync(fd);
      if (!stat.isFile() || stat.nlink !== 1 || stat.size !== expected.bytes) throw Error('Invalid DuckDB extension size or link count');
      // Read no more than the pinned length plus one sentinel byte, even if the
      // file grows after fstat. Descriptor reads also avoid reopening the path.
      const buffer = Buffer.alloc(expected.bytes + 1);
      let length = 0;
      while (length < buffer.length) {
        const count = fs.readSync(fd, buffer, length, buffer.length - length, length);
        if (!count) break;
        length += count;
      }
      const after = fs.fstatSync(fd);
      if (after.nlink !== 1 || after.size !== expected.bytes) throw Error('DuckDB extension changed during read');
      const bytes = buffer.subarray(0, length);
      if (!verifyDataEngineBytes(bytes, expected)) throw Error('Invalid DuckDB extension checksum');
      return bytes;
    } finally { fs.closeSync(fd); }
  }
  function status() {
    const extensions = {};
    for (const kind of Object.keys(DATA_ENGINE_FILES)) {
      try { read(kind); extensions[kind] = 'ready'; }
      catch (error) { extensions[kind] = error.code === 'ENOENT' ? 'missing' : 'invalid'; }
    }
    return { engineVersion: DATA_ENGINE_VERSION, platform: DATA_ENGINE_PLATFORM, csv: 'ready', extensions, provisionCommand: 'node scripts/provision_data_engine.mjs --extensions-root <private-extensions-root>' };
  }
  function handle(req, res, pathname) {
    // The document and worker must also receive this CSP from the parent server.
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; worker-src 'self' blob:; connect-src 'self'");
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cache-Control', 'no-store');
    const finish = (code, text = '') => { res.statusCode = code; res.setHeader('Content-Type', 'text/plain; charset=utf-8'); res.end(req.method === 'HEAD' ? undefined : text); };
    if (req.method !== 'GET' && req.method !== 'HEAD') { res.setHeader('Allow', 'GET, HEAD'); finish(405, 'GET or HEAD required'); return; }
    const prefix = `/vendor/duckdb/${DATA_ENGINE_VERSION}/`;
    if (pathname === prefix + 'status') {
      res.statusCode = 200; res.setHeader('Content-Type', 'application/json');
      res.end(req.method === 'HEAD' ? undefined : JSON.stringify(status())); return;
    }
    const kind = Object.keys(DATA_ENGINE_FILES).find(kind => pathname === `${prefix}${DATA_ENGINE_PLATFORM}/${DATA_ENGINE_FILES[kind].file}` || pathname === `${prefix}${DATA_ENGINE_PLATFORM}/${kind}.wasm`);
    if (!kind) { finish(404, 'Unknown DuckDB asset'); return; }
    let bytes;
    try { bytes = read(kind); }
    catch (error) { finish(error.code === 'ENOENT' ? 404 : 503, 'DuckDB extension unavailable; run the explicit data engine provisioning command.'); return; }
    res.statusCode = 200;
    res.setHeader('Content-Type', 'application/wasm');
    res.setHeader('Content-Length', bytes.length);
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    res.setHeader('ETag', `"sha256-${DATA_ENGINE_FILES[kind].sha256}"`);
    res.end(req.method === 'HEAD' ? undefined : bytes);
  }
  return { handle, status };
}
