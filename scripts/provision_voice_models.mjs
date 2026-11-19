import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  VOICE_MODEL,
  VOICE_MODEL_FILES,
  verifyVoiceModel,
  assertPrivatePath,
  hash,
} from '../server/voice-model-assets.mjs';

const args = process.argv.slice(2);
const verifyOnly = args.includes('--verify') || args[0] === 'verify';
const rootIndex = args.indexOf('--models-root');
const positional = args.filter((value, index) => value !== '--verify' && value !== 'verify' && value !== '--models-root' && !(rootIndex >= 0 && index === rootIndex + 1));
const root = rootIndex >= 0 ? args[rootIndex + 1] : positional[0] ?? '';
if (!root || root.startsWith('--'))
  throw Error('Usage: node scripts/provision_voice_models.mjs [--verify] --models-root PRIVATE_MODELS_ROOT');

const dest = path.resolve(root);
const parent = path.dirname(dest);

if (verifyOnly) {
  if (!verifyVoiceModel(dest)) throw Error('Models absent or integrity mismatch');
  console.log('Verified offline Moonshine dictation model', VOICE_MODEL.revision);
} else if (fs.existsSync(dest)) {
  if (!verifyVoiceModel(dest)) throw Error('Existing model mismatched; refusing overwrite');
  console.log('Already verified');
} else {
  fs.mkdirSync(parent, { recursive: true, mode: 0o700 });
  const temp = path.join(parent, `.voice-models-${randomUUID()}`);
  fs.mkdirSync(temp, { mode: 0o700 });
  for (const [name] of VOICE_MODEL_FILES) {
    const directory = path.dirname(name);
    if (directory !== '.') fs.mkdirSync(path.join(temp, directory), { mode: 0o700 });
  }
  try {
    for (const [name, size, sha] of VOICE_MODEL_FILES) {
      const response = await fetch(
        `https://huggingface.co/${VOICE_MODEL.id}/resolve/${VOICE_MODEL.revision}/${name}`,
        { signal: AbortSignal.timeout(300000) },
      );
      if (!response.ok) throw Error(`Download failed: ${name}`);
      const parts = [];
      let total = 0;
      for await (const part of response.body) {
        total += part.length;
        if (total > size) throw Error('Artifact exceeds reviewed bound');
        parts.push(part);
      }
      const bytes = Buffer.concat(parts);
      if (total !== size || hash(bytes) !== sha) throw Error(`SHA256 mismatch: ${name}`);
      const fd = fs.openSync(path.join(temp, name), 'wx', 0o600);
      try {
        fs.writeFileSync(fd, bytes);
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
    }
    const manifest = fs.openSync(path.join(temp, 'model.json'), 'wx', 0o600);
    try {
      fs.writeFileSync(manifest, JSON.stringify({ ...VOICE_MODEL, files: VOICE_MODEL_FILES }));
      fs.fsyncSync(manifest);
    } finally {
      fs.closeSync(manifest);
    }
    for (const directory of new Set(VOICE_MODEL_FILES.map(([name]) => path.dirname(name)).filter(name => name !== '.'))) {
      const fd = fs.openSync(path.join(temp, directory), 'r');
      try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    }
    const tempFd = fs.openSync(temp, 'r');
    try { fs.fsyncSync(tempFd); } finally { fs.closeSync(tempFd); }
    fs.renameSync(temp, dest);
    assertPrivatePath(dest, true);
    if (!verifyVoiceModel(dest)) throw Error('Provisioned model failed final verification');
    const parentFd = fs.openSync(parent, 'r');
    try { fs.fsyncSync(parentFd); } finally { fs.closeSync(parentFd); }
    console.log('Provisioned verified on-device Moonshine dictation model', VOICE_MODEL.revision);
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
}
