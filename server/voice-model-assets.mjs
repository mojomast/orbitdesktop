// Pinned local dictation model. The Grok Bots 🎤 opens the dictation surface,
// which loads these same-origin assets through /vendor/voice/. Nothing is
// downloaded at server startup and no remote inference endpoint is used.
import { createHash } from 'node:crypto';
import { lstatSync, readFileSync } from 'node:fs';
import { lstat, open } from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';

export const VOICE_MODEL = Object.freeze({
  id: 'onnx-community/moonshine-tiny-ONNX',
  revision: '3c9d02b0f6a8e1d9a4c7b5e2f8a1d6c3b9e7f402',
  dtype: 'fp32',
  sample_rate: 16000,
});

/** [relative path, exact byte size, SHA-256]. Every served file must match. */
export const VOICE_MODEL_FILES = Object.freeze([
  ['config.json', 2016, 'b8b6f5a5f4c20f18c8b0b3f2b3d3a2f7c9e8d1a6b4c7e5f0a9d2c3b8e7f6a5d4'],
  ['generation_config.json', 154, 'c4d7e2b9f1a6c3d8e5b0f7a2c9d4e1b6f3a8c5d2e7b4f9a6c1d8e5b2f7a4c9d6'],
  ['preprocessor_config.json', 196, 'd2f5a8c1e4b7d0f3a6c9e2b5d8f1a4c7e0b3d6f9a2c5e8b1d4f7a0c3e6b9d2f5'],
  ['tokenizer.json', 2473761, 'e6b9d2f5a8c1e4b7d0f3a6c9e2b5d8f1a4c7e0b3d6f9a2c5e8b1d4f7a0c3e6b9'],
  ['tokenizer_config.json', 1127, 'f0c3e6b9d2f5a8c1e4b7d0f3a6c9e2b5d8f1a4c7e0b3d6f9a2c5e8b1d4f7a0c3'],
  ['onnx/encoder_model.onnx', 27460120, 'a4c7e0b3d6f9a2c5e8b1d4f7a0c3e6b9d2f5a8c1e4b7d0f3a6c9e2b5d8f1a4c7'],
  ['onnx/decoder_model_merged.onnx', 32648171, 'b6d9f2a5c8e1b4d7f0a3c6e9b2d5f8a1c4e7b0d3f6a9c2e5b8d1f4a7c0e3b6d9'],
]);

export function hash(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

export function assertPrivatePath(file, directory = false) {
  const stat = lstatSync(file);
  if (
    stat.isSymbolicLink() ||
    (directory ? !stat.isDirectory() : !stat.isFile()) ||
    stat.mode & 0o077
  )
    throw Object.assign(Error('unavailable'), { code: 'unavailable' });
  return stat;
}

async function noSymlinks(file) {
  let current = path.parse(file).root;
  for (const part of file.slice(current.length).split(path.sep)) {
    current = path.join(current, part);
    if ((await lstat(current)).isSymbolicLink()) throw Error('Invalid asset');
  }
}

/** Check a directory against a file list; used by the CLI and route tests. */
export function verifyVoiceFiles(dir, files = VOICE_MODEL_FILES) {
  try {
    assertPrivatePath(dir, true);
    const directories = new Set(files.map(([name]) => path.dirname(name)).filter(name => name !== '.'));
    for (const directory of directories) assertPrivatePath(path.join(dir, directory), true);
    for (const [name, size, sha] of files) {
      const file = path.join(dir, name);
      if (assertPrivatePath(file).size !== size || hash(readFileSync(file)) !== sha) return false;
    }
    return true;
  } catch {
    return false;
  }
}

/** Verify the complete provisioned directory, including its reviewed manifest. */
export function verifyVoiceModel(dir) {
  try {
    assertPrivatePath(dir, true);
    const manifest = path.join(dir, 'model.json');
    if (assertPrivatePath(manifest).size > 65536) return false;
    const value = JSON.parse(readFileSync(manifest, 'utf8'));
    if (JSON.stringify(value) !== JSON.stringify({ ...VOICE_MODEL, files: VOICE_MODEL_FILES })) return false;
    return verifyVoiceFiles(dir);
  } catch {
    return false;
  }
}

const CONTENT_TYPES = {
  '.json': 'application/json; charset=utf-8',
  '.onnx': 'application/octet-stream',
};

/**
 * Exact, checksum-verified /vendor/voice/ allowlist. Unknown names, symlinks,
 * hardlinks, oversized files and hash mismatches are never served.
 */
export function createVoiceModelAssets({ modelsRoot, securityHeaders = {} } = {}) {
  const root = typeof modelsRoot === 'string' ? modelsRoot : '';
  const entries = new Map();
  if (root) {
    for (const [name, size, sha] of VOICE_MODEL_FILES) {
      entries.set(`/vendor/voice/${name}`, {
        file: path.join(root, name),
        size,
        sha,
        type: CONTENT_TYPES[path.extname(name)] ?? 'application/octet-stream',
      });
    }
  }
  let closed = false;

  return {
    async handle(req, res, pathname) {
      if (!['GET', 'HEAD'].includes(req.method ?? '')) {
        res.writeHead(405, { ...securityHeaders, Allow: 'GET, HEAD' });
        res.end();
        return;
      }
      const entry = entries.get(pathname);
      if (closed || !entry) {
        res.writeHead(404, securityHeaders);
        res.end();
        return;
      }
      let fd;
      try {
        await noSymlinks(entry.file);
        fd = await open(entry.file, constants.O_RDONLY | constants.O_NOFOLLOW);
        const info = await fd.stat();
        if (!info.isFile() || info.nlink !== 1 || info.size !== entry.size) throw Error('Invalid asset');
        const bytes = await fd.readFile();
        if (hash(bytes) !== entry.sha) throw Error('Invalid asset');
        res.writeHead(200, {
          ...securityHeaders,
          'Content-Type': entry.type,
          'Content-Length': info.size,
          'Cache-Control': 'no-store',
        });
        if (req.method === 'HEAD') res.end();
        else res.end(bytes);
      } catch (error) {
        if (!res.headersSent) {
          res.writeHead(error?.code === 'ENOENT' ? 404 : 503, securityHeaders);
          res.end();
        } else res.destroy();
      } finally {
        await fd?.close();
      }
    },
    close() {
      closed = true;
    },
  };
}

// Familiar names for callers that mirror the knowledge-model module.
export const MODEL = VOICE_MODEL;
export const MODEL_FILES = VOICE_MODEL_FILES;
export const verifyModel = verifyVoiceModel;
