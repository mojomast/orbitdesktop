import { lstat, readFile, realpath, open } from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

export const VOICE_MODEL = 'onnx-community/moonshine-tiny-ONNX';
export const VOICE_REVISION = 'a6da1241cd305dcd64eab1edbd615f2bb9aabb95';
export const ORT_VERSION = '1.31.0-dev.20260914-8d85527a0';
export const VOICE_FILES = Object.freeze({
  'config.json': [921, '558e1e02069137c796ace1e50c48d8fe451f04a295929138e6bea885517f0edb'],
  'preprocessor_config.json': [128, 'fa43a7017ef85cd1d0fba0d9aae77c8adb16990ae6f11115631f41ec5d8aa679'],
  'generation_config.json': [147, 'f9b3f711b57be7def2e50a8942f64f36ee0a55fad5b84ff93a687b6c5bcc1d44'],
  'tokenizer_config.json': [135735, 'edaee394565d428ea98a663ae7209cdcfeefc5585c42d7a570ff7c986df2cd15'],
  'special_tokens_map.json': [3, 'ca3d163bab055381827226140568f3bef7eaac187cebd76878e0b63e9e442356'],
  'tokenizer.json': [3761754, '7b913404bdd039af4756783218af4440bc07fb7d6d8258d677e34f95b3ec416f'],
  'onnx/encoder_model_quantized.onnx': [7937661, 'c6fc4b7bc5af75c0591fd157a1f3829b533d18e9769a888fd95a62e470dd4f4a'],
  'onnx/decoder_model_merged_quantized.onnx': [20243286, 'eed87831c3a6103534aae7d47a5d485025c659a1323901513961c39fe8a1a367'],
});
const ORT_FILES = {
  'ort-wasm-simd-threaded.mjs': [24381, 'c57ca56328877353a575e51bbca6f18450027d6c9bf2307a2cb2c41363b4de9f'],
  'ort-wasm-simd-threaded.wasm': [14264838, '06ba057753da3847e4c24f02d91ab133455b0817c69a44993a9a53a2146df9e3'],
};
export const modelAssetPrefix = `/vendor/voice/models/${VOICE_MODEL}/resolve/${VOICE_REVISION}/`;
export const ortAssetPrefix = `/vendor/voice/ort/${ORT_VERSION}/`;
export function verifyVoiceBytes(bytes, expected) {
  return bytes.length === expected[0] && createHash('sha256').update(bytes).digest('hex') === expected[1];
}

/** Size-check before allocation/read, then bounded reads even if a file grows. */
export async function readPinnedVoiceFile(file, expected) {
  await assertNoSymlinks(file);
  const info = await lstat(file);
  if (!info.isFile() || info.size !== expected[0]) throw new Error('Voice asset size mismatch');
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || opened.size !== expected[0]) throw new Error('Voice asset size changed');
    const bytes = Buffer.alloc(expected[0] + 1);
    let length = 0;
    while (length < bytes.length) {
      const { bytesRead } = await handle.read(bytes, length, bytes.length - length, length);
      if (!bytesRead) break;
      length += bytesRead;
    }
    const result = bytes.subarray(0, length);
    if (!verifyVoiceBytes(result, expected)) throw new Error('Voice asset checksum mismatch');
    return result;
  } finally { await handle.close(); }
}
// Inspect every path component, including the root: resolving only the leaf is
// insufficient when a parent directory was replaced with a symlink.
export async function assertNoSymlinks(file) {
  const absolute = path.resolve(file);
  let current = path.parse(absolute).root;
  for (const part of absolute.slice(current.length).split(path.sep)) {
    current = path.join(current, part);
    const stat = await lstat(current);
    if (stat.isSymbolicLink()) throw new Error('Voice assets must not use symlinks');
  }
  if (await realpath(absolute) !== absolute) throw new Error('Voice asset path changed');
}

/** Public MIT assets; exact allowlist, no runtime network or arbitrary paths. */
export function createVoiceModelAssets({ root, modelsRoot = path.join(root, '.runtime/models') }) {
  // root is the trusted application installation, not the private runtime.
  // Release installations may intentionally link node_modules outside the app.
  // Resolve that trusted package once, then serve only canonical pinned files.
  let dependencyRoot;
  function resolveDependencyRoot() {
    return dependencyRoot ??= (async () => {
      const require = createRequire(pathToFileURL(path.join(path.resolve(root), 'package.json')));
      const entry = await realpath(require.resolve('onnxruntime-web'));
      const canonical = await realpath(path.dirname(path.dirname(entry)));
      const metadataPath = path.join(canonical, 'package.json');
      const info = await lstat(metadataPath);
      if (!info.isFile() || info.size > 65536) throw new Error('Invalid trusted ORT package metadata');
      const metadata = JSON.parse(await readFile(metadataPath, 'utf8'));
      if (metadata.name !== 'onnxruntime-web' || metadata.version !== ORT_VERSION) throw new Error('Unexpected trusted ORT package version');
      return canonical;
    })();
  }
  const allowlist = new Map();
  for (const [file, expected] of Object.entries(VOICE_FILES)) {
    allowlist.set(modelAssetPrefix + file, { file: path.join(modelsRoot, VOICE_MODEL, 'resolve', VOICE_REVISION, file), expected });
  }
  for (const [file, expected] of Object.entries(ORT_FILES)) {
    allowlist.set(ortAssetPrefix + file, { ortFile: file, expected });
  }
  return {
    async handle(req, res, pathname) {
      if (!['GET', 'HEAD'].includes(req.method)) { res.writeHead(405, { Allow: 'GET, HEAD' }); res.end(); return; }
      const entry = allowlist.get(pathname);
      if (!entry) { res.writeHead(404); res.end(); return; }
      try {
        const file = entry.ortFile ? path.join(await resolveDependencyRoot(), 'dist', entry.ortFile) : entry.file;
        const bytes = await readPinnedVoiceFile(file, entry.expected);
        res.writeHead(200, {
          'Content-Type': pathname.endsWith('.wasm') ? 'application/wasm' : pathname.endsWith('.mjs') ? 'text/javascript' : pathname.endsWith('.json') ? 'application/json' : 'application/octet-stream',
          'Content-Length': bytes.length,
          'Cache-Control': 'public, max-age=31536000, immutable',
          'X-Content-Type-Options': 'nosniff',
          'Content-Security-Policy': "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; worker-src 'self' blob:; connect-src 'self'",
        });
        res.end(req.method === 'HEAD' ? undefined : bytes);
      } catch (error) {
        res.writeHead(error.code === 'ENOENT' ? 404 : 503);
        res.end();
      }
    },
  };
}
