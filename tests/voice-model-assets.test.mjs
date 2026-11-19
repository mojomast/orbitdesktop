import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { scratchPath } from './fixtures/scratch.mjs';
import {
  VOICE_MODEL,
  VOICE_MODEL_FILES,
  createVoiceModelAssets,
  hash,
  verifyVoiceFiles,
  verifyVoiceModel,
} from '../server/voice-model-assets.mjs';

const directory = () => {
  const root = fs.mkdtempSync(scratchPath('orbit-voice-assets-'));
  fs.chmodSync(root, 0o700);
  return root;
};

async function request(assets, pathname, method = 'GET') {
  let status, headers, body;
  const res = {
    headersSent: false,
    writeHead(code, values) { status = code; headers = values; this.headersSent = true; },
    end(bytes) { body = bytes; },
    destroy() { this.destroyed = true; },
  };
  await assets.handle({ method }, res, pathname);
  return { status, headers, body };
}

test('the reviewed manifest is complete, unique and pinned to exact sizes and SHA-256', () => {
  assert.equal(typeof VOICE_MODEL.id, 'string');
  assert.match(VOICE_MODEL.revision, /^[a-f0-9]{40}$/);
  assert.equal(VOICE_MODEL.sample_rate, 16000);
  const names = VOICE_MODEL_FILES.map(([name]) => name);
  assert.equal(new Set(names).size, names.length);
  for (const [name, size, sha] of VOICE_MODEL_FILES) {
    assert.ok(!path.isAbsolute(name) && !name.includes('..'), `${name} must stay inside the models root`);
    assert.ok(Number.isSafeInteger(size) && size > 0, `${name} needs a reviewed size`);
    assert.match(sha, /^[a-f0-9]{64}$/, `${name} needs a SHA-256 pin`);
  }
});

test('verifyVoiceFiles checks private paths, sizes and hashes', () => {
  const root = directory();
  const files = [['config.json', 7, ''], ['onnx/encoder_model.onnx', 4, '']];
  fs.mkdirSync(path.join(root, 'onnx'), { mode: 0o700 });
  const contents = new Map([['config.json', Buffer.from('{"a":1}')], ['onnx/encoder_model.onnx', Buffer.from('onnx')]]);
  for (const [name] of files) {
    const file = path.join(root, name);
    fs.writeFileSync(file, contents.get(name), { mode: 0o600 });
    fs.chmodSync(file, 0o600);
  }
  const pinned = files.map(([name, size]) => [name, size, hash(contents.get(name))]);
  assert.equal(verifyVoiceFiles(root, pinned), true);
  fs.appendFileSync(path.join(root, 'config.json'), ' ');
  assert.equal(verifyVoiceFiles(root, pinned), false);
  fs.rmSync(root, { recursive: true, force: true });
});

test('verifyVoiceModel rejects absent, incomplete and non-private model directories', () => {
  const root = directory();
  assert.equal(verifyVoiceModel(path.join(root, 'missing')), false);
  assert.equal(verifyVoiceModel(root), false);
  fs.writeFileSync(path.join(root, 'model.json'), JSON.stringify({ ...VOICE_MODEL, files: VOICE_MODEL_FILES }), { mode: 0o600 });
  assert.equal(verifyVoiceModel(root), false);
  fs.rmSync(root, { recursive: true, force: true });
});

test('the vendor route serves only exact reviewed names and never a symlink', async () => {
  const modelsRoot = directory();
  const assets = createVoiceModelAssets({ modelsRoot, securityHeaders: { 'X-Content-Type-Options': 'nosniff' } });
  for (const pathname of [
    '/vendor/voice/model.onnx',
    '/vendor/voice/unknown.json',
    '/vendor/voice/../package.json',
    '/vendor/voice/',
  ]) {
    assert.equal((await request(assets, pathname)).status, 404, pathname);
  }
  assert.equal((await request(assets, '/vendor/voice/config.json', 'POST')).status, 405);
  const outside = path.join(modelsRoot, 'outside.json');
  fs.writeFileSync(outside, '{}', { mode: 0o600 });
  fs.symlinkSync(outside, path.join(modelsRoot, 'config.json'));
  const linked = await request(assets, '/vendor/voice/config.json');
  assert.notEqual(linked.status, 200);
  assert.equal(linked.body, undefined);
  assets.close();
  assert.equal((await request(assets, '/vendor/voice/config.json')).status, 404);
  fs.rmSync(modelsRoot, { recursive: true, force: true });
});

test('an absent models root fails closed for every dictation asset', async () => {
  const assets = createVoiceModelAssets({ modelsRoot: scratchPath('orbit-voice-absent-model-root') });
  for (const [name] of VOICE_MODEL_FILES) {
    const result = await request(assets, `/vendor/voice/${name}`, 'HEAD');
    assert.equal(result.status, 404, name);
  }
  assets.close();
});
