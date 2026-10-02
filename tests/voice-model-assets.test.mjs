import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, symlink, rm, copyFile, open } from 'node:fs/promises';
import path from 'node:path';
import { createVoiceModelAssets, modelAssetPrefix, ortAssetPrefix, ORT_VERSION, VOICE_MODEL, VOICE_REVISION, verifyVoiceBytes, assertNoSymlinks, readPinnedVoiceFile, VOICE_FILES } from '../server/voice-model-assets.mjs';
import { provisionVoiceModels } from '../scripts/provision_voice_models.mjs';
import { createHash } from 'node:crypto';

test('exact allowlist, methods, missing assets, checksum and symlink refusal', async () => {
  const root = await mkdtemp('/tmp/opencode/voice-assets-');
  const service = createVoiceModelAssets({ root });
  async function request(url, method = 'GET') {
    let status, body, headers;
    await service.handle({ method }, { writeHead(s, h) { status = s; headers = h; }, end(b) { body = b; } }, url);
    return { status, body, headers };
  }
  try {
    assert.equal((await request(modelAssetPrefix + '../config.json')).status, 404);
    assert.equal((await request(modelAssetPrefix + 'config.json', 'POST')).status, 405);
    assert.equal((await request(modelAssetPrefix + 'config.json')).status, 404);
    const destination = path.join(root, '.runtime/models', VOICE_MODEL, 'resolve', VOICE_REVISION);
    await mkdir(destination, { recursive: true });
    await writeFile(path.join(destination, 'special_tokens_map.json'), '{}\n');
    const get = await request(modelAssetPrefix + 'special_tokens_map.json');
    assert.equal(get.status, 200);
    assert.equal(get.headers['Content-Type'], 'application/json');
    assert.match(get.headers['Cache-Control'], /immutable/);
    assert.equal(get.body.toString(), '{}\n');
    const head = await request(modelAssetPrefix + 'special_tokens_map.json', 'HEAD');
    assert.equal(head.status, 200); assert.equal(head.body, undefined);
    await writeFile(path.join(destination, 'config.json'), '{}');
    assert.equal((await request(modelAssetPrefix + 'config.json')).status, 503);
    const oversized = await open(path.join(destination, 'config.json'), 'w');
    await oversized.truncate(1024 * 1024 * 1024); await oversized.close();
    await assert.rejects(readPinnedVoiceFile(path.join(destination, 'config.json'), VOICE_FILES['config.json']), /size mismatch/);
    assert.equal((await request(modelAssetPrefix + 'config.json')).status, 503);
    await rm(path.join(destination, 'config.json'));
    await symlink('/etc/hosts', path.join(destination, 'config.json'));
    assert.equal((await request(modelAssetPrefix + 'config.json')).status, 503);
    await assert.rejects(assertNoSymlinks(path.join(destination, 'config.json')), /symlink/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('trusted external linked dependency resolves once; model-root links and corrupted ORT still fail closed', async () => {
  const scratch = await mkdtemp('/tmp/opencode/voice-release-');
  const app = path.join(scratch, 'app'), external = path.join(scratch, 'external');
  const dependency = path.join(external, 'node_modules/onnxruntime-web');
  const models = path.join(scratch, 'actual-models');
  const linkedModels = path.join(scratch, 'linked-models');
  async function request(service, url) {
    let status, body;
    await service.handle({ method: 'GET' }, { writeHead(s) { status = s; }, end(b) { body = b; } }, url);
    return { status, body };
  }
  try {
    await mkdir(app, { recursive: true }); await mkdir(path.join(dependency, 'dist'), { recursive: true });
    await writeFile(path.join(app, 'package.json'), '{}');
    await writeFile(path.join(dependency, 'package.json'), JSON.stringify({ name: 'onnxruntime-web', version: ORT_VERSION, exports: './dist/ort.node.min.js' }));
    await writeFile(path.join(dependency, 'dist/ort.node.min.js'), '');
    const loader = 'ort-wasm-simd-threaded.mjs';
    await copyFile(new URL('../node_modules/onnxruntime-web/dist/' + loader, import.meta.url), path.join(dependency, 'dist', loader));
    await symlink(path.join(external, 'node_modules'), path.join(app, 'node_modules'));
    const modelDirectory = path.join(models, VOICE_MODEL, 'resolve', VOICE_REVISION);
    await mkdir(modelDirectory, { recursive: true });
    await writeFile(path.join(modelDirectory, 'special_tokens_map.json'), '{}\n');
    await symlink(models, linkedModels);
    const service = createVoiceModelAssets({ root: app, modelsRoot: linkedModels });
    const valid = await request(service, ortAssetPrefix + loader);
    assert.equal(valid.status, 200); assert.equal(valid.body.length, 24381);
    assert.equal((await request(service, modelAssetPrefix + 'special_tokens_map.json')).status, 503);
    assert.equal((await request(service, ortAssetPrefix + '../package.json')).status, 404);
    // The original canonical dependency is pinned even if installation linkage changes.
    await rm(path.join(app, 'node_modules')); await symlink('/missing-release-dependency', path.join(app, 'node_modules'));
    assert.equal((await request(service, ortAssetPrefix + loader)).status, 200);
    await writeFile(path.join(dependency, 'dist', loader), Buffer.alloc(24381));
    assert.equal((await request(service, ortAssetPrefix + loader)).status, 503);
  } finally { await rm(scratch, { recursive: true, force: true }); }
});

test('provisioning rejects downloaded corruption and symlink parents without publishing bytes', async () => {
  const root = await mkdtemp('/tmp/opencode/voice-provision-');
  try {
    await assert.rejects(provisionVoiceModels({ modelsRoot: root, fetchFile: async () => new Response('{}') }), /checksum mismatch/);
    const linked = path.join(root, 'linked'); await symlink(root, linked);
    await assert.rejects(provisionVoiceModels({ modelsRoot: linked, fetchFile: () => { throw new Error('must not fetch'); } }), /symlink/);
    const bytes = Buffer.from('example');
    assert.equal(verifyVoiceBytes(bytes, [bytes.length, createHash('sha256').update(bytes).digest('hex')]), true);
    assert.equal(verifyVoiceBytes(bytes, [bytes.length + 1, createHash('sha256').update(bytes).digest('hex')]), false);
  } finally { await rm(root, { recursive: true, force: true }); }
});
